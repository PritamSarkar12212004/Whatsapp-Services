import { connect, getStatus } from "../../../integrations/whatsapp/manager.js";

const whatsappConnectController = async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated",
      });
    }

    const currentStatus = getStatus(userId);

    // Already connected
    if (currentStatus.connected) {
      return res.status(200).json({
        status: "success",
        message: "WhatsApp already connected",
        connected: true,
      });
    }

    // Already connecting
    if (currentStatus.status === "connecting" || currentStatus.status === "qr_required") {
      return res.status(200).json({
        status: "success",
        message: "WhatsApp connection is initializing",
        connected: false,
        status: currentStatus.status,
      });
    }

    // Start connection
    await connect(userId);

    const updatedStatus = getStatus(userId);

    return res.status(200).json({
      status: "success",
      message: "WhatsApp connection initiated",
      connected: updatedStatus.connected,
      status: updatedStatus.status,
    });
  } catch (err) {
    console.error("Error connecting WhatsApp:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to connect WhatsApp",
    });
  }
};

export default whatsappConnectController;