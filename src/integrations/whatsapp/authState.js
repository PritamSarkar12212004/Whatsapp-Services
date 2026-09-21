/**
 * MongoDB-backed Baileys authentication state.
 *
 * WHY THIS EXISTS
 * ---------------
 * `useMultiFileAuthState` keeps `creds.json` + every signal key as files
 * inside the deployed source folder. That works on your laptop, but the
 * production backend runs on Render's FREE plan where:
 *
 *   - the container is spun down after ~15 minutes without traffic, and
 *   - the filesystem is EPHEMERAL (free plan has no persistent disks), so
 *     every spin-down / redeploy starts from a clean disk.
 *
 * So after a while the auth folder was simply gone, `useMultiFileAuthState`
 * found no creds, Baileys generated a brand-new identity and the frontend was
 * shown a QR code again — even though nothing was ever logged out.
 *
 * This module is a drop-in replacement: it returns exactly the same shape as
 * `useMultiFileAuthState` —
 *
 *     { state: { creds, keys: { get, set } }, saveCreds }
 *
 * — but persists everything in MongoDB, which survives restarts, redeploys
 * and spin-downs.
 *
 * On the first run for a given scope, any auth state still lying on disk
 * (e.g. the currently committed `auth_info_baileys` folders) is imported
 * once, so the already linked device keeps working without a new QR scan.
 */
import fs from "fs";
import path from "path";
import chalk from "chalk";
import {
  BufferJSON,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
} from "@whiskeysockets/baileys";
import WhatsAppAuthState from "../../models/whatsapp/whatsappAuthState.model.js";

/** Owner key used by the legacy system (OTP) socket, which has no user id. */
export const SYSTEM_OWNER_KEY = "system";

const CREDS_TYPE = "creds";
const CREDS_KEY_ID = "";

/**
 * Baileys' file names are `${type}-${fileSafe(id)}.json`, and ids themselves
 * contain `-`, so the reverse mapping is done with a longest-prefix match.
 * Longest first so `sender-key-memory` wins over `sender-key` and
 * `app-state-sync-version` over `app-state-sync-key`.
 */
const KNOWN_KEY_TYPES = [
  "app-state-sync-version",
  "app-state-sync-key",
  "sender-key-memory",
  "identity-key",
  "sender-key",
  "lid-mapping",
  "device-list",
  "pre-key",
  "session",
  "tctoken",
].sort((a, b) => b.length - a.length);

/** Legacy on-disk location (root folder = system socket, subfolder = user). */
const LEGACY_AUTH_BASE_FOLDER = path.join(
  path.resolve(),
  "src/whatsapp/auth_info_baileys",
);

// ---------------------------------------------------------------------------
// Serialization helpers (identical to what useMultiFileAuthState uses)
// ---------------------------------------------------------------------------

/** Encode a value the way Baileys stores it (Buffers stay intact). */
const encode = (value) => JSON.stringify(value, BufferJSON.replacer);

/** Decode a stored value back into Baileys' object shape. */
const decode = (raw) => {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw, BufferJSON.reviver);
  } catch {
    return null;
  }
};

const chunked = (items, size) => {
  const result = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
};

// ---------------------------------------------------------------------------
// Per-owner write serialization
//
// Baileys fires many concurrent key writes during app-state sync. Mongo
// upserts on the same documents must not interleave, so writes for one owner
// are chained. A failed task never breaks the chain for the following writes.
// ---------------------------------------------------------------------------
const writeChains = new Map();

