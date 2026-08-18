import connectWhatsApp from "../integrations/whatsapp/connection.js";
import { restoreSessions } from "../integrations/whatsapp/manager.js";
import { startAutomationScheduler } from "../integrations/whatsapp/groupAutomation.service.js";

const initWhatsApp = async () => {
  connectWhatsApp();
  restoreSessions();
  startAutomationScheduler();
};

export default initWhatsApp;
