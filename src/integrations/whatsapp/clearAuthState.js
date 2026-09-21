import fs from "fs";
import path from "path";
import { clearMongoAuthState, SYSTEM_OWNER_KEY } from "./authState.js";
import { folderSafeKey } from "../../utils/whatsapp/accountKey.js";

/**
 * LEGACY on-disk auth folder.
 *
 * Auth state now lives in MongoDB (see ./authState.js) because the production
 * filesystem is ephemeral, but the disk copy is still cleared here so a stale
 * folder can never resurrect an old session on the next restart.
 *
 * Root folder = the system (OTP) socket, subfolders = one per user.
 */
const AUTH_BASE_FOLDER = path.join(
  path.resolve(),
  "src/whatsapp/auth_info_baileys",
);

/**
 * Clear auth state for one user, or for the system socket when no id is given.
 *
 * `userId` is optional purely for backward compatibility with existing calls:
 *   clearAuthState(userId) -> that user's state
 *   clearAuthState()       -> the system socket's state
 *
 * NOTE: for the system scope only the ROOT-LEVEL files are removed — the root
 * folder also contains the per-user subfolders, which must stay intact.
 */
const clearAuthState = async (userId) => {
  const scope = userId ? String(userId) : SYSTEM_OWNER_KEY;
  const label = userId ? `for user ${userId}` : "(system socket)";

  // 1. MongoDB — the authoritative store.
  try {
    const deleted = await clearMongoAuthState(scope);
    console.log(
      `✅ WhatsApp auth state cleared ${label} in MongoDB (${deleted} doc(s))`,
    );
  } catch (err) {
    console.error("Error clearing Mongo auth state:", err.message);
  }

  // 2. Legacy disk copy.
  try {
    if (userId) {
      // Account keys look like `userId::accountId`; folders use `__` instead.
      const userAuthPath = path.join(AUTH_BASE_FOLDER, folderSafeKey(userId));
      if (fs.existsSync(userAuthPath)) {
        fs.rmSync(userAuthPath, { recursive: true, force: true });
        console.log(`✅ WhatsApp auth folder removed for user ${userId}`);
      }
    } else if (fs.existsSync(AUTH_BASE_FOLDER)) {
      const files = fs.readdirSync(AUTH_BASE_FOLDER, { withFileTypes: true });
      let removed = 0;
      for (const entry of files) {
        if (!entry.isFile()) continue; // keep per-user subfolders
        fs.rmSync(path.join(AUTH_BASE_FOLDER, entry.name), { force: true });
        removed += 1;
      }
      if (removed) {
        console.log(`✅ WhatsApp auth files removed (${removed} file(s))`);
      }
    }
  } catch (err) {
    console.error("Error clearing auth state:", err.message);
  }
};

export default clearAuthState;
