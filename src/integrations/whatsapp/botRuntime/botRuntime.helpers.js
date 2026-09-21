/**
 * Pure helpers for the bot runtime — no DB, no socket, no module state, so the
 * matching rules can be reasoned about (and tested) on their own.
 *
 * @see botRuntime.service.js (the engine that imports these)
 */

/** `{{name}}` and `{name}` are both accepted in replies. */
export const applyVars = (text, vars = {}) =>
  String(text ?? "").replace(/\{\{?(\w+)\}?\}/g, (whole, key) =>
    vars[key] === undefined || vars[key] === null ? whole : String(vars[key]),
  );

/** WhatsApp text is messy — trim, collapse spaces, lowercase unless asked not to. */
export const normalizeText = (text, caseSensitive = false) => {
  const t = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return caseSensitive ? t : t.toLowerCase();
};

/** `keyword` triggers hold a comma separated list of words. */
export const parseKeywordList = (value) =>
  String(value ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);

const safeRegex = (pattern, flags = "i") => {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null; // bad pattern → treated as "no match", never crashes the socket
  }
};

/**
 * Does a single trigger fire for this message?
 *
 * @param {Object} trigger  trigger sub-document
 * @param {String} text     raw incoming text
 * @param {Object} ctx      { isFirstMessageFromSender, isNewMember }
 */
export const triggerMatches = (trigger, text, ctx = {}) => {
  if (!trigger?.enabled) return false;

  const type = trigger.type || "contains";
  const cs = !!trigger.caseSensitive;
  const needle = normalizeText(trigger.value, cs);
  const haystack = normalizeText(text, cs);

  switch (type) {
    case "any":
      return true;

    case "exact":
      return !!needle && haystack === needle;

    case "contains":
      return !!needle && haystack.includes(needle);

    case "starts_with":
      return !!needle && haystack.startsWith(needle);

    case "ends_with":
      return !!needle && haystack.endsWith(needle);

    case "regex": {
      const re = safeRegex(trigger.value || "", cs ? "" : "i");
      return !!re && re.test(String(text ?? ""));
    }

    case "keyword":
      return parseKeywordList(trigger.value).some(
        (w) => !!w && haystack.includes(normalizeText(w, cs)),
      );

    case "command": {
      const cmd = normalizeText(trigger.value, cs).replace(/^[/!]/, "");
      return !!cmd && haystack.startsWith(`!${cmd}`);
    }

    case "new_member":
    case "new_customer":
      return !!ctx.isFirstMessageFromSender;

    case "returning_member":
    case "returning_customer":
      return !ctx.isFirstMessageFromSender;

    default:
      return false;
  }
};

/** Lower priority number = checked earlier (exact commands before catch-alls). */
export const sortTriggers = (triggers = []) =>
  [...triggers].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

/** First enabled trigger that fires, or null. */
export const pickTrigger = (triggers, text, ctx = {}) =>
  sortTriggers(triggers).find((t) => triggerMatches(t, text, ctx)) || null;

/** "09:30" → 570 minutes. Returns null for junk. */
export const minutesOfDay = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

/**
 * Inside the bot's working hours? Handles the common "overnight" window
 * (e.g. 21:00 → 06:00) by treating it as a wrap-around range.
 */
export const withinWorkingHours = (workingHours, now = new Date()) => {
  if (!workingHours?.enabled) return true;

  const days = Array.isArray(workingHours.days) ? workingHours.days : [];
  if (days.length && !days.includes(now.getDay())) return false;

  const start = minutesOfDay(workingHours.start);
  const end = minutesOfDay(workingHours.end);
  if (start === null || end === null) return true;

  const current = now.getHours() * 60 + now.getMinutes();
  return start <= end
    ? current >= start && current < end
    : current >= start || current < end; // overnight window
};

/** Reply delay = fixed + random jitter (both capped so a typo can't stall a queue). */
export const resolveDelayMs = (behavior = {}, trigger = null) => {
  const base = Number(trigger?.delayMs) || Number(behavior?.replyDelayMs) || 0;
  const jitterMax = Math.max(0, Number(behavior?.randomDelayMs) || 0);
  const jitter = jitterMax ? Math.floor(Math.random() * jitterMax) : 0;
  return Math.min(60000, Math.max(0, base + jitter));
};

/**
 * Build the Baileys payload for a trigger reply.
 * Location/contact need coordinates/a vCard, so they fall back to the text
 * reply instead of sending something broken.
 */
/**
 * The `@…` handle WhatsApp shows for a person — the user part of their jid.
 *
 * @param {String} jid e.g. 919999999999@s.whatsapp.net
 * @returns {String} e.g. 919999999999
 */
export const mentionHandle = (jid) =>
  String(jid ?? "")
    .split("@")[0]
    .split(":")[0]
    .trim();

/**
 * Prefix the reply with `@<handle>` so the person reads as tagged in the group.
 *
 * @param {String} text      reply text (variables already applied)
 * @param {Boolean} mention  is the rule's tag switch on
 * @param {String} senderJid the person who sent the matched message
 */
export const tagSender = (text, mention, senderJid) => {
  const body = String(text ?? "");
  const handle = mentionHandle(senderJid);
  if (!mention || !handle) return body;
  return `@${handle} ${body}`;
};

/**
 * Options for a reply: a rule can tag the sender so a busy group still shows
 * who the bot is answering.
 *
 * WhatsApp only turns `@<number>` into a real tag when the jid is listed in
 * `mentions` — the text prefix and this option always travel together.
 *
 * @returns {Object|undefined} third argument for sock.sendMessage
 */
export const mentionOptions = (mention, senderJid) => {
  if (!mention || !senderJid) return undefined;
  return { mentions: [senderJid] };
};

/**
 * Send a message; if the options variant fails (an unsupported tag jid, for
 * example) retry without them so the reply is never lost to silence.
 *
 * @param {Function} sendMessage async (jid, payload, options) => void
 * @returns {Promise<{ sent: boolean, withOptions: boolean, error: string|null }>}
 */
export const sendWithOptionsFallback = async (
  sendMessage,
  jid,
  payload,
  options,
) => {
  try {
    await sendMessage(jid, payload, options);
    return { sent: true, withOptions: !!options, error: null };
  } catch (err) {
    if (!options) {
      return { sent: false, withOptions: false, error: err.message };
    }

    // The tag failed — the message itself still matters more.
    try {
      await sendMessage(jid, payload);
      return { sent: true, withOptions: false, error: err.message };
    } catch (retryErr) {
      return { sent: false, withOptions: false, error: retryErr.message };
    }
  }
};

export const buildReplyPayload = (reply, mediaType = "text", mediaUrl = null) => {
  const text = String(reply ?? "");
  const url = mediaUrl ? String(mediaUrl) : null;

  if (!url || mediaType === "text") return { text };

  switch (mediaType) {
    case "image":
      return { image: { url }, caption: text };
    case "video":
      return { video: { url }, caption: text };
    case "audio":
      return { audio: { url }, mimetype: "audio/mp4" };
    case "document":
      return {
        document: { url },
        mimetype: "application/pdf",
        fileName: text || "document.pdf",
      };
    case "sticker":
      return { sticker: { url } };
    default:
      return { text };
  }
};

/** Human-ish log line for the trigger that fired. */
export const describeTrigger = (trigger) =>
  trigger
    ? `${trigger.name || trigger.type}${trigger.value ? `:"${trigger.value}"` : ""}`
    : "none";
