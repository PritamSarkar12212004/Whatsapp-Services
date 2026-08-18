/**
 * Pure DB helpers for the campaign/message queue worker.
 * No queue state (no access to the in-memory queue) — safe to import
 * from the worker without circular dependencies.
 *
 * @see campaign.queue.js (worker that imports these)
 */

import mongoose from "mongoose";
import Campaign from "../../models/messaging/campaign.model.js";
import CampaignRecipient from "../../models/messaging/campaignRecipient.model.js";
import ContactActivity from "../../models/messaging/contactActivity.model.js";

/** Resolve after `ms` milliseconds (promise-based sleep). */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Move a campaign through its lifecycle based on remaining recipients:
 *   queued + remaining > 0  -> running
 *   running + remaining = 0 -> completed
 * Paused / cancelled / draft / scheduled campaigns are left untouched.
 */
export const syncCampaignStatus = async (campaignId) => {
  if (!campaignId || !mongoose.isValidObjectId(campaignId)) return;
  try {
    const campaign = await Campaign.findById(campaignId).exec();
    if (!campaign) return;

    // Dev campaigns are pure live switches — they never send to an audience
    // and must never complete automatically (running or paused only).
    if (campaign.devTemplate) return;

    const remaining = await CampaignRecipient.countDocuments({
      campaign: campaignId,
      status: { $in: ["pending", "queued", "sending"] },
    }).exec();

    if (campaign.status === "queued" && remaining > 0) {
      campaign.status = "running";
      campaign.startedAt = campaign.startedAt || new Date();
      await campaign.save();
      console.log(`[CRM Queue] Campaign ${campaignId} is now running`);
    } else if (
      remaining === 0 &&
      (campaign.status === "queued" || campaign.status === "running")
    ) {
      campaign.status = "completed";
      campaign.completedAt = new Date();
      await campaign.save();
      console.log(`[CRM Queue] Campaign ${campaignId} completed`);
    }
  } catch (err) {
    console.error("[CRM Queue] campaign status sync error:", err.message);
  }
};

/** Increment one statistics field on a campaign document. */
export const incrementCampaignStat = async (campaignId, field) => {
  if (!campaignId || !mongoose.isValidObjectId(campaignId)) return;
  try {
    await Campaign.updateOne(
      { _id: campaignId },
      { $inc: { [`statistics.${field}`]: 1 } },
    ).exec();
  } catch (err) {
    console.error("[CRM Queue] increment stat error:", err.message);
  }
};

/** Append a row to the contact activity feed. */
export const logActivity = async (ownerId, contactId, type, metadata = {}) => {
  try {
    await ContactActivity.create({
      owner: ownerId,
      contact: contactId,
      type,
      metadata,
    });
  } catch (err) {
    console.error("[CRM Queue] activity log error:", err.message);
  }
};
