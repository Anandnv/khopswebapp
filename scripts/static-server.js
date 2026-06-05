const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = 4173;
const reloadClients = new Set();
let reloadTimer = null;

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

function createLiveReloadSnippet() {
  return `<script>
(() => {
  if (window.__khLiveReloadConnected) return;
  window.__khLiveReloadConnected = true;

  let reconnectTimer = null;
  let reloadTimer = null;

  const connect = () => {
    const source = new EventSource("/__live_reload");

    source.addEventListener("reload", () => {
      clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => window.location.reload(), 120);
    });

    source.onerror = () => {
      source.close();
      clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, 1000);
    };
  };

  connect();
})();
</script>`;
}

function sendHtml(response, filePath) {
  fs.readFile(filePath, "utf8", (error, html) => {
    if (error) {
      send(response, 500, "Server error");
      return;
    }

    const withReloadClient = html.includes("</body>")
      ? html.replace("</body>", `${createLiveReloadSnippet()}\n  </body>`)
      : `${html}\n${createLiveReloadSnippet()}`;

    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(withReloadClient);
  });
}

function broadcastReload() {
  for (const response of reloadClients) {
    response.write("event: reload\ndata: now\n\n");
  }
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(broadcastReload, 80);
}

function watchProject() {
  const ignoredSegments = new Set([".git", "node_modules", "test-results"]);

  try {
    fs.watch(root, { recursive: true }, (eventType, fileName) => {
      if (!fileName) return;
      const parts = String(fileName).split(/[\\/]+/);
      if (parts.some((part) => ignoredSegments.has(part))) return;
      if (eventType === "rename" || eventType === "change") {
        scheduleReload();
      }
    });
  } catch (error) {
    console.warn("Live reload watcher could not start:", error.message);
  }
}

const server = http.createServer((request, response) => {
  const requestPath = decodeURIComponent((request.url || "/").split("?")[0]);

  if (requestPath === "/__live_reload") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive"
    });
    response.write("retry: 1000\n\n");
    reloadClients.add(response);
    request.on("close", () => reloadClients.delete(response));
    return;
  }

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
    if (ext === ".html") {
      sendHtml(response, safePath);
      return;
    }

    const contentType = mimeTypes[ext] || "application/octet-stream";
    const stream = fs.createReadStream(safePath);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    stream.pipe(response);
    stream.on("error", () => send(response, 500, "Server error"));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Static server running at http://127.0.0.1:${port}`);
});

watchProject();

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
