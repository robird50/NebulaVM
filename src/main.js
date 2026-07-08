import { V86 } from "v86";
import {
  QemuX64Emulator,
  MAX_BROWSER_MEDIA_BYTES,
  formatMegabytes,
  qemuWasmCanMountBrowserFiles,
} from "./qemuX64.js";
import "./styles.css";

const app = document.querySelector("#app");

const isMobileDevice = () => {
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === "boolean") {
    return navigator.userAgentData.mobile;
  }

  const userAgent = navigator.userAgent || navigator.vendor || window.opera || "";
  const mobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(userAgent);
  const coarseSmallScreen =
    navigator.maxTouchPoints > 1 &&
    window.matchMedia("(pointer: coarse)").matches &&
    window.matchMedia("(max-width: 900px)").matches;

  return mobileUserAgent || coarseSmallScreen;
};

if (isMobileDevice()) {
  document.documentElement.classList.add("is-mobile-device");
}

const state = {
  isoFile: null,
  emulator: null,
  running: false,
  startedAt: null,
  statsTimer: null,
  browserQemuCanMountFiles: false,
};

app.innerHTML = `
  <main class="mobile-unsupported" aria-labelledby="mobileUnsupportedTitle">
    <img class="mobile-unsupported-image" src="/assets/mobile-not-supported.png" alt="NebulaVM mobile devices not supported" />
    <section class="mobile-unsupported-copy">
      <h1 id="mobileUnsupportedTitle">Mobile Not Supported</h1>
      <p>NebulaVM is currently available only on desktop and laptop browsers. Mobile support is still in development.</p>
      <p>Please visit this page from a computer to launch a virtual machine. Thank you for your patience!</p>
    </section>
  </main>

  <main class="shell">
    <section class="hero">
      <div class="brand-lockup">
        <img class="brand-logo" src="/assets/nebulavm-logo.png" alt="NebulaVM logo" />
        <div class="hero-copy">
          <p class="eyebrow">Browser x86 lab</p>
          <h1>NebulaVM</h1>
          <p class="lede">Drop an ISO, tune the machine, and boot it directly in your browser.</p>
        </div>
      </div>
    </section>

    <section class="about-strip" aria-label="About NebulaVM">
      <p>
        NebulaVM is a free and open-source virtual machine platform that lets you run operating systems directly in your web browser&mdash;no downloads or installation required. Powered by modern backend technology, NebulaVM is designed to make virtualization simple, accessible, and available to everyone. Our commitment is permanent: <strong>NebulaVM will always be free</strong>, with no subscriptions, premium plans, hidden fees, or paywalls. It runs on most modern desktop and laptop browsers, with mobile support planned for a future release.
      </p>
      <div class="status-pill" id="powerState">
        <span class="status-dot"></span>
        <span>Powered off</span>
      </div>
    </section>

    <section class="workspace" aria-label="Virtual machine workspace">
      <aside class="panel controls" aria-label="Virtual machine controls">
        <div class="panel-header">
          <div>
            <p class="kicker">Media</p>
            <h2>Boot source</h2>
          </div>
        </div>

        <label class="drop-zone" id="dropZone" for="isoInput">
          <input id="isoInput" type="file" accept=".iso,.img,.bin,.raw" hidden />
          <span class="drop-icon" aria-hidden="true">+</span>
          <span class="drop-title">Drop ISO or disk image</span>
          <span class="drop-meta" id="isoMeta">No boot media selected</span>
        </label>
        <p class="media-warning" id="mediaWarning" hidden></p>

        <button class="secondary full-width" id="demoButton" type="button">Demo boot image</button>

        <div class="field-grid">
          <div class="field full-span emulator-field">
            <span id="emulatorLabel">Emulator</span>
            <select id="emulatorMode" aria-labelledby="emulatorLabel" hidden>
              <option value="v86">Nebula x86 / v86</option>
              <option value="qemu-x64">Nebula x64 / QEMU Wasm</option>
              <option value="native-qemu">Native QEMU / large ISO</option>
              <option value="remote-vm">Remote VM / browser stream</option>
            </select>
            <div class="emulator-list" role="listbox" aria-labelledby="emulatorLabel">
              <button class="emulator-option is-selected" type="button" role="option" aria-selected="true" data-emulator-option="v86">
                <img class="emulator-icon" src="/assets/nebulavm-emulator-icon.png" alt="" />
                <span class="emulator-option-copy">
                  <strong>Nebula x86</strong>
                  <small>v86 browser core</small>
                </span>
              </button>
              <button class="emulator-option" type="button" role="option" aria-selected="false" data-emulator-option="qemu-x64">
                <img class="emulator-icon" src="/assets/nebulavm-emulator-icon.png" alt="" />
                <span class="emulator-option-copy">
                  <strong>Nebula x64</strong>
                  <small>QEMU Wasm</small>
                </span>
              </button>
              <button class="emulator-option" type="button" role="option" aria-selected="false" data-emulator-option="native-qemu">
                <span class="emulator-icon emulator-icon-empty" aria-hidden="true"></span>
                <span class="emulator-option-copy">
                  <strong>Native QEMU</strong>
                  <small>large ISO</small>
                </span>
              </button>
              <button class="emulator-option" type="button" role="option" aria-selected="false" data-emulator-option="remote-vm">
                <span class="emulator-icon emulator-icon-empty" aria-hidden="true"></span>
                <span class="emulator-option-copy">
                  <strong>Remote VM</strong>
                  <small>browser stream</small>
                </span>
              </button>
            </div>
          </div>

          <label class="field full-span">
            <span>Processor</span>
            <select id="processorMode">
              <option value="x86">32-bit x86 processor</option>
              <option value="x64">64-bit x86_64 processor</option>
            </select>
          </label>

          <label class="field">
            <span>Boot as</span>
            <select id="mediaType">
              <option value="cdrom">CD-ROM ISO</option>
              <option value="hda">Hard disk image</option>
              <option value="fda">Floppy image</option>
            </select>
          </label>

          <label class="field">
            <span>Memory</span>
            <select id="memorySize">
              <option value="67108864">64 MB</option>
              <option value="134217728" selected>128 MB</option>
              <option value="268435456">256 MB</option>
              <option value="536870912">512 MB</option>
              <option value="1073741824">1024 MB</option>
              <option value="2147483648">2048 MB</option>
              <option value="4294967296">4096 MB</option>
              <option value="6442450944">6144 MB</option>
            </select>
          </label>

          <label class="field">
            <span>Video memory</span>
            <select id="vgaSize">
              <option value="8388608">8 MB</option>
              <option value="16777216" selected>16 MB</option>
              <option value="33554432">32 MB</option>
              <option value="67108864">64 MB</option>
            </select>
          </label>

          <label class="field">
            <span>Boot order</span>
            <select id="bootOrder">
              <option value="213">CD-ROM first</option>
              <option value="123">Hard disk first</option>
              <option value="132">Floppy first</option>
            </select>
          </label>
        </div>

        <div class="native-panel" id="nativePanel" hidden>
          <label class="field full-span">
            <span>Local ISO path</span>
            <input id="nativeIsoPath" type="text" placeholder="C:\\Users\\Dell\\Downloads\\Win11.iso" />
          </label>

          <label class="toggle-row">
            <input type="checkbox" id="nativeCreateDisk" checked />
            <span>
              <strong>Create install disk</strong>
              <small>Uses a qcow2 disk in the NebulaVM folder.</small>
            </span>
          </label>

          <label class="field">
            <span>Disk size</span>
            <select id="nativeDiskSize">
              <option value="64" selected>64 GB</option>
              <option value="80">80 GB</option>
              <option value="128">128 GB</option>
              <option value="256">256 GB</option>
            </select>
          </label>

          <p class="native-status" id="nativeStatus">Checking native QEMU...</p>
        </div>

        <div class="native-panel" id="remotePanel" hidden>
          <label class="field full-span">
            <span>Remote VM URL</span>
            <input id="remoteVmUrl" type="text" placeholder="https://your-vm-host/vnc.html" />
          </label>
          <p class="native-status" id="remoteStatus">
            Use a noVNC, Guacamole, cloud console, or remote desktop web URL.
          </p>
        </div>

        <label class="toggle-row">
          <input type="checkbox" id="networking" />
          <span>
            <strong>Network adapter</strong>
            <small id="networkingHelp">Uses v86 networking support when available.</small>
          </span>
        </label>

        <label class="toggle-row">
          <input type="checkbox" id="autostart" checked />
          <span>
            <strong>Auto-start after boot</strong>
            <small>Start the emulator as soon as it is created.</small>
          </span>
        </label>

        <div class="button-row">
          <button class="primary" id="bootButton" type="button" disabled>Boot VM</button>
          <button class="secondary" id="pauseButton" type="button" disabled>Pause</button>
          <button class="danger" id="stopButton" type="button" disabled>Stop</button>
        </div>

        <div class="button-row compact">
          <button class="secondary" id="resetButton" type="button" disabled>Reset</button>
          <button class="secondary" id="saveStateButton" type="button" disabled>Save state</button>
          <button class="secondary" id="loadStateButton" type="button">Load state</button>
          <input id="stateInput" type="file" accept=".bin,.state" hidden />
        </div>
      </aside>

      <section class="console-area" aria-label="Virtual machine display">
        <div class="machine-topbar">
          <div>
            <p class="kicker">Display</p>
            <h2 id="machineTitle">Awaiting boot media</h2>
          </div>
          <div class="metric-row">
            <span id="uptimeMetric">00:00</span>
            <span id="ramMetric">128 MB RAM</span>
            <button class="secondary compact-button" id="fullscreenButton" type="button">Fullscreen</button>
          </div>
        </div>

        <div class="screen-shell" id="screenShell">
          <div id="screenContainer" class="screen-container">
            <div class="vga-text"></div>
            <canvas class="vga-canvas"></canvas>
            <pre class="qemu-terminal" id="qemuTerminal" hidden></pre>
            <iframe class="remote-frame" id="remoteFrame" title="Remote VM display" hidden></iframe>
            <div class="screen-placeholder" id="screenPlaceholder">
              <span class="orbital"></span>
              <strong>Drop an ISO to begin</strong>
              <small id="placeholderMeta">Legacy x86, 32-bit Linux, DOS, hobby OS, and vintage Windows images work best.</small>
            </div>
          </div>
        </div>

        <div class="terminal-panel">
          <div class="terminal-header">
            <span>Activity</span>
            <button id="clearLogButton" type="button">Clear</button>
          </div>
          <pre id="logOutput" aria-live="polite"></pre>
        </div>
      </section>
    </section>
  </main>
`;

