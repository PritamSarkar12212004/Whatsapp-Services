import express from "express";
import generateOtpController from "../controllers/otp/otp.generate.controller.js";
import verifyOtpController from "../controllers/otp/otp.verify.controller.js";
import profileSetupController from "../controllers/user/profile.setup.controller.js";
import { phoneNumber, otpValidation } from "../validation/otp/otp.validation.js";
import profileSetupValidation from "../validation/profile/profile.validation.js";
import authMiddleware from "../middleware/auth.middleware.js";
import asyncHandler from "express-async-handler";
import whatsappRoute from "./whatsapp/whatsapp.route.js";

const route = express.Router();
const otpRouter = express.Router();
const authRouter = express.Router();

otpRouter.post(
  "/generate-otp",
  phoneNumber,
  asyncHandler(generateOtpController),
);

otpRouter.post("/verify-otp", otpValidation, asyncHandler(verifyOtpController));

authRouter.post(
  "/setup_profile",
  authMiddleware,
  profileSetupValidation,
  asyncHandler(profileSetupController),
);

route.use("/", otpRouter);
route.use("/", authRouter);
route.use("/whatsapp", whatsappRoute);

route.use("/otp", otpRouter);
route.use("/auth", authRouter);
route.use("/whatsapp", whatsappRoute);

export default route;