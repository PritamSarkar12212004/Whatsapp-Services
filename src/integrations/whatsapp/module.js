import { getSocket, getSocketInfo } from "./manager.js";
import { restartConnection } from "./connection.js";
import { promiseTimeout } from "@whiskeysockets/baileys";

// If a send hangs (e.g. stalled socket), fail it instead of blocking the
// campaign/message queue worker forever.
const SEND_TIMEOUT_MS = parseInt(process.env.WHATSAPP_SEND_TIMEOUT_MS || "30000", 10);

/**
 * Why a send failed — callers (the queue worker) need to tell a PERMANENT
 * failure (the number is not on WhatsApp, the message was rejected) from a
 * TRANSIENT one (the owner's socket is not up right now). A transient failure
 * must NOT consume a job's retries: the socket coming back a minute later is
 * the normal case after a restart / free-plan spin-down / reconnect, and a
 * few fast retries would permanently fail an otherwise deliverable OTP.
 */
export const SEND_ERROR = {
  NOT_CONNECTED: "not_connected",
  NOT_AUTHENTICATED: "not_authenticated",
  INVALID_NUMBER: "invalid_number",
  SEND_FAILED: "send_failed",
};

/** Transient reasons — the same send can succeed once the session is online. */
export const TRANSIENT_SEND_ERRORS = new Set([
  SEND_ERROR.NOT_CONNECTED,
  SEND_ERROR.NOT_AUTHENTICATED,
]);

const logSocketLookup = (ownerKey, client) => {
  const info = getSocketInfo(ownerKey);
  console.warn(
    "[WhatsApp Send] Session lookup unavailable",
    JSON.stringify({
      ...info,
      socketExists: Boolean(client),
    }),
  );
};

/**
 * Send an OTP message using the system-level WhatsApp connection.
 * Used by the OTP authentication flow.
 *
 * Returns a result object instead of swallowing failures: the controller must
 * never tell the user "OTP sent" when the gateway was dead. A failed/timed-out
 * send also restarts the gateway socket, because that is the symptom of a
 * half-open connection that would otherwise stay broken until a process
 * restart.
 */
const whatsappModule = async (client, number, otp, content) => {
  if (!number || !otp) {
    return { success: false, error: "Number and OTP are required", code: SEND_ERROR.INVALID_NUMBER };
  }

  if (!client || !client.user) {
    return {
      success: false,
      error: "WhatsApp gateway is not connected",
      code: SEND_ERROR.NOT_CONNECTED,
    };
  }

  let phoneNumber = number.toString().replace(/\D/g, "");
  if (phoneNumber.length === 10) phoneNumber = `91${phoneNumber}`;
  else if (phoneNumber.length !== 12) {
    return {
      success: false,
      error: "Invalid phone number",
      code: SEND_ERROR.INVALID_NUMBER,
    };
  }

  const chatId = `${phoneNumber}@s.whatsapp.net`;

  try {
    const result = await promiseTimeout(SEND_TIMEOUT_MS, (resolve, reject) => {
      client
        .sendMessage(chatId, { text: ` ${content}  OTP is: *${otp}*` })
        .then(resolve)
        .catch(reject);
    });

    console.log(
      `OTP sent successfully via WhatsApp. Message ID: ${result.key.id}`,
    );
    return { success: true, messageId: result.key.id };
  } catch (err) {
    // Never log the OTP itself.
    console.error(`[OTP] send failed for ${phoneNumber}:`, err.message);
    // A timeout / closed ws means the socket is half-dead: rebuild it so the
    // next request does not fail too.
    restartConnection(`OTP send failed: ${err.message}`);
    return {
      success: false,
      error: "Could not send OTP on WhatsApp",
      code: SEND_ERROR.SEND_FAILED,
    };
  }
};

/**
 * Send a message using a specific user's WhatsApp session.
 * The userId determines which socket is used.
 */
