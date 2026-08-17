import mongoose from "mongoose";

const campaignRecipientSchema = new mongoose.Schema(
  {
    campaign: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },

    contact: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      required: true,
    },

    phoneNumber: {
      type: String,
      required: true,
    },

    // 1-based copy number when the same contact receives the message more
    // than once (sendLimit = repeat count). Defaults to 1.
    sequence: {
      type: Number,
      default: 1,
    },

    renderedMessage: {
      type: String,
      default: null,
    },

    // Per-recipient rendered media (dynamic URLs/captions with {{variables}})
    renderedMedia: {
      type: new mongoose.Schema(
        {
          url: { type: String, default: null },
          filename: { type: String, default: null },
          caption: { type: String, default: null },
        },
        { _id: false },
      ),
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
        "skipped",
      ],
      default: "pending",
    },

    whatsappMessageId: {
      type: String,
      default: null,
    },

    queuedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },

    error: { type: String, default: null },

    retryCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// A recipient row is unique per campaign + contact + copy number
campaignRecipientSchema.index(
  { campaign: 1, contact: 1, sequence: 1 },
  { unique: true },
);

// Fast lookup by status for a campaign
campaignRecipientSchema.index({ campaign: 1, status: 1 });

const CampaignRecipient = mongoose.model(
  "CampaignRecipient",
  campaignRecipientSchema,
);

export default CampaignRecipient;
