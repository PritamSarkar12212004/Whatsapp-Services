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
        // Allow requests with no Origin header (curl, Postman, same-origin)
        // and every allowed origin below.
        if (
          !origin ||
          ["https://whatsapp-services-frontend.vercel.app"].includes(origin) ||
          origin.startsWith("http://localhost") ||
          origin.startsWith("http://127.0.0.1")
        ) {
          return callback(null, true);
        }``
        return callback(null, false);
      },
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      // ngrok-skip-browser-warning frontend se aata hai (ngrok warning page
      // bypass karne ke liye) — isliye preflight me allow karna zaroori hai.
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "ngrok-skip-browser-warning",
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
