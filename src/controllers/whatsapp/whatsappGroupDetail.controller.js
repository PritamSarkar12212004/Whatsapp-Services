import { getSocket } from "../../whatsapp/whatsappManager.js";
import {
  getBinaryNodeChild,
  getBinaryNodeChildren,
} from "@whiskeysockets/baileys";

const cleanNumber = (value) => {
  if (!value) return null;
  const num = String(value).split("@")[0];
  return /^\d+$/.test(num) ? num : null;
};

const whatsappGroupDetailController = async (req, res) => {
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

    const jid = req.params.id;

    if (!jid) {
      return res.status(400).json({
        status: "error",
        message: "Group id is required",
      });
    }

    const meta = await sock.groupMetadata(jid);

    // Raw group metadata query — WhatsApp includes the real phone number in
    // each participant's `phone_number` attribute even when the participant
    // jid is a LID ("...@lid"). Baileys' extractGroupMetadata drops this
    // unless strict checks pass, so we parse it ourselves.
    const rawByJid = new Map();
    try {
      const rawResult = await sock.query({
        tag: "iq",
        attrs: { type: "get", xmlns: "w:g2", to: jid },
        content: [{ tag: "query", attrs: { request: "interactive" } }],
      });

      const groupNode = getBinaryNodeChild(rawResult, "group") || rawResult;

      for (const { attrs } of getBinaryNodeChildren(groupNode, "participant")) {
        const rawJid = attrs?.jid;
        if (!rawJid) continue;

        const pn = cleanNumber(attrs.phone_number) || null;
        const pnFromJid =
          String(rawJid).endsWith("@s.whatsapp.net")
            ? cleanNumber(rawJid)
            : null;

        rawByJid.set(rawJid, { pn: pn || pnFromJid, lid: attrs.lid || null });
      }
    } catch (err) {
      console.error("Raw group metadata query failed:", err.message);
    }

    const participants = [];
    for (const p of meta.participants || []) {
      const raw = rawByJid.get(p.id) || {};
      let number = raw.pn || null;

      // Fall back to the session's LID->PN mapping (learned from previous
      // interactions / contacts sync).
      let pnJid = null;
      if (!number && String(p.id).endsWith("@lid")) {
        try {
          pnJid =
            (await sock.signalRepository?.lidMapping?.getPNForLID(p.id)) ||
            null;
        } catch (_) {
          pnJid = null;
        }
      }

      if (!pnJid) pnJid = p.phoneNumber || null;
      if (!number && pnJid) number = cleanNumber(pnJid);

      if (!number && sock.contacts?.[p.id]?.phoneNumber) {
        number = cleanNumber(sock.contacts[p.id].phoneNumber);
      }

      if (!number) {
        for (const entry of Object.values(sock.contacts || {})) {
          if (entry?.lid === p.id && entry.phoneNumber) {
            number = cleanNumber(entry.phoneNumber);
            if (number) break;
          }
        }
      }

      const contact =
        sock.contacts?.[p.id] ||
        (pnJid ? sock.contacts?.[pnJid] : undefined);

      participants.push({
        jid: p.id,
        number,
        name: contact?.name || contact?.verifiedName || p.username || p.notify || null,
        isAdmin: Boolean(p.admin),
        isSuperAdmin: p.admin === "superadmin" || Boolean(p.isSuperAdmin),
      });

      // Persist the freshly learned mapping so future requests resolve fast.
      if (number && String(p.id).endsWith("@lid")) {
        try {
          await sock.signalRepository?.lidMapping?.storeLIDPNMappings([
            { lid: p.id, pn: `${number}@s.whatsapp.net` },
          ]);
        } catch (_) {
          // non-fatal
        }
      }
    }

    let profilePicUrl = null;
    try {
      profilePicUrl = (await sock.profilePictureUrl(jid, "image")) || null;
    } catch (_) {
      profilePicUrl = null;
    }

    // If the group belongs to a community, include the community's subject.
    let community = null;
    if (meta.linkedParent) {
      try {
        const parent = await sock.groupMetadata(meta.linkedParent);
        community = {
          jid: meta.linkedParent,
          subject: parent.subject || null,
        };
      } catch (_) {
        community = { jid: meta.linkedParent, subject: null };
      }
    }

    const ownerNumber =
      cleanNumber(meta.ownerPn) || cleanNumber(meta.owner) || null;

    // Whether the connected user is an admin here and can send messages
    // (announcement groups only allow admins to message).
    const meJids = [sock.user?.id, sock.user?.lid].filter(Boolean);
    const myParticipant = (meta.participants || []).find((p) =>
      meJids.includes(p.id),
    );
    const amIAdmin = Boolean(myParticipant?.admin);
    const isOwnedByMe = [meta.owner, meta.ownerPn]
      .filter(Boolean)
      .some((o) =>
        meJids.some(
          (m) => String(m).split("@")[0] === String(o).split("@")[0],
        ),
      );
    const canMessage = !meta.announce || amIAdmin || isOwnedByMe;

    return res.status(200).json({
      status: "success",
      data: {
        id: meta.id,
        subject: meta.subject || "Unnamed group",
        desc: meta.desc || null,
        size: meta.size ?? participants.length,
        isCommunity: Boolean(meta.isCommunity),
        isCommunityAnnounce: Boolean(meta.isCommunityAnnounce),
        restrict: Boolean(meta.restrict),
        announce: Boolean(meta.announce),
        memberAddMode: Boolean(meta.memberAddMode),
        joinApprovalMode: Boolean(meta.joinApprovalMode),
        creation: meta.creation || null,
        owner: meta.owner || null,
        ownerNumber,
        amIAdmin,
        canMessage,
        isOwnedByMe,
        inviteCode: meta.inviteCode || null,
        profilePicUrl,
        community,
        participants,
      },
    });
  } catch (err) {
    console.error("Error fetching WhatsApp group detail:", err.message);
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch WhatsApp group detail",
    });
  }
};

export default whatsappGroupDetailController;
