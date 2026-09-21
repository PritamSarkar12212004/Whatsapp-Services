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
    if (!message) return;

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

    if (!result?.modifiedCount) return;

    if (!message.campaign) return;

    await CampaignRecipient.updateOne(
        {
            whatsappMessageId,
            status: { $in: statusesBefore(nextStatus) },
        },
        { $set: { status: nextStatus, ...stamp } },
    ).exec();

    await incrementCampaignStat(message.campaign, nextStatus);
};

/**
 * Handle a `messages.update` batch from Baileys.
 *
 * @param {String} ownerId  user id whose socket produced the receipts
 * @param {Array}  updates  WAMessageUpdate[] — { key: { id }, update: { status } }
 */
export const applyReceipts = async (ownerId, updates = []) => {
    for (const entry of updates) {
        const nextStatus = statusFromReceipt(entry?.update?.status);
        const whatsappMessageId = entry?.key?.id;

        if (!nextStatus || !whatsappMessageId) continue;

        try {
            await applyReceipt(ownerId, whatsappMessageId, nextStatus);
        } catch (err) {
            console.error(
                `[Baileys] receipt apply error for ${ownerId} (${whatsappMessageId}):`,
                err.message,
            );
        }
    }
};

export default { applyReceipts };
