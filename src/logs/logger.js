import dotenv from "dotenv";
dotenv.config({ quiet: true });

import util from "node:util";
import pino from "pino";
import pinoPretty from "pino-pretty";

/**
 * One logger for the whole app.
 *
 * Terminal format (development):
 *   2026-10-19 15:42:01.123 INFO  [manager] [Baileys] Connected
 *
 * Machine format (production): JSON lines, ready for pm2 / Docker / a log
 * shipper. Force it with LOG_PRETTY=false.
 *
 * Environment:
 *   LOG_LEVEL          error | warn | info | debug | trace   (default: info)
 *   LOG_PRETTY         true | false (default: true outside production)
 *   BAILEYS_LOG_LEVEL  level for Baileys' own pino logs (default: warn)
 */
const isProduction = process.env.NODE_ENV === "production";

const level = String(process.env.LOG_LEVEL || "info").toLowerCase();

const prettyEnabled =
  String(process.env.LOG_PRETTY ?? (isProduction ? "false" : "true")).toLowerCase() !== "false";

const options = {
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
};

const stream = prettyEnabled
  ? pinoPretty({
      // Colours only in a real terminal; pm2/docker logs stay clean.
      colorize: Boolean(process.stdout.isTTY),
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
      ignore: "pid,hostname,scope,class",
      messageFormat: "[{scope}] {msg}",
      singleLine: false,
      errorLikeObjectKeys: ["err", "error"],
      errorProps: "stack",
    })
  : undefined;

const base = stream ? pino(options, stream) : pino(options);

/**
 * Console-compatible argument handling: `util.format` keeps `%s`,
 * object inspection and Error stacks behaving exactly like console.* did,
 * while the logger adds timestamp, level and module scope.
 */
const format = (...args) => util.format(...args);

/**
 * Scoped logger used by application modules.
 *   const log = createLogger("queue");
 *   log.info("Started");            log.error("failed:", err.message);
 */
export const createLogger = (scope = "app") => {
  const child = base.child({ scope });
  return {
    info: (...args) => child.info(format(...args)),
    warn: (...args) => child.warn(format(...args)),
    error: (...args) => child.error(format(...args)),
    debug: (...args) => child.debug(format(...args)),
    trace: (...args) => child.trace(format(...args)),
    fatal: (...args) => child.fatal(format(...args)),
  };
};

/** Baileys talks to a pino-style logger directly (object-first API). */
export const baileysLogger = base.child(
  { scope: "baileys" },
  { level: String(process.env.BAILEYS_LOG_LEVEL || "warn").toLowerCase() },
);

export const logger = createLogger("app");

export default logger;
