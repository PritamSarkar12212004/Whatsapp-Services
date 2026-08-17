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

const templateSchema = new mongoose.Schema(
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

    // Free-form string so users can create their own categories
    // (e.g. "welcome", "offer", "reminder") besides the built-in ones.
    category: {
      type: String,
      trim: true,
      default: "custom",
    },

    type: {
      type: String,
      enum: ["text", "image", "video", "audio", "document"],
      default: "text",
    },

    // Required for text templates; media templates may rely on the media
    // caption instead, so content defaults to an empty string for them.
    content: {
      type: String,
      default: "",
    },

    variables: {
      type: [String],
      default: [],
    },

    media: {
      type: mediaSchema,
      default: null,
    },

    status: {
      type: String,
      enum: ["active", "inactive", "draft"],
      default: "active",
    },

    // True when the template was created with Dev Mode (dynamic variables)
    devMode: {
      type: Boolean,
      default: false,
    },

    // Dev mode: schedule flag — the caller sends scheduledAt (24h) in the API call
    scheduleEnabled: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// Template name must be unique per owner
templateSchema.index({ owner: 1, name: 1 }, { unique: true });

const Template = mongoose.model("Template", templateSchema);

export default Template;
