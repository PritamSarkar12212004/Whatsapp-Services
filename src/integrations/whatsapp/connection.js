import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Browsers } from "@whiskeysockets/baileys/lib/Utils/browser-utils.js";
import qrcode from "qrcode-terminal";
import chalk from "chalk";
import clearAuthState from "./clearAuthState.js";
import { useMongoAuthState, SYSTEM_OWNER_KEY } from "./authState.js";
import whatsappConnectionLog from "../../logs/connections/whatsappConnectionLog.js";

let sock = null;
let retryCount = 0;
let reconnecting = false;
let initializationPromise = null;
const MAX_RETRIES = 5;

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

  // Auth state lives in MongoDB (see ./authState.js) so the OTP gateway
  // session survives container restarts / redeploys / free-plan spin-downs.
  const { state, saveCreds } = await useMongoAuthState(SYSTEM_OWNER_KEY);
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
        await clearAuthState();
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

      // Baileys treats 401/403/419 as unrecoverable auth failures
      // (UNAUTHORIZED_CODES). 401 is already handled above as loggedOut, so
      // this adds 403.
      //
      // NOTE: this branch used to also match 405. 405 is NOT a WhatsApp auth
      // code — it is a transient stream/handshake error — so a single 405 used
      // to delete the credentials and force an unnecessary QR scan. It now
      // falls through to the normal retry path below.
      if (statusCode === 403 || statusCode === 419) {
        console.log(chalk.red(whatsappConnectionLog.WARNING.AUTH_REJECTED));
        await clearAuthState();
        sock = null;
        retryCount = 0;
        reconnecting = false;
        return;
      }

      if (statusCode === 405) {
        console.log(
          chalk.yellow(
            "[Baileys] Stream error 405 — treating as transient, retrying",
          ),
        );
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

/**
 * Gracefully end the system (OTP gateway) socket on process shutdown.
 * The close handler is suppressed so no reconnect is scheduled while exiting.
 */
export const closeClient = () => {
  if (sock) {
    try {
      sock.end();
    } catch (_) {
      /* socket already gone */
    }
    sock = null;
  }
  reconnecting = true; // block the close handler from scheduling a reconnect
};

export default whatsappConnect;