import { createLogger, baileysLogger } from "../../logs/logger.js";

const log = createLogger("wa.gateway");

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

/**
 * System-level WhatsApp connection used for sending authentication OTPs.
 * Uses a singleton pattern to guarantee ONLY ONE socket.
 *
 * RELIABILITY MODEL
 * -----------------
 * This socket is the single point of failure for OTP delivery, and it has no
 * user interface: nobody notices it died until an OTP never arrives. It used
 * to give up after MAX_RETRIES disconnects, give up on a 440 conflict and
 * hang forever on a stalled `fetchLatestBaileysVersion()` — each of those
 * left a healthy HTTP server with a dead gateway, so the only recovery was
 * restarting the whole VPS.
 *
 * It now:
 *   - reconnects forever with capped exponential backoff (reset on "open"),
 *   - watches for silently dead sockets (no close event, closed ws, stuck
 *     "connecting", stalled init) and rebuilds them,
 *   - exposes its real state so /health reports the gateway honestly,
 *   - can be woken on demand (`ensureConnected`) by the OTP request itself.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sock = null;
/** disconnected | connecting | qr_required | connected | auth_required | error */
let status = "disconnected";
let retryCount = 0;
let reconnecting = false;
let reconnectTimer = null;
let initializationPromise = null;
let initStartedAt = null;
let qr = null;
let connectingSince = null;
let connectedSince = null;
let lastConnectedAt = null;
let lastDisconnectedAt = null;
let lastError = null;
let shuttingDown = false;

/**
 * Incremented whenever the current socket is torn down so an in-flight
 * initialize() cannot install a socket that has already been superseded.
 */
let generation = 0;

// Reconnect tuning. There is deliberately no "give up" state: WhatsApp
// disconnects are routine and the gateway must recover on its own.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
const INIT_TIMEOUT_MS = 60000;
const CONNECTING_TIMEOUT_MS = 60000;
const WATCHDOG_INTERVAL_MS = 30000;
const RESTART_DEBOUNCE_MS = 10000;

let watchdogTimer = null;
let lastRestartAt = 0;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve/reject a promise that must not hang forever. */
const withTimeout = (ms, promise, label) =>
  Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
      t.unref?.();
    }),
  ]);

/** A socket is usable only when WhatsApp accepted the session AND ws is open. */
const isSocketLive = (socket) =>
  Boolean(socket && socket.user && socket.ws?.isOpen !== false && socket.ws);

const isLive = () => isSocketLive(sock) && status === "connected";

// ---------------------------------------------------------------------------
// Reconnect scheduling
// ---------------------------------------------------------------------------

const nextBackoffMs = () => {
  const exp = Math.min(retryCount, 6);
  const base = Math.min(RECONNECT_BASE_MS * 2 ** exp, RECONNECT_MAX_MS);
  // Jitter so many sessions (and restarts) do not retry in lockstep.
  return base + Math.floor(Math.random() * 1000);
};

const scheduleReconnect = (reason) => {
  // `initializationPromise` is deliberately NOT part of this guard: an init
  // that fails (auth-state/Mongo error, thrown makeWASocket) reports here
  // while its own promise is still settling, and skipping the retry used to
  // leave the gateway dead until the watchdog's next 30s tick.
  if (shuttingDown || reconnecting || reconnectTimer) return;

  reconnecting = true;
  retryCount += 1;
  const delay = nextBackoffMs();
  lastError = reason;

  log.info(
    chalk.blue(
      `[Baileys][system] Reconnecting in ${Math.round(delay / 1000)}s ` +
        `(attempt ${retryCount}: ${reason})`,
    ),
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnecting = false;
    whatsappConnect().catch((err) => {
      log.error(
        `[Baileys][system] reconnect attempt failed: ${err.message}`,
      );
    });
  }, delay);

  // Never keep the process alive just for this timer.
  reconnectTimer.unref?.();
};

