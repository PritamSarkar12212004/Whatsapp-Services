/**
 * WhatsApp -> CRM contact synchronization (orchestrator).
 *
 * Kept deliberately thin: discovery + normalization + orchestration live
 * here; the pieces below were extracted for readability:
 *
 *   - JID utils / retry policy / constants  -> See: ./contactSync/contactSync.helpers.js
 *   - MongoDB upsert (identity rules)      -> See: ./contactSync/contactSync.dbSync.js
 *
 * TODO(contacts): move the discovery tiers (USync / app-state / session
 *   registry) into ./contactSync/discovery.js once the in-memory caches are
 *   moved into that module.
 */

import { readdir } from "fs/promises";
import {
  USyncQuery,
  USyncUser,
  isJidGroup,
  isJidBroadcast,
  isJidStatusBroadcast,
  isJidNewsletter,
  isLidUser,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import Contact from "../../models/messaging/contact.model.js";
import { normalizePhoneNumber } from "../../utils/messaging/phone.util.js";
import {
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  RETRY_DELAYS_MS,
  APP_STATE_GRACE_MS,
  USYNC_TIMEOUT_MS,
  isPnJid,
  isLidJid,
  delay,
} from "./contactSync/contactSync.helpers.js";
import { syncWhatsAppContacts } from "./contactSync/contactSync.dbSync.js";
import { listAuthKeyIds } from "../../integrations/whatsapp/authState.js";

// ---------------------------------------------------------------------------
// Per-user in-memory caches fed by Baileys events.
//
// The installed Baileys version (7.0.0-rc14) does NOT keep a public contact
// store on the socket (sock.user.contacts does not exist). Contact metadata
// flows through events:
//   - 'contacts.upsert' / 'contacts.update'  → saved contact metadata
//     (name, username, lid, phoneNumber) delivered during app-state sync and
//     when pushNames arrive with incoming messages
//   - 'lid-mapping.update'                    → LID -> PN mappings
// We accumulate these per user so the sync can enrich results with saved
// names and resolve LID-only identifiers to real phone numbers.
//
// TODO(contacts): move these maps into ./contactSync/discovery.js together
//   with the tier functions that consume them.
// ---------------------------------------------------------------------------
const contactCache = new Map(); // userId -> Map<jid, contact>
const lidToPn = new Map(); // userId -> Map<lidJid, pnJid>
const activeSyncs = new Map(); // userId -> Promise (coalesce concurrent syncs)
const lastSyncAt = new Map(); // userId -> timestamp of last completed sync
const appStateRecoveredSockets = new WeakSet(); // per-socket snapshot guard

// ---------------------------------------------------------------------------
// Event listeners (registered once per socket)
// ---------------------------------------------------------------------------

/**
 * Wire Baileys events into the in-memory contact/LID caches.
 * Registered once per socket (guarded by a property flag).
 *
 * @see contactSync/contactSync.helpers.js for isPnJid/isLidJid
 */
const ensureEventListeners = (userId, sock) => {
  if (!sock || sock.__messagingContactSyncListeners) return;
  sock.__messagingContactSyncListeners = true;

  const getCache = (map, key) => {
    if (!map.has(key)) map.set(key, new Map());
    return map.get(key);
  };

  sock.ev.on("contacts.upsert", (contacts) => {
    const cache = getCache(contactCache, userId);
    for (const contact of contacts || []) {
      if (contact?.id) {
        cache.set(contact.id, {
          ...(cache.get(contact.id) || {}),
          ...contact,
        });
      }
      // Some versions deliver a PN jid under `phoneNumber` — index it too.
      if (contact?.phoneNumber && contact.phoneNumber !== contact.id) {
        cache.set(contact.phoneNumber, {
          ...(cache.get(contact.phoneNumber) || {}),
          ...contact,
          id: contact.phoneNumber,
        });
      }
    }
  });

  sock.ev.on("contacts.update", (updates) => {
    const cache = getCache(contactCache, userId);
    for (const update of updates || []) {
      if (update?.id) {
        cache.set(update.id, { ...(cache.get(update.id) || {}), ...update });
      }
    }
  });

  sock.ev.on("lid-mapping.update", ({ lid, pn }) => {
    if (lid && pn) getCache(lidToPn, userId).set(lid, pn);
  });
};

// ---------------------------------------------------------------------------
// App-state recovery
// ---------------------------------------------------------------------------

/**
 * On reconnections Baileys only fetches incremental app-state patches, so
 * saved-contact (contactAction) mutations that were consumed at initial login
 * never re-emit. When our cache is empty, force a full app-state snapshot by
 * clearing the stored sync versions — the snapshot contains every
 * contactAction, which re-emits 'contacts.upsert' into the cache.
 * (Only once per socket; the versions are re-stored automatically afterwards.)
 */
const recoverAppStateContacts = async (userId, sock) => {
  if (!sock || appStateRecoveredSockets.has(sock)) return;
  appStateRecoveredSockets.add(sock);
  if (contactCache.get(userId)?.size > 0) return;
  if (typeof sock.resyncAppState !== "function" || !sock.authState?.keys) {
    console.log(
      "[Contacts Sync] app-state recovery skipped (resyncAppState not exposed by this socket)",
    );
    return;
  }

  console.log(
    "[Contacts Sync] Requesting full app-state snapshot to recover saved contacts",
  );
  try {
    await sock.authState.keys.set({
      "app-state-sync-version": {
        regular: undefined,
        regular_high: undefined,
        regular_low: undefined,
      },
    });
    await sock.resyncAppState(["regular", "regular_high", "regular_low"], true);
    // createBufferedFunction flushes emitted events ~100ms after completion.
    await delay(800);
  } catch (err) {
    console.error(
      `[Contacts Sync] App-state snapshot recovery failed: ${err.message}`,
    );
  }
};

// ---------------------------------------------------------------------------
// Contact discovery (tiered sources)
//
// TODO(contacts): extract into ./contactSync/discovery.js
// ---------------------------------------------------------------------------

/** Tier 1 — USync directory query used by WhatsApp Web's contact picker. */
const fetchDirectoryContacts = async (userId, sock) => {
  if (!sock || typeof sock.executeUSyncQuery !== "function") return null;
  try {
    const query = new USyncQuery()
      .withMode("queryContact")
      .withContext("interactive")
      .withContactProtocol()
      .withStatusProtocol()
      .withLIDProtocol()
      .withUser(new USyncUser().withId("@queryContact").withType("query"));

    const pending = sock.executeUSyncQuery(query);
    pending.catch(() => {}); // swallow late rejections after our race wins
    const result = await Promise.race([
      pending,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("USync queryContact timed out")),
          USYNC_TIMEOUT_MS,
        ),
      ),
    ]);

    const list = result?.list || [];
    const entries = [];
    for (const item of list) {
      if (!item?.id) continue;
      entries.push({
        jid: item.id,
        inAddressBook: item.contact === true,
        lid: item.lid || null,
        status: item.status?.status || null,
      });
      if (item.lid && isLidJid(item.lid) && isPnJid(item.id)) {
        if (!lidToPn.has(userId)) lidToPn.set(userId, new Map());
        lidToPn.get(userId).set(item.lid, item.id);
      }
    }
    return entries.length
      ? { source: "USync queryContact", entries }
      : null;
  } catch (err) {
    console.error(
      `[Contacts Sync] USync queryContact unavailable: ${err.message}`,
    );
    return null;
  }
};

