import { createLogger } from "../logs/logger.js";

const log = createLogger("http");

const GlobalErrorHandler = (err, req, res, next) => {
  log.error(
    `[${new Date().toISOString()}] GLOBAL ERROR: ${req.method} ${req.originalUrl} - ${err.message}`,
    err,
  );
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
  });
};

export default GlobalErrorHandler;