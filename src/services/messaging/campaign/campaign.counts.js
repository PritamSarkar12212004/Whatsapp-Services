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

/**
 * Pick the freshest numbers for one campaign.
 *
 * `Campaign.statistics` is a denormalised counter that can be empty even though
 * real activity exists (older campaigns, API sends, counters written by an
 * earlier version), so it is only the last resort:
 *
 *   1. recipients  — whatever the campaign actually did to its audience
 *   2. messages    — Message rows carrying this campaign id (covers campaigns
 *                    whose recipient rows were never created / got cleaned up)
 *   3. stored      — the denormalised `statistics` counters
 */
export const pickStatistics = ({ recipients, messages, stored } = {}) => {
  const base = { ...emptyStatistics(), ...(stored || {}) };
  const live = recipients?.total ? recipients : messages?.total ? messages : null;
  return live ? { ...base, ...live } : base;
};

/**
 * The numbers a dev campaign shows in the table.
 *
 * Dev templates are "live switches" — every API call increments
 * `devStats.apiCalls` on the linked campaign (see message.helpers.js), while
 * per-message rows only exist for calls made after Message got its
 * `template`/`source` fields. So: use the message rows when they exist, and
 * otherwise fall back to the call counter rather than showing 0.
 */
export const buildDevStatsView = ({ rows, stored, storedApiCalls = 0 } = {}) => {
  const counters = rows || emptyStatistics();
  const apiCalls = Math.max(storedApiCalls || 0, counters.total || 0);
  const hasRows = (counters.total || 0) > 0;

  return {
    ...(stored || {}),
    apiCalls,
    total: apiCalls,
    // Without rows the exact split is unknown — an accepted call is the best
    // available answer (failures still show up in the drawer's live stats).
    sent: hasRows ? counters.sent : apiCalls,
    delivered: hasRows ? counters.delivered : 0,
    read: hasRows ? counters.read : 0,
    failed: hasRows ? counters.failed : 0,
    queued: hasRows ? Math.max(0, (counters.total || 0) - counters.sent - counters.failed) : 0,
  };
};

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
 *
 * Used for both sources — CampaignRecipient rows and Message rows — because both
 * group the same way (`campaign` + `status`).
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

/** Message rows carrying a campaign id, grouped the same way as recipients. */
export const fetchMessageStats = async (campaignIds = []) => {
  if (!campaignIds.length) return new Map();

  const Message = await getMessageModel();
  const rows = await Message.aggregate([
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

  const [recipientStats, messageStats, devApiStats] = await Promise.all([
    fetchRecipientStats(normalIds),
    fetchMessageStats(normalIds),
    fetchDevApiStats(ownerId, devTemplateIds),
  ]);

  return docs.map((doc) => {
    if (isDevCampaign(doc)) {
      const templateId = String(doc.template?._id || doc.template);
      // Always filled — a dev campaign with API calls must never read as 0 just
      // because its calls predate the Message.template/source fields.
      doc.devStats = buildDevStatsView({
        rows: devApiStats.get(templateId),
        stored: doc.devStats,
        storedApiCalls: doc.devStats?.apiCalls || 0,
      });
      return doc;
    }

    // Normal campaigns: recipients are the source of truth, Message rows the
    // backup, stored counters the last resort — see pickStatistics().
    doc.statistics = pickStatistics({
      recipients: recipientStats.get(String(doc._id)),
      messages: messageStats.get(String(doc._id)),
      stored: doc.statistics,
    });
    return doc;
  });
};

export default {
  isDevCampaign,
  buildRecipientStats,
  buildDevStats,
  buildDevStatsView,
  pickStatistics,
  fetchRecipientStats,
  fetchMessageStats,
  fetchDevApiStats,
  attachCampaignCounts,
};
