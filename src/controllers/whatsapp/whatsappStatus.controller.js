import { getStatus } from "../../whatsapp/whatsappManager.js";

const whatsappStatusController = async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated",
      });
    }

    const status = getStatus(userId);

    return res.status(200).json({
      status: "success",
      connected: status.connected,
      status: status.status,
      phoneNumber: status.phoneNumber,
    });
  } catch (err) {
    console.error("Error getting WhatsApp status:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to get WhatsApp status",
    });
  }
};

export default whatsappStatusController;