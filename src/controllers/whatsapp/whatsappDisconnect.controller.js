import { logout } from "../../whatsapp/whatsappManager.js";

const whatsappDisconnectController = async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated",
      });
    }

    // FULL logout — device WhatsApp servers se unlink + auth state delete.
    // Next connect QR scan require karega. MongoDB data safe rehta hai.
    await logout(userId);

    return res.status(200).json({
      status: "success",
      message: "WhatsApp logged out — QR scan required to reconnect",
      connected: false,
    });
  } catch (err) {
    console.error("Error logging out WhatsApp:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to log out WhatsApp",
    });
  }
};

export default whatsappDisconnectController;