/**
 * Tear the current socket down and immediately build a new one.
 * Debounced, because a burst of failed OTPs must not create a socket storm.
 */
const restartConnection = (reason) => {
  if (shuttingDown) return null;

  const now = Date.now();
  if (now - lastRestartAt < RESTART_DEBOUNCE_MS) {
    log.info(
      chalk.yellow(
        `[Baileys][system] Restart requested (${reason}) — already restarting, skipping`,
      ),
    );
    if (initializationPromise) {
      return initializationPromise.catch(() => null);
    }
    return sock;
  }
  lastRestartAt = now;

  log.warn(chalk.yellow(`[Baileys][system] Restarting socket: ${reason}`));

  generation += 1;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnecting = false;
  initStartedAt = null;
  // Drop the stale init promise so a hung initialize() cannot block the new
  // one; the old run bails out on its generation check.
  initializationPromise = null;

  if (sock) {
    try {
      sock.end(undefined);
    } catch (_) {
      /* socket already gone */
    }
    sock = null;
  }

  qr = null;
  connectingSince = null;
  connectedSince = null;
  status = "disconnected";
  lastError = reason;

  ensureWatchdog();
  return whatsappConnect().catch((err) => {
    log.error(
      `[Baileys][system] restart failed: ${err.message}`,
    );
    return null;
  });
};

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

const watchdogTick = () => {
  if (shuttingDown) return;

  // Waiting for a human to re-pair: leave it alone.
  if (status === "auth_required") return;

  // A QR socket that lost its websocket will never emit a code again —
  // rebuild it so a fresh QR can be scanned.
  if (status === "qr_required") {
    if (sock && sock.ws?.isOpen === false) {
      restartConnection("QR socket closed");
    }
    return;
  }

  if (initializationPromise) {
    if (initStartedAt && Date.now() - initStartedAt > INIT_TIMEOUT_MS) {
      restartConnection("initialization stalled");
    }
    return;
  }

  if (reconnectTimer || reconnecting) return;

  if (!sock) {
    scheduleReconnect("no active socket");
    return;
  }

  if (status === "connected") {
    // A socket can lose its websocket without emitting "close" (network
    // change, NAT timeout, sleep/resume). That is the classic "everything
    // looks fine but no OTP is ever delivered" failure.
    if (!sock.user || sock.ws?.isOpen === false || !sock.ws) {
      restartConnection("connected socket is no longer open");
    }
    return;
  }

  if (
    status === "connecting" &&
    connectingSince &&
    Date.now() - connectingSince > CONNECTING_TIMEOUT_MS
  ) {
    restartConnection("stuck connecting");
  }
};

const ensureWatchdog = () => {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref?.();
};

// ---------------------------------------------------------------------------
// Connect / initialize
// ---------------------------------------------------------------------------

/**
 * Get the system socket, creating it when needed.
 * Concurrent callers share one initialization.
 */
