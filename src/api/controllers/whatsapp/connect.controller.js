import { connect, getStatus } from "../../../integrations/whatsapp/manager.js";

/**
 * A socket that has been "connecting" longer than this never produced a QR and
 * never opened — it is dead. Rebuilding it is the only way out, so the request
 * that reports the problem also clears it.
 *
 * @see armStuckWatchdog() in manager.js for the background version of this.
 */
const STUCK_CONNECT_MS = 30000;

const readForce = (req) => {
  const raw = req.body?.force ?? req.query?.force;
  return raw === true || raw === "true" || raw === "1";
};

const whatsappConnectController = async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated",
      });
    }

    const force = readForce(req);
    const currentStatus = getStatus(userId);

    // Already connected
    if (currentStatus.connected) {
      return res.status(200).json({
        status: "success",
        message: "WhatsApp already connected",
        connected: true,
        status: "connected",
      });
    }

    const stuck =
      currentStatus.status === "connecting" &&
      (currentStatus.connectingFor ?? 0) > STUCK_CONNECT_MS;

    // Already connecting (and still healthy) → nothing to do. Without the
    // stuck/force escape hatch a wedged socket answered "initializing"
    // forever and the app stayed on "Connecting to WhatsApp…".
    if (
      !force &&
      !stuck &&
      (currentStatus.status === "connecting" ||
        currentStatus.status === "qr_required")
    ) {
      return res.status(200).json({
        status: "success",
        message: "WhatsApp connection is initializing",
        connected: false,
        status: currentStatus.status,
      });
    }

    // Start (or restart) the connection
    await connect(userId, { force: force || stuck });

    const updatedStatus = getStatus(userId);

    return res.status(200).json({
      status: "success",
      message:
        force || stuck
          ? "WhatsApp connection restarted"
          : "WhatsApp connection initiated",
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