const fs = require("fs");
const path = require("path");

const pidFile = path.join(__dirname, ".static-server.pid");

module.exports = async () => {
  if (!fs.existsSync(pidFile)) return;
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  fs.rmSync(pidFile, { force: true });
  if (!Number.isFinite(pid)) return;
  try {
    process.kill(pid);
  } catch {
    // Server may already be stopped.
  }
};
