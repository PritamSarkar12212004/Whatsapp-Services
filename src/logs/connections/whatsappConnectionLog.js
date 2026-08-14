const BORDER = "=".repeat(50);

const whatsappConnectionLog = {
  CONNECTION: {
    VERSION_USED: (v) => `[Baileys] Using version: ${v}`,
    VERSION_FETCH_FAILED: () =>
      "[Baileys] Could not fetch latest version, using default",
    QR_INFO_BORDER: `${BORDER}`,
    QR_GENERATED: "[Baileys] 📱 Scan this QR code to authenticate:",
    CONNECTION_CLOSED: "[Baileys] ❌ Connection closed",
    DISCONNECT_REASON: (code) => `[Baileys] Disconnect reason code: ${code}`,
    RETRY_COUNT: (count, max) =>
      `[Baileys] Retry attempt ${count}/${max}`,
    RECONNECTING: (count, max) =>
      `[Baileys] 🔄 Reconnecting... (${count}/${max})`,
    MAX_RETRIES: "[Baileys] ❌ Max retries reached. Restart required.",
    CONNECTION_SUCCESS: (phone, userId) =>
      `[Baileys] ✅ Connection open! Phone: ${phone} (${userId})`,
  },
  WARNING: {
    VERSION_FETCH_FAILED: "[Baileys] ⚠️ Version fetch failed, using default",
    AUTH_REJECTED:
      "[Baileys] ❌ Session was logged out/unauthorized. Clearing auth state.",
  },
  MESSAGE: {
    RECEIVED: "[Baileys] 📩 New message received:",
  },
  HELPER: {
    CLEAR_AUTH_STATE: "[Baileys] 🧹 Auth state cleared",
  },
};

export default whatsappConnectionLog;