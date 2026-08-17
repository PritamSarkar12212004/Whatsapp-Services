import mongoose from "mongoose";

const contactActivitySchema = new mongoose.Schema(
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
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: [
        "imported",
        "updated",
        "added_to_group",
        "removed_from_group",
        "tagged",
        "untagged",
        "message_sent",
        "message_received",
        "campaign_sent",
        "campaign_delivered",
        "campaign_read",
        "opted_out",
        "blocked",
      ],
      required: true,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true },
);

contactActivitySchema.index({ owner: 1, contact: 1, timestamp: -1 });

const ContactActivity = mongoose.model(
  "ContactActivity",
  contactActivitySchema,
);

export default ContactActivity;
