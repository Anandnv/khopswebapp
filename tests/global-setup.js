const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const pidFile = path.join(__dirname, ".static-server.pid");

function waitForServer(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(url, (response) => {
        response.resume();
        resolve();
      }).on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

module.exports = async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "static-server.js")], {
    cwd: path.join(__dirname, ".."),
    stdio: "ignore",
    detached: true
  });

  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), "utf8");
  await waitForServer("http://127.0.0.1:4173");
};
