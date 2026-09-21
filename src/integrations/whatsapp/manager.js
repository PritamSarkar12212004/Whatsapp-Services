import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Browsers } from "@whiskeysockets/baileys/lib/Utils/browser-utils.js";
import path from "path";
import chalk from "chalk";
import clearAuthState from "./clearAuthState.js";
import { useMongoAuthState } from "./authState.js";
import { setupGroupAutomation } from "./groupAutomation.service.js";
import whatsappConnectionLog from "../../logs/connections/whatsappConnectionLog.js";
import WhatsAppSession from "../../models/whatsapp/whatsappSession.model.js";
import contactSyncService from "../../services/messaging/contactSync.service.js";
import { applyReceipts, applyGroupReceipts } from "./receipts.js";

const AUTH_BASE_FOLDER = path.join(
  path.resolve(),
  "src/whatsapp/auth_info_baileys",
);

/**
 * Central WhatsApp Session Manager.
 * Maintains a Map<userId, session> where each session has exactly ONE Baileys socket.
 */
const sessions = new Map();

/**
 * 440 = connectionReplaced: another socket is using the same credentials,
 * usually our own duplicate after a fast restart. Retrying is safe, but only
 * a bounded number of times so we never loop forever.
 */
const MAX_CONFLICT_RETRIES = 3;

/**
 * How long a socket may sit in "connecting" without producing a QR or opening
 * before we consider it dead and rebuild it. The QR normally arrives within a
 * couple of seconds, so 30s means "something is wrong", not "slow network".
 */
const STUCK_CONNECT_MS = 30000;

/** Bounded self-healing — never restart the same socket forever. */
const MAX_STUCK_RECOVERIES = 2;

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

const getAuthFolder = (userId) => path.join(AUTH_BASE_FOLDER, userId);

const getSession = (userId) => sessions.get(userId);

const createSession = (userId) => {
  const session = {
    userId,
    socket: null,
    state: null,
    qr: null,
    status: "disconnected",
    reconnecting: false,
    retryCount: 0,
    conflictRetries: 0,
    reconnectTimer: null,
    initializationPromise: null,
    disconnecting: false,
    contactSyncScheduled: false,
    initialSyncDone: false,
    connectingSince: null,
    stuckTimer: null,
    stuckRecoveries: 0,
    generation: 0,
  };
  sessions.set(userId, session);
  return session;
};

/** Stop the stuck-socket watchdog for a session. */
const clearStuckWatchdog = (session) => {
  if (session?.stuckTimer) {
    clearTimeout(session.stuckTimer);
    session.stuckTimer = null;
  }
};

/**
 * A socket that neither produces a QR nor opens leaves the whole app gated
 * behind "Connecting to WhatsApp…" with nothing to advance the state machine.
 * After STUCK_CONNECT_MS we rebuild the socket, and if that keeps failing we
 * fall back to "disconnected" so the UI offers a Retry instead of spinning.
 */
const armStuckWatchdog = (userId, session) => {
  clearStuckWatchdog(session);

  const timer = setTimeout(async () => {
    session.stuckTimer = null;

    // QR / open / close always clear this timer first — reaching here means the
    // attempt never got past "connecting".
    if (session.status !== "connecting" || session.socket?.user) return;

    session.stuckRecoveries = (session.stuckRecoveries || 0) + 1;

    if (session.stuckRecoveries > MAX_STUCK_RECOVERIES) {
      console.error(
        chalk.red(
          `[Baileys] Connection stuck for user ${userId} after ${MAX_STUCK_RECOVERIES} restarts — handing control back to the client`,
        ),
      );
      session.socket = null;
      session.qr = null;
      session.status = "disconnected";
      await updateDbStatus(userId, "disconnected", {
        lastDisconnectedAt: new Date(),
      });
      return;
    }

    console.log(
      chalk.yellow(
        `[Baileys] Connection stuck in "connecting" for user ${userId} — restarting socket (attempt ${session.stuckRecoveries}/${MAX_STUCK_RECOVERIES})`,
      ),
    );
    await connect(userId, { force: true });
  }, STUCK_CONNECT_MS);

  // Never keep the process alive just for this timer.
  timer.unref?.();
  session.stuckTimer = timer;
};

/**
 * Tear down a session's socket + timers so a fresh one can be built from the
 * same credentials (forces a new QR request with WhatsApp).
 */
