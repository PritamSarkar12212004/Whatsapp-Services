import express from "express";
import asyncHandler from "express-async-handler";
import authMiddleware from "../../middleware/auth.middleware.js";
import whatsappConnectController from "../../controllers/whatsapp/whatsappConnect.controller.js";
import whatsappQRController from "../../controllers/whatsapp/whatsappQR.controller.js";
import whatsappStatusController from "../../controllers/whatsapp/whatsappStatus.controller.js";
import whatsappDisconnectController from "../../controllers/whatsapp/whatsappDisconnect.controller.js";
import whatsappProfileController from "../../controllers/whatsapp/whatsappProfile.controller.js";
import {
  updateProfileNameController,
  updateProfileAboutController,
  updateProfilePictureController,
} from "../../controllers/whatsapp/whatsappProfileUpdate.controller.js";

const route = express.Router();

route.use(authMiddleware);

route.post("/connect", asyncHandler(whatsappConnectController));
route.get("/qr", asyncHandler(whatsappQRController));
route.get("/status", asyncHandler(whatsappStatusController));
route.get("/profile", asyncHandler(whatsappProfileController));
route.post("/profile/name", asyncHandler(updateProfileNameController));
route.post("/profile/about", asyncHandler(updateProfileAboutController));
route.post("/profile/picture", asyncHandler(updateProfilePictureController));
route.post("/disconnect", asyncHandler(whatsappDisconnectController));

export default route;