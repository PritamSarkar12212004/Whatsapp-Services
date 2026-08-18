import chalk from "chalk";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import groupManagerModel from "../../models/whatsapp/groupManager.model.js";
import groupWarningLogModel from "../../models/whatsapp/groupWarningLog.model.js";
import Template from "../../models/messaging/template.model.js";
import {
  getText,
  getMemberNumber,
  getMemberName,
  fillVars,
  enabledRules,
  deleteMessage,
  isUrl,
  pad,
  isScheduleDue,
} from "./groupAutomation/groupAutomation.helpers.js";

// See: ./groupAutomation/groupAutomation.helpers.js (text extraction, member
//   resolution, var fill, rule filtering, url detection, schedule matching)

// ==================== CONFIG / STATE ====================

const managerCache = new Map(); // `${userId}:${groupJid}` -> lean manager doc
const floodState = new Map(); // `${userId}:${groupJid}:${senderJid}` -> timestamps[]
const adminCache = new Map(); // `${userId}:${groupJid}` -> { admins:Set, at:number }

const FLOOD_WINDOW_MS = 10000;
const FLOOD_MAX_MESSAGES = 6;
const SCHEDULER_INTERVAL_MS = 30000;

// ==================== HELPERS ====================

const getManager = async (userId, groupJid) => {
  const key = `${userId}:${groupJid}`;
  if (managerCache.has(key)) return managerCache.get(key);
  const manager = await groupManagerModel
    .findOne({ userId, groupJid })
    .lean();
  managerCache.set(key, manager || null);
  return manager || null;
};

export const invalidateManagerCache = (userId, groupJid) => {
  managerCache.delete(`${userId}:${groupJid}`);
};

// ==================== MODERATION ====================

const handleViolation = async (
  sock,
  userId,
  manager,
  groupJid,
  senderJid,
  text,
  reason,
) => {
  try {
    const settings = manager.settings || {};
    const strikeLimit = Math.max(1, Number(settings.strikeLimit) || 3);
    const memberNumber = getMemberNumber(sock, senderJid);
    const memberName = getMemberName(sock, senderJid);

    const previous = await groupWarningLogModel.countDocuments({
      userId,
      groupJid,
      memberJid: senderJid,
    });
    const strikes = previous + 1;

    const warningMessage = fillVars(
      settings.warningMessage ||
        "⚠️ {name}, please follow the group rules. Warning {strikes}/{limit}.",
      { name: memberName, strikes, limit: strikeLimit },
    );

    await sock.sendMessage(groupJid, { text: warningMessage });

    // Auto-delete the offending message (only works when the bot is admin).
    try {
      if (settings.autoDelete && text) {
        const key = { remoteJid: groupJid, fromMe: true, id: `del-${Date.now()}` };
        // Delete by fetching the actual key is complex; simplest reliable path
        // is deleting via the message key captured in the upsert. We handle it
        // in processGroupMessage where the real key is available.
        void key;
      }
    } catch (_) {}

    await groupWarningLogModel.create({
      userId,
      groupJid,
      groupSubject: manager.groupSubject || "",
      memberJid: senderJid,
      memberName,
      memberNumber,
      reason,
      message: String(text || "").slice(0, 200),
      strikes,
      action: "warning",
    });

    console.log(
      chalk.yellow(
        `[Automation] Warning ${strikes}/${strikeLimit} for ${memberName} in ${groupJid} (${reason})`,
      ),
    );

    if (strikes >= strikeLimit) {
      try {
        await sock.groupParticipantsUpdate(groupJid, [senderJid], "remove");
        await groupWarningLogModel.create({
          userId,
          groupJid,
          groupSubject: manager.groupSubject || "",
          memberJid: senderJid,
          memberName,
          memberNumber,
          reason,
          message: "Auto-kicked after reaching strike limit",
          strikes,
          action: "kicked",
        });
        console.log(
          chalk.red(`[Automation] Kicked ${memberName} from ${groupJid}`),
        );
      } catch (err) {
        console.log(
          chalk.yellow(
            `[Automation] Kick failed for ${memberName}: ${err.message}`,
          ),
        );
      }
    }
  } catch (err) {
    console.error("[Automation] handleViolation error:", err.message);
  }
};

// ==================== COMMANDS ====================

