import mongoose from "mongoose";

const customFieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    value: { type: String, default: "" },
  },
  { _id: false },
);

const contactSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userprofile",
      required: true,
      index: true,
    },

    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },

    name: {
      type: String,
      trim: true,
      default: null,
    },

    pushName: {
      type: String,
      trim: true,
      default: null,
    },

    profilePicture: {
      type: String,
      default: null,
    },

    isSavedContact: {
      type: Boolean,
      default: false,
    },

    isUnknown: {
      type: Boolean,
      default: false,
    },

    isBusiness: {
      type: Boolean,
      default: false,
    },

    tags: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Tag",
        default: [],
      },
    ],

    customGroups: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ContactGroup",
        default: [],
      },
    ],

    customFields: {
      type: [customFieldSchema],
      default: [],
    },

    // NOTE: no `default: null` here — the text index on phoneNumber treats
    // `language` as the language-override field and rejects non-string values,
    // so Mongoose must not inject language: null into new documents.
    language: {
      type: String,
      trim: true,
    },

    city: {
      type: String,
      trim: true,
      default: null,
    },

    state: {
      type: String,
      trim: true,
      default: null,
    },

    isBlocked: {
      type: Boolean,
      default: false,
    },

    isOptedOut: {
      type: Boolean,
      default: false,
    },

    lastMessageAt: {
      type: Date,
      default: null,
    },

    lastSeenAt: {
      type: Date,
      default: null,
    },

    // No default here: manual contacts must not carry whatsappJid at all,
    // so the partial unique index below only covers real WhatsApp JIDs.
    whatsappJid: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true },
);

// Prevent duplicate contacts for the same owner + phone number
contactSchema.index({ owner: 1, phoneNumber: 1 }, { unique: true });

// Searchable phone number + owner
contactSchema.index({ owner: 1, phoneNumber: "text" });

// Group relationships
contactSchema.index({ owner: 1, customGroups: 1 });

// Tags
contactSchema.index({ owner: 1, tags: 1 });

// WhatsApp contact identity - prevents duplicates per owner, but ONLY for
// real WhatsApp JIDs. Manual contacts (no whatsappJid) must not collide.
contactSchema.index(
  { owner: 1, whatsappJid: 1 },
  { unique: true, partialFilterExpression: { whatsappJid: { $type: "string" } } },
);

// Blocked / opted-out lookups
contactSchema.index({ owner: 1, isBlocked: 1 });
contactSchema.index({ owner: 1, isOptedOut: 1 });

const Contact = mongoose.model("Contact", contactSchema);

export default Contact;