import { defineConfig } from "vite";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import dgram from "node:dgram";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import net from "node:net";
import { cpus, networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const hostTokenPath = resolve(workspaceDir, ".nebulavm-host-token");
const publicUrlPath = resolve(workspaceDir, ".nebulavm-public-url");
const guestCredentialsPath = resolve(workspaceDir, ".nebulavm-guest-credentials.json");

const localEnvValue = (name) => {
  if (process.env[name]) return process.env[name];

  for (const filename of [".env.local", ".env"]) {
    const envPath = resolve(workspaceDir, filename);
    if (!existsSync(envPath)) continue;

    const line = readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((entry) => entry.trim().startsWith(`${name}=`));
    if (!line) continue;

    return line
      .slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  }

  return "";
};

const resolveHostAccessToken = () => {
  const environmentToken = String(process.env.NEBULAVM_HOST_TOKEN || "").trim();
  if (environmentToken) return environmentToken;
  if (existsSync(hostTokenPath)) {
    const savedToken = readFileSync(hostTokenPath, "utf8").trim();
    if (savedToken) return savedToken;
  }

  const token = randomBytes(24).toString("hex");
  writeFileSync(hostTokenPath, token, { encoding: "utf8", mode: 0o600 });
  return token;
};

const hostAccessToken = resolveHostAccessToken();

const sanitizeGuestUsername = (value) => {
  const username = String(value || "Nebula").trim();
  if (!username || username.length > 20 || /[\\/:;"|=,+*?<>@\[\]]/.test(username)) {
    throw new Error("Windows username must be 1-20 characters and cannot contain Windows account symbols.");
  }
  return username;
};

const loadGuestCredentials = () => {
  const fallback = {
    username: "Nebula",
    adminPassword: "",
    passwordDisabled: false,
    vncPassword: randomBytes(4).toString("hex"),
    createdAt: new Date().toISOString(),
  };

  if (!existsSync(guestCredentialsPath)) {
    return fallback;
  }

  try {
    const saved = JSON.parse(readFileSync(guestCredentialsPath, "utf8").replace(/^\uFEFF/, ""));
    return {
      ...fallback,
      ...saved,
      username: saved.username || fallback.username,
      vncPassword: saved.vncPassword || fallback.vncPassword,
      passwordDisabled: Boolean(saved.passwordDisabled),
    };
  } catch {
    return fallback;
  }
};

const saveGuestCredentials = (body = {}) => {
  const current = loadGuestCredentials();
  const username = sanitizeGuestUsername(body.username);
  const passwordDisabled = Boolean(body.passwordDisabled);
  const adminPassword = passwordDisabled ? "" : String(body.adminPassword || "");
  if (!passwordDisabled && !adminPassword) {
    throw new Error("Enter a Windows password or turn password off.");
  }

  const credentials = {
    username,
    adminPassword,
    passwordDisabled,
    vncPassword: current.vncPassword || randomBytes(4).toString("hex"),
    createdAt: current.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(guestCredentialsPath, JSON.stringify(credentials, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    ok: true,
    username,
    passwordDisabled,
  };
};

const requestHostname = (req) => {
  try {
    return new URL(`http://${req.headers.host || "localhost"}`).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const isLoopbackRequest = (req) => {
  const hostname = requestHostname(req);
  const remoteAddress = String(req.socket?.remoteAddress || "").toLowerCase();
  const loopbackHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const loopbackConnection =
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";
  return loopbackHost && loopbackConnection;
};

const requestAccessToken = (req, url) => {
  const authorization = String(req.headers.authorization || "");
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return url.searchParams.get("token") || "";
};

const isAuthorizedHostRequest = (req, url) =>
  isLoopbackRequest(req) || requestAccessToken(req, url) === hostAccessToken;

const primaryLanAddress = () =>
  new Promise((resolveAddress) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const finish = (address = "") => {
      if (settled) return;
      settled = true;
      socket.close();
      resolveAddress(address);
    };
    socket.once("error", () => finish());
    socket.connect(53, "1.1.1.1", () => finish(socket.address().address));
  });

const lanAddresses = async () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter(
      (address) =>
        address &&
        address.family === "IPv4" &&
        !address.internal &&
        !address.address.startsWith("169.254."),
    )
    .map((address) => address.address);
  const primary = await primaryLanAddress();
  return [...new Set([primary, ...addresses].filter(Boolean))];
};

const resolveCommitId = () => {
  if (process.env.COMMIT_REF) {
    return process.env.COMMIT_REF.slice(0, 7);
  }

  const gitCommands = ["git", "C:\\Program Files\\Git\\cmd\\git.exe"];
  for (const gitCommand of gitCommands) {
    try {
      return execFileSync(gitCommand, ["rev-parse", "--short", "HEAD"], {
        cwd: workspaceDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // Try the next Git path.
    }
  }

  return "local";
};

const commitId = resolveCommitId();

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const setNativeQemuCors = (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    [
      "Authorization",
      "Content-Type",
      "X-NebulaVM-Chunk-End",
      "X-NebulaVM-Chunk-Start",
      "X-NebulaVM-Filename",
      "X-NebulaVM-Session",
      "X-NebulaVM-Total-Bytes",
      "X-NebulaVM-Upload-Id",
    ].join(", "),
  );
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Vary", "Origin");
};

const json = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
};

const readJsonBody = (req) =>
  new Promise((resolveBody, rejectBody) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        rejectBody(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        rejectBody(new Error("Invalid JSON body."));
      }
    });
    req.on("error", rejectBody);
  });

const mobileDevAttempts = new Map();
const mobileDevMaxAttempts = 5;
const mobileDevLockMs = 5 * 60 * 1000;

const sha256Hex = (value) => createHash("sha256").update(String(value)).digest("hex");

const configuredMobileDevCodeHash = () => {
  const directHash = String(localEnvValue("NEBULAVM_MOBILE_DEV_CODE_HASH") || "").trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(directHash)) return directHash;

  const rawCode = String(localEnvValue("NEBULAVM_MOBILE_DEV_CODE") || "").trim();
  if (/^\d{6}$/.test(rawCode)) return sha256Hex(rawCode);

  return "";
};

