/**
 * Bots API — create/manage automation personas and switch them on per group.
 *
 * Everything the owner sends is sanitised here (the runtime trusts the DB), and
 * every mutation clears the runtime cache so a change is live immediately.
 *
 * @see ../../integrations/whatsapp/botRuntime/botRuntime.service.js
 */

import Bot from "../../../models/whatsapp/bot.model.js";
import { buildWaKey } from "../../../utils/whatsapp/accountKey.js";
import {
  invalidateBotCache,
  getBotsForGroup,
  simulateBotMessage,
} from "../../../integrations/whatsapp/botRuntime/botRuntime.service.js";

const MAX_BOT_NAME = 60;

const TRIGGER_TYPES = [
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
];

const MEDIA_TYPES = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
];

const CATEGORIES = [
  "filter_message",
  "general",
  "support",
  "sales",
  "booking",
  "community",
  "moderation",
  "custom",
];

const LANGUAGES = ["en", "hi", "hinglish"];

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const requireOwner = (req, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ status: "error", message: "User not authenticated" });
    return null;
  }
  return userId;
};

const sanitizeTrigger = (t = {}) => ({
  name: String(t.name ?? "").slice(0, 60),
  type: TRIGGER_TYPES.includes(t.type) ? t.type : "contains",
  value: String(t.value ?? "").slice(0, 500),
  caseSensitive: Boolean(t.caseSensitive),
  reply: String(t.reply ?? "").slice(0, 4000),
  mediaType: MEDIA_TYPES.includes(t.mediaType) ? t.mediaType : "text",
  mediaUrl: t.mediaUrl ? String(t.mediaUrl).slice(0, 1000) : null,
  mention: Boolean(t.mention),
  enabled: t.enabled !== false,
  priority: clampNumber(t.priority, 1, 999, 100),
  delayMs: clampNumber(t.delayMs, 0, 60000, 0),
  cooldownSec: clampNumber(t.cooldownSec, 0, 86400, 5),
});

const sanitizeBehavior = (b = {}) => ({
  autoReply: b.autoReply !== false,
  typingIndicator: b.typingIndicator !== false,
  readMessages: b.readMessages !== false,
  replyDelayMs: clampNumber(b.replyDelayMs, 0, 60000, 0),
  randomDelayMs: clampNumber(b.randomDelayMs, 0, 60000, 0),
  humanHandoff: Boolean(b.humanHandoff),
  handoffMessage: String(b.handoffMessage ?? "").slice(0, 2000),
  workingHours: {
    enabled: Boolean(b.workingHours?.enabled),
    start: /^\d{1,2}:\d{2}$/.test(b.workingHours?.start || "")
      ? b.workingHours.start
      : "09:00",
    end: /^\d{1,2}:\d{2}$/.test(b.workingHours?.end || "")
      ? b.workingHours.end
      : "21:00",
    days: Array.isArray(b.workingHours?.days)
      ? b.workingHours.days
          .map(Number)
          .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [1, 2, 3, 4, 5, 6],
  },
  awayMessage: String(b.awayMessage ?? "").slice(0, 2000),
  welcomeMessage: String(b.welcomeMessage ?? "").slice(0, 2000),
  goodbyeMessage: String(b.goodbyeMessage ?? "").slice(0, 2000),
});

/** Only touch the fields that were actually sent (PATCH semantics). */
const buildUpdate = (body = {}) => {
  const update = {};

  if (body.name !== undefined) {
    update.name = String(body.name).trim().slice(0, MAX_BOT_NAME);
  }
  if (body.description !== undefined) {
    update.description = String(body.description).slice(0, 1000);
  }
  if (body.emoji !== undefined) update.emoji = String(body.emoji).slice(0, 8) || "🤖";
  if (body.color !== undefined) update.color = String(body.color).slice(0, 20);
  if (body.category !== undefined && CATEGORIES.includes(body.category)) {
    update.category = body.category;
  }
  if (body.language !== undefined && LANGUAGES.includes(body.language)) {
    update.language = body.language;
  }
  if (body.timezone !== undefined) update.timezone = String(body.timezone).slice(0, 60);
  if (body.status !== undefined) {
    update.status = body.status === "inactive" ? "inactive" : "active";
  }
  if (body.behavior !== undefined) update.behavior = sanitizeBehavior(body.behavior);
  if (body.triggers !== undefined) {
    update.triggers = Array.isArray(body.triggers)
      ? body.triggers.filter(Boolean).map(sanitizeTrigger)
      : [];
  }

  return update;
};

