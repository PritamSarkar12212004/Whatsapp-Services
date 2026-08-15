import fs from "fs";
import path from "path";

const AUTH_BASE_FOLDER = path.join(
  path.resolve(),
  "src/whatsapp/auth_info_baileys",
);

/**
 * Clear a specific user's auth state folder.
 * If userId is provided, clears only that user's folder.
 * If no userId, clears the entire auth folder (legacy/system).
 */
const clearAuthState = (userId) => {
  try {
    if (userId) {
      const userAuthPath = path.join(AUTH_BASE_FOLDER, userId);
      if (fs.existsSync(userAuthPath)) {
        fs.rmSync(userAuthPath, { recursive: true, force: true });
        console.log(`✅ WhatsApp auth state cleared for user ${userId}`);
      }
    } else {
      if (fs.existsSync(AUTH_BASE_FOLDER)) {
        fs.rmSync(AUTH_BASE_FOLDER, { recursive: true, force: true });
        console.log("✅ WhatsApp auth state cleared");
      }
    }
  } catch (err) {
    console.error("Error clearing auth state:", err.message);
  }
};

export default clearAuthState;