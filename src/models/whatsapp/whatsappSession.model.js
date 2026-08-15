import mongoose from "mongoose";

const whatsappSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userprofile",
      required: true,
      unique: true,
      index: true,
    },

    phoneNumber: {
      type: String,
      default: null,
    },

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

const WhatsAppSession = mongoose.model(
  "WhatsAppSession",
  whatsappSessionSchema,
);

export default WhatsAppSession;