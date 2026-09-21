import WhatsappAccount from "../models/whatsapp/whatsappAccount.model.js";
import {
  buildWaKey,
  PRIMARY_ACCOUNT_ID,
  ACCOUNT_ID_PATTERN,
} from "../utils/whatsapp/accountKey.js";

/**
 * Which WhatsApp number the request is about.
 *
 * The client sends the number it has selected in the sidebar as
 * `x-wa-account: <accountId>`. No header (or an empty one) means the primary
 * number — that keeps every existing client, cron job and test working exactly
 * as before.
 *
 * Sets, for the rest of the request:
 *   req.waAccountId  null for the primary number, else the account id
 *   req.waKey        the key the WhatsApp layer is indexed by
 *   req.waAccount    the account document (null when it doesn't exist yet)
 */
const whatsappAccountMiddleware = async (req, res, next) => {
  try {
    const raw = req.headers?.["x-wa-account"];
    const accountId = String(raw ?? "").trim();

    const userId = req.user?.userId;

    // No header → primary number, no lookup needed.
    if (!accountId || !userId) {
      req.waAccountId = PRIMARY_ACCOUNT_ID;
      req.waKey = userId ? buildWaKey(userId, PRIMARY_ACCOUNT_ID) : null;
      req.waAccount = null;
      return next();
    }

    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      return res
        .status(400)
        .json({ status: "error", message: "Unknown WhatsApp account" });
    }

    const account = await WhatsappAccount.findOne({ userId, accountId }).lean();

    // A removed (or someone else's) account must never fall back to the
    // primary number — that would silently send from the wrong number.
    if (!account) {
      return res
        .status(404)
        .json({ status: "error", message: "Unknown WhatsApp account" });
    }

    req.waAccountId = accountId;
    req.waKey = buildWaKey(userId, accountId);
    req.waAccount = account;

    return next();
  } catch (err) {
    console.error("[Accounts] resolve failed:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Could not resolve WhatsApp account" });
  }
};

export default whatsappAccountMiddleware;
