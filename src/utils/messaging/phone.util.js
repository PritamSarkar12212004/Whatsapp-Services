/**
 * Phone number utilities for the CRM module.
 *
 * Normalization follows the EXISTING project convention:
 *   - digits only
 *   - 10-digit numbers are prefixed with "91"
 *   - a valid number is exactly 12 digits
 *
 * The normalized value (12-digit string) is what is stored on contacts
 * and expected by the existing whatsappModule.sendUserMessage transport.
 */
export const normalizePhoneNumber = (input) => {
  if (input === null || input === undefined) return null;
  let digits = String(input).replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length !== 12) return null;
  return digits;
};

export const isValidPhoneNumber = (input) =>
  normalizePhoneNumber(input) !== null;

/** Build the WhatsApp JID (remote Jid) from a normalized phone number. */
export const toWhatsAppId = (phoneNumber) => `${phoneNumber}@s.whatsapp.net`;

/**
 * Validate MongoDB ObjectId strings.
 * Returns true when the string is a valid ObjectId, false otherwise.
 */
export const isValidObjectId = (id) => {
  if (!id) return false;
  return /^[0-9a-fA-F]{24}$/.test(String(id));
};

export const assertValidObjectId = (id) => {
  if (!isValidObjectId(id)) {
    const err = new Error("Invalid identifier");
    err.statusCode = 400;
    throw err;
  }
  return id;
};
