import mongoose from "mongoose";

const mediaSchema = new mongoose.Schema(
  {
    url: { type: String, default: null },
    filename: { type: String, default: null },
    mimeType: { type: String, default: null },
    caption: { type: String, default: null },
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userprofile",
      required: true,
      index: true,
    },

    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
    },

    campaign: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      default: null,
    },

    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      default: "outbound",
    },

    type: {
      type: String,
      enum: [
        "text",
        "image",
        "video",
        "audio",
        "document",
        "sticker",
        "location",
        "contact",
      ],
      default: "text",
    },

    content: {
      type: String,
      default: null,
    },

    media: {
      type: mediaSchema,
      default: null,
    },

    to: {
      type: String,
      default: null,
    },

    whatsappMessageId: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      enum: [
        "pending",
        "queued",
        "sending",
        "sent",
        "delivered",
        "read",
        "failed",
      ],
      default: "pending",
    },

    error: {
      type: String,
      default: null,
    },

    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

messageSchema.index({ owner: 1, contact: 1 });
messageSchema.index({ owner: 1, campaign: 1 });
messageSchema.index({ owner: 1, whatsappMessageId: 1 });

const Message = mongoose.model("Message", messageSchema);

export default Message;
