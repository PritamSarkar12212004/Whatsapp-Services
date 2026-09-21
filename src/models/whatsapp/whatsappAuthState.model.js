import mongoose from "mongoose";

/**
 * MongoDB-backed Baileys authentication state.
 *
 * One document per auth blob (`creds` + every signal key), because Baileys
 * key ids contain characters Mongo does not allow in field names (`.`,
 * `$`, `:`), so they cannot be used as dotted object paths.
 *
 * `ownerKey` is either "system" (the OTP gateway socket) or the user's
 * `_id` string. This collection replaces the on-disk
 * `src/whatsapp/auth_info_baileys/**` folders, which are lost whenever the
 * host restarts / redeploys / spins down (Render free plan filesystem is
 * ephemeral) and were the reason a fresh QR scan was needed every so often.
 */
const whatsappAuthStateSchema = new mongoose.Schema(
  {
    ownerKey: {
      type: String,
      required: true,
      index: true,
    },

    // creds | pre-key | session | sender-key | sender-key-memory |
    // app-state-sync-key | app-state-sync-version | tctoken |
    // lid-mapping | device-list | identity-key
    type: {
      type: String,
      required: true,
    },

    // Empty string for the `creds` blob, otherwise the Baileys key id.
    keyId: {
      type: String,
      required: true,
      default: "",
    },

    // BufferJSON-serialized (Baileys replacer/reviver) so Buffers survive
    // the round trip. Always an explicit string — never Mixed.
    value: {
      type: String,
      required: true,
    },
  },
  { timestamps: true },
);

// One blob per owner + type + id.
whatsappAuthStateSchema.index(
  { ownerKey: 1, type: 1, keyId: 1 },
  { unique: true },
);

const WhatsAppAuthState = mongoose.model(
  "WhatsAppAuthState",
  whatsappAuthStateSchema,
);

export default WhatsAppAuthState;
