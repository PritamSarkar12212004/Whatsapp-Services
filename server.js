import dotenv from "dotenv";
dotenv.config({ quiet: true });
import chalk from "chalk";
import createApp from "./src/app.js";
import MainServerLog from "./src/logs/server/MainServerLog.js";
import initLoaders from "./src/loaders/index.js";

const PORT = process.env.PORT || 8080;

const start = async () => {
  await initLoaders();

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(chalk.green(MainServerLog.STARTUP_LOG(PORT)));
  });

  server.on("error", (err) => {
    console.error(
      chalk.red(MainServerLog.SERVER_STARTUP_ERROR_LOG(err, PORT)),
    );
  });
};

start();
