import mongoose from "mongoose";
import DataBaseLog from "../logs/database/DataBaseLog.js";
import chalk from "chalk";

const Database = async () => {
  try {
    const DB_URI = `mongodb+srv://${process.env.MONGO_USER_NAME}:${process.env.MONGO_URL}@${process.env.MONGO_CLUSTER}/${process.env.MONGO_DB_NAME}?retryWrites=true&w=majority`;

    const connection = await mongoose.connect(DB_URI, {
      serverSelectionTimeoutMS: 5000,
    });

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