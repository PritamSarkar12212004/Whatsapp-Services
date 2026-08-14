import express from "express";
import generateOtpController from "../controllers/otp.generate.controller.js";
import verifyOtpController from "../controllers/otp.verify.controller.js";
import profileSetupController from "../controllers/profile.setup.controller.js";
import { phoneNumber, otpValidation } from "../validation/otp.validation.js";
import profileSetupValidation from "../validation/profile.validation.js";
import asyncHandler from "express-async-handler";

const route = express.Router();
const otpRouter = express.Router();
const authRouter = express.Router();

// ===== OTP module routes (shared by both nesting levels) =====
otpRouter.post(
  "/generate-otp",
  phoneNumber,
  asyncHandler(generateOtpController),
);
otpRouter.post("/verify-otp", otpValidation, asyncHandler(verifyOtpController));

// ===== Auth module routes (shared by both nesting levels) =====
authRouter.post(
  "/setup_profile",
  profileSetupValidation,
  asyncHandler(profileSetupController),
);

// ===== Preserve original microservice root-level routes =====
// OTP service originally exposed: POST /generate-otp, POST /verify-otp
route.use("/", otpRouter);
// Auth service originally exposed: POST /setup_profile
route.use("/", authRouter);

// ===== Preserve original API gateway nested routes =====
// Gateway: /api/otp/* and /api/otp/* (also mounted at /otp, /auth for directness)
route.use("/otp", otpRouter);
route.use("/auth", authRouter);

export default route;