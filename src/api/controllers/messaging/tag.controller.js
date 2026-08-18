import tagService from "../../../services/messaging/tag.service.js";

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

const tagController = {
  /** GET /tags — list all tags for the owner */
  async getAll(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const tags = await tagService.listTags(ownerId);
      return res.status(200).json({ status: "success", data: tags });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /tags — create a tag */
  async create(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const tag = await tagService.createTag(ownerId, req.body);
      return res.status(201).json({
        status: "success",
        message: "Tag created",
        data: tag,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** PATCH /tags/:id — update a tag */
  async update(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const tag = await tagService.updateTag(ownerId, req.params.id, req.body);
      return res.status(200).json({
        status: "success",
        message: "Tag updated",
        data: tag,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** DELETE /tags/:id — delete a tag */
  async remove(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      await tagService.deleteTag(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        message: "Tag deleted",
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },
};

export default tagController;
