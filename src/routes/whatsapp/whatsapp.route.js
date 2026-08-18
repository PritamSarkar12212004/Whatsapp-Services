import express from "express";
import asyncHandler from "express-async-handler";
import authMiddleware from "../../middleware/auth.middleware.js";
import whatsappConnectController from "../../controllers/whatsapp/whatsappConnect.controller.js";
import whatsappQRController from "../../controllers/whatsapp/whatsappQR.controller.js";
import whatsappStatusController from "../../controllers/whatsapp/whatsappStatus.controller.js";
import whatsappDisconnectController from "../../controllers/whatsapp/whatsappDisconnect.controller.js";
import whatsappProfileController from "../../controllers/whatsapp/whatsappProfile.controller.js";
import whatsappGroupsController from "../../controllers/whatsapp/whatsappGroups.controller.js";
import whatsappGroupDetailController from "../../controllers/whatsapp/whatsappGroupDetail.controller.js";
import {
  getGroupManagerController,
  saveGroupManagerController,
  deleteGroupManagerController,
  getGroupWarningsController,
} from "../../controllers/whatsapp/groupManager.controller.js";
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
route.get("/groups", asyncHandler(whatsappGroupsController));
route.get("/groups/:id", asyncHandler(whatsappGroupDetailController));
route.get("/groups/:id/manager", asyncHandler(getGroupManagerController));
route.post("/groups/:id/manager", asyncHandler(saveGroupManagerController));
route.delete("/groups/:id/manager", asyncHandler(deleteGroupManagerController));
route.get("/groups/:id/warnings", asyncHandler(getGroupWarningsController));
route.post("/profile/name", asyncHandler(updateProfileNameController));
route.post("/profile/about", asyncHandler(updateProfileAboutController));
route.post("/profile/picture", asyncHandler(updateProfilePictureController));
route.post("/disconnect", asyncHandler(whatsappDisconnectController));

export default route;