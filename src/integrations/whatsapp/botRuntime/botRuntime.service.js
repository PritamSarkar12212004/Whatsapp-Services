/**
 * Bot runtime — decides whether an incoming group message should be answered by
 * one of the bots attached to that group.
 *
 * Runs inside the group automation message handler, right before the legacy
 * per-group `auto_reply` rules: if a bot answers, the legacy rule is skipped so
 * a single message never gets two replies.
 *
 * Everything here is defensive: a broken trigger, a bad URL or a dead socket
 * must never take the WhatsApp session down.
 *
 * @see botRuntime.helpers.js (pure matching / payload building)
 */

import chalk from "chalk";
import Bot from "../../../models/whatsapp/bot.model.js";
import { parseWaKey } from "../../../utils/whatsapp/accountKey.js";
import {
  applyVars,
  pickTrigger,
  describeTrigger,
  withinWorkingHours,
  resolveDelayMs,
  buildReplyPayload,
  tagSender,
  mentionOptions,
  sendWithOptionsFallback,
} from "./botRuntime.helpers.js";

// ==================== STATE ====================

const botCache = new Map(); // `${userId}:${groupJid}` -> { bots, at }
const seenSenders = new Map(); // `${botId}:${groupJid}:${senderJid}` -> first seen ts
const cooldown = new Map(); // `${botId}:${triggerId}:${senderJid}` -> ts
const handoffSent = new Map(); // `${botId}:${senderJid}` -> ts

const CACHE_TTL_MS = 15000;
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const HANDOFF_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_DELAY_MS = 15000; // never hold the socket handler longer than this

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const prune = (map, ttl) => {
  const now = Date.now();
  for (const [key, ts] of map) {
    if (now - (ts?.at ?? ts) > ttl) map.delete(key);
  }
};

/**
 * Drop the cached bot list.
 *
 * @param {String} accountKey account key (use one of the raw parts to clear a
 *   whole login: `invalidateBotCache("<userId>")` and
 *   `invalidateBotCache("<userId>::<accountId>")` both match their own rows).
 */
export const invalidateBotCache = (accountKey, groupJid) => {
  if (!groupJid) {
    for (const key of botCache.keys()) {
      if (key.startsWith(`${accountKey}:`)) botCache.delete(key);
    }
    return;
  }
  botCache.delete(`${accountKey}:${groupJid}`);
};

/** Bots that are active AND switched on for this group, lowest priority first. */
/**
 * Bots watching one group.
 *
 * @param {String} accountKey WhatsApp account key (userId or userId::accountId)
 * @param {String} groupJid
 */
export const getBotsForGroup = async (accountKey, groupJid) => {
  const { userId, accountId } = parseWaKey(accountKey);
  const cacheKey = `${accountKey}:${groupJid}`;
  const hit = botCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bots;

  let bots = [];
  try {
    bots = await Bot.find({
      owner: userId,
      accountId,
      status: "active",
      groups: { $elemMatch: { jid: groupJid, enabled: true } },
    }).lean();
  } catch (err) {
    console.error(chalk.yellow(`[Bot] Lookup failed: ${err.message}`));
  }

  botCache.set(cacheKey, { bots, at: Date.now() });
  return bots;
};

/** First message from this sender for this bot (drives new/returning triggers). */
const noteSender = (botId, groupJid, senderJid) => {
  prune(seenSenders, SEEN_TTL_MS);
  const key = `${botId}:${groupJid}:${senderJid}`;
  const isFirst = !seenSenders.has(key);
  seenSenders.set(key, Date.now());
  return isFirst;
};

const bumpStats = async (botId, inc, extra = {}) => {
  try {
    await Bot.updateOne(
      { _id: botId },
      { $inc: inc, $set: { "stats.lastActiveAt": new Date(), ...extra } },
    );
  } catch (err) {
    console.error(chalk.yellow(`[Bot] Stats update failed: ${err.message}`));
  }
};

