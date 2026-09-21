/**
 * MongoDB upsert layer for WhatsApp contact synchronization.
 *
 * Pure DB module — no sync-state dependencies. Owns the identity rules that
 * decide insert vs update so the orchestrator stays readable.
 *
 * WHY IT LOOKS LIKE THIS
 * ----------------------
 * A first full sync of ~1800 contacts used to run 36 batches, and EVERY batch
 * did two pre-fetch queries plus a bulkWrite (~110 round trips). On Atlas that
 * takes minutes, which is exactly when the WhatsApp socket starts logging
 * "timed out waiting for message" and the sync looks stuck after a network
 * blip. So now:
 *
 *   • one pre-fetch for the whole list (chunked `$in` queries),
 *   • one pass that plans every operation (pure function, easy to test),
 *   • bulk writes in large chunks, and
 *   • contacts that are already up to date are not written at all — a sync
 *     that finds nothing new touches the database zero times.
 *
 * @see contactSync.service.js (orchestrator that calls this)
 */

import Contact from "../../../models/messaging/contact.model.js";

const FETCH_CHUNK = 500; // ids per pre-fetch query
const WRITE_CHUNK = 500; // operations per bulkWrite

/** Fields compared before writing, so an unchanged contact is a no-op. */
const COMPARED_FIELDS = [
    "whatsappJid",
    "phoneNumber",
    "isBusiness",
    "isUnknown",
    "isSavedContact",
    "pushName",
];

const sameValue = (a, b) => {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) {
        return (a ?? null) === (b ?? null);
    }
    return String(a) === String(b);
};

const chunk = (items, size) => {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
};

/**
 * Only the fields that actually differ — `{}` means "nothing to write".
 *
 * @param {Object} existing lean contact document
 * @param {Object} wanted   fields this sync wants to store
 */
export const diffContact = (existing = {}, wanted = {}) => {
    const patch = {};

    for (const field of COMPARED_FIELDS) {
        if (wanted[field] === undefined) continue;
        if (!sameValue(existing[field], wanted[field])) patch[field] = wanted[field];
    }

    return patch;
};

/**
 * Plan the bulkWrite operations for one sync. Pure — no IO — so the identity
 * rules can be tested on their own.
 *
 * Identity rules (unchanged from the previous implementation):
 *   - a contact already linked by JID is updated, manual CRM fields survive,
 *   - a manually created contact with the same phone gets the WhatsApp identity
 *     merged into it instead of a duplicate,
 *   - anything else is an upsert,
 *   - a contact with no differences is skipped entirely.
 *
 * @param {Object} params
 * @param {String} params.ownerId
 * @param {Array}  params.contacts normalized records
 * @param {Map}    params.byJid    existing docs keyed by whatsappJid
 * @param {Map}    params.byPhone  existing docs keyed by phoneNumber
 * @param {Date}   [params.now]
 * @returns {{ops: Array, plannedCreates: Number, changed: Number, unchanged: Number, skippedInvalid: Number}}
 */
export const buildContactSyncOps = ({
    ownerId,
    contacts = [],
    byJid = new Map(),
    byPhone = new Map(),
    now = new Date(),
}) => {
    const ops = [];
    let plannedCreates = 0;
    let changed = 0;
    let unchanged = 0;
    let skippedInvalid = 0;

    for (const contact of contacts) {
        if (!contact?.jid || !contact?.phoneNumber) {
            skippedInvalid++;
            continue;
        }

        const jidDoc = byJid.get(contact.jid);
        const phoneDoc = byPhone.get(contact.phoneNumber);

        const wanted = {
            whatsappJid: contact.jid,
            phoneNumber: contact.phoneNumber,
            isBusiness: !!contact.isBusiness,
            isUnknown: !!contact.isUnknown,
            isSavedContact: !!contact.isSavedContact,
        };
        if (contact.pushName) wanted.pushName = contact.pushName;

        const existing = jidDoc
            ? jidDoc
            : phoneDoc && (!phoneDoc.whatsappJid || phoneDoc.whatsappJid === contact.jid)
              ? phoneDoc
              : null;

        if (existing) {
            // Existing contact → write only what changed. A name the user typed
            // in the CRM is never replaced by WhatsApp's version.
            const patch = diffContact(existing, wanted);
            if (!existing.name && contact.name) patch.name = contact.name;

            if (!Object.keys(patch).length) {
                unchanged++;
                continue;
            }

            patch.lastSyncedAt = now;
            ops.push({
                updateOne: {
                    filter: { _id: existing._id },
                    update: { $set: patch },
                },
            });
            changed++;
            continue;
        }

        // New contact → upsert with the full WhatsApp metadata.
        const insertSet = { ...wanted, lastSyncedAt: now };
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
        plannedCreates++;
    }

    return { ops, plannedCreates, changed, unchanged, skippedInvalid };
};

/** Every existing contact matching these jids/phones, in as few queries as possible. */
const preloadExisting = async (ownerId, jids, phones) => {
    const byJid = new Map();
    const byPhone = new Map();

    const collect = (docs) => {
        for (const doc of docs) {
            if (doc.whatsappJid) byJid.set(doc.whatsappJid, doc);
            if (doc.phoneNumber) byPhone.set(doc.phoneNumber, doc);
        }
    };

    const select = `_id whatsappJid phoneNumber name ${COMPARED_FIELDS.join(" ")}`;

    for (const part of chunk(jids, FETCH_CHUNK)) {
        const docs = await Contact.find({
            owner: ownerId,
            whatsappJid: { $in: part },
        })
            .select(select)
            .lean()
            .exec();
        collect(docs);
    }

    for (const part of chunk(phones, FETCH_CHUNK)) {
        const docs = await Contact.find({
            owner: ownerId,
            phoneNumber: { $in: part },
        })
            .select(select)
            .lean()
            .exec();
        collect(docs);
    }

    return { byJid, byPhone };
};

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
 * - Unchanged contacts are not written, so a repeat sync is cheap.
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
        unchanged: 0,
        skippedGroups: 0,
        skippedInvalid: 0,
        skippedSelf: 0,
    };

    if (!Array.isArray(contacts) || !contacts.length) {
        return summary;
    }

    void overwrite; // names stay protected — see the identity rules above

    const jids = [...new Set(contacts.map((c) => c.jid).filter(Boolean))];
    const phones = [...new Set(contacts.map((c) => c.phoneNumber).filter(Boolean))];

    const { byJid, byPhone } = await preloadExisting(ownerId, jids, phones);

    const { ops, plannedCreates, changed, unchanged, skippedInvalid } =
        buildContactSyncOps({ ownerId, contacts, byJid, byPhone });

    summary.unchanged = unchanged;
    summary.skippedInvalid = skippedInvalid;
    summary.plannedCreates = plannedCreates;
    summary.changed = changed;

    for (const part of chunk(ops, WRITE_CHUNK)) {
        const result = await Contact.bulkWrite(part, { ordered: false });
        summary.inserted += result.upsertedCount || 0;
        summary.updated += result.modifiedCount || 0;
    }

    return summary;
};

export default { syncWhatsAppContacts, buildContactSyncOps, diffContact };
