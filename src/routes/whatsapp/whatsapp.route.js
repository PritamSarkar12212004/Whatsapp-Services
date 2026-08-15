import express from "express";
import asyncHandler from "express-async-handler";
import authMiddleware from "../../middleware/auth.middleware.js";
import whatsappConnectController from "../../controllers/whatsapp/whatsappConnect.controller.js";
import whatsappQRController from "../../controllers/whatsapp/whatsappQR.controller.js";
import whatsappStatusController from "../../controllers/whatsapp/whatsappStatus.controller.js";
import whatsappDisconnectController from "../../controllers/whatsapp/whatsappDisconnect.controller.js";

const route = express.Router();

// All WhatsApp routes require JWT authentication
route.use(authMiddleware);

route.post("/connect", asyncHandler(whatsappConnectController));
route.get("/qr", asyncHandler(whatsappQRController));
route.get("/status", asyncHandler(whatsappStatusController));
route.post("/disconnect", asyncHandler(whatsappDisconnectController));

export default route;