/** Tier 2 — contacts accumulated from app-state / message pushName events. */
const fetchAppStateCacheContacts = (userId) => {
  const cache = contactCache.get(userId);
  if (!cache || cache.size === 0) return null;
  const entries = [];
  for (const contact of cache.values()) {
    if (!contact?.id) continue;
    entries.push({
      jid: contact.id,
      inAddressBook: !!(contact.name || contact.notify),
      lid: contact.lid || null,
      status: null,
    });
  }
  return entries.length
    ? { source: "app-state contact cache", entries }
    : null;
};

/**
 * Tier 3 — persisted session contact registry. Baileys' signal repository
 * writes a `lid-mapping-<pn>.json` file for every real phone number the
 * account has communicated with (device keys, sessions, LID↔PN pairs).
 * These are genuine contacts recorded by the Baileys session itself — not
 * fabricated from arbitrary message JIDs.
 */
/**
 * Tier 3 — persisted session contact registry. The Baileys signal repository
 * records a `lid-mapping` entry for every real phone number the account has
 * communicated with (device keys, sessions, LID↔PN pairs). These are genuine
 * contacts recorded by the session itself — not fabricated from message JIDs.
 *
 * Primary source is MongoDB (see integrations/whatsapp/authState.js), because
 * the deployed filesystem is ephemeral and the on-disk auth folder is wiped on
 * every restart/redeploy. The folder is still read as a legacy fallback for
 * local runs that have not been migrated yet.
 */
