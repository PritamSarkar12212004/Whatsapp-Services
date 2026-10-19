import { createLogger } from "../logs/logger.js";

const log = createLogger("http");

const requestInfo = (req, res, next) => {
  const startedAt = process.hrtime.bigint();

  // One line per request, written when the response is done so it can carry
  // the status code and duration (morgan did this before — two HTTP logs for
  // every request was just noise).
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const ip = req.ip || req.socket?.remoteAddress || "-";
    const line =
      `${req.method} ${req.originalUrl} ${res.statusCode} ` +
      `${durationMs.toFixed(1)}ms — ${ip}`;

    if (req.originalUrl.startsWith("/health")) return log.debug(line);
    if (res.statusCode >= 500) return log.error(line);
    if (res.statusCode >= 400) return log.warn(line);
    return log.info(line);
  });

  next();
};

export default requestInfo;