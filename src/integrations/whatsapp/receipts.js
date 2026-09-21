/**
 * Delivery / read receipt handling for outbound WhatsApp messages.
 *
 * Baileys emits `messages.update` with a numeric ack for every message we send:
 *   0 ERROR · 1 PENDING · 2 SERVER_ACK · 3 DELIVERY_ACK · 4 READ · 5 PLAYED
 *
 * Nothing in this project listened to it, so a message only ever moved
 * sent → (nothing). That is why the dashboard's "Delivered" / "Read" counters
 * and both delivery rates were permanently 0 — the data was never recorded.
 *
 * This module applies each receipt to:
 *   • the unified Message row            (dashboard counters + status donut)
 *   • the CampaignRecipient row          (per-recipient status)
 *   • the campaign's statistics.*        (campaign list/detail numbers)
 *
 * Every update is guarded so statuses only ever move forward (a late
 * "delivered" can never overwrite a "read") and campaign counters are bumped
 * exactly once per real transition.
 *
 * 1:1 vs group: Baileys 7 only emits `messages.update` for direct chats. Group
 * receipts come through `message-receipt.update` as
 * `{ key, receipt: { userJid, receiptTimestamp | readTimestamp } }`, so those
 * are handled separately (a group message counts as delivered/read as soon as
 * one participant's device acknowledges it).
 */

import Message from "../../models/messaging/message.model.js";
import CampaignRecipient from "../../models/messaging/campaignRecipient.model.js";
import { incrementCampaignStat } from "../../jobs/campaignQueue/campaignQueue.db.js";

/** Baileys proto.WebMessageInfo.Status → our Message status. */
const RECEIPT_STATUS = {
    3: "delivered", // DELIVERY_ACK
    4: "read", // READ
    5: "read", // PLAYED counts as read for audio/video
};

/** Ascending progress order — used to reject backwards transitions. */
const STATUS_ORDER = [
    "pending",
    "scheduled",
    "queued",
    "sending",
    "sent",
    "delivered",
    "read",
];

/** Every status strictly before `status` (so the update never downgrades). */
const statusesBefore = (status) => STATUS_ORDER.slice(0, STATUS_ORDER.indexOf(status));

const statusFromReceipt = (raw) => RECEIPT_STATUS[Number(raw)] || null;

/**
 * Apply one receipt to the Message row and, when the message came from a
 * campaign, to its recipient row and the campaign counters.
 */
const applyReceipt = async (ownerId, whatsappMessageId, nextStatus) => {
    const message = await Message.findOne({
        owner: ownerId,
        whatsappMessageId,
    })
        .select("_id status campaign")
        .lean();

    // Unknown id (deleted row, someone else's chat, group automation, ...).
    if (!message) return "unknown";

    const stamp =
        nextStatus === "read"
            ? { readAt: new Date() }
            : { deliveredAt: new Date() };

    // Atomic forward-only transition. `modifiedCount` tells us whether this
    // receipt was the one that actually advanced the message, which keeps the
    // campaign counters from being incremented twice for the same receipt.
    const result = await Message.updateOne(
        {
            _id: message._id,
            status: { $in: statusesBefore(nextStatus) },
        },
        { $set: { status: nextStatus, ...stamp } },
    ).exec();

    if (!result?.modifiedCount) return "stale";

    if (!message.campaign) return nextStatus;

    await CampaignRecipient.updateOne(
        {
            whatsappMessageId,
            status: { $in: statusesBefore(nextStatus) },
        },
        { $set: { status: nextStatus, ...stamp } },
    ).exec();

    await incrementCampaignStat(message.campaign, nextStatus);

    return nextStatus;
};

/**
 * Handle a `messages.update` batch from Baileys.
 *
 * @param {String} ownerId  user id whose socket produced the receipts
 * @param {Array}  updates  WAMessageUpdate[] — { key: { id }, update: { status } }
 */
/**
 * Move every receipt in a batch onto its Message row and report what happened.
 * The summary line is intentionally readable: if receipts stop arriving (or an
 * id never matches) the server log says so instead of failing silently.
 *
 * @param {String} channel  "chat" (1:1) or "group" — only used for the log line
 */
const applyBatch = async (ownerId, entries, channel) => {
    const summary = { delivered: 0, read: 0, unknown: 0, stale: 0 };

    for (const { whatsappMessageId, nextStatus } of entries) {
        try {
            const outcome = await applyReceipt(
                ownerId,
                whatsappMessageId,
                nextStatus,
            );
            if (outcome in summary) summary[outcome] += 1;
        } catch (err) {
            console.error(
                `[Baileys] receipt apply error for ${ownerId} (${whatsappMessageId}):`,
                err.message,
            );
        }
    }

    const changed = summary.delivered + summary.read;
    if (changed || summary.unknown) {
        console.log(
            `[Baileys] ${channel} receipts for ${ownerId}: ` +
                `delivered=${summary.delivered} read=${summary.read} ` +
                `unknown=${summary.unknown}`,
        );
    }
};

/**
 * Map a `messages.update` batch to `{ whatsappMessageId, nextStatus }` pairs.
 * Message edits, revokes and non-receipt acks (pending / server ack) are
 * dropped here — only real delivery progress survives.
 */
export const receiptEntries = (updates = []) => {
    const entries = [];
    for (const entry of updates || []) {
        const nextStatus = statusFromReceipt(entry?.update?.status);
        const whatsappMessageId = entry?.key?.id;
        if (nextStatus && whatsappMessageId) {
            entries.push({ whatsappMessageId, nextStatus });
        }
    }
    return entries;
};

/**
 * Map a `message-receipt.update` batch (group chats) to the same shape.
 * `readTimestamp` wins when a batch carries both stamps.
 */
export const groupReceiptEntries = (receipts = []) => {
    const entries = [];
    for (const entry of receipts || []) {
        const whatsappMessageId = entry?.key?.id;
        const receipt = entry?.receipt || {};
        const nextStatus = receipt.readTimestamp
            ? "read"
            : receipt.receiptTimestamp
              ? "delivered"
              : null;
        if (nextStatus && whatsappMessageId) {
            entries.push({ whatsappMessageId, nextStatus });
        }
    }
    return entries;
};

/**
 * Handle a `messages.update` batch from Baileys (direct chats).
 *
 * @param {String} ownerId  user id whose socket produced the receipts
 * @param {Array}  updates  WAMessageUpdate[] — { key: { id }, update: { status } }
 */
export const applyReceipts = async (ownerId, updates = []) => {
    await applyBatch(ownerId, receiptEntries(updates), "chat");
};

/**
 * Handle a `message-receipt.update` batch — how Baileys 7 reports receipts for
 * group chats. `receiptTimestamp` means the message reached a participant's
 * device (delivered), `readTimestamp` means someone opened it (read).
 *
 * @param {String} ownerId   user id whose socket produced the receipts
 * @param {Array}  receipts  { key: { id }, receipt: { receiptTimestamp, readTimestamp } }[]
 */
export const applyGroupReceipts = async (ownerId, receipts = []) => {
    await applyBatch(ownerId, groupReceiptEntries(receipts), "group");
};

export default { applyReceipts, applyGroupReceipts, receiptEntries, groupReceiptEntries };
