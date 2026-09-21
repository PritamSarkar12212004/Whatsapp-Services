/**
 * WhatsApp accounts — one login, several linked numbers.
 *
 * The primary number keeps the plain user id as its key, so everything stored
 * before multi-account (bots, group rules, the linked session) still belongs to
 * it. Every added number gets `userId::accountId`.
 *
 * Live state (QR, connecting, connected) comes from the session manager; the
 * database row only carries the label and the last known number/status so the
 * list still makes sense right after a restart.
 */
import chalk from "chalk";
import WhatsappAccount from "../../../models/whatsapp/whatsappAccount.model.js";
import { getStatus, logout } from "../../../integrations/whatsapp/manager.js";
import clearAuthState from "../../../integrations/whatsapp/clearAuthState.js";
import WhatsAppSession from "../../../models/whatsapp/whatsappSession.model.js";
import {
  buildWaKey,
  newAccountId,
  ACCOUNT_ID_PATTERN,
  PRIMARY_ACCOUNT_ID,
} from "../../../utils/whatsapp/accountKey.js";

const requireUser = (req, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ status: "error", message: "User not authenticated" });
    return null;
  }
  return userId;
};

/** Live session state merged with what the row remembers. */
const withLiveStatus = (account) => {
  const accountId = account.accountId ?? PRIMARY_ACCOUNT_ID;
  const key = buildWaKey(account.userId, accountId);
  const live = getStatus(key);

  return {
    accountId,
    label: account.label || "",
    isPrimary: !accountId,
    phoneNumber: live.phoneNumber || account.phoneNumber || null,
    profileName: account.profileName || null,
    status: live.status || account.status || "disconnected",
    connected: Boolean(live.connected),
    qrPending: live.status === "qr_required",
    lastConnectedAt: account.lastConnectedAt || null,
  };
};

/** The primary number always shows up, even before it ever connected. */
const ensurePrimaryRow = async (userId) =>
  WhatsappAccount.findOneAndUpdate(
    { userId, accountId: PRIMARY_ACCOUNT_ID },
    {
      $setOnInsert: { isPrimary: true, label: "" },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

export const listAccountsController = async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    await ensurePrimaryRow(userId);

    const accounts = await WhatsappAccount.find({ userId })
      .sort({ isPrimary: -1, createdAt: 1 })
      .lean();

    return res.status(200).json({
      status: "success",
      data: accounts.map(withLiveStatus),
    });
  } catch (err) {
    console.error("Error listing WhatsApp accounts:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to list WhatsApp accounts" });
  }
};

export const createAccountController = async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const label = String(req.body?.label ?? "")
      .trim()
      .slice(0, 40);

    const accountId = newAccountId();

    const account = await WhatsappAccount.create({
      userId,
      accountId,
      label: label || `Number ${accountId.slice(0, 4)}`,
      status: "disconnected",
    });

    console.log(
      chalk.cyan(`[Accounts] Added WhatsApp account ${accountId} for ${userId}`),
    );

    return res.status(201).json({
      status: "success",
      data: withLiveStatus(account.toObject()),
    });
  } catch (err) {
    console.error("Error creating WhatsApp account:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to add the number" });
  }
};

export const updateAccountController = async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { accountId } = req.params;
    if (accountId === "primary") {
      return res.status(400).json({
        status: "error",
        message: "The primary number cannot be renamed",
      });
    }

    const label = String(req.body?.label ?? "")
      .trim()
      .slice(0, 40);

    const account = await WhatsappAccount.findOneAndUpdate(
      { userId, accountId },
      { $set: { label } },
      { new: true },
    ).lean();

    if (!account) {
      return res
        .status(404)
        .json({ status: "error", message: "Unknown WhatsApp account" });
    }

    return res.status(200).json({ status: "success", data: withLiveStatus(account) });
  } catch (err) {
    console.error("Error updating WhatsApp account:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to update the number" });
  }
};

/**
 * Remove a number: unlink the device, drop its credentials, forget the row.
 * Anything the number created (bots, group rules) is kept in the database — it
 * simply becomes unreachable until a number with the same account id exists
 * again, which is deliberate: deleting them silently would be worse.
 */
export const deleteAccountController = async (req, res) => {
  try {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { accountId } = req.params;

    if (!ACCOUNT_ID_PATTERN.test(String(accountId ?? ""))) {
      return res
        .status(400)
        .json({ status: "error", message: "Unknown WhatsApp account" });
    }

    const account = await WhatsappAccount.findOne({ userId, accountId }).lean();
    if (!account) {
      return res
        .status(404)
        .json({ status: "error", message: "Unknown WhatsApp account" });
    }

    const key = buildWaKey(userId, accountId);

    try {
      await logout(key);
    } catch (err) {
      console.warn(`[Accounts] Logout failed for ${key}: ${err.message}`);
    }

    try {
      await clearAuthState(key);
    } catch (err) {
      console.warn(`[Accounts] Auth clear failed for ${key}: ${err.message}`);
    }

    await WhatsAppSession.deleteOne({ userId, accountId });
    await WhatsappAccount.deleteOne({ userId, accountId });

    console.log(chalk.yellow(`[Accounts] Removed WhatsApp account ${key}`));

    return res.status(200).json({ status: "success", removed: true });
  } catch (err) {
    console.error("Error removing WhatsApp account:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Failed to remove the number" });
  }
};

export default {
  listAccountsController,
  createAccountController,
  updateAccountController,
  deleteAccountController,
};
