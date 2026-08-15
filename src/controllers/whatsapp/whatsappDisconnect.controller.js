import { disconnect } from "../../whatsapp/whatsappManager.js";

const whatsappDisconnectController = async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated",
      });
    }

    await disconnect(userId);

    return res.status(200).json({
      status: "success",
      message: "WhatsApp disconnected",
      connected: false,
    });
  } catch (err) {
    console.error("Error disconnecting WhatsApp:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to disconnect WhatsApp",
    });
  }
};

export default whatsappDisconnectController;