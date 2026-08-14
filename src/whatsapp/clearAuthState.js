import fs from "fs";
import path from "path";

const AUTH_FOLDER = path.join(
  path.resolve(),
  "src/whatsapp/auth_info_baileys",
);

const clearAuthState = () => {
  const authPath = path.resolve(AUTH_FOLDER);
  if (fs.existsSync(authPath)) {
    fs.rmSync(authPath, { recursive: true, force: true });
    console.log("✅ WhatsApp auth state cleared");
  }
};

export default clearAuthState;