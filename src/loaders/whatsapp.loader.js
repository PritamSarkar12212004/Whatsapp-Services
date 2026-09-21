import connectWhatsApp from "../integrations/whatsapp/connection.js";
import { restoreSessions } from "../integrations/whatsapp/manager.js";
import { startAutomationScheduler } from "../integrations/whatsapp/groupAutomation.service.js";
import { syncWhatsappAccountIndexes } from "../migrations/whatsappAccounts.migration.js";

const initWhatsApp = async () => {
  // Replace the single-number indexes before any session is restored.
  await syncWhatsappAccountIndexes();

  connectWhatsApp();
  restoreSessions();
  startAutomationScheduler();
};

export default initWhatsApp;
