import initDatabase from "./database.loader.js";
import initWhatsApp from "./whatsapp.loader.js";
import initQueue from "./queue.loader.js";

const initLoaders = async () => {
  await initDatabase();
  await initWhatsApp();
  initQueue();
};

export { initDatabase, initWhatsApp, initQueue };
export default initLoaders;
