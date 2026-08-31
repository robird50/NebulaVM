import { defineConfig } from "vite";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { copyFileSync, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import net from "node:net";
import { cpus, freemem, homedir, networkInterfaces, totalmem } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import WebSocket, { WebSocketServer } from "ws";
import {
  MOBILE_DEVICE_DEV_COOKIE,
  SOURCE_APPROVED_IPV6_HASHES,
  createDeviceRecord,
  createDeviceToken,
  isApprovedIpv6,
  isDeviceTokenValid,
  isIpv6,
  normalizeIp,
  parseAllowedIpv6,
  parseCookies,
  renewDeviceRecord,
  safeEqualHex,
  serializeDeviceCookie,
  sha256Hex,
} from "./lib/mobileDevAccess.mjs";
import { normalizeStoredIsoOwnerId, storedIsosForOwner } from "./lib/storedIsoOwnership.mjs";
import {
  buildProblemReportEmail,
  buildProfanityModerationEmail,
  containsStrongProfanity,
  nextProfanityConsequence,
  redactStrongProfanity,
  validateProblemReport,
} from "./lib/problemReport.mjs";
import { getCommitHistory } from "./lib/commitHistory.mjs";

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const reportGmailAccount = "nebulavmsupport@gmail.com";
const hostTokenPath = resolve(workspaceDir, ".nebulavm-host-token");
const publicUrlPath = resolve(workspaceDir, ".nebulavm-public-url");
const autopilotEventPath = resolve(workspaceDir, ".nebulavm-autopilot-events.jsonl");
const guestCredentialsPath = resolve(workspaceDir, ".nebulavm-guest-credentials.json");
const publicAndroidEnabled = false;

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
      "X-NebulaVM-Client-Class",
      "X-NebulaVM-Filename",
      "X-NebulaVM-Device",
      "X-NebulaVM-Session",
      "X-NebulaVM-Total-Bytes",
      "X-NebulaVM-Upload-Id",
    ].join(", "),
  );
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Vary", "Origin");
};

const json = (res, status, payload, headers = {}) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  Object.entries(headers).forEach(([name, value]) => res.setHeader(name, value));
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

