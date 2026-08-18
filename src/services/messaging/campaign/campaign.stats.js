/**
 * Dev-campaign live statistics (API-call tracking for dev templates).
 *
 * @see campaign.service.js (delegates here)
 */

import mongoose from "mongoose";
import { getMessageModel } from "./campaign.helpers.js";

const ACTIVE_STATUSES = ["queued", "sending", "scheduled", "pending"];
const SUCCESS_STATUSES = ["sent", "delivered", "read"];

/**
 * Aggregate live stats for a dev campaign: totals, per-number breakdown and
 * the in-flight pipeline.
 *
 * @param {Object} service - campaign service instance (for getCampaign)
 * @param {String} ownerId
 * @param {String} campaignId
 */
export const getDevStats = async (service, ownerId, campaignId) => {
  const campaign = await service.getCampaign(ownerId, campaignId);
  const Message = await getMessageModel();
  const templateId = campaign.template?._id || campaign.template;
  const base = { owner: ownerId, template: templateId, source: "api" };
  const [sent, failed, queued, perNumber, pipeline] = await Promise.all([
    Message.countDocuments({
      ...base,
      status: { $in: SUCCESS_STATUSES },
    }).exec(),
    Message.countDocuments({ ...base, status: "failed" }).exec(),
    Message.countDocuments({
      ...base,
      status: { $in: ACTIVE_STATUSES },
    }).exec(),
    // Per-number breakdown: which numbers got called, how many times and
    // the status split for each (limit to the most active 100 numbers).
    // (Aggregate does not auto-cast — ObjectIds must be explicit.)
    Message.aggregate([
      {
        $match: {
          owner: new mongoose.Types.ObjectId(String(ownerId)),
          template: new mongoose.Types.ObjectId(String(templateId)),
          source: "api",
        },
      },
      {
        $group: {
          _id: "$to",
          count: { $sum: 1 },
          sent: {
            $sum: { $cond: [{ $in: ["$status", SUCCESS_STATUSES] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
          },
          queued: {
            $sum: { $cond: [{ $in: ["$status", ACTIVE_STATUSES] }, 1, 0] },
          },
          lastSentAt: { $max: "$sentAt" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 100 },
    ]).exec(),
    // Individual in-flight messages — queued / sending / scheduled — so the
    // UI can show exactly what is pending and when it will fire.
    Message.find({
      ...base,
      status: { $in: ACTIVE_STATUSES },
    })
      .select("to status type scheduledAt sentAt createdAt")
      .sort({ createdAt: -1 })
      .limit(50)
      .exec(),
  ]);

  const liveSince = campaign.devStats?.liveSince || campaign.startedAt || null;
  const liveStart = liveSince ? new Date(liveSince).getTime() : null;
  return {
    status: campaign.status,
    scheduledAt: campaign.scheduledAt || null,
    liveSince,
    uptimeSeconds:
      campaign.status === "running" && liveStart
        ? Math.max(0, Math.floor((Date.now() - liveStart) / 1000))
        : null,
    apiCalls: campaign.devStats?.apiCalls || 0,
    sent,
    failed,
    queued,
    total: sent + failed + queued,
    uniqueNumbers: perNumber.length,
    perNumber: perNumber.map((p) => ({
      number: p._id,
      count: p.count,
      sent: p.sent,
      failed: p.failed,
      queued: p.queued,
      lastSentAt: p.lastSentAt || null,
    })),
    pipeline: pipeline.map((p) => ({
      id: p._id,
      number: p.to,
      status: p.status,
      type: p.type,
      scheduledAt: p.scheduledAt || null,
      sentAt: p.sentAt || null,
      createdAt: p.createdAt,
    })),
  };
};
