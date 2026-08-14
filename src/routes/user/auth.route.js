import express from "express";
import asyncHandler from "express-async-handler";
import profileSetupController from "../../controllers/user/profile.setup.controller.js";
import profileSetupValidation from "../../validation/profile/profile.validation.js";

const route = express.Router();

route.post(
  "/setup_profile",
  profileSetupValidation,
  asyncHandler(profileSetupController),
);

export default route;