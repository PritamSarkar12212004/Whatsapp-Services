const DataBaseLog = {
  STARTUP_DATABASE: (name, host) => `
╔══════════════════════════════════════════════╗
║        🍃 DATABASE CONNECTED SUCCESSFULLY    ║
╠══════════════════════════════════════════════╣
║   🗄️  Database  : ${name}
║   🖥️  Host      : ${host}
╠══════════════════════════════════════════════╣
║   ✅ Status    : Connected
╚══════════════════════════════════════════════╝`,
  STARTUP_ERROR_DATABASE: (message) => `
╔══════════════════════════════════════════════╗
║        ❌ DATABASE CONNECTION FAILED         ║
╠══════════════════════════════════════════════╣
║   ❌ Error     : ${message}
╚══════════════════════════════════════════════╝`,
};

export default DataBaseLog;