/**
 * Which WhatsApp number this request is about.
 * `null` = the primary number, so bots created before multi-account keep
 * belonging to it (and requests without the header keep working).
 */
const accountOf = (req) => req.waAccountId ?? null;

/** The account key — what the runtime and its caches are indexed by. */
const accountKeyOf = (req) =>
  req.waKey || `${requireOwner(req, {}) ?? req.user?.userId}`;

const findOwned = async (req, res) => {
  const userId = requireOwner(req, res);
  if (!userId) return null;

  const accountId = accountOf(req);
  const bot = await Bot.findOne({ _id: req.params.id, owner: userId, accountId }).lean();
  if (!bot) {
    res.status(404).json({ status: "error", message: "Bot not found" });
    return null;
  }

  return {
    userId,
    accountId,
    accountKey: buildWaKey(userId, accountId),
    bot,
  };
};

// ==================== CRUD ====================

export const listBotsController = async (req, res) => {
  try {
    const userId = requireOwner(req, res);
    if (!userId) return;

    const bots = await Bot.find({ owner: userId, accountId: accountOf(req) })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      status: "success",
      count: bots.length,
      data: bots,
    });
  } catch (err) {
    console.error("Error listing bots:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to list bots" });
  }
};

export const createBotController = async (req, res) => {
  try {
    const userId = requireOwner(req, res);
    if (!userId) return;

    const name = String(req.body?.name ?? "").trim().slice(0, MAX_BOT_NAME);
    if (!name) {
      return res
        .status(400)
        .json({ status: "error", message: "Bot name is required" });
    }

    const bot = await Bot.create({
      owner: userId,
      accountId: accountOf(req),
      name,
      ...buildUpdate(req.body),
      // `behavior` / `triggers` arrive with sensible schema defaults when omitted
    });

    invalidateBotCache(accountKeyOf(req));
    return res.status(201).json({ status: "success", data: bot });
  } catch (err) {
    console.error("Error creating bot:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to create bot" });
  }
};

export const getBotController = async (req, res) => {
  try {
    const found = await findOwned(req, res);
    if (!found) return;
    return res.status(200).json({ status: "success", data: found.bot });
  } catch (err) {
    console.error("Error getting bot:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to get bot" });
  }
};

export const updateBotController = async (req, res) => {
  try {
    const found = await findOwned(req, res);
    if (!found) return;

    const update = buildUpdate(req.body || {});
    if (update.name === "") {
      return res
        .status(400)
        .json({ status: "error", message: "Bot name is required" });
    }

    const bot = await Bot.findOneAndUpdate(
      { _id: found.bot._id, owner: found.userId },
      { $set: update },
      { new: true },
    ).lean();

    invalidateBotCache(found.accountKey);
    return res.status(200).json({ status: "success", data: bot });
  } catch (err) {
    console.error("Error updating bot:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to update bot" });
  }
};

export const deleteBotController = async (req, res) => {
  try {
    const userId = requireOwner(req, res);
    if (!userId) return;

    const result = await Bot.deleteOne({
      _id: req.params.id,
      owner: userId,
      accountId: accountOf(req),
    });
    invalidateBotCache(accountKeyOf(req));

    return res.status(200).json({
      status: "success",
      deleted: result.deletedCount > 0,
    });
  } catch (err) {
    console.error("Error deleting bot:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to delete bot" });
  }
};

export const duplicateBotController = async (req, res) => {
  try {
    const found = await findOwned(req, res);
    if (!found) return;

    const { _id, createdAt, updatedAt, ...rest } = found.bot;
    const copy = await Bot.create({
      ...rest,
      accountId: found.accountId,
      name: `${found.bot.name} (copy)`.slice(0, MAX_BOT_NAME),
      // A copy starts as a draft: not switched on anywhere, counters reset.
      status: "inactive",
      groups: [],
      stats: {},
    });

    invalidateBotCache(found.accountKey);
    return res.status(201).json({ status: "success", data: copy });
  } catch (err) {
    console.error("Error duplicating bot:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to duplicate bot" });
  }
};