const getAdmins = async (sock, userId, groupJid) => {
  const key = `${userId}:${groupJid}`;
  const cached = adminCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.admins;

  try {
    const meta = await sock.groupMetadata(groupJid);
    const admins = new Set(
      (meta.participants || [])
        .filter((p) => p.admin)
        .map((p) => jidNormalizedUser(p.id)),
    );
    adminCache.set(key, { admins, at: Date.now() });
    return admins;
  } catch (_) {
    return new Set();
  }
};

const handleCommand = async (
  sock,
  userId,
  manager,
  groupJid,
  text,
  senderJid,
) => {
  try {
    const commands = manager.commands || {};
    const parts = text.trim().split(/\s+/);
    const cmd = (parts[0] || "").toLowerCase();
    const args = parts.slice(1);

    if (cmd === "!rules") {
      if (commands.rulesText) {
        await sock.sendMessage(groupJid, { text: commands.rulesText });
      }
      return;
    }

    if (cmd === "!help") {
      if (commands.helpText) {
        await sock.sendMessage(groupJid, { text: commands.helpText });
      } else {
        await sock.sendMessage(groupJid, {
          text: "Available commands:\n!rules — group rules\n!help — this message\n!warn — your warning count\n!kick <number> — remove a member (admin only)",
        });
      }
      return;
    }

    if (cmd === "!warn") {
      const previous = await groupWarningLogModel.countDocuments({
        userId,
        groupJid,
        memberJid: senderJid,
      });
      const limit = Math.max(1, Number(manager.settings?.strikeLimit) || 3);
      await sock.sendMessage(groupJid, {
        text: `You have ${previous}/${limit} warnings.`,
      });
      return;
    }

    if (cmd === "!kick" && args.length > 0) {
      const admins = await getAdmins(sock, userId, groupJid);
      if (!admins.has(senderJid)) {
        await sock.sendMessage(groupJid, {
          text: "Only admins can use !kick.",
        });
        return;
      }

      const target = String(args[0]).replace(/[^\d]/g, "");
      if (!/^\d{10,15}$/.test(target)) {
        await sock.sendMessage(groupJid, {
          text: "Invalid number. Usage: !kick <phone number>",
        });
        return;
      }

      await sock.groupParticipantsUpdate(
        groupJid,
        [`${target}@s.whatsapp.net`],
        "remove",
      );
      await sock.sendMessage(groupJid, { text: `Kicked +${target}.` });
    }
  } catch (err) {
    console.error("[Automation] handleCommand error:", err.message);
  }
};

// ==================== MESSAGE PROCESSING ====================

const processGroupMessage = async (sock, userId, msg) => {
  try {
    const remoteJid = msg.key?.remoteJid || "";
    if (!remoteJid.endsWith("@g.us")) return;
    if (msg.key?.fromMe) return;

    const text = getText(msg);
    const senderJid = jidNormalizedUser(msg.key?.participant || msg.key?.remoteJid);

    const manager = await getManager(userId, remoteJid);
    if (!manager) return;

    // --- Commands ---
    if (manager.commands?.enabled && text.startsWith("!")) {
      await handleCommand(sock, userId, manager, remoteJid, text, senderJid);
      return;
    }

    if (!text) return;

    // --- Banned words ---
    const bannedRules = enabledRules(manager, "banned_words");
    if (bannedRules.length) {
      const lower = text.toLowerCase();
      const hit = bannedRules.some((r) =>
        String(r.value || "")
          .split(",")
          .map((w) => w.trim().toLowerCase())
          .filter(Boolean)
          .some((w) => lower.includes(w)),
      );
      if (hit) {
        await handleViolation(sock, userId, manager, remoteJid, senderJid, text, "banned_words");
        if (manager.settings?.autoDelete) await deleteMessage(sock, remoteJid, msg.key);
        return;
      }
    }

    // --- Anti-link ---
    const linkRules = enabledRules(manager, "anti_link");
    if (linkRules.length && isUrl(text)) {
      await handleViolation(sock, userId, manager, remoteJid, senderJid, text, "anti_link");
      if (manager.settings?.autoDelete) await deleteMessage(sock, remoteJid, msg.key);
      return;
    }

    // --- Anti-flood ---
    const floodRules = enabledRules(manager, "anti_flood");
    if (floodRules.length) {
      const key = `${userId}:${remoteJid}:${senderJid}`;
      const now = Date.now();
      const times = (floodState.get(key) || []).filter(
        (t) => now - t < FLOOD_WINDOW_MS,
      );
      times.push(now);
      floodState.set(key, times);
      if (times.length > FLOOD_MAX_MESSAGES) {
        floodState.set(key, [now]);
        await handleViolation(sock, userId, manager, remoteJid, senderJid, text, "anti_flood");
        return;
      }
    }

    // --- Auto-reply (keyword) ---
    const replyRules = enabledRules(manager, "auto_reply");
    for (const rule of replyRules) {
      const trigger = String(rule.trigger || "").trim().toLowerCase();
      if (trigger && text.toLowerCase().includes(trigger)) {
        await sock.sendMessage(remoteJid, { text: rule.value });
        break;
      }
    }
  } catch (err) {
    console.error("[Automation] processGroupMessage error:", err.message);
  }
};

