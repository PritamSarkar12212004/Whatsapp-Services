import express from "express";
import asyncHandler from "express-async-handler";
import authMiddleware from "../../middleware/auth.middleware.js";
import whatsappConnectController from "../controllers/whatsapp/connect.controller.js";
import whatsappQRController from "../controllers/whatsapp/qr.controller.js";
import whatsappStatusController from "../controllers/whatsapp/status.controller.js";
import whatsappDisconnectController from "../controllers/whatsapp/disconnect.controller.js";
import whatsappProfileController from "../controllers/whatsapp/profile.controller.js";
import whatsappGroupsController from "../controllers/whatsapp/groups.controller.js";
import whatsappGroupDetailController from "../controllers/whatsapp/group-detail.controller.js";
import {
  getGroupManagerController,
  saveGroupManagerController,
  deleteGroupManagerController,
  getGroupWarningsController,
} from "../controllers/whatsapp/group-manager.controller.js";
import {
  updateProfileNameController,
  updateProfileAboutController,
  updateProfilePictureController,
} from "../controllers/whatsapp/profile-update.controller.js";

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