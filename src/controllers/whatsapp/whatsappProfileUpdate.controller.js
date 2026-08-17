import { getSocket } from "../../whatsapp/whatsappManager.js";

/**
 * Returns the connected socket for the authenticated user, or sends a 4xx
 * response and returns null when unavailable.
 */
const getConnectedSocket = (req, res) => {
  const userId = req.user?.userId;

  if (!userId) {
    res.status(401).json({
      status: "error",
      message: "User not authenticated",
    });
    return null;
  }

  const sock = getSocket(userId);

  if (!sock) {
    res.status(400).json({
      status: "error",
      message: "WhatsApp is not connected",
    });
    return null;
  }

  return sock;
};

const sendError = (res, err) => {
  console.error("Error updating WhatsApp profile:", err.message);
  return res.status(500).json({
    status: "error",
    message: "Failed to update WhatsApp profile",
  });
};

const updateProfileNameController = async (req, res) => {
  try {
    const sock = getConnectedSocket(req, res);
    if (!sock) return;

    const name = req.body?.name;

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        status: "error",
        message: "Name is required",
      });
    }

    await sock.updateProfileName(String(name).trim());

    return res.status(200).json({
      status: "success",
      message: "Profile name updated",
    });
  } catch (err) {
    return sendError(res, err);
  }
};

const updateProfileAboutController = async (req, res) => {
  try {
    const sock = getConnectedSocket(req, res);
    if (!sock) return;

    const about = req.body?.about;

    if (typeof about !== "string") {
      return res.status(400).json({
        status: "error",
        message: "About text is required",
      });
    }

    await sock.updateProfileStatus(about.trim());

    return res.status(200).json({
      status: "success",
      message: "Profile about updated",
    });
  } catch (err) {
    return sendError(res, err);
  }
};

const updateProfilePictureController = async (req, res) => {
  try {
    const sock = getConnectedSocket(req, res);
    if (!sock) return;

    const image = req.body?.image;

    if (!image || typeof image !== "string") {
      return res.status(400).json({
        status: "error",
        message: "Image is required",
      });
    }

    // Accept either a raw base64 string or a data URL ("data:image/...;base64,...").
    const base64 = image.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64, "base64");

    if (!buffer.length) {
      return res.status(400).json({
        status: "error",
        message: "Invalid image data",
      });
    }

    await sock.updateProfilePicture(sock.user?.id, buffer);

    return res.status(200).json({
      status: "success",
      message: "Profile picture updated",
    });
  } catch (err) {
    return sendError(res, err);
  }
};

export {
  updateProfileNameController,
  updateProfileAboutController,
  updateProfilePictureController,
};
