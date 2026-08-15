import contactService from "../../services/crm/contact.service.js";
import { triggerContactSync } from "../../whatsapp/whatsappManager.js";
import { parseCsv, csvRowsToObject, toCsv } from "../../utils/crm/csv.util.js";

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

const contactController = {
  /**
   * GET /contacts
   * List contacts with pagination, filtering and search.
   * Query: ?page=&limit=&known=&unknown=&blocked=&optedOut=&groupId=&tagId=&search=
   */
  async getAll(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const filters = {
        known: req.query.known,
        unknown: req.query.unknown,
        blocked: req.query.blocked,
        optedOut: req.query.optedOut,
        genuine: req.query.genuine,
        groupId: req.query.groupId,
        tagId: req.query.tagId,
        isBusiness: req.query.isBusiness,
        search: req.query.search,
        phoneNumber: req.query.phoneNumber,
      };

      const result = await contactService.listContacts(ownerId, filters, {
        page: req.query.page,
        limit: req.query.limit,
      });

      // User opened the CRM list (website load) → refresh WhatsApp contacts
      // in the background, throttled to once per 15 minutes per user.
      triggerContactSync(ownerId, {
        reason: "list-open",
        minIntervalMs: 15 * 60 * 1000,
      }).catch((err) => {
        console.error("[Contacts Sync] List-open triggered sync failed:", err.message);
      });

      return res.status(200).json({
        status: "success",
        data: result.contacts,
        pagination: result.pagination,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /contacts/:id — contact details */
  async getOne(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const contact = await contactService.getContact(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        data: contact,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /contacts — create a contact */
  async create(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const contact = await contactService.createContact(ownerId, req.body);
      return res.status(201).json({
        status: "success",
        message: "Contact created",
        data: contact,
      });
    } catch (err) {
      if (err.statusCode === 409 && err.existingContact) {
        return res.status(409).json({
          status: "error",
          message: "Contact already exists",
          data: err.existingContact,
        });
      }
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** PATCH /contacts/:id — update a contact */
  async update(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const contact = await contactService.updateContact(
        ownerId,
        req.params.id,
        req.body,
      );
      return res.status(200).json({
        status: "success",
        message: "Contact updated",
        data: contact,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** DELETE /contacts/:id — delete a contact */
  async remove(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      await contactService.deleteContact(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        message: "Contact deleted",
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /contacts/blocked — blocked contacts */
  async getBlocked(req, res) {
    req.query.blocked = "true";
    return contactController.getAll(req, res);
  },

  /** GET /contacts/known — saved contacts */
  async getKnown(req, res) {
    req.query.known = "true";
    return contactController.getAll(req, res);
  },

  /** GET /contacts/unknown — unknown contacts */
  async getUnknown(req, res) {
    req.query.unknown = "true";
    return contactController.getAll(req, res);
  },

  /**
   * POST /contacts/sync-whatsapp
   * Manually trigger a WhatsApp contact synchronization for the authenticated
   * user's active WhatsApp connection.
   */
  async syncWhatsApp(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const result = await triggerContactSync(ownerId, { reason: "manual" });

      if (result.error) {
        return res.status(409).json({
          status: "error",
          message: result.error,
        });
      }

      return res.status(200).json({
        status: "success",
        message: "WhatsApp contacts synchronized",
        data: {
          found: result.found || 0,
          inserted: result.inserted || 0,
          updated: result.updated || 0,
          skippedGroups: result.skippedGroups || 0,
          skippedInvalid: result.skippedInvalid || 0,
          skippedSelf: result.skippedSelf || 0,
        },
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /contacts/import — import contacts from CSV text */
  async import(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const { csv, updateExisting, assignGroups, assignTags } = req.body;

      if (!csv || typeof csv !== "string") {
        return res.status(400).json({
          status: "error",
          message: "CSV text is required in the 'csv' field",
        });
      }

      const { headers, rows } = parseCsv(csv);
      if (!headers.length) {
        return res.status(400).json({
          status: "error",
          message: "CSV appears to be empty or has no header row",
        });
      }

      const hasPhone = headers.some((h) => h.toLowerCase().includes("phone"));
      if (!hasPhone) {
        return res.status(400).json({
          status: "error",
          message: "CSV must contain a phone number column",
        });
      }

      const objects = csvRowsToObject(headers, rows);

      const summary = await contactService.importContacts(ownerId, objects, {
        updateExisting: !!updateExisting,
        assignGroups: Array.isArray(assignGroups) ? assignGroups : [],
        assignTags: Array.isArray(assignTags) ? assignTags : [],
      });

      return res.status(200).json({
        status: "success",
        message: "Import completed",
        data: summary,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /contacts/export — export contacts to CSV */
  async export(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const filters = {
        known: req.query.known,
        unknown: req.query.unknown,
        blocked: req.query.blocked,
        groupId: req.query.groupId,
        tagId: req.query.tagId,
        search: req.query.search,
      };

      // Export selected contacts by id
      if (req.query.contactIds) {
        const ids = String(req.query.contactIds)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const result = await contactService.exportSelectedContacts(ownerId, ids);
        const csvText = toCsv(result.headers, result.rows);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="contacts-export-${Date.now()}.csv"`,
        );
        return res.status(200).send(csvText);
      }

      const result = await contactService.exportContacts(ownerId, filters);
      const csvText = toCsv(result.headers, result.rows);

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="contacts-export-${Date.now()}.csv"`,
      );
      return res.status(200).send(csvText);
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /contacts/search?q=... — search contacts */
  async search(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const query = req.query.q || req.query.query;
      const result = await contactService.searchContacts(ownerId, query, {
        page: req.query.page,
        limit: req.query.limit,
      });

      return res.status(200).json({
        status: "success",
        data: result.contacts,
        pagination: result.pagination,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /contacts/:id/block — block a contact */
  async block(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const contact = await contactService.blockContact(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        message: "Contact blocked",
        data: contact,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /contacts/:id/unblock — unblock a contact */
  async unblock(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const contact = await contactService.updateContact(ownerId, req.params.id, {
        isBlocked: false,
      });
      return res.status(200).json({
        status: "success",
        message: "Contact unblocked",
        data: contact,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** POST /contacts/:id/opt-out — opt a contact out */
  async optOut(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const contact = await contactService.optOutContact(ownerId, req.params.id);
      return res.status(200).json({
        status: "success",
        message: "Contact opted out",
        data: contact,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /**
   * Replace the entire tag set on a contact.
   * POST /contacts/:id/tags  body: { tags: ["premium", "lead"] }
   */
  async setTags(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const contact = await contactService.updateContact(ownerId, req.params.id, {
        tags: req.body.tags,
      });

      return res.status(200).json({
        status: "success",
        message: "Tags updated for contact",
        data: contact,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },

  /** GET /contacts/:id/activities — activity log for a contact */
  async getActivities(req, res) {
    try {
      const ownerId = requireOwner(req, res);
      if (!ownerId) return;

      const { getActivityLog } = await import(
        "../../services/crm/activity.service.js"
      );
      const activities = await getActivityLog(ownerId, req.params.id, {
        limit: req.query.limit,
      });
      return res.status(200).json({
        status: "success",
        data: activities,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        status: "error",
        message: err.message || "Internal server error",
      });
    }
  },
};

export default contactController;
