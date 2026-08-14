import TempToken from "../../models/token/tempToken.model.js";

/**
 * MongoDB-backed replacement for the Redis key/value store used across
 * the merged microservices.
 *
 * The original Redis API exposed: set, get, del, exists, expire, ttl,
 * setNX, setXX, compare, delByPattern. This service provides those same
 * operations backed by a Mongo collection with TTL indexes, so behaviour
 * (including auto-expiry) is preserved without Redis.
 */
const toStringKey = (key) => String(key);

const serialize = (value) => {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
};

const deserialize = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const tokenStore = {
  /** set(key, value, ttlSeconds?) - upsert + set expiry */
  set: async (key, value, time) => {
    try {
      const k = toStringKey(key);
      const v = serialize(value);
      const expiresAt = new Date(Date.now() + (time || 0) * 1000);

      await TempToken.findOneAndUpdate(
        { key: k },
        { value: v, expiresAt },
        { upsert: true, new: true },
      );
      return true;
    } catch (err) {
      console.error("❌ TokenStore SET Error:", err.message);
      return false;
    }
  },

  /** get(key) */
  get: async (key) => {
    try {
      const k = toStringKey(key);
      const doc = await TempToken.findOne({ key: k });
      if (!doc) return null;
      if (doc.expiresAt && doc.expiresAt <= new Date()) {
        await TempToken.deleteOne({ key: k });
        return null;
      }
      return deserialize(doc.value);
    } catch (err) {
      console.error("❌ TokenStore GET Error:", err.message);
      return null;
    }
  },

  /** del(key) */
  del: async (key) => {
    try {
      const k = toStringKey(key);
      await TempToken.deleteOne({ key: k });
      return true;
    } catch (err) {
      console.error("❌ TokenStore DEL Error:", err.message);
      return false;
    }
  },

  /** exists(key) */
  exists: async (key) => {
    try {
      const k = toStringKey(key);
      const doc = await TempToken.findOne({ key: k });
      return !!doc && doc.expiresAt > new Date();
    } catch (err) {
      console.error("❌ TokenStore EXISTS Error:", err.message);
      return false;
    }
  },

  /** expire(key, ttlSeconds) - refresh expiry only */
  expire: async (key, time) => {
    try {
      const k = toStringKey(key);
      const expiresAt = new Date(Date.now() + time * 1000);
      await TempToken.updateOne({ key: k }, { expiresAt });
      return true;
    } catch (err) {
      console.error("❌ TokenStore EXPIRE Error:", err.message);
      return false;
    }
  },

  /** ttl(key) - seconds until expiry */
  ttl: async (key) => {
    try {
      const k = toStringKey(key);
      const doc = await TempToken.findOne({ key: k });
      if (!doc) return -2; // key not found
      const ttl = Math.round((doc.expiresAt - new Date()) / 1000);
      return ttl <= 0 ? -1 : ttl; // -1 = expired/about to expire
    } catch (err) {
      console.error("❌ TokenStore TTL Error:", err.message);
      return null;
    }
  },

  /** setNX(key, value, ttlSeconds) - only set if key does NOT exist */
  setNX: async (key, value, time) => {
    try {
      const k = toStringKey(key);
      const v = serialize(value);
      const expiresAt = new Date(Date.now() + time * 1000);
      const existing = await TempToken.findOne({ key: k });
      if (existing) return "OK"; // not setting because exists (NX semantics)

      await TempToken.create({ key: k, value: v, expiresAt });
      return "OK";
    } catch (err) {
      console.error("❌ TokenStore SETNX Error:", err.message);
      return null;
    }
  },

  /** setXX(key, value, ttlSeconds) - only set if key ALREADY exists */
  setXX: async (key, value, time) => {
    try {
      const k = toStringKey(key);
      const v = serialize(value);
      const expiresAt = new Date(Date.now() + time * 1000);
      const existing = await TempToken.findOne({ key: k });
      if (!existing) return null; // not setting because missing (XX semantics)

      await TempToken.updateOne({ key: k }, { value: v, expiresAt });
      return "OK";
    } catch (err) {
      console.error("❌ TokenStore SETXX Error:", err.message);
      return null;
    }
  },

  /** compare(key, value) - does stored value equal given value? */
  compare: async (key, value) => {
    try {
      const stored = await tokenStore.get(toStringKey(key));
      return stored === serialize(value);
    } catch (err) {
      console.error("❌ TokenStore COMPARE Error:", err.message);
      return false;
    }
  },

  /** delByPattern(pattern) - delete all keys matching a prefix pattern (e.g. "USER_ACCESS:*") */
  delByPattern: async (pattern) => {
    try {
      // Convert Redis-style glob ("USER_ACCESS:*") to a Mongo regex on the `key` field
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp("^" + escaped.replace(/\\\*/g, ".*") + "$");
      const result = await TempToken.deleteMany({ key: regex });
      return result.deletedCount > 0;
    } catch (err) {
      console.error("❌ TokenStore DEL_BY_PATTERN Error:", err.message);
      return false;
    }
  },
};

export default tokenStore;