export const setBotStatusController = async (req, res) => {
  try {
    const found = await findOwned(req, res);
    if (!found) return;

    const status = req.body?.status === "inactive" ? "inactive" : "active";
    const bot = await Bot.findOneAndUpdate(
      { _id: found.bot._id, owner: found.userId },
      { $set: { status } },
      { new: true },
    ).lean();

    invalidateBotCache(found.accountKey);
    return res.status(200).json({ status: "success", data: bot });
  } catch (err) {
    console.error("Error setting bot status:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to update bot status" });
  }
};

// ==================== GROUP ACTIVATION ====================

export const attachBotGroupController = async (req, res) => {
  try {
    const found = await findOwned(req, res);
    if (!found) return;

    const jid = String(req.body?.jid ?? "").trim();
    if (!jid.endsWith("@g.us")) {
      return res
        .status(400)
        .json({ status: "error", message: "A valid group id is required" });
    }

    const existing = found.bot.groups?.find((g) => g.jid === jid);
    const link = {
      jid,
      subject: String(req.body?.subject ?? existing?.subject ?? "").slice(0, 200),
      enabled: req.body?.enabled !== false,
      activatedAt: existing?.activatedAt || new Date(),
    };

    const groups = (found.bot.groups || []).filter((g) => g.jid !== jid);
    groups.push(link);

    const bot = await Bot.findOneAndUpdate(
      { _id: found.bot._id, owner: found.userId },
      { $set: { groups } },
      { new: true },
    ).lean();

    invalidateBotCache(found.accountKey, jid);
    return res.status(200).json({ status: "success", data: bot });
  } catch (err) {
    console.error("Error attaching bot to group:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to attach bot to group" });
  }
};

export const detachBotGroupController = async (req, res) => {
  try {
    const found = await findOwned(req, res);
    if (!found) return;

    const jid = String(req.params.jid ?? "").trim();
    const bot = await Bot.findOneAndUpdate(
      { _id: found.bot._id, owner: found.userId },
      { $pull: { groups: { jid } } },
      { new: true },
    ).lean();

    invalidateBotCache(found.accountKey, jid);
    return res.status(200).json({ status: "success", data: bot });
  } catch (err) {
    console.error("Error detaching bot from group:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to detach bot from group" });
  }
};

/** Which bots are live in this group (drives the group-level automation entry). */
export const groupBotsController = async (req, res) => {
  try {
    const userId = requireOwner(req, res);
    if (!userId) return;

    const jid = String(req.params.jid ?? "").trim();
    // Bots of THIS number only — each account has its own bot list.
    const bots = await getBotsForGroup(buildWaKey(userId, accountOf(req)), jid);

    const attached = (bots || []).map((b) => ({
      _id: b._id,
      name: b.name,
      emoji: b.emoji,
      status: b.status,
      triggers: (b.triggers || []).filter((t) => t.enabled).length,
      stats: b.stats || {},
    }));

    const others = await Bot.find({
      owner: userId,
      accountId: accountOf(req),
      groups: { $not: { $elemMatch: { jid, enabled: true } } },
    })
      .select("name emoji status")
      .lean();

    return res.status(200).json({
      status: "success",
      data: { attached, available: others },
    });
  } catch (err) {
    console.error("Error getting group bots:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to get bots for group" });
  }
};

// ==================== TEST CONSOLE ====================

export const simulateBotController = async (req, res) => {
  try {
    const found = await findOwned(req, res);
    if (!found) return;

    const text = String(req.body?.text ?? "");
    const senderName = String(req.body?.senderName ?? "Test user").slice(0, 60);
    const result = simulateBotMessage(found.bot, text, senderName);

    return res.status(200).json({ status: "success", data: result });
  } catch (err) {
    console.error("Error simulating bot:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to simulate bot" });
  }
};
