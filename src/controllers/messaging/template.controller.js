import templateService from "../../services/messaging/template.service.js";

const getOwnerId = (req) => req.user?.userId;

const requireOwner = (req, res) => {
  const ownerId = getOwnerId(req);
  if (!ownerId) {
    return res
      .status(401)
      .json({ status: "error", message: "User not authenticated" });
  }
  return ownerId;
};

const templateController = {
  /** GET /templates — list templates (optionally filter by status/category) */
  async getAll(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const filters = {
        status: req.query.status,
        category: req.query.category,
      };
      const templates = await templateService.listTemplates(ownerId, filters);
      return res.status(200).json({ status: "success", data: templates });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /templates — create a template */
  async create(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const template = await templateService.createTemplate(ownerId, req.body);
      return res.status(201).json({
        status: "success",
        message: "Template created",
        data: template,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /templates/:id — template details */
  async getOne(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const template = await templateService.getTemplate(ownerId, req.params.id);
      return res.status(200).json({ status: "success", data: template });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** PATCH /templates/:id — update a template */
  async update(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const template = await templateService.updateTemplate(
        ownerId,
        req.params.id,
        req.body,
      );
      return res.status(200).json({
        status: "success",
        message: "Template updated",
        data: template,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** DELETE /templates/:id — delete a template */
  async remove(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      await templateService.deleteTemplate(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        message: "Template deleted",
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /**
   * POST /templates/:id/preview
   * body: { variables: { name: "Pritam", otp: "123456" } }
   */
  async preview(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const result = await templateService.previewTemplate(
        ownerId,
        req.params.id,
        req.body.variables || {},
      );
      return res.status(200).json({
        status: "success",
        message: "Template preview generated",
        data: result,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },
};

export default templateController;
