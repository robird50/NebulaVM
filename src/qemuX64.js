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
  if (mediaType === "fda") {
    return ["-drive", `if=floppy,format=raw,readonly=on,file=${imagePath}`, "-boot", "a"];
  }
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
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    desynchronized: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("NebulaHV requires WebGL 2 for its local display.");

  const compileShader = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`NebulaHV display shader failed: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl.VERTEX_SHADER, `#version 300 es
    in vec2 position;
    out vec2 textureCoordinate;
    void main() {
      textureCoordinate = vec2((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `));
  gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, `#version 300 es
    precision mediump float;
    uniform sampler2D framebufferTexture;
    in vec2 textureCoordinate;
    out vec4 outputColor;
    void main() {
      outputColor = texture(framebufferTexture, textureCoordinate).bgra;
    }
  `));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`NebulaHV display program failed: ${gl.getProgramInfoLog(program)}`);
  }
  const vertices = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.useProgram(program);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let uploadBuffer = null;
  let pendingFrame = null;
  let frameRequest = 0;
  let lastPresentedAt = 0;

  moduleConfig.nebulahvDisplayResize = (width, height) => {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    uploadBuffer = new Uint8Array(width * height * 4);
    gl.viewport(0, 0, width, height);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, uploadBuffer,
    );
  };
  moduleConfig.nebulahvDisplayUpdate = (
    pointer, width, height, stride, x, y, updateWidth, updateHeight,
  ) => {
    pendingFrame = { pointer, width, height, stride, x, y, updateWidth, updateHeight };
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      const now = performance.now();
      if (now - lastPresentedAt < 100) return;
      lastPresentedAt = now;
      const frame = pendingFrame;
      pendingFrame = null;
      if (!frame) return;
      if (!uploadBuffer || canvas.width !== frame.width || canvas.height !== frame.height) {
        moduleConfig.nebulahvDisplayResize(frame.width, frame.height);
      }
      const heap = moduleConfig.HEAPU8 || globalThis.HEAPU8;
      if (!heap) return;
      const rowBytes = frame.width * 4;
      for (let row = 0; row < frame.height; row += 1) {
        const sourceOffset = frame.pointer + row * frame.stride;
        uploadBuffer.set(
          heap.subarray(sourceOffset, sourceOffset + rowBytes),
          row * rowBytes,
        );
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height,
        gl.RGBA, gl.UNSIGNED_BYTE, uploadBuffer,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    });
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
    const runtimeVersionTag = encodeURIComponent(runtimeManifest.runtimeVersion);
    const versionedRuntimeAsset = (path) => {
      const separator = String(path).includes("?") ? "&" : "?";
      return `${path}${separator}v=${runtimeVersionTag}`;
    };

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
      const bootQuery = new URLSearchParams(globalThis.location?.search || "");
      const localDiagnostics = ["127.0.0.1", "localhost", "[::1]"].includes(globalThis.location?.hostname)
        && bootQuery.get("hvBootDiagnostics") === "1";
      qemuArguments = buildNebulaHVV2Arguments({
        manifest: runtimeManifest,
        memoryMb: Math.round(memorySize / 1024 / 1024),
        mediaPath: imagePath,
        mediaFormat: qemuMediaFormat(isoFile, mediaType),
        mediaType: mediaType === "hda" ? "hda" : mediaType === "fda" ? "floppy" : "cdrom",
        diagnostics: localDiagnostics,
        cpuModel: localDiagnostics ? bootQuery.get("hvCpu") || "max" : "max",
        machineProfile: localDiagnostics ? bootQuery.get("hvMachine") || (runtimeManifest.features.secureBoot ? "q35" : "q35-nosmm")
          : runtimeManifest.features.secureBoot ? "q35" : "q35-nosmm",
      });
      qemuArguments = qemuArguments.map((argument) => (
        typeof argument === "string" && argument.startsWith("/firmware/")
          ? `/${argument.split("/").pop()}`
          : argument
      ));
      if (localDiagnostics) log(`NebulaHV boot diagnostics enabled; CPU model ${bootQuery.get("hvCpu") || "max"}.`);
      qemuArguments.unshift("-L", "/");
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
    let runtimeLineCount = 0;
    let diagnosticContextLines = 0;
    let lastDiskTraceAt = 0;
    const moduleConfig = {
      arguments: qemuArguments,
      canvas,
      noInitialRun: false,
      locateFile: (path) => versionedRuntimeAsset(`${runtimeManifest.runtimeBase}${path}`),
      mainScriptUrlOrBlob: versionedRuntimeAsset(runtimeManifest.entrypoint),
      print: (line) => this.writeLine(line),
      printErr: (line) => {
        const text = String(line);
        if (text.includes("ide_atapi_cmd_read")) {
          const now = Date.now();
          if (now - lastDiskTraceAt < 1000) return;
          lastDiskTraceAt = now;
        }
        const important = /error|exception|fault|abort|panic|CPU Reset|ide_atapi_cmd_read/i.test(text);
        if (important && !text.includes("ide_atapi_cmd_read")) diagnosticContextLines = 32;
        runtimeLineCount++;
        if (runtimeLineCount > 600 && !important && diagnosticContextLines === 0) return;
        if (diagnosticContextLines > 0) diagnosticContextLines--;
        this.writeLine(line);
        log(`NebulaHV runtime: ${line}`);
        if (String(line).includes("worker sent an error!")) onStopped?.();
      },
      preRun: [
        () => {
          if (v2Ready) {
            const firmwareFiles = [
              ...Object.values(runtimeManifest.firmware || {}).filter(Boolean).map((path) => ({
                source: path,
                destination: `/${path.split("/").pop()}`,
              })),
              ...["bios-256k.bin", "kvmvapic.bin", "vgabios-stdvga.bin"].map((name) => ({
                source: versionedRuntimeAsset(`${runtimeManifest.runtimeBase}${name}`),
                destination: `/${name}`,
              })),
            ];
            if (firmwareFiles.length) {
              const dependency = "nebulahv-uefi-firmware";
              moduleConfig.addRunDependency(dependency);
              Promise.all(firmwareFiles.map(async ({ source, destination }) => {
                const response = await fetch(source, { cache: "force-cache" });
                if (!response.ok) throw new Error(`Could not load UEFI firmware: ${source}`);
                moduleConfig.FS.writeFile(destination, new Uint8Array(await response.arrayBuffer()));
              })).then(
                () => moduleConfig.removeRunDependency(dependency),
                (error) => {
                  moduleConfig.printErr(`UEFI firmware load failed: ${error?.message || error}`);
                  moduleConfig.removeRunDependency(dependency);
                },
              );
            }
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
    const useDedicatedWorker = v2Ready
      && typeof Worker === "function"
      && typeof OffscreenCanvas === "function";
    if (v2Ready && !useDedicatedWorker) createNebulaHVDisplayBridge(moduleConfig, canvas);

    globalThis.Module = moduleConfig;

    if (await assetExists("/qemu/load.js")) {
      await loadScript("/qemu/load.js");
    }
    if (await assetExists("/qemu/load-rom.js")) {
      await loadScript("/qemu/load-rom.js");
    }

    this.writeLine("Starting NebulaHV x86-64 locally...");

    const qemuEntrypoint = versionedRuntimeAsset(runtimeManifest.entrypoint);
    if (v2Ready) {
      const runtimeUrl = new URL(qemuEntrypoint, window.location.href).href;
      moduleConfig.mainScriptUrlOrBlob = runtimeUrl;
      if (useDedicatedWorker) {
        const worker = new Worker(
          new URL("./nebulahvRuntime.worker.js", import.meta.url),
          { type: "module", name: "NebulaHV runtime" },
        );
        this.runtimeWorker = worker;
        const bitmapContext = canvas.getContext("bitmaprenderer");
        const fallbackContext = bitmapContext ? null : canvas.getContext("2d", { alpha: false });
        const started = new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => {
            if (data.type === "frame") {
              canvas.width = data.width;
              canvas.height = data.height;
              if (bitmapContext) bitmapContext.transferFromImageBitmap(data.bitmap);
              else {
                fallbackContext.drawImage(data.bitmap, 0, 0);
                data.bitmap.close();
              }
            } else if (data.type === "print") {
              moduleConfig.print(data.line);
            } else if (data.type === "printErr") {
              moduleConfig.printErr(data.line);
            } else if (data.type === "started") {
              resolve();
            } else if (data.type === "error") {
              reject(new Error(data.message));
            } else if (data.type === "abort") {
              moduleConfig.onAbort(data.reason);
            } else if (data.type === "exit") {
              moduleConfig.onExit(data.code);
            }
          };
          worker.onerror = (event) => reject(new Error(event.message || "NebulaHV worker failed."));
        });
        worker.postMessage({
          type: "start",
          qemuArguments,
          runtimeManifest,
          runtimeUrl,
          baseUrl: window.location.href,
        });
        await started;
        this.instance = {};
        for (const name of [
          "nebulahv_pointer_move",
          "nebulahv_pointer_button",
          "nebulahv_pointer_wheel",
          "nebulahv_key_number",
        ]) {
          this.instance[`_${name}`] = (...args) => worker.postMessage({
            type: "input", name, args,
          });
        }
      } else {
        const imported = await import(/* @vite-ignore */ runtimeUrl);
        if (typeof imported.default !== "function") {
          throw new Error("NebulaHV graphical runtime has no module entrypoint.");
        }
        this.instance = await imported.default(moduleConfig);
      }
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
    this.runtimeWorker?.terminate();
    this.runtimeWorker = null;
    this.instance?.PThread?.terminateAllThreads?.();
    this.instance = null;
  }

  async destroy() {
    await this.stop();
  }

  writeLine(line) {
    if (this.disposed || line == null) return;
    const { terminal } = this.options;
    terminal.textContent = `${terminal.textContent}${line}\n`.slice(-65536);
    terminal.scrollTop = terminal.scrollHeight;
  }
}

// Keep the old export so saved sessions and older imports remain compatible.
export const QemuX64Emulator = NebulaHVEmulator;
