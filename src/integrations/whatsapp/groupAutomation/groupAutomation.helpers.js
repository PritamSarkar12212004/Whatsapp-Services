/**
 * Pure helpers for the group automation engine.
 * No module state — safe to import from anywhere.
 *
 * @see groupAutomation.service.js (main engine that imports these)
 */

import chalk from "chalk";

/** Extract the plain text from any Baileys message payload. */
export const getText = (msg) => {
  if (!msg?.message) return "";
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.audioMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  );
};

/** Resolve the raw phone digits for a member JID (null if not a number). */
export const getMemberNumber = (sock, jid) => {
  const contact = sock.contacts?.[jid];
  const pn = contact?.phoneNumber || jid;
  const num = String(pn).split("@")[0];
  return /^\d+$/.test(num) ? num : null;
};

/** Best available display name for a member (saved name > pushName > number). */
export const getMemberName = (sock, jid) => {
  const contact = sock.contacts?.[jid];
  return (
    contact?.name ||
    contact?.verifiedName ||
    contact?.notify ||
    getMemberNumber(sock, jid) ||
    "Member"
  );
};

/** Replace {var} placeholders; unknown keys stay untouched. */
export const fillVars = (template, vars) =>
  String(template || "").replace(
    /\{(\w+)\}/g,
    (_, key) => vars[key] ?? `{${key}}`,
  );

/** Enabled rules of a given type from a manager document. */
export const enabledRules = (manager, type) =>
  (manager.rules || []).filter((r) => r.type === type && r.enabled);

/** Delete a message in a group (no-op when the key is missing). */
export const deleteMessage = async (sock, groupJid, msgKey) => {
  try {
    if (!msgKey) return;
    await sock.sendMessage(groupJid, { delete: msgKey });
  } catch (err) {
    console.log(chalk.yellow(`[Automation] Delete failed: ${err.message}`));
  }
};

/** True when the text contains a http(s) or www link. */
export const isUrl = (text) => /(https?:\/\/|www\.)[^\s]+/i.test(text);

/** Zero-pad a number to two digits (time formatting). */
export const pad = (n) => String(n).padStart(2, "0");

/**
 * Decide whether a schedule should fire at `now`.
 * Handles once / daily / weekly types with a lastRunAt guard.
 */
export const isScheduleDue = (schedule, now) => {
  if (!schedule.enabled) return false;
  const currentTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const ranToday =
    schedule.lastRunAt &&
    new Date(schedule.lastRunAt).toDateString() === now.toDateString();

  if (schedule.type === "once") {
    if (schedule.lastRunAt || !schedule.date) return false;
    return new Date(schedule.date) <= now;
  }

  if (ranToday) return false;
  if (currentTime !== (schedule.time || "09:00")) return false;

  if (schedule.type === "weekly") {
    const days = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
    return days.includes(now.getDay());
  }

  return true; // daily
};
