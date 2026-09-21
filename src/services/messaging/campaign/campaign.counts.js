/**
 * Live campaign counts — the numbers shown in the campaigns table (Sent / Total)
 * and the dashboard's "Top campaigns" chart.
 *
 * `Campaign.statistics.*` is a denormalised counter that only moves while a
 * campaign is actually being sent, and dev campaigns (pure API switches) never
 * move it at all. Anything that read only those counters showed 0 forever — e.g.
 * a dev campaign with hundreds of API sends, or a campaign started before the
 * counters existed.
 *
 * The real sources are:
 *   • CampaignRecipient rows          → normal campaigns (same as the drawer)
 *   • Message rows (source: "api")    → dev campaigns, per template
 *
 * The mapping functions are pure so they can be reasoned about (and tested)
 * without a database; the exported helpers are thin DB wrappers around them.
 */

import mongoose from "mongoose";
import CampaignRecipient from "../../../models/messaging/campaignRecipient.model.js";
import { getMessageModel } from "./campaign.helpers.js";

/** Recipient statuses that count as "sent" (a delivered/read row was sent too). */
const SENT_LIKE = ["sent", "delivered", "read"];
const DELIVERED_LIKE = ["delivered", "read"];
const PENDING_LIKE = ["queued", "sending", "scheduled", "pending"];

/** Older campaigns can predate the campaign.devTemplate flag — accept both. */
export const isDevCampaign = (campaign) =>
  !!campaign?.devTemplate || !!campaign?.template?.devMode;

const emptyStatistics = () => ({
  total: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  skipped: 0,
});

/**
 * Reduce `[{ _id: { campaign, status }, count }]` to
 * `Map<campaignId, CampaignStatistics>`.
 */
export const buildRecipientStats = (rows = []) => {
  const map = new Map();
  for (const row of rows) {
    const key = String(row?._id?.campaign ?? "");
    if (!key) continue;
    const status = row._id.status;
    const count = Number(row.count) || 0;
    const bucket = map.get(key) || emptyStatistics();

    bucket.total += count;
    if (SENT_LIKE.includes(status)) bucket.sent += count;
    if (DELIVERED_LIKE.includes(status)) bucket.delivered += count;
    if (status === "read") bucket.read += count;
    if (status === "failed") bucket.failed += count;
    if (status === "skipped") bucket.skipped += count;

    map.set(key, bucket);
  }
  return map;
};

/**
 * Reduce `[{ _id: templateId, total, sent, failed, queued }]` to
 * `Map<templateId, counts>` — the dev-campaign equivalent of the above.
 */
export const buildDevStats = (rows = []) =>
  new Map(rows.filter((row) => row?._id).map((row) => [String(row._id), row]));

/** Per-campaign recipient status counts for the given campaign ids. */
export const fetchRecipientStats = async (campaignIds = []) => {
  if (!campaignIds.length) return new Map();

  const rows = await CampaignRecipient.aggregate([
    { $match: { campaign: { $in: campaignIds } } },
    {
      $group: {
        _id: { campaign: "$campaign", status: "$status" },
        count: { $sum: 1 },
      },
    },
  ]).exec();

  return buildRecipientStats(rows);
};

/** API traffic (Message rows with source "api") per template. */
export const fetchDevApiStats = async (ownerId, templateIds = []) => {
  if (!ownerId || !templateIds.length) return new Map();

  const Message = await getMessageModel();
  const rows = await Message.aggregate([
    {
      $match: {
        owner: new mongoose.Types.ObjectId(String(ownerId)),
        template: {
          $in: templateIds.map((t) => new mongoose.Types.ObjectId(String(t))),
        },
        source: "api",
      },
    },
    {
      $group: {
        _id: "$template",
        total: { $sum: 1 },
        sent: { $sum: { $cond: [{ $in: ["$status", SENT_LIKE] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        queued: {
          $sum: { $cond: [{ $in: ["$status", PENDING_LIKE] }, 1, 0] },
        },
      },
    },
  ]).exec();

  return buildDevStats(rows);
};

/**
 * Merge live counts into plain campaign objects.
 *
 * @param {Array} campaigns  Mongoose docs or plain objects (owner must be set
 *                           on the first one for the dev lookup)
 * @returns {Promise<Array>} plain objects with `statistics` / `devStats` filled
 */
export const attachCampaignCounts = async (campaigns = []) => {
  if (!campaigns.length) return campaigns;

  const docs = campaigns.map((c) => (c.toObject ? c.toObject() : c));
  const ownerId = docs[0]?.owner;

  const normalIds = docs
    .filter((c) => !isDevCampaign(c))
    .map((c) => c._id);
  const devTemplateIds = docs
    .filter((c) => isDevCampaign(c))
    .map((c) => c.template?._id || c.template)
    .filter(Boolean);

  const [recipientStats, devApiStats] = await Promise.all([
    fetchRecipientStats(normalIds),
    fetchDevApiStats(ownerId, devTemplateIds),
  ]);

  return docs.map((doc) => {
    if (isDevCampaign(doc)) {
      const templateId = String(doc.template?._id || doc.template);
      const dev = devApiStats.get(templateId);
      if (dev) {
        doc.devStats = {
          ...(doc.devStats || {}),
          // Stored counter when it exists, otherwise every API message row.
          apiCalls: doc.devStats?.apiCalls || dev.total,
          sent: dev.sent,
          failed: dev.failed,
          queued: dev.queued,
          total: dev.total,
        };
      }
      return doc;
    }

    // Normal campaigns: recipients are the source of truth. Campaigns without
    // any recipient rows (drafts) keep their stored counters.
    const live = recipientStats.get(String(doc._id));
    if (live) doc.statistics = { ...(doc.statistics || {}), ...live };
    return doc;
  });
};

export default {
  isDevCampaign,
  buildRecipientStats,
  buildDevStats,
  fetchRecipientStats,
  fetchDevApiStats,
  attachCampaignCounts,
};
