import express from "express";
import asyncHandler from "express-async-handler";
import authMiddleware from "../../middleware/auth.middleware.js";
import generateOtpController from "../controllers/auth/otp-generate.controller.js";
import verifyOtpController from "../controllers/auth/otp-verify.controller.js";
import profileSetupController from "../controllers/auth/profile-setup.controller.js";
import { phoneNumber, otpValidation } from "../../validation/otp/otp.validation.js";
import profileSetupValidation from "../../validation/profile/profile.validation.js";

const route = express.Router();

route.post(
  "/generate-otp",
  phoneNumber,
  asyncHandler(generateOtpController),
);

route.post(
  "/verify-otp",
  otpValidation,
  asyncHandler(verifyOtpController),
);

route.post(
  "/setup_profile",
  authMiddleware,
  profileSetupValidation,
  asyncHandler(profileSetupController),
);

export default route;
