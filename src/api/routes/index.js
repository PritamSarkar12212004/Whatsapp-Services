import express from "express";
import authRoutes from "./auth.routes.js";
import whatsappRoutes from "./whatsapp.routes.js";
import messagingRoutes from "./messaging.routes.js";
import healthRoutes from "./health.routes.js";

const route = express.Router();

// Legacy mount points are preserved so every endpoint stays reachable at its
// existing path (e.g. /api/generate-otp and /api/otp/generate-otp both work).
route.use("/", authRoutes);
route.use("/auth", authRoutes);
route.use("/otp", authRoutes);
route.use("/whatsapp", whatsappRoutes);
route.use("/messaging", messagingRoutes);
// Public probes → /health and /api/health (plus /health/ready and /api/health/ready).
route.use("/health", healthRoutes);

export default route;