const serialize = (ownerKey, task) => {
  const previous = writeChains.get(ownerKey) || Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(
    ownerKey,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
};

// ---------------------------------------------------------------------------
// Mongo read / write primitives
// ---------------------------------------------------------------------------

const readCreds = async (ownerKey) => {
  const doc = await WhatsAppAuthState.findOne({
    ownerKey,
    type: CREDS_TYPE,
    keyId: CREDS_KEY_ID,
  })
    .select("value")
    .lean();
  return decode(doc?.value);
};

const writeCreds = (ownerKey, creds) =>
  WhatsAppAuthState.updateOne(
    { ownerKey, type: CREDS_TYPE, keyId: CREDS_KEY_ID },
    { $set: { value: encode(creds) } },
    { upsert: true },
  ).exec();

const readKeys = async (ownerKey, type, ids) => {
  const data = {};
  if (!Array.isArray(ids) || ids.length === 0) return data;

  const docs = await WhatsAppAuthState.find({
    ownerKey,
    type,
    keyId: { $in: ids.map(String) },
  })
    .select("keyId value")
    .lean();

  const stored = new Map(docs.map((doc) => [doc.keyId, doc.value]));

  for (const id of ids) {
    let value = decode(stored.get(String(id)));

    // app-state-sync-key is stored as a plain protobuf object and must be
    // revived into a real AppStateSyncKeyData instance (as Baileys does).
    if (type === "app-state-sync-key" && value) {
      try {
        value = proto.Message.AppStateSyncKeyData.fromObject(value);
      } catch {
        value = null;
      }
    }

    data[id] = value;
  }

  return data;
};

const writeKeys = async (ownerKey, data) => {
  const upserts = [];
  const deletes = [];

  for (const type of Object.keys(data || {})) {
    const bucket = data[type] || {};
    for (const keyId of Object.keys(bucket)) {
      const value = bucket[keyId];
      if (value === null || value === undefined) {
        deletes.push({ ownerKey, type, keyId: String(keyId) });
      } else {
        upserts.push({
          updateOne: {
            filter: { ownerKey, type, keyId: String(keyId) },
            update: { $set: { value: encode(value) } },
            upsert: true,
          },
        });
      }
    }
  }

  // Stay well inside Mongo's per-bulkWrite operation limit.
  for (const chunk of chunked(upserts, 500)) {
    await WhatsAppAuthState.bulkWrite(chunk, { ordered: false });
  }
  for (const chunk of chunked(deletes, 500)) {
    await WhatsAppAuthState.bulkWrite(
      chunk.map((filter) => ({ deleteOne: { filter } })),
      { ordered: false },
    );
  }
};

// ---------------------------------------------------------------------------
// One-time import of legacy on-disk auth state
// ---------------------------------------------------------------------------

const migratedScopes = new Set();

/** Map a legacy file name back to `{ type, keyId }` (null when unknown). */
const parseLegacyFileName = (fileName) => {
  if (!fileName.endsWith(".json")) return null;

  const stem = fileName.slice(0, -".json".length);

  if (stem === CREDS_TYPE) return { type: CREDS_TYPE, keyId: CREDS_KEY_ID };

  for (const type of KNOWN_KEY_TYPES) {
    if (stem.startsWith(`${type}-`)) {
      return { type, keyId: stem.slice(type.length + 1) };
    }
  }

  return null;
};

const importLegacyAuthState = async (ownerKey) => {
  if (migratedScopes.has(ownerKey)) return;

  // Never overwrite auth state that already lives in Mongo.
  if (await readCreds(ownerKey)) {
    migratedScopes.add(ownerKey);
    return;
  }

  const folder =
    ownerKey === SYSTEM_OWNER_KEY
      ? LEGACY_AUTH_BASE_FOLDER
      : path.join(LEGACY_AUTH_BASE_FOLDER, ownerKey);

  let entries;
  try {
    // Non-recursive + files only: the root folder also holds per-user
    // subfolders, which must not be imported into the system scope.
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    migratedScopes.add(ownerKey);
    return;
  }

  const byType = {};
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const parsed = parseLegacyFileName(entry.name);
    if (!parsed) {
      skipped += 1;
      continue;
    }

    try {
      const raw = fs.readFileSync(path.join(folder, entry.name), "utf-8");
      // Re-encode through BufferJSON so Buffers are stored correctly.
      const value = JSON.parse(raw, BufferJSON.reviver);
      byType[parsed.type] = byType[parsed.type] || {};
      byType[parsed.type][parsed.keyId] = value;
    } catch {
      skipped += 1;
    }
  }

  const creds = byType[CREDS_TYPE]?.[CREDS_KEY_ID];
  delete byType[CREDS_TYPE];

  if (!creds) {
    console.log(
      chalk.cyan(
        `[Baileys] No legacy auth state for "${ownerKey}" — starting fresh`,
      ),
    );
    migratedScopes.add(ownerKey);
    return;
  }

  await writeCreds(ownerKey, creds);
  await writeKeys(ownerKey, byType);

  const keyCount = Object.values(byType).reduce(
    (total, bucket) => total + Object.keys(bucket).length,
    0,
  );

  console.log(
    chalk.green(
      `[Baileys] Imported legacy auth state for "${ownerKey}" into MongoDB ` +
        `(creds + ${keyCount} key(s)${skipped ? `, ${skipped} skipped` : ""})`,
    ),
  );

  migratedScopes.add(ownerKey);
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a MongoDB-backed auth state for `ownerKey`.
 *
 * Drop-in replacement for `useMultiFileAuthState(folder)`:
 *   const { state, saveCreds } = await useMongoAuthState(userId);
 *
 * The key store is wrapped in `makeCacheableSignalKeyStore` because Baileys 7
 * does that itself ONLY for transaction capability — without the cache every
 * key lookup would be a network round trip to Atlas, making app-state sync
 * (thousands of keys) painfully slow.
 */
export const useMongoAuthState = async (ownerKey) => {
  const scope = String(ownerKey || SYSTEM_OWNER_KEY);

  await importLegacyAuthState(scope);

  const creds = (await readCreds(scope)) || initAuthCreds();

  const mongoStore = {
    get: (type, ids) => readKeys(scope, type, ids),
    set: (data) => serialize(scope, () => writeKeys(scope, data)),
  };

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(mongoStore),
    },
    saveCreds: () => serialize(scope, () => writeCreds(scope, creds)),
  };
};

/**
 * Remove all stored auth state for one owner (used on logout / auth reset).
 * Returns the number of deleted documents.
 */
export const clearMongoAuthState = async (ownerKey) => {
  const scope = String(ownerKey || SYSTEM_OWNER_KEY);
  const result = await WhatsAppAuthState.deleteMany({ ownerKey: scope }).exec();
  migratedScopes.delete(scope);
  return result.deletedCount || 0;
};

/**
 * List the stored key ids for one owner + type.
 * Used by features that previously read the auth folder listing
 * (e.g. the `lid-mapping-<pn>.json` session contact registry).
 */
export const listAuthKeyIds = async (ownerKey, type) => {
  const scope = String(ownerKey || SYSTEM_OWNER_KEY);
  const docs = await WhatsAppAuthState.find({ ownerKey: scope, type })
    .select("keyId")
    .lean();
  return docs.map((doc) => doc.keyId);
};

export default useMongoAuthState;



