import Message from "../../models/crm/message.model.js";
import Contact from "../../models/crm/contact.model.js";
import activityService from "./activity.service.js";
import templateService from "./template.service.js";
import { normalizePhoneNumber } from "../../utils/crm/phone.util.js";
import { renderTemplate } from "../../utils/crm/template.util.js";
import campaignQueue from "../../queue/campaignQueue.js";

const messageService = {
  /**
   * External/backend-to-backend transactional send.
   *
   * Flow: validate recipient -> find template -> render variables ->
   * create message -> queue -> send via existing Baileys transport ->
   * update status.
   */
  async sendTransactional(ownerId, payload) {
    const { to, template, variables = {} } = payload;

    if (!to) {
      const e = new Error("Recipient 'to' is required");
      e.statusCode = 400;
      throw e;
    }
    if (!template) {
      const e = new Error("Template identifier is required");
      e.statusCode = 400;
      throw e;
    }

    const phoneNumber = normalizePhoneNumber(to);
    if (!phoneNumber) {
      const e = new Error("Invalid recipient phone number");
      e.statusCode = 400;
      throw e;
    }

    // Find template (owner-scoped)
    const tmpl = await templateService.findTemplate(ownerId, template);
    const rendered = renderTemplate(tmpl.content, variables);

    // Find or create a lightweight contact record for the recipient
    let contact = await Contact.findOne({ owner: ownerId, phoneNumber }).exec();
    let contactId = null;
    if (!contact) {
      contact = await Contact.create({
        owner: ownerId,
        phoneNumber,
        isSavedContact: false,
        isUnknown: true,
        name: variables.name || null,
      });
      contactId = contact._id;
      await activityService.logActivity(ownerId, contactId, "imported", {
        source: "transactional_send",
      });
    } else {
      contactId = contact._id;
    }

    // Create a message record (outbound, queued)
    const message = await Message.create({
      owner: ownerId,
      contact: contactId,
      direction: "outbound",
      type: tmpl.type || "text",
      content: rendered,
      to: phoneNumber,
      status: "queued",
    });

    await activityService.logActivity(ownerId, contactId, "message_sent", {
      messageId: message._id,
    });

    // Enqueue for the worker (immediate delivery target)
    await campaignQueue.enqueueMessage({
      messageId: message._id.toString(),
      ownerId: ownerId.toString(),
      phoneNumber,
      rendered,
      type: tmpl.type || "text",
      media: tmpl.media || null,
      campaignId: null,
    });

    return { message, rendered };
  },

  /** List messages for the owner with pagination. */
  async listMessages(ownerId, options = {}) {
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const query = { owner: ownerId };
    if (options.direction) query.direction = options.direction;
    if (options.status) query.status = options.status;
    if (options.contactId) query.contact = options.contactId;
    if (options.campaignId) query.campaign = options.campaignId;

    const [total, messages] = await Promise.all([
      Message.countDocuments(query).exec(),
      Message.find(query)
        .populate("contact", "name phoneNumber")
        .populate("campaign", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
    ]);

    return {
      messages,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
    };
  },

  /** Get a single message (owner-scoped). */
  async getMessage(ownerId, id) {
    const message = await Message.findOne({ _id: id, owner: ownerId })
      .populate("contact", "name phoneNumber")
      .populate("campaign", "name")
      .exec();
    if (!message) {
      const e = new Error("Message not found");
      e.statusCode = 404;
      throw e;
    }
    return message;
  },

  /**
   * Record the outcome of a send attempt on a Message document.
   * Called by the queue worker.
   */
  async updateMessageStatus(messageId, status, opts = {}) {
    const updates = { status };
    if (opts.whatsappMessageId)
      updates.whatsappMessageId = opts.whatsappMessageId;
    if (opts.error) updates.error = opts.error;
    if (opts.sentAt) updates.sentAt = opts.sentAt;
    if (opts.deliveredAt) updates.deliveredAt = opts.deliveredAt;
    if (opts.failedAt) updates.failedAt = opts.failedAt;

    await Message.updateOne({ _id: messageId }, { $set: updates }).exec();
  },
};

export default messageService;
