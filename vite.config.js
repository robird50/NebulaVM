import { defineConfig } from "vite";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

let nativeVm = null;

const normalizeArch = (arch) => (arch === "aarch64" ? "aarch64" : "x86_64");

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
  };
};

const startNativeVm = async (body) => {
  if (nativeVm) {
    throw new Error(`A native QEMU VM is already running with pid ${nativeVm.pid}.`);
  }

  const arch = normalizeArch(body.arch);
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
  const vmDir = resolve(workspaceDir, "vm-disks");
  const diskPath = resolve(vmDir, arch === "aarch64" ? "nebulavm-native-arm64.qcow2" : "nebulavm-native.qcow2");
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
  const args =
    arch === "aarch64"
      ? [
          "-machine",
          "virt",
          "-cpu",
          "max",
          "-smp",
          "2",
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
          "usb-storage,drive=install,bootindex=1",
          "-netdev",
          "user,id=net0",
          "-device",
          "virtio-net-pci,netdev=net0",
        ]
      : [
          "-machine",
          "q35",
          "-cpu",
          "qemu64",
          "-smp",
          "2",
          "-m",
          `${memoryMb}M`,
          "-boot",
          "d",
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

  if (ovmf) {
    args.push("-bios", ovmf);
  }

  if (body.createDisk !== false && existsSync(diskPath)) {
    if (arch === "aarch64") {
      args.push("-drive", `if=none,id=systemdisk,file=${diskPath},format=qcow2`);
      args.push("-device", "nvme,drive=systemdisk,serial=nebulavm-arm64,bootindex=2");
    } else {
      args.push("-drive", `file=${diskPath},format=qcow2,if=ide`);
    }
  }

  const child = spawn(qemu, args, {
    cwd: workspaceDir,
    detached: false,
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  nativeVm = child;
  let recentOutput = "";
  const capture = (chunk) => {
    recentOutput = `${recentOutput}${chunk}`.slice(-4000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("exit", () => {
    nativeVm = null;
  });
  child.on("error", () => {
    nativeVm = null;
  });

  return {
    pid: child.pid,
    arch,
    qemu,
    args,
    diskPath: existsSync(diskPath) ? diskPath : null,
    ovmf,
    get recentOutput() {
      return recentOutput;
    },
  };
};

const nativeQemuPlugin = () => ({
  name: "nebulavm-native-qemu",
  configureServer(server) {
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
            qemu: result.qemu,
            diskPath: result.diskPath,
            ovmf: result.ovmf,
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/native-qemu/stop") {
          if (nativeVm) {
            nativeVm.kill();
            nativeVm = null;
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