const teardownSocket = (session) => {
  if (!session) return;
  clearStuckWatchdog(session);

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  try {
    session.socket?.end(undefined);
  } catch (_) {
    /* socket already gone */
  }

  session.socket = null;
  session.qr = null;
  session.reconnecting = false;
  session.connectingSince = null;
  // Bump the generation so a still-running initializeSocket() for the old
  // socket notices it was superseded and bails out instead of hijacking the
  // session when it finally resolves.
  session.generation = (session.generation || 0) + 1;
};

const updateDbStatus = async (userId, status, extra = {}) => {
  try {
    await WhatsAppSession.findOneAndUpdate(
      { userId },
      { sessionId: userId.toString(), status, ...extra },
      { upsert: true, new: true },
    );
  } catch (err) {
    console.error(`[Baileys] DB status update error for ${userId}:`, err.message);
  }
};

/**
 * Connect (or reuse) a user's WhatsApp socket.
 *
 * @param {String}  userId
 * @param {Object}  [options]
 * @param {Boolean} [options.force] Rebuild the socket even when one already
 *   exists. Used by the client's "Reconnect" button and by the stuck-socket
 *   watchdog — a socket wedged in "connecting" can only be cleared this way.
 */
const connect = async (userId, { force = false } = {}) => {
  let session = sessions.get(userId);

  if (force && session) {
    console.log(
      chalk.yellow(`[Baileys] Forcing a fresh socket for user ${userId}`),
    );
    teardownSocket(session);
    session.status = "disconnected";
    // An explicit retry deserves a fresh self-healing budget. Dropping a stale
    // init promise matters too: a wedged one would otherwise be awaited again
    // instead of building a new socket (the superseded run bails on its own).
    session.stuckRecoveries = 0;
    session.initializationPromise = null;
  }

  // Socket exists and is not disconnected (connecting, qr_required, connected) → reuse
  if (session && session.socket && session.status !== "disconnected") {
    console.log(
      chalk.green("[Baileys] Connection already active, reusing existing socket"),
    );
    return session.socket;
  }

  // Already initializing → wait for existing connection
  if (session && session.initializationPromise) {
    console.log(
      chalk.yellow(
        "[Baileys] Connection already initializing, waiting for existing connection",
      ),
    );
    return session.initializationPromise;
  }

  // Create session if not exists
  if (!session) {
    session = createSession(userId);
  }

  // Set initialization promise to prevent concurrent init
  const promise = initializeSocket(userId, session);
  session.initializationPromise = promise;

  try {
    return await promise;
  } finally {
    // Only clear our own promise — a forced restart may have replaced it with a
    // newer init that must stay visible to concurrent connect() calls.
    if (session.initializationPromise === promise) {
      session.initializationPromise = null;
    }
  }
};

