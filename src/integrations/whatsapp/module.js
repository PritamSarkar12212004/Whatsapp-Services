import { getSocket } from "./manager.js";
import { promiseTimeout } from "@whiskeysockets/baileys";

// If a send hangs (e.g. stalled socket), fail it instead of blocking the
// campaign/message queue worker forever.
const SEND_TIMEOUT_MS = parseInt(process.env.WHATSAPP_SEND_TIMEOUT_MS || "30000", 10);

/**
 * Send an OTP message using the system-level WhatsApp connection.
 * Used by the OTP authentication flow.
 */
const whatsappModule = async (client, number, otp, content) => {
  try {
    if (!number || !otp) {
      console.error("Number and OTP are required");
      return;
    }

    if (!client) {
      console.error("WhatsApp client not connected");
      return;
    }

    let phoneNumber = number.toString().replace(/\D/g, "");
    if (phoneNumber.length === 10) phoneNumber = `91${phoneNumber}`;
    else if (phoneNumber.length !== 12) {
      console.error(`Invalid phone number: ${number}`);
      return;
    }

    const chatId = `${phoneNumber}@s.whatsapp.net`;

    if (!client.user) {
      console.error("WhatsApp client is not authenticated");
      return;
    }

    const result = await client.sendMessage(chatId, {
      text: ` ${content}  OTP is: *${otp}*`,
    });

    console.log(`OTP sent successfully via WhatsApp. Message ID: ${result.key.id}`);
  } catch (err) {
    console.error(err, { phone: number, otp });
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
      console.error(`WhatsApp session not connected for user ${userId}`);
      return { success: false, error: "WhatsApp not connected" };
    }

    if (!client.user) {
      console.error(`WhatsApp session not authenticated for user ${userId}`);
      return { success: false, error: "WhatsApp not authenticated" };
    }

    let phoneNumber = number.toString().replace(/\D/g, "");
    if (phoneNumber.length === 10) phoneNumber = `91${phoneNumber}`;
    else if (phoneNumber.length !== 12) {
      console.error(`Invalid phone number: ${number}`);
      return { success: false, error: "Invalid phone number" };
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
    return { success: false, error: err.message };
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
      return { success: false, error: "WhatsApp not connected" };
    }
    if (!client.user) {
      return { success: false, error: "WhatsApp not authenticated" };
    }

    let phoneNumber = number.toString().replace(/\D/g, "");
    if (phoneNumber.length === 10) phoneNumber = `91${phoneNumber}`;
    else if (phoneNumber.length !== 12) {
      return { success: false, error: "Invalid phone number" };
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
    return { success: false, error: err.message };
  }
};

export default whatsappModule;