const readBinaryBody = (req, maxBytes = 2 * 1024 * 1024) =>
  new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        rejectBody(new Error("Monitoring frame is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });

const mobileDevAttempts = new Map();
const mobileDevMaxAttempts = 5;
const mobileDevLockMs = 5 * 60 * 1000;
let mobileDevApprovedDevice = null;
const localProblemReportLimits = new Map();
const localProblemReportMaxPerHour = 5;
const localProblemReportHourMs = 60 * 60 * 1000;

const localProblemReportLimit = (req) => {
  const key = String(req.socket?.remoteAddress || "local");
  const now = Date.now();
  const saved = localProblemReportLimits.get(key);
  const limit =
    saved && now - Number(saved.startedAt || 0) < localProblemReportHourMs
      ? saved
      : { ...saved, startedAt: now, count: 0 };
  localProblemReportLimits.set(key, limit);
  return { key, limit };
};

const configuredMobileDevCodeHash = () => {
  const directHash = String(localEnvValue("NEBULAVM_MOBILE_DEV_CODE_HASH") || "").trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(directHash)) return directHash;

  const rawCode = String(localEnvValue("NEBULAVM_MOBILE_DEV_CODE") || "").trim();
  if (/^\d{6}$/.test(rawCode)) return sha256Hex(rawCode);

  return "";
};

const mobileDevClientIp = (req) =>
  normalizeIp(
    req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      "",
  );

const mobileDevClientKey = (req) => {
  const userAgent = String(req.headers["user-agent"] || "").slice(0, 180);
  return `attempt-${sha256Hex(`${mobileDevClientIp(req)}|${userAgent}`)}`;
};

const verifyMobileDevUnlock = (req, body = {}) => {
  const expectedHash = configuredMobileDevCodeHash();
  if (!expectedHash) {
    return { status: 503, body: { ok: false, error: "Mobile developer unlock is not configured." } };
  }

  const denied = () => ({
    status: 403,
    body: { ok: false, error: "Your IP has not been granted permission to view this page" },
  });
  const clientIp = mobileDevClientIp(req);
  if (!isIpv6(clientIp)) return denied();

  const token = parseCookies(req.headers.cookie)[MOBILE_DEVICE_DEV_COOKIE] || "";
  const hasValidDevice = isDeviceTokenValid(mobileDevApprovedDevice, token);
  const deviceSuccess = (record, savedToken, deviceEnrolled) => {
    mobileDevApprovedDevice = renewDeviceRecord(record);
    return {
      status: 200,
      body: { ok: true, deviceEnrolled },
      headers: {
        "Set-Cookie": serializeDeviceCookie(savedToken, {
          secure: false,
          cookieName: MOBILE_DEVICE_DEV_COOKIE,
        }),
      },
    };
  };

  if (body.validateDevice === true) {
    return hasValidDevice ? deviceSuccess(mobileDevApprovedDevice, token, false) : denied();
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
    if (hasValidDevice) {
      mobileDevAttempts.set(key, { attempts: 0, lockUntil: 0 });
      return deviceSuccess(mobileDevApprovedDevice, token, false);
    }

    const allowedIps = parseAllowedIpv6(localEnvValue("NEBULAVM_MOBILE_DEV_ALLOWED_IPS"));
    if (!allowedIps.size && !SOURCE_APPROVED_IPV6_HASHES.size) {
      return {
        status: 503,
        body: { ok: false, error: "Mobile developer IP access is not configured." },
      };
    }
    if (!isApprovedIpv6(clientIp, allowedIps)) return denied();

    const newToken = createDeviceToken();
    mobileDevApprovedDevice = createDeviceRecord(newToken);
    mobileDevAttempts.set(key, { attempts: 0, lockUntil: 0 });
    return {
      status: 200,
      body: { ok: true, deviceEnrolled: true },
      headers: {
        "Set-Cookie": serializeDeviceCookie(newToken, {
          secure: false,
          cookieName: MOBILE_DEVICE_DEV_COOKIE,
        }),
      },
    };
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
const storedIsoTotalLimitBytes = 40 * 1024 * 1024 * 1024;
const browserUploadTtlMs = 2 * 60 * 60 * 1000;
const hostStorageReserveBytes = 25 * 1024 * 1024 * 1024;
const templateIsoDirectory = resolve(workspaceDir, "vm-disks", "templates");
const templateDiskDirectory = resolve(workspaceDir, "vm-disks", "emustar-hyperv", "disks");
const windows11TemplateIsoPath = resolve(templateIsoDirectory, "windows-11-template.iso");
const windows11TemplateSourceCandidates = [
  windows11TemplateIsoPath,
  resolve(homedir(), "Downloads", "Win11_25H2_English_x64_v2.iso"),
  resolve(storedIsoDirectory, "46a6f91a9bdd0c0f-w11.iso"),
];

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

const formatBytes = (bytes) => {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${Math.ceil(value / 1024 / 1024)} MB`;
  if (value >= 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${Math.ceil(value)} bytes`;
};

const hostDiskFreeBytes = (targetPath = workspaceDir) => {
  if (process.platform !== "win32") return Number.POSITIVE_INFINITY;
  const driveName = resolve(targetPath).match(/^([a-zA-Z]):[\\/]/)?.[1]?.toUpperCase() || "C";
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$drive = Get-PSDrive -Name '${driveName}' -ErrorAction Stop; [int64]$drive.Free`,
      ],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    ).trim();
    const value = Number(output.match(/\d+/)?.[0] || 0);
    return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const ensureHostStorageReserve = (requiredBytes = 0, action = "continue") => {
  const needed = Math.max(0, Number(requiredBytes) || 0);
  const freeBytes = hostDiskFreeBytes(workspaceDir);
  if (!Number.isFinite(freeBytes)) return;
  if (freeBytes - needed >= hostStorageReserveBytes) return;

  const shortfall = hostStorageReserveBytes + needed - freeBytes;
  const error = new Error(
    `NebulaVM host storage is too low to ${action}. The public host keeps ${formatBytes(hostStorageReserveBytes)} free so uploads and VMs cannot fill the disk. Free about ${formatBytes(shortfall)} on the Windows host, then try again.`,
  );
  error.statusCode = 507;
  throw error;
};

const cleanupBrowserIsoUploadSessions = (excludeSessionId = "") => {
  if (!existsSync(browserUploadDirectory)) return;
  const cutoff = Date.now() - browserUploadTtlMs;
  const excluded = sanitizeSessionId(excludeSessionId);
  for (const entry of readdirSync(browserUploadDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === excluded) continue;
    const uploadPath = resolve(browserUploadDirectory, entry.name);
    if (!isPathInsideDirectory(uploadPath, browserUploadDirectory)) continue;
    try {
      const stats = statSync(uploadPath);
      if (stats.mtimeMs <= cutoff) {
        rmSync(uploadPath, { recursive: true, force: true });
      }
    } catch {
      // Upload cleanup is best effort; active uploads are protected by session IDs.
    }
  }
};

const storedIsoFileKey = ({ fileKey, name, size }) =>
  String(fileKey || `${name || ""}:${Number(size) || 0}`).trim().slice(0, 240);

const sourceLooksLikeWindows11Template = (candidatePath) => {
  if (!candidatePath || !existsSync(candidatePath)) return false;
  const name = candidatePath.split(/[\\/]/).pop() || "";
  const size = statSync(candidatePath).size;
  return size > 4 * 1024 * 1024 * 1024 && /(?:win(?:dows)?[\s_-]*11|w11)/i.test(name);
};

const grantHyperVTemplateAccess = () => {
  const grantTarget = "*S-1-5-83-0:(R)";
  const grantTree = "*S-1-5-83-0:(OI)(CI)(RX)";
  const grantDiskTarget = "*S-1-5-83-0:(M)";
  const grantDiskTree = "*S-1-5-83-0:(OI)(CI)(M)";
  for (const directoryPath of [resolve(workspaceDir, "vm-disks"), templateIsoDirectory]) {
    if (!existsSync(directoryPath)) continue;
    execFileSync("icacls", [directoryPath, "/grant", grantTree], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
  if (existsSync(windows11TemplateIsoPath)) {
    execFileSync("icacls", [windows11TemplateIsoPath, "/grant", grantTarget], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
  if (existsSync(templateDiskDirectory)) {
    execFileSync("icacls", [templateDiskDirectory, "/grant", grantDiskTree], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
  const templateDiskPath = findWindows11TemplateDisk();
  if (templateDiskPath) {
    execFileSync("icacls", [templateDiskPath, "/grant", grantDiskTarget], {
      windowsHide: true,
      stdio: "ignore",
    });
  }
};

const findWindows11TemplateDisk = () => {
  if (!existsSync(templateDiskDirectory)) return "";
  const minimumInstalledDiskSize = 8 * 1024 * 1024 * 1024;
  return readdirSync(templateDiskDirectory)
    .filter((name) => /^windows-11-template-.*\.vhdx$/i.test(name))
    .map((name) => {
      const diskPath = resolve(templateDiskDirectory, name);
      const stats = statSync(diskPath);
      return { diskPath, size: stats.size, mtimeMs: stats.mtimeMs };
    })
    .filter((entry) => entry.size >= minimumInstalledDiskSize)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size)[0]?.diskPath || "";
};

const ensureWindows11TemplateIso = () => {
  const existingTemplate = existsSync(windows11TemplateIsoPath) ? windows11TemplateIsoPath : "";
  const sourcePath =
    (sourceLooksLikeWindows11Template(existingTemplate) && existingTemplate) ||
    windows11TemplateSourceCandidates.find((candidatePath) => sourceLooksLikeWindows11Template(candidatePath));

  if (!sourcePath) {
    return {
      ok: true,
      available: false,
      name: "Windows 11 Template",
      error: "Windows 11 Template ISO is not installed on this host.",
    };
  }

  mkdirSync(templateIsoDirectory, { recursive: true });
  if (!existsSync(windows11TemplateIsoPath)) {
    try {
      linkSync(sourcePath, windows11TemplateIsoPath);
    } catch {
      copyFileSync(sourcePath, windows11TemplateIsoPath);
    }
  }
  grantHyperVTemplateAccess();

  const size = statSync(windows11TemplateIsoPath).size;
  const diskPath = findWindows11TemplateDisk();
  const diskSize = diskPath ? statSync(diskPath).size : 0;
  return {
    ok: true,
    available: true,
    name: "Windows 11 Template",
    isoPath: windows11TemplateIsoPath,
    size,
    diskPath,
    diskSize,
    prepared: Boolean(diskPath),
  };
};

const storedIsoOwnerId = (req, fallback = "") => {
  const ownerId = normalizeStoredIsoOwnerId(req.headers["x-nebulavm-device"] || fallback);
  if (!ownerId) {
    const error = new Error("This stored ISO request is missing a valid device identity.");
    error.statusCode = 400;
    throw error;
  }
  return ownerId;
};

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

const activeStoredIsos = (items) => items.filter((item) => !item.pendingDelete);

const cleanupStoredIsos = () => {
  const now = Date.now();
  const current = loadStoredIsoManifest();
  const kept = [];
  let changed = false;

  for (const item of current) {
    const expired = item.pendingDelete || Date.parse(item.expiresAt || "") <= now;
    const missing = !item.isoPath || !existsSync(item.isoPath);
    if (expired || missing) {
      if (item.isoPath && existsSync(item.isoPath) && isPathInsideDirectory(item.isoPath, storedIsoDirectory)) {
        try {
          rmSync(item.isoPath, { force: true });
        } catch {
          kept.push({ ...item, pendingDelete: true });
          changed ||= !item.pendingDelete;
          continue;
        }
      }
      changed = true;
      continue;
    }
    kept.push(item);
  }

  let storedBytes = kept.reduce((total, item) => total + (Number(item.size) || 0), 0);
  if (storedBytes > storedIsoTotalLimitBytes) {
    const oldestFirst = [...kept]
      .map((item, index) => ({ item, index }))
      .sort(
        (left, right) =>
          (Date.parse(left.item.storedAt || "") || 0) - (Date.parse(right.item.storedAt || "") || 0),
      );
    const removeIndexes = new Set();
    for (const { item, index } of oldestFirst) {
      if (storedBytes <= storedIsoTotalLimitBytes) break;
      if (item.isoPath && existsSync(item.isoPath) && isPathInsideDirectory(item.isoPath, storedIsoDirectory)) {
        try {
          rmSync(item.isoPath, { force: true });
        } catch {
          kept[index] = { ...item, pendingDelete: true };
          changed ||= !item.pendingDelete;
          continue;
        }
      }
      storedBytes -= Number(item.size) || 0;
      removeIndexes.add(index);
      changed = true;
    }
    if (removeIndexes.size > 0) {
      for (let index = kept.length - 1; index >= 0; index -= 1) {
        if (removeIndexes.has(index)) kept.splice(index, 1);
      }
    }
  }

  if (changed) {
    saveStoredIsoManifest(kept);
  }

  return kept;
};

const listStoredIsos = (ownerId) => ({
  ok: true,
  limit: storedIsoLimit,
  ttlHours: Math.round(storedIsoTtlMs / 60 / 60 / 1000),
  items: storedIsosForOwner(activeStoredIsos(cleanupStoredIsos()), ownerId).map(storedIsoSnapshot),
});

const assertStoredIsoAccess = (req, isoPath) => {
  const candidatePath = stripPathQuotes(isoPath);
  if (!candidatePath || !isPathInsideDirectory(candidatePath, storedIsoDirectory)) return;

  const ownerId = storedIsoOwnerId(req);
  const resolvedCandidate = resolve(candidatePath).toLowerCase();
  const target = activeStoredIsos(cleanupStoredIsos()).find(
    (item) => item.isoPath && resolve(item.isoPath).toLowerCase() === resolvedCandidate,
  );
  if (!target || normalizeStoredIsoOwnerId(target.ownerId) !== ownerId) {
    const error = new Error("This stored ISO belongs to a different device.");
    error.statusCode = 403;
    throw error;
  }
};

const removeStoredIso = (ownerId, id) => {
  const safeId = sanitizeUploadId(id);
  const items = cleanupStoredIsos();
  const ownerItems = storedIsosForOwner(activeStoredIsos(items), ownerId);
  const target = ownerItems.find((item) => item.id === safeId);
  if (!target) {
    return {
      ok: true,
      removed: false,
      limit: storedIsoLimit,
      items: ownerItems.map(storedIsoSnapshot),
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
    items: storedIsosForOwner(activeStoredIsos(nextItems), ownerId).map(storedIsoSnapshot),
  };
};

const storeBrowserIsoOnHost = (ownerId, body) => {
  cleanupBrowserIsoUploadSessions(body.sessionId);
  cleanupStoredIsos();
  ensureHostStorageReserve(0, "save this ISO");

  const sourcePath = stripPathQuotes(body.isoPath);
  if (!sourcePath || !isAbsolute(sourcePath) || !existsSync(sourcePath)) {
    throw new Error("The staged ISO was not found on the host computer.");
  }
  if (!isPathInsideDirectory(sourcePath, isoImportDirectory) || isPathInsideDirectory(sourcePath, storedIsoDirectory)) {
    throw new Error("Only NebulaVM-staged ISOs can be saved as stored images.");
  }
  const { sessionDirectory } = browserUploadSessionDirectory(body.sessionId);
  if (!isPathInsideDirectory(sourcePath, sessionDirectory)) {
    throw new Error("This staged ISO does not belong to the requesting browser session.");
  }

  const name = sanitizeFilename(body.name || body.fileName || sourcePath.split(/[\\/]/).pop() || "stored.iso");
  const size = Number(body.size) || statSync(sourcePath).size;
  if (size > storedIsoTotalLimitBytes) {
    const error = new Error(
      `This ISO is too large to keep as a stored image. Stored images are capped at ${formatBytes(storedIsoTotalLimitBytes)} total on the public host.`,
    );
    error.statusCode = 507;
    throw error;
  }
  const fileKey = storedIsoFileKey({ fileKey: body.fileKey, name, size });
  const manifestItems = cleanupStoredIsos();
  const current = activeStoredIsos(manifestItems);
  const ownerItems = storedIsosForOwner(current, ownerId);
  let existing = ownerItems.find(
    (item) => item.fileKey === fileKey || (item.name === name && Number(item.size) === size),
  );
  if (!existing) {
    existing = current.find(
      (item) =>
        !normalizeStoredIsoOwnerId(item.ownerId) &&
        (item.fileKey === fileKey || (item.name === name && Number(item.size) === size)),
    );
    if (existing) {
      existing.ownerId = ownerId;
      saveStoredIsoManifest(manifestItems);
    }
  }
  if (existing) {
    rmSync(sourcePath, { force: true });
    if (body.sessionId) {
      cleanupBrowserIsoUploadSession(body.sessionId);
    }
    return {
      ok: true,
      duplicate: true,
      limit: storedIsoLimit,
      item: storedIsoSnapshot(existing),
      items: storedIsosForOwner(current, ownerId).map(storedIsoSnapshot),
    };
  }

  if (ownerItems.length >= storedIsoLimit) {
    return {
      ok: false,
      slotLimitReached: true,
      error: `Stored ISO slots are full. Remove an ISO before saving another one.`,
      limit: storedIsoLimit,
      items: ownerItems.map(storedIsoSnapshot),
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
    ownerId,
    storedAt: storedAt.toISOString(),
    expiresAt: new Date(storedAt.getTime() + storedIsoTtlMs).toISOString(),
  };
  const items = [...manifestItems, item];
  saveStoredIsoManifest(items);
  cleanupStoredIsos();

  return {
    ok: true,
    duplicate: false,
    limit: storedIsoLimit,
    item: storedIsoSnapshot(item),
    items: storedIsosForOwner(items, ownerId).map(storedIsoSnapshot),
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
  cleanupBrowserIsoUploadSessions(safeSessionId);
  cleanupStoredIsos();
  cleanupBrowserIsoUploadSession(safeSessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  const contentLength = Number(req.headers["content-length"]) || 0;
  ensureHostStorageReserve(contentLength, "stage this ISO");
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
  try {
    ensureHostStorageReserve(0, "finish staging this ISO");
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
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

const browserIsoUploadPaths = (req) => {
  const { safeSessionId, sessionDirectory } = browserUploadSessionDirectory(req.headers["x-nebulavm-session"]);
  const uploadId = sanitizeUploadId(req.headers["x-nebulavm-upload-id"]);
  const totalBytes = readHeaderInteger(req, "x-nebulavm-total-bytes");
  const headerName = decodeHeaderFilename(req.headers["x-nebulavm-filename"]);
  const baseName = sanitizeFilename(headerName || "browser-upload.iso");
  const mediaName = /\.(iso|img|bin|raw)$/i.test(baseName) ? baseName : `${baseName}.iso`;
  const finalPath = resolve(sessionDirectory, `${uploadId}-${mediaName}`);
  return {
    safeSessionId,
    sessionDirectory,
    uploadId,
    totalBytes,
    mediaName,
    finalPath,
    tempPath: `${finalPath}.part`,
  };
};

const finalizeBrowserIsoUpload = ({ finalPath, tempPath, totalBytes, safeSessionId }) => {
  if (existsSync(finalPath) && statSync(finalPath).size === totalBytes) {
    return {
      ok: true,
      complete: true,
      message: "Browser ISO uploaded to the NebulaVM host.",
      isoPath: finalPath,
      bytesReceived: totalBytes,
      totalBytes,
      sessionId: safeSessionId,
    };
  }
  if (!existsSync(tempPath) || statSync(tempPath).size !== totalBytes) return null;

  renameSync(tempPath, finalPath);
  return {
    ok: true,
    complete: true,
    message: "Browser ISO uploaded to the NebulaVM host.",
    isoPath: finalPath,
    bytesReceived: totalBytes,
    totalBytes,
    sessionId: safeSessionId,
  };
};

const browserIsoUploadStatus = (req) => {
  const paths = browserIsoUploadPaths(req);
  cleanupBrowserIsoUploadSessions(paths.safeSessionId);
  cleanupStoredIsos();
  mkdirSync(paths.sessionDirectory, { recursive: true });

  const completed = finalizeBrowserIsoUpload(paths);
  if (completed) return completed;

  // Recover uploads created before stable upload IDs were introduced.
  const suffix = `-${paths.mediaName}`.toLowerCase();
  const legacyEntries = readdirSync(paths.sessionDirectory)
    .filter((name) => name.toLowerCase().endsWith(suffix) || name.toLowerCase().endsWith(`${suffix}.part`))
    .map((name) => ({
      path: resolve(paths.sessionDirectory, name),
      isPartial: name.toLowerCase().endsWith(".part"),
    }))
    .filter((entry) => existsSync(entry.path))
    .map((entry) => ({ ...entry, size: statSync(entry.path).size }))
    .filter((entry) => entry.size <= paths.totalBytes)
    .sort((left, right) => right.size - left.size);

  const legacy = legacyEntries[0];
  if (legacy && legacy.size === paths.totalBytes) {
    if (legacy.path !== paths.finalPath) {
      renameSync(legacy.path, paths.finalPath);
    }
    return finalizeBrowserIsoUpload(paths);
  }
  if (legacy?.isPartial && legacy.size > 0 && !existsSync(paths.tempPath)) {
    renameSync(legacy.path, paths.tempPath);
  }

  return {
    ok: true,
    complete: false,
    bytesReceived: existsSync(paths.tempPath) ? statSync(paths.tempPath).size : 0,
    totalBytes: paths.totalBytes,
    sessionId: paths.safeSessionId,
  };
};

const saveBrowserIsoUploadChunk = async (req) => {
  const paths = browserIsoUploadPaths(req);
  const { safeSessionId, sessionDirectory, totalBytes, finalPath, tempPath } = paths;
  cleanupBrowserIsoUploadSessions(safeSessionId);
  cleanupStoredIsos();
  const chunkStart = readHeaderInteger(req, "x-nebulavm-chunk-start");
  const chunkEnd = readHeaderInteger(req, "x-nebulavm-chunk-end");
  if (chunkEnd <= chunkStart || chunkEnd > totalBytes) {
    throw new Error("Invalid browser upload chunk range.");
  }

  mkdirSync(sessionDirectory, { recursive: true });

  const completed = finalizeBrowserIsoUpload(paths);
  if (completed) return completed;

  const currentSize = existsSync(tempPath) ? statSync(tempPath).size : 0;
  if (currentSize > chunkStart) {
    if (currentSize === totalBytes) {
      return finalizeBrowserIsoUpload(paths);
    }
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

  ensureHostStorageReserve(chunkEnd - currentSize, "continue staging this ISO");
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
  try {
    ensureHostStorageReserve(0, "continue staging this ISO");
  } catch (error) {
    truncateSync(tempPath, chunkStart);
    throw error;
  }
  if (bytesReceived === totalBytes) {
    return finalizeBrowserIsoUpload(paths);
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
          join(qemuDir, "share", "edk2-i386-vars.fd"),
          join(qemuDir, "..", "share", "edk2-i386-vars.fd"),
          "C:\\Program Files\\qemu\\share\\edk2-x86_64-vars.fd",
          "C:\\Program Files\\qemu\\share\\edk2-i386-vars.fd",
          "C:\\Program Files\\qemu\\share\\qemu\\edk2-x86_64-vars.fd",
          "C:\\Program Files\\qemu\\share\\qemu\\edk2-i386-vars.fd",
        ];
  return candidates.map((candidate) => normalize(candidate)).find((candidate) => existsSync(candidate));
};

let nativeVm = null;
let nativeVmOutput = "";
let lastNativeExit = null;
let activeNativeRuntimeName = null;
let hyperVRemoteSessionId = "";
let hyperVRemoteSessionStartedAt = "";
let hyperVStatusCache = { expiresAt: 0, data: null };
let hyperVStatusRevision = 0;
let hyperVStatusTask = null;
let hyperVStartTask = null;
let hyperVRecoveryTask = null;
let lastHyperVStart = null;
let androidRuntime = null;
let androidImageCache = { expiresAt: 0, items: [] };
let lastAndroidEmulatorExit = null;
const androidSessionLeaseMs = 30 * 60_000;
const nativeVncHost = "127.0.0.1";
const nativeVncPath = "/api/native-qemu/vnc";
const hyperVGuestVncPath = "/api/emustar-hyperv/vnc";
const hyperVScriptPath = resolve(workspaceDir, "scripts", "emustar-hyperv.ps1");
const hyperVConsoleFrameScriptPath = resolve(workspaceDir, "scripts", "emustar-console-frame.ps1");
const hyperVConsoleInputScriptPath = resolve(workspaceDir, "scripts", "emustar-console-input.ps1");
const hyperVConsoleFramePath = resolve(workspaceDir, "vm-disks", "emustar-hyperv", "console-frame.jpg");
const androidStudioFrameScriptPath = resolve(workspaceDir, "scripts", "android-studio-frame.ps1");
const androidStudioInputScriptPath = resolve(workspaceDir, "scripts", "android-studio-input.ps1");
const androidStudioFramePath = resolve(workspaceDir, "vm-disks", "android-studio-frame.jpg");
const safetySessions = new Map();
const safetySessionTtlMs = 12_000;
const safetyMonitorLeaseMs = 6_000;
const safetyFrameMaxBytes = 2 * 1024 * 1024;

const safetyClientIp = (req) =>
  normalizeIp(
    req.headers["cf-connecting-ip"] ||
      String(req.headers["x-forwarded-for"] || "").split(",")[0] ||
      req.socket?.remoteAddress ||
      "",
  );

const safetyClientLocation = (req) => {
  const city = String(req.headers["cf-ipcity"] || "").trim();
  const region = String(req.headers["cf-region"] || "").trim();
  const country = String(req.headers["cf-ipcountry"] || "").trim();
  return [city, region, country].filter(Boolean).join(", ") || "Location unavailable";
};

const cleanupSafetySessions = () => {
  const now = Date.now();
  for (const [id, session] of safetySessions) {
    if (now - Number(session.lastSeen || 0) > safetySessionTtlMs) {
      safetySessions.delete(id);
      continue;
    }
    if (Number(session.monitorUntil || 0) <= now) {
      session.monitorUntil = 0;
    }
  }
};

const safetySessionId = (value) => {
  const id = sanitizeSessionId(value);
  if (!id || id.length < 8) throw new Error("Invalid safety session identifier.");
  return id;
};

const safetySessionSummary = (session) => ({
  id: session.id,
  ipv4: isIpv6(session.ip) ? "IPv6 connection" : session.ip || "Unknown",
  location: session.location,
  emulator: session.emulator,
  media: session.media,
  startedAt: session.startedAt,
  lastSeen: new Date(session.lastSeen).toISOString(),
  monitoring: Number(session.monitorUntil || 0) > Date.now(),
  hasFrame: Boolean(session.frame?.length),
});

const workspaceUserHome = () => {
  if (process.platform === "win32") {
    const match = normalize(workspaceDir).match(/^([A-Za-z]:\\Users\\[^\\]+)/i);
    if (match) return match[1];
  }
  return process.env.USERPROFILE || homedir();
};

const androidStudioAvdHome = () => join(workspaceUserHome(), ".android", "avd");

const removeAndroidStudioAvdReference = (runtime) => {
  if (!runtime?.studioAvdIniPath) return;
  rmSync(runtime.studioAvdIniPath, { force: true });
  runtime.studioAvdIniPath = "";
};

const exposeAndroidAvdToStudio = (runtime) => {
  const studioAvdHome = androidStudioAvdHome();
  mkdirSync(studioAvdHome, { recursive: true });
  const studioAvdIniPath = join(studioAvdHome, `${runtime.avdName}.ini`);
  writeFileSync(
    studioAvdIniPath,
    [
      "avd.ini.encoding=UTF-8",
      `path=${runtime.avdPath}`,
      `target=${runtime.image.targetId || `android-${runtime.image.api}`}`,
      "",
    ].join("\n"),
  );
  runtime.studioAvdIniPath = studioAvdIniPath;
  return studioAvdIniPath;
};

const androidSdkRoot = () => {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    join(process.env.LOCALAPPDATA || "", "Android", "Sdk"),
    join(workspaceUserHome(), "AppData", "Local", "Android", "Sdk"),
  ].filter(Boolean);
  return normalize(candidates.find((candidate) => existsSync(candidate)) || candidates.at(-1));
};

const androidToolPath = (tool) => {
  const sdkRoot = androidSdkRoot();
  const filename = process.platform === "win32" ? `${tool}.exe` : tool;
  const toolPath = tool === "emulator" ? join(sdkRoot, "emulator", filename) : join(sdkRoot, "platform-tools", filename);
  return existsSync(toolPath) ? toolPath : null;
};

const runAndroidTool = (tool, args, options = {}) => {
  const toolPath = androidToolPath(tool);
  if (!toolPath) {
    throw new Error(`${tool === "adb" ? "Android platform tools" : "Android Emulator"} were not found.`);
  }
  return execFileSync(toolPath, args, {
    encoding: options.binary ? null : "utf8",
    env: {
      ...process.env,
      ANDROID_SDK_ROOT: androidSdkRoot(),
      ANDROID_HOME: androidSdkRoot(),
      ...(options.avdHome ? { ANDROID_AVD_HOME: options.avdHome } : {}),
    },
    maxBuffer: options.maxBuffer || 24 * 1024 * 1024,
    timeout: options.timeout || 15000,
    windowsHide: true,
  });
};

const runAndroidToolAsync = (tool, args, options = {}) =>
  new Promise((resolveTool, rejectTool) => {
    const toolPath = androidToolPath(tool);
    if (!toolPath) {
      rejectTool(new Error(`${tool === "adb" ? "Android platform tools" : "Android Emulator"} were not found.`));
      return;
    }

    const child = spawn(toolPath, args, {
      cwd: workspaceDir,
      env: {
        ...process.env,
        ANDROID_SDK_ROOT: androidSdkRoot(),
        ANDROID_HOME: androidSdkRoot(),
        ...(options.avdHome ? { ANDROID_AVD_HOME: options.avdHome } : {}),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => rejectTool(new Error(`${tool} timed out.`)));
    }, options.timeout || 20000);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(() => rejectTool(error)));
    child.on("exit", (code) => {
      finish(() => {
        const output = Buffer.concat(stdout);
        if (code === 0) {
          resolveTool(options.binary ? output : output.toString("utf8"));
          return;
        }
        rejectTool(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${tool} failed with code ${code}.`));
      });
    });
  });

