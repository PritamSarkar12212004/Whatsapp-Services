import { getSocket } from "../../../integrations/whatsapp/manager.js";

/**
 * Group pictures are a separate WhatsApp lookup per group, so they are cached
 * and the batch runs with a small concurrency + a total time budget. A slow
 * (or missing) picture must never hold the list back — the card just keeps
 * showing its initials tile.
 */
const pictureCache = new Map(); // `${userId}:${jid}` -> { url, at }
const PICTURE_TTL_MS = 30 * 60 * 1000;
const MISSING_PICTURE_TTL_MS = 10 * 60 * 1000;
const PICTURE_CONCURRENCY = 4;
const PICTURE_LOOKUP_MS = 2500;
const PICTURE_BUDGET_MS = 4000;

const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("lookup timed out")), ms);
    }),
  ]);
};

const cachedPicture = (userId, jid) => {
  const hit = pictureCache.get(`${userId}:${jid}`);
  if (!hit) return { known: false, url: null };
  const ttl = hit.url ? PICTURE_TTL_MS : MISSING_PICTURE_TTL_MS;
  if (Date.now() - hit.at > ttl) return { known: false, url: null };
  return { known: true, url: hit.url };
};

/**
 * Fill in the picture of every group, newest lookups first come first served.
 *
 * @returns {Promise<Map<String, String|null>>} jid -> picture url (null = none)
 */
export const loadGroupPictures = async (sock, userId, jids) => {
  const out = new Map();
  const queue = [...jids];
  const startedAt = Date.now();

  const worker = async () => {
    while (queue.length) {
      const jid = queue.shift();

      const cached = cachedPicture(userId, jid);
      if (cached.known) {
        out.set(jid, cached.url);
        continue;
      }

      // Budget spent — leave this one blank rather than a slow response.
      if (Date.now() - startedAt > PICTURE_BUDGET_MS) return;

      let url = null;
      try {
        url = (await withTimeout(sock.profilePictureUrl(jid, "image"), PICTURE_LOOKUP_MS)) || null;
      } catch {
        url = null; // no picture, private picture, or the lookup timed out
      }

      pictureCache.set(`${userId}:${jid}`, { url, at: Date.now() });
      out.set(jid, url);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PICTURE_CONCURRENCY, queue.length) }, worker),
  );

  return out;
};

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

    const rawList = Object.values(groups || {});

    // Fetched in one batch so the list still answers when WhatsApp is slow.
    const pictures = await loadGroupPictures(
      sock,
      userId,
      rawList.map((g) => g.id),
    );

    const list = rawList.map((g) => {
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
        profilePicUrl: pictures.get(g.id) || null,
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
