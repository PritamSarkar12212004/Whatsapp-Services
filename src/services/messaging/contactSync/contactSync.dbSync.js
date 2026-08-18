/**
 * MongoDB upsert layer for WhatsApp contact synchronization.
 *
 * Pure DB module — no sync-state dependencies. Owns the identity rules that
 * decide insert vs update so the orchestrator stays readable.
 *
 * @see contactSync.service.js (orchestrator that calls this)
 */

import Contact from "../../../models/messaging/contact.model.js";

const BATCH_SIZE = 50;

/**
 * Sync WhatsApp contacts into the CRM Contact collection.
 *
 * - Upserts using ownerId + whatsappJid as the unique identity
 * - Preserves existing CRM data: tags, customGroups, customFields, notes,
 *   optOut/isOptedOut, campaign data and manually entered names are never
 *   overwritten. `name` is only filled when it is currently blank.
 * - If a manually created CRM contact already exists with the same phone
 *   number (but no whatsappJid), the sync merges into it instead of creating
 *   a duplicate.
 * - Never deletes contacts that were not returned by a sync.
 *
 * @param {Object} params
 * @param {String} params.ownerId
 * @param {Array}  params.contacts - normalized records from normalizeContactList
 * @param {Boolean} [params.overwrite=false] - reserved; names are never
 *   overwritten to protect manual CRM data
 * @returns {Promise<Object>} summary
 */
export const syncWhatsAppContacts = async ({
  ownerId,
  contacts,
  overwrite = false,
}) => {
  const summary = {
    total: Array.isArray(contacts) ? contacts.length : 0,
    inserted: 0,
    updated: 0,
    skippedGroups: 0,
    skippedInvalid: 0,
    skippedSelf: 0,
  };

  if (!Array.isArray(contacts) || !contacts.length) {
    return summary;
  }

  let batchIndex = 0;

  while (batchIndex < contacts.length) {
    const batch = contacts.slice(batchIndex, batchIndex + BATCH_SIZE);

    const jids = batch.map((c) => c.jid);
    const phones = batch.map((c) => c.phoneNumber).filter(Boolean);

    // Pre-fetch existing documents (by JID first, then by phone) so we can
    // decide insert vs update and preserve manual CRM data.
    const [byJid, byPhone] = await Promise.all([
      Contact.find({ owner: ownerId, whatsappJid: { $in: jids } })
        .select("_id whatsappJid phoneNumber name")
        .lean()
        .exec(),
      Contact.find({ owner: ownerId, phoneNumber: { $in: phones } })
        .select("_id whatsappJid phoneNumber name")
        .lean()
        .exec(),
    ]);

    const jidMap = new Map(byJid.map((d) => [d.whatsappJid, d]));
    const phoneMap = new Map(byPhone.map((d) => [d.phoneNumber, d]));

    const ops = [];
    for (const contact of batch) {
      const jidDoc = jidMap.get(contact.jid);
      const phoneDoc = phoneMap.get(contact.phoneNumber);

      const now = new Date();
      const $set = {
        whatsappJid: contact.jid,
        phoneNumber: contact.phoneNumber,
        isBusiness: !!contact.isBusiness,
        isUnknown: !!contact.isUnknown,
        isSavedContact: !!contact.isSavedContact,
        lastSyncedAt: now,
      };
      if (contact.pushName) $set.pushName = contact.pushName;

      if (jidDoc) {
        // Existing WhatsApp-linked contact → update, never touch CRM data.
        if (!jidDoc.name && contact.name) $set.name = contact.name;
        ops.push({
          updateOne: {
            filter: { _id: jidDoc._id },
            update: { $set },
          },
        });
      } else if (
        phoneDoc &&
        (!phoneDoc.whatsappJid || phoneDoc.whatsappJid === contact.jid)
      ) {
        // Manually created CRM contact with the same phone → merge in the
        // WhatsApp identity, preserving all manually entered fields.
        if (!phoneDoc.name && contact.name) $set.name = contact.name;
        ops.push({
          updateOne: {
            filter: { _id: phoneDoc._id },
            update: { $set },
          },
        });
      } else {
        // New contact → upsert with full WhatsApp metadata on insert.
        const insertSet = { ...$set };
        if (contact.name) insertSet.name = contact.name;
        ops.push({
          updateOne: {
            filter: { owner: ownerId, whatsappJid: contact.jid },
            update: {
              $set: insertSet,
              $setOnInsert: { createdAt: now },
            },
            upsert: true,
            // Mongoose 9 otherwise injects every schema default (including
            // `language: null`) into $setOnInsert — MongoDB's text index on
            // phoneNumber rejects a non-string `language` override field.
            setDefaultsOnInsert: false,
          },
        });
      }
    }

    if (ops.length > 0) {
      const result = await Contact.bulkWrite(ops, { ordered: false });
      summary.inserted += result.upsertedCount || 0;
      summary.updated += result.modifiedCount || 0;
    }

    batchIndex += BATCH_SIZE;
  }

  return summary;
};
