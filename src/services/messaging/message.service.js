import Message from "../../models/messaging/message.model.js";
import Contact from "../../models/messaging/contact.model.js";
import Campaign from "../../models/messaging/campaign.model.js";
import activityService from "./activity.service.js";
import templateService from "./template.service.js";
import { normalizePhoneNumber } from "../../utils/messaging/phone.util.js";
import {
  normalizeRecipients,
  assertDevTemplateGate,
  inferSendType,
} from "./message/message.helpers.js";

// See: ./message/message.helpers.js (recipient normalize, dev gate, type infer)
import {
  renderTemplate,
  renderTemplateMedia,
} from "../../utils/messaging/template.util.js";
import campaignQueue from "../../jobs/campaign.queue.js";

const messageService = {
  /**
   * External/backend-to-backend transactional send.
   *
   * Flow: validate recipient -> find template -> render variables ->
   * create message -> queue -> send via existing Baileys transport ->
   * update status.
   */
  async sendTransactional(ownerId, payload) {
    const { template, variables = {} } = payload;
    const phoneNumbers = normalizeRecipients(payload.to);

    // Find template (owner-scoped)
    const tmpl = await templateService.findTemplate(ownerId, template);

    // Dev-mode templates only run when one of their campaigns is RUNNING.
    // The campaign is the activation gate:
    //  - no (non-cancelled) campaign      -> blocked ("not added")
    //  - campaigns exist, all paused      -> blocked ("paused")
    //  - campaigns exist but none running -> blocked ("not running")
    //  - at least one queued/running      -> allowed
    if (tmpl.devMode) {
      await assertDevTemplateGate(Campaign, ownerId, tmpl, phoneNumbers.length);
    }

    const rendered = renderTemplate(tmpl.content, variables);
    // Media can be overridden per call (dynamic link); falls back to the
    // template's own media when not provided.
    const renderedMedia = renderTemplateMedia(payload.media || tmpl.media, variables);

    // When a media override is sent with a text template, infer the media
    // type from the URL extension so the file actually gets sent as media.
    // Extension-less URLs (e.g. gstatic/encrypted image links) fall back to
    // the provided mimeType.
    const sendType = inferSendType(tmpl.type, renderedMedia);

    // Scheduled? Future date -> message is created as "scheduled" and the
    // queue auto-starts it when the time arrives.
    let scheduledAt = null;
    if (payload.scheduledAt) {
      const d = new Date(payload.scheduledAt);
      if (Number.isNaN(d.getTime())) {
        const e = new Error("scheduledAt must be a valid date (24h format)");
        e.statusCode = 400;
        throw e;
      }
      if (d.getTime() > Date.now()) scheduledAt = d;
    }

    const messages = [];
    for (const phoneNumber of phoneNumbers) {
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

      // Create a message record (outbound, from the API).
      // template + source are set so dev-campaign stats can count calls.
      const message = await Message.create({
        owner: ownerId,
        contact: contactId,
        direction: "outbound",
        type: sendType,
        content: rendered,
        to: phoneNumber,
        status: scheduledAt ? "scheduled" : "queued",
        scheduledAt,
        template: tmpl._id,
        source: "api",
        media: renderedMedia || tmpl.media || null,
      });
      messages.push(message);

      await activityService.logActivity(ownerId, contactId, "message_sent", {
        messageId: message._id,
      });

      // Immediate delivery (or the scheduled sweep will pick it up later)
      if (!scheduledAt) {
        await campaignQueue.enqueueMessage({
          messageId: message._id.toString(),
          ownerId: ownerId.toString(),
          phoneNumber,
          rendered,
          type: sendType,
          media: renderedMedia || tmpl.media || null,
          campaignId: null,
        });
      }
    }

    return { messages, rendered };
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
   * Cancel a pending message (scheduled / queued / sending / pending).
   * The queue skips it because the record is no longer "queued" when the
   * worker picks it up; scheduled messages are not picked by the sweep.
   */
  async cancelMessage(ownerId, id) {
    const message = await Message.findOne({ _id: id, owner: ownerId }).exec();
    if (!message) {
      const e = new Error("Message not found");
      e.statusCode = 404;
      throw e;
    }
    if (["sent", "delivered", "read", "failed", "cancelled", "skipped"].includes(message.status)) {
      const e = new Error(`Message already ${message.status} — cannot cancel`);
      e.statusCode = 400;
      throw e;
    }
    message.status = "cancelled";
    await message.save();
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
