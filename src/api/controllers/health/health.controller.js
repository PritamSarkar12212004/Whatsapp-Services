import mongoose from "mongoose";
import { getConnectionState } from "../../../integrations/whatsapp/connection.js";

/**
 * Human readable form of mongoose.connection.readyState.
 */
const DATABASE_STATES = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
  99: "uninitialized",
};

const getDatabaseStatus = () =>
  DATABASE_STATES[mongoose.connection.readyState] || "unknown";

const getWhatsappGatewayStatus = () => {
  const state = getConnectionState();

  if (state.connected) return "connected";
  if (state.status === "auth_required") return "auth_required";
  if (state.status === "qr_required") return "qr_required";
  if (state.reconnecting || state.status === "connecting") {
    return "reconnecting";
  }
  return "disconnected";
};

const getMemoryUsage = () => {
  const memory = process.memoryUsage();
  return {
    rssMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
  };
};

/**
 * Liveness probe — always answers 200 while the process is serving traffic.
 * Dependency states are reported as information only, so a transient database
 * blip can never make an uptime monitor restart the container.
 */
const healthController = async (req, res) => {
  return res.status(200).json({
    success: true,
    status: "ok",
    message: "WhatsApp Services API is running",
    environment: process.env.NODE_ENV || "development",
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: getMemoryUsage(),
    services: {
      database: getDatabaseStatus(),
      whatsappGateway: getWhatsappGatewayStatus(),
      whatsappGatewayDetail: getConnectionState(),
    },
  });
};

/**
 * Readiness probe — answers 503 while a critical dependency (MongoDB) is not
 * available, so traffic is only routed to a fully bootstrapped instance.
 */
const healthReadyController = async (req, res) => {
  const database = getDatabaseStatus();
  const ready = database === "connected";

  return res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? "ready" : "not_ready",
    timestamp: new Date().toISOString(),
    services: {
      database,
      whatsappGateway: getWhatsappGatewayStatus(),
    },
  });
};

export { healthReadyController };
export default healthController;