const fetchSessionRegistryContacts = async (userId, authFolder) => {
  const entries = [];

  const pushNumber = (digits) => {
    if (!digits || digits.length < 7) return; // guard against odd keys
    entries.push({
      jid: `${digits}@s.whatsapp.net`,
      inAddressBook: false,
      lid: null,
      status: null,
    });
  };

  // Primary: MongoDB-backed auth state.
  try {
    const keyIds = await listAuthKeyIds(userId, "lid-mapping");
    for (const keyId of keyIds) {
      // Only forward PN→LID mappings (numeric); skip `reverse` & LID keys.
      if (/^\d+$/.test(keyId)) pushNumber(keyId);
    }
  } catch (err) {
    console.error(
      `[Contacts Sync] Session contact registry (MongoDB) read failed: ${err.message}`,
    );
  }

  // Legacy fallback: on-disk `lid-mapping-<pn>.json` files.
  if (!entries.length && authFolder) {
    try {
      const files = await readdir(authFolder);
      for (const file of files) {
        const match = file.match(/^lid-mapping-(\d+)\.json$/);
        if (!match) continue;
        pushNumber(match[1]);
      }
    } catch (err) {
      console.error(
        `[Contacts Sync] Session contact registry read failed: ${err.message}`,
      );
    }
  }

  return entries.length
    ? { source: "session contact registry (lid-mapping)", entries }
    : null;
};

/**
 * Fetch the best available contact list for the user, merging tiers:
 *   1. USync queryContact directory (official full contact list)
 *   2. app-state / pushName contact cache (saved names, recent pushNames)
 *   3. persisted session lid-mapping registry (real contacted PNs)
 * Cache-only entries (2) are unioned in so no known contact is lost.
 *
 * @returns {Promise<{source: string, entries: Array}>}
 */
const fetchContactsFromBaileys = async (userId, sock, { authFolder } = {}) => {
  // Tier 1 — USync queryContact directory, unioned with cache extras.
  const directory = await fetchDirectoryContacts(userId, sock);
  if (directory) {
    const seen = new Set(directory.entries.map((e) => e.jid));
    const extras = (fetchAppStateCacheContacts(userId)?.entries || []).filter(
      (e) => !seen.has(e.jid),
    );
    if (extras.length) directory.entries.push(...extras);
    return directory;
  }

  // Tier 2/3 — union the app-state cache with the persisted session registry
  // so a small cache never preempts the larger real-contact registry.
  const appStateEntries = fetchAppStateCacheContacts(userId)?.entries || [];
  const registry = await fetchSessionRegistryContacts(userId, authFolder);
  const registryEntries = registry?.entries || [];
  const merged = [];
  const seen = new Set();
  for (const entry of [...appStateEntries, ...registryEntries]) {
    if (seen.has(entry.jid)) continue;
    seen.add(entry.jid);
    merged.push(entry);
  }
  if (merged.length > 0) {
    const source =
      registryEntries.length > 0
        ? "session contact registry (lid-mapping) + app-state cache"
        : "app-state contact cache";
    return { source, entries: merged };
  }

  return { source: "none", entries: [] };
};

// ---------------------------------------------------------------------------
// Normalization + filtering
// ---------------------------------------------------------------------------

/**
 * Normalize raw directory/cache entries into CRM-ready contact records.
 * Excludes groups, broadcasts/system JIDs, the logged-in user and
 * invalid/non-phone JIDs. Resolves LID identifiers to their PN when possible.
 *
 * @returns {{contacts: Array, skippedGroups: number, skippedInvalid: number, skippedSelf: number}}
 */