const androidSessionsRoot = resolve(workspaceDir, "vm-disks", "android-sessions");
const androidEmulatorPort = 5580;
const androidEmulatorSerial = `emulator-${androidEmulatorPort}`;

const androidPortProcessId = () => {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync("netstat.exe", ["-ano", "-p", "TCP"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const line = output
      .split(/\r?\n/)
      .find((entry) => new RegExp(`(?:127\\.0\\.0\\.1|\\[?::1\\]?):${androidEmulatorPort}\\s+.*LISTENING\\s+\\d+$`, "i").test(entry.trim()));
    const pid = Number(line?.trim().match(/(\d+)$/)?.[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const killAndroidPortProcess = () => {
  const pid = androidPortProcessId();
  if (!pid) return false;
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
};

const nebulaAndroidProcessIds = () => {
  if (process.platform !== "win32") return [];
  try {
    const script = [
      "Get-CimInstance Win32_Process",
      "Where-Object { $_.CommandLine -match '(?i)(?:^|\\s)-avd\\s+NebulaVM_' }",
      "Select-Object -ExpandProperty ProcessId",
    ].join(" | ");
    return execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    )
      .split(/\r?\n/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
};

const killNebulaAndroidProcesses = () => {
  const processIds = nebulaAndroidProcessIds();
  for (const pid of processIds) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        timeout: 10000,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The process already exited.
      }
    }
  }
  return processIds.length;
};

const androidSessionId = (req) => {
  const raw = String(req.headers["x-nebulavm-session"] || "");
  const safe = sanitizeSessionId(raw);
  if (!raw || safe !== raw || safe.length < 8) {
    throw new Error("This Android request is missing a valid private session.");
  }
  return safe;
};

const isPublicMobileRequest = (req) => {
  if (String(req.headers["x-nebulavm-client-class"] || "") === "public-mobile") return true;
  if (String(req.headers["sec-ch-ua-mobile"] || "").trim() === "?1") return true;
  return /Android|iPhone|iPad|iPod|Mobile|Tablet|Kindle|Silk/i.test(
    String(req.headers["user-agent"] || ""),
  );
};

const androidSessionDirectory = (sessionId) => {
  const safeSessionId = sanitizeSessionId(sessionId);
  const sessionDirectory = resolve(androidSessionsRoot, safeSessionId);
  const root = androidSessionsRoot.endsWith(sep) ? androidSessionsRoot : `${androidSessionsRoot}${sep}`;
  if (!sessionDirectory.startsWith(root)) throw new Error("Invalid Android session path.");
  return { safeSessionId, sessionDirectory };
};

const removeAndroidSessionDirectory = async (sessionDirectory) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(sessionDirectory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code) || attempt === 19) throw error;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 500));
    }
  }
};

const androidReleaseMajor = (release) => {
  const major = Number(String(release || "").match(/^\d+/)?.[0]);
  return Number.isInteger(major) && major >= 1 && major <= 17 ? major : null;
};

const curatedAndroidVersions = [2, 4, 5, 6, 8, 9, 12, 16, 17];
const curatedAndroidVersionSet = new Set(curatedAndroidVersions);

const androidImageLabel = (image) => {
  if (!image) return "";
  const release = image.release && image.release !== String(image.version) ? ` ${image.release}` : "";
  const flavor = image.playStore ? "Google Play" : image.tag === "google_apis" ? "Google APIs" : "AOSP";
  return `Android ${image.version}${release} (API ${image.api}, ${flavor}, ${image.abi})`;
};

