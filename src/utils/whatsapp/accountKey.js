/**
 * WhatsApp accounts — one login can hold several linked numbers.
 *
 * HOW IT WORKS
 * ------------
 * A "key" is the single string the whole WhatsApp layer is indexed by: the
 * session map, the Baileys auth state (ownerKey) and the stored data. The
 * account that already existed keeps the plain `userId` key, so nothing has to
 * be migrated; every number added later gets `${userId}::${accountId}`.
 *
 *     primary number ....... 65f1c0...           (accountId = null)
 *     a second number ...... 65f1c0...::a1b2c3   (accountId = "a1b2c3")
 *
 * Only `parseWaKey` may split a key — never `String.split("::")` inline.
 */

/** The account that has no id: the login's first, already-connected number. */
export const PRIMARY_ACCOUNT_ID = null;

/** MongoDB-safe account id (also used in folder names, so keep it simple). */
export const ACCOUNT_ID_PATTERN = /^[a-z0-9]{6,32}$/;

export const buildWaKey = (userId, accountId) =>
  accountId ? `${String(userId)}::${String(accountId)}` : String(userId ?? "");

/**
 * Split a key back into the login user + account.
 * Anything without the separator is the primary account.
 */
export const parseWaKey = (key) => {
  const raw = String(key ?? "");
  const at = raw.indexOf("::");
  if (at === -1) return { userId: raw, accountId: PRIMARY_ACCOUNT_ID };
  return {
    userId: raw.slice(0, at),
    accountId: raw.slice(at + 2) || PRIMARY_ACCOUNT_ID,
  };
};

/** Key shaped for the legacy auth folder path (`::` is not folder friendly). */
export const folderSafeKey = (key) => String(key ?? "").replace(/::/g, "__");

/**
 * Mongo filter that scopes a collection to one account.
 * The primary account stores `accountId: null`, which also matches every
 * document written before accounts existed.
 */
export const accountScope = (key) => {
  const { userId, accountId } = parseWaKey(key);
  return { userId, accountId };
};

/** Short, readable id: 8 lowercase alphanumerics. */
export const newAccountId = () =>
  Math.random().toString(36).slice(2, 6) + Date.now().toString(36).slice(-4);

export default {
  PRIMARY_ACCOUNT_ID,
  ACCOUNT_ID_PATTERN,
  buildWaKey,
  parseWaKey,
  folderSafeKey,
  accountScope,
  newAccountId,
};
