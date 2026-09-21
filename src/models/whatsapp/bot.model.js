import mongoose from "mongoose";

/**
 * A bot = one automation persona (like a Telegram/Discord bot) that the owner
 * can attach to any group they are allowed to message in.
 *
 * Design notes:
 *   • Several bots can be attached to the same group; they are evaluated in
 *     priority order and the first trigger that matches wins (see
 *     botRuntime.helpers.js — pickTrigger).
 *   • `triggers` are the "when" (condition) and each carries its own reply, so a
 *     bot is useful without any flow builder yet. Flow/AI/API steps land on top
 *     of this same document later (see `flow` placeholder below).
 *   • Connection is NOT stored per bot: the WhatsApp session is per owner, so a
 *     bot simply piggybacks on the owner's connected session.
 */

const triggerSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    // When to fire
    type: {
      type: String,
      enum: [
        "any",
        "exact",
        "contains",
        "starts_with",
        "ends_with",
        "regex",
        "keyword",
        "command",
        "new_member",
        "returning_member",
        "new_customer",
        "returning_customer",
      ],
      default: "contains",
    },
    value: { type: String, default: "" },
    // Case sensitive matching (off by default — WhatsApp text is messy)
    caseSensitive: { type: Boolean, default: false },
    // What to send back
    reply: { type: String, default: "" },
    mediaType: {
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
    mediaUrl: { type: String, default: null },
    // Guard rails
    enabled: { type: Boolean, default: true },
    priority: { type: Number, default: 100 }, // lower = checked first
    delayMs: { type: Number, default: 0 },
    cooldownSec: { type: Number, default: 5 },
    hits: { type: Number, default: 0 },
  },
  { _id: true },
);

const behaviorSchema = new mongoose.Schema(
  {
    autoReply: { type: Boolean, default: true },
    typingIndicator: { type: Boolean, default: true },
    readMessages: { type: Boolean, default: true },
    replyDelayMs: { type: Number, default: 0 },
    randomDelayMs: { type: Number, default: 0 },

    // Human handoff — used when nothing else matched (or when requested)
    humanHandoff: { type: Boolean, default: false },
    handoffMessage: { type: String, default: "" },

    // Working hours — outside them the away message is sent instead
    workingHours: {
      enabled: { type: Boolean, default: false },
      start: { type: String, default: "09:00" },
      end: { type: String, default: "21:00" },
      days: { type: [Number], default: [1, 2, 3, 4, 5, 6] }, // 0 = Sunday
    },
    awayMessage: { type: String, default: "" },

    welcomeMessage: { type: String, default: "" },
    goodbyeMessage: { type: String, default: "" },
  },
  { _id: false },
);

const botGroupLinkSchema = new mongoose.Schema(
  {
    jid: { type: String, required: true },
    subject: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
    activatedAt: { type: Date, default: null },
  },
  { _id: true },
);

const statsSchema = new mongoose.Schema(
  {
    received: { type: Number, default: 0 },
    matched: { type: Number, default: 0 },
    replied: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    handoffs: { type: Number, default: 0 },
    lastActiveAt: { type: Date, default: null },
  },
  { _id: false },
);

const botSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "userprofile",
      required: true,
      index: true,
    },

    // ---- Basic information ----
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    emoji: { type: String, default: "🤖" },
    color: { type: String, default: "emerald" },
    category: {
      type: String,
      enum: [
        "filter_message",
        "general",
        "support",
        "sales",
        "booking",
        "community",
        "moderation",
        "custom",
      ],
      default: "filter_message",
    },
    language: {
      type: String,
      enum: ["en", "hi", "hinglish"],
      default: "en",
    },
    timezone: { type: String, default: "Asia/Kolkata" },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },

    // ---- Behaviour ----
    behavior: { type: behaviorSchema, default: () => ({}) },

    // ---- Triggers ----
    triggers: { type: [triggerSchema], default: [] },

    // ---- Where this bot is switched on ----
    groups: { type: [botGroupLinkSchema], default: [] },

    // ---- Live counters (dashboard / analytics) ----
    stats: { type: statsSchema, default: () => ({}) },

    // Reserved for the flow builder phase (nodes + edges).
    flow: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

botSchema.index({ owner: 1, name: 1 });
botSchema.index({ owner: 1, "groups.jid": 1 });

export default mongoose.model("Bot", botSchema);