const els = {
  dropZone: document.querySelector("#dropZone"),
  isoInput: document.querySelector("#isoInput"),
  isoMeta: document.querySelector("#isoMeta"),
  mediaWarning: document.querySelector("#mediaWarning"),
  demoButton: document.querySelector("#demoButton"),
  emulatorMode: document.querySelector("#emulatorMode"),
  emulatorOptions: [...document.querySelectorAll("[data-emulator-option]")],
  processorMode: document.querySelector("#processorMode"),
  nativePanel: document.querySelector("#nativePanel"),
  nativeIsoPath: document.querySelector("#nativeIsoPath"),
  nativeCreateDisk: document.querySelector("#nativeCreateDisk"),
  nativeDiskSize: document.querySelector("#nativeDiskSize"),
  nativeStatus: document.querySelector("#nativeStatus"),
  remotePanel: document.querySelector("#remotePanel"),
  remoteVmUrl: document.querySelector("#remoteVmUrl"),
  remoteStatus: document.querySelector("#remoteStatus"),
  mediaType: document.querySelector("#mediaType"),
  memorySize: document.querySelector("#memorySize"),
  vgaSize: document.querySelector("#vgaSize"),
  bootOrder: document.querySelector("#bootOrder"),
  networking: document.querySelector("#networking"),
  networkingHelp: document.querySelector("#networkingHelp"),
  autostart: document.querySelector("#autostart"),
  bootButton: document.querySelector("#bootButton"),
  pauseButton: document.querySelector("#pauseButton"),
  stopButton: document.querySelector("#stopButton"),
  resetButton: document.querySelector("#resetButton"),
  saveStateButton: document.querySelector("#saveStateButton"),
  loadStateButton: document.querySelector("#loadStateButton"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  stateInput: document.querySelector("#stateInput"),
  screenShell: document.querySelector("#screenShell"),
  screenContainer: document.querySelector("#screenContainer"),
  screenPlaceholder: document.querySelector("#screenPlaceholder"),
  qemuTerminal: document.querySelector("#qemuTerminal"),
  remoteFrame: document.querySelector("#remoteFrame"),
  placeholderMeta: document.querySelector("#placeholderMeta"),
  machineTitle: document.querySelector("#machineTitle"),
  powerState: document.querySelector("#powerState"),
  uptimeMetric: document.querySelector("#uptimeMetric"),
  ramMetric: document.querySelector("#ramMetric"),
  logOutput: document.querySelector("#logOutput"),
  clearLogButton: document.querySelector("#clearLogButton"),
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
};

const log = (message) => {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  els.logOutput.textContent += `[${time}] ${message}\n`;
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
};

const setPowerState = (label, mode = "off") => {
  els.powerState.dataset.mode = mode;
  els.powerState.querySelector("span:last-child").textContent = label;
};

const isBrowserQemuMode = () => els.emulatorMode.value === "qemu-x64";
const isNativeMode = () => els.emulatorMode.value === "native-qemu";
const isRemoteMode = () => els.emulatorMode.value === "remote-vm";
const isQemuMode = () => isBrowserQemuMode() || isNativeMode();
const isExternalMode = () => isQemuMode() || isRemoteMode();

const syncEmulatorPicker = () => {
  els.emulatorOptions.forEach((option) => {
    const selected = option.dataset.emulatorOption === els.emulatorMode.value;
    option.classList.toggle("is-selected", selected);
    option.setAttribute("aria-selected", String(selected));
  });
};

const isSelectedMediaTooLarge = () =>
  isBrowserQemuMode() &&
  !state.browserQemuCanMountFiles &&
  state.isoFile &&
  state.isoFile.size > MAX_BROWSER_MEDIA_BYTES;

const updateMediaWarning = () => {
  if (!isSelectedMediaTooLarge()) {
    els.mediaWarning.hidden = true;
    els.mediaWarning.textContent = "";
    return;
  }

  els.mediaWarning.hidden = false;
  els.mediaWarning.textContent =
    `${state.isoFile.name} is ${formatMegabytes(state.isoFile.size)}. ` +
    `This QEMU Wasm build can stage up to ${formatMegabytes(MAX_BROWSER_MEDIA_BYTES)} in browser memory. ` +
    "A no-install large-ISO backend needs a WORKERFS-capable QEMU Wasm build, or use Native QEMU / Remote VM.";
};

const updateButtons = (busy = false) => {
  const externalMode = isExternalMode();
  const hasBootMedia = isNativeMode()
    ? Boolean(els.nativeIsoPath.value.trim())
    : isRemoteMode()
      ? Boolean(els.remoteVmUrl.value.trim())
      : Boolean(state.isoFile);
  els.bootButton.disabled = !hasBootMedia || Boolean(state.emulator) || isSelectedMediaTooLarge();
  els.pauseButton.disabled = busy || !state.emulator || externalMode;
  els.stopButton.disabled = busy || !state.emulator;
  els.resetButton.disabled = busy || !state.emulator || externalMode;
  els.saveStateButton.disabled = busy || !state.emulator || externalMode;
  els.loadStateButton.disabled = externalMode;
  els.pauseButton.textContent = state.running ? "Pause" : "Resume";
};

const updateUptime = () => {
  if (!state.startedAt) {
    els.uptimeMetric.textContent = "00:00";
    return;
  }
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");
  els.uptimeMetric.textContent = `${minutes}:${seconds}`;
};

const clearStatsTimer = () => {
  if (state.statsTimer) {
    window.clearInterval(state.statsTimer);
    state.statsTimer = null;
  }
};

const setSelectedFile = (file) => {
  state.isoFile = file;
  els.isoMeta.textContent = `${file.name} - ${formatBytes(file.size)}`;
  els.machineTitle.textContent = file.name;
  els.dropZone.classList.add("has-file");
  log(`Selected ${file.name} (${formatBytes(file.size)}).`);
  updateMediaWarning();
  updateButtons();
};

const createDemoBootImage = () => {
  const bytes = new Uint8Array(512);
  const program = [
    0x31, 0xc0, 0x8e, 0xd8, 0x8e, 0xc0, 0xbe, 0x1f, 0x7c, 0xe8, 0x03, 0x00,
    0xf4, 0xeb, 0xfd, 0xac, 0x08, 0xc0, 0x74, 0x0a, 0xb4, 0x0e, 0xb7, 0x00,
    0xb3, 0x07, 0xcd, 0x10, 0xeb, 0xf1, 0xc3,
  ];
  const message = "\r\nNebulaVM demo booted.\r\nDrop your ISO to start a real VM.\r\n";

  bytes.set(program, 0);
  bytes.set(new TextEncoder().encode(message), program.length);
  bytes[510] = 0x55;
  bytes[511] = 0xaa;

  return new File([bytes], "nebulavm-demo-floppy.img", { type: "application/octet-stream" });
};

const stopEmulator = async () => {
  if (!state.emulator) return;

  const emulator = state.emulator;
  state.emulator = null;
  updateButtons(true);

  try {
    await emulator.stop();
    await emulator.destroy();
  } catch (error) {
    log(`Stopped with warning: ${error.message}`);
  }

  state.running = false;
  state.startedAt = null;
  clearStatsTimer();
  updateUptime();
  setPowerState("Powered off", "off");
  els.screenPlaceholder.hidden = false;
  els.screenContainer.querySelector(".vga-text").textContent = "";
  els.screenContainer.querySelector(".vga-text").hidden = false;
  els.screenContainer.querySelector(".vga-canvas").hidden = false;
  els.qemuTerminal.textContent = "";
  els.qemuTerminal.hidden = true;
  els.remoteFrame.src = "about:blank";
  els.remoteFrame.hidden = true;
  updateButtons();
};

const getBootMediaConfig = () => {
  const mediaType = els.mediaType.value;
  const media = { buffer: state.isoFile, async: state.isoFile.size >= 268435456 };
  if (mediaType === "hda") return { hda: media };
  if (mediaType === "fda") return { fda: media };
  return { cdrom: media };
};

const buildConfig = () => ({
  wasm_path: "/v86/v86.wasm",
  screen_container: els.screenContainer,
  bios: { url: "/bios/seabios.bin" },
  vga_bios: { url: "/bios/vgabios.bin" },
  memory_size: Number(els.memorySize.value),
  vga_memory_size: Number(els.vgaSize.value),
  boot_order: Number(els.bootOrder.value),
  autostart: els.autostart.checked,
  network_relay_url: els.networking.checked ? "wss://relay.widgetry.org/" : undefined,
  ...getBootMediaConfig(),
});

const prepareBootUi = () => {
  els.screenPlaceholder.hidden = true;
  els.ramMetric.textContent = `${Number(els.memorySize.value) / 1024 / 1024} MB RAM`;
  setPowerState("Booting", "booting");
  state.startedAt = Date.now();
  clearStatsTimer();
  state.statsTimer = window.setInterval(updateUptime, 1000);
  updateUptime();
};

const bootV86 = () => {
  els.qemuTerminal.hidden = true;
  els.screenContainer.querySelector(".vga-text").hidden = false;
  els.screenContainer.querySelector(".vga-canvas").hidden = false;
  state.emulator = new V86(buildConfig());
  state.running = els.autostart.checked;

  state.emulator.add_listener("emulator-ready", () => {
    log("Emulator ready.");
    setPowerState(state.running ? "Running" : "Paused", state.running ? "running" : "paused");
    updateButtons();
  });

  state.emulator.add_listener("emulator-started", () => {
    state.running = true;
    if (!state.startedAt) state.startedAt = Date.now();
    setPowerState("Running", "running");
    log("VM started.");
    updateButtons();
  });

  state.emulator.add_listener("emulator-stopped", () => {
    state.running = false;
    setPowerState("Paused", "paused");
    log("VM paused.");
    updateButtons();
  });

  state.emulator.add_listener("download-progress", (event) => {
    if (event.file_name) {
      log(`Loading ${event.file_name}: ${Math.round((event.loaded / event.total) * 100)}%.`);
    }
  });
};

const bootQemuX64 = async () => {
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = false;

  state.emulator = new QemuX64Emulator({
    isoFile: state.isoFile,
    mediaType: els.mediaType.value,
    memorySize: Number(els.memorySize.value),
    cpuModel: "qemu64",
    terminal: els.qemuTerminal,
    log,
    onStarted: () => {
      state.running = true;
      setPowerState("Running", "running");
      log("QEMU x86_64 started.");
      updateButtons();
    },
    onStopped: () => {
      state.running = false;
      setPowerState("Powered off", "off");
      updateButtons();
    },
  });

  await state.emulator.start();
};

const bootNativeQemu = async () => {
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = false;
  els.qemuTerminal.textContent = "Starting native QEMU...\n";

  const response = await fetch("/api/native-qemu/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      isoPath: els.nativeIsoPath.value.trim(),
      memoryMb: Number(els.memorySize.value) / 1024 / 1024,
      createDisk: els.nativeCreateDisk.checked,
      diskSizeGb: Number(els.nativeDiskSize.value),
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "Native QEMU failed to start.");
  }

  state.emulator = {
    stop: async () => {
      await fetch("/api/native-qemu/stop", { method: "POST" });
    },
    destroy: async () => {},
  };
  state.running = true;
  setPowerState("Native QEMU", "running");
  updateButtons();
  log(`Native QEMU started in a desktop window (pid ${result.pid}).`);
  if (result.diskPath) log(`Using install disk: ${result.diskPath}`);
  if (result.ovmf) log(`Using UEFI firmware: ${result.ovmf}`);
  els.qemuTerminal.textContent += `Native QEMU started.\nPID: ${result.pid}\n`;
};

