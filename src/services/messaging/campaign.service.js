import mongoose from "mongoose";
import Campaign from "../../models/messaging/campaign.model.js";
import CampaignRecipient from "../../models/messaging/campaignRecipient.model.js";
import {
  renderTemplate,
  renderTemplateMedia,
} from "../../utils/messaging/template.util.js";
import campaignQueue from "../../jobs/campaign.queue.js";
import { canTransition } from "./campaign/campaign.helpers.js";
import {
  generateAudience,
  previewAudience,
  previewMessage,
} from "./campaign/campaign.audience.js";
import { getDevStats } from "./campaign/campaign.stats.js";

// See: ./campaign/campaign.helpers.js (status transitions, model loaders)
// See: ./campaign/campaign.audience.js (audience + previews)
// See: ./campaign/campaign.stats.js (dev live stats)

const campaignService = {
  /** List campaigns for the owner, optionally filtered by status. */
  async listCampaigns(ownerId, filters = {}) {
    const query = { owner: ownerId };
    if (filters.status) query.status = filters.status;
    return Campaign.find(query)
      .populate("template", "name category type content devMode")
      .sort({ createdAt: -1 })
      .exec();
  },

  async getCampaign(ownerId, id) {
    const campaign = await Campaign.findOne({ _id: id, owner: ownerId })
      .populate("template", "name category type content variables media devMode")
      .populate("audience.groups", "name")
      .populate("audience.tags", "name")
      .exec();
    if (!campaign) {
      const e = new Error("Campaign not found");
      e.statusCode = 404;
      throw e;
    }
    return campaign;
  },

  async createCampaign(ownerId, data) {
    // Dev-template campaigns are pure "live switches" — they never send to an
    // audience; they only keep the template API-callable while running.
    const Template = (await import("../../models/messaging/template.model.js"))
      .default;
    const template = await Template.findById(data.template).exec();
    const devTemplate = !!template?.devMode;

    const campaign = await Campaign.create({
      owner: ownerId,
      name: String(data.name || "").trim(),
      template: data.template,
      audience: data.audience || {},
      variables: data.variables || {},
      // With a schedule the campaign waits in "scheduled" until the
      // auto-start sweep (campaignQueue) fires at scheduledAt.
      status: data.scheduledAt ? "scheduled" : "draft",
      scheduledAt: data.scheduledAt || null,
      sendLimit: data.sendLimit ?? null,
      statistics: {},
      devTemplate,
    });
    return campaign;
  },

  async updateCampaign(ownerId, id, data) {
    const campaign = await Campaign.findOne({ _id: id, owner: ownerId }).exec();
    if (!campaign) {
      const e = new Error("Campaign not found");
      e.statusCode = 404;
      throw e;
    }

    if (data.name !== undefined) campaign.name = String(data.name).trim();
    if (data.template !== undefined) {
      campaign.template = data.template;
      // Re-evaluate dev mode on template change
      const Template = (await import("../../models/messaging/template.model.js"))
        .default;
      const t = await Template.findById(data.template).exec();
      campaign.devTemplate = !!t?.devMode;
    }
    if (data.audience !== undefined) campaign.audience = data.audience || {};
    if (data.variables !== undefined) campaign.variables = data.variables || {};
    if (data.sendLimit !== undefined) campaign.sendLimit = data.sendLimit ?? null;
    if (data.scheduledAt !== undefined) campaign.scheduledAt = data.scheduledAt;
    // Setting a schedule from a draft moves it to "scheduled" (auto-start
    // sweep will pick it up); clearing it moves it back to "draft".
    if (campaign.status === "draft" && campaign.scheduledAt) {
      campaign.status = "scheduled";
    } else if (campaign.status === "scheduled" && !campaign.scheduledAt) {
      campaign.status = "draft";
    }

    // Status may only move through valid transitions
    if (data.status !== undefined && data.status !== campaign.status) {
      if (!canTransition(campaign.status, data.status)) {
        const e = new Error(
          `Invalid status transition from ${campaign.status} to ${data.status}`,
        );
        e.statusCode = 400;
        throw e;
      }
      campaign.status = data.status;
    }

    await campaign.save();
    return campaign;
  },

  async deleteCampaign(ownerId, id) {
    const campaign = await Campaign.findOneAndDelete({
      _id: id,
      owner: ownerId,
    }).exec();
    if (!campaign) {
      const e = new Error("Campaign not found");
      e.statusCode = 404;
      throw e;
    }
    // Cascade-delete recipients (only meaningful in context of a campaign)
    await CampaignRecipient.deleteMany({ campaign: id }).exec();
    return campaign;
  },

  /**
   * Resolve the audience for a campaign into a de-duplicated list of
   * visible (non-blocked, non-opted-out) contact records.
   *
   * Audience is derived from:
   *   - custom groups  (audience.groups)
   *   - tags           (audience.tags)
   *   - selected contacts (audience.contacts)
   * Excluded contacts (audience.excludedContacts) are removed.
   */
  async generateAudience(campaign) {
    // See: ./campaign/campaign.audience.js
    return generateAudience(campaign);
  },

  /**
   * Preview the audience without creating recipients.
   * Returns { total, excluded, contacts: [{ _id, phoneNumber, name }] }
   */
  async previewAudience(ownerId, campaignId) {
    // See: ./campaign/campaign.audience.js
    return previewAudience(this, ownerId, campaignId);
  },

  /**
   * Preview a single rendered message for a contact (by contactId or phoneNumber).
   */
  async previewMessage(ownerId, campaignId, identifier) {
    // See: ./campaign/campaign.audience.js
    return previewMessage(this, ownerId, campaignId, identifier);
  },

  /**
   * Start a campaign: generate audience, create recipients, enqueue jobs.
   */
  async startCampaign(ownerId, id) {
    const campaign = await this.getCampaign(ownerId, id);

    // Dev campaigns can be re-run even after completing (completed is
    // terminal only for normal campaigns — dev campaigns should never end).
    const canStart =
      canTransition(campaign.status, "queued") ||
      canTransition(campaign.status, "running") ||
      (campaign.devTemplate && campaign.status === "completed");
    if (!canStart) {
      const e = new Error("Campaign cannot be started from current status");
      e.statusCode = 400;
      throw e;
    }

    const Template = (
      await import("../../models/messaging/template.model.js")
    ).default;
    const template = await Template.findById(campaign.template).exec();
    if (!template) {
      const e = new Error("Campaign template not found");
      e.statusCode = 404;
      throw e;
    }

    // DEV CAMPAIGN: pure live switch — no audience, no recipients, no sends.
    // It only keeps the template API-callable while running, so it goes
    // straight to "running" and never completes on its own.
    if (campaign.devTemplate || template.devMode) {
      campaign.devTemplate = true;
      campaign.status = "running";
      campaign.startedAt = new Date();
      campaign.completedAt = null;
      campaign.devStats = {
        liveSince: new Date(),
        apiCalls: campaign.devStats?.apiCalls || 0,
      };
      campaign.statistics = {
        total: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        skipped: 0,
      };
      await campaign.save();
      return { campaign, audienceTotal: 0, excluded: [] };
    }

    // Generate the audience
    const { contacts, excluded } = await this.generateAudience(campaign);

    if (contacts.length === 0) {
      const e = new Error("Campaign audience is empty — nothing to send");
      e.statusCode = 400;
      throw e;
    }

    // sendLimit = how many times each contact receives the message.
    // One recipient row per send, so statistics.total = people x repeats.
    const repeats =
      campaign.sendLimit && campaign.sendLimit > 0 ? campaign.sendLimit : 1;

    // Clear any previously created recipients (idempotent re-start)
    await CampaignRecipient.deleteMany({ campaign: id }).exec();

    // Create recipients in bulk (one row per contact per repeat)
    const recipientDocs = [];
    for (const contact of contacts) {
      const variables = {
        ...(campaign.variables || {}),
        name: contact.name || "",
        phoneNumber: contact.phoneNumber,
      };
      const rendered = renderTemplate(template.content, variables);
      const renderedMedia = renderTemplateMedia(template.media, variables);
      for (let i = 0; i < repeats; i++) {
        recipientDocs.push({
          campaign: campaign._id,
          contact: contact._id,
          phoneNumber: contact.phoneNumber,
          sequence: i + 1,
          renderedMessage: rendered,
          renderedMedia,
          status: "pending",
          queuedAt: new Date(),
        });
      }
    }

    // insertMany returns the inserted documents WITH _id populated — the
    // source plain objects do not get _id assigned, so always map from the
    // return value (previously recipientIds were "undefined" and the queue
    // worker failed with a CastError, leaving recipients stuck in queued).
    const insertedRecipients = await CampaignRecipient.insertMany(recipientDocs, {
      ordered: false,
    });

    // Update campaign status + statistics
    campaign.status = "queued";
    campaign.startedAt = new Date();
    campaign.statistics = {
      total: recipientDocs.length,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      skipped: 0,
    };
    await campaign.save();

    // Enqueue all recipients for the worker
    const recipientIds = insertedRecipients.map((r) => r._id);
    await campaignQueue.enqueueCampaign({
      campaignId: campaign._id,
      recipientIds,
      ownerId: campaign.owner.toString(),
      templateType: template.type,
      templateMedia: template.media || null,
    });

    return { campaign, audienceTotal: contacts.length, excluded };
  },

  async pauseCampaign(ownerId, id) {
    const campaign = await this._transition(ownerId, id, "paused");
    campaignQueue.pauseCampaign(campaign._id.toString());
    return campaign;
  },

  async resumeCampaign(ownerId, id) {
    const campaign = await this._transition(ownerId, id, "running");
    campaignQueue.resumeCampaign(campaign._id.toString());
    return campaign;
  },

  async cancelCampaign(ownerId, id) {
    const campaign = await this._transition(ownerId, id, "cancelled");
    campaignQueue.cancelCampaign(campaign._id.toString());

    // Mark remaining pending/queued/sending recipients as skipped (atomic)
    await CampaignRecipient.updateMany(
      {
        campaign: id,
        status: { $in: ["pending", "queued", "sending"] },
      },
      { $set: { status: "skipped" } },
    ).exec();

    // Count remaining and bump the campaign skipped stat directly
    const remaining = await CampaignRecipient.countDocuments({
      campaign: id,
      status: "skipped",
    }).exec();
    await Campaign.updateOne(
      { _id: id },
      { $inc: { "statistics.skipped": remaining } },
    ).exec();

    return campaign;
  },

  async _transition(ownerId, id, newStatus) {
    const campaign = await Campaign.findOne({ _id: id, owner: ownerId }).exec();
    if (!campaign) {
      const e = new Error("Campaign not found");
      e.statusCode = 404;
      throw e;
    }
    if (!canTransition(campaign.status, newStatus)) {
      const e = new Error(
        `Invalid status transition from ${campaign.status} to ${newStatus}`,
      );
      e.statusCode = 400;
      throw e;
    }
    campaign.status = newStatus;
    if (newStatus === "running") campaign.startedAt = new Date();
    if (["completed", "cancelled", "failed"].includes(newStatus)) {
      campaign.completedAt = new Date();
    }
    await campaign.save();
    return campaign;
  },

  /**
   * Increment campaign statistics counters.
   * Called by the queue worker after each send attempt.
   */
  async incrementStat(campaignId, field) {
    if (!campaignId || !mongoose.isValidObjectId(campaignId)) return;
    const update = {};
    update[`statistics.${field}`] = 1;
    await Campaign.updateOne({ _id: campaignId }, { $inc: update }).exec();
  },

  /** Get aggregate recipient statistics for a campaign. */
  /**
   * Dev-campaign live stats — counts API-originated messages for the
   * campaign's template while it is (or was) live.
   */
  async getDevStats(ownerId, campaignId) {
    // See: ./campaign/campaign.stats.js
    return getDevStats(this, ownerId, campaignId);
  },

  /**
   * Cancel a dev campaign's schedule — clears scheduledAt and returns the
   * campaign to draft (nothing runs, API stays off until started).
   */
  async unscheduleCampaign(ownerId, id) {
    const campaign = await Campaign.findOne({ _id: id, owner: ownerId }).exec();
    if (!campaign) {
      const e = new Error("Campaign not found");
      e.statusCode = 404;
      throw e;
    }
    if (campaign.status !== "scheduled") {
      const e = new Error("Campaign is not scheduled");
      e.statusCode = 400;
      throw e;
    }
    campaign.scheduledAt = null;
    campaign.status = "draft";
    await campaign.save();
    return campaign;
  },

  async getRecipientStats(campaignId) {
    return CampaignRecipient.aggregate([
      { $match: { campaign: new mongoose.Types.ObjectId(campaignId) } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]).exec();
  },
};

export default campaignService;
