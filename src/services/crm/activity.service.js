import ContactActivity from "../../models/crm/contactActivity.model.js";

/**
 * Record an activity against a contact for audit/analytics.
 * Does NOT store sensitive message content — only metadata.
 */
const logActivity = async (ownerId, contactId, type, metadata = {}) => {
  try {
    await ContactActivity.create({
      owner: ownerId,
      contact: contactId,
      type,
      metadata,
    });
  } catch (err) {
    // Activity logging must never break the main flow
    console.error("[CRM] Failed to log activity:", err.message);
  }
};

/**
 * Retrieve recent activities for a contact (or for all contacts of an owner).
 */
const getActivityLog = (ownerId, contactId, options = {}) => {
  const filter = { owner: ownerId };
  if (contactId) filter.contact = contactId;
  const query = ContactActivity.find(filter).sort({ timestamp: -1 });
  if (options.limit) query.limit(Number(options.limit));
  return query.exec();
};

const activityService = {
  logActivity,
  getActivityLog,
};

export default activityService;
