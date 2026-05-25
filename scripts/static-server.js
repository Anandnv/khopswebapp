const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = 4173;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".sql": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function send(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "Content-Type": contentType });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const requestPath = decodeURIComponent((request.url || "/").split("?")[0]);
  const safePath = requestPath === "/"
    ? path.join(root, "index.html")
    : path.join(root, requestPath.replace(/^\/+/, ""));

  if (!safePath.startsWith(root)) {
    send(response, 403, "Forbidden");
    return;
  }

  fs.stat(safePath, (error, stats) => {
    if (error || !stats.isFile()) {
      send(response, 404, "Not found");
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = mimeTypes[ext] || "application/octet-stream";
    const stream = fs.createReadStream(safePath);
    response.writeHead(200, { "Content-Type": contentType });
    stream.pipe(response);
    stream.on("error", () => send(response, 500, "Server error"));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Static server running at http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
