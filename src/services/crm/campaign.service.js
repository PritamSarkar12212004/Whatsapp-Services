import mongoose from "mongoose";
import Campaign from "../../models/crm/campaign.model.js";
import CampaignRecipient from "../../models/crm/campaignRecipient.model.js";
import Contact from "../../models/crm/contact.model.js";
import { normalizePhoneNumber } from "../../utils/crm/phone.util.js";
import { renderTemplate } from "../../utils/crm/template.util.js";
import campaignQueue from "../../queue/campaignQueue.js";

const VALID_TRANSITIONS = {
  draft: ["scheduled", "queued", "running", "cancelled"],
  scheduled: ["queued", "running", "paused", "cancelled", "failed"],
  queued: ["running", "paused", "cancelled", "failed"],
  running: ["paused", "completed", "cancelled", "failed"],
  paused: ["running", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: ["queued", "running", "cancelled"],
};

const canTransition = (from, to) => {
  const allowed = VALID_TRANSITIONS[from] || [];
  return allowed.includes(to);
};

const campaignService = {
  /** List campaigns for the owner, optionally filtered by status. */
  async listCampaigns(ownerId, filters = {}) {
    const query = { owner: ownerId };
    if (filters.status) query.status = filters.status;
    return Campaign.find(query)
      .populate("template", "name category type content")
      .sort({ createdAt: -1 })
      .exec();
  },

  async getCampaign(ownerId, id) {
    const campaign = await Campaign.findOne({ _id: id, owner: ownerId })
      .populate("template", "name category type content variables media")
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
    if (data.template !== undefined) campaign.template = data.template;
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
    const ownerId = campaign.owner;
    const { groups, tags, contacts: selected, excludedContacts } =
      campaign.audience || {};

    const orConditions = [];
    if (Array.isArray(groups) && groups.length) {
      orConditions.push({ customGroups: { $in: groups } });
    }
    if (Array.isArray(tags) && tags.length) {
      orConditions.push({ tags: { $in: tags } });
    }
    if (Array.isArray(selected) && selected.length) {
      orConditions.push({ _id: { $in: selected } });
    }

    // If no audience source is selected, there is nobody to send to
    if (!orConditions.length) {
      return { contacts: [], excluded: 0 };
    }

    const excludedIds = Array.from(
      new Set(
        (Array.isArray(excludedContacts) ? excludedContacts : [])
          .map((c) => c.toString())
          .filter(Boolean),
      ),
    );

    const baseMatch = {
      owner: ownerId,
      isBlocked: { $ne: true },
      isOptedOut: { $ne: true },
      $or: orConditions,
    };

    if (excludedIds.length) {
      baseMatch._id = { $nin: excludedIds };
    }

    const matched = await Contact.find(baseMatch)
      .select("_id phoneNumber name")
      .exec();

    // Count how many were excluded due to block/opt-out
    const blockExcludeMatch = {
      owner: ownerId,
      $or: orConditions,
      $or: [{ isBlocked: true }, { isOptedOut: true }],
    };
    if (excludedIds.length) {
      blockExcludeMatch._id = { $nin: excludedIds };
    }
    const excludedCount = await Contact.countDocuments(blockExcludeMatch).exec();

    return { contacts: matched, excluded: excludedCount };
  },

  /**
   * Preview the audience without creating recipients.
   * Returns { total, excluded, contacts: [{ _id, phoneNumber, name }] }
   */
  async previewAudience(ownerId, campaignId) {
    const campaign = await this.getCampaign(ownerId, campaignId);
    const Template = (
      await import("../../models/crm/template.model.js")
    ).default;
    const template = await Template.findById(campaign.template).exec();
    const { contacts, excluded } = await this.generateAudience(campaign);
    // sendLimit = how many times each contact gets the message (repeat count)
    const repeats =
      campaign.sendLimit && campaign.sendLimit > 0 ? campaign.sendLimit : 1;
    return {
      total: contacts.length * repeats,
      people: contacts.length,
      sendsPerContact: repeats,
      excluded,
      template: template
        ? { name: template.name, content: template.content }
        : null,
      contacts: contacts.map((c) => ({
        _id: c._id,
        phoneNumber: c.phoneNumber,
        name: c.name,
      })),
    };
  },

  /**
   * Preview a single rendered message for a contact (by contactId or phoneNumber).
   */
  async previewMessage(ownerId, campaignId, identifier) {
    const campaign = await this.getCampaign(ownerId, campaignId);
    const Template = (
      await import("../../models/crm/template.model.js")
    ).default;
    const template = await Template.findById(campaign.template).exec();
    if (!template) {
      const e = new Error("Template not found");
      e.statusCode = 404;
      throw e;
    }

    let contact;
    if (/^[0-9a-fA-F]{24}$/.test(String(identifier))) {
      contact = await Contact.findOne({ _id: identifier, owner: ownerId })
        .select("phoneNumber name")
        .exec();
    } else {
      const normalised = normalizePhoneNumber(identifier);
      if (normalised) {
        contact = await Contact.findOne({
          owner: ownerId,
          phoneNumber: normalised,
        })
          .select("phoneNumber name")
          .exec();
      }
    }

    const name = contact?.name || contact?.phoneNumber || "";
    const variables = { ...(campaign.variables || {}), name };
    const rendered = renderTemplate(template.content, variables);

    return {
      template: { name: template.name, content: template.content },
      contact: contact
        ? {
            _id: contact._id,
            phoneNumber: contact.phoneNumber,
            name: contact.name,
          }
        : null,
      rendered,
    };
  },

  /**
   * Start a campaign: generate audience, create recipients, enqueue jobs.
   */
  async startCampaign(ownerId, id) {
    const campaign = await this.getCampaign(ownerId, id);

    if (
      !canTransition(campaign.status, "queued") &&
      !canTransition(campaign.status, "running")
    ) {
      const e = new Error("Campaign cannot be started from current status");
      e.statusCode = 400;
      throw e;
    }

    const Template = (
      await import("../../models/crm/template.model.js")
    ).default;
    const template = await Template.findById(campaign.template).exec();
    if (!template) {
      const e = new Error("Campaign template not found");
      e.statusCode = 404;
      throw e;
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
      for (let i = 0; i < repeats; i++) {
        recipientDocs.push({
          campaign: campaign._id,
          contact: contact._id,
          phoneNumber: contact.phoneNumber,
          sequence: i + 1,
          renderedMessage: rendered,
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