const androidCompatibilityProfile = (image, specs = {}, orientation = "portrait") => {
  const version = Number(image?.version) || 16;
  const api = Number(image?.api) || 36;
  const memoryMb = Number(specs.memoryMb) || 1024;
  const landscape = orientation === "landscape";
  const classic = api <= 10 || version <= 2;
  const legacy = api <= 19 || version <= 4;
  const earlyMaterial = api <= 25 || version <= 7;

  const basePortrait = classic
    ? { width: 320, height: 480, density: 160 }
    : legacy
      ? { width: 480, height: 800, density: 240 }
      : earlyMaterial
        ? { width: 540, height: 960, density: 280 }
        : memoryMb <= 512
          ? { width: 360, height: 640, density: 240 }
          : memoryMb <= 1280
            ? { width: 432, height: 768, density: 280 }
            : memoryMb <= 1536
              ? { width: 540, height: 960, density: 300 }
              : { width: 1080, height: 1920, density: 420 };

  const maxCores = classic ? 1 : legacy ? 2 : memoryMb <= 1536 ? 2 : 4;
  const heapMb = classic
    ? Math.min(128, Math.max(64, Math.floor(memoryMb / 4)))
    : memoryMb <= 512
      ? 128
      : memoryMb <= 1024
        ? 192
        : Math.min(512, Math.floor(memoryMb / 4));

  return {
    classic,
    legacy,
    earlyMaterial,
    lowMemory: memoryMb <= 1024 || classic,
    width: landscape ? basePortrait.height : basePortrait.width,
    height: landscape ? basePortrait.width : basePortrait.height,
    density: basePortrait.density,
    heapMb,
    gpuMode: classic || legacy ? "swiftshader_indirect" : "host",
    maxCores,
    deviceName: classic ? "Nexus One" : legacy ? "Nexus 4" : earlyMaterial ? "Nexus 5" : "pixel_6",
    mainKeys: classic ? "yes" : "no",
  };
};

const installedAndroidImages = () => {
  if (androidImageCache.expiresAt > Date.now()) return androidImageCache.items;
  const systemImagesRoot = join(androidSdkRoot(), "system-images");
  const images = [];
  if (existsSync(systemImagesRoot)) {
    for (const apiDirectory of readdirSync(systemImagesRoot, { withFileTypes: true })) {
      const api = Number(apiDirectory.name.match(/^android-(\d+)(?:\.[a-z0-9.-]+)?$/i)?.[1]);
      if (!apiDirectory.isDirectory() || !Number.isInteger(api)) continue;
      const apiPath = join(systemImagesRoot, apiDirectory.name);
      for (const tagDirectory of readdirSync(apiPath, { withFileTypes: true })) {
        if (!tagDirectory.isDirectory()) continue;
        const tagPath = join(apiPath, tagDirectory.name);
        for (const abiDirectory of readdirSync(tagPath, { withFileTypes: true })) {
          if (!abiDirectory.isDirectory()) continue;
          const imagePath = join(tagPath, abiDirectory.name);
          const buildPropPath = join(imagePath, "build.prop");
          if (!existsSync(buildPropPath) || !existsSync(join(imagePath, "system.img"))) continue;
          const buildProp = readFileSync(buildPropPath, "utf8");
          const release = buildProp.match(/^ro\.build\.version\.release=(.+)$/m)?.[1]?.trim() || "";
          const version = androidReleaseMajor(release);
          if (!version) continue;
          images.push({
            version,
            api,
            release,
            tag: tagDirectory.name,
            abi: abiDirectory.name,
            imagePath,
            relativeImagePath: `system-images\\${apiDirectory.name}\\${tagDirectory.name}\\${abiDirectory.name}\\`,
            playStore: tagDirectory.name.includes("playstore"),
            targetId: apiDirectory.name,
          });
        }
      }
    }
  }
  images.sort(
    (left, right) =>
      left.version - right.version ||
      right.api - left.api ||
      Number(left.playStore) - Number(right.playStore),
  );
  androidImageCache = { expiresAt: Date.now() + 60_000, items: images };
  return images;
};

const connectedAndroidSerial = () => {
  if (!androidRuntime) return null;
  try {
    const line = String(runAndroidTool("adb", ["-s", androidRuntime.serial, "get-state"], { timeout: 5000 })).trim();
    return line === "device" ? androidRuntime.serial : null;
  } catch {
    return null;
  }
};

const androidProperty = (serial, property) => {
  if (!serial) return "";
  try {
    return String(runAndroidTool("adb", ["-s", serial, "shell", "getprop", property])).trim();
  } catch {
    return "";
  }
};

const androidVersionCatalog = () => {
  const images = installedAndroidImages();
  return curatedAndroidVersions.map((version) => {
    const image = images.find((candidate) => candidate.version === version);
    return {
      version,
      available: Boolean(image),
      api: image?.api || null,
      release: image?.release || null,
      label: image ? androidImageLabel(image) : `Android ${version} (not installed)`,
      abi: image?.abi || null,
      tag: image?.tag || null,
      playStore: Boolean(image?.playStore),
    };
  });
};

const releaseAndroidRuntime = (runtime, reason = "Android session released") => {
  if (!runtime || androidRuntime !== runtime) return Promise.resolve(false);
  if (runtime.leaseTimer) {
    clearTimeout(runtime.leaseTimer);
    runtime.leaseTimer = null;
  }
  if (runtime.hardStopTimer) {
    clearTimeout(runtime.hardStopTimer);
    runtime.hardStopTimer = null;
  }
  androidRuntime = null;
  try {
    runtime.process?.kill();
  } catch {
    // The wrapper may already have exited.
  }
  killNebulaAndroidProcesses();
  killAndroidPortProcess();
  removeAndroidStudioAvdReference(runtime);
  lastAndroidEmulatorExit = {
    at: new Date().toISOString(),
    code: Number.isInteger(runtime.exitCode) ? runtime.exitCode : null,
    signal: runtime.exitSignal || null,
    output: `${reason}\n${runtime.output || ""}`.trim().slice(-8000),
  };
  return removeAndroidSessionDirectory(runtime.sessionDirectory)
    .catch(() => {})
    .then(() => true);
};

const renewAndroidLease = (runtime) => {
  if (!runtime || androidRuntime !== runtime) return;
  if (runtime.leaseTimer) clearTimeout(runtime.leaseTimer);
  runtime.leaseExpiresAt = Date.now() + androidSessionLeaseMs;
  runtime.leaseTimer = setTimeout(() => {
    if (androidRuntime !== runtime || Date.now() < runtime.leaseExpiresAt) return;
    void releaseAndroidRuntime(runtime, "Android session lease expired after its browser stopped responding.");
  }, androidSessionLeaseMs + 250);
  runtime.leaseTimer.unref?.();
};

const expireStaleAndroidRuntime = () => {
  if (!androidRuntime || Date.now() < (androidRuntime.leaseExpiresAt || 0)) return false;
  void releaseAndroidRuntime(androidRuntime, "Android session lease expired and was reclaimed.");
  return true;
};

const assertAndroidOwner = (sessionId) => {
  expireStaleAndroidRuntime();
  if (!androidRuntime || androidRuntime.sessionId !== sessionId) {
    throw new Error("This Android session was started in another browser. Control it from that device.");
  }
  renewAndroidLease(androidRuntime);
  return androidRuntime;
};

const androidEmulatorStatus = (sessionId) => {
  expireStaleAndroidRuntime();
  const emulatorPath = androidToolPath("emulator");
  const adbPath = androidToolPath("adb");
  const images = installedAndroidImages();
  const curatedImages = images.filter((image) => curatedAndroidVersionSet.has(image.version));
  const ownsRuntime = Boolean(androidRuntime && androidRuntime.sessionId === sessionId);
  if (ownsRuntime) renewAndroidLease(androidRuntime);
  const serial = ownsRuntime ? connectedAndroidSerial() : null;
  const release = ownsRuntime ? androidProperty(serial, "ro.build.version.release") : "";
  return {
    ok: true,
    available: Boolean(emulatorPath && adbPath && curatedImages.length),
    sdkRoot: androidSdkRoot(),
    versions: androidVersionCatalog(),
    installedVersions: [...new Set(curatedImages.map((image) => image.version))],
    busy: Boolean(androidRuntime && !ownsRuntime),
    running: Boolean(ownsRuntime && androidRuntime),
    booted: androidProperty(serial, "sys.boot_completed") === "1",
    release: release || null,
    orientation: ownsRuntime ? androidRuntime.orientation : null,
    specs: ownsRuntime ? androidRuntime.specs : null,
    output: ownsRuntime ? androidRuntime.output.trim().slice(-1200) : "",
    leaseRemainingMs: ownsRuntime ? Math.max(0, androidRuntime.leaseExpiresAt - Date.now()) : null,
    hostMemory: {
      availableBytes: freemem(),
      totalBytes: totalmem(),
    },
    lastExit: lastAndroidEmulatorExit,
  };
};

const configureAndroidViewport = (runtime) => {
  const { serial, orientation } = runtime;
  if (!serial) return;
  const profile = androidCompatibilityProfile(runtime.image, runtime.specs, orientation);
  const width = runtime.displayWidth || profile.width;
  const height = runtime.displayHeight || profile.height;
  try {
    runAndroidTool("adb", ["-s", serial, "shell", "wm", "size", `${width}x${height}`]);
    runAndroidTool("adb", ["-s", serial, "shell", "wm", "density", String(runtime.displayDensity || profile.density)]);
  } catch {
    // The device can still be used if Android rejects a temporary display override.
  } finally {
    runtime.configured = true;
  }
};

const androidInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
};

const createDisposableAndroidAvd = (sessionId, image, specs, orientation) => {
  const { sessionDirectory } = androidSessionDirectory(sessionId);
  rmSync(sessionDirectory, { recursive: true, force: true });
  const avdHome = join(sessionDirectory, "avd");
  const androidUserHome = join(sessionDirectory, "android-user");
  const emulatorHome = join(androidUserHome, ".android");
  const avdName = `NebulaVM_${sessionId.slice(0, 12)}_Android_${image.version}`;
  const avdPath = join(avdHome, `${avdName}.avd`);
  mkdirSync(avdPath, { recursive: true });
  mkdirSync(emulatorHome, { recursive: true });
  const profile = androidCompatibilityProfile(image, specs, orientation);
  const width = profile.width;
  const height = profile.height;
  writeFileSync(
    join(avdHome, `${avdName}.ini`),
    `avd.ini.encoding=UTF-8\npath=${avdPath}\ntarget=${image.targetId || `android-${image.api}`}\n`,
  );
  writeFileSync(
    join(avdPath, "config.ini"),
    [
      `AvdId=${avdName}`,
      `PlayStore.enabled=${image.playStore ? "true" : "false"}`,
      `abi.type=${image.abi}`,
      `avd.ini.displayname=NebulaVM private Android ${image.version}`,
      `disk.dataPartition.size=${specs.storageGb}G`,
      "fastboot.forceColdBoot=yes",
      "fastboot.forceFastBoot=no",
      "firstboot.bootFromDownloadableSnapshot=false",
      "firstboot.bootFromLocalSnapshot=false",
      "firstboot.saveToLocalSnapshot=false",
      "hw.accelerometer=yes",
      "hw.audioInput=yes",
      "hw.battery=yes",
      `hw.camera.back=${profile.lowMemory ? "none" : "emulated"}`,
      `hw.camera.front=${profile.lowMemory ? "none" : "emulated"}`,
      `hw.cpu.arch=${image.abi}`,
      `hw.cpu.ncore=${Math.min(specs.cores, profile.maxCores)}`,
      "hw.dPad=no",
      "hw.device.manufacturer=Google",
      `hw.device.name=${profile.deviceName}`,
      "hw.gps=yes",
      "hw.gpu.enabled=yes",
      `hw.gpu.mode=${profile.gpuMode}`,
      `hw.initialOrientation=${orientation}`,
      "hw.keyboard=yes",
      `hw.lcd.density=${profile.density}`,
      `hw.lcd.height=${height}`,
      `hw.lcd.width=${width}`,
      `hw.mainKeys=${profile.mainKeys}`,
      `hw.ramSize=${specs.memoryMb}`,
      "hw.sdCard=no",
      "hw.sensors.orientation=yes",
      "hw.sensors.proximity=yes",
      `image.sysdir.1=${image.relativeImagePath}`,
      "runtime.network.latency=none",
      "runtime.network.speed=full",
      "showDeviceFrame=no",
      "skin.dynamic=yes",
      `skin.name=${width}x${height}`,
      "skin.path=_no_skin",
      `tag.display=${image.playStore ? "Google Play" : image.tag}`,
      `tag.id=${image.tag}`,
      `target=${image.targetId || `android-${image.api}`}`,
      `vm.heapSize=${profile.heapMb}`,
      "",
    ].join("\n"),
  );
  return {
    sessionDirectory,
    avdHome,
    androidUserHome,
    emulatorHome,
    avdName,
    avdPath,
    displayWidth: width,
    displayHeight: height,
    displayDensity: profile.density,
    lowMemory: profile.lowMemory,
    gpuMode: profile.gpuMode,
    maxCores: profile.maxCores,
  };
};

