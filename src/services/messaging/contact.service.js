import Contact from "../../models/messaging/contact.model.js";
import ContactGroup from "../../models/messaging/contactGroup.model.js";
import Tag from "../../models/messaging/tag.model.js";
import activityService from "./activity.service.js";
import { normalizePhoneNumber } from "../../utils/messaging/phone.util.js";
import {
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  escapeRegex,
  parseCustomFields,
  resolveGroupIds,
  resolveTagIds,
} from "./contact/contact.helpers.js";
import { importContacts } from "./contact/contact.imports.js";

// See: ./contact/contact.helpers.js (pagination, regex, tag/group resolution)
// See: ./contact/contact.imports.js (bulk CSV/API import logic)

const contactService = {
  /**
   * List contacts with pagination, filtering and search.
   *
   * Filters: { known, unknown, blocked, optedOut, groupId, tagId, isBusiness, search, phoneNumber }
   * Pagination: { page, limit }
   */
  async listContacts(ownerId, filters = {}, pagination = {}) {
    const page = Math.max(1, parseInt(pagination.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(pagination.limit, 10) || DEFAULT_LIMIT),
    );
    const skip = (page - 1) * limit;

    const query = { owner: ownerId };

    if (filters.known === "true" || filters.known === true) {
      query.isSavedContact = true;
      query.isUnknown = { $ne: true };
    }
    if (filters.unknown === "true" || filters.unknown === true) {
      query.isUnknown = true;
    }
    if (filters.blocked === "true" || filters.blocked === true) {
      query.isBlocked = true;
    }
    if (filters.optedOut === "true" || filters.optedOut === true) {
      query.isOptedOut = true;
    }
    // Genuine = real WhatsApp contact synced from the connected account
    // (has a WhatsApp JID). Manual/imported entries without a JID are excluded.
    if (filters.genuine === "true" || filters.genuine === true) {
      query.whatsappJid = { $ne: null };
    }
    if (filters.groupId) query.customGroups = filters.groupId;
    if (filters.tagId) query.tags = filters.tagId;

    // OR-clauses that combine across multiple fields (search, business tab).
    // The old $text search only indexed phoneNumber, so name/pushName never
    // matched — replaced with regex OR matching.
    const orClauses = [];

    if (filters.isBusiness === "true" || filters.isBusiness === true) {
      // Business tab = WhatsApp business accounts OR any contact assigned to
      // a group named "business" (case-insensitive), so manually created
      // contacts with the Business group show up here too.
      const bizGroup = await ContactGroup.findOne({
        owner: ownerId,
        name: /^business$/i,
      })
        .select("_id")
        .lean()
        .exec();
      if (bizGroup) {
        orClauses.push({ isBusiness: true }, { customGroups: bizGroup._id });
      } else {
        orClauses.push({ isBusiness: true });
      }
    }

    if (filters.search) {
      const q = String(filters.search).trim();
      const re = new RegExp(escapeRegex(q), "i");
      orClauses.push({ name: re }, { pushName: re }, { phoneNumber: re });
      // Also match partial phone digits (e.g. "919876" or "9876543210")
      const digits = q.replace(/\D/g, "");
      if (digits.length >= 3) {
        orClauses.push({ phoneNumber: new RegExp(escapeRegex(digits)) });
      }
    } else if (filters.phoneNumber) {
      const normalised = normalizePhoneNumber(filters.phoneNumber);
      if (normalised) query.phoneNumber = normalised;
    }

    if (orClauses.length) query.$or = orClauses;

    const [total, contacts] = await Promise.all([
      Contact.countDocuments(query).exec(),
      Contact.find(query)
        .populate("tags", "name color")
        .populate("customGroups", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      contacts,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  },

  /** Contact details by id (owner-scoped). */
  async getContact(ownerId, id) {
    const contact = await Contact.findOne({ _id: id, owner: ownerId })
      .populate("tags", "name color")
      .populate("customGroups", "name")
      .exec();
    if (!contact) {
      const e = new Error("Contact not found");
      e.statusCode = 404;
      throw e;
    }
    return contact;
  },

  /**
   * Create a contact. Phone numbers are normalised and deduplicated
   * per owner + phone number.
   */
  async createContact(ownerId, data) {
    const phoneNumber = normalizePhoneNumber(data.phoneNumber);
    if (!phoneNumber) {
      const e = new Error("Invalid phone number");
      e.statusCode = 400;
      throw e;
    }

    // Deduplicate: reject if a contact with this phone already exists
    const existing = await Contact.findOne({ owner: ownerId, phoneNumber }).exec();
    if (existing) {
      const e = new Error("Contact already exists");
      e.statusCode = 409;
      e.existingContact = existing;
      throw e;
    }

    const contactTagIds = await resolveTagIds(
      ownerId,
      data.tags || data.tagIds,
    );
    const contactGroupIds = await resolveGroupIds(
      ownerId,
      data.customGroups || data.groupIds,
    );

    const contact = await Contact.create({
      owner: ownerId,
      phoneNumber,
      name: data.name || null,
      pushName: data.pushName || null,
      profilePicture: data.profilePicture || null,
      isSavedContact: data.isSavedContact ?? true,
      isUnknown: data.isUnknown ?? false,
      isBusiness: data.isBusiness ?? false,
      tags: contactTagIds,
      customGroups: contactGroupIds,
      customFields: Array.isArray(data.customFields) ? data.customFields : [],
      // Omit language when falsy — the phoneNumber text index treats `language`
      // as its language-override field and rejects explicit null values.
      ...(data.language ? { language: data.language } : {}),
      city: data.city || null,
      state: data.state || null,
      isBlocked: data.isBlocked ?? false,
      isOptedOut: data.isOptedOut ?? false,
      lastMessageAt: data.lastMessageAt || null,
      lastSeenAt: data.lastSeenAt || null,
    });

    await activityService.logActivity(ownerId, contact._id, "imported", {
      source: "manual",
    });

    // Keep group reverse references in sync
    if (contactGroupIds.length) {
      await ContactGroup.updateMany(
        { _id: { $in: contactGroupIds }, owner: ownerId },
        { $addToSet: { contacts: contact._id } },
      ).exec();
    }

    return contact;
  },

  /**
   * Update a contact. Mass-assignment protection: only allowlisted
   * fields are mutated. Phone number changes are normalised and
   * re-deduplicated.
   */
  async updateContact(ownerId, id, data) {
    const contact = await Contact.findOne({ _id: id, owner: ownerId }).exec();
    if (!contact) {
      const e = new Error("Contact not found");
      e.statusCode = 404;
      throw e;
    }

    const allowedFields = [
      "name", "pushName", "profilePicture", "isSavedContact", "isUnknown",
      "isBusiness", "language", "city", "state", "customFields",
      "lastMessageAt", "lastSeenAt", "isBlocked", "isOptedOut",
    ];

    let changed = false;
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        // Never persist `language: null` — the phoneNumber text index treats
        // `language` as its language-override field and rejects explicit null.
        if (field === "language" && !data[field]) {
          contact[field] = undefined;
        } else {
          contact[field] = data[field];
        }
        changed = true;
      }
    }

    // Handle phone number change with re-deduplication
    if (Object.prototype.hasOwnProperty.call(data, "phoneNumber")) {
      const newPhone = normalizePhoneNumber(data.phoneNumber);
      if (!newPhone) {
        const e = new Error("Invalid phone number");
        e.statusCode = 400;
        throw e;
      }
      if (newPhone !== contact.phoneNumber) {
        const dup = await Contact.findOne({
          owner: ownerId,
          phoneNumber: newPhone,
          _id: { $ne: contact._id },
        }).exec();
        if (dup) {
          const e = new Error("A contact with this phone number already exists");
          e.statusCode = 409;
          throw e;
        }
        contact.phoneNumber = newPhone;
        changed = true;
      }
    }

    // Tag updates (replace the set of tags)
    if (Object.prototype.hasOwnProperty.call(data, "tags")) {
      contact.tags = await resolveTagIds(ownerId, data.tags);
      changed = true;
    }

    // Group membership updates (replace the set of groups)
    if (Object.prototype.hasOwnProperty.call(data, "customGroups")) {
      const newGroupIds = await resolveGroupIds(ownerId, data.customGroups);

      // Update reverse references on old vs new groups
      const oldGroupIds = (contact.customGroups || []).map((g) => g.toString());
      const newGroupIdsStr = newGroupIds.map((g) => g.toString());

      const removed = oldGroupIds.filter((g) => !newGroupIdsStr.includes(g));
      const added = newGroupIdsStr.filter((g) => !oldGroupIds.includes(g));

      if (removed.length) {
        await ContactGroup.updateMany(
          { _id: { $in: removed }, owner: ownerId },
          { $pull: { contacts: contact._id } },
        ).exec();
      }
      if (added.length) {
        await ContactGroup.updateMany(
          { _id: { $in: added }, owner: ownerId },
          { $addToSet: { contacts: contact._id } },
        ).exec();
      }

      contact.customGroups = newGroupIds;
      changed = true;
    }

    if (changed) await contact.save();

    await activityService.logActivity(ownerId, contact._id, "updated", {});

    return contact;
  },

  /** Delete a contact (and clean up all references). */
  async deleteContact(ownerId, id) {
    const contact = await Contact.findOneAndDelete({ _id: id, owner: ownerId }).exec();
    if (!contact) {
      const e = new Error("Contact not found");
      e.statusCode = 404;
      throw e;
    }

    // Clean up references in groups
    await ContactGroup.updateMany(
      { owner: ownerId, contacts: id },
      { $pull: { contacts: id } },
    ).exec();

    // Remove from campaign audience selections and excluded lists
    const Campaign = (await import("../../models/messaging/campaign.model.js")).default;
    await Promise.all([
      Campaign.updateMany(
        { owner: ownerId, "audience.contacts": id },
        { $pull: { "audience.contacts": id } },
      ).exec(),
      Campaign.updateMany(
        { owner: ownerId, "audience.excludedContacts": id },
        { $pull: { "audience.excludedContacts": id } },
      ).exec(),
    ]);

    return contact;
  },

  /** Block a contact (add to blocklist). */
  async blockContact(ownerId, id) {
    const contact = await Contact.findOneAndUpdate(
      { _id: id, owner: ownerId },
      { $set: { isBlocked: true }, $currentDate: { updatedAt: true } },
      { new: true },
    ).exec();
    if (!contact) {
      const e = new Error("Contact not found");
      e.statusCode = 404;
      throw e;
    }
    await activityService.logActivity(ownerId, contact._id, "blocked", {});
    return contact;
  },

  /** Opt a contact out (do-not-disturb / unsubscribe). */
  async optOutContact(ownerId, id) {
    const contact = await Contact.findOneAndUpdate(
      { _id: id, owner: ownerId },
      { $set: { isOptedOut: true }, $currentDate: { updatedAt: true } },
      { new: true },
    ).exec();
    if (!contact) {
      const e = new Error("Contact not found");
      e.statusCode = 404;
      throw e;
    }
    await activityService.logActivity(ownerId, contact._id, "opted_out", {});
    return contact;
  },

  /** Search contacts across phone/name fields (owner-scoped). */
  async searchContacts(ownerId, query, pagination = {}) {
    if (!query || String(query).trim().length < 2) {
      return {
        contacts: [],
        pagination: {
          total: 0,
          page: 1,
          limit: MAX_LIMIT,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      };
    }
    return this.listContacts(ownerId, { search: query }, pagination);
  },

  /**
   * Import contacts from parsed CSV rows.
   *
   * Options:
   *   - updateExisting: when true, existing contacts are merged (existing
   *     values are never blanked out). When false, duplicates are counted
   *     and never overwritten.
   *   - assignGroups: [groupName] — auto-create + assign groups
   *   - assignTags: [tagName] — auto-create + assign tags
   *
   * Returns { total, created, updated, duplicates, invalid }
   */
  async importContacts(ownerId, rows, options = {}) {
    // Full implementation lives in ./contact/contact.imports.js
    return importContacts(ownerId, rows, options);
  },

  /**
   * Export contacts to CSV rows.
   * Filters follow the same shape as listContacts.
   */
  async exportContacts(ownerId, filters = {}) {
    const { contacts } = await this.listContacts(ownerId, filters, {
      limit: MAX_LIMIT,
    });
    const to = (v) => (v === null || v === undefined ? "" : String(v));

    const headers = [
      "phoneNumber", "name", "pushName", "isSavedContact",
      "isUnknown", "isBusiness", "tags", "customGroups", "customFields",
      "language", "city", "state", "isBlocked", "isOptedOut",
      "lastMessageAt", "lastSeenAt", "createdAt", "updatedAt",
    ];

    const rows = contacts.map((c) => [
      to(c.phoneNumber),
      to(c.name),
      to(c.pushName),
      to(c.isSavedContact),
      to(c.isUnknown),
      to(c.isBusiness),
      to(Array.isArray(c.tags) ? c.tags.map((t) => t.name || t.toString()).join(";") : ""),
      to(Array.isArray(c.customGroups)
        ? c.customGroups.map((g) => g.name || g.toString()).join(";") : ""),
      to(c.customFields && c.customFields.length
        ? c.customFields.map((f) => `${f.key}:${f.value}`).join(";") : ""),
      to(c.language),
      to(c.city),
      to(c.state),
      to(c.isBlocked),
      to(c.isOptedOut),
      to(c.lastMessageAt),
      to(c.lastSeenAt),
      to(c.createdAt),
      to(c.updatedAt),
    ]);

    return { headers, rows, count: contacts.length };
  },

  /**
   * Export specific contacts by id (owner-scoped).
   */
  async exportSelectedContacts(ownerId, contactIds) {
    const contacts = await Contact.find({ owner: ownerId, _id: { $in: contactIds } })
      .populate("tags", "name")
      .populate("customGroups", "name")
      .exec();
    const to = (v) => (v === null || v === undefined ? "" : String(v));

    const headers = [
      "phoneNumber", "name", "pushName", "tags", "customGroups",
      "createdAt", "updatedAt",
    ];
    const rows = contacts.map((c) => [
      to(c.phoneNumber),
      to(c.name),
      to(c.pushName),
      to(Array.isArray(c.tags) ? c.tags.map((t) => t.name).join(";") : ""),
      to(Array.isArray(c.customGroups) ? c.customGroups.map((g) => g.name).join(";") : ""),
      to(c.createdAt),
      to(c.updatedAt),
    ]);
    return { headers, rows, count: contacts.length };
  },
};

export default contactService;
