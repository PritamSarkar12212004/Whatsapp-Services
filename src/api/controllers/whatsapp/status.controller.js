import { getStatus } from "../../../integrations/whatsapp/manager.js";

const whatsappStatusController = async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated",
      });
    }

    // The selected number — `req.waKey` is the primary number when the client
    // did not ask for a specific one.
    const status = getStatus(req.waKey || userId);

    return res.status(200).json({
      status: status.status,
      connected: status.connected,
      phoneNumber: status.phoneNumber,
      // Milliseconds the socket has been stuck in "connecting" (null when it
      // is not connecting) — lets the client size up a wedged session.
      connectingFor: status.connectingFor ?? null,
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