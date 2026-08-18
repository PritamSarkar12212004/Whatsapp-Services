/**
 * Campaign audience generation + previews.
 *
 * `generateAudience` is standalone; the preview functions take the campaign
 * service instance as `service` so they can reuse getCampaign without a
 * circular import.
 *
 * @see campaign.service.js (delegates here)
 */

import Contact from "../../../models/messaging/contact.model.js";
import { normalizePhoneNumber } from "../../../utils/messaging/phone.util.js";
import { renderTemplate } from "../../../utils/messaging/template.util.js";
import { getTemplateModel } from "./campaign.helpers.js";

/**
 * Resolve the audience for a campaign from its audience config
 * (groups / tags / selected contacts minus excluded ones), excluding
 * blocked and opted-out contacts.
 *
 * @param {Object} campaign - campaign document (must have .owner and .audience)
 * @returns {Promise<{contacts: Array, excluded: number}>}
 */
export const generateAudience = async (campaign) => {
  const ownerId = campaign.owner;
  const { groups, tags, contacts: selected, excludedContacts } =
    campaign.audience || {};

  const orConditions = [];
  if (Array.isArray(groups) && groups.length) {
    orConditions.push({ customGroups: { $in: groups } });
  }
  if (Array.isArray(tags) && tags.length) {
    orConditions.push({ tags: { $in: tags } });
  }
  if (Array.isArray(selected) && selected.length) {
    orConditions.push({ _id: { $in: selected } });
  }

  // If no audience source is selected, there is nobody to send to
  if (!orConditions.length) {
    return { contacts: [], excluded: 0 };
  }

  const excludedIds = Array.from(
    new Set(
      (Array.isArray(excludedContacts) ? excludedContacts : [])
        .map((c) => c.toString())
        .filter(Boolean),
    ),
  );

  const baseMatch = {
    owner: ownerId,
    isBlocked: { $ne: true },
    isOptedOut: { $ne: true },
    $or: orConditions,
  };

  if (excludedIds.length) {
    baseMatch._id = { $nin: excludedIds };
  }

  const matched = await Contact.find(baseMatch)
    .select("_id phoneNumber name")
    .exec();

  // Count how many were excluded due to block/opt-out
  const blockExcludeMatch = {
    owner: ownerId,
    $or: [{ isBlocked: true }, { isOptedOut: true }],
  };
  if (excludedIds.length) {
    blockExcludeMatch._id = { $nin: excludedIds };
  }
  const excludedCount = await Contact.countDocuments(blockExcludeMatch).exec();

  return { contacts: matched, excluded: excludedCount };
};

/**
 * Preview the audience without creating recipients.
 * Returns { total, excluded, contacts: [{ _id, phoneNumber, name }] }
 */
export const previewAudience = async (service, ownerId, campaignId) => {
  const campaign = await service.getCampaign(ownerId, campaignId);
  const Template = await getTemplateModel();
  const template = await Template.findById(campaign.template).exec();
  const { contacts, excluded } = await generateAudience(campaign);
  // sendLimit = how many times each contact gets the message (repeat count)
  const repeats =
    campaign.sendLimit && campaign.sendLimit > 0 ? campaign.sendLimit : 1;
  return {
    total: contacts.length * repeats,
    people: contacts.length,
    sendsPerContact: repeats,
    excluded,
    template: template
      ? { name: template.name, content: template.content }
      : null,
    contacts: contacts.map((c) => ({
      _id: c._id,
      phoneNumber: c.phoneNumber,
      name: c.name,
    })),
  };
};

/**
 * Preview a single rendered message for a contact (by contactId or phoneNumber).
 */
export const previewMessage = async (service, ownerId, campaignId, identifier) => {
  const campaign = await service.getCampaign(ownerId, campaignId);
  const Template = await getTemplateModel();
  const template = await Template.findById(campaign.template).exec();
  if (!template) {
    const e = new Error("Template not found");
    e.statusCode = 404;
    throw e;
  }

  let contact;
  if (/^[0-9a-fA-F]{24}$/.test(String(identifier))) {
    contact = await Contact.findOne({ _id: identifier, owner: ownerId })
      .select("phoneNumber name")
      .exec();
  } else {
    const normalised = normalizePhoneNumber(identifier);
    if (normalised) {
      contact = await Contact.findOne({
        owner: ownerId,
        phoneNumber: normalised,
      })
        .select("phoneNumber name")
        .exec();
    }
  }

  const name = contact?.name || contact?.phoneNumber || "";
  const variables = { ...(campaign.variables || {}), name };
  const rendered = renderTemplate(template.content, variables);

  return {
    template: { name: template.name, content: template.content },
    contact: contact
      ? {
          _id: contact._id,
          phoneNumber: contact.phoneNumber,
          name: contact.name,
        }
      : null,
    rendered,
  };
};
