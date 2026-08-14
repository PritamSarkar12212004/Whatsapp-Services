import express from "express";
import asyncHandler from "express-async-handler";
import profileSetupController from "../controllers/profile.setup.controller.js";
import profileSetupValidation from "../validation/profile.validation.js";

const route = express.Router();

route.post(
  "/setup_profile",
  profileSetupValidation,
  asyncHandler(profileSetupController),
);

export default route;