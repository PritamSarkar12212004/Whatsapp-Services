import mongoose from "mongoose";

/**
 * One WhatsApp number belonging to a login.
 *
 * The primary number (the one the account was created with) is stored with
 * `accountId: null` so every document written before multi-account existed
 * keeps belonging to it — no migration, no re-scan.
 */
const whatsappAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userprofile",
      required: true,
      index: true,
    },

    /** null = the primary (default) number. */
    accountId: {
      type: String,
      default: null,
    },

    /** What the user calls this number — "Sales", "Support", … */
    label: {
      type: String,
      default: "",
      trim: true,
    },

    /** Filled in once the number is linked (pushed from the socket). */
    phoneNumber: { type: String, default: null },
    profileName: { type: String, default: null },
    profilePicUrl: { type: String, default: null },

    status: {
      type: String,
      enum: [
        "disconnected",
        "connecting",
        "qr_required",
        "connected",
        "logged_out",
        "error",
      ],
      default: "disconnected",
    },

    /** Set once for the original number, so the UI can mark it. */
    isPrimary: { type: Boolean, default: false },

    lastConnectedAt: { type: Date, default: null },
    lastDisconnectedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

whatsappAccountSchema.index({ userId: 1, accountId: 1 }, { unique: true });

const WhatsappAccount = mongoose.model("WhatsappAccount", whatsappAccountSchema);

export default WhatsappAccount;
