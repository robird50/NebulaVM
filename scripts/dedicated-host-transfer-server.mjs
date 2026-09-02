import { timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const configPath = process.argv[2];
if (!configPath) throw new Error("A private transfer configuration path is required.");

const config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
const expectedToken = Buffer.from(String(config.token || ""), "utf8");
const expectedAddress = String(config.allowedAddress || "").trim();
const entries = new Map(Object.entries(config.files || {}));

const normalizedAddress = (value) => String(value || "").replace(/^::ffff:/i, "");
const authorized = (request) => {
  const remoteAddress = normalizedAddress(request.socket.remoteAddress);
  if (remoteAddress !== expectedAddress && remoteAddress !== "127.0.0.1" && remoteAddress !== "::1") {
    return false;
  }
  const supplied = Buffer.from(
    String(request.headers.authorization || "").replace(/^Bearer\s+/i, ""),
    "utf8",
  );
  return supplied.length === expectedToken.length && timingSafeEqual(supplied, expectedToken);
};

const json = (response, status, body) => {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  response.end(payload);
};

const streamFile = (request, response, entry) => {
  const stats = statSync(entry.path);
  let start = 0;
  let end = stats.size - 1;
  let status = 200;
  const range = String(request.headers.range || "").match(/^bytes=(\d+)-(\d*)$/i);
  if (range) {
    start = Number(range[1]);
    end = range[2] ? Math.min(Number(range[2]), end) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stats.size) {
      response.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
      response.end();
      return;
    }
    status = 206;
  }

  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Length": end - start + 1,
    "Content-Disposition": `attachment; filename="${String(entry.name).replace(/["\r\n]/g, "")}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${stats.size}`;
  response.writeHead(status, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(entry.path, { start, end }).pipe(response);
};

const server = createServer((request, response) => {
  if (!authorized(request)) {
    json(response, 403, { ok: false, error: "This transfer is private." });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    json(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }
  if (request.url === "/manifest") {
    json(response, 200, {
      ok: true,
      files: Object.fromEntries(
        [...entries].map(([id, entry]) => [
          id,
          { name: entry.name, size: statSync(entry.path).size, sha256: entry.sha256 },
        ]),
      ),
    });
    return;
  }
  const match = String(request.url || "").match(/^\/files\/([a-z-]+)$/);
  const entry = match ? entries.get(match[1]) : null;
  if (!entry) {
    json(response, 404, { ok: false, error: "Transfer file not found." });
    return;
  }
  streamFile(request, response, entry);
});

server.listen(Number(config.port), String(config.bindAddress || "0.0.0.0"), () => {
  writeFileSync(config.readyPath, new Date().toISOString(), "utf8");
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
