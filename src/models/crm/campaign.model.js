import mongoose from "mongoose";

const audienceSchema = new mongoose.Schema(
  {
    groups: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ContactGroup",
        default: [],
      },
    ],
    tags: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Tag",
        default: [],
      },
    ],
    contacts: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Contact",
        default: [],
      },
    ],
    excludedContacts: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Contact",
        default: [],
      },
    ],
  },
  { _id: false },
);

const statisticsSchema = new mongoose.Schema(
  {
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    read: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
  },
  { _id: false, default: {} },
);

const campaignSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userprofile",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    template: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Template",
      required: true,
    },

    audience: {
      type: audienceSchema,
      default: () => ({}),
    },

    variables: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    status: {
      type: String,
      enum: [
        "draft",
        "scheduled",
        "queued",
        "running",
        "paused",
        "completed",
        "cancelled",
        "failed",
      ],
      default: "draft",
    },

    scheduledAt: {
      type: Date,
      default: null,
    },

    // Optional cap on how many messages this campaign may send.
    // null = no limit. Applied when the audience is generated.
    sendLimit: {
      type: Number,
      default: null,
      min: 1,
    },

    startedAt: {
      type: Date,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    statistics: {
      type: statisticsSchema,
      default: () => ({}),
    },
  },
  { timestamps: true },
);

const Campaign = mongoose.model("Campaign", campaignSchema);

export default Campaign;
