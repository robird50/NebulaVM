import {
  describeNebulaHVMissingCapabilities,
  inspectNebulaHVCapabilities,
  NEBULAHV_MAX_GUEST_MEMORY_BYTES,
  nebulahvMediaBudget,
} from "./nebulahvCapabilities.js";
import {
  buildNebulaHVV2Arguments,
  describeNebulaHVV2Status,
  hasNebulaHVGraphicalRuntime,
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

const QNUM_BY_CODE = {
  Escape: 0x01,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14,
  KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22,
  KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27,
  Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35,
  ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
  CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e,
  F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, F11: 0x57, F12: 0x58,
  NumpadEnter: 0x9c, ControlRight: 0x9d, AltRight: 0xb8,
  Home: 0xc7, ArrowUp: 0xc8, PageUp: 0xc9, ArrowLeft: 0xcb,
  ArrowRight: 0xcd, End: 0xcf, ArrowDown: 0xd0, PageDown: 0xd1,
  Insert: 0xd2, Delete: 0xd3, MetaLeft: 0xdb, MetaRight: 0xdc,
  ContextMenu: 0xdd,
};

const createNebulaHVDisplayBridge = (moduleConfig, canvas) => {
  let context = null;
  let imageData = null;

  moduleConfig.nebulahvDisplayResize = (width, height) => {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    imageData = context.createImageData(width, height);
  };
  moduleConfig.nebulahvDisplayUpdate = (
    pointer, width, height, stride, x, y, updateWidth, updateHeight,
  ) => {
    if (!context || !imageData || imageData.width !== width || imageData.height !== height) {
      moduleConfig.nebulahvDisplayResize(width, height);
    }
    const heap = moduleConfig.HEAPU8 || globalThis.HEAPU8;
    if (!heap) return;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(width, left + Math.max(0, updateWidth));
    const bottom = Math.min(height, top + Math.max(0, updateHeight));
    const destination = imageData.data;
    for (let row = top; row < bottom; row += 1) {
      let sourceOffset = pointer + row * stride + left * 4;
      let destinationOffset = (row * width + left) * 4;
      for (let column = left; column < right; column += 1) {
        destination[destinationOffset] = heap[sourceOffset + 2];
        destination[destinationOffset + 1] = heap[sourceOffset + 1];
        destination[destinationOffset + 2] = heap[sourceOffset];
        destination[destinationOffset + 3] = 255;
        sourceOffset += 4;
        destinationOffset += 4;
      }
    }
    context.putImageData(imageData, 0, 0, left, top, right - left, bottom - top);
  };
};

const installNebulaHVInput = (runtime, canvas) => {
  const call = (name, ...args) => {
    const direct = runtime?.[`_${name}`];
    if (typeof direct === "function") direct(...args);
  };
  const pointerMove = (event) => {
    const bounds = canvas.getBoundingClientRect();
    call(
      "nebulahv_pointer_move",
      Math.round((event.clientX - bounds.left) * canvas.width / Math.max(bounds.width, 1)),
      Math.round((event.clientY - bounds.top) * canvas.height / Math.max(bounds.height, 1)),
      canvas.width,
      canvas.height,
    );
  };
  const pointerButton = (event, down) => {
    event.preventDefault();
    canvas.focus();
    call("nebulahv_pointer_button", event.button, down ? 1 : 0);
  };
  const key = (event, down) => {
    const number = QNUM_BY_CODE[event.code];
    if (number == null) return;
    event.preventDefault();
    call("nebulahv_key_number", number, down ? 1 : 0);
  };
  const wheel = (event) => {
    event.preventDefault();
    call("nebulahv_pointer_wheel", Math.sign(event.deltaY));
  };
  const handlers = {
    pointermove: pointerMove,
    pointerdown: (event) => pointerButton(event, true),
    pointerup: (event) => pointerButton(event, false),
    keydown: (event) => key(event, true),
    keyup: (event) => key(event, false),
    wheel,
    contextmenu: (event) => event.preventDefault(),
  };
  canvas.tabIndex = 0;
  for (const [name, handler] of Object.entries(handlers)) {
    canvas.addEventListener(name, handler, name === "wheel" ? { passive: false } : undefined);
  }
  return () => {
    for (const [name, handler] of Object.entries(handlers)) {
      canvas.removeEventListener(name, handler);
    }
  };
};

export class NebulaHVEmulator {
  constructor(options) {
    this.options = options;
    this.disposed = false;
    this.instance = null;
    this.removeInput = null;
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
    const v2Ready = hasNebulaHVGraphicalRuntime(runtimeManifest);
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
      qemuArguments.unshift("-L", "/firmware");
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
      noInitialRun: v2Ready,
      locateFile: (path) => `${runtimeManifest.runtimeBase}${path}`,
      mainScriptUrlOrBlob: runtimeManifest.entrypoint,
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
    if (v2Ready) createNebulaHVDisplayBridge(moduleConfig, canvas);

    globalThis.Module = moduleConfig;

    if (await assetExists("/qemu/load.js")) {
      await loadScript("/qemu/load.js");
    }
    if (await assetExists("/qemu/load-rom.js")) {
      await loadScript("/qemu/load-rom.js");
    }

    this.writeLine("Starting NebulaHV x86-64 locally...");

    const qemuEntrypoint = runtimeManifest.entrypoint;
    if (v2Ready) {
      const runtimeUrl = new URL(qemuEntrypoint, window.location.href).href;
      moduleConfig.mainScriptUrlOrBlob = runtimeUrl;
      const imported = await import(/* @vite-ignore */ runtimeUrl);
      if (typeof imported.default !== "function") {
        throw new Error("NebulaHV graphical runtime has no module entrypoint.");
      }
      this.instance = await imported.default(moduleConfig);
      if (typeof this.instance.callMain !== "function") {
        throw new Error("NebulaHV graphical runtime cannot start its VM worker.");
      }
      try {
        this.instance.FS.mkdir("/firmware");
      } catch {}
      for (const firmwareName of ["bios-256k.bin", "kvmvapic.bin", "vgabios-stdvga.bin"]) {
        const response = await fetch(`${runtimeManifest.runtimeBase}${firmwareName}`);
        if (!response.ok) {
          throw new Error(`NebulaHV firmware failed to load: ${firmwareName}.`);
        }
        this.instance.FS.writeFile(`/firmware/${firmwareName}`, new Uint8Array(await response.arrayBuffer()));
      }
      setTimeout(() => {
        if (this.disposed) return;
        try {
          this.instance.callMain(qemuArguments);
        } catch (error) {
          this.writeLine(`NebulaHV runtime stopped: ${error.message || error}`);
          onStopped?.();
        }
      }, 0);
    } else {
      try {
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
    }

    if (v2Ready) this.removeInput = installNebulaHVInput(this.instance || moduleConfig, canvas);

    onStarted?.();
  }

  async stop() {
    this.disposed = true;
    this.removeInput?.();
    this.removeInput = null;
    if (this.instance?.quit) {
      this.instance.quit(0);
    }
    this.writeLine("NebulaHV stopped.");
  }

  async destroy() {
    this.disposed = true;
    this.removeInput?.();
    this.removeInput = null;
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
