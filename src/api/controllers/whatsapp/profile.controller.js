import { getSocket } from "../../../integrations/whatsapp/manager.js";

const whatsappProfileController = async (req, res) => {
  try {
    const userId = req.user.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated",
      });
    }

    const sock = getSocket(req.waKey || userId);

    if (!sock) {
      return res.status(400).json({
        status: "error",
        message: "WhatsApp is not connected",
      });
    }

    const myJid = sock.user?.id;
    const phoneNumber = myJid?.split(":")[0] || null;

    // Display name: prefer the creds name, fall back to the synced contact.
    let name = sock.user?.name || null;
    if (!name && myJid) {
      name = sock.contacts?.[myJid]?.name || null;
    }

    // About / status text.
    let about = null;
    if (myJid) {
      try {
        const statusResult = await sock.fetchStatus(myJid);
        about = statusResult?.[0]?.status || null;
      } catch (err) {
        console.error("Error fetching WhatsApp status:", err.message);
      }
    }

    // Profile picture URL (undefined / throws when none is set).
    let profilePicUrl = null;
    if (myJid) {
      try {
        profilePicUrl =
          (await sock.profilePictureUrl(myJid, "image")) || null;
      } catch (err) {
        profilePicUrl = null;
      }
    }

    return res.status(200).json({
      status: "success",
      data: {
        name,
        about,
        phoneNumber,
        profilePicUrl,
      },
    });
  } catch (err) {
    console.error("Error getting WhatsApp profile:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to get WhatsApp profile",
    });
  }
};

export default whatsappProfileController;
