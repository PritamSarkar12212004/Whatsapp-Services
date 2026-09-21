import mongoose from "mongoose";

const whatsappSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userprofile",
      required: true,
      index: true,
    },

    /**
     * Which of the user's numbers this session belongs to.
     * null = the primary number (and every session written before accounts
     * existed), so old rows keep working unchanged.
     */
    accountId: {
      type: String,
      default: null,
    },

    phoneNumber: {
      type: String,
      default: null,
    },

    /** The full account key — `userId` or `userId::accountId`. */
    sessionId: {
      type: String,
      required: true,
      unique: true,
    },

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

    lastConnectedAt: Date,
    lastDisconnectedAt: Date,
  },
  { timestamps: true },
);

// One session row per number (this replaces the old unique index on userId).
whatsappSessionSchema.index({ userId: 1, accountId: 1 }, { unique: true });

const WhatsAppSession = mongoose.model(
  "WhatsAppSession",
  whatsappSessionSchema,
);

export default WhatsAppSession;