const startAndroidEmulator = (sessionId, body = {}, { publicMobile = false } = {}) => {
  const status = androidEmulatorStatus(sessionId);
  if (!status.available) {
    throw new Error("Install a genuine Android system image in Android Studio first.");
  }
  if (androidRuntime) {
    if (androidRuntime.sessionId !== sessionId) {
      const error = new Error("Android is currently in use by another private browser session.");
      error.statusCode = 409;
      throw error;
    }
    return { ...androidEmulatorStatus(sessionId), starting: !status.booted };
  }
  killNebulaAndroidProcesses();
  killAndroidPortProcess();

  const requestedVersion = Number(body.version);
  if (!curatedAndroidVersionSet.has(requestedVersion)) {
    const error = new Error(`Android ${requestedVersion || ""} is not part of NebulaVM's curated Android test set.`.trim());
    error.statusCode = 400;
    throw error;
  }
  const image = installedAndroidImages().find(
    (candidate) => candidate.version === requestedVersion && curatedAndroidVersionSet.has(candidate.version),
  );
  if (!image) {
    const error = new Error(`A genuine Android ${requestedVersion || ""} system image is not installed on this host.`.trim());
    error.statusCode = 400;
    throw error;
  }
  const freeMemoryMb = Math.floor(freemem() / 1024 / 1024);
  const requestedMemoryMb = publicMobile ? 0 : Number(body.memoryMb) || 0;
  const adaptiveCeilingMb =
    freeMemoryMb >= 6144
      ? 3072
      : freeMemoryMb >= 4608
        ? 2048
        : freeMemoryMb >= 3072
          ? 1280
          : freeMemoryMb >= 1408
            ? 768
            : 512;
  const modernAndroid = requestedVersion >= 15;
  const modernAndroidMinimumHostFreeMb = 3072;
  if (modernAndroid && freeMemoryMb < modernAndroidMinimumHostFreeMb) {
    const error = new Error(
      `Android ${requestedVersion} needs about ${modernAndroidMinimumHostFreeMb} MB free on the public host because the emulator needs extra overhead beyond its 1280 MB device RAM. Only ${freeMemoryMb} MB is currently free. Try an older Android version or wait until the host has more memory.`,
    );
    error.statusCode = 503;
    throw error;
  }
  const selectedMemoryMb =
    requestedMemoryMb > 0
      ? Math.min(androidInteger(requestedMemoryMb, 1024, modernAndroid ? 1024 : 512, 4096), adaptiveCeilingMb)
      : Math.min(adaptiveCeilingMb, publicMobile ? 1280 : 4096);
  const memoryMb = modernAndroid ? Math.max(1280, selectedMemoryMb) : selectedMemoryMb;
  const requestedCores = publicMobile
    ? Math.min(2, cpus().length)
    : androidInteger(body.cores, 4, 1, Math.min(4, cpus().length));
  const preliminarySpecs = { memoryMb };
  const compatibility = androidCompatibilityProfile(image, preliminarySpecs, body.orientation);
  const specs = {
    cores: Math.min(memoryMb <= 768 ? 1 : Math.min(requestedCores, memoryMb <= 1536 ? 2 : 4), compatibility.maxCores),
    memoryMb,
    requestedMemoryMb,
    memoryAdapted: requestedMemoryMb === 0 || memoryMb !== requestedMemoryMb,
    storageGb: publicMobile ? 4 : androidInteger(body.storageGb, 8, 4, 32),
    publicMobileRestricted: publicMobile,
  };
  cleanupOrphanedAndroidSessions();
  ensureHostStorageReserve(
    Math.min(specs.storageGb, 8) * 1024 * 1024 * 1024,
    "create a private Android AVD",
  );
  const orientation = publicMobile
    ? "portrait"
    : body.orientation === "landscape"
      ? "landscape"
      : "portrait";
  const disposable = createDisposableAndroidAvd(sessionId, image, specs, orientation);

  const emulatorPath = androidToolPath("emulator");
  const processHandle = spawn(
    emulatorPath,
    [
      "-avd",
      disposable.avdName,
      "-port",
      String(androidEmulatorPort),
      "-no-window",
      "-no-snapshot",
      "-no-snapstorage",
      "-no-snapshot-load",
      "-no-snapshot-save",
      "-no-audio",
      "-no-boot-anim",
      "-gpu",
      disposable.gpuMode,
      "-feature",
      "-BluetoothEmulation",
      "-feature",
      "-Mac80211hwsimUserspaceManaged",
      "-feature",
      "-ModemSimulator",
      "-feature",
      "-Uwb",
      "-cores",
      String(specs.cores),
      "-memory",
      String(specs.memoryMb),
      ...(disposable.lowMemory ? ["-prop", "ro.config.low_ram=true"] : []),
      "-no-metrics",
      "-qemu",
      "-m",
      String(specs.memoryMb),
    ],
    {
      cwd: workspaceDir,
      env: {
        ...process.env,
        ANDROID_SDK_ROOT: androidSdkRoot(),
        ANDROID_HOME: androidSdkRoot(),
        ANDROID_AVD_HOME: disposable.avdHome,
        ANDROID_USER_HOME: disposable.androidUserHome,
        ANDROID_EMULATOR_HOME: disposable.emulatorHome,
        ANDROID_PREFS_ROOT: disposable.androidUserHome,
      },
      windowsHide: true,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  androidRuntime = {
    sessionId,
    process: processHandle,
    serial: androidEmulatorSerial,
    output: "",
    configured: false,
    awake: false,
    blankFrameCount: 0,
    frameCaptureFailureCount: 0,
    lastDisplayRecoveryAt: 0,
    image,
    specs,
    orientation,
    ...disposable,
    wrapperExited: false,
    exitCode: null,
    exitSignal: null,
    leaseExpiresAt: 0,
    leaseTimer: null,
    hardStopTimer: null,
  };
  renewAndroidLease(androidRuntime);
  if (publicMobile) {
    androidRuntime.hardStopTimer = setTimeout(() => {
      if (androidRuntime?.sessionId !== sessionId) return;
      void releaseAndroidRuntime(
        androidRuntime,
        "Public mobile Android session reached its 20-minute limit.",
      );
    }, 20 * 60_000);
    androidRuntime.hardStopTimer.unref?.();
  }
  exposeAndroidAvdToStudio(androidRuntime);
  lastAndroidEmulatorExit = null;
  const rememberAndroidOutput = (chunk) => {
    if (androidRuntime?.sessionId === sessionId) {
      androidRuntime.output = `${androidRuntime.output}${chunk}`.slice(-8000);
    }
  };
  processHandle.stdout.on("data", rememberAndroidOutput);
  processHandle.stderr.on("data", rememberAndroidOutput);
  processHandle.once("exit", (code, signal) => {
    const exitedRuntime = androidRuntime?.sessionId === sessionId ? androidRuntime : null;
    if (exitedRuntime) {
      exitedRuntime.exitCode = Number.isInteger(code) ? code : null;
      exitedRuntime.exitSignal = signal || null;
      lastAndroidEmulatorExit = {
        at: new Date().toISOString(),
        code: exitedRuntime.exitCode,
        signal: exitedRuntime.exitSignal,
        output: exitedRuntime.output.trim().slice(-8000),
      };
      exitedRuntime.wrapperExited = true;
    }
    let checksRemaining = 8;
    const verifyChildRuntime = () => {
      if (androidRuntime?.sessionId !== sessionId) return;
      if (androidPortProcessId() || nebulaAndroidProcessIds().length) {
        androidRuntime.output = `${androidRuntime.output}\nAndroid launcher handed off to its emulator child.`.slice(
          -12000,
        );
        return;
      }
      checksRemaining -= 1;
      if (checksRemaining > 0) {
        setTimeout(verifyChildRuntime, 2000);
        return;
      }
      const failedRuntime = androidRuntime;
      void releaseAndroidRuntime(failedRuntime, "Android emulator and its child process exited.");
    };
    setTimeout(verifyChildRuntime, 2000);
  });
  processHandle.once("error", (error) => {
    rememberAndroidOutput(error.message);
  });

  return {
    ok: true,
    available: true,
    starting: true,
    running: true,
    booted: false,
    version: image.version,
    api: image.api,
    orientation,
    specs,
    installedVersions: status.installedVersions,
  };
};

const androidEmulatorFrame = async (sessionId) => {
  const runtime = assertAndroidOwner(sessionId);
  const serial = connectedAndroidSerial();
  if (!serial) throw new Error("The Android Emulator is not connected yet.");
  if (!runtime.configured) {
    configureAndroidViewport(runtime);
  }
  if (!runtime.awake && androidProperty(serial, "sys.boot_completed") === "1") {
    const runBootCommand = async (args, { required = false } = {}) => {
      try {
        renewAndroidLease(runtime);
        await runAndroidToolAsync("adb", ["-s", serial, "shell", ...args], {
          timeout: 15000,
        });
        renewAndroidLease(runtime);
        return true;
      } catch (error) {
        if (required) throw error;
        return false;
      }
    };
    const api = Number(runtime.image.api) || 36;
    if (api >= 23) {
      await runBootCommand(["settings", "put", "global", "hide_error_dialogs", "1"]);
    }
    if (api >= 17) {
      await runBootCommand(["settings", "put", "global", "stay_on_while_plugged_in", "7"]);
      await runBootCommand(["settings", "put", "global", "window_animation_scale", "0"]);
      await runBootCommand(["settings", "put", "global", "transition_animation_scale", "0"]);
      await runBootCommand(["settings", "put", "global", "animator_duration_scale", "0"]);
    }
    await runBootCommand(["settings", "put", "system", "screen_off_timeout", "2147483647"]);
    await runBootCommand(["svc", "power", "stayon", "true"]);
    if (runtime.specs.memoryMb <= 1536 && api >= 21) {
      await runBootCommand(["settings", "put", "global", "activity_manager_constants", "max_cached_processes=8"]);
      for (const packageName of [
        "com.google.android.googlequicksearchbox",
        "com.google.android.apps.wellbeing",
        "com.google.android.apps.photos",
        "com.google.android.apps.maps",
        "com.google.android.apps.docs",
        "com.google.android.apps.youtube.music",
        "com.google.android.apps.messaging",
      ]) {
        await runBootCommand(["am", "force-stop", packageName]);
      }
    }
    await runBootCommand(["input", "keyevent", "KEYCODE_WAKEUP"]);
    await runBootCommand(["input", "keyevent", "26"]);
    await runBootCommand(["wm", "dismiss-keyguard"]);
    await runBootCommand(["input", "keyevent", "KEYCODE_HOME"]);
    await runBootCommand(["input", "keyevent", "3"]);
    runtime.awake = true;
  }
  let image;
  try {
    image = await runAndroidToolAsync("adb", ["-s", serial, "exec-out", "screencap", "-p"], {
      binary: true,
      timeout: 20000,
    });
  } catch (error) {
    const booted = androidProperty(serial, "sys.boot_completed") === "1";
    const captureTimedOut = /timed out/i.test(String(error?.message || error));
    runtime.frameCaptureFailureCount += 1;
    if (
      booted &&
      captureTimedOut &&
      runtime.frameCaptureFailureCount >= 1 &&
      Date.now() - runtime.lastDisplayRecoveryAt > 120_000
    ) {
      runtime.lastDisplayRecoveryAt = Date.now();
      runtime.frameCaptureFailureCount = 0;
      runtime.awake = false;
      runtime.configured = false;
      await releaseAndroidRuntime(
        runtime,
        "Android display stopped responding after boot, so NebulaVM reset the session.",
      );
      throw new Error("Android display stalled. The session was reset; press Start Android to try again.");
    }
    // Older Android releases cannot stream screencap output and may mount
    // /sdcard read-only, but /data/local/tmp remains available over ADB.
    const remoteFramePath = "/data/local/tmp/nebulavm-frame.png";
    const localFramePath = join(runtime.sessionDirectory, "android-frame.png");
    try {
      await runAndroidToolAsync("adb", ["-s", serial, "shell", "screencap", remoteFramePath], {
        timeout: 20000,
      });
      await runAndroidToolAsync("adb", ["-s", serial, "pull", remoteFramePath, localFramePath], {
        timeout: 20000,
      });
      void runAndroidToolAsync("adb", ["-s", serial, "shell", "rm", "-f", remoteFramePath], {
        timeout: 5000,
      }).catch(() => {});
    } catch {
      await runAndroidToolAsync("adb", ["-s", serial, "emu", "screenrecord", "screenshot", localFramePath], {
        timeout: 20000,
      });
    }
    image = readFileSync(localFramePath);
  }
  if (!image?.length) throw new Error("The Android Emulator returned an empty frame.");
  runtime.frameCaptureFailureCount = 0;
  const booted = androidProperty(serial, "sys.boot_completed") === "1";
  runtime.blankFrameCount = booted && image.length < 12_000 ? runtime.blankFrameCount + 1 : 0;
  if (runtime.blankFrameCount >= 4 && Date.now() - runtime.lastDisplayRecoveryAt > 60_000) {
    runtime.lastDisplayRecoveryAt = Date.now();
    runtime.blankFrameCount = 0;
    const recover = (args) =>
      runAndroidToolAsync("adb", ["-s", serial, "shell", ...args], { timeout: 15000 }).catch(() => {});
    await recover(["am", "force-stop", "com.google.android.apps.nexuslauncher"]);
    await recover(["pkill", "com.android.systemui"]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2500));
    await recover(["input", "keyevent", "KEYCODE_WAKEUP"]);
    await recover(["wm", "dismiss-keyguard"]);
    await recover([
      "am",
      "start",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.HOME",
    ]);
    runtime.output = `${runtime.output}\nNebulaVM recovered a blank Android display.`.slice(-12000);
  }
  return image;
};

const sendAndroidEmulatorInput = async (sessionId, body = {}) => {
  const runtime = assertAndroidOwner(sessionId);
  const serial = connectedAndroidSerial();
  if (!serial) throw new Error("The Android Emulator is not connected.");
  const clampCoordinate = (value, maximum) =>
    String(Math.max(0, Math.min(maximum, Math.round(Number(value) || 0))));
  const keyMap = {
    back: ["KEYCODE_BACK", "4"],
    home: ["KEYCODE_HOME", "3"],
    recents: ["KEYCODE_APP_SWITCH", "187"],
    wake: ["KEYCODE_WAKEUP", "26"],
    power: ["KEYCODE_POWER", "26"],
    enter: ["KEYCODE_ENTER", "66"],
    escape: ["KEYCODE_BACK", "4"],
  };

  const runInput = async (variants) => {
    let lastError;
    const commands = Array.isArray(variants?.[0]) ? variants : [variants];
    for (const args of commands) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await runAndroidToolAsync("adb", ["-s", serial, "shell", "input", ...args]);
          return;
        } catch (error) {
          lastError = error;
          if (/can't find service:\s*input/i.test(String(error?.message || error))) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
          } else {
            break;
          }
        }
      }
    }
    throw new Error(
      "Android is still starting. Controls will become available when the operating system finishes booting.",
      { cause: lastError },
    );
  };

  if (body.type === "reboot") {
    renewAndroidLease(runtime);
    runtime.awake = false;
    await runAndroidToolAsync("adb", ["-s", serial, "reboot"], { timeout: 15000 });
  } else if (body.type === "key" && keyMap[body.key]) {
    await runInput(keyMap[body.key].map((keyCode) => ["keyevent", keyCode]));
  } else if (body.type === "tap") {
    const x = clampCoordinate(body.x, runtime.displayWidth || (runtime.orientation === "landscape" ? 1920 : 1080));
    const y = clampCoordinate(body.y, runtime.displayHeight || (runtime.orientation === "landscape" ? 1080 : 1920));
    await runInput([
      ["tap", x, y],
      ["touchscreen", "tap", x, y],
    ]);
  } else if (body.type === "swipe") {
    const x1 = clampCoordinate(body.x1, runtime.displayWidth || (runtime.orientation === "landscape" ? 1920 : 1080));
    const y1 = clampCoordinate(body.y1, runtime.displayHeight || (runtime.orientation === "landscape" ? 1080 : 1920));
    const x2 = clampCoordinate(body.x2, runtime.displayWidth || (runtime.orientation === "landscape" ? 1920 : 1080));
    const y2 = clampCoordinate(body.y2, runtime.displayHeight || (runtime.orientation === "landscape" ? 1080 : 1920));
    const duration = String(Math.max(50, Math.min(3000, Math.round(Number(body.duration) || 250))));
    await runInput([
      ["swipe", x1, y1, x2, y2, duration],
      ["touchscreen", "swipe", x1, y1, x2, y2, duration],
    ]);
  } else if (body.type === "text") {
    const text = String(body.text || "").slice(0, 500).replace(/%/g, "%25").replace(/\s/g, "%s");
    await runInput(["text", text]);
  } else {
    throw new Error("Unsupported Android input.");
  }
  return { ok: true };
};

