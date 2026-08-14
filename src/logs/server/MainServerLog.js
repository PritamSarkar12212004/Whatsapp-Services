const getEnv = () => process.env.NODE_ENV || "development";

const MainServerLog = {
  STARTUP_LOG: (PORT) => `
╔══════════════════════════════════════════════╗
║        🚀 SERVER STARTED SUCCESSFULLY        ║
╠══════════════════════════════════════════════╣
║   🌐 Port      : ${PORT}
║   🔧 Env       : ${getEnv()}
║   🚀 Status    : Running
╠══════════════════════════════════════════════╣
║   🤖 Monolith : Auth + OTP + WhatsApp merged ║
╚══════════════════════════════════════════════╝`,
  SERVER_STARTUP_ERROR_LOG: (err, PORT) => `
╔══════════════════════════════════════════════╗
║        ❌ SERVER STARTUP FAILED              ║
╠══════════════════════════════════════════════╣
║   🌐 Port      : ${PORT}
║   🔧 Env       : ${getEnv()}
║   ❌ Error     : ${err?.message || err}
╚══════════════════════════════════════════════╝`,
};

export default MainServerLog;