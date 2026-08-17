import mongoose from "mongoose";
import Template from "../../models/messaging/template.model.js";
import Campaign from "../../models/messaging/campaign.model.js";
import {
  extractVariables,
  extractUrlFromText,
  renderTemplate,
  renderTemplateMedia,
} from "../../utils/messaging/template.util.js";

// Dev-mode media templates carry the media link inside the content.
// Derive the media object from the content when no media URL is provided.
const deriveMediaFromContent = (content, type, media, devMode) => {
  if (!devMode || type === "text") return media || null;
  if (media && media.url) return media;
  const url = extractUrlFromText(content);
  if (!url) return media || null;
  return {
    url,
    filename: media?.filename || null,
    mimeType: media?.mimeType || null,
    caption: content.replace(url, "").trim() || null,
  };
};

const templateService = {
  /** List all templates owned by the user. */
  async listTemplates(ownerId, options = {}) {
    const filter = { owner: ownerId };
    if (options.status) filter.status = options.status;
    if (options.category) filter.category = options.category;
    const templates = await Template.find(filter).sort({ createdAt: -1 }).exec();

    // Dev-mode templates are API-enabled only while one of their campaigns is
    // RUNNING (queued/running). Expose the link count + gate state so the
    // frontend can show the template lifecycle:
    //  - off        : no (non-cancelled) campaign -> "API OFF"
    //  - added      : campaign exists, none running (draft/scheduled/completed)
    //                 -> "In campaign" (press Run to go live)
    //  - paused     : all campaigns paused -> "API paused"
    //  - live       : >=1 queued/running campaign -> "API LIVE"
    // Note: aggregate() does NOT cast query values — cast ids to ObjectId
    // explicitly (countDocuments would, but aggregate won't).
    const { Types } = mongoose;
    const devIds = templates.filter((t) => t.devMode).map((t) => t._id);
    let campaignCounts = new Map();
    let runningCounts = new Map();
    let pausedCounts = new Map();
    if (devIds.length > 0) {
      const rows = await Campaign.aggregate([
        {
          $match: {
            owner: new Types.ObjectId(String(ownerId)),
            template: { $in: devIds.map((id) => new Types.ObjectId(String(id))) },
            status: { $ne: "cancelled" },
          },
        },
        {
          $group: {
            _id: "$template",
            count: { $sum: 1 },
            running: {
              $sum: { $cond: [{ $in: ["$status", ["queued", "running"]] }, 1, 0] },
            },
            paused: { $sum: { $cond: [{ $eq: ["$status", "paused"] }, 1, 0] } },
          },
        },
      ]).exec();
      campaignCounts = new Map(rows.map((r) => [String(r._id), r.count]));
      runningCounts = new Map(rows.map((r) => [String(r._id), r.running || 0]));
      pausedCounts = new Map(rows.map((r) => [String(r._id), r.paused || 0]));
    }

    return templates.map((t) => {
      const plain = t.toObject();
      if (!t.devMode) {
        plain.inCampaignCount = 0;
        plain.apiEnabled = true;
        plain.gateState = "enabled";
      } else {
        const total = campaignCounts.get(String(t._id)) || 0;
        const running = runningCounts.get(String(t._id)) || 0;
        const paused = pausedCounts.get(String(t._id)) || 0;
        plain.inCampaignCount = total;
        plain.apiEnabled = running > 0;
        plain.gateState =
          total === 0
            ? "off"
            : running > 0
              ? "live"
              : paused === total
                ? "paused"
                : "added";
      }
      return plain;
    });
  },

  async getTemplate(ownerId, id) {
    const template = await Template.findOne({ _id: id, owner: ownerId }).exec();
    if (!template) {
      const e = new Error("Template not found");
      e.statusCode = 404;
      throw e;
    }
    return template;
  },

  /**
   * Create a template. Variables are auto-extracted from the content
   * but can be overridden by passing `variables` explicitly.
   */
  async createTemplate(ownerId, data) {
    const content = String(data.content || "");
    const detected = extractVariables(content);
    const devMode = data.devMode === true;
    const media = deriveMediaFromContent(
      content,
      data.type || "text",
      data.media || null,
      devMode,
    );
    const template = await Template.create({
      owner: ownerId,
      name: String(data.name || "").trim(),
      category: data.category || "custom",
      type: data.type || "text",
      content,
      variables: Array.isArray(data.variables) && data.variables.length
        ? data.variables
        : detected,
      media,
      status: data.status || "active",
      devMode,
      scheduleEnabled: data.scheduleEnabled === true,
    });
    return template;
  },

  async updateTemplate(ownerId, id, data) {
    const template = await Template.findOne({ _id: id, owner: ownerId }).exec();
    if (!template) {
      const e = new Error("Template not found");
      e.statusCode = 404;
      throw e;
    }

    if (data.name !== undefined) template.name = String(data.name).trim();
    if (data.category !== undefined) template.category = data.category;
    if (data.type !== undefined) template.type = data.type;
    if (data.content !== undefined) {
      template.content = String(data.content);
      // Re-derive variables from the updated content
      template.variables = Array.isArray(data.variables) && data.variables.length
        ? data.variables
        : extractVariables(template.content);
    } else if (data.variables !== undefined) {
      template.variables = data.variables;
    }
    if (data.media !== undefined) template.media = data.media;
    if (data.status !== undefined) template.status = data.status;
    if (data.devMode !== undefined) template.devMode = data.devMode === true;
    if (data.scheduleEnabled !== undefined)
      template.scheduleEnabled = data.scheduleEnabled === true;

    // Dev-mode media templates: re-derive the media URL from content when
    // no explicit media URL was provided (URL lives inside the content).
    template.media = deriveMediaFromContent(
      template.content,
      template.type,
      template.media,
      template.devMode,
    );

    await template.save();
    return template;
  },

  async deleteTemplate(ownerId, id) {
    const template = await Template.findOneAndDelete({
      _id: id,
      owner: ownerId,
    }).exec();
    if (!template) {
      const e = new Error("Template not found");
      e.statusCode = 404;
      throw e;
    }
    return template;
  },

  /**
   * Render a template preview for the authenticated owner.
   * Only templates that belong to the owner can be previewed.
   */
  async previewTemplate(ownerId, id, variables = {}) {
    const template = await this.getTemplate(ownerId, id);
    const rendered = renderTemplate(template.content, variables);
    const renderedMedia = renderTemplateMedia(template.media, variables);
    return {
      template,
      variables: template.variables,
      providedVariables: variables,
      rendered,
      renderedMedia,
    };
  },

  /**
   * Find a template by name (owner-scoped) or by id.
   * Used by the transactional message API.
   */
  async findTemplate(ownerId, identifier) {
    if (!identifier) {
      const e = new Error("Template identifier is required");
      e.statusCode = 400;
      throw e;
    }
    const query = { owner: ownerId };
    if (/^[0-9a-fA-F]{24}$/.test(String(identifier))) {
      query._id = identifier;
    } else {
      query.name = String(identifier).trim();
    }
    const template = await Template.findOne(query).exec();
    if (!template) {
      const e = new Error("Template not found");
      e.statusCode = 404;
      throw e;
    }
    if (template.status === "inactive" || template.status === "draft") {
      const e = new Error("Template is not active");
      e.statusCode = 400;
      throw e;
    }
    return template;
  },
};

export default templateService;
