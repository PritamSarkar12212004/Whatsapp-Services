import Database from "../config/database/database.js";

const initDatabase = async () => {
  await Database();
};

export default initDatabase;