const send = async (sock, groupJid, payload, options) => {
  const result = await sendWithOptionsFallback(
    (jid, body, opts) => sock.sendMessage(jid, body, opts),
    groupJid,
    payload,
    options,
  );

  if (!result.sent) {
    console.error(chalk.yellow(`[Bot] Send failed: ${result.error}`));
  } else if (result.error) {
    console.warn(
      chalk.yellow(
        `[Bot] Tagging failed (${result.error}) — sent it without the tag instead` +
          ` [mentions=${(options?.mentions || []).join(",") || "-"}]`,
      ),
    );
  }

  return result.sent;
};

/** Best-effort presence + read receipt; failures are never fatal. */
const preSend = async (sock, groupJid, bot, msgKey) => {
  try {
    if (bot.behavior?.readMessages && msgKey) {
      await sock.readMessages([msgKey]);
    }
  } catch {
    /* ignore */
  }
  try {
    if (bot.behavior?.typingIndicator) {
      await sock.sendPresenceUpdate("composing", groupJid);
    }
  } catch {
    /* ignore */
  }
};

// ==================== MESSAGE HANDLING ====================

const botReplies = async (
  sock,
  bot,
  groupJid,
  senderName,
  trigger,
  text,
  senderJid,
) => {
  const vars = {
    name: senderName,
    message: text,
    bot: bot.name,
    group: bot.groups?.find((g) => g.jid === groupJid)?.subject || "",
    time: new Date().toLocaleTimeString(bot.language === "en" ? "en-IN" : "en-IN", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    date: new Date().toLocaleDateString("en-IN"),
  };

  const reply = applyVars(trigger.reply, vars);
  // Media URLs accept variables too, so one rule can send per-person files.
  const mediaUrl = trigger.mediaUrl ? applyVars(trigger.mediaUrl, vars) : null;

  // `mention` rules open the reply with @theirhandle so they read as tagged.
  const payload = buildReplyPayload(
    tagSender(reply, trigger.mention, senderJid),
    trigger.mediaType,
    mediaUrl,
  );
  const sent = await send(
    sock,
    groupJid,
    payload,
    mentionOptions(trigger.mention, senderJid),
  );

  if (sent) {
    const inc = { "stats.replied": 1 };
    try {
      await Bot.updateOne(
        { _id: bot._id, "triggers._id": trigger._id },
        { $inc: { ...inc, "triggers.$.hits": 1 } },
      );
      await Bot.updateOne(
        { _id: bot._id },
        { $set: { "stats.lastActiveAt": new Date() } },
      );
    } catch (err) {
      console.error(chalk.yellow(`[Bot] Counter update failed: ${err.message}`));
    }
  }

  return sent;
};

const runBot = async (sock, bot, ctx) => {
  const { groupJid, text, senderJid, senderName, msgKey, isPerson } = ctx;

  if (!bot.behavior?.autoReply) return false;

  // --- Working hours → away message (once per sender, not on every message) ---
  if (!withinWorkingHours(bot.behavior.workingHours)) {
    const away = String(bot.behavior.awayMessage || "").trim();
    const key = `${bot._id}:away:${senderJid}`;
    if (!away || Date.now() - (cooldown.get(key) || 0) < HANDOFF_COOLDOWN_MS) {
      return false;
    }
    cooldown.set(key, Date.now());
    const sent = await send(sock, groupJid, { text: applyVars(away, { name: senderName }) });
    if (sent) await bumpStats(bot._id, { "stats.replied": 1 });
    return sent;
  }

  if (!isPerson) return false;

  const isFirst = noteSender(String(bot._id), groupJid, senderJid);
  const trigger = pickTrigger(bot.triggers, text, {
    isFirstMessageFromSender: isFirst,
  });

  // --- Nothing matched ---
  if (!trigger) {
    const handoff = String(bot.behavior?.handoffMessage || "").trim();
    if (!bot.behavior?.humanHandoff || !handoff) return false;

    const key = `${bot._id}:${senderJid}`;
    if (Date.now() - (handoffSent.get(key) || 0) < HANDOFF_COOLDOWN_MS) return false;
    handoffSent.set(key, Date.now());

    const sent = await send(sock, groupJid, {
      text: applyVars(handoff, { name: senderName }),
    });
    if (sent) await bumpStats(bot._id, { "stats.handoffs": 1 });
    return sent;
  }

  // --- Cooldown so a chatty group doesn't get spammed ---
  const cdKey = `${bot._id}:${trigger._id}:${senderJid}`;
  const cooldownMs = Math.max(0, Number(trigger.cooldownSec) || 0) * 1000;
  if (cooldownMs && Date.now() - (cooldown.get(cdKey) || 0) < cooldownMs) {
    return false;
  }
  cooldown.set(cdKey, Date.now());

  await preSend(sock, groupJid, bot, msgKey);

  const delay = Math.min(MAX_DELAY_MS, resolveDelayMs(bot.behavior, trigger));
  if (delay) await sleep(delay);

  const replied = await botReplies(
    sock,
    bot,
    groupJid,
    senderName,
    trigger,
    text,
    senderJid,
  );

  if (replied) {
    await bumpStats(bot._id, { "stats.matched": 1 });
    console.log(
      chalk.cyan(
        `[Bot] ${bot.name} → ${describeTrigger(trigger)} in ${groupJid} (${senderName})`,
      ),
    );
  }

  // A matched trigger "owns" the message even if sending failed — otherwise the
  // legacy keyword rules would answer with a different text.
  return true;
};

/**
 * Run every bot attached to a group against one incoming message.
 *
 * @returns {Promise<Boolean>} true when a bot handled the message
 */
export const handleBotGroupMessage = async (sock, userId, ctx) => {
  try {
    const { groupJid, text, senderJid } = ctx;
    if (!groupJid || !senderJid || senderJid.endsWith("@g.us")) return false;

    const bots = await getBotsForGroup(userId, groupJid);
    if (!bots.length) return false;

    // Counters for "bot is watching this group"
    await Promise.all(
      bots.map((bot) => bumpStats(bot._id, { "stats.received": 1 })),
    );

    for (const bot of bots) {
      const handled = await runBot(sock, bot, { ...ctx, isPerson: true });
      if (handled) return true;
    }
    return false;
  } catch (err) {
    console.error(chalk.yellow(`[Bot] handleBotGroupMessage error: ${err.message}`));
    return false;
  }
};

/**
 * Welcome / goodbye for member joins and leaves.
 *
 * @param {Object} params { groupJid, memberJid, memberName, kind: "welcome"|"goodbye" }
 */
export const handleBotMemberEvent = async (sock, userId, params) => {
  try {
    const { groupJid, memberName, kind } = params;
    const bots = await getBotsForGroup(userId, groupJid);

    for (const bot of bots) {
      const template = String(bot.behavior?.[`${kind}Message`] || "").trim();
      if (!template) continue;

      const reply = applyVars(template, {
        name: memberName,
        bot: bot.name,
        group: bot.groups?.find((g) => g.jid === groupJid)?.subject || "",
      });

      if (await send(sock, groupJid, { text: reply })) {
        await bumpStats(bot._id, { "stats.replied": 1 });
      }
      return true; // first bot with a message wins — no duplicate welcomes
    }
    return false;
  } catch (err) {
    console.error(chalk.yellow(`[Bot] handleBotMemberEvent error: ${err.message}`));
    return false;
  }
};

/** Test console: which trigger would fire for this text, and what would go out. */
export const simulateBotMessage = (bot, text, senderName = "Test user") => {
  const isFirst = true;
  const trigger = pickTrigger(bot.triggers, text, {
    isFirstMessageFromSender: isFirst,
  });

  if (!trigger) {
    return {
      matched: false,
      trigger: null,
      reply: "",
      note: bot.behavior?.humanHandoff
        ? "No trigger matched — human handoff message would be sent."
        : "No trigger matched — the bot stays silent.",
    };
  }

  return {
    matched: true,
    trigger: {
      id: String(trigger._id ?? ""),
      name: trigger.name || trigger.type,
      type: trigger.type,
      value: trigger.value,
    },
    reply: applyVars(trigger.reply, { name: senderName, message: text, bot: bot.name }),
    mention: !!trigger.mention,
    mediaType: trigger.mediaType || "text",
    mediaUrl: trigger.mediaUrl || null,
    delayMs: resolveDelayMs(bot.behavior, trigger),
  };
};
