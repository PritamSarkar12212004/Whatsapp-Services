/**
 * In-process campaign & message queue worker.
 *
 * This project does NOT have Redis installed (it was replaced by a
 * MongoDB-backed token store). To avoid introducing a new dependency
 * or a second Redis connection, the queue is implemented as a simple
 * in-process job queue with a lazy-starting worker loop.
 *
 * Configuration (environment variables):
 *   CAMPAIGN_BATCH_SIZE   — number of jobs processed per batch (default 5)
 *   CAMPAIGN_SEND_DELAY_MS — delay between individual sends (default 2000)
 *   CAMPAIGN_MAX_RETRIES  — retry attempts before a job is marked failed (default 3)
 *
 * The worker sends through the EXISTING Baileys transport
 * (whatsappModule.sendUserMessage) — no new WhatsApp connection is created.
 */
import {
  sendUserMessage,
  sendUserMediaMessage,
} from "../integrations/whatsapp/module.js";
import Campaign from "../models/messaging/campaign.model.js";
import CampaignRecipient from "../models/messaging/campaignRecipient.model.js";
import Message from "../models/messaging/message.model.js";
import ContactActivity from "../models/messaging/contactActivity.model.js";
import mongoose from "mongoose";
import {
  delay,
  syncCampaignStatus,
  incrementCampaignStat,
  logActivity,
} from "./campaignQueue/campaignQueue.db.js";

const BATCH_SIZE = parseInt(process.env.CAMPAIGN_BATCH_SIZE || "5", 10);
const SEND_DELAY_MS = parseInt(process.env.CAMPAIGN_SEND_DELAY_MS || "2000", 10);
const MAX_RETRIES = parseInt(process.env.CAMPAIGN_MAX_RETRIES || "3", 10);

const queue = [];
let processing = false;

// Track paused / cancelled campaigns so the worker can skip or hold them
const pausedCampaigns = new Set();
const cancelledCampaigns = new Set();

// Ids of recipients/messages currently in the in-memory queue — the periodic
// recovery sweep must not re-enqueue (duplicate sends) anything already queued.
const queuedRecipientIds = new Set();
const queuedMessageIds = new Set();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue all recipients for a campaign as individual send jobs.
 * Each recipient has already been created in the DB by campaignService.startCampaign.
 */
const enqueueCampaign = (job) => {
  const campaignId = String(job.campaignId);
  const ownerId = String(job.ownerId);

  for (const recipientId of job.recipientIds) {
    queuedRecipientIds.add(String(recipientId));
    queue.push({
      type: "campaign",
      campaignId,
      recipientId: String(recipientId),
      ownerId,
      templateType: job.templateType || "text",
      templateMedia: job.templateMedia || null,
      retryCount: 0,
    });
  }
  _wake();
};

/** Enqueue a single transactional message job. */
const enqueueMessage = (job) => {
  queuedMessageIds.add(String(job.messageId));
  queue.push({
    type: "message",
    messageId: String(job.messageId),
    ownerId: String(job.ownerId),
    phoneNumber: job.phoneNumber,
    content: job.content || job.rendered,
    messageType: job.type,
    media: job.media || null,
    campaignId: job.campaignId ? String(job.campaignId) : null,
    retryCount: 0,
  });
  _wake();
};

const pauseCampaign = (campaignId) => {
  pausedCampaigns.add(String(campaignId));
};

const resumeCampaign = (campaignId) => {
  pausedCampaigns.delete(String(campaignId));
  _wake();
};

const cancelCampaign = (campaignId) => {
  cancelledCampaigns.add(String(campaignId));
  pausedCampaigns.add(String(campaignId));
};

// TODO(queue): extract the recovery + scheduled sweeps (recoverPendingJobs,
//   _autoStartDue, _autoStartDueMessages, _recoverStuckSending) into
//   ./campaignQueue/campaignQueue.recovery.js

/**
 * Re-enqueue jobs that were left in an active state (e.g. after a server
 * restart wiped the in-memory queue). Only campaigns whose DB status is
 * "queued" or "running" are recovered — paused/cancelled are left alone.
 */