// TODO(whatsapp): initializeSocket is ~200 lines of socket setup + event
//   wiring. Split into ./socket/initialize.js + ./socket/eventHandlers.js
//   when a unit-test seam is introduced (the handlers close over session).
const initializeSocket = async (userId, session) => {
  // Every init owns a generation number. If the session is torn down and
  // rebuilt while we are waiting on Mongo/WhatsApp, this run must not touch the
  // session any more (otherwise a slow init would overwrite the fresh socket).
  const generation = session.generation || 0;
  const superseded = () => (session.generation || 0) !== generation;

  // Clean up old socket if exists
  if (session.socket) {
    try {
      session.socket.end();
    } catch (_) {}
    session.socket = null;
  }

  console.log(
    chalk.cyan(`[Baileys] Initializing WhatsApp connection for user ${userId}...`),
  );

  // Auth state lives in MongoDB, NOT on disk — see ./authState.js. The
  // deployed filesystem is ephemeral (Render free plan spins the container
  // down and wipes it), so creds kept as files meant a fresh QR scan every
  // time the service restarted or redeployed.
  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMongoAuthState(userId));
  } catch (err) {
    console.error(
      chalk.red(
        `[Baileys] Failed to load auth state for user ${userId}: ${err.message}`,
      ),
    );
    session.status = "error";
    await updateDbStatus(userId, "error");
    return null;
  }

  // A paired device normally has `registered: true`, but some sessions keep
  // `registered: false` while still carrying a valid `me.id` — the device IS
  // linked in that case. Only warn when there is no linked identity at all.
  const linkedIdentity = state?.creds?.me?.id;
  if (linkedIdentity) {
    console.log(
      chalk.cyan(
        `[Baileys] Loaded existing WhatsApp identity for user ${userId} ` +
          `(${String(linkedIdentity).split(":")[0]}) — no QR scan needed`,
      ),
    );
  } else {
    console.log(
      chalk.yellow(
        `[Baileys] No linked WhatsApp identity for user ${userId} — a QR scan is required`,
      ),
    );
  }

  // Check if session was disconnected during initialization
  if (session.disconnecting || superseded()) {
    console.log(
      chalk.yellow(
        `[Baileys] Session for user ${userId} was disconnected during initialization`,
      ),
    );
    return null;
  }

  session.state = state;

  let version;
  try {
    // Never let the version lookup stall the connect — without a timeout a slow
    // WhatsApp response left the session stuck before a socket even existed.
    const { version: fetchedVersion } = await withTimeout(
      8000,
      fetchLatestBaileysVersion(),
      "fetchLatestBaileysVersion",
    );
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

  if (session.disconnecting || superseded()) return null;

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.windows("Chrome"),
    // Explicit timeouts so a dead handshake fails fast instead of hanging the
    // Session Manager in "connecting" forever (the UI has nothing to show
    // until a QR or an open/close event arrives).
    connectTimeoutMs: 20000,
    keepAliveIntervalMs: 15000,
    defaultQueryTimeoutMs: 30000,
    retryRequestDelayMs: 500,
    ...(version && { version }),
  });

  session.socket = sock;
  session.status = "connecting";
  session.connectingSince = Date.now();
  await updateDbStatus(userId, "connecting");
  armStuckWatchdog(userId, session);

  sock.ev.on("creds.update", saveCreds);

  // Trigger the WhatsApp → CRM contact sync only once the connection is fully
  // online AND initial/app-state synchronization has completed.
  const maybeTriggerContactSync = () => {
    if (
      session.status === "connected" &&
      session.initialSyncDone &&
      !session.contactSyncScheduled
    ) {
      session.contactSyncScheduled = true;
      console.log(
        `[Contacts Sync] Starting contact synchronization for user ${userId}`,
      );
      contactSyncService
        .syncContactsOnConnect(userId, sock, {
          reason: "connect",
          authFolder: getAuthFolder(userId),
        })
        .catch((error) => {
          console.error(
            `[Contacts Sync] Error during contact synchronization:`,
            error.message,
          );
          // Do NOT throw - sync failure must not crash the connection
        });
    }
  };

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

    if (qr) {
      session.qr = qr;
      session.status = "qr_required";
      session.retryCount = 0;
      // The socket is alive — stop treating this attempt as stuck.
      session.connectingSince = null;
      clearStuckWatchdog(session);
      console.log(
        chalk.cyan(`[Baileys] QR generated for user ${userId}`),
      );
      await updateDbStatus(userId, "qr_required");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      session.qr = null;
      session.connectingSince = null;
      clearStuckWatchdog(session);
      session.contactSyncScheduled = false;
      session.initialSyncDone = false;
      contactSyncService.clearUserCache(userId);

      console.log(
        chalk.red(`[Baileys] WhatsApp disconnected for user ${userId}`),
      );
      console.log(
        chalk.yellow(`[Baileys] Disconnect reason code: ${statusCode}`),
      );

      // Permanent logout → clean up, do NOT reconnect
      if (statusCode === DisconnectReason.loggedOut) {
        console.log(
          chalk.red(`[Baileys] User ${userId} logged out permanently`),
        );
        session.status = "logged_out";
        await updateDbStatus(userId, "logged_out", {
          lastDisconnectedAt: new Date(),
        });
        await clearAuthState(userId);
        sessions.delete(userId);
        return;
      }

      // Conflict / replaced (440 = connectionReplaced) → another socket is
      // using the same credentials, which is normally our own duplicate right
      // after a restart or a retry. Giving up here killed the session forever
      // and left the UI stuck, so retry with backoff instead of dying.
      if (statusCode === 440) {
        session.socket = null;
        session.status = "disconnected";
        session.conflictRetries = (session.conflictRetries || 0) + 1;

        await updateDbStatus(userId, "disconnected", {
          lastDisconnectedAt: new Date(),
        });

        if (
          session.conflictRetries <= MAX_CONFLICT_RETRIES &&
          !session.reconnecting
        ) {
          const retryDelay = 5000 * session.conflictRetries;
          console.log(
            chalk.yellow(
              `[Baileys] Conflict (440) for user ${userId} — retrying in ${retryDelay}ms ` +
                `(attempt ${session.conflictRetries}/${MAX_CONFLICT_RETRIES})`,
            ),
          );
          session.reconnecting = true;
          session.reconnectTimer = setTimeout(() => {
            session.reconnecting = false;
            connect(userId);
          }, retryDelay);
        } else {
          console.log(
            chalk.red(
              `[Baileys] Conflict (440) persisted for user ${userId} — stopping retries`,
            ),
          );
          session.conflictRetries = 0;
        }
        return;
      }

      // Temporary disconnects → controlled reconnect
      session.status = "disconnected";
      await updateDbStatus(userId, "disconnected", {
        lastDisconnectedAt: new Date(),
      });

      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== DisconnectReason.multideviceMismatch;

      if (shouldReconnect && !session.reconnecting) {
        session.reconnecting = true;
        session.retryCount++;
        const delay = Math.min(3000 * (session.retryCount + 1), 15000);
        console.log(
          chalk.blue(
            `[Baileys] Reconnecting user ${userId}... (${session.retryCount})`,
          ),
        );
        session.reconnectTimer = setTimeout(() => {
          session.reconnecting = false;
          connect(userId);
        }, delay);
      }
    } else if (connection === "open") {
      session.status = "connected";
      session.retryCount = 0;
      session.conflictRetries = 0;
      session.stuckRecoveries = 0;
      session.connectingSince = null;
      clearStuckWatchdog(session);
      const phone = sock.user?.id?.split(":")[0] || "Unknown";
      console.log(
        chalk.green(
          `[Baileys] WhatsApp connected for user ${userId} (${phone})`,
        ),
      );
      await updateDbStatus(userId, "connected", {
        phoneNumber: phone,
        lastConnectedAt: new Date(),
      });
      // Reset so a reconnect re-triggers contact sync after initial sync
      session.contactSyncScheduled = false;
      maybeTriggerContactSync();
    }

    // Contact sync must run only AFTER the connection is fully online AND
    // initial/app-state synchronization has completed. Note: on reconnects with
    // existing sync data, `receivedPendingNotifications` can arrive BEFORE the
    // `open` event, so we track both flags and trigger once both are true.
    if (receivedPendingNotifications) {
      session.initialSyncDone = true;
      maybeTriggerContactSync();
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;
    const sender = msg.key.remoteJid?.split("@")[0] || "Unknown";
    console.log(
      chalk.magenta(
        `[Baileys] 📩 New message from ${sender} for user ${userId}`,
      ),
    );
  });

  // Delivery / read receipts → advance Message + CampaignRecipient statuses so
  // the dashboard's Delivered / Read counters and rates reflect reality.
  sock.ev.on("messages.update", async (updates) => {
    try {
      await applyReceipts(userId, updates);
    } catch (err) {
      console.error(
        `[Baileys] receipt handler error for user ${userId}:`,
        err.message,
      );
    }
  });

  // Group chats report receipts on a different event (Baileys 7 keeps
  // `messages.update` for direct chats only).
  sock.ev.on("message-receipt.update", async (receipts) => {
    try {
      await applyGroupReceipts(userId, receipts);
    } catch (err) {
      console.error(
        `[Baileys] group receipt handler error for user ${userId}:`,
        err.message,
      );
    }
  });

  // Group automation engine (moderation, auto-reply, commands, welcome/goodbye).
  setupGroupAutomation(sock, userId);

  return sock;
};

