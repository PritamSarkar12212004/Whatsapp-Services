/**
 * Bulk contact import (CSV rows / API payloads).
 *
 * Extracted from contact.service.js to keep the service readable.
 *
 * @see contact.service.js (calls importContacts)
 */

import Contact from "../../../models/messaging/contact.model.js";
import ContactGroup from "../../../models/messaging/contactGroup.model.js";
import activityService from "../activity.service.js";
import { normalizePhoneNumber } from "../../../utils/messaging/phone.util.js";
import { resolveGroupIds, resolveTagIds, parseCustomFields } from "./contact.helpers.js";

/**
 * Import contacts from raw rows (CSV rows or API payloads).
 *
 * - Validates phone numbers (normalized, invalid rows reported back)
 * - Existing contacts are merged when updateExisting=true (only blank fields
 *   are filled; row-specific + default tags/groups are unioned)
 * - New contacts are created with reverse group references
 *
 * @param {String} ownerId
 * @param {Array} rows - [{ phoneNumber, name, pushName, city, state, language, tags, groups, customFields }]
 * @param {Object} [options] - { assignGroups, assignTags, updateExisting }
 * @returns {Promise<Object>} summary with created/updated/duplicates/invalid
 */
export const importContacts = async (ownerId, rows, options = {}) => {
  const summary = {
    total: rows.length,
    created: 0,
    updated: 0,
    duplicates: 0,
    invalid: 0,
  };
  const invalidRows = [];

  const defaultGroupIds = await resolveGroupIds(
    ownerId,
    options.assignGroups,
  );
  const defaultTagIds = await resolveTagIds(ownerId, options.assignTags);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawPhone =
      row.phoneNumber || row.phone || row.PhoneNumber || row.Phone || "";
    const phoneNumber = normalizePhoneNumber(rawPhone);

    if (!phoneNumber) {
      summary.invalid++;
      invalidRows.push({
        row: i + 2,
        raw: row,
        reason: "Invalid or missing phone number",
      });
      continue;
    }

    const existing = await Contact.findOne({
      owner: ownerId,
      phoneNumber,
    }).exec();

    if (existing) {
      if (options.updateExisting) {
        // Merge: only fill blank fields, never blank out existing values
        const updates = {};
        if (!existing.name && row.name) updates.name = row.name;
        if (!existing.pushName && row.pushName) updates.pushName = row.pushName;
        if (!existing.city && row.city) updates.city = row.city;
        if (!existing.state && row.state) updates.state = row.state;
        if (!existing.language && row.language) updates.language = row.language;

        let merged = false;
        if (Object.keys(updates).length > 0) {
          Object.assign(existing, updates);
          merged = true;
        }

        // Row-specific tags
        if (row.tags) {
          const rowTags = String(row.tags)
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
          const rowTagIds = await resolveTagIds(ownerId, rowTags);
          existing.tags = Array.from(
            new Set([
              ...(existing.tags || []).map(String),
              ...rowTagIds.map(String),
            ]),
          ).map((v) => v);
          merged = true;
        }

        // Row-specific groups
        if (row.groups) {
          const rowGroups = String(row.groups)
            .split(",")
            .map((g) => g.trim())
            .filter(Boolean);
          const rowGroupIds = await resolveGroupIds(ownerId, rowGroups);
          const oldGroupIds = (existing.customGroups || []).map((g) =>
            g.toString(),
          );
          const added = rowGroupIds
            .map((g) => g.toString())
            .filter((g) => !oldGroupIds.includes(g));
          if (added.length) {
            await ContactGroup.updateMany(
              { _id: { $in: added }, owner: ownerId },
              { $addToSet: { contacts: existing._id } },
            ).exec();
          }
          existing.customGroups = Array.from(
            new Set([...oldGroupIds, ...rowGroupIds.map(String)]),
          ).map((v) => v);
          merged = true;
        }

        // Apply default assignGroups / assignTags
        if (defaultGroupIds.length) {
          const oldGroupIds = (existing.customGroups || []).map((g) =>
            g.toString(),
          );
          const added = defaultGroupIds
            .map((g) => g.toString())
            .filter((g) => !oldGroupIds.includes(g));
          if (added.length) {
            await ContactGroup.updateMany(
              { _id: { $in: added }, owner: ownerId },
              { $addToSet: { contacts: existing._id } },
            ).exec();
          }
          existing.customGroups = Array.from(
            new Set([...oldGroupIds, ...defaultGroupIds.map(String)]),
          ).map((v) => v);
          merged = true;
        }
        if (defaultTagIds.length) {
          existing.tags = Array.from(
            new Set([
              ...(existing.tags || []).map(String),
              ...defaultTagIds.map(String),
            ]),
          ).map((v) => v);
          merged = true;
        }

        if (merged) {
          await existing.save();
          summary.updated++;
          await activityService.logActivity(ownerId, existing._id, "updated", {
            source: "import",
          });
        } else {
          summary.duplicates++;
        }
      } else {
        summary.duplicates++;
      }
      continue;
    }

    // Create new contact
    const contactData = {
      owner: ownerId,
      phoneNumber,
      name: row.name || null,
      pushName: row.pushName || null,
      isSavedContact: true,
      isUnknown: false,
      // Omit language when falsy — see createContact note.
      ...(row.language ? { language: row.language } : {}),
      city: row.city || null,
      state: row.state || null,
      customFields: row.customFields ? parseCustomFields(row.customFields) : [],
    };

    let contact;
    try {
      contact = await Contact.create(contactData);
    } catch (err) {
      // Race condition / unique violation → treat as duplicate
      summary.duplicates++;
      continue;
    }

    // Row-specific tags via CSV "tags" column
    if (row.tags) {
      const rowTags = String(row.tags)
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      contact.tags = await resolveTagIds(ownerId, rowTags);
    }
    // Row-specific groups via CSV "groups" column
    if (row.groups) {
      const rowGroups = String(row.groups)
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
      contact.customGroups = await resolveGroupIds(ownerId, rowGroups);
    }
    // Apply default assignGroups / assignTags
    if (defaultGroupIds.length) {
      contact.customGroups = Array.from(
        new Set([
          ...(contact.customGroups || []).map(String),
          ...defaultGroupIds.map(String),
        ]),
      ).map((v) => v);
    }
    if (defaultTagIds.length) {
      contact.tags = Array.from(
        new Set([
          ...(contact.tags || []).map(String),
          ...defaultTagIds.map(String),
        ]),
      ).map((v) => v);
    }

    await contact.save();

    // Sync reverse references on groups
    if (contact.customGroups && contact.customGroups.length) {
      await ContactGroup.updateMany(
        { _id: { $in: contact.customGroups }, owner: ownerId },
        { $addToSet: { contacts: contact._id } },
      ).exec();
    }

    summary.created++;
    await activityService.logActivity(ownerId, contact._id, "imported", {
      source: "csv",
    });
  }

  summary.invalidRows = invalidRows;
  return summary;
};