// ==================== MEMBER EVENTS ====================

const handleParticipantsUpdate = async (sock, userId, update) => {
  try {
    const groupJid = update.id || "";
    if (!groupJid.endsWith("@g.us")) return;

    const manager = await getManager(userId, groupJid);
    if (!manager) return;

    for (const p of update.participants || []) {
      const memberJid = jidNormalizedUser(p.id);
      const memberName = getMemberName(sock, memberJid);

      if (p.add) {
        const welcomeRules = enabledRules(manager, "welcome");
        if (welcomeRules.length) {
          await sock.sendMessage(groupJid, {
            text: fillVars(welcomeRules[0].value, { name: memberName }),
          });
        }
      } else if (p.remove) {
        const goodbyeRules = enabledRules(manager, "goodbye");
        if (goodbyeRules.length) {
          await sock.sendMessage(groupJid, {
            text: fillVars(goodbyeRules[0].value, { name: memberName }),
          });
        }
      }
    }
  } catch (err) {
    console.error("[Automation] handleParticipantsUpdate error:", err.message);
  }
};

// ==================== SCHEDULER ====================
// TODO(automation): extract runDueSchedules + startAutomationScheduler into
//   ./groupAutomation/groupAutomation.scheduler.js (needs a non-circular way
//   to reach invalidateManagerCache first).

const runDueSchedules = async () => {
  try {
    const now = new Date();
    const managers = await groupManagerModel
      .find({ "schedules.enabled": true })
      .lean();

    for (const manager of managers) {
      const due = (manager.schedules || []).filter((s) => isScheduleDue(s, now));
      if (!due.length) continue;

      // Lazy import to avoid a circular dependency at module init.
      const { getSocket } = await import("./manager.js");
      const sock = getSocket(manager.userId.toString());
      if (!sock) continue;

      for (const schedule of due) {
        try {
          let message = schedule.message || "";
          if (schedule.templateId) {
            const template = await Template.findById(schedule.templateId).lean();
            if (template) message = template.content || "";
          }

          if (!message) {
            console.log(
              chalk.yellow(`[Automation] Empty message for schedule ${schedule.name}`),
            );
            continue;
          }

          await sock.sendMessage(manager.groupJid, { text: message });

          const update = { "schedules.$.lastRunAt": new Date() };
          if (schedule.type === "once") update["schedules.$.enabled"] = false;
          await groupManagerModel.updateOne(
            { _id: manager._id, "schedules._id": schedule._id },
            { $set: update },
          );

          console.log(
            chalk.green(
              `[Automation] Sent scheduled message "${schedule.name}" to ${manager.groupJid}`,
            ),
          );
        } catch (err) {
          console.error(
            `[Automation] Schedule "${schedule.name}" failed:`,
            err.message,
          );
        }
      }

      invalidateManagerCache(manager.userId.toString(), manager.groupJid);
    }
  } catch (err) {
    console.error("[Automation] runDueSchedules error:", err.message);
  }
};

let schedulerTimer = null;

export const startAutomationScheduler = () => {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(runDueSchedules, SCHEDULER_INTERVAL_MS);
  console.log(
    chalk.cyan(
      `[Automation] Scheduler started (every ${SCHEDULER_INTERVAL_MS / 1000}s)`,
    ),
  );
};

// ==================== SETUP ====================

export const setupGroupAutomation = (sock, userId) => {
  if (!sock || !userId) return;

  sock.ev.on("messages.upsert", async (m) => {
    const msgs = m.messages || [];
    for (const msg of msgs) {
      if (msg.key?.remoteJid?.endsWith("@g.us")) {
        await processGroupMessage(sock, userId, msg);
      }
    }
  });

  sock.ev.on("participants.update", async (update) => {
    await handleParticipantsUpdate(sock, userId, update);
  });

  console.log(
    chalk.cyan(`[Automation] Listeners active for user ${userId}`),
  );
};