const recoverPendingJobs = async () => {
  try {
    const activeCampaigns = await Campaign.find({
      status: { $in: ["queued", "running"] },
    })
      .select("_id owner")
      .exec();

    for (const campaign of activeCampaigns) {
      // Finalize campaigns whose recipients all finished in a previous
      // process (queued/running + no active recipients -> completed).
      await syncCampaignStatus(campaign._id);

      // "sending" recipients are stale after a restart (no send can be
      // in-flight across processes) — re-enqueue them too.
      const recipients = await CampaignRecipient.find({
        campaign: campaign._id,
        status: { $in: ["pending", "queued", "sending"] },
      })
        .select("_id")
        .exec();

      // Skip recipients that are already in the in-memory queue
      const toRecover = recipients.filter(
        (r) => !queuedRecipientIds.has(String(r._id)),
      );
      if (toRecover.length > 0) {
        enqueueCampaign({
          campaignId: campaign._id,
          recipientIds: toRecover.map((r) => r._id),
          ownerId: campaign.owner.toString(),
        });
        console.log(
          `[CRM Queue] Recovered ${toRecover.length} queued recipient(s) for campaign ${campaign._id}`,
        );
      }
    }

    const messages = await Message.find({ status: "queued" })
      .select("_id owner to content type media campaign")
      .exec();
    const messagesToRecover = messages.filter(
      (m) => !queuedMessageIds.has(String(m._id)),
    );
    for (const m of messagesToRecover) {
      enqueueMessage({
        messageId: m._id,
        ownerId: m.owner.toString(),
        phoneNumber: m.to,
        content: m.content,
        type: m.type,
        media: m.media || null,
        campaignId: m.campaign ? m.campaign.toString() : null,
      });
    }
    if (messagesToRecover.length) {
      console.log(
        `[CRM Queue] Recovered ${messagesToRecover.length} queued message(s)`,
      );
    }
  } catch (err) {
    console.error("[CRM Queue] recovery error:", err.message);
  }
};

/**
 * Auto-start campaigns whose scheduledAt time has arrived.
 * Runs at startup and on a 15s interval. Uses a dynamic import of the
 * campaign service to avoid a circular import (service -> queue).
 */
const _autoStartDue = async () => {
  try {
    const due = await Campaign.find({
      status: "scheduled",
      scheduledAt: { $lte: new Date() },
    })
      .select("_id owner")
      .exec();

    for (const c of due) {
      console.log(`[CRM Queue] Auto-starting scheduled campaign ${c._id}`);
      const { default: campaignService } = await import("../services/messaging/campaign.service.js"
      );
      try {
        const result = await campaignService.startCampaign(
          c.owner.toString(),
          c._id,
        );
        console.log(
          `[CRM Queue] Scheduled campaign ${c._id} started (${result.audienceTotal} recipient(s))`,
        );
      } catch (err) {
        console.error(
          `[CRM Queue] auto-start failed for campaign ${c._id}:`,
          err.message,
        );
      }
    }
  } catch (err) {
    console.error("[CRM Queue] scheduled sweep error:", err.message);
  }
};

/**
 * Auto-enqueue transactional messages whose scheduledAt time has arrived.
 * Runs on the same 15s sweep as campaigns.
 */
const _autoStartDueMessages = async () => {
  try {
    const due = await Message.find({
      owner: { $exists: true },
      status: "scheduled",
      scheduledAt: { $lte: new Date() },
    })
      .select("_id owner to content type media")
      .exec();

    for (const msg of due) {
      console.log(`[CRM Queue] Auto-starting scheduled message ${msg._id}`);
      await Message.updateOne(
        { _id: msg._id },
        { $set: { status: "queued" } },
      ).exec();
      enqueueMessage({
        messageId: msg._id.toString(),
        ownerId: msg.owner.toString(),
        phoneNumber: msg.to,
        rendered: msg.content,
        type: msg.type,
        media: msg.media || null,
        campaignId: null,
      });
    }
  } catch (err) {
    console.error("[CRM Queue] scheduled message sweep error:", err.message);
  }
};

// Periodic self-heal: auto-start due schedules + re-enqueue jobs lost when
// the in-memory queue was wiped (e.g. server restart) or a send died midway.
// Stuck "sending" messages (a send attempt died without settling the record)
// are reset to queued and re-enqueued so nothing is lost forever.
const _recoverStuckSending = async () => {
  try {
    const stuck = await Message.find({
      status: "sending",
      $or: [
        { sentAt: { $lte: new Date(Date.now() - 60 * 1000) } },
        { updatedAt: { $lte: new Date(Date.now() - 60 * 1000) } },
        { sentAt: null, updatedAt: { $lte: new Date(Date.now() - 30 * 1000) } },
      ],
    })
      .select("_id owner to content type media")
      .exec();

    for (const msg of stuck) {
      await Message.updateOne(
        { _id: msg._id },
        { $set: { status: "queued" } },
      ).exec();
      console.log(`[CRM Queue] Recovering stuck sending message ${msg._id}`);
      enqueueMessage({
        messageId: msg._id.toString(),
        ownerId: msg.owner.toString(),
        phoneNumber: msg.to,
        rendered: msg.content,
        type: msg.type,
        media: msg.media || null,
        campaignId: null,
      });
    }
  } catch (err) {
    console.error("[CRM Queue] stuck sending recovery error:", err.message);
  }
};