const normalizeContactList = (userId, sock, entries) => {
  const contacts = [];
  let skippedGroups = 0;
  let skippedInvalid = 0;
  let skippedSelf = 0;

  const ownJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;

  const cache = contactCache.get(userId);
  const lidMap = lidToPn.get(userId);

  for (const entry of entries) {
    let jid = entry?.jid;
    if (!jid) {
      skippedInvalid++;
      continue;
    }

    // Exclude WhatsApp groups (@g.us)
    if (isJidGroup(jid) || jid.endsWith("@g.us")) {
      skippedGroups++;
      continue;
    }

    // Exclude broadcast / status / newsletter / system JIDs
    if (
      isJidBroadcast(jid) ||
      isJidStatusBroadcast(jid) ||
      isJidNewsletter(jid) ||
      jid.includes("@broadcast") ||
      jid.includes("@status") ||
      jid.includes("@newsletter")
    ) {
      skippedInvalid++;
      continue;
    }

    // Exclude the logged-in user's own JID
    if (ownJid && jidNormalizedUser(jid) === ownJid) {
      skippedSelf++;
      continue;
    }

    // Resolve LID identifiers to their PN (phone) JID when possible
    if (isLidUser(jid) || isLidJid(jid)) {
      const pn = lidMap?.get(jid) || cache?.get(jid)?.phoneNumber || null;
      if (pn && isPnJid(pn)) {
        jid = pn;
      } else {
        // Unresolvable LID — no real phone number, skip rather than fabricate.
        skippedInvalid++;
        continue;
      }
    }

    // Only real WhatsApp PN JIDs are acceptable
    if (!isPnJid(jid)) {
      skippedInvalid++;
      continue;
    }

    const digits = jid.split("@")[0];
    const phoneNumber = normalizePhoneNumber(digits) || (digits || null);
    if (!phoneNumber) {
      skippedInvalid++;
      continue;
    }

    // Enrich with app-state saved-contact metadata (by PN or by LID)
    const meta =
      cache?.get(jid) || (entry.lid ? cache?.get(entry.lid) : null) || {};

    const savedName = meta.name || meta.verifiedName || null;
    const pushName = meta.notify || null;
    const isSavedContact = entry.inAddressBook === true || !!savedName;
    const isUnknown = !isSavedContact;

    contacts.push({
      jid,
      phoneNumber,
      name: savedName,
      pushName,
      isSavedContact,
      isUnknown,
      isBusiness: false, // no reliable business flag exposed for directory results
      lid: entry.lid || meta.lid || null,
    });
  }

  return { contacts, skippedGroups, skippedInvalid, skippedSelf };
};

// ---------------------------------------------------------------------------
// Main entry point: connection-ready + controlled retry
// ---------------------------------------------------------------------------

/**
 * Run the WhatsApp → CRM contact synchronization for a user.
 *
 * Flow:
 *   connection open → wait for initial/app-state sync → retrieve contacts →
 *   normalize → filter invalid/group/system/self JIDs → bulk upsert MongoDB →
 *   log exact counts.
 *
 * Retries (max 3 attempts) with delays 2s / 5s / 10s when no contacts are
 * available, logging detailed diagnostics instead of silently succeeding.
 *
 * @param {String} ownerId
 * @param {Object} sock - Baileys socket
 * @param {Object} [options]
 * @param {String} [options.reason="connect"] - "connect" or "manual"
 * @param {String} [options.authFolder] - folder containing the user's Baileys
 *   session files (used for the session contact registry fallback)
 * @returns {Promise<Object>} summary
 */