/**
 * Run the WhatsApp → CRM contact sync for a user's active socket.
 * Used by the manual sync endpoint (POST /api/messaging/contacts/sync-whatsapp).
 */
const triggerContactSync = async (userId, options = {}) => {
  const sock = getSocket(userId);
  if (!sock) {
    return { error: "WhatsApp is not connected" };
  }
  return contactSyncService.syncContactsOnConnect(userId, sock, {
    ...options,
    authFolder: getAuthFolder(userId),
  });
};

/**
 * Get a user's socket. Returns null if not connected.
 */
const getSocket = (userId) => {
  const session = sessions.get(userId);
  return session?.socket || null;
};

/**
 * Get a user's QR code. Returns null if not available.
 */
const getQR = (userId) => {
  const session = sessions.get(userId);
  return session?.qr || null;
};

/**
 * Get a user's session status.
 */
const getStatus = (userId) => {
  const session = sessions.get(userId);
  if (!session) {
    return { connected: false, status: "disconnected", phoneNumber: null };
  }
  return {
    connected: session.status === "connected",
    status: session.status,
    phoneNumber: session.socket?.user?.id?.split(":")[0] || null,
    // How long the session has been stuck in "connecting" (ms) — lets the
    // client (and the connect controller) tell "starting up" from "stuck".
    connectingFor: session.connectingSince
      ? Date.now() - session.connectingSince
      : null,
  };
};

