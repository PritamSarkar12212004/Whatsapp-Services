import express from "express";
import asyncHandler from "express-async-handler";
import healthController, {
  healthReadyController,
} from "../controllers/health/health.controller.js";

const route = express.Router();

route.get("/", asyncHandler(healthController));
route.get("/ready", asyncHandler(healthReadyController));

export default route;