setInterval(() => {
  _autoStartDue();
  _autoStartDueMessages();
  _recoverStuckSending();
  recoverPendingJobs();
}, 15000);

const getQueueStats = () => ({
  pending: queue.length,
  processing,
  batchSize: BATCH_SIZE,
  sendDelayMs: SEND_DELAY_MS,
  maxRetries: MAX_RETRIES,
  pausedCampaigns: Array.from(pausedCampaigns),
  cancelledCampaigns: Array.from(cancelledCampaigns),
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const _wake = () => {
  if (!processing && queue.length > 0) {
    _process();
  }
};

const _campaignState = (job) => {
  if (job.type !== "campaign") return "ok";
  if (cancelledCampaigns.has(job.campaignId)) return "cancelled";
  if (pausedCampaigns.has(job.campaignId)) return "paused";
  return "ok";
};

const _markRecipientSkipped = async (job) => {
  try {
    await CampaignRecipient.updateOne(
      { _id: job.recipientId },
      { $set: { status: "skipped" } },
    ).exec();
    queuedRecipientIds.delete(job.recipientId);
    await incrementCampaignStat(job.campaignId, "skipped");
  } catch (err) {
    console.error("[CRM Queue] mark skipped error:", err.message);
  }
};

// See: ./campaignQueue/campaignQueue.db.js (delay, syncCampaignStatus,
// incrementCampaignStat, logActivity)

// Record / update the outcome of a campaign recipient send
const _sendCampaignRecipient = async (job) => {
  const recipient = await CampaignRecipient.findById(job.recipientId).exec();
  if (!recipient || ["sent", "skipped"].includes(recipient.status)) return;

  // Mark as sending
  recipient.status = "sending";
  await recipient.save();

  // Load the template's media/type when the job does not carry it yet
  // (e.g. jobs recovered after a restart).
  if (!job.templateMedia) {
    const camp = await Campaign.findById(job.campaignId)
      .populate("template", "type media")
      .exec();
    if (camp?.template) {
      job.templateType = camp.template.type || "text";
      job.templateMedia = camp.template.media || null;
    }
  }

  // Use the per-recipient rendered media (dynamic {{variable}} URLs/captions)
  // when available; fall back to the template's raw media.
  const media = recipient.renderedMedia || job.templateMedia || null;

  const result = await sendUserMediaMessage(job.ownerId, recipient.phoneNumber, {
    text: recipient.renderedMessage,
    type: job.templateType || "text",
    media,
  });

  if (result.success) {
    recipient.status = "sent";
    recipient.whatsappMessageId = result.messageId;
    recipient.sentAt = new Date();
    await recipient.save();
    queuedRecipientIds.delete(job.recipientId);

    await incrementCampaignStat(job.campaignId, "sent");

    // Create a unified Message record for the campaign send
    await Message.create({
      owner: job.ownerId,
      contact: recipient.contact,
      campaign: job.campaignId,
      direction: "outbound",
      type: "text",
      content: recipient.renderedMessage,
      to: recipient.phoneNumber,
      whatsappMessageId: result.messageId,
      status: "sent",
      sentAt: new Date(),
    }).catch((err) =>
      console.error("[CRM Queue] message create error:", err.message),
    );

    await logActivity(job.ownerId, recipient.contact, "campaign_sent", {
      campaignId: job.campaignId,
      messageId: result.messageId,
    });
  } else {
    const retries = recipient.retryCount + 1;
    if (retries >= MAX_RETRIES) {
      recipient.status = "failed";
      recipient.failedAt = new Date();
      recipient.error = result.error || "Max retries exceeded";
      recipient.retryCount = retries;
      await recipient.save();
      queuedRecipientIds.delete(job.recipientId);
      await incrementCampaignStat(job.campaignId, "failed");
    } else {
      recipient.retryCount = retries;
      recipient.status = "queued";
      await recipient.save();
      // Re-enqueue with linear backoff (kept in queuedRecipientIds until done)
      const retryJob = { ...job, retryCount: retries };
      setTimeout(() => {
        queue.push(retryJob);
        _wake();
      }, SEND_DELAY_MS * retries);
    }
  }
};

// Record the outcome of a transactional message send
const _sendMessage = async (job) => {
  // Atomically move from queued -> sending
  const updated = await Message.findOneAndUpdate(
    { _id: job.messageId, owner: job.ownerId, status: "queued" },
    { $set: { status: "sending" } },
    { new: true },
  ).exec();

  if (!updated) {
    // Already being processed / completed / no longer queued
    return;
  }

  const result = await sendUserMediaMessage(job.ownerId, job.phoneNumber, {
    text: job.content,
    type: job.messageType || "text",
    media: job.media || null,
  });

  if (result.success) {
    await Message.updateOne(
      { _id: job.messageId },
      {
        $set: {
          status: "sent",
          whatsappMessageId: result.messageId,
          sentAt: new Date(),
        },
      },
    ).exec();
    queuedMessageIds.delete(String(job.messageId));

    if (job.campaignId) {
      await incrementCampaignStat(job.campaignId, "sent");
    }
  } else {
    const retries = job.retryCount + 1;
    if (retries >= MAX_RETRIES) {
      await Message.updateOne(
        { _id: job.messageId },
        {
          $set: {
            status: "failed",
            error: result.error || "Max retries exceeded",
            failedAt: new Date(),
          },
        },
      ).exec();
      queuedMessageIds.delete(String(job.messageId));
      if (job.campaignId) {
        await incrementCampaignStat(job.campaignId, "failed");
      }
    } else {
      // Reset the record back to queued so the retry actually picks it up
      // (otherwise findOneAndUpdate skips it and it stays "sending" forever).
      await Message.updateOne(
        { _id: job.messageId },
        { $set: { status: "queued" } },
      ).exec();
      const retryJob = { ...job, retryCount: retries };
      setTimeout(() => {
        queue.push(retryJob);
        _wake();
      }, SEND_DELAY_MS * retries);
    }
  }
};

const _sendJob = async (job) => {
  try {
    if (job.type === "campaign") {
      await _sendCampaignRecipient(job);
    } else {
      await _sendMessage(job);
    }
  } catch (err) {
    // A job that threw is stale — drop it from the dedup set so the periodic
    // recovery sweep re-enqueues and retries it (self-heal).
    if (job.type === "campaign") {
      queuedRecipientIds.delete(job.recipientId);
    } else {
      queuedMessageIds.delete(String(job.messageId));
    }
    console.error("[CRM Queue] job error:", err.message);
  }
};

// ---------------------------------------------------------------------------
// Main processing loop
// ---------------------------------------------------------------------------

const _process = async () => {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      // Collect up to BATCH_SIZE actionable jobs, re-queueing paused/cancelled
      const batch = [];
      const requeued = [];

      while (batch.length < BATCH_SIZE && queue.length > 0) {
        const job = queue.shift();
        const state = _campaignState(job);

        if (state === "cancelled") {
          if (job.type === "campaign") {
            await _markRecipientSkipped(job);
          } else {
            await Message.updateOne(
              { _id: job.messageId, owner: job.ownerId },
              { $set: { status: "skipped" } },
            ).exec();
            queuedMessageIds.delete(String(job.messageId));
            if (job.campaignId) await incrementCampaignStat(job.campaignId, "skipped");
          }
        } else if (state === "paused") {
          requeued.push(job);
        } else {
          batch.push(job);
        }
      }

      // Put paused jobs back at the tail
      for (const job of requeued) queue.push(job);

      // Process the batch with rate-limited sends
      const campaignsInBatch = new Set();
      for (const job of batch) {
        if (job.type === "campaign") campaignsInBatch.add(job.campaignId);
        await _sendJob(job);
        await delay(SEND_DELAY_MS);
      }

      // Drive campaign lifecycle: queued -> running, then completed when
      // every recipient is finished.
      for (const cid of campaignsInBatch) {
        await syncCampaignStatus(cid);
      }

      // If only paused jobs remain, sleep to avoid busy-looping
      if (queue.length > 0) {
        const onlyPaused = queue.every((j) => _campaignState(j) === "paused");
        if (onlyPaused) {
          await delay(SEND_DELAY_MS * 3);
        }
      }
    }
  } catch (err) {
    console.error("[CRM Queue] worker error:", err.message);
  } finally {
    processing = false;
  }
};

const campaignQueue = {
  enqueueCampaign,
  enqueueMessage,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  recoverPendingJobs,
  getQueueStats,
};

export default campaignQueue;