const syncContactsOnConnect = async (ownerId, sock, options = {}) => {
  const reason = options.reason || "connect";
  const authFolder = options.authFolder || null;
  const minIntervalMs = options.minIntervalMs || 0;

  // Coalesce concurrent syncs for the same user.
  if (activeSyncs.has(ownerId)) {
    return activeSyncs.get(ownerId);
  }

  // Throttle: skip if a sync completed recently (e.g. login / list-open
  // triggers) — prevents hammering when the same user opens the site often.
  const lastDone = lastSyncAt.get(ownerId);
  if (minIntervalMs > 0 && lastDone && Date.now() - lastDone < minIntervalMs) {
    const ago = Math.round((Date.now() - lastDone) / 1000);
    console.log(
      `[Contacts Sync] Skipped for user ${ownerId} (last sync ${ago}s ago, min interval ${Math.round(minIntervalMs / 1000)}s)`,
    );
    return {
      source: null,
      total: 0,
      found: 0,
      inserted: 0,
      updated: 0,
      skippedGroups: 0,
      skippedInvalid: 0,
      skippedSelf: 0,
      completed: false,
      skipped: true,
    };
  }

  const run = async () => {
    const summary = {
      source: null,
      total: 0,
      found: 0,
      inserted: 0,
      updated: 0,
      skippedGroups: 0,
      skippedInvalid: 0,
      skippedSelf: 0,
      completed: false,
    };

    try {
      ensureEventListeners(ownerId, sock);

      console.log(`[Contacts Sync] Connection ready for user ${ownerId}`);

      // Give app-state sync a moment to deliver saved-contact metadata.
      if (reason === "connect") {
        await delay(APP_STATE_GRACE_MS);
      }

      await recoverAppStateContacts(ownerId, sock);

      const maxAttempts = RETRY_DELAYS_MS.length; // 3
      let attempt = 0;
      let lastFetch = null;

      while (attempt < maxAttempts) {
        attempt++;
        try {
          lastFetch = await fetchContactsFromBaileys(ownerId, sock, {
            authFolder,
          });
        } catch (err) {
          console.error(
            `[Contacts Sync] Attempt ${attempt}/${maxAttempts} failed:`,
            err.message,
          );
          lastFetch = { source: null, entries: [] };
        }

        const { contacts, skippedGroups, skippedInvalid, skippedSelf } =
          normalizeContactList(ownerId, sock, lastFetch.entries);

        summary.source = lastFetch.source || "unknown";
        summary.found = lastFetch.entries.length;
        summary.skippedGroups = skippedGroups;
        summary.skippedInvalid = skippedInvalid;
        summary.skippedSelf = skippedSelf;
        summary.total = contacts.length;

        console.log(`[Contacts Sync] Contact source: ${summary.source}`);
        console.log(`[Contacts Sync] Raw contacts found: ${summary.found}`);
        console.log(`[Contacts Sync] Valid contacts: ${summary.total}`);
        console.log(`[Contacts Sync] Groups skipped: ${skippedGroups}`);
        console.log(`[Contacts Sync] Invalid JIDs skipped: ${skippedInvalid}`);
        console.log(`[Contacts Sync] Self skipped: ${skippedSelf}`);

        if (contacts.length > 0) {
          console.log(`[Contacts Sync] Upserting ${contacts.length} contacts`);
          const syncResult = await syncWhatsAppContacts({
            ownerId,
            contacts,
            overwrite: options.overwrite || false,
          });
          summary.inserted = syncResult.inserted;
          summary.updated = syncResult.updated;
          summary.completed = true;
          lastSyncAt.set(ownerId, Date.now());
          console.log(`[Contacts Sync] Inserted: ${syncResult.inserted}`);
          console.log(`[Contacts Sync] Updated: ${syncResult.updated}`);
          console.log(`[Contacts Sync] Completed`);
          return summary;
        }

        // No contacts available — log WHY, then retry with backoff.
        console.log(
          `[Contacts Sync] No contacts available from ${summary.source}`,
        );
        try {
          console.log(
            `[Contacts Sync] sock.user.contacts count: ${
              Array.isArray(sock?.user?.contacts)
                ? sock.user.contacts.length
                : "N/A (not exposed by this Baileys version)"
            }`,
          );
        } catch {
          console.log(
            `[Contacts Sync] sock.user.contacts count: N/A (not exposed)`,
          );
        }
        console.log(
          `[Contacts Sync] store/contact cache count: ${
            contactCache.get(ownerId)?.size || 0
          }`,
        );
        console.log(
          `[Contacts Sync] LID mappings cached: ${
            lidToPn.get(ownerId)?.size || 0
          }`,
        );
        console.log(
          `[Contacts Sync] app-state/contact sync status: ${
            (contactCache.get(ownerId)?.size || 0) > 0
              ? "app-state contacts received"
              : "no app-state contacts received yet"
          }`,
        );

        if (attempt < maxAttempts) {
          const retryDelay = RETRY_DELAYS_MS[attempt - 1];
          console.log(
            `[Contacts Sync] Retrying in ${retryDelay} ms (attempt ${attempt}/${maxAttempts})`,
          );
          await delay(retryDelay);
        }
      }

      console.log(
        `[Contacts Sync] Completed (no contacts after ${maxAttempts} attempts)`,
      );
      lastSyncAt.set(ownerId, Date.now());
      return summary;
    } catch (error) {
      console.error(
        `[Contacts Sync] Error during synchronization:`,
        error.message,
      );
      return summary;
    } finally {
      activeSyncs.delete(ownerId);
    }
  };

  const promise = run();
  activeSyncs.set(ownerId, promise);
  return promise;
};

/** Remove in-memory caches for a user (call when the session disconnects). */
const clearUserCache = (userId) => {
  contactCache.delete(userId);
  lidToPn.delete(userId);
  lastSyncAt.delete(userId);
};

/** Resolve a LID to its PN jid from the cached mappings (exported for reuse). */
const getLidToPn = (userId) => lidToPn.get(userId) || new Map();

export default {
  syncWhatsAppContacts,
  syncContactsOnConnect,
  clearUserCache,
  getLidToPn,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
