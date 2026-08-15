import dotenv from "dotenv";
dotenv.config({ quiet: true });
import express from "express";
import helmet from "helmet";
import dns from "dns";
import morgan from "morgan";
import chalk from "chalk";
import cors from 'cors'
import MainServerLog from "./src/logs/server/MainServerLog.js";
import GlobalErrorHandler from "./src/middleware/GlobalErrorHandler.middleware.js";
import requestInfo from "./src/middleware/requestInfo.middleware.js";
import Database from "./src/config/database/database.js";
import connectWhatsApp from "./src/whatsapp/whatsappConnection.js";
import route from "./src/routes/index.js";

const app = express();
const PORT = process.env.PORT || 8080;

dns.setServers(["8.8.8.8", "8.8.4.4"]);
app.use(cors({
  origin: "*"
}))
app.use(morgan("dev"));
app.use(helmet());
app.use(express.json());
app.use(requestInfo);

app.use("/api", route);
app.use("/", route);

app.use(GlobalErrorHandler);

const start = async () => {
  await Database();
  connectWhatsApp();
  const server = app.listen(PORT, () => {
    console.log(chalk.green(MainServerLog.STARTUP_LOG(PORT)));
  });
  server.on("error", (err) => {
    console.error(chalk.red(MainServerLog.SERVER_STARTUP_ERROR_LOG(err, PORT)));
  });
};

start();