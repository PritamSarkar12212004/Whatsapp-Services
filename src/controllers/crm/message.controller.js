import messageService from "../../services/crm/message.service.js";

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

const messageController = {
  /**
   * POST /messages/send — send a transactional message via template.
   *
   * body: { to, template, variables }
   */
  async send(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const result = await messageService.sendTransactional(ownerId, req.body);
      return res.status(202).json({
        status: "success",
        message: "Message queued for sending",
        data: result,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /messages — list messages for the owner */
  async getAll(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const result = await messageService.listMessages(ownerId, {
        page: req.query.page,
        limit: req.query.limit,
        direction: req.query.direction,
        status: req.query.status,
        contactId: req.query.contactId,
        campaignId: req.query.campaignId,
      });

      return res.status(200).json({
        status: "success",
        data: result.messages,
        pagination: result.pagination,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /messages/:id — message details */
  async getOne(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const message = await messageService.getMessage(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        data: message,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },
};

export default messageController;