const whatsappConnect = async () => {
  if (shuttingDown) return null;

  ensureWatchdog();

  // Reuse a socket that is already usable or still coming up.
  if (sock && ["connected", "connecting", "qr_required"].includes(status)) {
    if (status !== "connected" || isSocketLive(sock)) {
      return sock;
    }
    // connected but dead → fall through and rebuild
    restartConnection("stale socket on connect");
    return initializationPromise;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initStartedAt = Date.now();
  const promise = initializeSocket();
  initializationPromise = promise;

  try {
    return await promise;
  } finally {
    // Only clear our own promise — a restart may have replaced it.
    if (initializationPromise === promise) {
      initializationPromise = null;
      initStartedAt = null;
    }
  }
};

const initializeSocket = async () => {
  const myGeneration = generation;

  const superseded = () =>
    shuttingDown || generation !== myGeneration;

  log.info(chalk.cyan("[Baileys][system] Initializing WhatsApp connection..."));

  // Auth state lives in MongoDB (see ./authState.js) so the OTP gateway
  // session survives container restarts / redeploys / free-plan spin-downs.
  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMongoAuthState(SYSTEM_OWNER_KEY));
  } catch (err) {
    status = "error";
    lastError = `auth state: ${err.message}`;
    log.error(
      chalk.red(
        `[Baileys][system] Failed to load auth state: ${err.message}`,
      ),
    );
    if (!superseded()) scheduleReconnect("auth state load failed");
    return null;
  }

  if (superseded()) return null;

  status = "connecting";
  connectingSince = Date.now();
  initStartedAt = initStartedAt || Date.now();

  let version;
  try {
    // Never let the version lookup stall the connect — without a timeout a
    // slow WhatsApp response left the gateway dead until a process restart.
    const { version: fetchedVersion } = await withTimeout(
      8000,
      fetchLatestBaileysVersion(),
      "fetchLatestBaileysVersion",
    );
    version = fetchedVersion;
    log.info(
      chalk.cyan(
        whatsappConnectionLog.CONNECTION.VERSION_USED(version.join(".")),
      ),
    );
  } catch (err) {
    log.info(
      chalk.yellow(whatsappConnectionLog.WARNING.VERSION_FETCH_FAILED),
    );
  }

  if (superseded()) return null;

  const newSock = makeWASocket({
    auth: state,
    logger: baileysLogger.child({ account: "system" }),
    browser: Browsers.windows("Chrome"),
    connectTimeoutMs: 20000,
    keepAliveIntervalMs: 15000,
    defaultQueryTimeoutMs: 30000,
    retryRequestDelayMs: 500,
    ...(version && { version }),
  });

  sock = newSock;
  status = "connecting";
  connectingSince = Date.now();
  initStartedAt = Date.now();
  ensureWatchdog();

  // Events from a superseded socket must never mutate current state.
  const isCurrent = () => sock === newSock && !superseded();

  newSock.ev.on("creds.update", () => {
    if (!isCurrent()) return;
    Promise.resolve(saveCreds()).catch((err) =>
      log.error(
        `[Baileys][system] creds save failed: ${err.message}`,
      ),
    );
  });

  newSock.ev.on("connection.update", async (update) => {
    if (!isCurrent()) {
      log.warn("[Baileys][system] Ignoring stale connection update");
      return;
    }

    const { connection, lastDisconnect, qr: updateQr } = update;

    if (updateQr) {
      retryCount = 0;
      qr = updateQr;
      status = "qr_required";
      connectingSince = null;
      connectedSince = null;
      log.info(
        chalk.cyan(
          "[Baileys][system] " +
            whatsappConnectionLog.CONNECTION.QR_INFO_BORDER,
        ),
      );
      log.info(
        chalk.cyan(
          "[Baileys][system] " + whatsappConnectionLog.CONNECTION.QR_GENERATED,
        ),
      );
      log.info(chalk.cyan(whatsappConnectionLog.CONNECTION.QR_INFO_BORDER));
      qrcode.generate(updateQr, { small: true });
      log.info(
        chalk.cyan(whatsappConnectionLog.CONNECTION.QR_INFO_BORDER + "\n"),
      );
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      qr = null;
      connectingSince = null;
      connectedSince = null;
      lastDisconnectedAt = new Date();
      lastError = `closed${statusCode ? ` (${statusCode})` : ""}`;

      log.info(
        chalk.red(whatsappConnectionLog.CONNECTION.CONNECTION_CLOSED),
      );
      log.info(
        chalk.yellow(
          whatsappConnectionLog.CONNECTION.DISCONNECT_REASON(statusCode),
        ),
      );

      // Only this socket may clear/replace the shared reference.
      if (sock === newSock) sock = null;

      // Permanent logout → clean up, do NOT reconnect (needs a new QR scan).
      if (statusCode === DisconnectReason.loggedOut) {
        log.info(chalk.red(whatsappConnectionLog.WARNING.AUTH_REJECTED));
        status = "auth_required";
        lastError = "logged out";
        await clearAuthState().catch(() => {});
        retryCount = 0;
        reconnecting = false;
        return;
      }

      // 403/419 are unrecoverable auth failures in Baileys.
      if (statusCode === 403 || statusCode === 419) {
        log.info(chalk.red(whatsappConnectionLog.WARNING.AUTH_REJECTED));
        status = "auth_required";
        lastError = `auth rejected (${statusCode})`;
        await clearAuthState().catch(() => {});
        retryCount = 0;
        reconnecting = false;
        return;
      }

      // Everything else — including 440 (connectionReplaced), 405 (stream
      // error) and plain network drops — is transient. Keep retrying with
      // backoff instead of leaving the gateway dead.
      if (statusCode === 440) {
        log.info(
          chalk.yellow(
            "[Baileys][system] Conflict (440) — these credentials are in use by ANOTHER " +
              "running instance (e.g. local + VPS). WhatsApp allows one socket per " +
              "device, so the instances keep kicking each other. Stop one instance.",
          ),
        );
      }

      status = "disconnected";
      scheduleReconnect(
        statusCode ? `disconnect ${statusCode}` : "disconnect",
      );
    } else if (connection === "open") {
      retryCount = 0;
      reconnecting = false;
      qr = null;
      status = "connected";
      connectingSince = null;
      connectedSince = new Date();
      lastConnectedAt = new Date();
      lastError = null;
      log.info(
        chalk.green("[Baileys][system] Connection open — gateway is ready"),
      );
    }
  });

  newSock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg?.message) return;
    const sender = msg.key.remoteJid?.split("@")[0] || "Unknown";
    const messageType = Object.keys(msg.message)[0] || "Unknown";

    log.info(chalk.magenta(whatsappConnectionLog.MESSAGE.RECEIVED));
    log.info(chalk.white(`From: ${sender}`));
    log.info(chalk.white(`Type: ${messageType}`));
  });

  return newSock;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const getClient = () => sock;