const stopAndroidEmulator = async (sessionId) => {
  const runtime = assertAndroidOwner(sessionId);
  const serial = connectedAndroidSerial();
  if (serial) {
    try {
      runAndroidTool("adb", ["-s", serial, "emu", "kill"], { timeout: 10000 });
    } catch {
      runtime.process?.kill();
    }
  } else {
    runtime.process?.kill();
  }
  await releaseAndroidRuntime(runtime, "Android session stopped by its browser.");
  return { ok: true, deleted: true };
};

const cleanupOrphanedAndroidSessions = () => {
  if (androidRuntime) return;
  try {
    runAndroidTool("adb", ["-s", androidEmulatorSerial, "emu", "kill"], { timeout: 5000 });
  } catch {
    // No disposable NebulaVM Android emulator is running.
  }
  killNebulaAndroidProcesses();
  killAndroidPortProcess();
  if (existsSync(androidSessionsRoot)) {
    rmSync(androidSessionsRoot, { recursive: true, force: true });
  }
  const studioAvdHome = androidStudioAvdHome();
  if (existsSync(studioAvdHome)) {
    for (const entry of readdirSync(studioAvdHome, { withFileTypes: true })) {
      if (entry.isFile() && /^NebulaVM_[A-Za-z0-9_-]+\.ini$/i.test(entry.name)) {
        rmSync(join(studioAvdHome, entry.name), { force: true });
      }
    }
  }
};

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
      try {
        if (process.platform === "win32" && child.pid) {
          execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 5000,
          });
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        child.kill();
      }
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
      try {
        if (process.platform === "win32" && child.pid) {
          execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 5000,
          });
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        child.kill();
      }
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

let hyperVConsoleFrameQueue = Promise.resolve();
let hyperVConsoleInputQueue = Promise.resolve();

const runHyperVConsoleFrameExclusive = (action) => {
  const next = hyperVConsoleFrameQueue.catch(() => {}).then(action);
  hyperVConsoleFrameQueue = next.catch(() => {});
  return next;
};

const runHyperVConsoleInputExclusive = (action) => {
  const next = hyperVConsoleInputQueue.catch(() => {}).then(action);
  hyperVConsoleInputQueue = next.catch(() => {});
  return next;
};

const runHyperVConsoleFrame = (contentOnly = false) =>
  runHyperVConsoleFrameExclusive(() =>
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
        ...(contentOnly ? ["-ContentOnly"] : []),
      ],
      45000,
    ),
  );

const runHyperVConsoleInput = (body) =>
  runHyperVConsoleInputExclusive(() =>
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
    ),
  );

const runAndroidStudioFrame = (sessionId) => {
  const runtime = assertAndroidOwner(sessionId);
  exposeAndroidAvdToStudio(runtime);
  const openDeviceManager = !runtime.studioManagerOpened;
  runtime.studioManagerOpened = true;
  return runPowerShellJson(
    "Android Studio frame",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      androidStudioFrameScriptPath,
      "-OutputPath",
      androidStudioFramePath,
      "-AvdName",
      runtime.avdName,
      ...(openDeviceManager ? ["-AllowLaunch", "-OpenDeviceManager"] : []),
    ],
    60000,
  );
};

const runAndroidStudioInput = (sessionId, body) => {
  const runtime = assertAndroidOwner(sessionId);
  exposeAndroidAvdToStudio(runtime);
  return runPowerShellJson(
    "Android Studio input",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      androidStudioInputScriptPath,
      "-ConfigBase64",
      Buffer.from(JSON.stringify(body || {}), "utf8").toString("base64"),
      "-AvdName",
      runtime.avdName,
    ],
    45000,
  );
};

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
  const enrichedStatus = {
    ...status,
    guestAddress,
    vncPath: hyperVGuestVncPath,
    vncReady,
    vncPassword,
  };

  if (enrichedStatus.vm?.state === "Running") {
    if (!hyperVRemoteSessionId) {
      hyperVRemoteSessionId = randomBytes(12).toString("hex");
      hyperVRemoteSessionStartedAt = new Date().toISOString();
    }
    enrichedStatus.remoteSessionId = hyperVRemoteSessionId;
    enrichedStatus.remoteSessionStartedAt = hyperVRemoteSessionStartedAt;
  } else {
    hyperVRemoteSessionId = "";
    hyperVRemoteSessionStartedAt = "";
    enrichedStatus.remoteSessionId = "";
    enrichedStatus.remoteSessionStartedAt = "";
  }

  return enrichedStatus;
};

const cacheHyperVStatus = (status, ttlMs = 8000, expectedRevision = null) => {
  if (expectedRevision !== null && expectedRevision !== hyperVStatusRevision) {
    return hyperVStatusCache.data || status;
  }
  hyperVStatusCache = {
    expiresAt: Date.now() + ttlMs,
    data: status,
  };
  return status;
};

const clearHyperVStatusCache = () => {
  hyperVStatusRevision += 1;
  hyperVStatusCache = { expiresAt: 0, data: null };
};

const hyperVStartKey = (config) =>
  JSON.stringify({
    storageOwnerId: config.storageOwnerId,
    isoPath: config.isoPath,
    templateDiskPath: config.templateDiskPath,
    memoryMb: config.memoryMb,
    displayWidth: config.displayWidth,
    displayHeight: config.displayHeight,
    bootOrder: config.bootOrder,
    diskSizeGb: config.diskSizeGb,
  });

const withHyperVAutopilotAction = (result, action) => ({
  ...result,
  warnings: [
    ...(result.warnings || []),
    `NebulaVM Autopilot: ${action}`,
  ],
});

