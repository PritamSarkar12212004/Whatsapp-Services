import Message from "../../models/messaging/message.model.js";
import Campaign from "../../models/messaging/campaign.model.js";
import CampaignRecipient from "../../models/messaging/campaignRecipient.model.js";
import Contact from "../../models/messaging/contact.model.js";
import ContactActivity from "../../models/messaging/contactActivity.model.js";
import { getSocket } from "../../whatsapp/whatsappManager.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const lastNDays = (n) => {
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY_MS);
    days.push({
      start: d,
      end: new Date(d.getTime() + DAY_MS),
      key: d.toISOString().slice(0, 10),
    });
  }
  return days;
};

const analyticsController = {
  /**
   * GET /messaging/analytics
   * Aggregated dashboard analytics for the connected account.
   */
  async getAnalytics(req, res) {
    try {
      const ownerId = req.user.userId;

      if (!ownerId) {
        return res.status(401).json({
          status: "error",
          message: "User not authenticated",
        });
      }

      const days = lastNDays(14);
      const since = days[0].start;

      // ------------------------------------------------------------------
      // 1. Overview counters
      // ------------------------------------------------------------------
      const [messageCounts, campaignCounts, contactCount, recipientCounts] =
        await Promise.all([
          Message.aggregate([
            { $match: { owner: ownerId } },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                sent: {
                  $sum: { $cond: [{ $in: ["$status", ["sent", "delivered", "read"]] }, 1, 0] },
                },
                delivered: { $sum: { $cond: [{ $in: ["$status", ["delivered", "read"]] }, 1, 0] } },
                read: { $sum: { $cond: [{ $eq: ["$status", "read"] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
                pending: {
                  $sum: {
                    $cond: [
                      { $in: ["$status", ["pending", "queued", "sending", "scheduled"]] },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ]),
          Campaign.aggregate([
            { $match: { owner: ownerId } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ]),
          Contact.countDocuments({ owner: ownerId }),
          CampaignRecipient.aggregate([
            { $match: { status: { $in: ["sent", "delivered", "read", "failed"] } } },
            {
              $group: {
                _id: null,
                sent: { $sum: 1 },
                delivered: { $sum: { $cond: [{ $in: ["$status", ["delivered", "read"]] }, 1, 0] } },
                read: { $sum: { $cond: [{ $eq: ["$status", "read"] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
              },
            },
          ]),
        ]);

      const mc = messageCounts[0] || {};
      const rc = recipientCounts[0] || {};

      const overview = {
        totalMessages: mc.total || 0,
        sent: mc.sent || 0,
        delivered: mc.delivered || 0,
        read: mc.read || 0,
        failed: mc.failed || 0,
        pending: mc.pending || 0,
        recipientsDelivered: rc.delivered || 0,
        recipientsRead: rc.read || 0,
        recipientsFailed: rc.failed || 0,
        totalContacts: contactCount || 0,
        totalCampaigns: campaignCounts.reduce((a, r) => a + r.count, 0),
        runningCampaigns:
          campaignCounts.find((r) => ["running", "queued"].includes(r._id))?.count || 0,
      };

      // WhatsApp groups count (best effort — only when connected)
      let groupsCount = 0;
      try {
        const sock = getSocket(ownerId);
        if (sock) {
          const groups = await sock.groupFetchAllParticipating();
          groupsCount = Object.keys(groups || {}).length;
        }
      } catch (err) {
        groupsCount = 0;
      }
      overview.totalGroups = groupsCount;

      // ------------------------------------------------------------------
      // 2. Messages over the last 14 days
      // ------------------------------------------------------------------
      const dailyRows = await Message.aggregate([
        {
          $match: {
            owner: ownerId,
            createdAt: { $gte: since },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            total: { $sum: 1 },
            sent: {
              $sum: { $cond: [{ $in: ["$status", ["sent", "delivered", "read"]] }, 1, 0] },
            },
            delivered: {
              $sum: { $cond: [{ $in: ["$status", ["delivered", "read"]] }, 1, 0] },
            },
            read: { $sum: { $cond: [{ $eq: ["$status", "read"] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          },
        },
      ]);
      const byDay = new Map(dailyRows.map((r) => [r._id, r]));

      const messagesOverTime = days.map((d) => {
        const row = byDay.get(d.key) || {};
        return {
          date: d.key,
          label: new Date(d.start).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          }),
          total: row.total || 0,
          sent: row.sent || 0,
          delivered: row.delivered || 0,
          read: row.read || 0,
          failed: row.failed || 0,
        };
      });

      // ------------------------------------------------------------------
      // 3. Status breakdown (donut)
      // ------------------------------------------------------------------
      const statusCounts = await Message.aggregate([
        { $match: { owner: ownerId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]);
      const statusMap = new Map(statusCounts.map((r) => [r._id, r.count]));
      const statusLabels = {
        sent: "Sent",
        delivered: "Delivered",
        read: "Read",
        failed: "Failed",
        pending: "Pending",
        queued: "Queued",
        sending: "Sending",
        scheduled: "Scheduled",
        cancelled: "Cancelled",
        skipped: "Skipped",
      };
      const statusBreakdown = Object.entries(statusMap)
        .filter(([key]) => statusLabels[key])
        .map(([key, value]) => ({ name: statusLabels[key], value }))
        .sort((a, b) => b.value - a.value);

      // ------------------------------------------------------------------
      // 4. Campaign status breakdown + top campaigns
      // ------------------------------------------------------------------
      const campaignStatusLabels = {
        draft: "Draft",
        scheduled: "Scheduled",
        queued: "Queued",
        running: "Running",
        paused: "Paused",
        completed: "Completed",
        cancelled: "Cancelled",
        failed: "Failed",
      };
      const campaignBreakdown = campaignCounts
        .map((r) => ({
          name: campaignStatusLabels[r._id] || r._id,
          value: r.count,
        }))
        .sort((a, b) => b.value - a.value);

      const topCampaigns = await Campaign.aggregate([
        { $match: { owner: ownerId } },
        { $sort: { "statistics.sent": -1 } },
        { $limit: 6 },
        {
          $project: {
            name: 1,
            status: 1,
            sent: { $ifNull: ["$statistics.sent", 0] },
            delivered: { $ifNull: ["$statistics.delivered", 0] },
            read: { $ifNull: ["$statistics.read", 0] },
            failed: { $ifNull: ["$statistics.failed", 0] },
          },
        },
      ]);

      // ------------------------------------------------------------------
      // 5. Message type breakdown
      // ------------------------------------------------------------------
      const typeCounts = await Message.aggregate([
        { $match: { owner: ownerId } },
        { $group: { _id: "$type", count: { $sum: 1 } } },
      ]);
      const typeMap = new Map(typeCounts.map((r) => [r._id, r.count]));
      const typeLabels = {
        text: "Text",
        image: "Image",
        video: "Video",
        audio: "Audio",
        document: "Document",
        sticker: "Sticker",
        location: "Location",
        contact: "Contact",
      };
      const messageTypes = Object.entries(typeMap)
        .map(([key, value]) => ({ name: typeLabels[key] || key, value }))
        .sort((a, b) => b.value - a.value);

      // ------------------------------------------------------------------
      // 6. Recent activity feed
      // ------------------------------------------------------------------
      const activityLabels = {
        imported: "Contact imported",
        updated: "Contact updated",
        added_to_group: "Added to group",
        removed_from_group: "Removed from group",
        tagged: "Tagged",
        untagged: "Untagged",
        message_sent: "Message sent",
        message_received: "Message received",
        campaign_sent: "Campaign sent",
        campaign_delivered: "Campaign delivered",
        campaign_read: "Campaign read",
        opted_out: "Opted out",
        blocked: "Blocked",
      };

      const recentActivities = await ContactActivity.find({ owner: ownerId })
        .sort({ timestamp: -1 })
        .limit(12)
        .populate("contact", "name phoneNumber")
        .lean();

      const activityFeed = recentActivities.map((a) => ({
        id: String(a._id),
        type: a.type,
        label: activityLabels[a.type] || a.type,
        contactName: a.contact?.name || a.contact?.phoneNumber || "Unknown",
        timestamp: a.timestamp,
      }));

      return res.status(200).json({
        status: "success",
        data: {
          overview,
          messagesOverTime,
          statusBreakdown,
          campaignBreakdown,
          topCampaigns,
          messageTypes,
          activityFeed,
        },
      });
    } catch (err) {
      console.error("Error getting analytics:", err.message);
      return res.status(500).json({
        status: "error",
        message: "Failed to get analytics",
      });
    }
  },
};

export default analyticsController;
