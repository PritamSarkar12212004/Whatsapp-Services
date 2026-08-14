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
import whatsappConnectionLog from "../logs/connections/whatsappConnectionLog.js";

let sock = null;
let retryCount = 0;
const MAX_RETRIES = 5;

const AUTH_FOLDER = path.join(
  path.resolve(),
  "src/whatsapp/auth_info_baileys",
);

const whatsappConnect = async () => {
  if (sock) {
    try {
      sock.end();
    } catch (_) {}
    sock = null;
  }

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
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        chalk.red(whatsappConnectionLog.CONNECTION.CONNECTION_CLOSED),
      );
      console.log(
        chalk.yellow(
          whatsappConnectionLog.CONNECTION.DISCONNECT_REASON(statusCode),
        ),
      );
      console.log(
        chalk.yellow(
          whatsappConnectionLog.CONNECTION.RETRY_COUNT(retryCount, MAX_RETRIES),
        ),
      );

      if (statusCode === 405 || statusCode === 401) {
        console.log(chalk.red(whatsappConnectionLog.WARNING.AUTH_REJECTED));
        clearAuthState();
      }

      if (shouldReconnect && retryCount < MAX_RETRIES) {
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
        setTimeout(() => whatsappConnect(), delay);
      } else if (retryCount >= MAX_RETRIES) {
        console.log(chalk.red(whatsappConnectionLog.CONNECTION.MAX_RETRIES));
      }
    } else if (connection === "open") {
      retryCount = 0;
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