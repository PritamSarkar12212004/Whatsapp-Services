import Template from "../../models/crm/template.model.js";
import { extractVariables, renderTemplate } from "../../utils/crm/template.util.js";

const templateService = {
  /** List all templates owned by the user. */
  async listTemplates(ownerId, options = {}) {
    const filter = { owner: ownerId };
    if (options.status) filter.status = options.status;
    if (options.category) filter.category = options.category;
    return Template.find(filter).sort({ createdAt: -1 }).exec();
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
    const template = await Template.create({
      owner: ownerId,
      name: String(data.name || "").trim(),
      category: data.category || "custom",
      type: data.type || "text",
      content,
      variables: Array.isArray(data.variables) && data.variables.length
        ? data.variables
        : detected,
      media: data.media || null,
      status: data.status || "active",
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
    return {
      template,
      variables: template.variables,
      providedVariables: variables,
      rendered,
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
