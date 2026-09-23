import dotenv from "dotenv";
dotenv.config({ quiet: true });
import chalk from "chalk";
import mongoose from "mongoose";
import createApp from "./src/app.js";
import MainServerLog from "./src/logs/server/MainServerLog.js";
import initLoaders from "./src/loaders/index.js";
import { closeClient } from "./src/integrations/whatsapp/connection.js";
import { shutdownAll } from "./src/integrations/whatsapp/manager.js";

const PORT = process.env.PORT || 8080;

const startKeepAlive = () => {
  if (String(process.env.KEEP_ALIVE || "").toLowerCase() !== "true") return;

  const baseUrl = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;

  if (!baseUrl) {
    console.log(
      chalk.yellow(
        "[KeepAlive] KEEP_ALIVE=true but no public URL (set KEEP_ALIVE_URL or RENDER_EXTERNAL_URL) — skipping",
      ),
    );
    return;
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/health`;
  const intervalMs = 10 * 60 * 1000; // must stay below the 15 min spin-down timer

  const timer = setInterval(async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.log(chalk.yellow(`[KeepAlive] ${url} -> HTTP ${res.status}`));
      }
    } catch (err) {
      console.log(chalk.yellow(`[KeepAlive] ping failed: ${err.message}`));
    }
  }, intervalMs);

  // Do not keep the event loop alive on our own account.
  if (typeof timer.unref === "function") timer.unref();

  console.log(chalk.cyan(`[KeepAlive] Pinging ${url} every 10 minutes`));
};

const start = async () => {
  await initLoaders();

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(chalk.green(MainServerLog.STARTUP_LOG(PORT)));
    startKeepAlive();
  });

  server.on("error", (err) => {
    console.error(
      chalk.red(MainServerLog.SERVER_STARTUP_ERROR_LOG(err, PORT)),
    );
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  //
  // Render sends SIGTERM before killing the container. Closing the WhatsApp
  // sockets cleanly (and letting in-flight Mongo writes settle) avoids both a
  // "dropped connection" on WhatsApp's side and a truncated auth write.
  // -------------------------------------------------------------------------
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(
      chalk.yellow(`\n[Server] ${signal} received — shutting down gracefully...`),
    );

    // Never hang forever: hardened exit after 10s.
    const forceExit = setTimeout(() => {
      console.error(chalk.red("[Server] Forced exit after 10s"));
      process.exit(1);
    }, 10000);
    if (typeof forceExit.unref === "function") forceExit.unref();

    try {
      await shutdownAll();
    } catch (err) {
      console.error("[Server] WhatsApp shutdown error:", err.message);
    }

    try {
      closeClient();
    } catch (err) {
      console.error("[Server] System socket shutdown error:", err.message);
    }

    try {
      await mongoose.connection.close();
      console.log(chalk.cyan("[Server] MongoDB connection closed"));
    } catch (err) {
      console.error("[Server] MongoDB close error:", err.message);
    }

    server.close(() => {
      console.log(chalk.cyan("[Server] HTTP server closed"));
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

start();

