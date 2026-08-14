import express from "express";
import asyncHandler from "express-async-handler";
import generateOtpController from "../../controllers/otp/otp.generate.controller.js";
import verifyOtpController from "../../controllers/otp/otp.verify.controller.js";
import { phoneNumber, otpValidation } from "../../validation/otp.validation.js";

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

export default route;