export const sendUserMessage = async (userId, number, message) => {
  try {
    if (!userId || !number || !message) {
      console.error("userId, number, and message are required");
      return { success: false, error: "Missing required parameters" };
    }

    const client = getSocket(userId);

    if (!client) {
      logSocketLookup(userId, client);
      return {
        success: false,
        error: "WhatsApp not connected",
        code: SEND_ERROR.NOT_CONNECTED,
      };
    }

    if (!client.user) {
      logSocketLookup(userId, client);
      return {
        success: false,
        error: "WhatsApp not authenticated",
        code: SEND_ERROR.NOT_AUTHENTICATED,
      };
    }

    let phoneNumber = number.toString().replace(/\D/g, "");
    if (phoneNumber.length === 10) phoneNumber = `91${phoneNumber}`;
    else if (phoneNumber.length !== 12) {
      console.error(`Invalid phone number: ${number}`);
      return {
        success: false,
        error: "Invalid phone number",
        code: SEND_ERROR.INVALID_NUMBER,
      };
    }

    const chatId = `${phoneNumber}@s.whatsapp.net`;

    const result = await promiseTimeout(SEND_TIMEOUT_MS, (resolve, reject) => {
      client.sendMessage(chatId, { text: message }).then(resolve).catch(reject);
    });

    console.log(
      `Message sent via user ${userId}'s WhatsApp. Message ID: ${result.key.id}`,
    );
    return { success: true, messageId: result.key.id };
  } catch (err) {
    console.error(err, { userId, phone: number });
    return { success: false, error: err.message, code: SEND_ERROR.SEND_FAILED };
  }
};

/**
 * Guess a document MIME type from a filename when none is provided.
 */
const mimeFromFilename = (filename = "") => {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const map = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    zip: "application/zip",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[ext] || "application/octet-stream";
};

/**
 * Send a message with optional media (image / video / audio / document)
 * in WhatsApp's native format. `type` = text | image | video | audio |
 * document. `media` = { url, filename, mimeType, caption }.
 * Text messages containing links get WhatsApp's automatic link preview.
 */
export const sendUserMediaMessage = async (userId, number, opts = {}) => {
  const { text = "", type = "text", media = null } = opts;
  try {
    if (!userId || !number) {
      return { success: false, error: "Missing required parameters" };
    }

    const client = getSocket(userId);
    if (!client) {
      logSocketLookup(userId, client);
      return {
        success: false,
        error: "WhatsApp not connected",
        code: SEND_ERROR.NOT_CONNECTED,
      };
    }
    if (!client.user) {
      logSocketLookup(userId, client);
      return {
        success: false,
        error: "WhatsApp not authenticated",
        code: SEND_ERROR.NOT_AUTHENTICATED,
      };
    }

    let phoneNumber = number.toString().replace(/\D/g, "");
    if (phoneNumber.length === 10) phoneNumber = `91${phoneNumber}`;
    else if (phoneNumber.length !== 12) {
      return {
        success: false,
        error: "Invalid phone number",
        code: SEND_ERROR.INVALID_NUMBER,
      };
    }
    const chatId = `${phoneNumber}@s.whatsapp.net`;

    const result = await promiseTimeout(SEND_TIMEOUT_MS, (resolve, reject) => {
      let sendPromise;
      switch (type) {
        case "image":
          sendPromise = client.sendMessage(chatId, {
            image: { url: media?.url },
            caption: text || "",
          });
          break;
        case "video":
          sendPromise = client.sendMessage(chatId, {
            video: { url: media?.url },
            caption: text || "",
            mimetype: media?.mimeType || "video/mp4",
          });
          break;
        case "audio":
          sendPromise = client.sendMessage(chatId, {
            audio: { url: media?.url },
            mimetype: media?.mimeType || "audio/mp4",
            ptt: false,
          });
          break;
        case "document":
          sendPromise = client.sendMessage(chatId, {
            document: { url: media?.url },
            fileName: media?.filename || "file",
            mimetype:
              media?.mimeType || mimeFromFilename(media?.filename),
            caption: text || "",
          });
          break;
        default:
          // Plain text — WhatsApp attaches link previews automatically for
          // URLs inside the text.
          sendPromise = client.sendMessage(chatId, { text });
      }
      sendPromise.then(resolve).catch(reject);
    });

    console.log(
      `Message (${type}) sent via user ${userId}'s WhatsApp. Message ID: ${result.key.id}`,
    );
    return { success: true, messageId: result.key.id };
  } catch (err) {
    console.error(err, { userId, phone: number, type });
    return { success: false, error: err.message, code: SEND_ERROR.SEND_FAILED };
  }
};

export default whatsappModule;
