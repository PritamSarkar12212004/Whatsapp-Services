import { getQR } from "../../../integrations/whatsapp/manager.js";

const whatsappQRController = async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated",
      });
    }

    const qr = getQR(userId);

    if (!qr) {
      return res.status(200).json({
        status: "success",
        qr: null,
        available: false,
      });
    }

    return res.status(200).json({
      status: "success",
      qr,
      available: true,
    });
  } catch (err) {
    console.error("Error getting QR:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to get QR code",
    });
  }
};

export default whatsappQRController;