const getHyperVStatus = async ({ maxAgeMs = 8000, timeoutMs = 25000, force = false } = {}) => {
  if (!force && hyperVStatusCache.data && Date.now() < hyperVStatusCache.expiresAt) {
    return hyperVStatusCache.data;
  }

  let revision = hyperVStatusRevision;
  if (hyperVStatusTask?.revision === revision) {
    const activeTask = hyperVStatusTask;
    if (!force) return activeTask.promise;

    try {
      await activeTask.promise;
    } catch {
      // A forced confirmation still needs a newer probe after the active one fails.
    }
    revision = hyperVStatusRevision;
    if (
      hyperVStatusTask?.revision === revision &&
      hyperVStatusTask.promise !== activeTask.promise
    ) {
      return hyperVStatusTask.promise;
    }
  }

  const statusPromise = (async () => {
    const rawStatus = await runHyperVAction("Status", {}, timeoutMs);
    if (revision !== hyperVStatusRevision && hyperVStatusCache.data) {
      return hyperVStatusCache.data;
    }
    const status = await withHyperVDisplayStatus(rawStatus);
    if (revision !== hyperVStatusRevision && hyperVStatusCache.data) {
      return hyperVStatusCache.data;
    }
    return cacheHyperVStatus(status, maxAgeMs, revision);
  })();
  hyperVStatusTask = { revision, promise: statusPromise };
  try {
    return await statusPromise;
  } finally {
    if (hyperVStatusTask?.promise === statusPromise) {
      hyperVStatusTask = null;
    }
  }
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
    throw new Error("Stop Hyper-V before resetting its UEFI settings.");
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
    runtime: activeNativeRuntimeName || "Hyper-V",
    engine: "QEMU",
    lastExit: lastNativeExit,
  };
};

const stopNativeVmIfRunning = async () => {
  if (!nativeVm) return null;

  const child = nativeVm;
  const stopped = {
    runtime: activeNativeRuntimeName || "QEMU",
    pid: child.pid || null,
  };

  await new Promise((resolveStop) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveStop();
    };
    const timeout = setTimeout(finish, 5000);
    child.once("exit", finish);
    child.once("error", finish);
    try {
      child.kill();
    } catch {
      finish();
    }
  });

  if (nativeVm === child) {
    nativeVm = null;
    activeNativeRuntimeName = null;
  }
  return stopped;
};

const startNativeVm = async (body) => {
  let replacedRuntime = null;
  if (nativeVm) {
    const stopped = await stopNativeVmIfRunning();
    replacedRuntime = stopped?.runtime || "QEMU";
  }
  const hyperVStatus = await runHyperVAction("Status", {}, 45000).catch(() => null);
  if (hyperVStatus?.vm?.state === "Running") {
    await runHyperVAction("Stop", {}, 120000);
    replacedRuntime = "Hyper-V";
    hyperVRemoteSessionId = "";
    hyperVRemoteSessionStartedAt = "";
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
      const qemuError = nativeVmOutput.trim() || lastNativeExit?.output || "";
      throw new Error(
        qemuError
          ? `QEMU exited before its embedded display opened: ${qemuError}`
          : error.message,
      );
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
    replacedRuntime,
    get recentOutput() {
      return nativeVmOutput;
    },
  };
};

const stopSafetySession = async (session) => {
  session.stopRequested = true;
  session.stopMessage = "Admin stopped your VM";
  if (session.emulator.toLowerCase().includes("hyper-v")) {
    await runHyperVAction("Stop", {}, 120000).catch(() => null);
    hyperVRemoteSessionId = "";
    hyperVRemoteSessionStartedAt = "";
    clearHyperVStatusCache();
  } else if (session.emulator.toLowerCase().includes("native qemu")) {
    await stopNativeVmIfRunning();
  }
  return { ok: true, message: session.stopMessage };
};

