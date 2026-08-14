import mongoose from "mongoose";

/**
 * MongoDB-backed replacement for the Redis temp-token store.
 *
 * Replaces these Redis usages:
 *   - `otp_temp_token:${phone}`  → { key, value, ttlSeconds: 600 }
 *   - `USER_ACCESS:${userId}:${deviceId}`  → { key, value, ttlSeconds: 600 }
 *   - `USER_REFRESH:${userId}:${deviceId}` → { key, value, ttlSeconds: 1296000 }
 *
 * The `expiresAt` field + TTL index auto-deletes expired documents,
 * mirroring Redis EXPIRE behavior (data is persisted across restarts).
 */
const tempTokenSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    value: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

// Auto-delete expired tokens (mirrors Redis TTL)
tempTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const TempToken = mongoose.model("TempToken", tempTokenSchema);

export default TempToken;