/**
 * Disconnect ONLY the given user's WhatsApp session.
 */
const disconnect = async (userId) => {
  const session = sessions.get(userId);
  if (!session) {
    console.log(chalk.yellow(`[Baileys] No active session for user ${userId}`));
    return;
  }

  // Mark as disconnecting to prevent orphaned sockets during init
  session.disconnecting = true;

  // Clear the stuck-socket watchdog
  clearStuckWatchdog(session);
  session.connectingSince = null;

  // Clear reconnect timer
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  if (session.socket) {
    try {
      session.socket.end();
    } catch (_) {}
    session.socket = null;
  }

  session.status = "disconnected";
  session.qr = null;
  session.reconnecting = false;

  await updateDbStatus(userId, "disconnected", {
    lastDisconnectedAt: new Date(),
  });

  sessions.delete(userId);
  console.log(
    chalk.blue(`[Baileys] User ${userId} disconnected and session removed`),
  );
};

/**
 * FULL logout — unlink the device from WhatsApp servers AND delete the local
 * auth state folder. The next connect will require a fresh QR scan.
 */
const logout = async (userId) => {
  const session = sessions.get(userId);

  // A logout must also kill the stuck-socket watchdog and any in-flight init.
  clearStuckWatchdog(session);
  if (session) {
    session.connectingSince = null;
    session.generation = (session.generation || 0) + 1;
  }

  if (session?.socket) {
    try {
      // Gracefully unlink the device from WhatsApp servers.
      // The connection closes with DisconnectReason.loggedOut → the close
      // handler below clears auth state and removes the session as well.
      await session.socket.logout();
      console.log(
        chalk.red(`[Baileys] Logout request sent for user ${userId}`),
      );
    } catch (err) {
      console.log(
        chalk.yellow(
          `[Baileys] socket.logout() failed for ${userId}: ${err.message}`,
        ),
      );
      try {
        session.socket.end();
      } catch (_) {}
    }
  }

  // Clear reconnect timer
  if (session?.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  // Always delete the auth state → next connect requires a QR scan.
  await clearAuthState(userId);

  if (session) {
    session.socket = null;
    session.qr = null;
    session.status = "logged_out";
    session.disconnecting = true;
    sessions.delete(userId);
  }

  await updateDbStatus(userId, "logged_out", {
    lastDisconnectedAt: new Date(),
  });

  console.log(
    chalk.red(
      `[Baileys] User ${userId} fully logged out — QR scan required to reconnect`,
    ),
  );
};

/**
 * Restore active sessions on server restart.
 * Only reconnects sessions marked as "connected" in DB.
 */
const restoreSessions = async () => {
  console.log(
    chalk.cyan("[Baileys] Restoring active WhatsApp sessions..."),
  );
  try {
    const activeSessions = await WhatsAppSession.find({ status: "connected" });
    for (const session of activeSessions) {
      const userId = session.userId.toString();
      console.log(
        chalk.cyan(`[Baileys] Restoring session for user ${userId}`),
      );
      connect(userId);
    }
    if (activeSessions.length === 0) {
      console.log(
        chalk.cyan("[Baileys] No active sessions to restore"),
      );
    }
  } catch (err) {
    console.error("[Baileys] Error restoring sessions:", err.message);
  }
};

/**
 * Gracefully end every active socket.
 * Called on process shutdown so WhatsApp sees a clean disconnect instead of a
 * dropped connection (and so no reconnect timer fires while we are exiting).
 */
const shutdownAll = async () => {
  for (const [userId, session] of sessions.entries()) {
    clearStuckWatchdog(session);

    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }

    // Both flags prevent the close handler below from scheduling a reconnect.
    session.disconnecting = true;
    session.reconnecting = true;

    try {
      session.socket?.end();
    } catch (_) {
      /* socket already gone */
    }

    session.socket = null;
    session.status = "disconnected";
    console.log(chalk.blue(`[Baileys] Closed socket for user ${userId}`));
  }
};

export {
  connect,
  getSocket,
  getQR,
  getStatus,
  disconnect,
  logout,
  restoreSessions,
  getSession,
  triggerContactSync,
  shutdownAll,
};