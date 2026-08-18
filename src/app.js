import express from "express";
import helmet from "helmet";
import dns from "dns";
import morgan from "morgan";
import cors from "cors";
import route from "./api/routes/index.js";
import GlobalErrorHandler from "./middleware/error.middleware.js";
import requestInfo from "./middleware/requestInfo.middleware.js";

dns.setServers(["8.8.8.8", "8.8.4.4"]);

/**
 * Build the Express application (middleware stack + routes + error handler).
 * Kept separate from server.js so the app can be tested/imported without
 * binding a port.
 */
const createApp = () => {
  const app = express();

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
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
      return res.sendStatus(204);
    }
    next();
  });

  app.use("/api", route);
  app.use("/", route);

  app.use(GlobalErrorHandler);

  return app;
};

export default createApp;
