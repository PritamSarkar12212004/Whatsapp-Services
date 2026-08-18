/**
 * Pure helpers for the campaign service.
 *
 * @see campaign.service.js (main service that imports these)
 */

export const VALID_TRANSITIONS = {
  draft: ["scheduled", "queued", "running", "cancelled"],
  scheduled: ["queued", "running", "paused", "cancelled", "failed"],
  queued: ["running", "paused", "cancelled", "failed"],
  running: ["paused", "completed", "cancelled", "failed"],
  paused: ["running", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: ["queued", "running", "cancelled"],
};

export const canTransition = (from, to) => {
  const allowed = VALID_TRANSITIONS[from] || [];
  return allowed.includes(to);
};

/**
 * Lazy-load the Template model. Dynamic import is kept on purpose: the model
 * module participates in a circular dependency with campaign services.
 */
export const getTemplateModel = async () =>
  (await import("../../../models/messaging/template.model.js")).default;

/**
 * Lazy-load the Message model (same circular-dependency note as above).
 */
export const getMessageModel = async () =>
  (await import("../../../models/messaging/message.model.js")).default;
