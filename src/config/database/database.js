import mongoose from "mongoose";
import DataBaseLog from "../../logs/database/DataBaseLog.js";
import chalk from "chalk";

/**
 * Keep the (owner, whatsappJid) unique index limited to REAL JIDs only
 * (partial index on string whatsappJid). Manual contacts have no
 * whatsappJid at all, so they must never collide with each other.
 * A plain unique index treats `null` as a real value (allowing only one
 * null-JID doc per owner); a sparse index still indexes explicit nulls.
 * Run once on startup, idempotent.
 */
const migrateContactJidIndex = async (db) => {
  const IDX_NAME = "owner_1_whatsappJid_1";
  try {
    const coll = db.collection("contacts");
    if (!coll) return;

    const indexes = await coll.indexes();
    const jidIdx = indexes.find((i) => i.name === IDX_NAME);
    const isPartial = jidIdx && jidIdx.partialFilterExpression;
    if (jidIdx && !isPartial) {
      await coll.dropIndex(IDX_NAME);
      console.log(
        chalk.yellow(`[DB] Dropped ${IDX_NAME} index (contacts) — not partial`),
      );
    }

    const hasPartial = await coll
      .indexes()
      .then((list) =>
        list.some(
          (i) => i.name === IDX_NAME && i.partialFilterExpression,
        ),
      );
    if (!hasPartial) {
      await coll.createIndex(
        { owner: 1, whatsappJid: 1 },
        {
          unique: true,
          partialFilterExpression: { whatsappJid: { $type: "string" } },
          name: IDX_NAME,
        },
      );
      console.log(
        chalk.green(`[DB] Created partial unique ${IDX_NAME} index (contacts)`),
      );
    }
  } catch (err) {
    // Never block startup on a migration issue — log and continue.
    console.log(chalk.yellow(`[DB] Contact JID index migration skipped: ${err.message}`));
  }
};

/**
 * Campaign recipients may repeat (sendLimit = copies per contact), so the
 * uniqueness moves from (campaign, contact) to (campaign, contact, sequence).
 * Drop the old unique index and create the new one. Idempotent.
 */
const migrateCampaignRecipientIndex = async (db) => {
  const OLD_IDX = "campaign_1_contact_1";
  const NEW_IDX = "campaign_1_contact_1_sequence_1";
  try {
    const coll = db.collection("campaignrecipients");
    if (!coll) return;

    const indexes = await coll.indexes();
    if (indexes.some((i) => i.name === OLD_IDX)) {
      await coll.dropIndex(OLD_IDX);
      console.log(
        chalk.yellow(`[DB] Dropped ${OLD_IDX} index (campaignrecipients)`),
      );
    }

    if (!(await coll.indexes()).some((i) => i.name === NEW_IDX)) {
      await coll.createIndex(
        { campaign: 1, contact: 1, sequence: 1 },
        { unique: true, name: NEW_IDX },
      );
      console.log(
        chalk.green(`[DB] Created unique ${NEW_IDX} index (campaignrecipients)`),
      );
    }
  } catch (err) {
    console.log(
      chalk.yellow(
        `[DB] Campaign recipient index migration skipped: ${err.message}`,
      ),
    );
  }
};

const Database = async () => {
  try {
    const DB_URI = `mongodb+srv://${process.env.MONGO_USER_NAME}:${process.env.MONGO_URL}@${process.env.MONGO_CLUSTER}/${process.env.MONGO_DB_NAME}?retryWrites=true&w=majority`;

    const connection = await mongoose.connect(DB_URI, {
      serverSelectionTimeoutMS: 5000,
    });

    // Keep contact dedupe index in sync with the schema definition
    await migrateContactJidIndex(connection.connection.db);
    // Allow repeated recipients (sendLimit = copies per contact)
    await migrateCampaignRecipientIndex(connection.connection.db);

    console.log(
      chalk.green(
        DataBaseLog.STARTUP_DATABASE(
          connection.connection.name,
          connection.connection.host,
        ),
      ),
    );
  } catch (error) {
    console.log(DataBaseLog.STARTUP_ERROR_DATABASE(error.message));
    process.exit(1);
  }
};

export default Database;