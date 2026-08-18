import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Browsers } from "@whiskeysockets/baileys/lib/Utils/browser-utils.js";
import qrcode from "qrcode-terminal";
import path from "path";
import chalk from "chalk";
import clearAuthState from "./clearAuthState.js";
import whatsappConnectionLog from "../../logs/connections/whatsappConnectionLog.js";

let sock = null;
let retryCount = 0;
let reconnecting = false;
let initializationPromise = null;
const MAX_RETRIES = 5;

const AUTH_FOLDER = path.join(
  path.resolve(),
  "src/whatsapp/auth_info_baileys",
);

/**
 * System-level WhatsApp connection used for sending authentication OTPs.
 * Uses a singleton pattern to guarantee ONLY ONE socket.
 */
const whatsappConnect = async () => {
  // Socket already exists (connecting or connected) → reuse
  if (sock) {
    console.log(
      chalk.green("[Baileys] Connection already active, reusing existing socket"),
    );
    return sock;
  }

  // Already initializing → wait for existing connection
  if (initializationPromise) {
    console.log(
      chalk.yellow(
        "[Baileys] Connection already initializing, waiting for existing connection",
      ),
    );
    return initializationPromise;
  }

  // Set initialization promise to prevent concurrent init
  initializationPromise = initializeSocket();

  try {
    return await initializationPromise;
  } finally {
    initializationPromise = null;
  }
};

const initializeSocket = async () => {
  // Clean up old socket if exists
  if (sock) {
    try {
      sock.end();
    } catch (_) {}
    sock = null;
  }

  console.log(chalk.cyan("[Baileys] Initializing WhatsApp connection..."));

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  let version;

  try {
    const { version: fetchedVersion } = await fetchLatestBaileysVersion();
    version = fetchedVersion;
    console.log(
      chalk.cyan(
        whatsappConnectionLog.CONNECTION.VERSION_USED(version.join(".")),
      ),
    );
  } catch (err) {
    console.log(
      chalk.yellow(whatsappConnectionLog.WARNING.VERSION_FETCH_FAILED),
    );
  }

  sock = makeWASocket({
    auth: state,
    browser: Browsers.windows("Chrome"),
    ...(version && { version }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      retryCount = 0;
      console.log(chalk.cyan(whatsappConnectionLog.CONNECTION.QR_INFO_BORDER));
      console.log(chalk.cyan(whatsappConnectionLog.CONNECTION.QR_GENERATED));
      console.log(chalk.cyan(whatsappConnectionLog.CONNECTION.QR_INFO_BORDER));
      qrcode.generate(qr, { small: true });
      console.log(
        chalk.cyan(whatsappConnectionLog.CONNECTION.QR_INFO_BORDER + "\n"),
      );
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      console.log(
        chalk.red(whatsappConnectionLog.CONNECTION.CONNECTION_CLOSED),
      );
      console.log(
        chalk.yellow(
          whatsappConnectionLog.CONNECTION.DISCONNECT_REASON(statusCode),
        ),
      );

      // Permanent logout → clean up, do NOT reconnect
      if (statusCode === DisconnectReason.loggedOut) {
        console.log(chalk.red(whatsappConnectionLog.WARNING.AUTH_REJECTED));
        clearAuthState();
        sock = null;
        retryCount = 0;
        reconnecting = false;
        return;
      }

      // Conflict / replaced (440) → prevent duplicate socket creation
      if (statusCode === 440) {
        console.log(
          chalk.yellow(
            "[Baileys] Conflict detected - preventing duplicate socket creation",
          ),
        );
        sock = null;
        retryCount = 0;
        reconnecting = false;
        return;
      }

      if (statusCode === 405 || statusCode === 401) {
        console.log(chalk.red(whatsappConnectionLog.WARNING.AUTH_REJECTED));
        clearAuthState();
        sock = null;
        retryCount = 0;
        reconnecting = false;
        return;
      }

      // Temporary disconnects → controlled reconnect
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== DisconnectReason.multideviceMismatch;

      if (shouldReconnect && retryCount < MAX_RETRIES && !reconnecting) {
        reconnecting = true;
        retryCount++;
        const delay = Math.min(3000 * (retryCount + 1), 15000);
        console.log(
          chalk.blue(
            whatsappConnectionLog.CONNECTION.RECONNECTING(
              retryCount,
              MAX_RETRIES,
            ),
          ),
        );
        setTimeout(() => {
          reconnecting = false;
          sock = null;
          whatsappConnect();
        }, delay);
      } else if (retryCount >= MAX_RETRIES) {
        console.log(chalk.red(whatsappConnectionLog.CONNECTION.MAX_RETRIES));
        sock = null;
        retryCount = 0;
        reconnecting = false;
      }
    } else if (connection === "open") {
      retryCount = 0;
      reconnecting = false;
      const phone = sock.user?.id?.split(":")[0] || "Unknown";
      const userId = sock.user?.id || "Unknown";
      console.log(
        chalk.green(
          whatsappConnectionLog.CONNECTION.CONNECTION_SUCCESS(phone, userId),
        ),
      );
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;
    const sender = msg.key.remoteJid?.split("@")[0] || "Unknown";
    const messageType = Object.keys(msg.message)[0] || "Unknown";

    console.log(chalk.magenta(whatsappConnectionLog.MESSAGE.RECEIVED));
    console.log(chalk.white(`From: ${sender}`));
    console.log(chalk.white(`Type: ${messageType}`));
  });

  return sock;
};

export const getClient = () => sock;
export default whatsappConnect;