const normalizeRemoteUrl = (url) => {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

const bootRemoteVm = async () => {
  const remoteUrl = normalizeRemoteUrl(els.remoteVmUrl.value);
  if (!remoteUrl) {
    throw new Error("Enter a remote VM URL.");
  }

  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = true;
  els.remoteFrame.hidden = false;
  els.remoteFrame.src = remoteUrl;

  state.emulator = {
    stop: async () => {
      els.remoteFrame.src = "about:blank";
      els.remoteFrame.hidden = true;
    },
    destroy: async () => {},
  };
  state.running = true;
  setPowerState("Remote VM", "running");
  log(`Opened remote VM stream: ${remoteUrl}`);
  log("If the display stays blank, the remote site may block embedding. Open the same URL directly in a new browser tab.");
  updateButtons();
};

const bootEmulator = async () => {
  if (!isNativeMode() && !isRemoteMode() && !state.isoFile) return;
  if (isNativeMode() && !els.nativeIsoPath.value.trim()) {
    log("Boot blocked: enter a local ISO path for Native QEMU.");
    return;
  }
  if (isRemoteMode() && !els.remoteVmUrl.value.trim()) {
    log("Boot blocked: enter a remote VM URL.");
    return;
  }
  if (isSelectedMediaTooLarge()) {
    updateMediaWarning();
    log(`Boot blocked: ${els.mediaWarning.textContent}`);
    return;
  }
  await stopEmulator();

  prepareBootUi();
  log("Creating virtual machine.");

  try {
    if (isRemoteMode()) {
      await bootRemoteVm();
    } else if (isNativeMode()) {
      await bootNativeQemu();
    } else if (isBrowserQemuMode()) {
      await bootQemuX64();
    } else {
      bootV86();
    }
    log("Boot sequence started.");
  } catch (error) {
    log(`Boot failed: ${error.message}`);
    await stopEmulator();
  }
};

const pauseOrResume = () => {
  if (!state.emulator) return;
  if (els.emulatorMode.value === "qemu-x64") {
    log("Pause and resume are not available for the QEMU x86_64 backend yet.");
    return;
  }
  if (state.running) {
    state.emulator.stop();
    return;
  }
  state.emulator.run();
};

const resetEmulator = () => {
  if (!state.emulator) return;
  if (isExternalMode()) {
    log("Reset is not available for QEMU or remote backends yet.");
    return;
  }
  state.emulator.restart();
  state.startedAt = Date.now();
  log("VM reset.");
  updateUptime();
};

const saveState = async () => {
  if (!state.emulator) return;
  if (isExternalMode()) {
    log("State save is not available for QEMU or remote backends yet.");
    return;
  }
  log("Saving VM state.");
  const buffer = await state.emulator.save_state();
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nebulavm-${Date.now()}.state`;
  link.click();
  URL.revokeObjectURL(url);
  log("State downloaded.");
};

const loadState = async (file) => {
  if (isExternalMode()) {
    log("State load is not available for QEMU or remote backends yet.");
    return;
  }
  if (!state.emulator) {
    log("Boot a VM before loading a saved state.");
    return;
  }
  const buffer = await file.arrayBuffer();
  await state.emulator.restore_state(buffer);
  log(`Loaded state from ${file.name}.`);
};

els.isoInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) setSelectedFile(file);
});

els.dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.dropZone.classList.add("is-dragging");
});

els.dropZone.addEventListener("dragleave", () => {
  els.dropZone.classList.remove("is-dragging");
});

els.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  els.dropZone.classList.remove("is-dragging");
  const [file] = event.dataTransfer.files;
  if (file) setSelectedFile(file);
});

els.bootButton.addEventListener("click", bootEmulator);
els.demoButton.addEventListener("click", () => {
  els.emulatorMode.value = "v86";
  els.processorMode.value = "x86";
  updateBackendUi();
  setSelectedFile(createDemoBootImage());
  els.mediaType.value = "fda";
  els.bootOrder.value = "132";
  log("Demo boot image loaded.");
});
els.pauseButton.addEventListener("click", pauseOrResume);
els.stopButton.addEventListener("click", stopEmulator);
els.resetButton.addEventListener("click", resetEmulator);
els.saveStateButton.addEventListener("click", saveState);
els.loadStateButton.addEventListener("click", () => els.stateInput.click());
els.stateInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) loadState(file);
});

els.memorySize.addEventListener("change", () => {
  els.ramMetric.textContent = `${Number(els.memorySize.value) / 1024 / 1024} MB RAM`;
});

const updateNativeStatus = async () => {
  if (!isNativeMode()) return;

  try {
    const response = await fetch("/api/native-qemu/status");
    const status = await response.json();
    if (status.available) {
      els.nativeStatus.dataset.mode = "ready";
      els.nativeStatus.textContent = `Native QEMU ready${status.ovmf ? " with UEFI" : ""}.`;
    } else {
      els.nativeStatus.dataset.mode = "missing";
      els.nativeStatus.textContent = "Native QEMU not found. Install QEMU for Windows, then restart NebulaVM.";
    }
  } catch (error) {
    els.nativeStatus.dataset.mode = "missing";
    els.nativeStatus.textContent = `Native QEMU status unavailable: ${error.message}`;
  }
};

const updateBrowserQemuCapabilities = async () => {
  if (!isBrowserQemuMode()) return;
  state.browserQemuCanMountFiles = await qemuWasmCanMountBrowserFiles();
  updateMediaWarning();
  updateButtons();
};

const updateBackendUi = () => {
  const qemuMode = isQemuMode();
  const nativeMode = isNativeMode();
  const remoteMode = isRemoteMode();
  const externalMode = isExternalMode();
  syncEmulatorPicker();
  els.processorMode.value = qemuMode ? "x64" : "x86";
  els.nativePanel.hidden = !nativeMode;
  els.remotePanel.hidden = !remoteMode;
  els.vgaSize.disabled = externalMode;
  els.bootOrder.disabled = externalMode;
  els.demoButton.disabled = externalMode;
  els.autostart.disabled = externalMode;
  els.networkingHelp.textContent = externalMode
    ? "QEMU networking depends on the compiled Wasm build."
    : "Uses v86 networking support when available.";
  els.placeholderMeta.textContent = nativeMode
    ? "Native QEMU opens a desktop VM window and reads the ISO directly from disk."
    : remoteMode
      ? "Remote VM mode shows a VM running on another computer or cloud server."
    : isBrowserQemuMode()
      ? "x86_64 support uses QEMU Wasm and local artifacts from public/qemu."
    : "Legacy x86, 32-bit Linux, DOS, hobby OS, and vintage Windows images work best.";
  els.ramMetric.textContent = `${Number(els.memorySize.value) / 1024 / 1024} MB RAM`;
  updateMediaWarning();
  updateButtons();
  void updateNativeStatus();
  void updateBrowserQemuCapabilities();
};

els.emulatorMode.addEventListener("change", updateBackendUi);
els.emulatorOptions.forEach((option) => {
  option.addEventListener("click", () => {
    els.emulatorMode.value = option.dataset.emulatorOption;
    updateBackendUi();
  });
});
els.processorMode.addEventListener("change", () => {
  els.emulatorMode.value = els.processorMode.value === "x64" ? "qemu-x64" : "v86";
  updateBackendUi();
});
els.nativeIsoPath.addEventListener("input", updateButtons);
els.nativeCreateDisk.addEventListener("change", updateButtons);
els.remoteVmUrl.addEventListener("input", updateButtons);

const updateFullscreenButton = () => {
  const isFullscreen = document.fullscreenElement === els.screenShell;
  els.fullscreenButton.textContent = isFullscreen ? "Exit fullscreen" : "Fullscreen";
  els.screenShell.classList.toggle("is-fullscreen", isFullscreen);
};

const toggleFullscreen = async () => {
  try {
    if (document.fullscreenElement === els.screenShell) {
      await document.exitFullscreen();
    } else {
      await els.screenShell.requestFullscreen();
    }
  } catch (error) {
    log(`Fullscreen unavailable: ${error.message}`);
  }
  updateFullscreenButton();
};

els.fullscreenButton.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", updateFullscreenButton);

els.clearLogButton.addEventListener("click", () => {
  els.logOutput.textContent = "";
});

window.addEventListener("beforeunload", stopEmulator);

log("NebulaVM ready.");
updateBackendUi();
updateButtons();
