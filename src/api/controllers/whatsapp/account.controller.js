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

/** Digits only — users paste "+91 98765 43210", "(0)98765…" and so on. */
export const normalizePhone = (value) =>
  String(value ?? "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");

/** WhatsApp international numbers are 8–15 digits including the country code. */
export const isValidPhone = (value) => {
  const digits = normalizePhone(value);
  return digits.length >= 8 && digits.length <= 15;
};

/**
 * Same number, however it happens to be formatted?
 * WhatsApp reports the linked number as `919999999999`; someone may have typed
 * `09999999999`. Comparing the national part avoids a false alarm.
 */
export const sameNumber = (a, b) => {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  if (!left || !right) return true; // nothing to compare → not a mismatch
  if (left === right) return true;
  return left.slice(-10) === right.slice(-10);
};

/**
 * Does this row already hold `digits`?
 *
 * Unlike `sameNumber`, blanks never match — otherwise a row with no number yet
 * would look like a duplicate of everything.
 */
export const rowHasNumber = (row, digits) => {
  const target = normalizePhone(digits);
  if (target.length < 7) return false;

  return [row?.phoneNumber, row?.expectedPhoneNumber]
    .map((value) => normalizePhone(value))
    .some(
      (value) => value.length >= 7 && value.slice(-10) === target.slice(-10),
    );
};

/** Live session state merged with what the row remembers. */
const withLiveStatus = (account) => {
  const accountId = account.accountId ?? PRIMARY_ACCOUNT_ID;
  const key = buildWaKey(account.userId, accountId);
  const live = getStatus(key);

  const linkedNumber = live.phoneNumber || account.phoneNumber || null;
  const expected = account.expectedPhoneNumber || null;

  return {
    accountId,
    label: account.label || "",
    isPrimary: !accountId,
    /** The number as WhatsApp reports it (falls back to what was stored). */
    phoneNumber: linkedNumber,
    /** What the user entered when adding the number. */
    expectedPhoneNumber: expected,
    /** Typed and linked numbers disagree — the UI warns about it. */
    numberMismatch: Boolean(
      expected && linkedNumber && !sameNumber(expected, linkedNumber),
    ),
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

    // The number is required and validated here as well as in the UI — a
    // half-saved number would leave the accounts list showing nonsense.
    const phoneNumber = normalizePhone(req.body?.phoneNumber);

    if (!isValidPhone(phoneNumber)) {
      return res.status(400).json({
        status: "error",
        message:
          "Enter a valid WhatsApp number with its country code (8–15 digits)",
      });
    }

    // The same number twice would leave two sessions fighting over one WhatsApp
    // account, so it is refused up front (numbers already linked included).
    const known = await WhatsappAccount.find({ userId }).lean();
    const already = known.find((row) => rowHasNumber(row, phoneNumber));

    if (already) {
      return res.status(409).json({
        status: "error",
        message: `+${phoneNumber} is already added — remove it first or pick another number`,
      });
    }

    const accountId = newAccountId();

    const account = await WhatsappAccount.create({
      userId,
      accountId,
      label: label || `Number ${accountId.slice(0, 4)}`,
      // Remember what was typed so a wrong-number scan can be spotted later.
      expectedPhoneNumber: phoneNumber,
      phoneNumber,
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
  rowHasNumber,
  normalizePhone,
  isValidPhone,
  sameNumber,
  listAccountsController,
  createAccountController,
  updateAccountController,
  deleteAccountController,
};
