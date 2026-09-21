import express from "express";
import helmet from "helmet";
import dns from "dns";
import morgan from "morgan";
import cors from "cors";
import route from "./api/routes/index.js";
import GlobalErrorHandler from "./middleware/error.middleware.js";
import requestInfo from "./middleware/requestInfo.middleware.js";

dns.setServers(["8.8.8.8", "8.8.4.4"]);

const createApp = () => {
  const app = express();

  app.use(
    cors({
      origin: function (origin, callback) {
        if (
          !origin ||
          ["https://whatsapp-services-frontend.vercel.app"].includes(origin) ||
          origin.startsWith("http://localhost") ||
          origin.startsWith("http://127.0.0.1")
        ) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      // PATCH is used by the bot editor — without it the browser's preflight
      // fails and "could not save" looks like a server bug.
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "ngrok-skip-browser-warning",
        // Which WhatsApp number a request is for (multi-account switcher).
        // A header missing here fails the preflight, so the browser never even
        // sends the request — the app just shows "network error".
        "x-wa-account",
      ],
    }),
  );
  app.use(morgan("dev"));
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(express.json({ limit: "5mb" }));
  app.use(requestInfo);

  app.use("/api", route);
  app.use("/", route);

  app.use(GlobalErrorHandler);

  return app;
};

export default createApp;
