const REQUIRED_ASSETS = [
  "/qemu/out.js",
  "/qemu/qemu-system-x86_64.wasm",
  "/qemu/qemu-system-x86_64.worker.js",
];

const OPTIONAL_ASSETS = [
  "/qemu/load.js",
  "/qemu/qemu-system-x86_64.data",
  "/qemu/load-rom.js",
  "/qemu/load-rom.data",
];

export const MAX_BROWSER_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;

const loadScript = (src) =>
  new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.append(script);
  });

const assetExists = async (path) => {
  try {
    const response = await fetch(path, { method: "HEAD", cache: "no-store" });
    const contentType = response.headers.get("content-type") || "";
    return response.ok && !contentType.includes("text/html");
  } catch {
    return false;
  }
};

export const findMissingQemuAssets = async () => {
  const checks = await Promise.all(REQUIRED_ASSETS.map(async (path) => [path, await assetExists(path)]));
  return checks.filter(([, exists]) => !exists).map(([path]) => path);
};

let workerFsSupportPromise;

export const qemuWasmCanMountBrowserFiles = async () => {
  workerFsSupportPromise ||= fetch("/qemu/out.js", { cache: "no-store" })
    .then((response) => (response.ok ? response.text() : ""))
    .then((source) => source.includes("WORKERFS"))
    .catch(() => false);

  return workerFsSupportPromise;
};

const qemuMemoryArg = (bytes) => `${Math.max(128, Math.round(bytes / 1024 / 1024))}M`;

export const formatMegabytes = (bytes) =>
  `${(bytes / 1024 / 1024).toFixed(bytes >= 1024 * 1024 * 1024 ? 1 : 0)} MB`;

const safeMediaName = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "_") || "boot-media.iso";

const qemuBiosArgs = async () => {
  if (await assetExists("/qemu/load-rom.js")) {
    return ["-L", "/pack-rom/"];
  }

  return [];
};

const qemuDriveArgs = (mediaType, imagePath) => {
  if (mediaType === "hda") {
    return ["-drive", `if=virtio,format=raw,file=${imagePath}`, "-boot", "c"];
  }

  return ["-cdrom", imagePath, "-boot", "d"];
};

export class QemuX64Emulator {
  constructor(options) {
    this.options = options;
    this.disposed = false;
    this.instance = null;
  }

  async start() {
    if (!window.crossOriginIsolated) {
      throw new Error(
        "Nebula x64 needs cross-origin isolation. Restart the dev server so Vite can send COOP/COEP headers.",
      );
    }

    const missing = await findMissingQemuAssets();
    if (missing.length) {
      throw new Error(
        `Missing QEMU Wasm artifacts: ${missing.join(", ")}. Build qemu-system-x86_64 and place the files in public/qemu/.`,
      );
    }

    const {
      isoFile,
      mediaType,
      memorySize,
      cpuModel = "qemu64",
      terminal,
      log,
      onStarted,
      onStopped,
    } = this.options;

    terminal.textContent = "";
    terminal.hidden = false;
    this.writeLine("Nebula x64 preparing uploaded media...");
    const canMountBrowserFiles = await qemuWasmCanMountBrowserFiles();
    const shouldMountBrowserFile = isoFile.size > MAX_BROWSER_MEDIA_BYTES && canMountBrowserFiles;

    if (isoFile.size > MAX_BROWSER_MEDIA_BYTES && !canMountBrowserFiles) {
      throw new Error(
        `${isoFile.name} is ${formatMegabytes(isoFile.size)}. This QEMU Wasm build can only copy boot media up to ${formatMegabytes(MAX_BROWSER_MEDIA_BYTES)} into browser memory. A no-install large-ISO backend needs a QEMU Wasm build compiled with WORKERFS so local files can be mounted instead of copied.`,
      );
    }

    const imageName = mediaType === "hda" ? "nebula-disk.img" : "nebula.iso";
    const imagePath = shouldMountBrowserFile ? `/media/${safeMediaName(isoFile.name)}` : `/${imageName}`;
    const imageBytes = shouldMountBrowserFile ? null : new Uint8Array(await isoFile.arrayBuffer());
    const biosArgs = await qemuBiosArgs();
    const moduleConfig = {
      arguments: [
        "-nographic",
        "-machine",
        "q35",
        "-cpu",
        cpuModel,
        "-m",
        qemuMemoryArg(memorySize),
        "-accel",
        "tcg,tb-size=500",
        "-serial",
        "stdio",
        "-monitor",
        "none",
        ...biosArgs,
        ...qemuDriveArgs(mediaType, imagePath),
      ],
      locateFile: (path) => `/qemu/${path}`,
      mainScriptUrlOrBlob: "/qemu/out.js",
      print: (line) => this.writeLine(line),
      printErr: (line) => this.writeLine(line),
      preRun: [
        () => {
          if (shouldMountBrowserFile) {
            const workerFs = moduleConfig.FS.filesystems.WORKERFS || moduleConfig.WORKERFS || globalThis.WORKERFS;
            if (!workerFs) {
              throw new Error("This QEMU Wasm build did not expose WORKERFS at runtime.");
            }
            try {
              moduleConfig.FS.mkdir("/media");
            } catch {}
            moduleConfig.FS.mount(workerFs, { files: [isoFile] }, "/media");
          } else {
            moduleConfig.FS.writeFile(imagePath, imageBytes);
          }
        },
      ],
      onAbort: (reason) => {
        log(`QEMU aborted: ${reason}`);
        onStopped?.();
      },
      onExit: (code) => {
        log(`QEMU exited with code ${code}.`);
        onStopped?.();
      },
    };

    globalThis.Module = moduleConfig;

    if (await assetExists("/qemu/load.js")) {
      await loadScript("/qemu/load.js");
    }
    if (await assetExists("/qemu/load-rom.js")) {
      await loadScript("/qemu/load-rom.js");
    }

    this.writeLine("Starting QEMU x86_64...");

    try {
      const qemuEntrypoint = "/qemu/out.js";
      const imported = await import(/* @vite-ignore */ qemuEntrypoint);
      if (typeof imported.default === "function") {
        this.instance = await imported.default(moduleConfig);
      }
    } catch (error) {
      if (!String(error?.message || error).includes("Unexpected token")) {
        log(`ES module load failed, trying script mode: ${error.message}`);
      }
      await loadScript("/qemu/out.js");
    }

    onStarted?.();
  }

  async stop() {
    this.disposed = true;
    if (this.instance?.quit) {
      this.instance.quit(0);
    }
    this.writeLine("Nebula x64 stopped.");
  }

  async destroy() {
    this.disposed = true;
  }

  writeLine(line) {
    if (this.disposed || line == null) return;
    const { terminal } = this.options;
    terminal.textContent += `${line}\n`;
    terminal.scrollTop = terminal.scrollHeight;
  }
}
