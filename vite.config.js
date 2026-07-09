import { defineConfig } from "vite";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { cpus, networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const hostTokenPath = resolve(workspaceDir, ".nebulavm-host-token");
const publicUrlPath = resolve(workspaceDir, ".nebulavm-public-url");
const guestCredentialsPath = resolve(workspaceDir, ".nebulavm-guest-credentials.json");

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
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
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

const driveImportDirectory = resolve(workspaceDir, "vm-disks", "imports");
let driveImportJob = null;

const sanitizeFilename = (value) => {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return cleaned || "google-drive.iso";
};

const parseContentDispositionFilename = (header) => {
  const value = String(header || "");
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].replace(/^"|"$/g, ""));
    } catch {
      return utf8Match[1].replace(/^"|"$/g, "");
    }
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] || "";
};

const parseGoogleDriveFileId = (value) => {
  const input = String(value || "").trim();
  if (!input) throw new Error("Paste a Google Drive file share link first.");
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Paste a full Google Drive file link, not a Chromebook path.");
  }

  const host = url.hostname.toLowerCase();
  if (!/(^|\.)drive\.google\.com$/.test(host) && !/(^|\.)googleusercontent\.com$/.test(host)) {
    throw new Error("Only Google Drive file links are supported here.");
  }

  const pathMatch = url.pathname.match(/\/file\/d\/([^/]+)/i);
  const id = pathMatch?.[1] || url.searchParams.get("id") || "";
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(id)) {
    throw new Error("That Google Drive link does not include a downloadable file ID.");
  }
  return id;
};

const downloadResponseFromGoogleDrive = async (fileId) => {
  const directUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}&confirm=t`;
  let response = await fetch(directUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Google Drive returned HTTP ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) {
    return response;
  }

  const html = await response.text();
  const hrefMatch = html.match(/href="([^"]*(?:uc|download)[^"]*confirm=[^"]+)"/i);
  if (hrefMatch) {
    const nextUrl = new URL(hrefMatch[1].replaceAll("&amp;", "&"), response.url).toString();
    response = await fetch(nextUrl, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Google Drive returned HTTP ${response.status}.`);
    }
    if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/html")) {
      return response;
    }
  }

  if (/access denied|need access|request access|sign in/i.test(html)) {
    throw new Error("Google Drive blocked the file. Set sharing to 'Anyone with the link can view'.");
  }
  if (/quota|too many users|download quota/i.test(html)) {
    throw new Error("Google Drive says this file hit a download limit.");
  }
  throw new Error("Google Drive did not return the ISO file. Make sure the link is shared publicly.");
};

const driveJobSnapshot = (job = driveImportJob) => {
  if (!job) return { ok: true, job: null };
  return {
    ok: true,
    job: {
      id: job.id,
      state: job.state,
      message: job.message,
      bytesReceived: job.bytesReceived,
      totalBytes: job.totalBytes,
      isoPath: job.isoPath,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    },
  };
};

const startGoogleDriveIsoImport = (driveUrl) => {
  if (driveImportJob?.state === "running") {
    throw new Error("A Google Drive ISO import is already running.");
  }

  const fileId = parseGoogleDriveFileId(driveUrl);
  const job = {
    id: randomBytes(8).toString("hex"),
    state: "running",
    message: "Connecting to Google Drive...",
    bytesReceived: 0,
    totalBytes: 0,
    isoPath: "",
    error: "",
    startedAt: new Date().toISOString(),
    completedAt: "",
  };
  driveImportJob = job;

  (async () => {
    mkdirSync(driveImportDirectory, { recursive: true });
    const response = await downloadResponseFromGoogleDrive(fileId);
    job.message = "Downloading ISO to the NebulaVM host...";
    job.totalBytes = Number(response.headers.get("content-length") || 0);

    const headerName = parseContentDispositionFilename(response.headers.get("content-disposition"));
    const baseName = sanitizeFilename(headerName || `google-drive-${fileId}.iso`);
    const isoName = baseName.toLowerCase().endsWith(".iso") ? baseName : `${baseName}.iso`;
    const finalPath = resolve(driveImportDirectory, `${Date.now()}-${isoName}`);
    const tempPath = `${finalPath}.part`;

    const source = Readable.from(async function* progressChunks() {
      for await (const chunk of Readable.fromWeb(response.body)) {
        job.bytesReceived += chunk.length;
        yield chunk;
      }
    }());
    await pipeline(source, createWriteStream(tempPath));
    renameSync(tempPath, finalPath);

    job.state = "complete";
    job.message = "Google Drive ISO imported.";
    job.isoPath = finalPath;
    job.completedAt = new Date().toISOString();
  })().catch((error) => {
    job.state = "error";
    job.message = "Google Drive ISO import failed.";
    job.error = error.message || String(error);
    job.completedAt = new Date().toISOString();
  });

  return job;
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

const runHyperVAction = (action, config = {}) =>
  new Promise((resolveAction, rejectAction) => {
    const configBase64 = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectAction);
    child.on("exit", (code) => {
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
      if (!isNativeQemuApi && !isHyperVApi && !isHostApi) {
        next();
        return;
      }

      setNativeQemuCors(req, res);

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
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

        if (url.pathname === "/api/emustar-host/drive-import") {
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            json(res, 200, driveJobSnapshot(startGoogleDriveIsoImport(body.driveUrl || body.url)));
            return;
          }
          if (req.method === "GET") {
            json(res, 200, driveJobSnapshot());
            return;
          }
        }

        if (req.method === "GET" && url.pathname === "/api/emustar-hyperv/status") {
          json(res, 200, await withHyperVDisplayStatus(await runHyperVAction("Status")));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/emustar-hyperv/start") {
          const body = await readJsonBody(req);
          const result = await runHyperVAction("Start", {
              ...body,
              vmDirectory: resolve(workspaceDir, "vm-disks", "emustar-hyperv"),
            });
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