/** True only when the gateway can actually send right now. */
export const isConnected = () => isLive();

/**
 * Wait (bounded) for the gateway to be ready, triggering a connection if it
 * is down. Used by the OTP endpoint so a request arriving during a reconnect
 * gets a real attempt instead of a silent failure.
 */
export const ensureConnected = async ({ timeoutMs = 15000 } = {}) => {
  if (isLive()) return sock;
  if (shuttingDown) return null;

  // These need a human (QR scan / re-pair); waiting cannot help.
  if (status === "auth_required" || status === "qr_required") return null;

  whatsappConnect().catch((err) => {
    log.error(
      `[Baileys][system] connect failed: ${err.message}`,
    );
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isLive()) return sock;
    if (shuttingDown || status === "auth_required") return null;
    await sleep(250);
  }

  return isLive() ? sock : null;
};

/** Diagnostic snapshot — no phone numbers, credentials or QR data. */
export const getConnectionState = () => ({
  status,
  connected: isLive(),
  reconnecting: Boolean(reconnecting || reconnectTimer),
  retryCount,
  lastError,
  connectedSince: connectedSince ? connectedSince.toISOString() : null,
  lastConnectedAt: lastConnectedAt ? lastConnectedAt.toISOString() : null,
  lastDisconnectedAt: lastDisconnectedAt
    ? lastDisconnectedAt.toISOString()
    : null,
});

/**
 * Gracefully end the system (OTP gateway) socket on process shutdown.
 * No reconnect is scheduled while exiting.
 */
export const closeClient = () => {
  shuttingDown = true;
  generation += 1;

  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  initializationPromise = null;
  initStartedAt = null;
  connectingSince = null;
  reconnecting = false;
  status = "disconnected";

  if (sock) {
    try {
      sock.end(undefined);
    } catch (_) {
      /* socket already gone */
    }
    sock = null;
  }
};

export { restartConnection };
export default whatsappConnect;
