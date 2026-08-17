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
import { restoreSessions } from "./src/whatsapp/whatsappManager.js";
import campaignQueue from "./src/queue/campaignQueue.js";
import route from "./src/routes/index.js";

const app = express();
const PORT = process.env.PORT || 8080;

dns.setServers(["8.8.8.8", "8.8.4.4"]);
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);
app.use(morgan("dev"));
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: "5mb" }));
app.use(requestInfo);

// Handle preflight OPTIONS requests (Express 5 compatible)
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.sendStatus(204);
  }
  next();
});

app.use("/api", route);
app.use("/", route);

app.use(GlobalErrorHandler);

const start = async () => {
  await Database();
  connectWhatsApp();
  restoreSessions();
  // Re-enqueue any campaign recipients / messages left queued by a previous
  // process (the queue is in-memory and loses jobs on restart).
  campaignQueue.recoverPendingJobs().catch((err) =>
    console.error("[CRM Queue] recovery error:", err.message),
  );
  const server = app.listen(PORT, () => {
    console.log(chalk.green(MainServerLog.STARTUP_LOG(PORT)));
  });
  server.on("error", (err) => {
    console.error(chalk.red(MainServerLog.SERVER_STARTUP_ERROR_LOG(err, PORT)));
  });
};

start();