import { getSocket } from "../../whatsapp/whatsappManager.js";

const cleanNumber = (value) => {
  if (!value) return null;
  const num = String(value).split("@")[0];
  return /^\d+$/.test(num) ? num : null;
};

const whatsappGroupsController = async (req, res) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({
        status: "error",
        message: "User not authenticated",
      });
    }

    const sock = getSocket(userId);

    if (!sock) {
      return res.status(400).json({
        status: "error",
        message: "WhatsApp is not connected",
      });
    }

    const groups = await sock.groupFetchAllParticipating();

    // The connected user's own identifiers (PN and/or LID) to detect groups
    // this account owns vs groups owned by someone else.
    const meJids = [sock.user?.id, sock.user?.lid].filter(Boolean);

    const isMe = (jid) => meJids.includes(jid);

    const isOwnedByMe = (meta) => {
      const candidates = [meta.owner, meta.ownerPn]
        .filter(Boolean)
        .map((j) => String(j).split("@")[0]);
      return candidates.some((c) =>
        meJids.some((m) => String(m).split("@")[0] === c),
      );
    };

    const myAdminStatus = (meta) => {
      const me = (meta.participants || []).find((p) => isMe(p.id));
      return Boolean(me?.admin);
    };

    const list = Object.values(groups || {}).map((g) => {
      const amIAdmin = myAdminStatus(g);

      return {
        id: g.id,
        subject: g.subject || "Unnamed group",
        desc: g.desc || null,
        size: g.size ?? g.participants?.length ?? 0,
        isCommunity: Boolean(g.isCommunity),
        isCommunityAnnounce: Boolean(g.isCommunityAnnounce),
        linkedParent: g.linkedParent || null,
        creation: g.creation || null,
        restrict: Boolean(g.restrict),
        announce: Boolean(g.announce),
        isOwnedByMe: isOwnedByMe(g),
        ownerNumber: cleanNumber(g.ownerPn) || cleanNumber(g.owner),
        amIAdmin,
        // In announcement groups only admins can message.
        canMessage: !g.announce || amIAdmin || isOwnedByMe(g),
      };
    });

    // Communities first, then alphabetical by name.
    list.sort((a, b) => {
      if (a.isCommunity !== b.isCommunity) {
        return a.isCommunity ? -1 : 1;
      }
      return a.subject.localeCompare(b.subject);
    });

    return res.status(200).json({
      status: "success",
      data: list,
    });
  } catch (err) {
    console.error("Error fetching WhatsApp groups:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch WhatsApp groups",
    });
  }
};

export default whatsappGroupsController;
