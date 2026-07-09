import { defineConfig } from "vite";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import { cpus } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const workspaceDir = dirname(fileURLToPath(import.meta.url));

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
  const runtimeName = body.runtime === "QEMU" ? "QEMU" : "EMUSTAR";
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

    server.httpServer?.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== nativeVncPath) return;

      nativeVncWss.handleUpgrade(req, socket, head, (ws) => {
        nativeVncWss.emit("connection", ws, req);
      });
    });

    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url || "/", "http://localhost");
      if (!url.pathname.startsWith("/api/native-qemu")) {
        next();
        return;
      }

      setNativeQemuCors(req, res);

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      try {
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
    headers: isolationHeaders,
  },
  preview: {
    cors: false,
    headers: isolationHeaders,
  },
});
