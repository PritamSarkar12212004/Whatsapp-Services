import express from "express";
import asyncHandler from "express-async-handler";
import authMiddleware from "../../middleware/auth.middleware.js";
import validateObjectId from "../../middleware/messaging/validateObjectId.middleware.js";
import contactController from "../../controllers/messaging/contact.controller.js";
import contactGroupController from "../../controllers/messaging/contactGroup.controller.js";
import tagController from "../../controllers/messaging/tag.controller.js";
import templateController from "../../controllers/messaging/template.controller.js";
import campaignController from "../../controllers/messaging/campaign.controller.js";
import messageController from "../../controllers/messaging/message.controller.js";
import { validateContact } from "../../validation/messaging/contact.validation.js";
import { validateTag } from "../../validation/messaging/tag.validation.js";
import { validateContactGroup } from "../../validation/messaging/contactGroup.validation.js";
import { validateTemplate } from "../../validation/messaging/template.validation.js";
import { validateCampaign } from "../../validation/messaging/campaign.validation.js";
import { validateSendMessage } from "../../validation/messaging/message.validation.js";

const route = express.Router();

// All CRM routes are authenticated
route.use(authMiddleware);

// ============================================================================
// CONTACTS
// ============================================================================
// NOTE: specific routes must come BEFORE /:id to avoid param shadowing.

route.get("/contacts", asyncHandler(contactController.getAll));
route.get("/contacts/search", asyncHandler(contactController.search));
route.get("/contacts/export", asyncHandler(contactController.export));
route.get("/contacts/blocked", asyncHandler(contactController.getBlocked));
route.get("/contacts/known", asyncHandler(contactController.getKnown));
route.get("/contacts/unknown", asyncHandler(contactController.getUnknown));
route.post("/contacts/import", asyncHandler(contactController.import));
route.post("/contacts/sync-whatsapp", asyncHandler(contactController.syncWhatsApp));
route.get("/contacts/:id", validateObjectId("id"), asyncHandler(contactController.getOne));
route.post("/contacts", validateContact, asyncHandler(contactController.create));
route.patch("/contacts/:id", validateObjectId("id"), asyncHandler(contactController.update));
route.delete("/contacts/:id", validateObjectId("id"), asyncHandler(contactController.remove));
route.post("/contacts/:id/block", validateObjectId("id"), asyncHandler(contactController.block));
route.post("/contacts/:id/unblock", validateObjectId("id"), asyncHandler(contactController.unblock));
route.post("/contacts/:id/opt-out", validateObjectId("id"), asyncHandler(contactController.optOut));
route.post("/contacts/:id/tags", validateObjectId("id"), asyncHandler(contactController.setTags));
route.get("/contacts/:id/activities", validateObjectId("id"), asyncHandler(contactController.getActivities));

// ============================================================================
// CONTACT GROUPS (application-level, NOT WhatsApp groups)
// ============================================================================

route.get("/contact-groups", asyncHandler(contactGroupController.getAll));
route.post("/contact-groups", validateContactGroup, asyncHandler(contactGroupController.create));
route.get("/contact-groups/:id", validateObjectId("id"), asyncHandler(contactGroupController.getOne));
route.patch("/contact-groups/:id", validateObjectId("id"), validateContactGroup, asyncHandler(contactGroupController.update));
route.delete("/contact-groups/:id", validateObjectId("id"), asyncHandler(contactGroupController.remove));
route.post("/contact-groups/:id/contacts", validateObjectId("id"), asyncHandler(contactGroupController.addContacts));
route.delete(
    "/contact-groups/:id/contacts/:contactId",
    validateObjectId("id", "contactId"),
    asyncHandler(contactGroupController.removeContact),
);

// ============================================================================
// TAGS
// ============================================================================

route.get("/tags", asyncHandler(tagController.getAll));
route.post("/tags", validateTag, asyncHandler(tagController.create));
route.patch("/tags/:id", validateObjectId("id"), validateTag, asyncHandler(tagController.update));
route.delete("/tags/:id", validateObjectId("id"), asyncHandler(tagController.remove));

// ============================================================================
// TEMPLATES
// ============================================================================

route.get("/templates", asyncHandler(templateController.getAll));
route.post("/templates", validateTemplate, asyncHandler(templateController.create));
route.get("/templates/:id", validateObjectId("id"), asyncHandler(templateController.getOne));
route.patch("/templates/:id", validateObjectId("id"), validateTemplate, asyncHandler(templateController.update));
route.delete("/templates/:id", validateObjectId("id"), asyncHandler(templateController.remove));
route.post("/templates/:id/preview", validateObjectId("id"), asyncHandler(templateController.preview));

// ============================================================================
// CAMPAIGNS
// ============================================================================

route.get("/campaigns", asyncHandler(campaignController.getAll));
route.post("/campaigns", validateCampaign, asyncHandler(campaignController.create));
route.get("/campaigns/:id", validateObjectId("id"), asyncHandler(campaignController.getOne));
route.patch("/campaigns/:id", validateObjectId("id"), validateCampaign, asyncHandler(campaignController.update));
route.delete("/campaigns/:id", validateObjectId("id"), asyncHandler(campaignController.remove));
route.post("/campaigns/:id/preview", validateObjectId("id"), asyncHandler(campaignController.preview));
route.get("/campaigns/:id/audience", validateObjectId("id"), asyncHandler(campaignController.audience));
route.get("/campaigns/:id/recipients", validateObjectId("id"), asyncHandler(campaignController.recipients));
route.get("/campaigns/:id/stats", validateObjectId("id"), asyncHandler(campaignController.stats));
route.post("/campaigns/:id/start", validateObjectId("id"), asyncHandler(campaignController.start));
route.post("/campaigns/:id/pause", validateObjectId("id"), asyncHandler(campaignController.pause));
route.post("/campaigns/:id/resume", validateObjectId("id"), asyncHandler(campaignController.resume));
route.post("/campaigns/:id/cancel", validateObjectId("id"), asyncHandler(campaignController.cancel));
route.post("/campaigns/:id/unschedule", validateObjectId("id"), asyncHandler(campaignController.unschedule));

// ============================================================================
// MESSAGES (external transactional API)
// ============================================================================

route.post("/messages/send", validateSendMessage, asyncHandler(messageController.send));
route.get("/messages", asyncHandler(messageController.getAll));
route.get("/messages/:id", validateObjectId("id"), asyncHandler(messageController.getOne));
route.post("/messages/:id/cancel", validateObjectId("id"), asyncHandler(messageController.cancel));

export default route;
