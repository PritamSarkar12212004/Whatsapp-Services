/**
 * Pure helpers for the transactional message service.
 *
 * @see message.service.js (imports these)
 */

import { normalizePhoneNumber } from "../../../utils/messaging/phone.util.js";

/**
 * Normalize a `to` value (single or array) into a deduplicated list of valid
 * phone numbers. Throws a 400 error for any invalid recipient.
 */
export const normalizeRecipients = (to) => {
  const list = Array.isArray(to) ? to : [to];

  if (!to) {
    const e = new Error("Recipient 'to' is required");
    e.statusCode = 400;
    throw e;
  }

  const phoneNumbers = [];
  for (const raw of list) {
    const pn = normalizePhoneNumber(raw);
    if (!pn) {
      const e = new Error(`Invalid recipient phone number: ${raw}`);
      e.statusCode = 400;
      throw e;
    }
    if (!phoneNumbers.includes(pn)) phoneNumbers.push(pn);
  }

  if (phoneNumbers.length === 0) {
    const e = new Error("Recipient 'to' is required");
    e.statusCode = 400;
    throw e;
  }

  return phoneNumbers;
};

/**
 * Dev-mode gate: dev templates only run while at least one of their linked
 * campaigns is RUNNING (the campaign is the activation switch). On success,
 * counts the API call against the linked campaigns for live stats.
 *
 * @param {Object} Campaign - Campaign model
 * @param {String} ownerId
 * @param {Object} tmpl - template document (must have devMode)
 * @param {Number} count - number of recipients (for apiCalls increment)
 */
export const assertDevTemplateGate = async (Campaign, ownerId, tmpl, count) => {
  const linkedCampaigns = await Campaign.find({
    owner: ownerId,
    template: tmpl._id,
    status: { $ne: "cancelled" },
  })
    .select("status")
    .lean()
    .exec();

  if (linkedCampaigns.length === 0) {
    const e = new Error(
      "Dev template is not added to any campaign — create a campaign with this template first",
    );
    e.statusCode = 400;
    throw e;
  }

  const allPaused = linkedCampaigns.every((c) => c.status === "paused");
  if (allPaused) {
    const e = new Error(
      "Campaign is paused for this template — resume the campaign to enable API sends",
    );
    e.statusCode = 400;
    throw e;
  }

  const isRunning = linkedCampaigns.some((c) =>
    ["queued", "running"].includes(c.status),
  );
  if (!isRunning) {
    const e = new Error(
      "No running campaign for this template — start the campaign to enable API sends",
    );
    e.statusCode = 400;
    throw e;
  }

  // The gate passed — count this API call against the linked campaigns
  // so the dev-campaign live stats can show how many calls came in.
  await Campaign.updateMany(
    {
      owner: ownerId,
      template: tmpl._id,
      status: { $ne: "cancelled" },
    },
    { $inc: { "devStats.apiCalls": count } },
  ).exec();
};

/**
 * Infer the WhatsApp message type from a media URL / mimeType when the
 * template itself is text-only but a media override was provided.
 */
export const inferSendType = (templateType, renderedMedia) => {
  let sendType = templateType || "text";
  if (sendType === "text" && renderedMedia?.url) {
    const url = String(renderedMedia.url).toLowerCase();
    if (/\.(jpe?g|png|gif|webp|svg|bmp|ico)(\?|#|$)/.test(url)) sendType = "image";
    else if (/\.(mp4|webm|mov|mkv)(\?|#|$)/.test(url)) sendType = "video";
    else if (/\.(mp3|m4a|wav|ogg|aac)(\?|#|$)/.test(url)) sendType = "audio";
    else if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv)(\?|#|$)/.test(url)) sendType = "document";
    else {
      const mt = String(renderedMedia.mimeType || "").toLowerCase();
      if (mt.startsWith("image/")) sendType = "image";
      else if (mt.startsWith("video/")) sendType = "video";
      else if (mt.startsWith("audio/")) sendType = "audio";
      else if (/pdf|word|excel|powerpoint|officedocument/.test(mt))
        sendType = "document";
    }
  }
  return sendType;
};
