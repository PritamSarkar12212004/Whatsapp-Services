/**
 * Multi-number index migration.
 *
 * Before accounts existed, a login had exactly one number, so the indexes said
 * so: `WhatsAppSession.userId` was unique and group rules were unique on
 * `{ userId, groupJid }`. Both would keep blocking a SECOND number from having
 * its own session or its own rules for the same group, so they are replaced by
 * account-aware indexes.
 *
 * `syncIndexes()` drops the indexes the schema no longer declares and creates
 * the missing ones — no data is touched, and documents written before accounts
 * exist simply have no `accountId` field, which reads as the primary number
 * (MongoDB treats a missing field as null).
 */
import chalk from "chalk";
import WhatsAppSession from "../models/whatsapp/whatsappSession.model.js";
import groupManagerModel from "../models/whatsapp/groupManager.model.js";
import WhatsappAccount from "../models/whatsapp/whatsappAccount.model.js";

export const syncWhatsappAccountIndexes = async () => {
  try {
    for (const model of [WhatsAppSession, groupManagerModel, WhatsappAccount]) {
      await model.syncIndexes();
    }
    console.log(chalk.cyan("[Accounts] WhatsApp account indexes are in sync"));
  } catch (err) {
    // Index work must never stop the server: a stale index only affects the
    // extra numbers, while the primary number keeps working.
    console.error(
      chalk.yellow(`[Accounts] Index sync failed: ${err.message}`),
    );
  }
};

export default syncWhatsappAccountIndexes;
