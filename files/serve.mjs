import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const HOST = "127.0.0.1";
const ROOT = resolve(".");
const DEFAULT_PORT = Number.parseInt(process.env.PORT ?? "8000", 10);

const MIME_TYPES = {
  ".css": "text/css; charset=UTF-8",
  ".html": "text/html; charset=UTF-8",
  ".js": "application/javascript; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".map": "application/json; charset=UTF-8",
  ".md": "text/markdown; charset=UTF-8",
  ".mjs": "application/javascript; charset=UTF-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function getFilePath(urlPath) {
  const safePath = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const requestedPath = safePath === "/" ? "/index.html" : safePath;
  const fullPath = resolve(join(ROOT, requestedPath));

  if (!fullPath.startsWith(ROOT)) {
    return null;
  }

  return fullPath;
}

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const filePath = getFilePath(url.pathname);

    if (!filePath) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=UTF-8" });
      res.end("Forbidden");
      return;
    }

    const body = await readFile(filePath);
    const contentType = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";

    res.writeHead(200, {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Content-Type": contentType
    });
    res.end(body);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=UTF-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(500, { "Content-Type": "text/plain; charset=UTF-8" });
    res.end("Internal server error");
  }
}

async function listenOnFreePort(server, startPort) {
  let port = Number.isFinite(startPort) ? startPort : 8000;

  while (port < startPort + 200) {
    const chosenPort = await new Promise((resolvePort, rejectPort) => {
      const onError = (error) => {
        server.off("listening", onListening);
        resolvePort(error);
      };

      const onListening = () => {
        server.off("error", onError);
        resolvePort(port);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, HOST);
    });

    if (typeof chosenPort === "number") {
      return chosenPort;
    }

    if (chosenPort && chosenPort.code === "EADDRINUSE") {
      port += 1;
      continue;
    }

    throw chosenPort;
  }

  throw new Error("No free port found in the checked range.");
}

const server = createServer(requestHandler);
const port = await listenOnFreePort(server, DEFAULT_PORT);

console.log("");
console.log(`Slides running at http://${HOST}:${port}`);
console.log("Press Ctrl+C to stop the server.");
