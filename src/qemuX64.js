import {
  describeNebulaHVMissingCapabilities,
  inspectNebulaHVCapabilities,
  NEBULAHV_MAX_GUEST_MEMORY_BYTES,
  nebulahvMediaBudget,
} from "./nebulahvCapabilities.js";
import {
  buildNebulaHVV2Arguments,
  describeNebulaHVV2Status,
  loadNebulaHVRuntimeManifest,
  missingNebulaHVV2Features,
} from "./nebulahvV2.js";
import { stageNebulaHVDiskInOpfs } from "./nebulahvOpfs.js";

const REQUIRED_ASSETS = [
  "/qemu/nebulahv-runtime.json",
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

export const MAX_BROWSER_MEDIA_BYTES = 1024 * 1024 * 1024;

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

export const maxNebulaHVMediaBytes = (memorySize, canMountBrowserFiles = false) =>
  canMountBrowserFiles
    ? Number.MAX_SAFE_INTEGER
    : Math.min(MAX_BROWSER_MEDIA_BYTES, nebulahvMediaBudget(memorySize));

const safeMediaName = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "_") || "boot-media.iso";

const qemuMediaFormat = (file, mediaType) => {
  if (mediaType !== "hda") return "raw";
  if (/\.vhdx$/i.test(file.name)) return "vhdx";
  if (/\.qcow2?$/i.test(file.name)) return "qcow2";
  return "raw";
};

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

export class NebulaHVEmulator {
  constructor(options) {
    this.options = options;
    this.disposed = false;
    this.instance = null;
  }

  async start() {
    const capabilities = inspectNebulaHVCapabilities(window);
    if (!capabilities.ready) {
      const missing = describeNebulaHVMissingCapabilities(capabilities);
      throw new Error(
        `NebulaHV cannot start in this browser. Missing: ${missing.join(", ")}.`,
      );
    }

    const missing = await findMissingQemuAssets();
    if (missing.length) {
      throw new Error(
        `NebulaHV runtime is incomplete. Missing: ${missing.join(", ")}.`,
      );
    }
    const runtimeManifest = await loadNebulaHVRuntimeManifest();

    const {
      isoFile,
      mediaType,
      memorySize,
      cpuModel = "qemu64",
      terminal,
      canvas,
      log,
      onStarted,
      onStopped,
      onDisplayMode,
    } = this.options;

    terminal.textContent = "";
    terminal.hidden = false;
    const v2Ready = missingNebulaHVV2Features(runtimeManifest).length === 0;
    if (!v2Ready && memorySize > NEBULAHV_MAX_GUEST_MEMORY_BYTES) {
      throw new Error("NebulaHV V1 supports up to 2048 MB of guest RAM with the bundled runtime.");
    }

    this.writeLine(`NebulaHV ${v2Ready ? "V2" : "V1"} preparing local boot media...`);
    this.writeLine("Privacy: the selected file stays on this device.");
    this.writeLine(
      `Runtime ${runtimeManifest.runtimeVersion} (${runtimeManifest.profile}). ${describeNebulaHVV2Status(runtimeManifest)}`,
    );
    this.writeLine(
      `Runtime: x86-64 TCG/Wasm, ${capabilities.optional.opfs ? "OPFS available" : "OPFS unavailable"}, ${capabilities.optional.webGpu ? "WebGPU available" : "WebGPU unavailable"}.`,
    );
    const canMountBrowserFiles = await qemuWasmCanMountBrowserFiles();
    const mediaLimit = maxNebulaHVMediaBytes(memorySize, canMountBrowserFiles);
    const shouldMountBrowserFile = canMountBrowserFiles;

    if (!v2Ready && isoFile.size > mediaLimit && !canMountBrowserFiles) {
      throw new Error(
        `${isoFile.name} is ${formatMegabytes(isoFile.size)}, but only ${formatMegabytes(mediaLimit)} remains in the NebulaHV V1 Wasm heap after reserving ${formatMegabytes(memorySize)} for guest RAM. Choose less RAM or smaller boot media.`,
      );
    }

    let imagePath;
    let imageBytes = null;
    let qemuArguments;
    if (v2Ready) {
      const missingV2Assets = (
        await Promise.all(runtimeManifest.artifacts.map(async (path) => [path, await assetExists(path)]))
      )
        .filter(([, exists]) => !exists)
        .map(([path]) => path);
      if (missingV2Assets.length) {
        throw new Error(`NebulaHV V2 artifacts are missing: ${missingV2Assets.join(", ")}.`);
      }
      this.writeLine("Staging the disk in private browser storage...");
      let lastProgressBucket = -1;
      const staged = await stageNebulaHVDiskInOpfs(isoFile, {
        onProgress: ({ written, total }) => {
          const percent = total ? Math.floor((written / total) * 100) : 0;
          const bucket = Math.min(100, Math.floor(percent / 10) * 10);
          if (bucket >= 10 && bucket !== lastProgressBucket) {
            lastProgressBucket = bucket;
            log(`NebulaHV OPFS staging: ${bucket}%.`);
          }
        },
      });
      imagePath = staged.qemuPath;
      qemuArguments = buildNebulaHVV2Arguments({
        manifest: runtimeManifest,
        memoryMb: Math.round(memorySize / 1024 / 1024),
        mediaPath: imagePath,
        mediaFormat: qemuMediaFormat(isoFile, mediaType),
        mediaType: mediaType === "hda" ? "hda" : "cdrom",
      });
      onDisplayMode?.("graphics");
    } else {
      const imageName = mediaType === "hda" ? "nebula-disk.img" : "nebula.iso";
      imagePath = shouldMountBrowserFile ? `/media/${safeMediaName(isoFile.name)}` : `/${imageName}`;
      imageBytes = shouldMountBrowserFile ? null : new Uint8Array(await isoFile.arrayBuffer());
      const biosArgs = await qemuBiosArgs();
      qemuArguments = [
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
      ];
      onDisplayMode?.("terminal");
    }
    const moduleConfig = {
      arguments: qemuArguments,
      canvas,
      locateFile: (path) => `/qemu/${path}`,
      mainScriptUrlOrBlob: "/qemu/out.js",
      print: (line) => this.writeLine(line),
      printErr: (line) => this.writeLine(line),
      preRun: [
        () => {
          if (v2Ready) {
            return;
          }
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

    this.writeLine("Starting NebulaHV x86-64 locally...");

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
    this.writeLine("NebulaHV stopped.");
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

// Keep the old export so saved sessions and older imports remain compatible.
export const QemuX64Emulator = NebulaHVEmulator;