const safeEqualHex = (left, right) => {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const mobileDevClientKey = (req) => {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const remoteAddress = String(req.socket?.remoteAddress || "");
  const userAgent = String(req.headers["user-agent"] || "").slice(0, 180);
  return sha256Hex(`${forwardedFor || remoteAddress}|${userAgent}`);
};

const verifyMobileDevUnlock = (req, body = {}) => {
  const expectedHash = configuredMobileDevCodeHash();
  if (!expectedHash) {
    return { status: 503, body: { ok: false, error: "Mobile developer unlock is not configured." } };
  }

  const code = String(body.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return { status: 400, body: { ok: false, error: "Enter the 6-digit developer code." } };
  }

  const key = mobileDevClientKey(req);
  const saved = mobileDevAttempts.get(key) || { attempts: 0, lockUntil: 0 };
  const lockRemainingMs = Math.max(0, Number(saved.lockUntil || 0) - Date.now());
  if (lockRemainingMs > 0) {
    return {
      status: 429,
      body: {
        ok: false,
        error: "Too many misses. Try again later.",
        lockRemainingMs,
        remainingAttempts: 0,
      },
    };
  }

  if (safeEqualHex(sha256Hex(code), expectedHash)) {
    mobileDevAttempts.set(key, { attempts: 0, lockUntil: 0 });
    return { status: 200, body: { ok: true } };
  }

  const attempts = Number(saved.attempts || 0) + 1;
  const shouldLock = attempts >= mobileDevMaxAttempts;
  mobileDevAttempts.set(key, {
    attempts: shouldLock ? 0 : attempts,
    lockUntil: shouldLock ? Date.now() + mobileDevLockMs : 0,
  });

  return {
    status: 401,
    body: {
      ok: false,
      error: shouldLock ? "Locked for 5 minutes." : "Incorrect developer code.",
      remainingAttempts: shouldLock ? 0 : mobileDevMaxAttempts - attempts,
      lockRemainingMs: shouldLock ? mobileDevLockMs : 0,
    },
  };
};

const isoImportDirectory = resolve(workspaceDir, "vm-disks", "imports");
const browserUploadDirectory = resolve(isoImportDirectory, "browser-sessions");
const storedIsoDirectory = resolve(isoImportDirectory, "stored-isos");
const storedIsoManifestPath = resolve(storedIsoDirectory, "stored-isos.json");
const storedIsoLimit = 2;
const storedIsoTtlMs = 3 * 24 * 60 * 60 * 1000;

const sanitizeFilename = (value) => {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return cleaned || "nebulavm.iso";
};

const sanitizeSessionId = (value) => {
  const cleaned = String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return cleaned || randomBytes(8).toString("hex");
};

const sanitizeUploadId = (value) => {
  const cleaned = String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return cleaned || randomBytes(8).toString("hex");
};

const browserUploadSessionDirectory = (sessionId) => {
  const safeSessionId = sanitizeSessionId(sessionId);
  const sessionDirectory = resolve(browserUploadDirectory, safeSessionId);
  const root = browserUploadDirectory.endsWith(sep) ? browserUploadDirectory : `${browserUploadDirectory}${sep}`;
  if (!sessionDirectory.startsWith(root)) {
    throw new Error("Invalid browser upload session.");
  }
  return { safeSessionId, sessionDirectory };
};

const cleanupBrowserIsoUploadSession = (sessionId) => {
  const { safeSessionId, sessionDirectory } = browserUploadSessionDirectory(sessionId);
  if (existsSync(sessionDirectory)) {
    rmSync(sessionDirectory, { recursive: true, force: true });
  }
  return {
    ok: true,
    message: "Browser-staged ISO removed from the NebulaVM host.",
    sessionId: safeSessionId,
  };
};

const isPathInsideDirectory = (candidatePath, parentDirectory) => {
  const resolvedCandidate = resolve(candidatePath);
  const resolvedParent = resolve(parentDirectory);
  const root = resolvedParent.endsWith(sep) ? resolvedParent : `${resolvedParent}${sep}`;
  return resolvedCandidate.toLowerCase().startsWith(root.toLowerCase());
};

const storedIsoFileKey = ({ fileKey, name, size }) =>
  String(fileKey || `${name || ""}:${Number(size) || 0}`).trim().slice(0, 240);

const loadStoredIsoManifest = () => {
  if (!existsSync(storedIsoManifestPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(storedIsoManifestPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const saveStoredIsoManifest = (items) => {
  mkdirSync(storedIsoDirectory, { recursive: true });
  writeFileSync(storedIsoManifestPath, JSON.stringify(items, null, 2), "utf8");
};

const storedIsoSnapshot = (item) => ({
  id: item.id,
  name: item.name,
  fileKey: item.fileKey,
  size: Number(item.size) || 0,
  isoPath: item.isoPath,
  storedAt: item.storedAt,
  expiresAt: item.expiresAt,
});

const cleanupStoredIsos = () => {
  const now = Date.now();
  const current = loadStoredIsoManifest();
  const kept = [];
  let changed = false;

  for (const item of current) {
    const expired = Date.parse(item.expiresAt || "") <= now;
    const missing = !item.isoPath || !existsSync(item.isoPath);
    if (expired || missing) {
      if (item.isoPath && existsSync(item.isoPath) && isPathInsideDirectory(item.isoPath, storedIsoDirectory)) {
        rmSync(item.isoPath, { force: true });
      }
      changed = true;
      continue;
    }
    kept.push(item);
  }

  if (changed) {
    saveStoredIsoManifest(kept);
  }

  return kept.map(storedIsoSnapshot);
};

const listStoredIsos = () => ({
  ok: true,
  limit: storedIsoLimit,
  ttlHours: Math.round(storedIsoTtlMs / 60 / 60 / 1000),
  items: cleanupStoredIsos(),
});

const removeStoredIso = (id) => {
  const safeId = sanitizeUploadId(id);
  const items = cleanupStoredIsos();
  const target = items.find((item) => item.id === safeId);
  if (!target) {
    return {
      ok: true,
      removed: false,
      limit: storedIsoLimit,
      items,
    };
  }

  if (target.isoPath && existsSync(target.isoPath) && isPathInsideDirectory(target.isoPath, storedIsoDirectory)) {
    rmSync(target.isoPath, { force: true });
  }

  const nextItems = items.filter((item) => item.id !== safeId);
  saveStoredIsoManifest(nextItems);
  return {
    ok: true,
    removed: true,
    limit: storedIsoLimit,
    items: nextItems,
  };
};

const storeBrowserIsoOnHost = (body) => {
  const sourcePath = stripPathQuotes(body.isoPath);
  if (!sourcePath || !isAbsolute(sourcePath) || !existsSync(sourcePath)) {
    throw new Error("The staged ISO was not found on the host computer.");
  }
  if (!isPathInsideDirectory(sourcePath, isoImportDirectory) || isPathInsideDirectory(sourcePath, storedIsoDirectory)) {
    throw new Error("Only NebulaVM-staged ISOs can be saved as stored images.");
  }

  const name = sanitizeFilename(body.name || body.fileName || sourcePath.split(/[\\/]/).pop() || "stored.iso");
  const size = Number(body.size) || statSync(sourcePath).size;
  const fileKey = storedIsoFileKey({ fileKey: body.fileKey, name, size });
  const current = cleanupStoredIsos();
  const existing = current.find((item) => item.fileKey === fileKey || (item.name === name && Number(item.size) === size));
  if (existing) {
    rmSync(sourcePath, { force: true });
    if (body.sessionId) {
      cleanupBrowserIsoUploadSession(body.sessionId);
    }
    return {
      ok: true,
      duplicate: true,
      limit: storedIsoLimit,
      item: existing,
      items: current,
    };
  }

  if (current.length >= storedIsoLimit) {
    return {
      ok: false,
      slotLimitReached: true,
      error: `Stored ISO slots are full. Remove an ISO before saving another one.`,
      limit: storedIsoLimit,
      items: current,
    };
  }

  mkdirSync(storedIsoDirectory, { recursive: true });
  const id = sanitizeUploadId(randomBytes(8).toString("hex"));
  const mediaName = /\.(iso|img|bin|raw)$/i.test(name) ? name : `${name}.iso`;
  const storedPath = resolve(storedIsoDirectory, `${id}-${mediaName}`);
  renameSync(sourcePath, storedPath);
  if (body.sessionId) {
    cleanupBrowserIsoUploadSession(body.sessionId);
  }

  const storedAt = new Date();
  const item = {
    id,
    name: mediaName,
    fileKey,
    size,
    isoPath: storedPath,
    storedAt: storedAt.toISOString(),
    expiresAt: new Date(storedAt.getTime() + storedIsoTtlMs).toISOString(),
  };
  const items = [...current, item].map(storedIsoSnapshot);
  saveStoredIsoManifest(items);

  return {
    ok: true,
    duplicate: false,
    limit: storedIsoLimit,
    item: storedIsoSnapshot(item),
    items,
  };
};

const decodeHeaderFilename = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const saveBrowserIsoUpload = async (req) => {
  const { safeSessionId, sessionDirectory } = browserUploadSessionDirectory(req.headers["x-nebulavm-session"]);
  cleanupBrowserIsoUploadSession(safeSessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const headerName = decodeHeaderFilename(req.headers["x-nebulavm-filename"]);
  const baseName = sanitizeFilename(headerName || "browser-upload.iso");
  const mediaName = /\.(iso|img|bin|raw)$/i.test(baseName) ? baseName : `${baseName}.iso`;
  const finalPath = resolve(sessionDirectory, `${Date.now()}-${mediaName}`);
  const tempPath = `${finalPath}.part`;

  try {
    await pipeline(req, createWriteStream(tempPath));
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  const bytesReceived = existsSync(tempPath) ? statSync(tempPath).size : 0;
  if (bytesReceived <= 0) {
    rmSync(tempPath, { force: true });
    throw new Error("The browser upload was empty.");
  }
  renameSync(tempPath, finalPath);

  return {
    ok: true,
    message: "Browser ISO uploaded to the NebulaVM host.",
    isoPath: finalPath,
    bytesReceived,
    sessionId: safeSessionId,
  };
};

const readHeaderInteger = (req, name) => {
  const value = Number(req.headers[name]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name} header.`);
  }
  return value;
};

const saveBrowserIsoUploadChunk = async (req) => {
  const { safeSessionId, sessionDirectory } = browserUploadSessionDirectory(req.headers["x-nebulavm-session"]);
  const uploadId = sanitizeUploadId(req.headers["x-nebulavm-upload-id"]);
  const chunkStart = readHeaderInteger(req, "x-nebulavm-chunk-start");
  const chunkEnd = readHeaderInteger(req, "x-nebulavm-chunk-end");
  const totalBytes = readHeaderInteger(req, "x-nebulavm-total-bytes");
  if (chunkEnd <= chunkStart || chunkEnd > totalBytes) {
    throw new Error("Invalid browser upload chunk range.");
  }

  mkdirSync(sessionDirectory, { recursive: true });

  const headerName = decodeHeaderFilename(req.headers["x-nebulavm-filename"]);
  const baseName = sanitizeFilename(headerName || "browser-upload.iso");
  const mediaName = /\.(iso|img|bin|raw)$/i.test(baseName) ? baseName : `${baseName}.iso`;
  const finalPath = resolve(sessionDirectory, `${uploadId}-${mediaName}`);
  const tempPath = `${finalPath}.part`;

  if (existsSync(finalPath) && statSync(finalPath).size === totalBytes) {
    return {
      ok: true,
      complete: true,
      message: "Browser ISO uploaded to the NebulaVM host.",
      isoPath: finalPath,
      bytesReceived: totalBytes,
      sessionId: safeSessionId,
    };
  }

  const currentSize = existsSync(tempPath) ? statSync(tempPath).size : 0;
  if (currentSize > chunkStart) {
    if (currentSize >= chunkEnd) {
      return {
        ok: true,
        complete: false,
        message: "Browser ISO chunk was already staged.",
        bytesReceived: currentSize,
        totalBytes,
        sessionId: safeSessionId,
      };
    }
    throw new Error("Browser upload resume point is inconsistent.");
  }
  if (currentSize < chunkStart) {
    throw new Error("Browser upload is missing an earlier chunk.");
  }

  try {
    await pipeline(req, createWriteStream(tempPath, { flags: chunkStart === 0 ? "w" : "a" }));
  } catch (error) {
    if (existsSync(tempPath)) {
      truncateSync(tempPath, chunkStart);
    }
    throw error;
  }

  const bytesReceived = existsSync(tempPath) ? statSync(tempPath).size : 0;
  if (bytesReceived < chunkEnd) {
    truncateSync(tempPath, chunkStart);
    throw new Error("Browser upload chunk ended before all bytes were received.");
  }
  if (bytesReceived === totalBytes) {
    renameSync(tempPath, finalPath);
    return {
      ok: true,
      complete: true,
      message: "Browser ISO uploaded to the NebulaVM host.",
      isoPath: finalPath,
      bytesReceived,
      totalBytes,
      sessionId: safeSessionId,
    };
  }

  return {
    ok: true,
    complete: false,
    message: "Browser ISO chunk staged.",
    bytesReceived,
    totalBytes,
    sessionId: safeSessionId,
  };
};

const stripPathQuotes = (value) => String(value || "").trim().replace(/^"|"$/g, "");

const candidateExecutables = (name) => {
  const pathExts = (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  const pathDirs = (process.env.PATH || "").split(";").filter(Boolean);
  const qemuDirs = [
    "C:\\Program Files\\qemu",
    "C:\\Program Files (x86)\\qemu",
    "C:\\msys64\\mingw64\\bin",
  ];
  const dirs = [...pathDirs, ...qemuDirs];
  const names = name.toLowerCase().endsWith(".exe") ? [name] : [name, ...pathExts.map((ext) => `${name}${ext}`)];
  return dirs.flatMap((dir) => names.map((exe) => join(dir, exe)));
};

const findExecutable = (name) => candidateExecutables(name).find((candidate) => existsSync(candidate));

const findFirmware = (arch, qemuPath) => {
  const qemuDir = qemuPath ? dirname(qemuPath) : "";
  const candidates =
    arch === "aarch64"
      ? [
          join(qemuDir, "share", "edk2-aarch64-code.fd"),
          join(qemuDir, "..", "share", "edk2-aarch64-code.fd"),
          "C:\\Program Files\\qemu\\share\\edk2-aarch64-code.fd",
          "C:\\Program Files\\qemu\\share\\qemu\\edk2-aarch64-code.fd",
        ]
      : [
          join(qemuDir, "share", "edk2-x86_64-code.fd"),
          join(qemuDir, "..", "share", "edk2-x86_64-code.fd"),
          "C:\\Program Files\\qemu\\share\\edk2-x86_64-code.fd",
          "C:\\Program Files\\qemu\\share\\qemu\\edk2-x86_64-code.fd",
        ];
  return candidates.map((candidate) => normalize(candidate)).find((candidate) => existsSync(candidate));
};

const findFirmwareVars = (arch, qemuPath) => {
  const qemuDir = qemuPath ? dirname(qemuPath) : "";
  const candidates =
    arch === "aarch64"
      ? [
          join(qemuDir, "share", "edk2-aarch64-vars.fd"),
          join(qemuDir, "..", "share", "edk2-aarch64-vars.fd"),
          join(qemuDir, "share", "edk2-arm-vars.fd"),
          join(qemuDir, "..", "share", "edk2-arm-vars.fd"),
          "C:\\Program Files\\qemu\\share\\edk2-aarch64-vars.fd",
          "C:\\Program Files\\qemu\\share\\edk2-arm-vars.fd",
          "C:\\Program Files\\qemu\\share\\qemu\\edk2-aarch64-vars.fd",
          "C:\\Program Files\\qemu\\share\\qemu\\edk2-arm-vars.fd",
        ]
      : [
          join(qemuDir, "share", "edk2-x86_64-vars.fd"),
          join(qemuDir, "..", "share", "edk2-x86_64-vars.fd"),
          "C:\\Program Files\\qemu\\share\\edk2-x86_64-vars.fd",
          "C:\\Program Files\\qemu\\share\\qemu\\edk2-x86_64-vars.fd",
        ];
  return candidates.map((candidate) => normalize(candidate)).find((candidate) => existsSync(candidate));
};

let nativeVm = null;
let nativeVmOutput = "";
let lastNativeExit = null;
let activeNativeRuntimeName = null;
const nativeVncHost = "127.0.0.1";
const nativeVncPath = "/api/native-qemu/vnc";
const hyperVGuestVncPath = "/api/emustar-hyperv/vnc";
const hyperVScriptPath = resolve(workspaceDir, "scripts", "emustar-hyperv.ps1");
const hyperVConsoleFrameScriptPath = resolve(workspaceDir, "scripts", "emustar-console-frame.ps1");
const hyperVConsoleInputScriptPath = resolve(workspaceDir, "scripts", "emustar-console-input.ps1");
const hyperVConsoleFramePath = resolve(workspaceDir, "vm-disks", "emustar-hyperv", "console-frame.jpg");

const runHyperVAction = (action, config = {}, timeoutMs = 30000) =>
  new Promise((resolveAction, rejectAction) => {
    const configBase64 = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
    let settled = false;
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        hyperVScriptPath,
        "-Action",
        action,
        "-ConfigBase64",
        configBase64,
      ],
      {
        cwd: workspaceDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => rejectAction(new Error(`${action} timed out while waiting for Hyper-V.`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(() => rejectAction(error)));
    child.on("exit", (code) => {
      finish(() => {
        const output = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
        try {
          const result = JSON.parse(output || "{}");
          if (code === 0 && result.ok !== false) {
            resolveAction(result);
            return;
          }
          rejectAction(new Error(result.error || stderr.trim() || `Hyper-V action failed with code ${code}.`));
        } catch {
          rejectAction(new Error(stderr.trim() || stdout.trim() || `Hyper-V action failed with code ${code}.`));
        }
      });
    });
  });

const runPowerShellJson = (label, args, timeoutMs = 30000) =>
  new Promise((resolveAction, rejectAction) => {
    let settled = false;
    const child = spawn("powershell.exe", args, {
      cwd: workspaceDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => rejectAction(new Error(`${label} timed out.`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(() => rejectAction(error)));
    child.on("exit", (code) => {
      finish(() => {
        const output = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
        try {
          const result = JSON.parse(output || "{}");
          if (code === 0 && result.ok !== false) {
            resolveAction(result);
            return;
          }
          rejectAction(new Error(result.error || stderr.trim() || `${label} failed with code ${code}.`));
        } catch {
          rejectAction(new Error(stderr.trim() || stdout.trim() || `${label} failed with code ${code}.`));
        }
      });
    });
  });

const runHyperVConsoleFrame = () =>
  runPowerShellJson(
    "Hyper-V setup console frame",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      hyperVConsoleFrameScriptPath,
      "-OutputPath",
      hyperVConsoleFramePath,
    ],
    45000,
  );

const runHyperVConsoleInput = (body) =>
  runPowerShellJson(
    "Hyper-V setup console input",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      hyperVConsoleInputScriptPath,
      "-ConfigBase64",
      Buffer.from(JSON.stringify(body || {}), "utf8").toString("base64"),
    ],
    45000,
  );

const isPortAvailable = (port) =>
  new Promise((resolvePort) => {
    const server = net.createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, nativeVncHost, () => {
      server.close(() => resolvePort(true));
    });
  });

const findAvailableVncDisplay = async () => {
  for (let display = 10; display < 100; display += 1) {
    const port = 5900 + display;
    if (await isPortAvailable(port)) {
      return { display, port };
    }
  }

  throw new Error("No local VNC ports are available for the native QEMU display.");
};

const waitForTcpPort = async (port, timeoutMs = 8000) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise((resolveConnection) => {
      const socket = net.connect(port, nativeVncHost);
      socket.once("connect", () => {
        socket.end();
        resolveConnection(true);
      });
      socket.once("error", () => resolveConnection(false));
      socket.setTimeout(400, () => {
        socket.destroy();
        resolveConnection(false);
      });
    });

    if (connected) return;
    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 150);
    });
  }

  throw new Error("Native QEMU started, but its embedded display did not become available.");
};

const canConnectToTcpPort = (host, port, timeoutMs = 700) =>
  new Promise((resolveConnection) => {
    if (!host) {
      resolveConnection(false);
      return;
    }
    const socket = net.connect(port, host);
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnection(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });

const withHyperVDisplayStatus = async (status) => {
  const addresses = (status.vm?.ipAddresses || [])
    .filter((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address))
    .sort((left, right) => {
      const leftIsDisplay = left.startsWith("192.168.231.");
      const rightIsDisplay = right.startsWith("192.168.231.");
      return Number(rightIsDisplay) - Number(leftIsDisplay);
    });
  const connectivity = await Promise.all(
    addresses.map(async (address) => ({
      address,
      reachable: await canConnectToTcpPort(address, 5900),
    })),
  );
  const guestAddress =
    connectivity.find(({ reachable }) => reachable)?.address || addresses[0] || null;
  const vncReady = connectivity.some(({ reachable }) => reachable);
  let vncPassword = "";
  if (existsSync(guestCredentialsPath)) {
    try {
      const credentials = JSON.parse(
        readFileSync(guestCredentialsPath, "utf8").replace(/^\uFEFF/, ""),
      );
      vncPassword = credentials.vncPassword || "";
    } catch {
      vncPassword = "";
    }
  }
  return {
    ...status,
    guestAddress,
    vncPath: hyperVGuestVncPath,
    vncReady,
    vncPassword,
  };
};

const normalizeArch = (arch) => (arch === "aarch64" ? "aarch64" : "x86_64");

const normalizeNativeProfile = (profile, arch) => {
  if (arch === "aarch64" && profile === "ubuntu-arm64") return "ubuntu-arm64";
  if (arch === "aarch64") return "windows-arm64";
  return "generic-x64";
};

const nativeDiskName = (profile) => {
  if (profile === "ubuntu-arm64") return "nebulavm-native-ubuntu-arm64.qcow2";
  if (profile === "windows-arm64") return "nebulavm-native-arm64.qcow2";
  return "nebulavm-native.qcow2";
};

const nativeVarsName = (profile) => {
  if (profile === "ubuntu-arm64") return "nebulavm-native-ubuntu-arm64-vars.fd";
  if (profile === "windows-arm64") return "nebulavm-native-arm64-vars.fd";
  return "nebulavm-native-vars.fd";
};

const resetNativeFirmware = (body) => {
  if (nativeVm) {
    throw new Error("Stop EMUSTAR before resetting its UEFI settings.");
  }

  const arch = normalizeArch(body.arch);
  const profile = normalizeNativeProfile(body.profile, arch);
  const qemu = findExecutable(arch === "aarch64" ? "qemu-system-aarch64" : "qemu-system-x86_64");
  const varsTemplate = findFirmwareVars(arch, qemu);
  if (!qemu || !varsTemplate) {
    throw new Error("QEMU UEFI firmware variables were not found.");
  }

  const vmDir = resolve(workspaceDir, "vm-disks");
  const varsPath = resolve(vmDir, nativeVarsName(profile));
  const backupPath = `${varsPath}.bak`;
  mkdirSync(vmDir, { recursive: true });
  if (existsSync(varsPath)) {
    copyFileSync(varsPath, backupPath);
  }
  copyFileSync(varsTemplate, varsPath);

  return { arch, profile, varsPath, backupPath: existsSync(backupPath) ? backupPath : null };
};

const nativeStatus = (requestedArch = "x86_64") => {
  const arch = normalizeArch(requestedArch);
  const qemu = findExecutable(arch === "aarch64" ? "qemu-system-aarch64" : "qemu-system-x86_64");
  const qemuImg = findExecutable("qemu-img");
  return {
    available: Boolean(qemu),
    arch,
    qemu,
    qemuImg,
    ovmf: findFirmware(arch, qemu),
    running: Boolean(nativeVm),
    pid: nativeVm?.pid || null,
    embeddedDisplay: Boolean(nativeVm?.vncPort),
    runtime: activeNativeRuntimeName || "EMUSTAR",
    engine: "QEMU",
    lastExit: lastNativeExit,
  };
};

const startNativeVm = async (body) => {
  if (nativeVm) {
    throw new Error(`A native QEMU VM is already running with pid ${nativeVm.pid}.`);
  }

  const arch = normalizeArch(body.arch);
  const profile = normalizeNativeProfile(body.profile, arch);
  const runtimeName = "QEMU";
  const qemu = findExecutable(arch === "aarch64" ? "qemu-system-aarch64" : "qemu-system-x86_64");
  if (!qemu) {
    throw new Error(
      `${arch === "aarch64" ? "qemu-system-aarch64" : "qemu-system-x86_64"} was not found. Install QEMU for Windows and restart NebulaVM.`,
    );
  }

  const isoPath = stripPathQuotes(body.isoPath);
  if (!isoPath || !isAbsolute(isoPath) || !existsSync(isoPath)) {
    throw new Error("Enter a valid absolute ISO path, for example C:\\Users\\Dell\\Downloads\\Win11.iso.");
  }

  const memoryMb = Math.min(6144, Math.max(512, Number(body.memoryMb) || 2048));
  const diskSizeGb = Math.min(256, Math.max(32, Number(body.diskSizeGb) || 64));
  const bootOrder = String(body.bootOrder || "213");
  const diskFirst = bootOrder === "123";
  const cdBootIndex = diskFirst ? 2 : 1;
  const diskBootIndex = diskFirst ? 1 : 2;
  const qemuBootDevice = diskFirst ? "c" : "d";
  const displayMode = body.displayMode === "external" ? "external" : "viewport";
  const embeddedDisplay = displayMode === "viewport";
  const vcpuCount = Math.max(2, Math.min(4, cpus().length - 1));
  const vmDir = resolve(workspaceDir, "vm-disks");
  const diskPath = resolve(vmDir, nativeDiskName(profile));
  mkdirSync(vmDir, { recursive: true });

  const qemuImg = findExecutable("qemu-img");
  if (body.createDisk !== false && qemuImg && !existsSync(diskPath)) {
    await new Promise((resolveCreate, rejectCreate) => {
      const child = spawn(qemuImg, ["create", "-f", "qcow2", diskPath, `${diskSizeGb}G`], {
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("exit", (code) => {
        if (code === 0) resolveCreate();
        else rejectCreate(new Error(stderr || `qemu-img exited with code ${code}.`));
      });
      child.on("error", rejectCreate);
    });
  }

  const ovmf = findFirmware(arch, qemu);
  const ovmfVarsTemplate = findFirmwareVars(arch, qemu);
  const ovmfVarsPath = ovmf && ovmfVarsTemplate ? resolve(vmDir, nativeVarsName(profile)) : null;
  if (ovmfVarsPath && !existsSync(ovmfVarsPath)) {
    copyFileSync(ovmfVarsTemplate, ovmfVarsPath);
  }
  const vnc = embeddedDisplay ? await findAvailableVncDisplay() : null;
  const args =
    arch === "aarch64"
      ? [
          "-name",
          `${runtimeName} ${profile}`,
          "-machine",
          "virt,gic-version=3,highmem=on",
          "-accel",
          "tcg,thread=multi",
          "-cpu",
          "max",
          "-smp",
          `${vcpuCount}`,
          "-m",
          `${memoryMb}M`,
          "-device",
          "ramfb",
          "-device",
          "qemu-xhci",
          "-device",
          "usb-kbd",
          "-device",
          "usb-tablet",
          "-drive",
          `if=none,id=install,media=cdrom,readonly=on,file=${isoPath}`,
          "-device",
          `usb-storage,drive=install,bootindex=${cdBootIndex}`,
          "-netdev",
          "user,id=net0",
          "-device",
          "virtio-net-pci,netdev=net0",
        ]
      : [
          "-name",
          `${runtimeName} x64`,
          "-machine",
          "q35",
          "-cpu",
          "qemu64",
          "-smp",
          "2",
          "-m",
          `${memoryMb}M`,
          "-boot",
          qemuBootDevice,
          "-cdrom",
          isoPath,
          "-usb",
          "-device",
          "usb-tablet",
          "-netdev",
          "user,id=net0",
          "-device",
          "e1000,netdev=net0",
        ];

  if (ovmf && ovmfVarsPath) {
    args.push("-drive", `if=pflash,format=raw,readonly=on,file=${ovmf}`);
    args.push("-drive", `if=pflash,format=raw,file=${ovmfVarsPath}`);
  } else if (ovmf) {
    args.push("-bios", ovmf);
  }

  if (embeddedDisplay) {
    args.push("-display", "none", "-vnc", `${nativeVncHost}:${vnc.display}`);
  } else {
    args.push("-display", "gtk");
  }

  if (body.createDisk !== false && existsSync(diskPath)) {
    if (arch === "aarch64") {
      args.push("-drive", `if=none,id=systemdisk,file=${diskPath},format=qcow2`);
      args.push(
        "-device",
        profile === "ubuntu-arm64"
          ? `virtio-blk-pci,drive=systemdisk,bootindex=${diskBootIndex}`
          : `nvme,drive=systemdisk,serial=nebulavm-arm64,bootindex=${diskBootIndex}`,
      );
    } else {
      args.push("-drive", `file=${diskPath},format=qcow2,if=ide`);
    }
  }

  const child = spawn(qemu, args, {
    cwd: workspaceDir,
    detached: false,
    windowsHide: embeddedDisplay,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.vncPort = vnc?.port || null;
  nativeVm = child;
  activeNativeRuntimeName = runtimeName;
  nativeVmOutput = "";
  lastNativeExit = null;
  const capture = (chunk) => {
    nativeVmOutput = `${nativeVmOutput}${chunk}`.slice(-4000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("exit", (code, signal) => {
    lastNativeExit = {
      code,
      signal,
      output: nativeVmOutput.trim(),
      at: new Date().toISOString(),
    };
    if (nativeVm === child) {
      nativeVm = null;
      activeNativeRuntimeName = null;
    }
  });
  child.on("error", (error) => {
    lastNativeExit = {
      code: null,
      signal: null,
      output: error.message,
      at: new Date().toISOString(),
    };
    if (nativeVm === child) {
      nativeVm = null;
      activeNativeRuntimeName = null;
    }
  });

  if (embeddedDisplay) {
    try {
      await waitForTcpPort(vnc.port);
    } catch (error) {
      child.kill();
      nativeVm = null;
      throw error;
    }
  }

  return {
    pid: child.pid,
    arch,
    profile,
    runtime: runtimeName,
    qemu,
    args,
    bootOrder: diskFirst ? "disk-first" : "cdrom-first",
    displayMode,
    diskPath: body.createDisk !== false && existsSync(diskPath) ? diskPath : null,
    ovmf,
    ovmfVarsPath,
    vncPath: embeddedDisplay ? nativeVncPath : null,
    vncPort: vnc?.port || null,
    get recentOutput() {
      return nativeVmOutput;
    },
  };
};

const nativeQemuPlugin = () => ({
  name: "nebulavm-native-qemu",
  configureServer(server) {
    const nativeVncWss = new WebSocketServer({ noServer: true });
    const hyperVGuestVncWss = new WebSocketServer({ noServer: true });

    nativeVncWss.on("connection", (socket) => {
      if (!nativeVm?.vncPort) {
        socket.close(1011, "Native QEMU VNC display is not ready.");
        return;
      }

      const vncSocket = net.connect(nativeVm.vncPort, nativeVncHost);
      const closeBoth = () => {
        vncSocket.destroy();
        if (socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
      };

      vncSocket.on("data", (chunk) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(chunk);
        }
      });
      vncSocket.on("error", closeBoth);
      vncSocket.on("close", closeBoth);
      socket.on("message", (data) => {
        const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        vncSocket.write(buffer);
      });
      socket.on("error", closeBoth);
      socket.on("close", closeBoth);
    });

    hyperVGuestVncWss.on("connection", async (socket) => {
      try {
        const status = await withHyperVDisplayStatus(await runHyperVAction("Status"));
        if (!status.guestAddress || !status.vncReady) {
          socket.close(1011, "The EMUSTAR guest display is not ready.");
          return;
        }

        const vncSocket = net.connect(5900, status.guestAddress);
        const closeBoth = () => {
          vncSocket.destroy();
          if (socket.readyState === WebSocket.OPEN) {
            socket.close();
          }
        };
        vncSocket.on("data", (chunk) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(chunk);
          }
        });
        vncSocket.on("error", closeBoth);
        vncSocket.on("close", closeBoth);
        socket.on("message", (data) => {
          const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
          vncSocket.write(buffer);
        });
        socket.on("error", closeBoth);
        socket.on("close", closeBoth);
      } catch {
        socket.close(1011, "The EMUSTAR guest display could not be reached.");
      }
    });

    server.httpServer?.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== nativeVncPath && url.pathname !== hyperVGuestVncPath) return;
      if (!isAuthorizedHostRequest(req, url)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const targetWss = url.pathname === hyperVGuestVncPath ? hyperVGuestVncWss : nativeVncWss;
      targetWss.handleUpgrade(req, socket, head, (ws) => {
        targetWss.emit("connection", ws, req);
      });
    });

    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url || "/", "http://localhost");
      const isNativeQemuApi = url.pathname.startsWith("/api/native-qemu");
      const isHyperVApi = url.pathname.startsWith("/api/emustar-hyperv");
      const isHostApi = url.pathname.startsWith("/api/emustar-host/");
      const isMobileDevUnlockApi =
        url.pathname === "/api/mobile-dev-unlock" || url.pathname === "/.netlify/functions/mobile-dev-unlock";
      if (!isNativeQemuApi && !isHyperVApi && !isHostApi && !isMobileDevUnlockApi) {
        next();
        return;
      }

      setNativeQemuCors(req, res);

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (isMobileDevUnlockApi) {
        try {
          const body = await readJsonBody(req);
          const result = verifyMobileDevUnlock(req, body);
          json(res, result.status, result.body);
        } catch (error) {
          json(res, 400, { ok: false, error: error.message });
        }
        return;
      }

      if (!isAuthorizedHostRequest(req, url)) {
        json(res, 401, { error: "This EMUSTAR host link is missing a valid access token." });
        return;
      }

      try {
        if (req.method === "GET" && url.pathname === "/api/emustar-host/info") {
          const configuredHost = server.config.server.host;
          const sharingEnabled =
            configuredHost === true || configuredHost === "0.0.0.0" || configuredHost === "::";
          const port = Number(server.config.server.port) || 5173;
          const shareUrls = sharingEnabled
            ? (await lanAddresses()).map(
                (address) => `http://${address}:${port}/#token=${encodeURIComponent(hostAccessToken)}`,
              )
            : [];
          const publicUrl = existsSync(publicUrlPath)
            ? readFileSync(publicUrlPath, "utf8").trim().replace(/\/$/, "")
            : "";
          if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(publicUrl)) {
            shareUrls.unshift(`${publicUrl}/#token=${encodeURIComponent(hostAccessToken)}`);
          }
          json(res, 200, {
            ok: true,
            sharingEnabled,
            shareUrls,
            publicUrl: publicUrl || null,
            accessToken: hostAccessToken,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-host/guest-credentials") {
          const body = await readJsonBody(req);
          json(res, 200, saveGuestCredentials(body));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-host/upload-iso") {
          json(res, 200, await saveBrowserIsoUpload(req));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-host/upload-iso-chunk") {
          json(res, 200, await saveBrowserIsoUploadChunk(req));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/emustar-host/stored-isos") {
          json(res, 200, listStoredIsos());
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-host/stored-isos") {
          const body = await readJsonBody(req);
          const result = storeBrowserIsoOnHost(body);
          json(res, result.ok ? 200 : 409, result);
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-host/stored-isos/remove") {
          const body = await readJsonBody(req);
          json(res, 200, removeStoredIso(body.id || ""));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-host/upload-session-cleanup") {
          let sessionId = url.searchParams.get("sessionId") || req.headers["x-nebulavm-session"] || "";
          if (!sessionId && String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
            const body = await readJsonBody(req);
            sessionId = body.sessionId || "";
          }
          json(res, 200, cleanupBrowserIsoUploadSession(sessionId));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/emustar-hyperv/status") {
          json(res, 200, await withHyperVDisplayStatus(await runHyperVAction("Status", {}, 45000)));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/start") {
          const body = await readJsonBody(req);
          const result = await runHyperVAction("Start", {
              ...body,
              vmDirectory: resolve(workspaceDir, "vm-disks", "emustar-hyperv"),
            }, 120000);
          json(res, 200, await withHyperVDisplayStatus(result));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/stop") {
          json(res, 200, await runHyperVAction("Stop"));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/reset") {
          json(res, 200, await runHyperVAction("Reset"));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/open-console") {
          json(res, 200, await runHyperVAction("OpenConsole"));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/close-console") {
          json(res, 200, await runHyperVAction("CloseConsole"));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/emustar-hyperv/console-frame") {
          const frame = await runHyperVConsoleFrame();
          if (!frame.outputPath || !existsSync(frame.outputPath)) {
            throw new Error("Hyper-V setup console frame was not written.");
          }

          const image = readFileSync(frame.outputPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", frame.mimeType || "image/jpeg");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-NebulaVM-Frame-Width", String(frame.width || ""));
          res.setHeader("X-NebulaVM-Frame-Height", String(frame.height || ""));
          res.setHeader("X-NebulaVM-Frame-Title", encodeURIComponent(frame.title || ""));
          res.end(image);
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/console-input") {
          const body = await readJsonBody(req);
          json(res, 200, await runHyperVConsoleInput(body));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/resize-display") {
          const body = await readJsonBody(req);
          json(res, 200, await runHyperVAction("ResizeDisplay", body, 12000));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/native-qemu/status") {
          json(res, 200, nativeStatus(url.searchParams.get("arch")));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/native-qemu/start") {
          const body = await readJsonBody(req);
          const result = await startNativeVm(body);
          json(res, 200, {
            ok: true,
            pid: result.pid,
            arch: result.arch,
            profile: result.profile,
            runtime: result.runtime,
            qemu: result.qemu,
            diskPath: result.diskPath,
            displayMode: result.displayMode,
            ovmf: result.ovmf,
            ovmfVarsPath: result.ovmfVarsPath,
            vncPath: result.vncPath,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/native-qemu/reset-firmware") {
          const body = await readJsonBody(req);
          json(res, 200, { ok: true, ...resetNativeFirmware(body) });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/native-qemu/stop") {
          if (nativeVm) {
            nativeVm.kill();
            nativeVm = null;
            activeNativeRuntimeName = null;
          }
          json(res, 200, { ok: true });
          return;
        }

        json(res, 404, { error: "Unknown native QEMU endpoint." });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    });
  },
});

export default defineConfig({
  plugins: [nativeQemuPlugin()],
  define: {
    __NEBULAVM_COMMIT__: JSON.stringify(commitId),
  },
  server: {
    cors: false,
    allowedHosts: [".trycloudflare.com"],
    headers: isolationHeaders,
  },
  preview: {
    cors: false,
    headers: isolationHeaders,
  },
});
