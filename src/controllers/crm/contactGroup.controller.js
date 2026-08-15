import contactGroupService from "../../services/crm/contactGroup.service.js";

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

const contactGroupController = {
  /** GET /contact-groups — list all groups */
  async getAll(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const groups = await contactGroupService.listGroups(ownerId);
      return res.status(200).json({ status: "success", data: groups });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /contact-groups — create a group */
  async create(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const group = await contactGroupService.createGroup(ownerId, req.body);
      return res.status(201).json({
        status: "success",
        message: "Group created",
        data: group,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /contact-groups/:id — group details */
  async getOne(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const group = await contactGroupService.getGroup(ownerId, req.params.id);
      return res.status(200).json({ status: "success", data: group });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** PATCH /contact-groups/:id — update a group */
  async update(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      const group = await contactGroupService.updateGroup(
        ownerId,
        req.params.id,
        req.body,
      );
      return res.status(200).json({
        status: "success",
        message: "Group updated",
        data: group,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** DELETE /contact-groups/:id — delete a group */
  async remove(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      await contactGroupService.deleteGroup(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        message: "Group deleted",
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /**
   * POST /contact-groups/:id/contacts
   * Add contacts to a group. body: { contactIds: [...] }
   */
  async addContacts(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const contactIds = req.body.contactIds || req.body;
      const ids = Array.isArray(contactIds)
        ? contactIds
        : Array.isArray(req.body.contacts)
          ? req.body.contacts
          : [];

      if (!ids.length) {
        return res.status(400).json({
          status: "error",
          message: "At least one contactId is required",
        });
      }

      const result = await contactGroupService.addContacts(
        ownerId,
        req.params.id,
        ids,
      );
      return res.status(200).json({
        status: "success",
        message: `${result.added} contact(s) added to group`,
        data: result,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /**
   * DELETE /contact-groups/:id/contacts/:contactId
   * Remove a contact from a group.
   */
  async removeContact(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;
      await contactGroupService.removeContact(
        ownerId,
        req.params.id,
        req.params.contactId,
      );
      return res.status(200).json({
        status: "success",
        message: "Contact removed from group",
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },
};

export default contactGroupController;