const nativeQemuPlugin = () => ({
  name: "nebulavm-native-qemu",
  configureServer(server) {
    cleanupOrphanedAndroidSessions();
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
        const status = await getHyperVStatus({ maxAgeMs: 3000, timeoutMs: 25000 });
        if (!status.guestAddress || !status.vncReady) {
          socket.close(1011, "The Hyper-V guest display is not ready.");
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
        socket.close(1011, "The Hyper-V guest display could not be reached.");
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
      const isAndroidApi = url.pathname.startsWith("/api/android-emulator");
      const isAndroidStudioApi = url.pathname.startsWith("/api/android-studio");
      const isHostApi = url.pathname.startsWith("/api/emustar-host/");
      const isSafetyMonitorApi = url.pathname.startsWith("/api/nebulavm-monitor/");
      const isSafetyAdminApi = url.pathname.startsWith("/api/nebulavm-admin/");
      const isMobileDevUnlockApi =
        url.pathname === "/api/mobile-dev-unlock" || url.pathname === "/.netlify/functions/mobile-dev-unlock";
      const isReportProblemApi =
        url.pathname === "/api/report-problem" || url.pathname === "/.netlify/functions/report-problem";
      const isCommitHistoryApi =
        url.pathname === "/api/commit-history" || url.pathname === "/.netlify/functions/commit-history";
      if (
        !isNativeQemuApi &&
        !isHyperVApi &&
        !isAndroidApi &&
        !isAndroidStudioApi &&
        !isHostApi &&
        !isSafetyMonitorApi &&
        !isSafetyAdminApi &&
        !isMobileDevUnlockApi &&
        !isReportProblemApi &&
        !isCommitHistoryApi
      ) {
        next();
        return;
      }

      setNativeQemuCors(req, res);

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (isSafetyAdminApi) {
        if (!isLoopbackRequest(req)) {
          json(res, 403, { ok: false, error: "NebulaVM Admin Console is available on this PC only." });
          return;
        }
        try {
          cleanupSafetySessions();
          if (req.method === "GET" && url.pathname === "/api/nebulavm-admin/sessions") {
            json(res, 200, {
              ok: true,
              sessions: [...safetySessions.values()].map(safetySessionSummary),
            });
            return;
          }
          if (req.method === "POST" && url.pathname === "/api/nebulavm-admin/monitor") {
            const body = await readJsonBody(req);
            const id = safetySessionId(body.sessionId);
            const session = safetySessions.get(id);
            if (!session) throw new Error("That VM session is no longer active.");
            session.monitorUntil = body.active ? Date.now() + safetyMonitorLeaseMs : 0;
            json(res, 200, { ok: true, monitoring: Boolean(body.active) });
            return;
          }
          if (req.method === "GET" && url.pathname === "/api/nebulavm-admin/preview") {
            const id = safetySessionId(url.searchParams.get("sessionId"));
            const session = safetySessions.get(id);
            if (!session?.frame?.length) {
              json(res, 404, { ok: false, error: "Preview is waiting for the monitored browser." });
              return;
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", session.frameMimeType || "image/jpeg");
            res.setHeader("Cache-Control", "no-store");
            res.end(session.frame);
            return;
          }
          if (req.method === "POST" && url.pathname === "/api/nebulavm-admin/stop") {
            const body = await readJsonBody(req);
            const id = safetySessionId(body.sessionId);
            const session = safetySessions.get(id);
            if (!session) throw new Error("That VM session is no longer active.");
            json(res, 200, await stopSafetySession(session));
            return;
          }
          json(res, 404, { ok: false, error: "Unknown NebulaVM Admin Console endpoint." });
        } catch (error) {
          json(res, 400, { ok: false, error: error.message });
        }
        return;
      }

      const publicMobileRequest = isPublicMobileRequest(req);

      if (
        !publicAndroidEnabled &&
        (isAndroidApi || isAndroidStudioApi) &&
        !(req.method === "POST" && url.pathname === "/api/android-emulator/stop")
      ) {
        json(res, 410, {
          ok: false,
          available: false,
          error: "Android is disabled on the public NebulaVM host because it uses host RAM.",
        });
        return;
      }

      if (isMobileDevUnlockApi) {
        try {
          const body = await readJsonBody(req);
          const result = verifyMobileDevUnlock(req, body);
          json(res, result.status, result.body, result.headers);
        } catch (error) {
          json(res, 400, { ok: false, error: error.message });
        }
        return;
      }

      if (isReportProblemApi) {
        if (!["GET", "POST"].includes(req.method)) {
          json(res, 405, { ok: false, error: "Method not allowed." });
          return;
        }
        let moderationLockoutUntil = null;
        try {
          const { key, limit } = localProblemReportLimit(req);
          const lockedUntil = Number(limit.lockedUntil || 0);
          if (req.method === "GET") {
            const locked = lockedUntil > Date.now();
            json(res, 200, {
              ok: true,
              canReport: !locked,
              lockoutUntil: locked ? new Date(lockedUntil).toISOString() : null,
              reason: locked ? "profane language" : null,
            });
            return;
          }
          if (lockedUntil > Date.now()) {
            const error = new Error("Can't report now. Reason: profane language.");
            error.statusCode = 429;
            error.lockoutUntil = new Date(lockedUntil).toISOString();
            throw error;
          }
          if (Number(limit.count || 0) >= localProblemReportMaxPerHour) {
            const error = new Error("Too many reports were sent. Please try again later.");
            error.statusCode = 429;
            throw error;
          }
          const gmailUser = reportGmailAccount;
          const gmailAppPassword = String(
            localEnvValue("NEBULAVM_REPORT_GMAIL_APP_PASSWORD") || "",
          ).replace(/\s+/g, "");
          const destination = String(
            localEnvValue("NEBULAVM_REPORT_TO") || reportGmailAccount,
          ).trim();
          if (!gmailAppPassword) {
            const error = new Error("Problem reporting is not configured yet.");
            error.statusCode = 503;
            throw error;
          }
          const report = validateProblemReport(await readJsonBody(req));
          const moderated = containsStrongProfanity(report.description);
          const consequence = moderated ? nextProfanityConsequence(limit) : null;
          const moderationCooldownMinutes = consequence?.cooldownMinutes || 0;
          const submittedReport = moderated
            ? { ...report, description: redactStrongProfanity(report.description) }
            : report;
          const message = buildProblemReportEmail(submittedReport);
          const transport = nodemailer.createTransport({
            service: "gmail",
            auth: { user: gmailUser, pass: gmailAppPassword },
          });
          if (moderated) {
            moderationLockoutUntil = moderationCooldownMinutes
              ? new Date(Date.now() + moderationCooldownMinutes * 60 * 1000).toISOString()
              : null;
            localProblemReportLimits.set(key, {
              ...limit,
              startedAt: limit.startedAt,
              count: Number(limit.count || 0) + 1,
              profanityStrikeStartedAt: consequence.strikeStartedAt,
              profanityStrikes: consequence.strikes,
              ...(moderationLockoutUntil
                ? { lockedUntil: Date.parse(moderationLockoutUntil) }
                : {}),
            });
          }
          await transport.sendMail({
            from: `"NebulaVM Problem Reports" <${gmailUser}>`,
            to: destination,
            replyTo: report.email,
            subject: message.subject,
            text: message.text,
            html: message.html,
          });
          if (moderationCooldownMinutes) {
            const moderationMessage = buildProfanityModerationEmail({
              cooldownMinutes: moderationCooldownMinutes,
            });
            await transport.sendMail({
              from: `"NebulaVM Automated Moderation" <${gmailUser}>`,
              to: report.email,
              subject: moderationMessage.subject,
              text: moderationMessage.text,
              html: moderationMessage.html,
            });
          }
          if (!moderated) {
            localProblemReportLimits.set(key, {
              ...limit,
              startedAt: limit.startedAt,
              count: Number(limit.count || 0) + 1,
            });
          }
          json(res, 200, {
            ok: true,
            moderated,
            canReport: !moderationLockoutUntil,
            lockoutUntil: moderationLockoutUntil,
            reason: moderationLockoutUntil ? "profane language" : null,
            message: moderated
              ? moderationCooldownMinutes
                ? `Your report was submitted with strong language redacted. Reporting is paused for ${moderationCooldownMinutes} minutes.`
                : "We noticed strong language. Your report was submitted with that language automatically redacted."
              : "Your report was sent. Thank you.",
          });
        } catch (error) {
          json(res, Number(error.statusCode) || 500, {
            ok: false,
            ...(error?.lockoutUntil || moderationLockoutUntil
              ? {
                  canReport: false,
                  lockoutUntil: error?.lockoutUntil || moderationLockoutUntil,
                  reason: "profane language",
                }
              : {}),
            error:
              error.statusCode
                ? error.message
                : "The report could not be sent. Please try again later.",
          });
        }
        return;
      }

      if (isCommitHistoryApi) {
        if (req.method !== "GET") {
          json(res, 405, { ok: false, error: "Method not allowed." });
          return;
        }
        try {
          const commits = await getCommitHistory();
          json(res, 200, {
            ok: true,
            commits,
            total: commits.length,
            generatedAt: new Date().toISOString(),
          });
        } catch {
          json(res, 502, {
            ok: false,
            error: "Commit history could not be loaded. Please try again.",
          });
        }
        return;
      }

      if (!isAuthorizedHostRequest(req, url)) {
        json(res, 401, { error: "This Hyper-V host link is missing a valid access token." });
        return;
      }

      const remoteConsoleRequest =
        String(req.headers["x-nebulavm-client-class"] || "") === "remote-console";
      const publicRemoteConsoleHyperVRequest =
        remoteConsoleRequest &&
        isHyperVApi &&
        ((req.method === "GET" && url.pathname === "/api/emustar-hyperv/status") ||
          (req.method === "GET" && url.pathname === "/api/emustar-hyperv/console-frame") ||
          (req.method === "POST" && url.pathname === "/api/emustar-hyperv/console-input"));

      if (
        publicMobileRequest &&
        (isNativeQemuApi ||
          (isHyperVApi && !publicRemoteConsoleHyperVRequest) ||
          isAndroidStudioApi ||
          (isHostApi && url.pathname !== "/api/emustar-host/info"))
      ) {
        json(res, 403, {
          ok: false,
          error: "Public mobile mode can only connect to an existing Remote VM stream.",
        });
        return;
      }

      try {
        if (req.method === "POST" && url.pathname === "/api/nebulavm-monitor/heartbeat") {
          const body = await readJsonBody(req);
          const id = safetySessionId(body.sessionId || req.headers["x-nebulavm-session"]);
          const now = Date.now();
          const existing = safetySessions.get(id) || {};
          const session = {
            ...existing,
            id,
            ip: safetyClientIp(req),
            location: safetyClientLocation(req),
            emulator: String(body.emulator || "Unknown emulator").slice(0, 80),
            media: String(body.media || "No media name").slice(0, 260),
            startedAt: existing.startedAt || body.startedAt || new Date(now).toISOString(),
            lastSeen: now,
          };
          safetySessions.set(id, session);
          cleanupSafetySessions();
          const monitoring = Number(session.monitorUntil || 0) > now;
          const stopRequested = Boolean(session.stopRequested);
          const stopMessage = session.stopMessage || "Admin stopped your VM";
          if (stopRequested) {
            session.stopRequested = false;
            session.stopMessage = "";
          }
          json(res, 200, { ok: true, monitoring, stopRequested, stopMessage });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/nebulavm-monitor/frame") {
          const id = safetySessionId(
            url.searchParams.get("sessionId") || req.headers["x-nebulavm-session"],
          );
          const session = safetySessions.get(id);
          if (!session || Number(session.monitorUntil || 0) <= Date.now()) {
            json(res, 409, { ok: false, error: "Fullscreen safety monitoring is not active." });
            return;
          }
          const frame = await readBinaryBody(req, safetyFrameMaxBytes);
          if (!frame.length) throw new Error("Monitoring frame is empty.");
          session.frame = frame;
          session.frameMimeType = /^image\/(jpeg|png|webp)$/i.test(String(req.headers["content-type"] || ""))
            ? String(req.headers["content-type"])
            : "image/jpeg";
          session.lastFrameAt = Date.now();
          json(res, 200, { ok: true });
          return;
        }

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

        if (req.method === "GET" && url.pathname === "/api/emustar-host/upload-iso-status") {
          json(res, 200, browserIsoUploadStatus(req));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/emustar-host/windows11-template") {
          json(res, 200, ensureWindows11TemplateIso());
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/emustar-host/stored-isos") {
          json(res, 200, listStoredIsos(storedIsoOwnerId(req)));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-host/stored-isos") {
          const body = await readJsonBody(req);
          const result = storeBrowserIsoOnHost(storedIsoOwnerId(req), body);
          json(res, result.ok ? 200 : 409, result);
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-host/stored-isos/remove") {
          const body = await readJsonBody(req);
          json(res, 200, removeStoredIso(storedIsoOwnerId(req), body.id || ""));
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
          json(
            res,
            200,
            await getHyperVStatus({ force: url.searchParams.get("fresh") === "1" }),
          );
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/start") {
          const requestedBody = await readJsonBody(req);
          const body = requestedBody.templateDiskPath
            ? { ...requestedBody, isoPath: "" }
            : requestedBody;
          assertStoredIsoAccess(req, body.isoPath);
          const storageOwnerId = storedIsoOwnerId(req);
          const startConfig = {
            ...body,
            storageOwnerId,
            vmDirectory: resolve(workspaceDir, "vm-disks", "emustar-hyperv"),
          };
          const requestKey = hyperVStartKey(startConfig);

          if (hyperVStartTask) {
            if (hyperVStartTask.key !== requestKey) {
              json(res, 409, {
                ok: false,
                error: "Hyper-V is finishing another VM start. Wait a moment, then launch again.",
              });
              return;
            }
            const joinedResult = await hyperVStartTask.promise;
            json(
              res,
              200,
              withHyperVAutopilotAction(
                joinedResult,
                "joined a duplicate start request instead of restarting the running VM.",
              ),
            );
            return;
          }

          if (
            lastHyperVStart?.key === requestKey &&
            Date.now() - lastHyperVStart.finishedAt < 45_000
          ) {
            clearHyperVStatusCache();
            const currentStatus = await getHyperVStatus({ maxAgeMs: 0, timeoutMs: 25000 });
            if (currentStatus.vm?.state === "Running") {
              json(
                res,
                200,
                withHyperVAutopilotAction(
                  {
                    ...lastHyperVStart.result,
                    ...currentStatus,
                    attachedExisting: true,
                  },
                  "ignored a repeated start because this exact VM is already running.",
                ),
              );
              return;
            }
          }

          const startPromise = (async () => {
            let replacedRuntime = null;
            if (nativeVm) {
              const stopped = await stopNativeVmIfRunning();
              replacedRuntime = stopped?.runtime || "QEMU";
            }
            const actionResult = await runHyperVAction("Start", startConfig, 120000);
            hyperVRemoteSessionId = randomBytes(12).toString("hex");
            hyperVRemoteSessionStartedAt = new Date().toISOString();
            actionResult.replacedRuntime = replacedRuntime;
            clearHyperVStatusCache();
            return cacheHyperVStatus(await withHyperVDisplayStatus(actionResult));
          })();
          hyperVStartTask = { key: requestKey, promise: startPromise };

          try {
            const result = await startPromise;
            lastHyperVStart = {
              key: requestKey,
              finishedAt: Date.now(),
              result,
            };
            json(res, 200, result);
          } finally {
            if (hyperVStartTask?.promise === startPromise) {
              hyperVStartTask = null;
            }
          }
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/emustar-host/autopilot-activity") {
          const events = existsSync(autopilotEventPath)
            ? readFileSync(autopilotEventPath, "utf8")
                .split(/\r?\n/)
                .filter(Boolean)
                .slice(-80)
                .flatMap((line) => {
                  try {
                    const event = JSON.parse(line.replace(/^\uFEFF/, ""));
                    return event?.id && event?.timestamp && event?.message ? [event] : [];
                  } catch {
                    return [];
                  }
                })
            : [];
          json(res, 200, { ok: true, events });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/stop") {
          const result = await runHyperVAction("Stop");
          hyperVRemoteSessionId = "";
          hyperVRemoteSessionStartedAt = "";
          clearHyperVStatusCache();
          json(res, 200, result);
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/auto-recover") {
          if (!hyperVRecoveryTask) {
            hyperVRecoveryTask = (async () => {
              clearHyperVStatusCache();
              const actionResult = await runHyperVAction("AutoRecover", {}, 90000);
              if (actionResult.vm?.state === "Running") {
                hyperVRemoteSessionId = hyperVRemoteSessionId || randomBytes(12).toString("hex");
                hyperVRemoteSessionStartedAt = hyperVRemoteSessionStartedAt || new Date().toISOString();
              }
              clearHyperVStatusCache();
              return cacheHyperVStatus(await withHyperVDisplayStatus(actionResult));
            })();
          }

          const recoveryPromise = hyperVRecoveryTask;
          try {
            json(res, 200, await recoveryPromise);
          } finally {
            if (hyperVRecoveryTask === recoveryPromise) {
              hyperVRecoveryTask = null;
            }
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/request-new-disk") {
          const body = await readJsonBody(req);
          assertStoredIsoAccess(req, body.isoPath);
          const result = await runHyperVAction("RequestNewDisk", {
              ...body,
              storageOwnerId: storedIsoOwnerId(req),
              vmDirectory: resolve(workspaceDir, "vm-disks", "emustar-hyperv"),
            }, 120000);
          hyperVRemoteSessionId = "";
          hyperVRemoteSessionStartedAt = "";
          clearHyperVStatusCache();
          json(res, 200, result);
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/reset") {
          clearHyperVStatusCache();
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
          const frame = await runHyperVConsoleFrame(url.searchParams.get("contentOnly") === "1");
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

        if (req.method === "GET" && url.pathname === "/api/android-emulator/status") {
          const sessionId = androidSessionId(req);
          json(res, 200, androidEmulatorStatus(sessionId));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/android-emulator/start") {
          const sessionId = androidSessionId(req);
          const body = await readJsonBody(req);
          json(
            res,
            200,
            startAndroidEmulator(sessionId, body, { publicMobile: publicMobileRequest }),
          );
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/android-emulator/stop") {
          const sessionId = androidSessionId(req);
          json(res, 200, await stopAndroidEmulator(sessionId));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/android-emulator/frame") {
          const sessionId = androidSessionId(req);
          assertAndroidOwner(sessionId);
          const image = await androidEmulatorFrame(sessionId);
          const isPng = image.length >= 24 && image.subarray(1, 4).toString("ascii") === "PNG";
          const frameWidth = isPng ? image.readUInt32BE(16) : 0;
          const frameHeight = isPng ? image.readUInt32BE(20) : 0;
          res.statusCode = 200;
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Cache-Control", "no-store");
          if (frameWidth && frameHeight) {
            res.setHeader("X-NebulaVM-Frame-Width", String(frameWidth));
            res.setHeader("X-NebulaVM-Frame-Height", String(frameHeight));
          }
          res.end(image);
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/android-emulator/input") {
          const sessionId = androidSessionId(req);
          const body = await readJsonBody(req);
          json(res, 200, await sendAndroidEmulatorInput(sessionId, body));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/android-studio/frame") {
          const sessionId = androidSessionId(req);
          const frame = await runAndroidStudioFrame(sessionId);
          if (!frame.outputPath || !existsSync(frame.outputPath)) {
            throw new Error("Android Studio did not write a management frame.");
          }
          const image = readFileSync(frame.outputPath);
          res.statusCode = 200;
          res.setHeader("Content-Type", frame.mimeType || "image/jpeg");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-NebulaVM-Frame-Width", String(frame.width || ""));
          res.setHeader("X-NebulaVM-Frame-Height", String(frame.height || ""));
          res.setHeader("X-NebulaVM-Frame-Title", encodeURIComponent(frame.title || ""));
          res.setHeader("X-NebulaVM-AVD-Name", encodeURIComponent(frame.avdName || ""));
          res.end(image);
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/android-studio/input") {
          const sessionId = androidSessionId(req);
          const body = await readJsonBody(req);
          json(res, 200, await runAndroidStudioInput(sessionId, body));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/native-qemu/status") {
          json(res, 200, nativeStatus(url.searchParams.get("arch")));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/native-qemu/start") {
          const body = await readJsonBody(req);
          assertStoredIsoAccess(req, body.isoPath);
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
            replacedRuntime: result.replacedRuntime,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/native-qemu/reset-firmware") {
          const body = await readJsonBody(req);
          json(res, 200, { ok: true, ...resetNativeFirmware(body) });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/native-qemu/stop") {
          const stopped = await stopNativeVmIfRunning();
          json(res, 200, { ok: true, stopped });
          return;
        }

        json(res, 404, { error: "Unknown native QEMU endpoint." });
      } catch (error) {
        json(res, Number(error.statusCode) || 400, { error: error.message });
      }
    });
  },
});

export default defineConfig({
  plugins: [nativeQemuPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(workspaceDir, "index.html"),
        remote: resolve(workspaceDir, "remote.html"),
      },
    },
  },
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
