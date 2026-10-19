import connectWhatsApp from "../integrations/whatsapp/connection.js";
import {
  restoreSessions,
  startSessionWatchdog,
} from "../integrations/whatsapp/manager.js";
import { startAutomationScheduler } from "../integrations/whatsapp/groupAutomation.service.js";
import { syncWhatsappAccountIndexes } from "../migrations/whatsappAccounts.migration.js";

const initWhatsApp = async () => {
  // Local development often points at the SAME MongoDB as the VPS. Two
  // instances then connect with identical Baileys credentials and kick each
  // other off with a 440 "connection replaced" loop. Setting
  // WHATSAPP_ENABLED=false in a local .env keeps the API usable without
  // hijacking the production WhatsApp sessions.
  if (String(process.env.WHATSAPP_ENABLED || "true").toLowerCase() === "false") {
    console.log(
      "[Baileys] WHATSAPP_ENABLED=false — skipping all WhatsApp connections on this instance",
    );
    return;
  }

  // Replace the single-number indexes before any session is restored.
  await syncWhatsappAccountIndexes();

  // The gateway self-heals, but an initial failure must not become an
  // unhandled rejection (which kills the whole process on modern Node).
  connectWhatsApp().catch((err) =>
    console.error("[Baileys][system] initial connect failed:", err.message),
  );
  restoreSessions();
  startSessionWatchdog();
  startAutomationScheduler();
};

export default initWhatsApp;
