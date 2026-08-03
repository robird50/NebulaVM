import { V86 } from "v86";
import RFB from "@novnc/novnc";
import {
  QemuX64Emulator,
  MAX_BROWSER_MEDIA_BYTES,
  formatMegabytes,
  qemuWasmCanMountBrowserFiles,
} from "./qemuX64.js";
import "./styles.css";

const app = document.querySelector("#app");
const COMMIT_ID = typeof __NEBULAVM_COMMIT__ === "string" ? __NEBULAVM_COMMIT__ : "local";
const HOST_TOKEN_STORAGE_KEY = "nebulavm.emustar.hostToken";
const HOST_SESSION_STORAGE_KEY = "nebulavm.emustar.sessionId";
const HOST_DEVICE_STORAGE_KEY = "nebulavm.emustar.deviceId.v1";
const HYPERV_REMOTE_SESSION_STORAGE_KEY = "nebulavm.hyperv.remoteSessionId";
const STORED_ISO_PROMPT_KEY = "nebulavm.emustar.storedIsoPrompt";
const STORED_ISO_LIMIT = 2;
const MOBILE_DEV_UNLOCK_KEY = "nebulavm.mobile.devUnlock.v3";
const MOBILE_DEV_ATTEMPTS_KEY = "nebulavm.mobile.devAttempts";
const MOBILE_DEV_LOCK_KEY = "nebulavm.mobile.devLockUntil";
const MOBILE_DEV_MAX_ATTEMPTS = 5;
const MOBILE_DEV_LOCK_MS = 5 * 60 * 1000;
const HYPERV_MIRROR_60FPS_FRAME_MS = 16;
const HYPERV_MIRROR_FAST_FRAME_MS = HYPERV_MIRROR_60FPS_FRAME_MS;
const HYPERV_MIRROR_HIGH_FRAME_MS = HYPERV_MIRROR_60FPS_FRAME_MS;
const HYPERV_MIRROR_IDLE_FRAME_MS = HYPERV_MIRROR_60FPS_FRAME_MS;
const HYPERV_MIRROR_RETRY_MS = 500;
const MOBILE_PUBLIC_RELEASE = true;
const MOBILE_DEV_GATE_ENABLED = !MOBILE_PUBLIC_RELEASE;
const ANDROID_CURATED_VERSIONS = [2, 4, 5, 6, 8, 9, 12, 16, 17];
const NINTENDO_EMULATORS = [
  {
    value: "mgba",
    label: "mGBA",
    system: "Game Boy Advance",
    core: "gba",
    formats: ".gba, .gb, .gbc, .zip",
    extensions: ["gba", "gb", "gbc", "zip"],
  },
  {
    value: "melonds",
    label: "melonDS",
    system: "Nintendo DS",
    core: "nds",
    formats: ".nds, .zip",
    extensions: ["nds", "zip"],
  },
  {
    value: "snes9x",
    label: "Snes9x",
    system: "Super Nintendo",
    core: "snes",
    formats: ".sfc, .smc, .fig, .swc, .zip",
    extensions: ["sfc", "smc", "fig", "swc", "zip"],
  },
];
const NINTENDO_ACCEPTED_EXTENSIONS = [
  ...new Set(NINTENDO_EMULATORS.flatMap((engine) => engine.extensions)),
];
const NINTENDO_CPU_STEPS = [2, 4, 6, 8];
const NINTENDO_RAM_STEPS = [2, 4, 8, 16];
const NINTENDO_VRAM_STEPS = [
  { value: 512, label: "512 MB" },
  { value: 1024, label: "1 GB" },
  { value: 2048, label: "2 GB" },
  { value: 4096, label: "4 GB" },
];
const hostedLauncherHostnames = new Set(["nebulavm.online", "www.nebulavm.online"]);
const isHistoricalNetlifyDeploy =
  /\.netlify\.app$/i.test(window.location.hostname) &&
  !hostedLauncherHostnames.has(window.location.hostname);
const isNetlifyLauncher =
  /\.netlify\.app$/i.test(window.location.hostname) || hostedLauncherHostnames.has(window.location.hostname);

const isMobileOrTabletDevice = () => {
  if (navigator.userAgentData?.mobile) {
    return true;
  }

  const userAgent = navigator.userAgent || navigator.vendor || window.opera || "";
  const mobileOrTabletUserAgent =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet|Kindle|Silk/i.test(userAgent);
  const iPadDesktopMode = /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1;
  const touchCapable = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  const coarsePointer =
    window.matchMedia("(pointer: coarse)").matches ||
    window.matchMedia("(any-pointer: coarse)").matches;
  const coarsePortableScreen =
    touchCapable &&
    coarsePointer &&
    window.matchMedia("(max-width: 1366px)").matches;

  return mobileOrTabletUserAgent || iPadDesktopMode || coarsePortableScreen;
};

const isPublicMobileClient = MOBILE_PUBLIC_RELEASE && isMobileOrTabletDevice();

if (isMobileOrTabletDevice()) {
  document.documentElement.classList.add("is-mobile-device");
  if (isPublicMobileClient) {
    document.documentElement.classList.add("mobile-dev-bypass", "mobile-public");
  }
}

const sharedHostTokenFromUrl = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
if (sharedHostTokenFromUrl) {
  window.sessionStorage.setItem(HOST_TOKEN_STORAGE_KEY, sharedHostTokenFromUrl);
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  hashParams.delete("token");
  const cleanHash = hashParams.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${cleanHash ? `#${cleanHash}` : ""}`,
  );
}
const legacyHostToken = window.localStorage.getItem(HOST_TOKEN_STORAGE_KEY) || "";
if (!sharedHostTokenFromUrl && legacyHostToken && !window.sessionStorage.getItem(HOST_TOKEN_STORAGE_KEY)) {
  window.sessionStorage.setItem(HOST_TOKEN_STORAGE_KEY, legacyHostToken);
}
window.localStorage.removeItem(HOST_TOKEN_STORAGE_KEY);
const savedHostToken = sharedHostTokenFromUrl || window.sessionStorage.getItem(HOST_TOKEN_STORAGE_KEY) || "";
const savedSessionId =
  window.sessionStorage.getItem(HOST_SESSION_STORAGE_KEY) ||
  (crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`);
window.sessionStorage.setItem(HOST_SESSION_STORAGE_KEY, savedSessionId);
const savedHyperVRemoteSessionId = window.sessionStorage.getItem(HYPERV_REMOTE_SESSION_STORAGE_KEY) || "";
const storedDeviceId = window.localStorage.getItem(HOST_DEVICE_STORAGE_KEY) || "";
const savedDeviceId = /^[a-zA-Z0-9_-]{16,128}$/.test(storedDeviceId)
  ? storedDeviceId
  : `device-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
window.localStorage.setItem(HOST_DEVICE_STORAGE_KEY, savedDeviceId);

const state = {
  isoFile: null,
  emulator: null,
  running: false,
  startedAt: null,
  statsTimer: null,
  browserQemuCanMountFiles: false,
  nativeQemuApiAvailable: null,
  nativeQemuReady: false,
  nativeQemuApiBase: null,
  nativeHostToken: savedHostToken,
  nativeSessionId: savedSessionId,
  nativeDeviceId: savedDeviceId,
  hyperVRemoteSessionId: savedHyperVRemoteSessionId,
  nativeRfb: null,
  nativeRuntimeName: null,
  nativeMonitorTimer: null,
  nativeStatusRefreshTimer: null,
  nativeDisplayReconnectTimer: null,
  nativeDisplayReconnectAttempts: 0,
  nativeDisplayReconnectConfig: null,
  lastNativeStopLogKey: "",
  hyperVConsoleTimer: null,
  hyperVConsoleActive: false,
  hyperVConsoleCleanup: null,
  hyperVConsoleFrameUrl: null,
  hyperVConsolePollNow: null,
  hyperVConsoleFastUntil: 0,
  virtualKeyboardOpen: false,
  virtualKeyboardShift: false,
  guestResizeTimer: null,
  lastGuestResize: "",
  hostStagedIsoBase: "",
  hostStagedIsoFileKey: "",
  hostStagedIsoPath: "",
  hostStagedIsoSessionId: "",
  hostStagedIsoUploadPromise: null,
  hostStagedIsoUploading: false,
  hostStagingEtaBaselineBytes: 0,
  hostStagingEtaStartedAt: 0,
  hostStagingEtaLastRenderedAt: 0,
  nintendoRomUrl: "",
  nintendoFrame: null,
  nintendoRunId: 0,
  nintendoMessageHandler: null,
  storedIsos: [],
  storedIsoLimit: STORED_ISO_LIMIT,
  storedImagesMenuOpen: false,
  storedIsoUploading: false,
  windowsTemplateLoading: false,
  windowsTemplateSelected: false,
  windowsTemplateDiskPath: "",
  androidView: "home",
  androidHistory: ["home"],
  androidRecents: [],
  androidNativeActive: false,
  androidNativeFrameTimer: null,
  androidNativeFrameUrl: null,
  androidNativePointer: null,
  androidNativeInputController: null,
  androidNativeLeaseTimer: null,
  androidColdBootTimer: null,
  androidColdBootEndsAt: 0,
  androidViewportMode: "device",
  androidStudioActive: false,
  androidStudioTimer: null,
  androidStudioFrameUrl: null,
  androidStudioCleanup: null,
  screenAppFullscreen: false,
};

app.innerHTML = `
  <main class="mobile-unsupported" aria-labelledby="mobileUnsupportedTitle">
    <img class="mobile-unsupported-image" src="/assets/mobile-not-supported.png" alt="NebulaVM mobile and tablet devices not supported" />
    <section class="mobile-unsupported-copy">
      <h1 id="mobileUnsupportedTitle">Mobile and Tablet Not Supported</h1>
      <p>NebulaVM is currently available only on desktop and laptop browsers. Mobile and tablet support is still in development.</p>
      <p>Please visit this page from a computer to launch a virtual machine. Thank you for your patience!</p>
      <button class="mobile-bypass-link" id="mobileBypassButton" type="button">Bypass (devs only)</button>
    </section>
    <small class="commit-id">Commit ${COMMIT_ID} <span>RoBird Studios 2026</span> <a href="https://github.com/robird50/NebulaVM">Source Code</a> <a href="#other-commits" data-commit-history-link>Other commits</a> <a href="#faq" data-faq-link>FAQ</a> <a href="#nebula-conflict" data-nebula-conflict-link>The Nebula Conflict</a> <a class="mobile-apk-link" href="/downloads/NebulaVM.apk" download>APK download</a> <a class="tiktok-footer-link" href="https://www.tiktok.com/@nebulavm" aria-label="NebulaVM on TikTok" title="NebulaVM on TikTok"><img src="/assets/tiktok-icon.png" alt="" /></a> <a class="report-problem-link" href="#report-problem" data-report-problem-link>Report a problem</a></small>
  </main>

  <div class="mobile-bypass-overlay popup-motion-overlay" id="mobileBypassDialog" role="dialog" aria-modal="true" aria-labelledby="mobileBypassText" hidden>
    <section class="mobile-bypass-panel popup-motion-panel">
      <button class="mobile-bypass-close" id="mobileBypassCloseButton" type="button" aria-label="Close developer bypass">x</button>
      <img class="mobile-bypass-lock" src="/assets/mobile-dev-lock.png" alt="" />
      <p id="mobileBypassText">Enter the confidential 6-digit developer code to unlock the mobile testing build.</p>
      <div class="mobile-pin-dots" id="mobilePinDots" aria-label="6-digit code progress">
        <span></span><span></span><span></span><span></span><span></span><span></span>
      </div>
      <div class="mobile-keypad" id="mobileKeypad" aria-label="Developer number keypad"></div>
      <p class="mobile-bypass-feedback" id="mobileBypassFeedback" aria-live="polite"></p>
    </section>
  </div>

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
        NebulaVM is an open-source, browser-based virtual machine platform that makes running operating systems simple. Launch lightweight virtual machines directly in your browser, or use the optional Hyper-V host for more flexible virtualization and support for modern 64-bit operating systems like Windows 11. With drag-and-drop ISO support, configurable hardware, fullscreen mode, and a clean interface, NebulaVM brings virtualization to the web while remaining <strong>free forever</strong>.
      </p>
      <div class="status-actions">
        <div class="status-pill" id="powerState">
          <span class="status-dot"></span>
          <span>Powered off</span>
        </div>
        <div class="experimental-warning-pill" id="experimentalWarningPill" hidden>
          This emulator is experimental. Be careful as things might not go the way you want it to.
        </div>
        <div class="stored-images-control" id="storedImagesControl">
          <button class="stored-images-button" id="storedImagesButton" type="button" aria-haspopup="menu" aria-expanded="false">
            <span class="stored-images-arrow" aria-hidden="true">v</span>
            <span>Stored images</span>
          </button>
          <div class="stored-images-menu" id="storedImagesMenu" role="menu" hidden>
            <div class="stored-images-menu-head">
              <strong>Stored images</strong>
              <small id="storedImagesCount">0 / 2 used</small>
            </div>
            <div class="stored-iso-slots" id="storedIsoSlots"></div>
          </div>
        </div>
        <button class="windows-template-button" id="windowsTemplateButton" type="button" hidden>
          Windows 11 Template &#128513;
        </button>
      </div>
    </section>

    <section class="workspace" id="workspace" aria-label="Virtual machine workspace">
      <aside class="panel controls" aria-label="Virtual machine controls">
        <div class="panel-header">
          <div>
            <p class="kicker" id="mediaKicker">Media</p>
            <h2 id="bootSourceTitle">Boot source</h2>
          </div>
        </div>

        <div class="button-row main-actions">
          <button class="primary" id="bootButton" type="button" disabled>Boot VM</button>
          <button class="secondary" id="pauseButton" type="button" disabled>Pause</button>
          <button class="danger" id="stopButton" type="button" disabled>Stop</button>
        </div>

        <label class="drop-zone" id="dropZone" for="isoInput">
          <input id="isoInput" type="file" accept=".iso,.img,.bin,.raw" hidden />
          <input id="storedIsoInput" type="file" accept=".iso,.img,.bin,.raw" hidden />
          <span class="drop-icon" aria-hidden="true">+</span>
          <span class="drop-title">Drop ISO or disk image</span>
          <span class="drop-meta" id="isoMeta">No boot media selected</span>
          <span class="host-staging-progress" id="hostStagingProgress" hidden>
            <span
              class="host-staging-track"
              role="progressbar"
              aria-label="Hyper-V host staging progress"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow="0"
            >
              <span id="hostStagingProgressFill"></span>
            </span>
            <span class="host-staging-stats">
              <span id="hostStagingProgressText">0% - 0 B</span>
              <span class="host-staging-speed" id="hostStagingSpeed">0 KB/s</span>
              <span class="host-staging-eta" id="hostStagingEta">--:--:-- remaining</span>
            </span>
          </span>
        </label>
        <button class="nintendo-help-link" id="nintendoHelpLink" type="button" hidden>
          Need help finding games?
        </button>
        <p class="media-warning" id="mediaWarning" hidden></p>

        <button class="secondary full-width" id="demoButton" type="button">Demo boot image</button>

        <div class="field-grid">
          <div class="field full-span emulator-field">
            <span id="emulatorLabel">Emulator</span>
            <select id="emulatorMode" aria-labelledby="emulatorLabel" hidden>
              <option value="v86">Nebula x86 / v86</option>
              <option value="qemu-x64">Nebula x64 / QEMU Wasm</option>
              <option value="emustar-hyperv">Hyper-V x64</option>
              <option value="qemu-native-x64">QEMU x64 / large ISO</option>
              <option value="qemu-native-arm64-windows">QEMU ARM64 / Windows</option>
              <option value="qemu-native-arm64-ubuntu">QEMU ARM64 / Ubuntu</option>
              <option value="remote-vm">Remote VM / browser stream</option>
              <option value="android">Android</option>
              <option value="nintendo">Nintendo</option>
            </select>
            <div class="emulator-dropdown">
              <button
                class="emulator-select"
                id="emulatorSelectButton"
                type="button"
                aria-haspopup="listbox"
                aria-expanded="false"
                aria-labelledby="emulatorLabel emulatorSelectedText"
              >
                <span class="emulator-selected">
                  <img class="emulator-menu-icon" id="emulatorSelectedIcon" src="/assets/nebulavm-emulator-icon.png" alt="" />
                  <span id="emulatorSelectedText">Nebula x86 / v86</span>
                </span>
              </button>
              <div class="emulator-menu" id="emulatorMenu" role="listbox" aria-labelledby="emulatorLabel" hidden>
                <button class="emulator-menu-option is-selected" type="button" role="option" aria-selected="true" data-emulator-option="v86">
                  <img class="emulator-menu-icon" src="/assets/nebulavm-emulator-icon.png" alt="" />
                  <span>Nebula x86 / v86</span>
                </button>
                <button class="emulator-menu-option" type="button" role="option" aria-selected="false" data-emulator-option="qemu-x64">
                  <img class="emulator-menu-icon" src="/assets/nebulavm-emulator-icon.png" alt="" />
                  <span>Nebula x64 / QEMU Wasm</span>
                </button>
                <button class="emulator-menu-option" type="button" role="option" aria-selected="false" data-emulator-option="emustar-hyperv">
                  <img class="emulator-menu-icon" src="/assets/hyperv-icon.svg" alt="" />
                  <span>Hyper-V x64</span>
                </button>
                <button class="emulator-menu-option" type="button" role="option" aria-selected="false" data-emulator-option="qemu-native-x64">
                  <img class="emulator-menu-icon" src="/assets/qemu-icon.png" alt="" />
                  <span>QEMU x64 / large ISO</span>
                </button>
                <button class="emulator-menu-option" type="button" role="option" aria-selected="false" data-emulator-option="qemu-native-arm64-windows">
                  <img class="emulator-menu-icon" src="/assets/qemu-icon.png" alt="" />
                  <span>QEMU ARM64 / Windows</span>
                </button>
                <button class="emulator-menu-option" type="button" role="option" aria-selected="false" data-emulator-option="qemu-native-arm64-ubuntu">
                  <img class="emulator-menu-icon" src="/assets/qemu-icon.png" alt="" />
                  <span>QEMU ARM64 / Ubuntu</span>
                </button>
                <button class="emulator-menu-option" type="button" role="option" aria-selected="false" data-emulator-option="remote-vm">
                  <img class="emulator-menu-icon" src="/assets/remote-vm-icon.png" alt="" />
                  <span>Remote VM / browser stream</span>
                </button>
                <button class="emulator-menu-option" type="button" role="option" aria-selected="false" data-emulator-option="android">
                  <img class="emulator-menu-icon" src="/assets/android-icon.png" alt="" />
                  <span>Android</span>
                </button>
                <button class="emulator-menu-option" type="button" role="option" aria-selected="false" data-emulator-option="nintendo">
                  <img class="emulator-menu-icon" src="/assets/nintendo-icon.webp" alt="" />
                  <span>Nintendo</span>
                </button>
              </div>
            </div>
            <button class="emustar-info-link" id="emustarInfoLink" type="button" hidden>
              What in the world is Hyper-V?
            </button>
          </div>

          <section class="android-config full-span" id="androidConfig" hidden>
            <p class="android-public-limits">
              Public mobile mode: Android or Remote VM. Android uses adaptive RAM, up to 2 CPU
              cores, 4 GB storage, portrait Device view, and a 20-minute session limit.
            </p>
            <label class="field full-span">
              <span>Genuine Android system image</span>
              <select id="androidVersion">
                ${ANDROID_CURATED_VERSIONS.map((version) => {
                  return `<option value="${version}"${version === 16 ? " selected" : ""}>Android ${version}</option>`;
                }).join("")}
              </select>
            </label>
            <div class="android-spec-grid">
              <label class="field">
                <span>Processor cores</span>
                <select id="androidCores">
                  <option value="1">1 core</option>
                  <option value="2">2 cores</option>
                  <option value="4" selected>4 cores</option>
                </select>
              </label>
              <label class="field">
                <span>Memory</span>
                <select id="androidMemory">
                  <option value="0" selected>Adaptive (recommended)</option>
                  <option value="512">512 MB</option>
                  <option value="1024">1024 MB</option>
                  <option value="2048">2048 MB</option>
                  <option value="3072">3072 MB</option>
                  <option value="4096">4096 MB</option>
                </select>
              </label>
              <label class="field full-span">
                <span>Device storage</span>
                <select id="androidStorage">
                  <option value="4">4 GB</option>
                  <option value="8" selected>8 GB</option>
                  <option value="16">16 GB</option>
                  <option value="32">32 GB</option>
                </select>
              </label>
            </div>
            <fieldset class="android-orientation">
              <legend>Orientation</legend>
              <label>
                <input type="radio" name="androidOrientation" value="portrait" checked />
                <span><strong>9:16</strong><small>Portrait</small></span>
              </label>
              <label>
                <input type="radio" name="androidOrientation" value="landscape" />
                <span><strong>16:9</strong><small>Landscape</small></span>
              </label>
            </fieldset>
            <p class="android-image-note" id="androidImageNote">Checking installed Android system images...</p>
          </section>

          <section class="nintendo-config full-span" id="nintendoConfig" hidden>
            <label class="field full-span">
              <span>Legal emulator engine</span>
              <select id="nintendoEngine">
                ${NINTENDO_EMULATORS.map((engine) => {
                  return `<option value="${engine.value}">${engine.label} - ${engine.system}</option>`;
                }).join("")}
              </select>
            </label>
            <p class="nintendo-legal-note">
              Real browser cores are included for mGBA, melonDS, and Snes9x. Use homebrew or game
              backups you legally own. NebulaVM does not include Nintendo games, firmware, BIOS files,
              keys, or copyrighted system files.
            </p>
            <div class="nintendo-spec-grid">
              <div class="field range-field full-span">
                <div class="range-heading">
                  <label for="nintendoCpuSlider">CPU cores</label>
                  <output id="nintendoCpuValue" for="nintendoCpuSlider">4 cores</output>
                </div>
                <input
                  class="hardware-slider nintendo-slider"
                  id="nintendoCpuSlider"
                  type="range"
                  min="0"
                  max="3"
                  step="1"
                  value="1"
                  aria-label="Nintendo CPU cores"
                  aria-valuetext="4 cores"
                />
                <span class="range-endpoints" aria-hidden="true"><span>2 cores</span><span>8 cores</span></span>
              </div>

              <div class="field range-field">
                <div class="range-heading">
                  <label for="nintendoRamSlider">RAM</label>
                  <output id="nintendoRamValue" for="nintendoRamSlider">4 GB</output>
                </div>
                <input
                  class="hardware-slider nintendo-slider"
                  id="nintendoRamSlider"
                  type="range"
                  min="0"
                  max="3"
                  step="1"
                  value="1"
                  aria-label="Nintendo RAM"
                  aria-valuetext="4 GB"
                />
                <span class="range-endpoints" aria-hidden="true"><span>2 GB</span><span>16 GB</span></span>
              </div>

              <div class="field range-field">
                <div class="range-heading">
                  <label for="nintendoVramSlider">VRAM</label>
                  <output id="nintendoVramValue" for="nintendoVramSlider">512 MB</output>
                </div>
                <input
                  class="hardware-slider nintendo-slider"
                  id="nintendoVramSlider"
                  type="range"
                  min="0"
                  max="3"
                  step="1"
                  value="0"
                  aria-label="Nintendo VRAM"
                  aria-valuetext="512 MB"
                />
                <span class="range-endpoints" aria-hidden="true"><span>512 MB</span><span>4 GB</span></span>
              </div>
            </div>
          </section>

          <label class="field full-span pc-spec-control">
            <span>Processor</span>
            <select id="processorMode">
              <option value="x86">32-bit x86 processor</option>
              <option value="x64">64-bit x86_64 processor</option>
              <option value="arm64">64-bit ARM64 processor</option>
            </select>
          </label>

          <div class="field range-field full-span pc-spec-control">
            <div class="range-heading">
              <label for="processorSpeed">Processor speed</label>
              <output id="processorSpeedValue" for="processorSpeed">2 GHz</output>
            </div>
            <input
              class="hardware-slider"
              id="processorSpeed"
              type="range"
              min="1"
              max="5"
              step="1"
              value="2"
              aria-label="Processor speed"
              aria-valuetext="2 GHz"
            />
            <span class="range-endpoints" aria-hidden="true"><span>1 GHz</span><span>5 GHz</span></span>
          </div>

          <label class="field pc-spec-control">
            <span>Boot as</span>
            <select id="mediaType">
              <option value="cdrom">CD-ROM ISO</option>
              <option value="hda">Hard disk image</option>
              <option value="fda">Floppy image</option>
            </select>
          </label>

          <div class="field range-field pc-spec-control">
            <div class="range-heading">
              <label for="memorySlider">Memory</label>
              <output id="memorySliderValue" for="memorySlider">128 MB</output>
            </div>
            <input
              class="hardware-slider"
              id="memorySlider"
              type="range"
              min="0"
              max="7"
              step="1"
              value="1"
              aria-label="Memory"
              aria-valuetext="128 MB"
            />
            <span class="range-endpoints" aria-hidden="true"><span>64 MB</span><span>6144 MB</span></span>
            <select id="memorySize" hidden aria-hidden="true" tabindex="-1">
              <option value="67108864">64 MB</option>
              <option value="134217728" selected>128 MB</option>
              <option value="268435456">256 MB</option>
              <option value="536870912">512 MB</option>
              <option value="1073741824">1024 MB</option>
              <option value="2147483648">2048 MB</option>
              <option value="4294967296">4096 MB</option>
              <option value="6442450944">6144 MB</option>
            </select>
          </div>

          <label class="field pc-spec-control">
            <span>Video memory</span>
            <select id="vgaSize">
              <option value="8388608">8 MB</option>
              <option value="16777216" selected>16 MB</option>
              <option value="33554432">32 MB</option>
              <option value="67108864">64 MB</option>
            </select>
          </label>

          <label class="field pc-spec-control">
            <span>Boot order</span>
            <select id="bootOrder">
              <option value="213">CD-ROM first</option>
              <option value="123">Hard disk first</option>
              <option value="132">Floppy first</option>
            </select>
          </label>
        </div>

        <details class="advanced-options" id="advancedOptions">
          <summary>
            <span>More options</span>
            <small>Runtime, storage, network, and state tools</small>
          </summary>

          <div class="advanced-options-body">
            <div class="native-panel" id="nativePanel" hidden>
              <div class="emustar-runtime-heading">
                <img id="nativeRuntimeIcon" src="/assets/hyperv-icon.svg" alt="" />
                <span>
                  <span class="emustar-console-kicker">Nebula Console</span>
                  <strong id="nativeRuntimeName">Hyper-V</strong>
                  <small id="nativeRuntimeAttribution">Native virtualization runtime</small>
                </span>
              </div>

              <div class="emustar-host-share" id="emustarHostShare" hidden>
                <label class="field full-span">
                  <span>Browser access link</span>
                  <input id="emustarShareUrl" type="text" readonly />
                </label>
                <button class="secondary" id="emustarCopyShareButton" type="button">Copy browser link</button>
                <small id="emustarShareStatus">Checking host access...</small>
              </div>

              <label class="field full-span">
                <span>Display</span>
                <select id="nativeDisplayMode">
                  <option value="viewport" selected>Browser desktop</option>
                  <option value="external">Host console</option>
                </select>
              </label>

              <label class="field full-span">
                <span>Local ISO path</span>
                <input id="nativeIsoPath" type="text" placeholder="C:\\Path\\To\\Your.iso" />
              </label>

              <div class="windows-credentials-panel" id="windowsCredentialsPanel">
                <div class="windows-credentials-heading">
                  <strong>Windows account</strong>
                  <small id="windowsCredentialsHelp">Enabled when the selected ISO looks like Windows.</small>
                </div>
                <label class="field">
                  <span>Username</span>
                  <input id="windowsUsername" type="text" value="Nebula" maxlength="20" autocomplete="username" />
                </label>
                <label class="field">
                  <span>Password</span>
                  <input id="windowsPassword" type="password" autocomplete="new-password" />
                </label>
                <label class="toggle-row">
                  <input type="checkbox" id="windowsPasswordOff" />
                  <span>
                    <strong>Password off</strong>
                    <small>Creates the Windows account without a password.</small>
                  </span>
                </label>
              </div>

              <label class="toggle-row">
                <input type="checkbox" id="nativeCreateDisk" checked />
                <span>
                  <strong>Create install disk</strong>
                  <small id="nativeDiskHelp">Uses a virtual disk in the NebulaVM folder.</small>
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

              <button
                class="secondary emustar-reset-firmware"
                id="nativeResetFirmwareButton"
                type="button"
                title="Restore clean UEFI settings without deleting the virtual disk"
              >Reset UEFI</button>

              <button
                class="secondary emustar-reset-firmware"
                id="nativeConsoleButton"
                type="button"
                title="Open the Hyper-V setup console on this host"
                hidden
              >Open host console</button>

              <p class="native-status" id="nativeStatus">Checking Hyper-V...</p>
            </div>

            <div class="native-panel" id="remotePanel" hidden>
              <label class="field full-span">
                <span>Remote VM URL</span>
                <input id="remoteVmUrl" type="text" value="https://nebulavm.online/remote.html" />
              </label>
              <p class="native-status" id="remoteStatus">
                NebulaVM Remote Console connects to the Windows VM already running on your active host.
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

            <div class="button-row compact">
              <button class="secondary" id="resetButton" type="button" disabled>Reset</button>
              <button class="secondary" id="saveStateButton" type="button" disabled>Save state</button>
              <button class="secondary" id="loadStateButton" type="button">Load state</button>
              <input id="stateInput" type="file" accept=".bin,.state" hidden />
            </div>
          </div>
        </details>
      </aside>

      <section class="console-area" aria-label="Virtual machine display">
        <div class="machine-topbar">
          <div class="display-identity">
            <img class="emustar-console-mark" id="displayModeMark" src="/assets/hyperv-icon.svg" alt="" />
            <div>
              <p class="kicker" id="displayKicker">Display</p>
              <h2 id="machineTitle">Awaiting boot media</h2>
            </div>
          </div>
          <div class="metric-row">
            <span id="uptimeMetric">00:00</span>
            <span class="host-memory-pill" id="hostMemoryMetric" hidden>Checking host memory...</span>
            <div class="android-view-switch" id="androidViewSwitch" role="group" aria-label="Android viewport mode" hidden>
              <button class="is-active" type="button" data-android-viewport-mode="device" aria-pressed="true">Device</button>
              <button type="button" data-android-viewport-mode="management" aria-pressed="false">AVD Management</button>
            </div>
            <span id="ramMetric">128 MB RAM</span>
            <button class="secondary compact-button" id="fullscreenButton" type="button">Fullscreen</button>
            <button class="secondary compact-button" id="virtualKeyboardButton" type="button" hidden>Keyboard</button>
          </div>
        </div>

        <div class="screen-shell" id="screenShell">
          <button class="screen-fullscreen-exit" id="screenFullscreenExitButton" type="button" hidden>
            Exit
          </button>
          <div id="screenContainer" class="screen-container">
            <div class="vga-text"></div>
            <canvas class="vga-canvas"></canvas>
            <pre class="qemu-terminal" id="qemuTerminal" hidden></pre>
            <div class="native-display" id="nativeDisplay" hidden></div>
            <iframe class="remote-frame" id="remoteFrame" title="Remote VM display" hidden></iframe>
            <div class="nintendo-display" id="nintendoDisplay" hidden></div>
            <div class="android-display" id="androidDisplay" hidden>
              <div class="android-device" id="androidDevice" data-era="modern">
                <div class="android-status-bar">
                  <span id="androidClock">9:41</span>
                  <span class="android-status-icons" aria-label="Wi-Fi and battery status">
                    <span class="android-signal" aria-hidden="true"></span>
                    <span class="android-wifi" aria-hidden="true"></span>
                    <span class="android-battery" aria-hidden="true"></span>
                  </span>
                </div>
                <main class="android-surface" id="androidSurface" tabindex="-1"></main>
                <nav class="android-navigation" aria-label="Android system navigation">
                  <button id="androidBackButton" type="button" aria-label="Back" title="Back">
                    <span class="android-back-shape" aria-hidden="true"></span>
                  </button>
                  <button id="androidHomeButton" type="button" aria-label="Home" title="Home">
                    <span class="android-home-shape" aria-hidden="true"></span>
                  </button>
                  <button id="androidRecentsButton" type="button" aria-label="Recent apps" title="Recent apps">
                    <span class="android-recents-shape" aria-hidden="true"></span>
                  </button>
                </nav>
              </div>
            </div>
            <div class="screen-placeholder" id="screenPlaceholder">
              <img class="screen-mode-icon" id="screenModeIcon" src="/assets/hyperv-icon.svg" alt="" hidden />
              <span class="orbital" id="screenOrbital"></span>
              <strong id="placeholderTitle">Drop an ISO to begin</strong>
              <small id="placeholderMeta">Legacy x86, 32-bit Linux, DOS, hobby OS, and vintage Windows images work best.</small>
            </div>
          </div>
          <section class="virtual-keyboard" id="virtualKeyboard" aria-label="Virtual keyboard" hidden>
            <div class="virtual-keyboard-head">
              <strong>Virtual keyboard</strong>
              <button class="secondary compact-button" id="virtualKeyboardClose" type="button">Close</button>
            </div>
            <div class="virtual-keyboard-send">
              <input id="virtualKeyboardText" type="text" placeholder="Type here, then send" autocomplete="off" />
              <button class="primary compact-button" id="virtualKeyboardSend" type="button">Send</button>
            </div>
            <div class="virtual-keyboard-keys" id="virtualKeyboardKeys"></div>
          </section>
        </div>

        <div class="terminal-panel">
          <div class="terminal-header">
            <span id="activityLabel">Activity</span>
            <button id="clearLogButton" type="button">Clear</button>
          </div>
          <pre id="logOutput" aria-live="polite"></pre>
        </div>
      </section>
    </section>
    <footer class="commit-id">Commit ${COMMIT_ID} <span>RoBird Studios 2026</span> <a href="https://github.com/robird50/NebulaVM">Source Code</a> <a href="#other-commits" data-commit-history-link>Other commits</a> <a href="#faq" data-faq-link>FAQ</a> <a href="#nebula-conflict" data-nebula-conflict-link>The Nebula Conflict</a> <a class="mobile-apk-link" href="/downloads/NebulaVM.apk" download>APK download</a> <a class="tiktok-footer-link" href="https://www.tiktok.com/@nebulavm" aria-label="NebulaVM on TikTok" title="NebulaVM on TikTok"><img src="/assets/tiktok-icon.png" alt="" /></a> <a class="report-problem-link" href="#report-problem" data-report-problem-link>Report a problem</a></footer>
  </main>

  <div class="display-choice-overlay popup-motion-overlay" id="emustarInfoDialog" role="dialog" aria-modal="true" aria-labelledby="emustarInfoTitle" hidden>
    <section class="display-choice-panel emustar-info-panel popup-motion-panel">
      <img class="emustar-info-icon" src="/assets/hyperv-icon.svg" alt="" />
      <h2 id="emustarInfoTitle">Hyper-V</h2>
      <div class="emustar-info-copy">
        <p>
          Hyper-V is NebulaVM's Windows virtualization runtime. It creates and controls a Generation 2 virtual machine with its own VHDX disk, Secure Boot capability, virtual TPM, ISO drive, memory, processors, and boot order.
        </p>
        <p>
          Microsoft Hyper-V performs the hardware virtualization; QEMU is not involved. NebulaVM adds the friendlier browser controls and keeps the intimidating switches behind the curtain, where intimidating switches are happiest.
        </p>
      </div>
      <div class="emustar-info-actions">
        <button class="primary" id="emustarInfoOkButton" type="button">OK</button>
      </div>
    </section>
  </div>

  <div class="display-choice-overlay popup-motion-overlay" id="nintendoHelpDialog" role="dialog" aria-modal="true" aria-labelledby="nintendoHelpTitle" hidden>
    <section class="display-choice-panel nintendo-help-panel popup-motion-panel" id="nintendoHelpPanel" tabindex="-1">
      <header class="nintendo-help-heading">
        <img src="/assets/nintendo-icon.webp" alt="" />
        <div>
          <p class="kicker">LEGAL HOMEBREW</p>
          <h2 id="nintendoHelpTitle">Need help finding games?</h2>
          <p>Use free homebrew, demos from the creator, or backups you legally made from games you own. NebulaVM does not provide commercial Nintendo games.</p>
        </div>
      </header>

      <div class="nintendo-help-sections">
        <section>
          <h3>Game Boy</h3>
          <p>Works with mGBA for Game Boy, Game Boy Color, and Game Boy Advance homebrew.</p>
          <ul>
            <li><a href="https://itch.io/games/free/tag-gameboy" target="_blank" rel="noreferrer">Free Game Boy homebrew on itch.io</a></li>
            <li><a href="https://itch.io/games/free/tag-gameboy-color" target="_blank" rel="noreferrer">Free Game Boy Color homebrew on itch.io</a></li>
            <li><a href="https://itch.io/games/free/tag-gameboy-advance" target="_blank" rel="noreferrer">Free Game Boy Advance homebrew on itch.io</a></li>
            <li><a href="https://itch.io/c/3268267/all-homebrew-gba-roms" target="_blank" rel="noreferrer">All Homebrew GBA ROMs collection</a></li>
          </ul>
        </section>

        <section>
          <h3>Nintendo DS</h3>
          <p>Works with melonDS for legal <code>.nds</code> homebrew.</p>
          <ul>
            <li><a href="https://www.gamebrew.org/wiki/List_of_DS_homebrew_games" target="_blank" rel="noreferrer">GameBrew DS homebrew games list</a></li>
            <li><a href="https://itch.io/c/1565877/nds-homebrew" target="_blank" rel="noreferrer">NDS Homebrew collection on itch.io</a></li>
          </ul>
        </section>

        <section>
          <h3>Super Nintendo</h3>
          <p>Works with Snes9x for legal <code>.sfc</code> and <code>.smc</code> homebrew.</p>
          <ul>
            <li><a href="https://itch.io/games/free/tag-homebrew/tag-snes-rom" target="_blank" rel="noreferrer">Free SNES ROM homebrew on itch.io</a></li>
            <li><a href="https://itch.io/c/1537684/snes-homebrew" target="_blank" rel="noreferrer">SNES Homebrew collection on itch.io</a></li>
          </ul>
        </section>
      </div>

      <p class="nintendo-help-warning">Avoid sites offering free Mario, Pokemon, Zelda, or other commercial ROMs. Those are usually unauthorized copies.</p>
      <div class="nintendo-help-actions">
        <button class="primary" id="nintendoHelpOkButton" type="button">OK</button>
      </div>
    </section>
  </div>

  <div class="display-choice-overlay popup-motion-overlay" id="nebulaConflictDialog" role="dialog" aria-modal="true" aria-labelledby="nebulaConflictTitle" hidden>
    <section class="display-choice-panel nebula-conflict-panel popup-motion-panel" id="nebulaConflictPanel" tabindex="-1">
      <img class="nebula-conflict-art" src="/assets/nebula-conflict.png" alt="NebulaVM is not connected with the unrelated Nebula astrology app" />
      <h2 id="nebulaConflictTitle">The Nebula Conflict</h2>
      <div class="nebula-conflict-copy">
        <p>
          NebulaVM and RoBird Studios are <strong>not affiliated, associated, endorsed by, or connected with</strong> the "Nebula" astrology and psychic services app in any way.
        </p>
        <p>
          This notice is provided to prevent confusion due to the similarity in names. Any reports or controversies involving the unrelated Nebula app have <strong>no connection whatsoever</strong> to NebulaVM or RoBird Studios.
        </p>
        <p>
          At NebulaVM, we believe software should be transparent and accessible. <strong>NebulaVM is completely free to use</strong>—there are no subscriptions, hidden fees, paywalls, or surprise charges.
        </p>
        <p>
          RoBird Studios has zero tolerance for deceptive or misleading business practices. We would <strong>never</strong> create, promote, endorse, or participate in scams, unauthorized charges, subscription traps, or any other dishonest practices. Our goal is to earn users' trust by being open, honest, and transparent about how NebulaVM works.
        </p>
      </div>
      <div class="nebula-conflict-actions">
        <button class="primary" id="nebulaConflictOkButton" type="button">OK</button>
      </div>
    </section>
  </div>

  <div class="display-choice-overlay popup-motion-overlay" id="faqDialog" role="dialog" aria-modal="true" aria-labelledby="faqTitle" hidden>
    <section class="display-choice-panel faq-panel popup-motion-panel" id="faqPanel" tabindex="-1">
      <header class="faq-heading">
        <p class="kicker">NEBULAVM HELP CENTER</p>
        <h2 id="faqTitle">Frequently Asked Questions</h2>
        <p>Answers about runtimes, compatibility, storage, performance, and the project.</p>
      </header>

      <div class="faq-sections">
        <section class="faq-section">
          <h3>General</h3>
          <details><summary>What is NebulaVM?</summary><p>NebulaVM is an open-source web interface for launching and controlling virtual machines and emulators. Lightweight guests can run with browser technology, while modern 64-bit systems, Hyper-V, QEMU, and Android use a configured host computer.</p></details>
          <details><summary>Is NebulaVM really free?</summary><p>Yes. NebulaVM has no subscriptions, premium plans, hidden fees, or software paywalls. You are still responsible for internet access, computer hardware, and any operating-system licenses you use.</p></details>
          <details><summary>Do I need to install anything?</summary><p>Not for lightweight browser-compatible guests or for connecting to an already configured NebulaVM host. Running Windows 11, Android, Hyper-V, or native QEMU requires the host computer to have the matching virtualization tools installed and NebulaVM Host running.</p></details>
          <details><summary>Is NebulaVM open source?</summary><p>Yes. The source code is public on GitHub under the MIT License. Use the Source Code link in the footer to inspect it.</p></details>
          <details><summary>Which operating systems can I run?</summary><p>Support depends on the selected runtime and guest architecture. Legacy x86 systems, DOS, lightweight Linux distributions, modern Windows through a native host, and installed Android system images are supported to different degrees.</p></details>
        </section>

        <section class="faq-section">
          <h3>Compatibility</h3>
          <details><summary>Does NebulaVM work on Chromebooks?</summary><p>Yes, a Chromebook can act as the browser client. Host-backed emulators still run on the connected Windows host, which must remain powered on, online, and running NebulaVM Host.</p></details>
          <details><summary>Can I use NebulaVM on Windows, macOS, or Linux?</summary><p>The web interface works in supported browsers on all three. Native host features currently depend on the runtimes available and configured on the host; Hyper-V and the current Android host are Windows-focused.</p></details>
          <details><summary>Does it work on mobile devices?</summary><p>Yes, the public mobile build provides restricted Android and Remote VM modes for modern phones and tablets. Android remains experimental and uses lower host resource limits. ISO, Hyper-V, QEMU, and AVD Management controls are unavailable on public mobile.</p></details>
          <details><summary>Which browsers are supported?</summary><p>Current Chromium-based browsers such as Chrome and Edge provide the best-tested experience. Other modern browsers may work, but fullscreen, large-file handling, keyboard capture, and streamed input can behave differently.</p></details>
        </section>

        <section class="faq-section">
          <h3>Features</h3>
          <details><summary>Can I boot my own ISO?</summary><p>Yes. Choose or drop a bootable ISO, select a compatible emulator and architecture, then launch it. Host-backed modes stage the ISO on the host before booting.</p></details>
          <details><summary>Can I install Windows?</summary><p>Yes, with a compatible Windows ISO and a host-backed 64-bit runtime such as Hyper-V or native QEMU. Windows licensing and system requirements still apply.</p></details>
          <details><summary>Does NebulaVM support Linux?</summary><p>Yes. Lightweight Linux images may run in the browser runtime, while larger or 64-bit distributions generally work better through native QEMU or another suitable host runtime.</p></details>
          <details><summary>Can I save my virtual machine?</summary><p>Persistent virtual disks and saved state are available only where the selected runtime supports them. Ending a temporary Android session deletes its private AVD, while Hyper-V and QEMU can use persistent virtual disks.</p></details>
          <details><summary>Can I upload multiple ISOs?</summary><p>You can keep up to two stored ISOs per approved browser device on the host. Only one boot image is selected for a VM session at a time.</p></details>
          <details><summary>What hardware settings can I customize?</summary><p>Available controls depend on the runtime and include processor target, processor cores, memory, storage size, video memory, boot order, networking, and Android orientation.</p></details>
          <details><summary>Does NebulaVM support 64-bit operating systems?</summary><p>Yes through compatible native or host-backed runtimes. The lightweight browser runtime has stricter architecture and memory limits and is not a replacement for native 64-bit virtualization.</p></details>
        </section>

        <section class="faq-section">
          <h3>Storage &amp; Privacy</h3>
          <details><summary>Where are my uploaded ISOs stored?</summary><p>A file selected in the browser remains local until a host-backed mode stages it. Staged and saved ISOs are stored on the configured host computer, not inside Netlify's static website.</p></details>
          <details><summary>Are my files private?</summary><p>Stored-image access is tied to the browser device that uploaded the image. NebulaVM also uses session protections, but you should not upload highly sensitive data to a host you do not own or trust.</p></details>
          <details><summary>Are saved ISOs shared with other users?</summary><p>No. Stored ISO listings are scoped to the browser device that saved them, so another user's device should not be able to view or manage your saved images.</p></details>
          <details><summary>How long are stored images kept?</summary><p>Stored ISOs expire automatically after three days to conserve host storage.</p></details>
          <details><summary>Can I delete my saved ISOs?</summary><p>Yes. Open Stored images and use the remove button beside an ISO to delete it and free its slot immediately.</p></details>
        </section>

        <section class="faq-section">
          <h3>Performance</h3>
          <details><summary>Why is my VM running slowly?</summary><p>Performance depends on host CPU load, available RAM, disk speed, network quality, guest architecture, and the selected runtime. Close unnecessary host applications, lower the guest memory or core count, and avoid assigning resources the host does not actually have available.</p></details>
          <details><summary>How much RAM should I allocate?</summary><p>Use the smallest amount the guest can run comfortably with. On an 8 GB host, 1-2 GB is a safer starting point when memory is limited; never allocate all available host RAM to the guest.</p></details>
          <details><summary>Why won't my ISO boot?</summary><p>The ISO may use the wrong CPU architecture, be non-bootable or corrupted, require a different firmware mode, or need more resources. Confirm x64 versus ARM64, choose the matching emulator, and check the Mission log for the exact failure.</p></details>
          <details><summary>Does NebulaVM use hardware acceleration?</summary><p>Host-backed runtimes can use hardware virtualization when the host and runtime support it. Browser-only emulation uses web technologies and does not provide the same acceleration or performance as native virtualization.</p></details>
        </section>

        <section class="faq-section">
          <h3>Troubleshooting</h3>
          <details><summary>My VM is stuck on a black screen. What should I do?</summary><p>Check the Mission or Android log first. Wait through an initial cold boot, confirm the host has free memory, try a lower resource setting, and restart the session. If the display never appears, end the session before launching it again.</p></details>
          <details><summary>Why won't my keyboard or mouse work?</summary><p>Click or tap inside the viewport to focus it. Make sure the VM has finished booting and that the session belongs to the current browser. Fullscreen can improve keyboard capture; mobile input remains experimental.</p></details>
          <details><summary>Why can't I connect to my host?</summary><p>The host may be asleep, offline, blocked by its firewall or network, running an old NebulaVM version, or missing the host service. Keep NebulaVM Host open and confirm that the site reports the host as reachable.</p></details>
          <details><summary>What does "Host Offline" mean?</summary><p>The website cannot currently reach the computer that runs the native emulator. The host must be powered on, connected to the internet, and running the matching NebulaVM Host service.</p></details>
        </section>

        <section class="faq-section">
          <h3>Security</h3>
          <details><summary>Is NebulaVM safe?</summary><p>NebulaVM is open source and uses isolated virtualization runtimes, but no virtualization software is risk-free. Use trusted images, keep the host updated, and avoid running unknown software with unnecessary network access.</p></details>
          <details><summary>Can a virtual machine access my real computer?</summary><p>A guest is isolated from the host by its emulator or hypervisor, but enabled networking, shared folders, clipboard features, runtime vulnerabilities, or host configuration can reduce that isolation. Do not treat a VM as a perfect security boundary.</p></details>
          <details><summary>Is my data encrypted?</summary><p>Traffic to nebulavm.online is protected by HTTPS. Encryption of staged ISOs and virtual disks at rest depends on the host computer's storage encryption; NebulaVM does not claim separate end-to-end encryption for those files.</p></details>
        </section>

        <section class="faq-section">
          <h3>Project</h3>
          <details><summary>Who created NebulaVM?</summary><p>NebulaVM is a RoBird Studios project.</p></details>
          <details><summary>How can I report a bug?</summary><p>Select Report a problem in the footer, choose the bug type, describe what happened, and include an email address so the project can follow up.</p></details>
          <details><summary>How can I contribute?</summary><p>Visit the GitHub repository through the Source Code link, review the project and license, then open an issue or submit a focused pull request.</p></details>
          <details><summary>Where can I find the source code?</summary><p>Use the yellow Source Code link in the footer to open the official robird50/NebulaVM GitHub repository.</p></details>
          <details><summary>How can I support the project?</summary><p>Test NebulaVM, submit useful bug reports, improve the code or documentation, and share the official site responsibly. Those contributions help the project stay useful and free.</p></details>
          <details class="faq-final"><summary>Why is NebulaVM free?</summary><p>NebulaVM's goal is to make virtualization accessible to everyone. The project is open source and is designed to let anyone experiment with operating systems directly from their browser without paying for the software.</p></details>
        </section>
      </div>

      <div class="faq-actions">
        <button class="primary" id="faqOkButton" type="button">OK</button>
      </div>
    </section>
  </div>

  <div class="display-choice-overlay popup-motion-overlay" id="commitHistoryDialog" role="dialog" aria-modal="true" aria-labelledby="commitHistoryTitle" hidden>
    <section class="display-choice-panel commit-history-panel popup-motion-panel" id="commitHistoryPanel" tabindex="-1">
      <header class="commit-history-heading">
        <p class="kicker">NEBULAVM TIME MACHINE</p>
        <h2 id="commitHistoryTitle">Other commits</h2>
        <p>Open a frozen historical deployment. Older versions may contain bugs or retired features.</p>
      </header>
      <label class="commit-history-search">
        <span>Find a commit</span>
        <input id="commitHistorySearch" type="search" placeholder="Search message or commit ID" autocomplete="off" />
      </label>
      <p class="commit-history-status" id="commitHistoryStatus" role="status" aria-live="polite">Loading commit history...</p>
      <div class="commit-history-list" id="commitHistoryList"></div>
      <div class="commit-history-actions">
        <a class="secondary" href="https://nebulavm.online/">Latest version</a>
        <button class="primary" id="commitHistoryCloseButton" type="button">Close</button>
      </div>
    </section>
  </div>

  <div class="display-choice-overlay popup-motion-overlay" id="problemReportDialog" role="dialog" aria-modal="true" aria-labelledby="problemReportTitle" hidden>
    <section class="display-choice-panel problem-report-panel popup-motion-panel" id="problemReportPanel" tabindex="-1">
      <div class="problem-report-heading">
        <p class="kicker">NEBULAVM SUPPORT</p>
        <h2 id="problemReportTitle">Report a problem/bug</h2>
      </div>
      <form class="problem-report-form" id="problemReportForm">
        <label>
          <span>Bug type</span>
          <select id="problemReportType" name="bugType" required>
            <option value="">Choose a bug type</option>
            <option>Startup or boot problem</option>
            <option>ISO upload or staging</option>
            <option>VM display or controls</option>
            <option>Slow or unresponsive emulator</option>
            <option>Android emulator</option>
            <option>Hyper-V</option>
            <option>QEMU emulator</option>
            <option>Mobile or tablet</option>
            <option>Stored images</option>
            <option>Other</option>
          </select>
        </label>
        <label>
          <span>Describe what's going on</span>
          <textarea id="problemReportDescription" name="description" minlength="20" maxlength="5000" rows="8" required></textarea>
          <small><span id="problemReportCharacterCount">0</span>/5000 characters; minimum 20</small>
        </label>
        <label>
          <span>Email</span>
          <input id="problemReportEmail" name="email" type="email" maxlength="254" autocomplete="email" required />
          <small>This is so we can get back to you.</small>
        </label>
        <label class="problem-report-trap" aria-hidden="true">
          <span>Website</span>
          <input id="problemReportWebsite" name="website" type="text" tabindex="-1" autocomplete="off" />
        </label>
        <p class="problem-report-feedback" id="problemReportFeedback" role="status" aria-live="polite"></p>
        <div class="problem-report-actions">
          <button class="secondary" id="problemReportBackButton" type="button">Back</button>
          <button class="primary" id="problemReportSubmitButton" type="submit">Submit</button>
        </div>
      </form>
    </section>
  </div>

  <div class="display-choice-overlay popup-motion-overlay" id="keepIsoDialog" role="dialog" aria-modal="true" aria-labelledby="keepIsoTitle" hidden>
    <section class="display-choice-panel keep-iso-panel popup-motion-panel">
      <img class="keep-iso-art" src="/assets/stored-iso-host.png" alt="" />
      <h2 id="keepIsoTitle">Keep this ISO on the host computer?</h2>
      <div class="keep-iso-copy">
        <p>
          Would you like to keep this ISO stored on the host computer? If you do, you won't have to wait for it to stage again the next time you use it.
        </p>
        <p>Please note:</p>
        <ul>
          <li>You can store up to 2 ISOs at a time.</li>
          <li>Stored ISOs are automatically deleted after 3 days to conserve host computer storage space, since ISO files can be very large.</li>
        </ul>
      </div>
      <label class="toggle-row keep-iso-remember">
        <input type="checkbox" id="keepIsoDontAsk" />
        <span>
          <strong>Don't ask again</strong>
          <small>Remember this choice for future ISO uploads.</small>
        </span>
      </label>
      <div class="keep-iso-actions">
        <button class="secondary" id="keepIsoNoButton" type="button">No</button>
        <button class="primary" id="keepIsoYesButton" type="button">Yes</button>
      </div>
    </section>
  </div>
`;

const els = {
  mobileBypassButton: document.querySelector("#mobileBypassButton"),
  mobileBypassDialog: document.querySelector("#mobileBypassDialog"),
  mobileBypassCloseButton: document.querySelector("#mobileBypassCloseButton"),
  mobilePinDots: document.querySelector("#mobilePinDots"),
  mobileKeypad: document.querySelector("#mobileKeypad"),
  mobileBypassFeedback: document.querySelector("#mobileBypassFeedback"),
  dropZone: document.querySelector("#dropZone"),
  isoInput: document.querySelector("#isoInput"),
  storedIsoInput: document.querySelector("#storedIsoInput"),
  dropTitle: document.querySelector(".drop-title"),
  isoMeta: document.querySelector("#isoMeta"),
  hostStagingProgress: document.querySelector("#hostStagingProgress"),
  hostStagingProgressFill: document.querySelector("#hostStagingProgressFill"),
  hostStagingProgressText: document.querySelector("#hostStagingProgressText"),
  hostStagingSpeed: document.querySelector("#hostStagingSpeed"),
  hostStagingEta: document.querySelector("#hostStagingEta"),
  nintendoHelpLink: document.querySelector("#nintendoHelpLink"),
  nintendoHelpDialog: document.querySelector("#nintendoHelpDialog"),
  nintendoHelpPanel: document.querySelector("#nintendoHelpPanel"),
  nintendoHelpOkButton: document.querySelector("#nintendoHelpOkButton"),
  mediaWarning: document.querySelector("#mediaWarning"),
  demoButton: document.querySelector("#demoButton"),
  emulatorMode: document.querySelector("#emulatorMode"),
  emulatorSelectButton: document.querySelector("#emulatorSelectButton"),
  emulatorSelectedIcon: document.querySelector("#emulatorSelectedIcon"),
  emulatorSelectedText: document.querySelector("#emulatorSelectedText"),
  emulatorMenu: document.querySelector("#emulatorMenu"),
  emulatorMenuOptions: [...document.querySelectorAll("[data-emulator-option]")],
  androidConfig: document.querySelector("#androidConfig"),
  androidVersion: document.querySelector("#androidVersion"),
  androidCores: document.querySelector("#androidCores"),
  androidMemory: document.querySelector("#androidMemory"),
  androidStorage: document.querySelector("#androidStorage"),
  androidOrientation: [...document.querySelectorAll('input[name="androidOrientation"]')],
  androidImageNote: document.querySelector("#androidImageNote"),
  nintendoConfig: document.querySelector("#nintendoConfig"),
  nintendoEngine: document.querySelector("#nintendoEngine"),
  nintendoCpuSlider: document.querySelector("#nintendoCpuSlider"),
  nintendoCpuValue: document.querySelector("#nintendoCpuValue"),
  nintendoRamSlider: document.querySelector("#nintendoRamSlider"),
  nintendoRamValue: document.querySelector("#nintendoRamValue"),
  nintendoVramSlider: document.querySelector("#nintendoVramSlider"),
  nintendoVramValue: document.querySelector("#nintendoVramValue"),
  experimentalWarningPill: document.querySelector("#experimentalWarningPill"),
  pcSpecControls: [...document.querySelectorAll(".pc-spec-control")],
  workspace: document.querySelector("#workspace"),
  mediaKicker: document.querySelector("#mediaKicker"),
  bootSourceTitle: document.querySelector("#bootSourceTitle"),
  emustarInfoLink: document.querySelector("#emustarInfoLink"),
  emustarInfoDialog: document.querySelector("#emustarInfoDialog"),
  emustarInfoOkButton: document.querySelector("#emustarInfoOkButton"),
  nebulaConflictLinks: [...document.querySelectorAll("[data-nebula-conflict-link]")],
  nebulaConflictDialog: document.querySelector("#nebulaConflictDialog"),
  nebulaConflictPanel: document.querySelector("#nebulaConflictPanel"),
  nebulaConflictOkButton: document.querySelector("#nebulaConflictOkButton"),
  faqLinks: [...document.querySelectorAll("[data-faq-link]")],
  faqDialog: document.querySelector("#faqDialog"),
  faqPanel: document.querySelector("#faqPanel"),
  faqOkButton: document.querySelector("#faqOkButton"),
  commitHistoryLinks: [...document.querySelectorAll("[data-commit-history-link]")],
  commitHistoryDialog: document.querySelector("#commitHistoryDialog"),
  commitHistoryPanel: document.querySelector("#commitHistoryPanel"),
  commitHistorySearch: document.querySelector("#commitHistorySearch"),
  commitHistoryStatus: document.querySelector("#commitHistoryStatus"),
  commitHistoryList: document.querySelector("#commitHistoryList"),
  commitHistoryCloseButton: document.querySelector("#commitHistoryCloseButton"),
  problemReportLinks: [...document.querySelectorAll("[data-report-problem-link]")],
  problemReportDialog: document.querySelector("#problemReportDialog"),
  problemReportPanel: document.querySelector("#problemReportPanel"),
  problemReportForm: document.querySelector("#problemReportForm"),
  problemReportType: document.querySelector("#problemReportType"),
  problemReportDescription: document.querySelector("#problemReportDescription"),
  problemReportCharacterCount: document.querySelector("#problemReportCharacterCount"),
  problemReportEmail: document.querySelector("#problemReportEmail"),
  problemReportWebsite: document.querySelector("#problemReportWebsite"),
  problemReportFeedback: document.querySelector("#problemReportFeedback"),
  problemReportBackButton: document.querySelector("#problemReportBackButton"),
  problemReportSubmitButton: document.querySelector("#problemReportSubmitButton"),
  processorMode: document.querySelector("#processorMode"),
  processorSpeed: document.querySelector("#processorSpeed"),
  processorSpeedValue: document.querySelector("#processorSpeedValue"),
  advancedOptions: document.querySelector("#advancedOptions"),
  nativePanel: document.querySelector("#nativePanel"),
  nativeRuntimeIcon: document.querySelector("#nativeRuntimeIcon"),
  nativeRuntimeName: document.querySelector("#nativeRuntimeName"),
  nativeRuntimeAttribution: document.querySelector("#nativeRuntimeAttribution"),
  emustarHostShare: document.querySelector("#emustarHostShare"),
  emustarShareUrl: document.querySelector("#emustarShareUrl"),
  emustarCopyShareButton: document.querySelector("#emustarCopyShareButton"),
  emustarShareStatus: document.querySelector("#emustarShareStatus"),
  nativeDisplayMode: document.querySelector("#nativeDisplayMode"),
  nativeIsoPath: document.querySelector("#nativeIsoPath"),
  windowsCredentialsPanel: document.querySelector("#windowsCredentialsPanel"),
  windowsCredentialsHelp: document.querySelector("#windowsCredentialsHelp"),
  windowsUsername: document.querySelector("#windowsUsername"),
  windowsPassword: document.querySelector("#windowsPassword"),
  windowsPasswordOff: document.querySelector("#windowsPasswordOff"),
  nativeCreateDisk: document.querySelector("#nativeCreateDisk"),
  nativeDiskHelp: document.querySelector("#nativeDiskHelp"),
  nativeDiskSize: document.querySelector("#nativeDiskSize"),
  nativeResetFirmwareButton: document.querySelector("#nativeResetFirmwareButton"),
  nativeConsoleButton: document.querySelector("#nativeConsoleButton"),
  nativeStatus: document.querySelector("#nativeStatus"),
  remotePanel: document.querySelector("#remotePanel"),
  remoteVmUrl: document.querySelector("#remoteVmUrl"),
  remoteStatus: document.querySelector("#remoteStatus"),
  mediaType: document.querySelector("#mediaType"),
  memorySize: document.querySelector("#memorySize"),
  memorySlider: document.querySelector("#memorySlider"),
  memorySliderValue: document.querySelector("#memorySliderValue"),
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
  screenFullscreenExitButton: document.querySelector("#screenFullscreenExitButton"),
  virtualKeyboardButton: document.querySelector("#virtualKeyboardButton"),
  virtualKeyboard: document.querySelector("#virtualKeyboard"),
  virtualKeyboardClose: document.querySelector("#virtualKeyboardClose"),
  virtualKeyboardText: document.querySelector("#virtualKeyboardText"),
  virtualKeyboardSend: document.querySelector("#virtualKeyboardSend"),
  virtualKeyboardKeys: document.querySelector("#virtualKeyboardKeys"),
  androidViewSwitch: document.querySelector("#androidViewSwitch"),
  androidViewModeButtons: [...document.querySelectorAll("[data-android-viewport-mode]")],
  stateInput: document.querySelector("#stateInput"),
  screenShell: document.querySelector("#screenShell"),
  screenContainer: document.querySelector("#screenContainer"),
  screenPlaceholder: document.querySelector("#screenPlaceholder"),
  qemuTerminal: document.querySelector("#qemuTerminal"),
  nativeDisplay: document.querySelector("#nativeDisplay"),
  remoteFrame: document.querySelector("#remoteFrame"),
  nintendoDisplay: document.querySelector("#nintendoDisplay"),
  androidDisplay: document.querySelector("#androidDisplay"),
  androidDevice: document.querySelector("#androidDevice"),
  androidClock: document.querySelector("#androidClock"),
  androidSurface: document.querySelector("#androidSurface"),
  androidBackButton: document.querySelector("#androidBackButton"),
  androidHomeButton: document.querySelector("#androidHomeButton"),
  androidRecentsButton: document.querySelector("#androidRecentsButton"),
  placeholderMeta: document.querySelector("#placeholderMeta"),
  placeholderTitle: document.querySelector("#placeholderTitle"),
  screenModeIcon: document.querySelector("#screenModeIcon"),
  screenOrbital: document.querySelector("#screenOrbital"),
  displayKicker: document.querySelector("#displayKicker"),
  displayModeMark: document.querySelector("#displayModeMark"),
  activityLabel: document.querySelector("#activityLabel"),
  machineTitle: document.querySelector("#machineTitle"),
  powerState: document.querySelector("#powerState"),
  storedImagesControl: document.querySelector("#storedImagesControl"),
  storedImagesButton: document.querySelector("#storedImagesButton"),
  storedImagesMenu: document.querySelector("#storedImagesMenu"),
  storedImagesCount: document.querySelector("#storedImagesCount"),
  storedIsoSlots: document.querySelector("#storedIsoSlots"),
  windowsTemplateButton: document.querySelector("#windowsTemplateButton"),
  keepIsoDialog: document.querySelector("#keepIsoDialog"),
  keepIsoDontAsk: document.querySelector("#keepIsoDontAsk"),
  keepIsoNoButton: document.querySelector("#keepIsoNoButton"),
  keepIsoYesButton: document.querySelector("#keepIsoYesButton"),
  uptimeMetric: document.querySelector("#uptimeMetric"),
  hostMemoryMetric: document.querySelector("#hostMemoryMetric"),
  ramMetric: document.querySelector("#ramMetric"),
  logOutput: document.querySelector("#logOutput"),
  clearLogButton: document.querySelector("#clearLogButton"),
};

const MEMORY_STEPS = [64, 128, 256, 512, 1024, 2048, 4096, 6144];
const BYTES_PER_MEGABYTE = 1024 * 1024;

const updateSliderTrack = (slider) => {
  const minimum = Number(slider.min) || 0;
  const maximum = Number(slider.max) || 1;
  const progress = ((Number(slider.value) - minimum) / Math.max(1, maximum - minimum)) * 100;
  slider.style.setProperty("--slider-progress", `${progress}%`);
};

const selectedProcessorSpeedGhz = () => Number(els.processorSpeed.value) || 2;
const selectedMemoryMb = () => Number(els.memorySize.value) / BYTES_PER_MEGABYTE;

const syncProcessorSpeedSlider = () => {
  const ghz = selectedProcessorSpeedGhz();
  const label = `${ghz} GHz`;
  els.processorSpeedValue.textContent = label;
  els.processorSpeed.setAttribute("aria-valuetext", label);
  updateSliderTrack(els.processorSpeed);
};

const syncMemorySliderFromSelect = () => {
  const selectedMb = selectedMemoryMb();
  const index = Math.max(0, MEMORY_STEPS.indexOf(selectedMb));
  els.memorySlider.value = String(index);
  els.memorySliderValue.textContent = `${MEMORY_STEPS[index]} MB`;
  els.memorySlider.setAttribute("aria-valuetext", `${MEMORY_STEPS[index]} MB`);
  updateSliderTrack(els.memorySlider);
};

const syncMemorySelectFromSlider = () => {
  const index = Math.max(0, Math.min(MEMORY_STEPS.length - 1, Number(els.memorySlider.value) || 0));
  const memoryMb = MEMORY_STEPS[index];
  els.memorySize.value = String(memoryMb * BYTES_PER_MEGABYTE);
  els.memorySliderValue.textContent = `${memoryMb} MB`;
  els.memorySlider.setAttribute("aria-valuetext", `${memoryMb} MB`);
  updateSliderTrack(els.memorySlider);
};

const selectedNintendoEngine = () =>
  NINTENDO_EMULATORS.find((engine) => engine.value === els.nintendoEngine.value) || NINTENDO_EMULATORS[0];
const nintendoMediaExtension = (file = state.isoFile) =>
  String(file?.name || "")
    .split(".")
    .pop()
    .toLowerCase();
const nintendoAcceptString = () => NINTENDO_ACCEPTED_EXTENSIONS.map((extension) => `.${extension}`).join(",");
const nintendoEngineSupportsFile = (engine = selectedNintendoEngine(), file = state.isoFile) => {
  const extension = nintendoMediaExtension(file);
  return Boolean(extension && engine.extensions.includes(extension));
};
const selectedNintendoCpuCores = () =>
  NINTENDO_CPU_STEPS[Math.max(0, Math.min(NINTENDO_CPU_STEPS.length - 1, Number(els.nintendoCpuSlider.value) || 0))];
const selectedNintendoRamGb = () =>
  NINTENDO_RAM_STEPS[Math.max(0, Math.min(NINTENDO_RAM_STEPS.length - 1, Number(els.nintendoRamSlider.value) || 0))];
const selectedNintendoVram = () =>
  NINTENDO_VRAM_STEPS[
    Math.max(0, Math.min(NINTENDO_VRAM_STEPS.length - 1, Number(els.nintendoVramSlider.value) || 0))
  ];

const syncNintendoSlider = (slider, output, label) => {
  output.textContent = label;
  slider.setAttribute("aria-valuetext", label);
  updateSliderTrack(slider);
};

const syncNintendoSliders = () => {
  syncNintendoSlider(els.nintendoCpuSlider, els.nintendoCpuValue, `${selectedNintendoCpuCores()} cores`);
  syncNintendoSlider(els.nintendoRamSlider, els.nintendoRamValue, `${selectedNintendoRamGb()} GB`);
  syncNintendoSlider(els.nintendoVramSlider, els.nintendoVramValue, selectedNintendoVram().label);
};

const scriptSafeJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

const nintendoPlayerDocument = ({ core, engineName, gameName, gameUrl, threads }) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html,
      body,
      #game {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: #05070b;
      }

      body {
        color: #fff7f7;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
    </style>
  </head>
  <body>
    <div id="game"></div>
    <script>
      window.EJS_player = "#game";
      window.EJS_gameName = ${scriptSafeJson(gameName)};
      window.EJS_gameUrl = ${scriptSafeJson(gameUrl)};
      window.EJS_core = ${scriptSafeJson(core)};
      window.EJS_pathtodata = "/emulatorjs/data/";
      window.EJS_biosUrl = "";
      window.EJS_startOnLoaded = true;
      window.EJS_threads = ${threads ? "true" : "false"};
      window.EJS_forceLegacyCores = false;
      window.EJS_DEBUG_XX = true;
      window.EJS_disableDatabases = true;
      window.EJS_disableAutoLang = false;
      window.EJS_language = "en-US";
      window.EJS_color = "#ef4444";
      window.EJS_backgroundColor = "#05070b";
      window.EJS_gameID = ${scriptSafeJson(`nebulavm-${engineName}-${gameName}`)};
      window.EJS_onGameStart = function () {
        parent.postMessage({ type: "nebulavm:nintendo-started", engine: ${scriptSafeJson(engineName)} }, window.location.origin);
      };
    </script>
    <script src="/emulatorjs/data/loader.js"></script>
  </body>
</html>`;

const POPUP_MOTION_MS = 720;
const popupMotionOrigins = new WeakMap();
const popupMotionPending = new WeakMap();
const prefersReducedPopupMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const popupMotionPanel = (dialog) => dialog?.querySelector(".popup-motion-panel");
const clampPopupValue = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const clearPendingPopupMotion = (dialog) => {
  popupMotionPending.get(dialog)?.();
  popupMotionPending.delete(dialog);
};

const setPopupMotionGeometry = (dialog, trigger) => {
  const panel = popupMotionPanel(dialog);
  if (!panel) return;

  const panelRect = panel.getBoundingClientRect();
  const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
  const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
  const usableTrigger = trigger instanceof Element && trigger.isConnected ? trigger : null;
  const triggerRect = usableTrigger?.getBoundingClientRect();
  const targetX = triggerRect ? triggerRect.left + triggerRect.width / 2 : viewportWidth / 2;
  const targetY = triggerRect ? triggerRect.top + triggerRect.height / 2 : viewportHeight / 2;
  const panelX = panelRect.left + panelRect.width / 2;
  const panelY = panelRect.top + panelRect.height / 2;
  const deltaX = targetX - panelX;
  const deltaY = targetY - panelY;
  const startScaleX = clampPopupValue((triggerRect?.width || 28) / Math.max(panelRect.width, 1), 0.035, 0.34);
  const startScaleY = clampPopupValue((triggerRect?.height || 28) / Math.max(panelRect.height, 1), 0.035, 0.34);
  const rotation = clampPopupValue((deltaX / viewportWidth) * 14, -8, 8);
  const skewX = clampPopupValue((-deltaY / viewportHeight) * 16, -9, 9);
  const skewY = clampPopupValue((deltaX / viewportWidth) * 16, -9, 9);

  const setStep = (name, progress) => {
    panel.style.setProperty(`--popup-dx-${name}`, `${deltaX * (1 - progress)}px`);
    panel.style.setProperty(`--popup-dy-${name}`, `${deltaY * (1 - progress)}px`);
    panel.style.setProperty(`--popup-sx-${name}`, String(startScaleX + (1 - startScaleX) * progress));
    panel.style.setProperty(`--popup-sy-${name}`, String(startScaleY + (1 - startScaleY) * progress));
    panel.style.setProperty(`--popup-rotate-${name}`, `${rotation * (1 - progress)}deg`);
    panel.style.setProperty(`--popup-skew-x-${name}`, `${skewX * (1 - progress)}deg`);
    panel.style.setProperty(`--popup-skew-y-${name}`, `${skewY * (1 - progress)}deg`);
  };

  setStep("start", 0);
  setStep("triangle", 0.2);
  setStep("one", 0.48);
  setStep("two", 0.72);
  setStep("three", 0.9);
};

const focusPopupElement = (element) => {
  if (element && typeof element.focus === "function") {
    element.focus({ preventScroll: true });
  }
};

const openPopupFrom = (dialog, trigger, focusTarget) => {
  if (!dialog) return;
  clearPendingPopupMotion(dialog);
  popupMotionOrigins.set(dialog, trigger);
  dialog.dataset.popupState = "";
  dialog.classList.remove("is-popup-opening", "is-popup-closing");
  dialog.classList.add("is-popup-preparing");
  dialog.hidden = false;

  const panel = popupMotionPanel(dialog);
  setPopupMotionGeometry(dialog, trigger);
  if (panel) void panel.offsetWidth;
  dialog.classList.remove("is-popup-preparing");
  if (!prefersReducedPopupMotion()) {
    dialog.classList.add("is-popup-opening");
  }
  focusPopupElement(focusTarget || panel);
};

const closePopupTo = (dialog, trigger = popupMotionOrigins.get(dialog)) => {
  if (!dialog || dialog.hidden || dialog.dataset.popupState === "closing") return;
  clearPendingPopupMotion(dialog);
  const panel = popupMotionPanel(dialog);

  const finish = () => {
    clearPendingPopupMotion(dialog);
    dialog.hidden = true;
    dialog.dataset.popupState = "";
    dialog.classList.remove("is-popup-opening", "is-popup-closing", "is-popup-preparing");
    focusPopupElement(trigger);
  };

  if (!panel || prefersReducedPopupMotion()) {
    finish();
    return;
  }

  setPopupMotionGeometry(dialog, trigger);
  dialog.dataset.popupState = "closing";
  dialog.classList.remove("is-popup-opening");
  void panel.offsetWidth;
  dialog.classList.add("is-popup-closing");

  let timeoutId;
  const cleanup = () => {
    window.clearTimeout(timeoutId);
  };
  timeoutId = window.setTimeout(finish, POPUP_MOTION_MS);
  popupMotionPending.set(dialog, cleanup);
};

const savedNativeDisplayMode = window.localStorage.getItem("nebulavm.emustar.display");
if (isNetlifyLauncher) {
  els.nativeDisplayMode.value = "viewport";
  window.localStorage.setItem("nebulavm.emustar.display", "viewport");
} else if (savedNativeDisplayMode === "viewport" || savedNativeDisplayMode === "external") {
  els.nativeDisplayMode.value = savedNativeDisplayMode;
}

const mobilePinState = {
  digits: "",
};

const getMobileBypassLockRemaining = () => {
  const lockUntil = Number(window.sessionStorage.getItem(MOBILE_DEV_LOCK_KEY) || 0);
  return Math.max(0, lockUntil - Date.now());
};

const renderMobilePinDots = () => {
  const dots = [...els.mobilePinDots.querySelectorAll("span")];
  dots.forEach((dot, index) => {
    dot.classList.toggle("is-filled", index < mobilePinState.digits.length);
  });
};

const resetMobilePin = () => {
  mobilePinState.digits = "";
  renderMobilePinDots();
};

const setMobileBypassFeedback = (message = "") => {
  els.mobileBypassFeedback.textContent = message;
};

const refreshMobileBypassLockMessage = () => {
  const remaining = getMobileBypassLockRemaining();
  if (!remaining) {
    setMobileBypassFeedback("");
    return false;
  }

  const seconds = Math.ceil(remaining / 1000);
  setMobileBypassFeedback(`Too many misses. Try again in ${seconds}s.`);
  return true;
};

const closeMobileBypassDialog = () => {
  closePopupTo(els.mobileBypassDialog, els.mobileBypassButton);
  resetMobilePin();
  setMobileBypassFeedback("");
};

const openMobileBypassDialog = () => {
  resetMobilePin();
  refreshMobileBypassLockMessage();
  openPopupFrom(els.mobileBypassDialog, els.mobileBypassButton, els.mobileBypassCloseButton);
};

const applyMobileDevMode = () => {
  document.documentElement.classList.add("mobile-dev-bypass");
  document.documentElement.classList.toggle("mobile-public", isPublicMobileClient);
  if (isMobileOrTabletDevice() && !state.running) {
    els.emulatorMode.value = isPublicMobileClient ? "android" : "v86";
    els.androidCores.value = "2";
    els.androidMemory.value = "0";
    els.androidStorage.value = "4";
    els.androidOrientation.forEach((option) => {
      option.checked = option.value === "portrait";
    });
    els.memorySize.value = "134217728";
    els.networking.checked = false;
    els.autostart.checked = false;
    document.querySelectorAll("details.advanced-options").forEach((details) => {
      details.open = false;
    });
  }
  syncEmulatorDropdown();
  updateBackendUi();
  updateButtons();
};

const unlockMobileDevMode = () => {
  window.sessionStorage.setItem(MOBILE_DEV_UNLOCK_KEY, "1");
  window.sessionStorage.removeItem(MOBILE_DEV_ATTEMPTS_KEY);
  window.sessionStorage.removeItem(MOBILE_DEV_LOCK_KEY);
  closeMobileBypassDialog();
  applyMobileDevMode();
  log("Mobile developer testing build unlocked for this tab.");
};

const mobileDevUnlockUrl = () =>
  isNetlifyLauncher ? "/.netlify/functions/mobile-dev-unlock" : "/api/mobile-dev-unlock";

const validateSavedMobileDevMode = async () => {
  if (window.sessionStorage.getItem(MOBILE_DEV_UNLOCK_KEY) !== "1") return;

  try {
    const response = await fetch(mobileDevUnlockUrl(), {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ validateDevice: true }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok) {
      applyMobileDevMode();
      return;
    }
  } catch {
    // The saved browser flag cannot unlock the page without backend validation.
  }

  window.sessionStorage.removeItem(MOBILE_DEV_UNLOCK_KEY);
  document.documentElement.classList.remove("mobile-dev-bypass");
};

const shakeMobilePin = () => {
  els.mobilePinDots.classList.remove("is-shaking");
  void els.mobilePinDots.offsetWidth;
  els.mobilePinDots.classList.add("is-shaking");
};

const failMobilePin = ({ message = "", remainingAttempts = null, lockRemainingMs = 0 } = {}) => {
  if (lockRemainingMs > 0) {
    window.sessionStorage.setItem(MOBILE_DEV_ATTEMPTS_KEY, "0");
    window.sessionStorage.setItem(MOBILE_DEV_LOCK_KEY, String(Date.now() + lockRemainingMs));
    setMobileBypassFeedback(message || "Locked for 5 minutes.");
    shakeMobilePin();
    resetMobilePin();
    return;
  }

  if (Number.isFinite(remainingAttempts)) {
    setMobileBypassFeedback(message || `${Math.max(0, remainingAttempts)} tries left.`);
  } else {
    const attempts = Number(window.sessionStorage.getItem(MOBILE_DEV_ATTEMPTS_KEY) || 0) + 1;
    if (attempts >= MOBILE_DEV_MAX_ATTEMPTS) {
      window.sessionStorage.setItem(MOBILE_DEV_ATTEMPTS_KEY, "0");
      window.sessionStorage.setItem(MOBILE_DEV_LOCK_KEY, String(Date.now() + MOBILE_DEV_LOCK_MS));
      setMobileBypassFeedback("Locked for 5 minutes.");
    } else {
      window.sessionStorage.setItem(MOBILE_DEV_ATTEMPTS_KEY, String(attempts));
      setMobileBypassFeedback(`${MOBILE_DEV_MAX_ATTEMPTS - attempts} tries left.`);
    }
  }
  shakeMobilePin();
  resetMobilePin();
};

const verifyMobilePin = async () => {
  if (refreshMobileBypassLockMessage()) {
    resetMobilePin();
    return;
  }

  setMobileBypassFeedback("Checking...");
  try {
    const response = await fetch(mobileDevUnlockUrl(), {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: mobilePinState.digits }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok) {
      unlockMobileDevMode();
      return;
    }

    if (response.status === 401 || response.status === 429) {
      failMobilePin({
        message: data.error || "Incorrect developer code.",
        remainingAttempts: Number(data.remainingAttempts),
        lockRemainingMs: Number(data.lockRemainingMs) || 0,
      });
      return;
    }

    setMobileBypassFeedback(data.error || "Mobile unlock service rejected the request.");
    resetMobilePin();
  } catch {
    setMobileBypassFeedback("Unlock service unavailable.");
    resetMobilePin();
  }
};

const handleMobileKeypadPress = (value) => {
  if (refreshMobileBypassLockMessage()) return;

  if (value === "clear") {
    resetMobilePin();
    setMobileBypassFeedback("");
    return;
  }

  if (value === "backspace") {
    mobilePinState.digits = mobilePinState.digits.slice(0, -1);
    renderMobilePinDots();
    setMobileBypassFeedback("");
    return;
  }

  if (!/^\d$/.test(value) || mobilePinState.digits.length >= 6) return;
  mobilePinState.digits += value;
  renderMobilePinDots();
  setMobileBypassFeedback("");
  if (mobilePinState.digits.length === 6) {
    void verifyMobilePin();
  }
};

const initMobileDevBypass = () => {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "backspace"];
  els.mobileKeypad.replaceChildren(
    ...keys.map((key) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mobile-key";
      button.dataset.mobileKey = key;
      button.textContent = key === "clear" ? "C" : key === "backspace" ? "Del" : key;
      button.setAttribute(
        "aria-label",
        key === "clear" ? "Clear code" : key === "backspace" ? "Delete last digit" : `Number ${key}`,
      );
      return button;
    }),
  );

  els.mobileBypassButton.addEventListener("click", openMobileBypassDialog);
  els.mobileBypassCloseButton.addEventListener("click", closeMobileBypassDialog);
  els.mobileBypassDialog.addEventListener("click", (event) => {
    if (event.target === els.mobileBypassDialog) {
      closeMobileBypassDialog();
    }
  });
  els.mobileKeypad.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mobile-key]");
    if (!button) return;
    handleMobileKeypadPress(button.dataset.mobileKey);
  });
  document.addEventListener("keydown", (event) => {
    if (els.mobileBypassDialog.hidden) return;
    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      handleMobileKeypadPress(event.key);
    } else if (event.key === "Backspace") {
      event.preventDefault();
      handleMobileKeypadPress("backspace");
    } else if (event.key === "Escape") {
      closeMobileBypassDialog();
    }
  });
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

const nativeQemuBridgeMessage = isNetlifyLauncher
  ? "NebulaVM is waiting for the public Windows Hyper-V host to come back online. This is a NebulaVM host issue, not a problem with your device. Refresh this page in a moment."
  : "Native runtimes need the local NebulaVM bridge. Run NebulaVM locally with npm run host, then keep this page open.";

const nativeBridgeBases = () => {
  const localBases = [
    state.nativeQemuApiBase,
    window.location.origin,
    "http://127.0.0.1:5174",
    "http://localhost:5174",
  ].filter(Boolean);
  const hostedBases = [state.nativeQemuApiBase].filter(Boolean);
  const bridgeBases = isNetlifyLauncher ? hostedBases : localBases;
  return [...new Set(bridgeBases.map((base) => base.replace(/\/$/, "")))];
};

const fetchNativeQemuJson = async (path, options) => {
  const uniqueBridgeBases = nativeBridgeBases();
  let lastError = new Error(nativeQemuBridgeMessage);

  for (const base of uniqueBridgeBases) {
    try {
      const headers = new Headers(options?.headers || {});
      if (state.nativeHostToken) {
        headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      }
      headers.set("X-NebulaVM-Device", state.nativeDeviceId);
      const response = await fetch(`${base}/api/native-qemu/${path}`, {
        cache: "no-store",
        ...options,
        headers,
      });
      const contentType = response.headers.get("content-type") || "";

      if (!contentType.toLowerCase().includes("application/json")) {
        lastError = new Error(nativeQemuBridgeMessage);
        continue;
      }

      state.nativeQemuApiBase = base;
      return { response, data: await response.json(), base };
    } catch (error) {
      lastError = error instanceof TypeError ? new Error(nativeQemuBridgeMessage) : error;
    }
  }

  throw new Error(lastError.message || nativeQemuBridgeMessage);
};

const requestHyperVJsonFromBases = async (path, options, bridgeBases) => {
  let lastError = new Error(nativeQemuBridgeMessage);

  for (const base of bridgeBases) {
    try {
      const headers = new Headers(options?.headers || {});
      if (state.nativeHostToken) {
        headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      }
      headers.set("X-NebulaVM-Device", state.nativeDeviceId);
      const response = await fetch(`${base}/api/emustar-hyperv/${path}`, {
        cache: "no-store",
        ...options,
        headers,
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        continue;
      }

      const data = await response.json();
      state.nativeQemuApiBase = base;
      return { response, data, base };
    } catch (error) {
      lastError = error instanceof TypeError ? new Error(nativeQemuBridgeMessage) : error;
    }
  }

  throw new Error(lastError.message || nativeQemuBridgeMessage);
};

const fetchHyperVJson = async (path, options) => {
  const uniqueBridgeBases = await prepareHostedHyperVBases();
  const previousBase = state.nativeQemuApiBase;

  try {
    return await requestHyperVJsonFromBases(path, options, uniqueBridgeBases);
  } catch (error) {
    if (!isNetlifyLauncher) throw error;

    state.nativeQemuApiBase = null;
    const refreshedHost = await waitForNetlifyHostRegistry();
    if (!refreshedHost?.publicUrl || refreshedHost.publicUrl === previousBase) {
      throw error;
    }
    return requestHyperVJsonFromBases(path, options, [refreshedHost.publicUrl]);
  }
};

const requestHyperVFrameFromBases = async (contentOnly, bridgeBases) => {
  let lastError = new Error(nativeQemuBridgeMessage);

  for (const base of bridgeBases) {
    try {
      const headers = new Headers();
      if (state.nativeHostToken) {
        headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      }
      const frameUrl = new URL("/api/emustar-hyperv/console-frame", base);
      if (contentOnly) frameUrl.searchParams.set("contentOnly", "1");
      const response = await fetch(frameUrl, {
        cache: "no-store",
        headers,
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
        let message = response.statusText || "Hyper-V setup console frame was unavailable.";
        if (contentType.toLowerCase().includes("application/json")) {
          try {
            const data = await response.json();
            message = data.error || message;
          } catch {
            // Keep the response status text when the error body is not usable JSON.
          }
        }
        throw new Error(message);
      }

      state.nativeQemuApiBase = base;
      return {
        blob: await response.blob(),
        width: Number(response.headers.get("X-NebulaVM-Frame-Width")) || 0,
        height: Number(response.headers.get("X-NebulaVM-Frame-Height")) || 0,
        title: decodeURIComponent(response.headers.get("X-NebulaVM-Frame-Title") || ""),
        base,
      };
    } catch (error) {
      lastError = error instanceof TypeError ? new Error(nativeQemuBridgeMessage) : error;
    }
  }

  throw new Error(lastError.message || nativeQemuBridgeMessage);
};

const fetchHyperVFrame = async (contentOnly = false) => {
  const uniqueBridgeBases = await prepareHostedHyperVBases();
  const previousBase = state.nativeQemuApiBase;

  try {
    return await requestHyperVFrameFromBases(contentOnly, uniqueBridgeBases);
  } catch (error) {
    if (!isNetlifyLauncher) throw error;

    state.nativeQemuApiBase = null;
    const refreshedHost = await waitForNetlifyHostRegistry();
    if (!refreshedHost?.publicUrl || refreshedHost.publicUrl === previousBase) {
      throw error;
    }
    return requestHyperVFrameFromBases(contentOnly, [refreshedHost.publicUrl]);
  }
};

const androidBridgeMessage = isNetlifyLauncher
  ? "The public Android host is offline or unreachable right now. This is a NebulaVM host issue, not a problem with your device. Try again in a moment."
  : "The real Android Emulator needs NebulaVM Host running locally.";

const prepareAndroidBridgeBases = async () => {
  if (isNetlifyLauncher && !state.nativeQemuApiBase) {
    await fetchNetlifyHostRegistry();
  }
  return nativeBridgeBases();
};

const updateAndroidHostMemory = (hostMemory) => {
  if (!hostMemory || !els.hostMemoryMetric) return;
  const bytesPerGigabyte = 1024 ** 3;
  const availableGb = Math.max(0, Number(hostMemory.availableBytes) || 0) / bytesPerGigabyte;
  const totalGb = Math.max(0, Number(hostMemory.totalBytes) || 0) / bytesPerGigabyte;
  const availableLabel = availableGb < 10 ? availableGb.toFixed(1) : Math.round(availableGb).toString();
  const totalLabel = Math.max(1, Math.round(totalGb));
  els.hostMemoryMetric.textContent = `${availableLabel} GB/${totalLabel} GB available on host`;
};

const requestAndroidJsonFromBases = async (path, options, bridgeBases) => {
  let lastError = new Error(androidBridgeMessage);

  for (const base of bridgeBases) {
    try {
      const headers = new Headers(options?.headers || {});
      if (state.nativeHostToken) {
        headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      }
      headers.set("X-NebulaVM-Session", state.nativeSessionId);
      if (isPublicMobileClient) {
        headers.set("X-NebulaVM-Client-Class", "public-mobile");
      }
      const response = await fetch(`${base}/api/android-emulator/${path}`, {
        cache: "no-store",
        ...options,
        headers,
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) continue;
      const data = await response.json();
      updateAndroidHostMemory(data.hostMemory);
      state.nativeQemuApiBase = base;
      return { response, data, base };
    } catch (error) {
      lastError = error instanceof TypeError ? new Error(androidBridgeMessage) : error;
    }
  }

  throw new Error(lastError.message || androidBridgeMessage);
};

const fetchAndroidJson = async (path, options) => {
  const uniqueBridgeBases = await prepareAndroidBridgeBases();
  const previousBase = state.nativeQemuApiBase;

  try {
    return await requestAndroidJsonFromBases(path, options, uniqueBridgeBases);
  } catch (error) {
    if (!isNetlifyLauncher) throw error;

    state.nativeQemuApiBase = null;
    const refreshedHost = await fetchNetlifyHostRegistry();
    if (!refreshedHost?.publicUrl || refreshedHost.publicUrl === previousBase) {
      throw error;
    }
    return requestAndroidJsonFromBases(path, options, [refreshedHost.publicUrl]);
  }
};

const fetchAndroidFrame = async () => {
  const uniqueBridgeBases = await prepareAndroidBridgeBases();
  let lastError = new Error(androidBridgeMessage);

  for (const base of uniqueBridgeBases) {
    try {
      const headers = new Headers();
      if (state.nativeHostToken) {
        headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      }
      headers.set("X-NebulaVM-Session", state.nativeSessionId);
      if (isPublicMobileClient) {
        headers.set("X-NebulaVM-Client-Class", "public-mobile");
      }
      const response = await fetch(`${base}/api/android-emulator/frame?t=${Date.now()}`, {
        cache: "no-store",
        headers,
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
        if (contentType.toLowerCase().includes("application/json")) {
          const data = await response.json();
          throw new Error(data.error || "The Android frame is not ready.");
        }
        throw new Error(response.statusText || "The Android frame is not ready.");
      }
      state.nativeQemuApiBase = base;
      return {
        blob: await response.blob(),
        width: Number(response.headers.get("X-NebulaVM-Frame-Width")) || 1080,
        height: Number(response.headers.get("X-NebulaVM-Frame-Height")) || 1920,
      };
    } catch (error) {
      lastError = error instanceof TypeError ? new Error(androidBridgeMessage) : error;
    }
  }

  throw new Error(lastError.message || androidBridgeMessage);
};

const fetchAndroidStudioJson = async (path, options) => {
  const uniqueBridgeBases = await prepareAndroidBridgeBases();
  let lastError = new Error(androidBridgeMessage);
  for (const base of uniqueBridgeBases) {
    try {
      const headers = new Headers(options?.headers || {});
      if (state.nativeHostToken) headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      headers.set("X-NebulaVM-Session", state.nativeSessionId);
      if (isPublicMobileClient) {
        headers.set("X-NebulaVM-Client-Class", "public-mobile");
      }
      const response = await fetch(`${base}/api/android-studio/${path}`, {
        cache: "no-store",
        ...options,
        headers,
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) continue;
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "Android Studio rejected the request.");
      state.nativeQemuApiBase = base;
      return { response, data, base };
    } catch (error) {
      lastError = error instanceof TypeError ? new Error(androidBridgeMessage) : error;
    }
  }
  throw new Error(lastError.message || androidBridgeMessage);
};

const fetchAndroidStudioFrame = async () => {
  const uniqueBridgeBases = await prepareAndroidBridgeBases();
  let lastError = new Error(androidBridgeMessage);
  for (const base of uniqueBridgeBases) {
    try {
      const headers = new Headers();
      if (state.nativeHostToken) headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      headers.set("X-NebulaVM-Session", state.nativeSessionId);
      if (isPublicMobileClient) {
        headers.set("X-NebulaVM-Client-Class", "public-mobile");
      }
      const response = await fetch(`${base}/api/android-studio/frame?t=${Date.now()}`, {
        cache: "no-store",
        headers,
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
        const data = contentType.toLowerCase().includes("application/json") ? await response.json() : {};
        throw new Error(data.error || "Android Studio is not ready.");
      }
      state.nativeQemuApiBase = base;
      return {
        blob: await response.blob(),
        width: Number(response.headers.get("X-NebulaVM-Frame-Width")) || 0,
        height: Number(response.headers.get("X-NebulaVM-Frame-Height")) || 0,
        title: decodeURIComponent(response.headers.get("X-NebulaVM-Frame-Title") || ""),
        avdName: decodeURIComponent(response.headers.get("X-NebulaVM-AVD-Name") || ""),
      };
    } catch (error) {
      lastError = error instanceof TypeError ? new Error(androidBridgeMessage) : error;
    }
  }
  throw new Error(lastError.message || androidBridgeMessage);
};

const screenVisualViewportSize = () => {
  const visual = window.visualViewport;
  return {
    width: Math.max(
      320,
      Math.round(visual?.width || window.innerWidth || document.documentElement.clientWidth || 0),
    ),
    height: Math.max(
      320,
      Math.round(visual?.height || window.innerHeight || document.documentElement.clientHeight || 0),
    ),
  };
};

const setScreenVisualViewportSize = () => {
  const { width, height } = screenVisualViewportSize();
  document.documentElement.style.setProperty("--screen-visual-width", `${width}px`);
  document.documentElement.style.setProperty("--screen-visual-height", `${height}px`);
};

const viewportDesktopSize = () => {
  if (isScreenFullscreen()) {
    const { width, height } = screenVisualViewportSize();
    return {
      width: width - (width % 2),
      height: height - (height % 2),
    };
  }

  const rect = (els.nativeDisplay.hidden ? els.screenContainer : els.nativeDisplay).getBoundingClientRect();
  const width = Math.max(640, Math.min(7680, Math.round(rect.width)));
  const height = Math.max(360, Math.min(4320, Math.round(rect.height)));
  return {
    width: width - (width % 2),
    height: height - (height % 2),
  };
};

const requestRfbDesktopResize = () => {
  const rfb = state.nativeRfb;
  if (!rfb) return;

  configureRfbFor60Fps(rfb);
  const refresh = () => {
    if (state.nativeRfb !== rfb) return;
    rfb._updateClip?.();
    rfb._updateScale?.();
    rfb._requestRemoteResize?.();
  };

  window.requestAnimationFrame(refresh);
  window.setTimeout(refresh, 120);
  window.setTimeout(refresh, 350);
};

const configureRfbFor60Fps = (rfb) => {
  rfb.background = "#05070a";
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.qualityLevel = 8;
  rfb.compressionLevel = 1;
};

const requestGuestDesktopResize = (reason = "viewport") => {
  requestRfbDesktopResize();

  if (
    els.emulatorMode.value !== "emustar-hyperv" ||
    state.nativeRuntimeName !== "Hyper-V" ||
    !state.running ||
    state.hyperVConsoleActive ||
    state.windowsTemplateSelected
  ) {
    return;
  }

  window.clearTimeout(state.guestResizeTimer);
  state.guestResizeTimer = window.setTimeout(async () => {
    if (state.hyperVConsoleActive || !state.running) return;
    const { width, height } = viewportDesktopSize();
    const resizeKey = `${width}x${height}`;
    if (state.lastGuestResize === resizeKey) return;
    state.lastGuestResize = resizeKey;

    try {
      const { response, data } = await fetchHyperVJson("resize-display", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width, height }),
      });
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "The guest rejected the display resize.");
      }
      if (data.accepted) {
        log(`Extended Hyper-V desktop to ${data.width}x${data.height} for ${reason}.`);
      } else {
        log("Asked the guest to extend its desktop; if it refuses, NebulaVM will keep the image contained without stretching.");
      }
    } catch (error) {
      if (!/timed out/i.test(error.message || "")) {
        log(`Guest display resize unavailable: ${error.message}`);
      }
    }
  }, 350);
};

const prepareHostedHyperVBases = async () => {
  if (isNetlifyLauncher && !state.nativeQemuApiBase) {
    await waitForNetlifyHostRegistry();
  }
  return nativeBridgeBases();
};

const fetchEmustarHostJson = async (path, options) => {
  const uniqueBridgeBases = await prepareHostedHyperVBases();
  const previousBase = state.nativeQemuApiBase;
  let lastError = new Error(nativeQemuBridgeMessage);

  for (const base of uniqueBridgeBases) {
    try {
      const headers = new Headers(options?.headers || {});
      if (state.nativeHostToken) {
        headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      }
      headers.set("X-NebulaVM-Device", state.nativeDeviceId);
      const response = await fetch(`${base}/api/emustar-host/${path}`, {
        cache: "no-store",
        ...options,
        headers,
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        continue;
      }

      const data = await response.json();
      state.nativeQemuApiBase = base;
      return { response, data, base };
    } catch (error) {
      lastError = error instanceof TypeError ? new Error(nativeQemuBridgeMessage) : error;
    }
  }

  if (isNetlifyLauncher) {
    state.nativeQemuApiBase = null;
    const refreshedHost = await waitForNetlifyHostRegistry();
    if (refreshedHost?.publicUrl && refreshedHost.publicUrl !== previousBase) {
      return fetchEmustarHostJson(path, options);
    }
  }

  throw new Error(lastError.message || nativeQemuBridgeMessage);
};

const emustarHostBaseCandidates = () => nativeBridgeBases();

const browserIsoFileKey = (file) => (file ? `${file.name}:${file.size}` : "");
const WINDOWS_TEMPLATE_SETUP_MEDIA_TYPE = "cdrom";
const WINDOWS_TEMPLATE_SETUP_BOOT_ORDER = "213";
const WINDOWS_TEMPLATE_DISK_MEDIA_TYPE = "hda";
const WINDOWS_TEMPLATE_DISK_BOOT_ORDER = "123";

const applyWindowsTemplateBootLocks = () => {
  if (!state.windowsTemplateSelected) return;
  els.mediaType.value = state.windowsTemplateDiskPath ? WINDOWS_TEMPLATE_DISK_MEDIA_TYPE : WINDOWS_TEMPLATE_SETUP_MEDIA_TYPE;
  els.bootOrder.value = state.windowsTemplateDiskPath
    ? WINDOWS_TEMPLATE_DISK_BOOT_ORDER
    : WINDOWS_TEMPLATE_SETUP_BOOT_ORDER;
};

const clearWindowsTemplateSelection = () => {
  state.windowsTemplateSelected = false;
  state.windowsTemplateDiskPath = "";
  els.windowsTemplateButton?.classList.remove("is-active");
};

const fetchWindows11Template = async () => {
  const { response, data } = await fetchEmustarHostJson("windows11-template");
  if (!response.ok || !data.ok || !data.available) {
    throw new Error(data.error || "Windows 11 Template is not available on the host.");
  }
  return data;
};

const storedIsoPromptPreference = () => {
  const value = window.localStorage.getItem(STORED_ISO_PROMPT_KEY);
  return value === "always" || value === "never" ? value : "ask";
};

const setStoredImagesMenuOpen = (open) => {
  state.storedImagesMenuOpen = open;
  els.storedImagesMenu.hidden = !open;
  els.storedImagesButton.setAttribute("aria-expanded", String(open));
  els.storedImagesButton.classList.toggle("is-open", open);
  if (open) {
    void refreshStoredIsos();
  }
};

const formatStoredIsoExpiry = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Expires soon";
  return `Expires ${new Intl.DateTimeFormat([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)}`;
};

const renderStoredIsoSlots = () => {
  els.storedImagesCount.textContent = `${state.storedIsos.length} / ${state.storedIsoLimit} used`;
  els.storedIsoSlots.replaceChildren();

  for (let index = 0; index < state.storedIsoLimit; index += 1) {
    const item = state.storedIsos[index];
    const slot = document.createElement("div");
    slot.className = `stored-iso-slot${item ? " has-image" : " is-empty"}`;

    if (item) {
      const useButton = document.createElement("button");
      useButton.className = "stored-iso-use";
      useButton.type = "button";
      useButton.setAttribute("role", "menuitem");

      const name = document.createElement("strong");
      name.textContent = item.name || "Stored ISO";
      const meta = document.createElement("small");
      meta.textContent = formatStoredIsoExpiry(item.expiresAt);
      useButton.append(name, meta);
      useButton.addEventListener("click", () => {
        void selectStoredIso(item);
      });

      const removeButton = document.createElement("button");
      removeButton.className = "stored-iso-remove";
      removeButton.type = "button";
      removeButton.setAttribute("aria-label", `Remove ${item.name || "stored ISO"}`);
      removeButton.textContent = "X";
      removeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        void removeStoredIso(item.id);
      });

      slot.append(useButton, removeButton);
    } else {
      const addButton = document.createElement("button");
      addButton.className = "stored-iso-add";
      addButton.type = "button";
      addButton.setAttribute("role", "menuitem");
      addButton.disabled = state.storedIsoUploading;
      addButton.innerHTML = `<span aria-hidden="true">+</span><strong>Store ISO</strong><small>Slot ${index + 1}</small>`;
      addButton.addEventListener("click", () => {
        els.storedIsoInput.value = "";
        els.storedIsoInput.click();
      });
      slot.append(addButton);
    }

    els.storedIsoSlots.append(slot);
  }
};

const refreshStoredIsos = async ({ silent = false } = {}) => {
  try {
    const { response, data } = await fetchEmustarHostJson("stored-isos");
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Stored ISO list is unavailable.");
    }
    state.storedIsos = data.items || [];
    state.storedIsoLimit = Number(data.limit) || STORED_ISO_LIMIT;
    renderStoredIsoSlots();
    return state.storedIsos;
  } catch (error) {
    state.storedIsos = [];
    renderStoredIsoSlots();
    if (!silent) log(`Stored images unavailable: ${error.message}`);
    return [];
  }
};

const findStoredIsoForFile = async (file) => {
  if (!file) return null;
  const items = await refreshStoredIsos({ silent: true });
  const fileKey = browserIsoFileKey(file);
  return items.find((item) => item.fileKey === fileKey || (item.name === file.name && Number(item.size) === file.size)) || null;
};

const resetHostStagedIsoStateOnly = () => {
  state.hostStagedIsoBase = "";
  state.hostStagedIsoFileKey = "";
  state.hostStagedIsoPath = "";
  state.hostStagedIsoSessionId = "";
  state.hostStagedIsoUploadPromise = null;
  state.hostStagedIsoUploading = false;
};

const selectStoredIso = async (item, { silent = false } = {}) => {
  if (!item?.isoPath) return "";
  await cleanupStagedHostIso({ silent: true });
  resetHostStagedIsoStateOnly();
  clearWindowsTemplateSelection();
  state.isoFile = null;
  els.nativeIsoPath.value = item.isoPath;
  els.isoMeta.textContent = `${item.name || "Stored ISO"} stored on host - ${formatBytes(item.size || 0)}`;
  els.machineTitle.textContent = item.name || "Stored ISO";
  els.dropZone.classList.add("has-file");
  updateButtons();
  if (!silent) log(`Using stored ISO: ${item.name || item.isoPath}`);
  setStoredImagesMenuOpen(false);
  return item.isoPath;
};

const selectWindows11Template = async ({ boot = false } = {}) => {
  if (isMobileOrTabletDevice()) {
    log("Windows 11 Template is available on desktop and laptop browsers only.");
    return;
  }
  if (state.emulator) {
    log("End the current session before launching the Windows 11 Template.");
    return;
  }

  state.windowsTemplateLoading = true;
  updateButtons();
  try {
    const template = await fetchWindows11Template();
    await cleanupStagedHostIso({ silent: true });
    resetHostStagedIsoStateOnly();
    state.isoFile = null;
    state.windowsTemplateSelected = true;
    state.windowsTemplateDiskPath = template.diskPath || "";
    els.emulatorMode.value = "emustar-hyperv";
    els.processorMode.value = "x64";
    els.nativeIsoPath.value = template.isoPath;
    els.windowsPasswordOff.checked = true;
    els.windowsPassword.value = "";
    applyWindowsTemplateBootLocks();
    updateBackendUi();
    state.windowsTemplateSelected = true;
    applyWindowsTemplateBootLocks();
    els.isoMeta.textContent = `${template.name || "Windows 11 Template"} on host - ${formatBytes(template.size || 0)}`;
    els.machineTitle.textContent = template.name || "Windows 11 Template";
    els.dropZone.classList.add("has-file");
    els.windowsTemplateButton.classList.add("is-active");
    setStoredImagesMenuOpen(false);
    log(
      template.diskPath
        ? `Using prepared Windows 11 Template disk: ${template.diskPath}`
        : `Using Windows 11 Template setup ISO: ${template.isoPath}`,
    );
    updateButtons();
    if (boot) {
      await bootEmulator();
    }
  } catch (error) {
    clearWindowsTemplateSelection();
    log(`Windows 11 Template unavailable: ${error.message}`);
  } finally {
    state.windowsTemplateLoading = false;
    updateButtons();
  }
};

const removeStoredIso = async (id) => {
  if (!id) return;
  try {
    const { response, data } = await fetchEmustarHostJson("stored-isos/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Stored ISO could not be removed.");
    }
    state.storedIsos = data.items || [];
    renderStoredIsoSlots();
    log(data.removed ? "Removed stored ISO from the host." : "Stored ISO slot was already empty.");
  } catch (error) {
    log(`Stored ISO removal failed: ${error.message}`);
  }
};

const askKeepStagedIso = () =>
  new Promise((resolvePrompt) => {
    els.keepIsoDontAsk.checked = false;
    openPopupFrom(els.keepIsoDialog, els.dropZone, els.keepIsoYesButton);

    const finish = (keep) => {
      if (els.keepIsoDontAsk.checked) {
        window.localStorage.setItem(STORED_ISO_PROMPT_KEY, keep ? "always" : "never");
      }
      closePopupTo(els.keepIsoDialog, els.dropZone);
      els.keepIsoYesButton.onclick = null;
      els.keepIsoNoButton.onclick = null;
      resolvePrompt(keep);
    };

    els.keepIsoYesButton.onclick = () => finish(true);
    els.keepIsoNoButton.onclick = () => finish(false);
  });

const saveStagedIsoAsStored = async (file, stagedData) => {
  const { response, data } = await fetchEmustarHostJson("stored-isos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      isoPath: stagedData.isoPath,
      sessionId: stagedData.sessionId || state.nativeSessionId,
      name: file.name,
      size: file.size,
      fileKey: browserIsoFileKey(file),
    }),
  });
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "The host could not store this ISO.");
  }

  state.storedIsos = data.items || [];
  renderStoredIsoSlots();
  resetHostStagedIsoStateOnly();
  const item = data.item;
  if (item?.isoPath) {
    clearWindowsTemplateSelection();
    els.nativeIsoPath.value = item.isoPath;
    els.isoMeta.textContent = `${item.name || file.name} stored on host - ${formatBytes(item.size || file.size)}`;
    els.machineTitle.textContent = item.name || file.name;
    els.dropZone.classList.add("has-file");
    log(data.duplicate ? "That ISO was already stored, so NebulaVM reused the existing host copy." : "Stored ISO on the host computer.");
  }
  return item;
};

const maybeKeepStagedIsoOnHost = async (file, stagedData) => {
  const items = await refreshStoredIsos({ silent: true });
  const duplicate = items.find(
    (item) => item.fileKey === browserIsoFileKey(file) || (item.name === file.name && Number(item.size) === file.size),
  );
  if (duplicate) {
    await cleanupStagedHostIso({ silent: true });
    await selectStoredIso(duplicate, { silent: true });
    return duplicate;
  }
  if (items.length >= state.storedIsoLimit) return null;

  const preference = storedIsoPromptPreference();
  if (preference === "never") return null;

  const shouldKeep = preference === "always" ? true : await askKeepStagedIso();
  if (!shouldKeep) return null;

  return saveStagedIsoAsStored(file, stagedData);
};

const addStoredIsoFromFile = async (file) => {
  if (!file) return;

  const duplicate = await findStoredIsoForFile(file);
  if (duplicate?.isoPath) {
    await selectStoredIso(duplicate);
    return;
  }
  if (state.storedIsos.length >= state.storedIsoLimit) {
    log("Stored ISO slots are full. Remove one before adding another.");
    renderStoredIsoSlots();
    return;
  }

  state.storedIsoUploading = true;
  renderStoredIsoSlots();
  log(`Uploading ${file.name} into a stored ISO slot.`);
  const startedAt = performance.now();
  updateHostStagingProgress({ bytesUploaded: 0, totalBytes: file.size, startedAt });

  try {
    const { data, base } = await uploadBrowserIsoToHost(file, (progress = {}) => {
      const { bytesUploaded = 0, totalBytes = file.size } = progress;
      updateHostStagingProgress({ ...progress, bytesUploaded, totalBytes, startedAt });
    });
    state.hostStagedIsoBase = base;
    state.hostStagedIsoPath = data.isoPath || "";
    state.hostStagedIsoSessionId = data.sessionId || state.nativeSessionId;
    const item = await saveStagedIsoAsStored(file, data);
    if (item?.isoPath) {
      updateHostStagingProgress({
        bytesUploaded: file.size,
        totalBytes: file.size,
        startedAt,
        complete: true,
      });
      log(`Stored ${item.name || file.name} in a host ISO slot.`);
    }
  } catch (error) {
    els.isoMeta.textContent = "boi you aint uploadin shi😂😂";
    els.hostStagingSpeed.textContent = "Failed";
    els.hostStagingEta.textContent = "Upload failed";
    log(`Stored ISO upload failed: ${error.message}`);
  } finally {
    state.storedIsoUploading = false;
    renderStoredIsoSlots();
    updateButtons();
  }
};

const HOST_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const HOST_UPLOAD_MAX_ATTEMPTS = 8;
const HOST_UPLOAD_CONFIRM_ATTEMPTS = 10;
const HOST_UPLOAD_RECOVERY_ATTEMPTS = 18;

const createHostUploadId = (file) => {
  const name = String(file.name || "browser-upload.iso")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40);
  return `${file.size}-${file.lastModified || 0}-${name}`.slice(0, 80);
};

const wait = (ms) => new Promise((resolveWait) => window.setTimeout(resolveWait, ms));

const uploadBrowserIsoChunkToBase = (base, file, uploadId, start, end, onProgress) =>
  new Promise((resolveUpload, rejectUpload) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}/api/emustar-host/upload-iso-chunk`, true);
    xhr.responseType = "json";
    xhr.timeout = 5 * 60 * 1000;
    if (state.nativeHostToken) {
      xhr.setRequestHeader("Authorization", `Bearer ${state.nativeHostToken}`);
    }
    xhr.setRequestHeader("X-NebulaVM-Filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-NebulaVM-Device", state.nativeDeviceId);
    xhr.setRequestHeader("X-NebulaVM-Session", state.nativeSessionId);
    xhr.setRequestHeader("X-NebulaVM-Upload-Id", uploadId);
    xhr.setRequestHeader("X-NebulaVM-Chunk-Start", String(start));
    xhr.setRequestHeader("X-NebulaVM-Chunk-End", String(end));
    xhr.setRequestHeader("X-NebulaVM-Total-Bytes", String(file.size));

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const bytesUploaded = Math.min(file.size, start + event.loaded);
      onProgress?.({
        bytesUploaded,
        totalBytes: file.size,
        percent: Math.max(0, Math.min(100, (bytesUploaded / file.size) * 100)),
      });
    };
    xhr.onload = () => {
      const data = xhr.response || {};
      if (xhr.status < 200 || xhr.status >= 300 || !data.ok) {
        rejectUpload(new Error(data.error || data.message || `Host upload failed with HTTP ${xhr.status}.`));
        return;
      }
      resolveUpload(data);
    };
    xhr.onerror = () => rejectUpload(new Error(nativeQemuBridgeMessage));
    xhr.ontimeout = () => rejectUpload(new Error("The host upload paused because the connection timed out."));
    xhr.onabort = () => rejectUpload(new Error("Browser ISO upload was canceled."));
    xhr.send(file.slice(start, end));
  });

const fetchBrowserIsoUploadStatus = async (base, file, uploadId) => {
  const response = await fetch(`${base}/api/emustar-host/upload-iso-status`, {
    method: "GET",
    headers: {
      ...(state.nativeHostToken ? { Authorization: `Bearer ${state.nativeHostToken}` } : {}),
      "X-NebulaVM-Filename": encodeURIComponent(file.name),
      "X-NebulaVM-Device": state.nativeDeviceId,
      "X-NebulaVM-Session": state.nativeSessionId,
      "X-NebulaVM-Upload-Id": uploadId,
      "X-NebulaVM-Total-Bytes": String(file.size),
    },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.message || `Host upload status failed with HTTP ${response.status}.`);
  }
  return data;
};

const confirmBrowserIsoUpload = async (base, file, uploadId, onProgress, attempts = HOST_UPLOAD_CONFIRM_ATTEMPTS) => {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const status = await fetchBrowserIsoUploadStatus(base, file, uploadId);
      const bytesReceived = Math.min(file.size, Number(status.bytesReceived) || 0);
      onProgress?.({
        bytesUploaded: bytesReceived,
        totalBytes: file.size,
        percent: Math.max(0, Math.min(100, (bytesReceived / file.size) * 100)),
        confirming: bytesReceived >= file.size,
        resumed: bytesReceived > 0 && bytesReceived < file.size,
      });
      return status;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(Math.min(5000, 750 * attempt));
      }
    }
  }

  throw lastError || new Error("The host did not confirm the staged ISO.");
};

const uploadBrowserIsoToBase = async (base, file, uploadId, onProgress) => {
  const initialStatus = await confirmBrowserIsoUpload(base, file, uploadId, onProgress, 3);
  if (initialStatus.complete && initialStatus.isoPath) return initialStatus;

  let uploadedBytes = Math.min(file.size, Number(initialStatus.bytesReceived) || 0);
  if (uploadedBytes > 0) {
    onProgress?.({
      bytesUploaded: uploadedBytes,
      totalBytes: file.size,
      percent: Math.max(0, Math.min(100, (uploadedBytes / file.size) * 100)),
      resumed: true,
    });
  }

  while (uploadedBytes < file.size) {
    const start = uploadedBytes;
    const end = Math.min(file.size, start + HOST_UPLOAD_CHUNK_BYTES);
    let lastChunkError = null;

    for (let attempt = 1; attempt <= HOST_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      try {
        const data = await uploadBrowserIsoChunkToBase(base, file, uploadId, start, end, onProgress);
        uploadedBytes = Math.max(end, Number(data.bytesReceived) || end);
        onProgress?.({
          bytesUploaded: uploadedBytes,
          totalBytes: file.size,
          percent: Math.max(0, Math.min(100, (uploadedBytes / file.size) * 100)),
        });
        if (data.complete) return data;
        lastChunkError = null;
        break;
      } catch (error) {
        lastChunkError = error;
        try {
          const status = await confirmBrowserIsoUpload(base, file, uploadId, onProgress, 1);
          if (status.complete && status.isoPath) return status;

          const confirmedBytes = Math.min(file.size, Number(status.bytesReceived) || 0);
          if (confirmedBytes > start) {
            uploadedBytes = confirmedBytes;
            lastChunkError = null;
            break;
          }
        } catch {
          // The host may be briefly unreachable while the public tunnel recovers.
        }

        if (attempt < HOST_UPLOAD_MAX_ATTEMPTS) {
          onProgress?.({
            bytesUploaded: start,
            totalBytes: file.size,
            percent: Math.max(0, Math.min(100, (start / file.size) * 100)),
            retrying: true,
          });
          await wait(Math.min(6000, 900 * attempt));
        }
      }
    }

    if (lastChunkError) {
      try {
        const recovered = await confirmBrowserIsoUpload(base, file, uploadId, onProgress);
        if (recovered.complete && recovered.isoPath) return recovered;
        const confirmedBytes = Math.min(file.size, Number(recovered.bytesReceived) || 0);
        if (confirmedBytes > start) {
          uploadedBytes = confirmedBytes;
          continue;
        }
      } catch {
        // Preserve the original chunk failure because it identifies where the transfer dropped.
      }
      throw new Error(`Host upload dropped at ${Math.floor((start / file.size) * 100)}%. ${lastChunkError.message}`);
    }
  }

  const finalStatus = await confirmBrowserIsoUpload(base, file, uploadId, onProgress);
  if (finalStatus.complete && finalStatus.isoPath) return finalStatus;
  throw new Error("Host upload finished without a final ISO path.");
};

const uploadBrowserIsoToHost = async (file, onProgress) => {
  const uploadId = createHostUploadId(file);
  let lastError = new Error(nativeQemuBridgeMessage);

  const recoveryAttempts = isNetlifyLauncher ? HOST_UPLOAD_RECOVERY_ATTEMPTS : 1;
  for (let recoveryAttempt = 0; recoveryAttempt < recoveryAttempts; recoveryAttempt += 1) {
    if (isNetlifyLauncher && recoveryAttempt > 0) {
      await wait(5000);
      await fetchNetlifyHostRegistry();
    }

    let bases = emustarHostBaseCandidates();
    if (isNetlifyLauncher && bases.length === 0) {
      await fetchNetlifyHostRegistry();
      bases = emustarHostBaseCandidates();
    }

    for (const base of bases) {
      try {
        state.hostStagedIsoBase = base;
        const data = await uploadBrowserIsoToBase(base, file, uploadId, onProgress);
        state.nativeQemuApiBase = base;
        return { data, base };
      } catch (error) {
        lastError = error instanceof TypeError ? new Error(nativeQemuBridgeMessage) : error;
      }
    }
  }
  throw new Error(lastError.message || nativeQemuBridgeMessage);
};

const resetHostStagingProgress = () => {
  els.hostStagingProgress.hidden = true;
  els.hostStagingProgressFill.style.width = "0%";
  els.hostStagingProgress.querySelector(".host-staging-track").setAttribute("aria-valuenow", "0");
  els.hostStagingProgressText.textContent = "0% - 0 B";
  els.hostStagingSpeed.textContent = "0 KB/s";
  els.hostStagingEta.textContent = "--:--:-- remaining";
  state.hostStagingEtaBaselineBytes = 0;
  state.hostStagingEtaStartedAt = 0;
  state.hostStagingEtaLastRenderedAt = 0;
};

const formatHostStagingEta = (seconds) => {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")} remaining`;
};

const updateHostStagingProgress = ({
  bytesUploaded = 0,
  totalBytes = 0,
  startedAt = performance.now(),
  complete = false,
  confirming = false,
  resumed = false,
  retrying = false,
} = {}) => {
  const now = performance.now();
  const percent = totalBytes > 0 ? Math.max(0, Math.min(100, (bytesUploaded / totalBytes) * 100)) : 0;
  if (
    bytesUploaded <= 0 ||
    resumed ||
    !state.hostStagingEtaStartedAt ||
    bytesUploaded < state.hostStagingEtaBaselineBytes
  ) {
    state.hostStagingEtaBaselineBytes = bytesUploaded;
    state.hostStagingEtaStartedAt = bytesUploaded > 0 && resumed ? now : startedAt;
  }
  const elapsedSeconds = Math.max(0.001, (now - state.hostStagingEtaStartedAt) / 1000);
  const uploadedThisAttempt = Math.max(0, bytesUploaded - state.hostStagingEtaBaselineBytes);
  const speed = complete ? 0 : uploadedThisAttempt / elapsedSeconds;
  const finalizing = !complete && totalBytes > 0 && bytesUploaded >= totalBytes;
  const remainingBytes = Math.max(0, totalBytes - bytesUploaded);
  const etaLabel =
    complete || finalizing
      ? "00:00:00 remaining"
      : speed > 1 && remainingBytes > 0
        ? formatHostStagingEta(remainingBytes / speed)
        : "--:--:-- remaining";
  const percentText = complete ? "100%" : `${Math.floor(percent)}%`;
  const uploaded = formatBytes(bytesUploaded);
  const total = totalBytes ? ` / ${formatBytes(totalBytes)}` : "";
  const progressLabel = finalizing
    ? "100% - Finalizing on host..."
    : retrying
      ? `${percentText} - Reconnecting, will resume from ${uploaded}${total}`
      : resumed
        ? `${percentText} - Resumed at ${uploaded}${total}`
        : `${percentText} - ${uploaded}${total}`;

  els.hostStagingProgress.hidden = false;
  els.hostStagingProgressFill.style.width = `${percent}%`;
  els.hostStagingProgress.querySelector(".host-staging-track").setAttribute("aria-valuenow", String(Math.round(percent)));
  els.hostStagingProgressText.textContent = progressLabel;
  els.hostStagingSpeed.textContent = complete
    ? "Complete"
    : finalizing || confirming
      ? "Verifying"
      : retrying
        ? "Retrying"
        : formatTransferSpeed(speed);
  const etaShouldRender =
    complete ||
    finalizing ||
    retrying ||
    confirming ||
    !state.hostStagingEtaLastRenderedAt ||
    now - state.hostStagingEtaLastRenderedAt >= 1000;
  if (etaShouldRender) {
    els.hostStagingEta.textContent = etaLabel;
    state.hostStagingEtaLastRenderedAt = now;
  }
};

const cleanupStagedHostIso = async ({
  keepalive = false,
  silent = false,
  preserveUploadLock = false,
  cleanupPartial = false,
} = {}) => {
  const sessionId = state.hostStagedIsoSessionId || state.nativeSessionId;
  const shouldCleanup = Boolean(state.hostStagedIsoPath || (cleanupPartial && state.hostStagedIsoSessionId));
  if (!shouldCleanup || !sessionId) return;

  const resetStagedState = () => {
    if (els.nativeIsoPath.value.trim() === state.hostStagedIsoPath) {
      els.nativeIsoPath.value = "";
    }
    state.hostStagedIsoBase = "";
    state.hostStagedIsoPath = "";
    state.hostStagedIsoSessionId = "";
    if (!preserveUploadLock) {
      state.hostStagedIsoFileKey = "";
      state.hostStagedIsoUploadPromise = null;
      state.hostStagedIsoUploading = false;
    }
    resetHostStagingProgress();
  };

  if (keepalive) {
    const base = (state.hostStagedIsoBase || state.nativeQemuApiBase || window.location.origin).replace(/\/$/, "");
    const params = new URLSearchParams({ sessionId, deviceId: state.nativeDeviceId });
    if (state.nativeHostToken) params.set("token", state.nativeHostToken);
    const url = `${base}/api/emustar-host/upload-session-cleanup?${params}`;
    if (navigator.sendBeacon?.(url)) {
      resetStagedState();
      return;
    }
    fetch(url, { method: "POST", keepalive: true }).catch(() => {});
    resetStagedState();
    return;
  }

  try {
    await fetchEmustarHostJson("upload-session-cleanup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-NebulaVM-Session": sessionId,
      },
      body: JSON.stringify({ sessionId }),
    });
    if (!silent) log("Removed browser-staged ISO from the Hyper-V host.");
  } catch (error) {
    if (!silent) log(`Could not remove browser-staged ISO: ${error.message}`);
  } finally {
    resetStagedState();
    updateButtons();
  }
};

const stageSelectedIsoForEmustar = (file = state.isoFile) => {
  if (!isHyperVMode() || !file) return els.nativeIsoPath.value.trim();

  const fileKey = browserIsoFileKey(file);
  if (state.hostStagedIsoPath && state.hostStagedIsoFileKey === fileKey) {
    els.nativeIsoPath.value = state.hostStagedIsoPath;
    updateButtons();
    return Promise.resolve(state.hostStagedIsoPath);
  }
  if (state.hostStagedIsoUploadPromise) {
    if (state.hostStagedIsoFileKey === fileKey) {
      return state.hostStagedIsoUploadPromise;
    }
    return state.hostStagedIsoUploadPromise.then(
      () => stageSelectedIsoForEmustar(file),
      () => stageSelectedIsoForEmustar(file),
    );
  }

  state.hostStagedIsoUploading = true;
  state.hostStagedIsoFileKey = fileKey;
  updateButtons();
  log(`Staging ${file.name} to the Hyper-V host for this tab.`);
  const stagingStartedAt = performance.now();
  updateHostStagingProgress({ bytesUploaded: 0, totalBytes: file.size, startedAt: stagingStartedAt });

  const uploadTask = (async () => {
    const storedIso = await findStoredIsoForFile(file);
    if (storedIso?.isoPath) {
      await selectStoredIso(storedIso);
      return storedIso.isoPath;
    }

    await cleanupStagedHostIso({ silent: true, preserveUploadLock: true });
    state.hostStagedIsoFileKey = fileKey;
    state.hostStagedIsoSessionId = state.nativeSessionId;

    const { data, base } = await uploadBrowserIsoToHost(file, (progress = {}) => {
      const { bytesUploaded = 0, totalBytes = file.size } = progress;
      const percent = totalBytes > 0 ? Math.max(0, Math.min(100, (bytesUploaded / totalBytes) * 100)) : 0;
      els.isoMeta.textContent = `Staging to host ${Math.floor(percent)}%`;
      updateHostStagingProgress({ ...progress, bytesUploaded, totalBytes, startedAt: stagingStartedAt });
    });

    state.hostStagedIsoBase = base;
    state.hostStagedIsoPath = data.isoPath || "";
    state.hostStagedIsoSessionId = data.sessionId || state.nativeSessionId;
    if (!state.hostStagedIsoPath) {
      throw new Error("The Hyper-V host did not return an ISO path.");
    }
    els.nativeIsoPath.value = state.hostStagedIsoPath;
    els.isoMeta.textContent = `${file.name} staged on host - ${formatBytes(file.size)}`;
    updateHostStagingProgress({
      bytesUploaded: file.size,
      totalBytes: file.size,
      startedAt: stagingStartedAt,
      complete: true,
    });
    log(`Staged browser ISO on the Hyper-V host: ${state.hostStagedIsoPath}`);
    const storedItem = await maybeKeepStagedIsoOnHost(file, data).catch((error) => {
      log(`Stored ISO prompt failed: ${error.message}`);
      return null;
    });
    if (storedItem?.isoPath) return storedItem.isoPath;
    return state.hostStagedIsoPath;
  })()
    .catch((error) => {
      els.isoMeta.textContent = "boi you aint uploadin shi😂😂";
      els.hostStagingSpeed.textContent = "Failed";
      els.hostStagingEta.textContent = "Upload failed";
      log(`Host staging paused: ${error.message}`);
      log("Select Launch again with the same ISO to resume from the host's saved progress.");
      throw error;
    })
    .finally(() => {
      if (state.hostStagedIsoUploadPromise === uploadTask) {
        state.hostStagedIsoUploading = false;
        state.hostStagedIsoUploadPromise = null;
        updateButtons();
      }
    });

  state.hostStagedIsoUploadPromise = uploadTask;
  return uploadTask;
};

const fetchNetlifyHostRegistry = async () => {
  if (!isNetlifyLauncher) return null;

  try {
    const response = await fetch("/.netlify/functions/host-registry", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.ok || !data.host?.publicUrl || !data.host?.accessToken) return null;

    const publicUrl = String(data.host.publicUrl).replace(/\/$/, "");
    state.nativeQemuApiBase = publicUrl;
    state.nativeHostToken = String(data.host.accessToken);
    window.sessionStorage.setItem(HOST_TOKEN_STORAGE_KEY, state.nativeHostToken);
    return { ...data.host, publicUrl, stale: data.stale };
  } catch {
    return null;
  }
};

const waitForNetlifyHostRegistry = async ({ attempts = 6, intervalMs = 750 } = {}) => {
  let host = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    host = await fetchNetlifyHostRegistry();
    if (host?.publicUrl) return host;
    await new Promise((resolveWait) => window.setTimeout(resolveWait, intervalMs));
  }
  return host;
};

const remoteConsoleUrl = (sessionId = "") => {
  const url = new URL("/remote.html", window.location.origin);
  const safeSessionId = String(sessionId || "").trim();
  if (/^[a-f0-9]{16,64}$/i.test(safeSessionId)) {
    url.hash = `session=${encodeURIComponent(safeSessionId)}`;
  }
  return url.toString();
};

const setHyperVRemoteSessionId = (sessionId = "") => {
  const safeSessionId = String(sessionId || "").trim();
  state.hyperVRemoteSessionId = safeSessionId;
  if (/^[a-f0-9]{16,64}$/i.test(safeSessionId)) {
    window.sessionStorage.setItem(HYPERV_REMOTE_SESSION_STORAGE_KEY, safeSessionId);
  } else {
    window.sessionStorage.removeItem(HYPERV_REMOTE_SESSION_STORAGE_KEY);
  }
};

const canAdoptHyperVViewport = (status) => {
  if (status.vm?.state !== "Running") return false;
  if (state.emulator || state.nativeRuntimeName === "Hyper-V") return true;

  const statusSessionId = String(status.remoteSessionId || "").trim();
  return Boolean(
    statusSessionId &&
      state.hyperVRemoteSessionId &&
      statusSessionId === state.hyperVRemoteSessionId,
  );
};

const setHostedHostWaitingStatus = () => {
  state.nativeQemuApiAvailable = false;
  state.nativeQemuReady = false;
  els.nativeStatus.dataset.mode = "missing";
  els.nativeStatus.textContent =
    "Waiting for the public Windows Hyper-V host. This is a NebulaVM host issue, not a problem with your device. Refresh this page in a moment.";
};

const connectNetlifyHostRegistry = async () => {
  const host = await fetchNetlifyHostRegistry();
  if (!host) {
    if (isHyperVMode()) {
      setHostedHostWaitingStatus();
      updateButtons();
    }
    return null;
  }

  if (isPublicMobileClient) {
    state.nativeQemuApiAvailable = true;
    state.nativeQemuReady = true;
    updateButtons();
    return host;
  }

  if (!isHyperVMode()) {
    els.emulatorMode.value = "emustar-hyperv";
    syncEmulatorDropdown();
    updateBackendUi();
  }

  state.nativeQemuApiAvailable = true;
  state.nativeQemuReady = true;
  els.nativeStatus.dataset.mode = "ready";
  els.nativeStatus.textContent = host.stale
    ? "Found a registered Windows host, but it may be stale. Choose an ISO before launching Hyper-V."
    : "Found the current Windows Hyper-V host. Choose an ISO before launching Hyper-V.";
  updateButtons();
  return host;
};

const updateEmustarHostInfo = async () => {
  const emustarMode = isEmustarEmulator(els.emulatorMode.value);
  els.emustarHostShare.hidden = !emustarMode;
  if (!emustarMode) return;

  els.emustarCopyShareButton.disabled = true;
  els.emustarShareStatus.textContent = "Checking host access...";

  if (isNetlifyLauncher) {
    const host = state.nativeQemuApiBase && state.nativeHostToken ? { publicUrl: state.nativeQemuApiBase } : await fetchNetlifyHostRegistry();
    let sessionId = "";
    if (host?.publicUrl) {
      try {
        const { data: status } = await requestHyperVJsonFromBases("status", {}, [host.publicUrl]);
        sessionId = status.remoteSessionId || "";
      } catch {
        sessionId = "";
      }
    }
    els.emustarShareUrl.value = remoteConsoleUrl(sessionId);
    els.emustarCopyShareButton.disabled = false;
    els.emustarShareStatus.textContent = host
      ? sessionId
        ? "Remote console link ready for this active Hyper-V session."
        : "Remote console link ready. Start Hyper-V to generate a session-specific link."
      : "Waiting for the Windows Hyper-V host to register.";
    return;
  }

  try {
    const { response, data: info } = await fetchEmustarHostJson("info");
    if (!response.ok || !info.ok) {
      throw new Error(info.error || "Hyper-V Host Mode is unavailable.");
    }

    const [hostShareUrl] = info.shareUrls || [];
    const shareUrl = hostShareUrl;
    els.emustarShareUrl.value = shareUrl || "";
    els.emustarCopyShareButton.disabled = !shareUrl;
    els.emustarShareStatus.textContent = shareUrl
      ? info.publicUrl
        ? "Ready from any network while this host stays online."
        : "Ready for another computer on the same network."
      : "Run npm run host to create a browser access link.";
  } catch (error) {
    els.emustarShareUrl.value = "";
    els.emustarShareStatus.textContent = error.message;
  }
};

const nativeWebSocketUrl = (base, path) => {
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (state.nativeHostToken) {
    url.searchParams.set("token", state.nativeHostToken);
  }
  return url.toString();
};

const RFB_KEYSYMS = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Space: 0x20,
};

const VIRTUAL_KEYBOARD_ROWS = [
  [
    { label: "Esc", key: "Escape", type: "special" },
    { label: "Tab", key: "Tab", type: "special" },
    { label: "Del", key: "Delete", type: "special" },
    { label: "Ctrl+Alt+Del", key: "CtrlAltDel", type: "combo", wide: true },
  ],
  [..."1234567890"].map((key) => ({ label: key, key, type: "text" })),
  [..."qwertyuiop"].map((key) => ({ label: key, key, type: "text" })),
  [..."asdfghjkl"].map((key) => ({ label: key, key, type: "text" })),
  [
    { label: "Shift", key: "Shift", type: "shift" },
    ...[..."zxcvbnm"].map((key) => ({ label: key, key, type: "text" })),
    { label: "Back", key: "Backspace", type: "special" },
  ],
  [
    { label: "Left", key: "ArrowLeft", type: "special" },
    { label: "Up", key: "ArrowUp", type: "special" },
    { label: "Down", key: "ArrowDown", type: "special" },
    { label: "Right", key: "ArrowRight", type: "special" },
    { label: "Space", key: " ", type: "text", wide: true },
    { label: "Enter", key: "Enter", type: "special", wide: true },
  ],
];

const renderVirtualKeyboard = () => {
  els.virtualKeyboardKeys.replaceChildren();
  for (const row of VIRTUAL_KEYBOARD_ROWS) {
    const rowElement = document.createElement("div");
    rowElement.className = "virtual-keyboard-row";
    for (const key of row) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.keyboardType = key.type;
      button.dataset.keyboardKey = key.key;
      button.textContent =
        key.type === "text" && key.key.length === 1 && /[a-z]/.test(key.key) && state.virtualKeyboardShift
          ? key.key.toUpperCase()
          : key.label;
      button.className = key.wide ? "is-wide" : "";
      if (key.type === "shift" && state.virtualKeyboardShift) {
        button.classList.add("is-active");
      }
      rowElement.append(button);
    }
    els.virtualKeyboardKeys.append(rowElement);
  }
};

const setVirtualKeyboardOpen = (open) => {
  state.virtualKeyboardOpen = open;
  els.virtualKeyboard.hidden = !open;
  els.virtualKeyboardButton.classList.toggle("is-active", open);
  els.virtualKeyboardButton.setAttribute("aria-expanded", String(open));
  if (open) {
    renderVirtualKeyboard();
    els.virtualKeyboardText.focus({ preventScroll: true });
  }
};

const sendRfbText = (text) => {
  const rfb = state.nativeRfb;
  if (!rfb) return false;
  for (const char of text) {
    if (char === "\n" || char === "\r") {
      rfb.sendKey(RFB_KEYSYMS.Enter, "Enter");
      continue;
    }
    const codePoint = char.codePointAt(0);
    if (codePoint >= 0x20 && codePoint <= 0x7e) {
      rfb.sendKey(codePoint, null);
    }
  }
  rfb.focus?.({ preventScroll: true });
  return true;
};

const sendRfbSpecialKey = (key) => {
  const rfb = state.nativeRfb;
  if (!rfb) return false;
  if (key === "CtrlAltDel") {
    rfb.sendCtrlAltDel();
    return true;
  }
  const keysym = RFB_KEYSYMS[key] || 0;
  if (!keysym) return false;
  rfb.sendKey(keysym, key === "Space" ? "Space" : key);
  rfb.focus?.({ preventScroll: true });
  return true;
};

const sendVirtualKeyboardText = async (text) => {
  if (!text) return;
  if (state.hyperVConsoleActive) {
    await sendHyperVConsoleInput({ type: "text", text });
    return;
  }
  if (sendRfbText(text)) return;
  log("Virtual keyboard is waiting for the Hyper-V browser display to connect.");
};

const sendVirtualKeyboardKey = async (key, { text = false } = {}) => {
  if (text) {
    await sendVirtualKeyboardText(key);
    return;
  }
  if (state.hyperVConsoleActive) {
    await sendHyperVConsoleInput({ type: "key", key });
    return;
  }
  if (sendRfbSpecialKey(key)) return;
  log("Virtual keyboard is waiting for the Hyper-V browser display to connect.");
};

const connectNativeDisplay = (base, vncPath, runtimeName, password = "") => {
  if (!vncPath) return null;

  clearNativeDisplayReconnect({ resetAttempts: false });
  state.nativeDisplayReconnectConfig = { base, vncPath, runtimeName, password };
  if (runtimeName === "Hyper-V") {
    stopHyperVSetupConsole();
  }
  state.lastGuestResize = "";
  els.nativeDisplay.hidden = false;
  const status = document.createElement("span");
  status.className = "native-display-status";
  status.textContent = `Connecting to ${runtimeName} display...`;
  els.nativeDisplay.replaceChildren(status);

  const rfb = new RFB(els.nativeDisplay, nativeWebSocketUrl(base, vncPath));
  configureRfbFor60Fps(rfb);
  rfb.viewOnly = false;
  rfb.focusOnClick = true;
  let connected = false;
  const connectTimeout = window.setTimeout(() => {
    if (connected || state.nativeRfb !== rfb || !state.emulator) return;
    state.nativeRfb = null;
    log(`${runtimeName} display connection timed out.`);
    try {
      rfb.disconnect();
    } catch {
      // The reconnect loop below is the important recovery path here.
    }
    scheduleNativeDisplayReconnect(`${runtimeName} display connection timed out`);
    updateButtons();
  }, 15000);
  rfb.addEventListener("credentialsrequired", () => {
    rfb.sendCredentials({ password });
  });
  rfb.addEventListener("connect", () => {
    connected = true;
    window.clearTimeout(connectTimeout);
    clearNativeDisplayReconnect();
    state.nativeDisplayReconnectConfig = { base, vncPath, runtimeName, password };
    status.remove();
    requestGuestDesktopResize(`${runtimeName} viewport`);
    log(`${runtimeName} display connected in browser.`);
    updateButtons();
  });
  rfb.addEventListener("disconnect", () => {
    window.clearTimeout(connectTimeout);
    const wasCurrentDisplay = state.nativeRfb === rfb;
    if (wasCurrentDisplay) {
      state.nativeRfb = null;
    }
    if (state.emulator) {
      log(`${runtimeName} display disconnected.`);
      if (wasCurrentDisplay && selectedNativeDisplayMode() === "viewport") {
        scheduleNativeDisplayReconnect(`${runtimeName} display disconnected`);
      }
    }
    updateButtons();
  });

  return rfb;
};

const closeHyperVConsole = async () => {
  try {
    await fetchHyperVJson("close-console", { method: "POST" });
  } catch {
    // Closing the host viewer is best-effort; the browser display still works without it.
  }
};

const stopHyperVSetupConsole = () => {
  state.hyperVConsoleActive = false;
  state.hyperVConsoleFastUntil = 0;
  if (state.hyperVConsoleTimer) {
    window.clearTimeout(state.hyperVConsoleTimer);
    state.hyperVConsoleTimer = null;
  }
  if (state.hyperVConsoleCleanup) {
    state.hyperVConsoleCleanup();
    state.hyperVConsoleCleanup = null;
  }
  if (state.hyperVConsoleFrameUrl) {
    URL.revokeObjectURL(state.hyperVConsoleFrameUrl);
    state.hyperVConsoleFrameUrl = null;
  }
  state.hyperVConsolePollNow = null;
  updateButtons();
};

const sendHyperVConsoleInput = async (payload) => {
  if (!state.hyperVConsoleActive) return;
  state.hyperVConsoleFastUntil = Date.now() + 2200;
  state.hyperVConsolePollNow?.(8);
  try {
    await fetchHyperVJson("console-input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.hyperVConsolePollNow?.(8);
  } catch (error) {
    log(`Hyper-V setup input failed: ${error.message}`);
  }
};

const clearNativeDisplayReconnect = ({ resetAttempts = true, clearConfig = false } = {}) => {
  if (state.nativeDisplayReconnectTimer) {
    window.clearTimeout(state.nativeDisplayReconnectTimer);
    state.nativeDisplayReconnectTimer = null;
  }
  if (resetAttempts) {
    state.nativeDisplayReconnectAttempts = 0;
  }
  if (clearConfig) {
    state.nativeDisplayReconnectConfig = null;
  }
};

const scheduleNativeDisplayReconnect = (reason = "Display disconnected") => {
  const config = state.nativeDisplayReconnectConfig;
  if (!state.emulator || !config?.vncPath || !isNativeMode()) return;
  if (state.nativeDisplayReconnectTimer) return;

  state.nativeDisplayReconnectAttempts += 1;
  const delay = Math.min(10000, 1000 + state.nativeDisplayReconnectAttempts * 1500);
  showNativeDisplayStatus(`${reason}. Reconnecting in ${Math.ceil(delay / 1000)} seconds...`);

  state.nativeDisplayReconnectTimer = window.setTimeout(() => {
    state.nativeDisplayReconnectTimer = null;
    if (!state.emulator || state.nativeRfb || !isNativeMode()) return;
    try {
      state.nativeRfb = connectNativeDisplay(
        config.base || state.nativeQemuApiBase || window.location.origin,
        config.vncPath,
        config.runtimeName || nativeRuntimeBrand(),
        config.password || "",
      );
    } catch (error) {
      log(`Display reconnect failed: ${error.message}`);
      scheduleNativeDisplayReconnect("Display reconnect failed");
    }
  }, delay);
};

const startHyperVSetupConsole = (base) => {
  stopHyperVSetupConsole();

  state.hyperVConsoleActive = true;
  state.hyperVConsoleFastUntil = Date.now() + (state.windowsTemplateSelected ? 12000 : 3000);
  state.nativeQemuApiBase = base || state.nativeQemuApiBase || window.location.origin;
  els.screenPlaceholder.hidden = true;
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = true;
  els.qemuTerminal.textContent = "";
  els.remoteFrame.hidden = true;
  els.remoteFrame.src = "about:blank";
  els.nativeDisplay.hidden = false;

  const shell = document.createElement("div");
  shell.className = "hyperv-console-bridge";
  shell.tabIndex = 0;

  const image = document.createElement("img");
  image.alt = "Hyper-V setup console";
  image.draggable = false;

  const overlay = document.createElement("div");
  overlay.className = "hyperv-console-overlay";
  overlay.textContent = "Hyper-V setup console";

  const status = document.createElement("span");
  status.className = "native-display-status";
  status.textContent = "Opening Hyper-V setup in this browser viewport...";

  shell.append(image, overlay, status);
  els.nativeDisplay.replaceChildren(shell);
  shell.focus({ preventScroll: true });

  let pointerStart = null;

  const pointerToFramePoint = (event) => {
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const frameWidth = Number(image.dataset.frameWidth) || image.naturalWidth || rect.width;
    const frameHeight = Number(image.dataset.frameHeight) || image.naturalHeight || rect.height;
    const relativeX = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
    const relativeY = Math.min(Math.max(0, event.clientY - rect.top), rect.height);
    return {
      type: "click",
      x: (relativeX / rect.width) * frameWidth,
      y: (relativeY / rect.height) * frameHeight,
      width: frameWidth,
      height: frameHeight,
      contentOnly: isScreenFullscreen(),
    };
  };

  const pointerDownHandler = (event) => {
    const point = pointerToFramePoint(event);
    if (!point) return;
    event.preventDefault();
    shell.focus({ preventScroll: true });
    image.setPointerCapture?.(event.pointerId);
    pointerStart = {
      id: event.pointerId,
      x: point.x,
      y: point.y,
      sent: true,
    };
    void sendHyperVConsoleInput(point);
  };

  const pointerUpHandler = (event) => {
    const point = pointerToFramePoint(event);
    if (!point || !pointerStart || pointerStart.id !== event.pointerId) return;
    event.preventDefault();
    image.releasePointerCapture?.(event.pointerId);
    const moved = Math.hypot(point.x - pointerStart.x, point.y - pointerStart.y);
    if (moved > 18) {
      state.hyperVConsoleFastUntil = Date.now() + 1200;
    }
    pointerStart = null;
  };

  const pointerCancelHandler = (event) => {
    if (pointerStart?.id === event.pointerId) {
      pointerStart = null;
    }
  };

  const keyHandler = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const specialKeys = new Set([
      "Enter",
      "Escape",
      "Backspace",
      "Delete",
      "Tab",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "F1",
      "F2",
      "F3",
      "F4",
      "F5",
      "F6",
      "F7",
      "F8",
      "F9",
      "F10",
      "F11",
      "F12",
    ]);

    if (event.key.length === 1) {
      event.preventDefault();
      void sendHyperVConsoleInput({ type: "text", text: event.key });
      return;
    }

    if (specialKeys.has(event.key)) {
      event.preventDefault();
      void sendHyperVConsoleInput({ type: "key", key: event.key, shiftKey: event.shiftKey });
    }
  };

  const pasteHandler = (event) => {
    const text = event.clipboardData?.getData("text") || "";
    if (!text) return;
    event.preventDefault();
    void sendHyperVConsoleInput({ type: "text", text });
  };

  image.addEventListener("pointerdown", pointerDownHandler);
  image.addEventListener("pointerup", pointerUpHandler);
  image.addEventListener("pointercancel", pointerCancelHandler);
  shell.addEventListener("keydown", keyHandler);
  shell.addEventListener("paste", pasteHandler);
  state.hyperVConsoleCleanup = () => {
    image.removeEventListener("pointerdown", pointerDownHandler);
    image.removeEventListener("pointerup", pointerUpHandler);
    image.removeEventListener("pointercancel", pointerCancelHandler);
    shell.removeEventListener("keydown", keyHandler);
    shell.removeEventListener("paste", pasteHandler);
  };

  const pollFrame = async () => {
    if (!state.hyperVConsoleActive) return;
    const frameStartedAt = performance.now();
    try {
      const frame = await fetchHyperVFrame(isScreenFullscreen());
      const nextFrameUrl = URL.createObjectURL(frame.blob);
      if (state.hyperVConsoleFrameUrl) {
        URL.revokeObjectURL(state.hyperVConsoleFrameUrl);
      }
      state.hyperVConsoleFrameUrl = nextFrameUrl;
      image.src = nextFrameUrl;
      image.dataset.frameWidth = String(frame.width || "");
      image.dataset.frameHeight = String(frame.height || "");
      if (frame.width) image.width = frame.width;
      if (frame.height) image.height = frame.height;
      status.textContent = "Use Tab, arrows, Enter, and paste text here to control setup.";
      const highFrameMode = state.windowsTemplateSelected || isScreenFullscreen();
      const nextDelay =
        Date.now() < state.hyperVConsoleFastUntil
          ? HYPERV_MIRROR_FAST_FRAME_MS
          : highFrameMode
            ? HYPERV_MIRROR_HIGH_FRAME_MS
            : HYPERV_MIRROR_IDLE_FRAME_MS;
      const elapsedMs = performance.now() - frameStartedAt;
      state.hyperVConsoleTimer = window.setTimeout(pollFrame, Math.max(0, nextDelay - elapsedMs));
    } catch (error) {
      status.textContent = `Hyper-V setup mirror waiting: ${error.message}`;
      state.hyperVConsoleTimer = window.setTimeout(pollFrame, HYPERV_MIRROR_RETRY_MS);
    }
  };
  state.hyperVConsolePollNow = (delay = 80) => {
    if (!state.hyperVConsoleActive) return;
    if (state.hyperVConsoleTimer) {
      window.clearTimeout(state.hyperVConsoleTimer);
    }
    state.hyperVConsoleTimer = window.setTimeout(pollFrame, delay);
  };

  void pollFrame();
  log("Mirroring Hyper-V setup into the requesting browser viewport.");
  updateButtons();
};

const adoptRunningHyperVViewport = async (status, base) => {
  if (!isHyperVMode() || !canAdoptHyperVViewport(status)) {
    return false;
  }

  setHyperVRemoteSessionId(status.remoteSessionId || state.hyperVRemoteSessionId);
  els.nativeDisplayMode.value = "viewport";
  window.localStorage.setItem("nebulavm.emustar.display", "viewport");
  els.screenPlaceholder.hidden = true;
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = true;
  els.qemuTerminal.textContent = "";
  els.remoteFrame.hidden = true;
  els.remoteFrame.src = "about:blank";

  state.nativeRuntimeName = "Hyper-V";
  state.nativeQemuApiBase = base;
  state.running = true;
  state.lastNativeStopLogKey = "";
  if (!state.startedAt) {
    state.startedAt = Date.now();
    clearStatsTimer();
    state.statsTimer = window.setInterval(updateUptime, 1000);
  }

  if (status.vncReady && status.vncPath && !state.nativeRfb) {
    stopHyperVSetupConsole();
    state.nativeRfb = connectNativeDisplay(base, status.vncPath, "Hyper-V", status.vncPassword || "");
    log("Attached to the running Hyper-V display in the browser viewport.");
  } else if (!status.vncReady && !state.hyperVConsoleActive) {
    startHyperVSetupConsole(base);
    log("Attached to the running Hyper-V setup mirror in the browser viewport.");
  }

  if (!state.emulator) {
    state.emulator = {
      stop: async () => {
        state.nativeRfb?.disconnect();
        await fetchHyperVJson("stop", { method: "POST" });
      },
      destroy: async () => {
        state.nativeRfb?.disconnect();
      },
    };
  }

  els.machineTitle.textContent = "Hyper-V Control Deck";
  setPowerState("Hyper-V", "running");
  updateUptime();
  updateButtons();
  void updateEmustarHostInfo();
  monitorNativeVm();
  if (status.vncReady) {
    await closeHyperVConsole();
  }
  return true;
};

const waitForHyperVStartRecovery = async (shouldStop = () => false) => {
  await wait(18000);
  let notedSlowStart = false;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (shouldStop()) return null;

    try {
      if (!notedSlowStart) {
        notedSlowStart = true;
        showNativeDisplayStatus("Hyper-V started slowly. Looking for the live display...");
        log("Hyper-V start request is taking a while, so NebulaVM is checking the host status directly.");
      }

      const { data: status, base } = await fetchHyperVJson("status");
      if (status.vm?.state === "Running") {
        return {
          response: { ok: true },
          data: {
            ok: true,
            recoveredFromSlowStart: true,
            vm: status.vm,
            remoteSessionId: status.remoteSessionId || "",
            vncReady: Boolean(status.vncReady),
            vncPath: status.vncPath || "",
            vncPassword: status.vncPassword || "",
            warnings: ["Recovered from a slow Hyper-V start response."],
          },
          base,
        };
      }
    } catch {
      // The tunnel may still be waking up; keep polling until the regular start request wins.
    }

    await wait(3000);
  }

  return null;
};

const setPowerState = (label, mode = "off") => {
  els.powerState.dataset.mode = mode;
  els.powerState.querySelector("span:last-child").textContent = label;
};

const isBrowserQemuMode = () => els.emulatorMode.value === "qemu-x64";
const isHyperVMode = () => els.emulatorMode.value === "emustar-hyperv";
const isStandaloneQemuMode = () =>
  els.emulatorMode.value === "qemu-native-x64" ||
  els.emulatorMode.value === "qemu-native-arm64-windows" ||
  els.emulatorMode.value === "qemu-native-arm64-ubuntu";
const isNativeX64Mode = () =>
  isHyperVMode() || els.emulatorMode.value === "qemu-native-x64";
const isNativeWindowsArm64Mode = () =>
  els.emulatorMode.value === "qemu-native-arm64-windows";
const isNativeUbuntuArm64Mode = () =>
  els.emulatorMode.value === "qemu-native-arm64-ubuntu";
const isNativeArm64Mode = () => isNativeWindowsArm64Mode() || isNativeUbuntuArm64Mode();
const isNativeMode = () => isNativeX64Mode() || isNativeArm64Mode();
const isRemoteMode = () => els.emulatorMode.value === "remote-vm";
const isAndroidMode = () => els.emulatorMode.value === "android";
const isNintendoMode = () => els.emulatorMode.value === "nintendo";
const isPublicMobileModeAllowed = (value = els.emulatorMode.value) =>
  value === "android" || value === "remote-vm";
const isNativeQemuMode = () => isStandaloneQemuMode();
const isQemuMode = () => isBrowserQemuMode() || isNativeQemuMode();
const isExternalMode = () => isQemuMode() || isHyperVMode() || isRemoteMode();
const shouldForceEmustarViewport = () => isNetlifyLauncher && isHyperVMode();
const selectedNativeDisplayMode = () => (shouldForceEmustarViewport() ? "viewport" : els.nativeDisplayMode.value);
const nativeArchitecture = () => (isNativeArm64Mode() ? "aarch64" : "x86_64");
const nativeProfile = () =>
  isNativeUbuntuArm64Mode() ? "ubuntu-arm64" : isNativeWindowsArm64Mode() ? "windows-arm64" : "generic-x64";
const nativeRuntimeBrand = () => (isHyperVMode() ? "Hyper-V" : "QEMU");
const nativeModeLabel = () =>
  isHyperVMode()
    ? "Hyper-V x64"
    : isNativeUbuntuArm64Mode()
    ? `${nativeRuntimeBrand()} ARM64 / Ubuntu`
    : isNativeWindowsArm64Mode()
      ? `${nativeRuntimeBrand()} ARM64 / Windows`
      : `${nativeRuntimeBrand()} x64`;
const isEmustarEmulator = (value) => value === "emustar-hyperv";
const hasEmulatorIcon = (value) =>
  value === "v86" ||
  value === "qemu-x64" ||
  value === "emustar-hyperv" ||
  value === "qemu-native-x64" ||
  value === "qemu-native-arm64-windows" ||
  value === "qemu-native-arm64-ubuntu" ||
  value === "remote-vm" ||
  value === "android" ||
  value === "nintendo";
const looksLikeArm64Iso = (path) => /(^|[^a-z0-9])(arm64|aarch64)(?=[^a-z0-9]|$)/i.test(path);
const looksLikeX64Iso = (path) => /(^|[^a-z0-9])(x64|amd64|x86_64)(?=[^a-z0-9]|$)/i.test(path);
const looksLikeUbuntuIso = (path) => /(^|[^a-z0-9])ubuntu(?=[^a-z0-9]|$)/i.test(path);
const looksLikeWindowsIso = (path) =>
  /(^|[^a-z0-9])(windows|win(?:dows)?[\s_-]*\d+|w\d+)(?=[^a-z0-9]|$)/i.test(path);
const selectedIsoDescriptor = () =>
  [els.nativeIsoPath.value.trim(), state.isoFile?.name || "", els.isoMeta.textContent || ""].join(" ");
const selectedIsoLooksLikeWindows = () => looksLikeWindowsIso(selectedIsoDescriptor());
const windowsUsernameIsValid = () => {
  const username = els.windowsUsername.value.trim();
  return Boolean(username) && username.length <= 20 && !/[\\/:;"|=,+*?<>@\[\]]/.test(username);
};

const updateWindowsCredentialUi = () => {
  const windowsIso = selectedIsoLooksLikeWindows();
  const enabled = isNativeMode() && windowsIso && !state.emulator;
  const passwordOff = els.windowsPasswordOff.checked;

  els.windowsCredentialsPanel.classList.toggle("is-disabled", !enabled);
  els.windowsUsername.disabled = !enabled;
  els.windowsPasswordOff.disabled = !enabled;
  els.windowsPassword.disabled = !enabled || passwordOff;
  els.windowsCredentialsHelp.textContent = windowsIso
    ? "These settings will be used for the Windows account Hyper-V prepares."
    : "Disabled because this media does not look like a Windows ISO.";
  if (passwordOff) {
    els.windowsPassword.value = "";
  }
};

const saveWindowsGuestCredentialsIfNeeded = async () => {
  if (!isHyperVMode() || !selectedIsoLooksLikeWindows()) return;

  const username = els.windowsUsername.value.trim();
  const passwordDisabled = els.windowsPasswordOff.checked;
  const adminPassword = passwordDisabled ? "" : els.windowsPassword.value;
  if (!windowsUsernameIsValid()) {
    throw new Error("Windows username must be 1-20 characters and cannot contain Windows account symbols.");
  }
  if (!passwordDisabled && !adminPassword) {
    throw new Error("Enter a Windows password or turn password off.");
  }

  const { response, data } = await fetchEmustarHostJson("guest-credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, adminPassword, passwordDisabled }),
  });
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "The Hyper-V host could not save Windows credentials.");
  }
  log(`Saved Windows guest account settings for ${data.username}.`);
};

const getEmulatorLabel = (value) =>
  [...els.emulatorMode.options].find((option) => option.value === value)?.textContent || value;

const setEmulatorMenuOpen = (open) => {
  els.emulatorMenu.hidden = !open;
  els.emulatorSelectButton.setAttribute("aria-expanded", String(open));
};

const syncEmulatorDropdown = () => {
  const selectedValue = els.emulatorMode.value;
  els.emulatorSelectedText.textContent = getEmulatorLabel(selectedValue);
  els.emulatorSelectedIcon.classList.toggle("emulator-menu-icon-empty", !hasEmulatorIcon(selectedValue));
  els.emulatorSelectedIcon.src =
    selectedValue === "android"
      ? "/assets/android-icon.png"
      : selectedValue === "nintendo"
        ? "/assets/nintendo-icon.webp"
      : selectedValue === "remote-vm"
      ? "/assets/remote-vm-icon.png"
      : selectedValue.startsWith("qemu-native-")
        ? "/assets/qemu-icon.png"
      : isEmustarEmulator(selectedValue)
        ? "/assets/hyperv-icon.svg"
        : "/assets/nebulavm-emulator-icon.png";

  els.emulatorMenuOptions.forEach((option) => {
    const allowedOnMobile = !isPublicMobileClient || isPublicMobileModeAllowed(option.dataset.emulatorOption);
    option.hidden = !allowedOnMobile;
    option.disabled = !allowedOnMobile;
    const selected = option.dataset.emulatorOption === selectedValue;
    option.classList.toggle("is-selected", selected);
    option.setAttribute("aria-selected", String(selected));
  });
  [...els.emulatorMode.options].forEach((option) => {
    const allowedOnMobile = !isPublicMobileClient || isPublicMobileModeAllowed(option.value);
    option.hidden = !allowedOnMobile;
    option.disabled = !allowedOnMobile;
  });
};

const syncNativeModeToIsoPath = () => {
  if (!isNativeMode()) return;
  if (isHyperVMode()) return;

  const isoPath = els.nativeIsoPath.value.trim();
  const x64Mode = "qemu-native-x64";
  const windowsArmMode = "qemu-native-arm64-windows";
  const ubuntuArmMode = "qemu-native-arm64-ubuntu";
  const nextMode = looksLikeX64Iso(isoPath)
    ? x64Mode
    : looksLikeUbuntuIso(isoPath) && looksLikeArm64Iso(isoPath)
      ? ubuntuArmMode
      : looksLikeWindowsIso(isoPath) && looksLikeArm64Iso(isoPath)
        ? windowsArmMode
        : looksLikeArm64Iso(isoPath)
          ? isNativeUbuntuArm64Mode()
            ? ubuntuArmMode
            : windowsArmMode
          : els.emulatorMode.value;

  if (nextMode !== els.emulatorMode.value) {
    els.emulatorMode.value = nextMode;
    updateBackendUi();
    log(`Switched emulator to ${nativeModeLabel()} based on the ISO path.`);
  }
};

const isSelectedMediaTooLarge = () =>
  isBrowserQemuMode() &&
  !state.browserQemuCanMountFiles &&
  state.isoFile &&
  state.isoFile.size > MAX_BROWSER_MEDIA_BYTES;

const isHostStoredMediaSelectedForBrowserMode = () =>
  !isAndroidMode() &&
  !isNintendoMode() &&
  !isNativeMode() &&
  !isRemoteMode() &&
  Boolean(els.nativeIsoPath.value.trim()) &&
  !state.isoFile;

const updateMediaWarning = () => {
  if (isAndroidMode()) {
    els.mediaWarning.hidden = true;
    els.mediaWarning.textContent = "";
    return;
  }

  if (isHostStoredMediaSelectedForBrowserMode()) {
    els.mediaWarning.hidden = false;
    els.mediaWarning.textContent =
      "This ISO is stored on the NebulaVM host, but the selected emulator runs only inside this browser. " +
      "Choose Hyper-V or QEMU large ISO, or drop the ISO file again for Nebula x86 / v86.";
    return;
  }

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
  updateMediaWarning();
  updateWindowsCredentialUi();
  applyWindowsTemplateBootLocks();
  const externalMode = isExternalMode();
  const emustarMode = isEmustarEmulator(els.emulatorMode.value);
  const androidMode = isAndroidMode();
  const nintendoMode = isNintendoMode();
  const mediaWarningBlocksBoot = !els.mediaWarning.hidden && Boolean(els.mediaWarning.textContent);
  const hasBootMedia = androidMode
    ? true
    : nintendoMode
    ? Boolean(state.isoFile)
    : emustarMode
    ? Boolean(els.nativeIsoPath.value.trim() || state.isoFile)
    : isNativeMode()
    ? Boolean(els.nativeIsoPath.value.trim())
    : isRemoteMode()
      ? Boolean(els.remoteVmUrl.value.trim())
      : Boolean(state.isoFile);
  const windowsCredentialsNeeded = emustarMode && selectedIsoLooksLikeWindows();
  const windowsCredentialsBlocked =
    windowsCredentialsNeeded &&
    (!windowsUsernameIsValid() || (!els.windowsPasswordOff.checked && !els.windowsPassword.value));
  const nativeUnavailable =
    isNativeMode() && (state.nativeQemuApiAvailable === false || state.nativeQemuReady === false);
  els.bootButton.disabled =
    !hasBootMedia ||
    Boolean(state.emulator) ||
    mediaWarningBlocksBoot ||
    nativeUnavailable ||
    windowsCredentialsBlocked ||
    state.hostStagedIsoUploading;
  els.bootButton.title = els.bootButton.disabled && mediaWarningBlocksBoot ? els.mediaWarning.textContent : "";
  els.pauseButton.disabled = busy || !state.emulator || externalMode || nintendoMode;
  els.stopButton.disabled = busy || !state.emulator;
  els.resetButton.disabled = busy || !state.emulator || externalMode || nintendoMode;
  els.saveStateButton.disabled = busy || !state.emulator || externalMode || nintendoMode;
  els.loadStateButton.disabled = externalMode || nintendoMode;
  els.nativeResetFirmwareButton.disabled =
    busy || !isNativeMode() || Boolean(state.emulator) || nativeUnavailable;
  els.nativeConsoleButton.disabled = busy || !isHyperVMode() || nativeUnavailable;
  els.windowsTemplateButton.hidden = isMobileOrTabletDevice() || !emustarMode;
  els.windowsTemplateButton.disabled =
    busy || Boolean(state.emulator) || state.hostStagedIsoUploading || state.windowsTemplateLoading;
  els.windowsTemplateButton.classList.toggle("is-active", state.windowsTemplateSelected);
  const virtualKeyboardAvailable =
    isHyperVMode() && (state.hyperVConsoleActive || Boolean(state.nativeRfb));
  els.virtualKeyboardButton.hidden = !isHyperVMode();
  els.virtualKeyboardButton.disabled = busy || !virtualKeyboardAvailable;
  if (!virtualKeyboardAvailable && state.virtualKeyboardOpen) {
    setVirtualKeyboardOpen(false);
  }
  els.bootButton.textContent = androidMode
    ? "Start Android"
    : nintendoMode
    ? "Start Nintendo"
    : emustarMode
      ? "Launch Hyper-V"
      : "Boot VM";
  els.stopButton.textContent = emustarMode
    ? "End session"
    : androidMode
    ? "Stop Android"
    : nintendoMode
      ? "Stop Nintendo"
      : "Stop";
  els.pauseButton.textContent = state.running ? "Pause" : "Resume";
  els.androidVersion.disabled = androidMode && Boolean(state.emulator);
  [els.androidCores, els.androidMemory, els.androidStorage, ...els.androidOrientation].forEach(
    (control) => {
      control.disabled = androidMode && (Boolean(state.emulator) || isPublicMobileClient);
    },
  );
  syncAndroidViewportModeButtons();
};

const updateUptime = () => {
  if (els.androidClock) {
    els.androidClock.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
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

const clearNativeMonitor = () => {
  if (state.nativeMonitorTimer) {
    window.clearInterval(state.nativeMonitorTimer);
    state.nativeMonitorTimer = null;
  }
};

const nativeExitSummary = (lastExit) => {
  if (!lastExit) return "The runtime stopped without an exit report.";
  const outputLine = String(lastExit.output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const code = Number.isInteger(lastExit.code) ? ` (exit ${lastExit.code})` : "";
  return outputLine ? `${outputLine}${code}` : `The runtime stopped${code}.`;
};

const hyperVStopSummary = (status) => {
  const event = status?.lastHyperVPowerEvent || status?.lastHyperVEvent;
  const base = status?.vm?.status && status.vm.status !== "Operating normally"
    ? `The Hyper-V machine is powered off. VM status: ${status.vm.status}.`
    : "The Hyper-V machine is powered off.";

  if (!event?.message) {
    return `${base} Windows did not report a more specific reason yet.`;
  }

  const eventLabel = event.id ? `Event ${event.id}` : "Latest Hyper-V event";
  const level = event.level ? `${event.level} ` : "";
  const message = String(event.message).replace(/\s+/g, " ").trim();
  if (event.id === 18502 && /was turned off/i.test(message)) {
    return `${base} ${level}${eventLabel}: Windows logged that the VM was turned off, but did not report a crash reason.`;
  }

  return `${base} ${level}${eventLabel}: ${message}`;
};

const monitorNativeVm = () => {
  clearNativeMonitor();
  state.nativeMonitorTimer = window.setInterval(async () => {
    if (!state.emulator || !isNativeMode()) {
      clearNativeMonitor();
      return;
    }

    try {
      const hyperVRuntime = state.nativeRuntimeName === "Hyper-V";
      const { data: status } = hyperVRuntime
        ? await fetchHyperVJson("status")
        : await fetchNativeQemuJson(`status?arch=${nativeArchitecture()}`);
      const running = hyperVRuntime ? status.vm?.state === "Running" : status.running;
      if (running) {
        state.lastNativeStopLogKey = "";
        if (
          hyperVRuntime &&
          !state.nativeRfb &&
          selectedNativeDisplayMode() === "viewport" &&
          status.vncReady
        ) {
          stopHyperVSetupConsole();
          state.nativeRfb = connectNativeDisplay(
            state.nativeQemuApiBase || window.location.origin,
            status.vncPath,
            "Hyper-V",
            status.vncPassword || "",
          );
          log("Hyper-V browser display is ready.");
          await closeHyperVConsole();
        } else if (
          hyperVRuntime &&
          !state.nativeRfb &&
          selectedNativeDisplayMode() === "viewport" &&
          !status.vncReady &&
          !state.hyperVConsoleActive
        ) {
          startHyperVSetupConsole(state.nativeQemuApiBase || window.location.origin);
        }
        return;
      }

      if (hyperVRuntime) {
        try {
          await wait(750);
          const { data: confirmStatus } = await fetchHyperVJson("status");
          if (confirmStatus.vm?.state === "Running") {
            return;
          }
        } catch {
          // A failed confirmation should not tear down an otherwise healthy session.
          return;
        }
      }

      clearNativeMonitor();
      clearNativeDisplayReconnect({ clearConfig: true });
      stopHyperVSetupConsole();
      state.nativeRfb?.disconnect();
      state.nativeRfb = null;
      state.emulator = null;
      setHyperVRemoteSessionId("");
      state.running = false;
      state.startedAt = null;
      clearStatsTimer();
      updateUptime();
      const summary = hyperVRuntime
        ? hyperVStopSummary(status)
        : nativeExitSummary(status.lastExit);
      const runtimeName = state.nativeRuntimeName || nativeRuntimeBrand();
      const stopLogKey = `${runtimeName}:${summary}`;
      showNativeDisplayStatus(`${runtimeName} stopped. ${summary}`);
      setPowerState(`${runtimeName} stopped`, "off");
      if (state.lastNativeStopLogKey !== stopLogKey) {
        log(`${runtimeName} stopped: ${summary}`);
        state.lastNativeStopLogKey = stopLogKey;
      }
      state.nativeRuntimeName = null;
      updateButtons();
    } catch {
      // A temporary status request failure should not disconnect a running VM.
    }
  }, 2000);
};

const setSelectedFile = (file) => {
  clearWindowsTemplateSelection();
  state.isoFile = file;
  els.isoMeta.textContent = `${file.name} - ${formatBytes(file.size)}`;
  els.machineTitle.textContent = file.name;
  els.dropZone.classList.add("has-file");
  if (isNintendoMode()) {
    const matchingEngines = NINTENDO_EMULATORS.filter((engine) => engine.extensions.includes(nintendoMediaExtension(file)));
    const [matchingEngine] = matchingEngines.length === 1 ? matchingEngines : [];
    if (matchingEngine && matchingEngine.value !== els.nintendoEngine.value) {
      els.nintendoEngine.value = matchingEngine.value;
      syncNintendoSliders();
      log(`Switched Nintendo core to ${matchingEngine.label} for ${matchingEngine.system}.`);
    }
  }
  log(`Selected ${isNintendoMode() ? "Nintendo media" : "boot media"}: ${file.name} (${formatBytes(file.size)}).`);
  updateMediaWarning();
  updateButtons();
  void (async () => {
    await cleanupStagedHostIso({ silent: true });
    if (isHyperVMode() && state.isoFile === file) {
      await stageSelectedIsoForEmustar(file);
    }
  })().catch(() => {});
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
  clearNativeMonitor();
  clearNativeDisplayReconnect({ clearConfig: true });
  setHyperVRemoteSessionId("");
  setVirtualKeyboardOpen(false);
  stopHyperVSetupConsole();

  if (isAndroidMode()) {
    setAndroidViewportMode("device", { force: true });
  }
  const emulator = state.emulator;
  state.emulator = null;
  updateButtons(true);

  if (emulator) {
    try {
      await emulator.stop();
      await emulator.destroy();
    } catch (error) {
      log(`Stopped with warning: ${error.message}`);
    }
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
  els.nativeDisplay.replaceChildren();
  els.nativeDisplay.hidden = true;
  state.nativeRfb = null;
  state.nativeRuntimeName = null;
  els.remoteFrame.src = "about:blank";
  els.remoteFrame.hidden = true;
  if (state.nintendoMessageHandler) {
    window.removeEventListener("message", state.nintendoMessageHandler);
    state.nintendoMessageHandler = null;
  }
  if (state.nintendoRomUrl) {
    URL.revokeObjectURL(state.nintendoRomUrl);
    state.nintendoRomUrl = "";
  }
  state.nintendoFrame = null;
  els.nintendoDisplay.replaceChildren();
  els.nintendoDisplay.hidden = true;
  els.androidDisplay.hidden = true;
  if (isAndroidMode()) {
    els.placeholderTitle.textContent = `${androidVersionLabel()} ready`;
    els.placeholderMeta.textContent = "Start Android to open the browser simulator.";
  } else if (isNintendoMode()) {
    els.placeholderTitle.textContent = "Nintendo emulator ready";
    els.placeholderMeta.textContent = `${selectedNintendoEngine().label} handles ${selectedNintendoEngine().system}. Drop legally owned media to begin.`;
  }
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
  els.ramMetric.textContent = isNintendoMode()
    ? `${selectedNintendoRamGb()} GB RAM`
    : `${selectedMemoryMb()} MB RAM`;
  setPowerState("Booting", "booting");
  state.startedAt = Date.now();
  clearStatsTimer();
  state.statsTimer = window.setInterval(updateUptime, 1000);
  updateUptime();
};

const bootNintendo = () => {
  const engine = selectedNintendoEngine();
  if (!state.isoFile) {
    throw new Error("Drop a legally owned Nintendo ROM first.");
  }
  if (!nintendoEngineSupportsFile(engine)) {
    throw new Error(`${engine.label} expects ${engine.formats}. Choose the matching Nintendo emulator for this file.`);
  }

  if (state.nintendoRomUrl) {
    URL.revokeObjectURL(state.nintendoRomUrl);
    state.nintendoRomUrl = "";
  }
  if (state.nintendoMessageHandler) {
    window.removeEventListener("message", state.nintendoMessageHandler);
    state.nintendoMessageHandler = null;
  }
  state.nintendoRunId += 1;
  const runId = state.nintendoRunId;
  const mediaName = state.isoFile.name || "Nintendo media";
  const threads = selectedNintendoCpuCores() >= 4 && window.crossOriginIsolated === true;
  const romUrl = URL.createObjectURL(state.isoFile);
  const frame = document.createElement("iframe");
  frame.className = "nintendo-player-frame";
  frame.title = `${engine.label} ${engine.system} player`;
  frame.allow = "fullscreen; gamepad";
  frame.srcdoc = nintendoPlayerDocument({
    core: engine.core,
    engineName: engine.label,
    gameName: mediaName,
    gameUrl: romUrl,
    threads,
  });
  state.nintendoRomUrl = romUrl;
  state.nintendoFrame = frame;

  els.qemuTerminal.hidden = true;
  els.nativeDisplay.hidden = true;
  els.remoteFrame.hidden = true;
  els.androidDisplay.hidden = true;
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.nintendoDisplay.replaceChildren(frame);
  els.nintendoDisplay.hidden = false;
  els.machineTitle.textContent = `${engine.label} - ${engine.system}`;
  els.ramMetric.textContent = `${selectedNintendoRamGb()} GB RAM`;
  setPowerState("Nintendo loading", "booting");
  state.running = true;
  state.emulator = {
    run() {
      state.running = true;
      setPowerState("Nintendo running", "running");
      updateButtons();
    },
    stop() {
      state.running = false;
      setPowerState("Nintendo stopped", "off");
      updateButtons();
    },
    restart() {
      bootNintendo();
    },
    async destroy() {
      if (state.nintendoFrame === frame) {
        state.nintendoFrame = null;
      }
      if (state.nintendoMessageHandler === onNintendoMessage) {
        window.removeEventListener("message", onNintendoMessage);
        state.nintendoMessageHandler = null;
      }
      frame.src = "about:blank";
      frame.remove();
      if (state.nintendoRomUrl === romUrl) {
        URL.revokeObjectURL(romUrl);
        state.nintendoRomUrl = "";
      }
    },
  };
  log(
    `Starting ${engine.label} with ${mediaName}: ${selectedNintendoCpuCores()} CPU cores, ${selectedNintendoRamGb()} GB RAM, ${selectedNintendoVram().label} VRAM profile.`,
  );
  log(`Loaded the real ${engine.label} browser core. Use only homebrew or backups you legally own.`);
  const onNintendoMessage = (event) => {
    if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type !== "nebulavm:nintendo-started" || runId !== state.nintendoRunId) return;
    window.removeEventListener("message", onNintendoMessage);
    setPowerState("Nintendo running", "running");
    log(`${engine.label} reported that the game started.`);
  };
  state.nintendoMessageHandler = onNintendoMessage;
  window.addEventListener("message", onNintendoMessage);
  updateButtons();
};

const bootV86 = () => {
  els.qemuTerminal.hidden = true;
  els.screenContainer.querySelector(".vga-text").hidden = false;
  els.screenContainer.querySelector(".vga-canvas").hidden = false;
  state.emulator = new V86(buildConfig());
  state.running = els.autostart.checked;
  updateButtons();

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

  updateButtons();
  await state.emulator.start();
};

const showNativeDisplayStatus = (message) => {
  stopHyperVSetupConsole();
  els.nativeDisplay.hidden = false;
  const status = document.createElement("span");
  status.className = "native-display-status";
  status.textContent = message;
  els.nativeDisplay.replaceChildren(status);
};

const bootNativeQemu = async (displayMode = "viewport") => {
  const runtimeName = nativeRuntimeBrand();
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = true;
  els.qemuTerminal.textContent = "";
  showNativeDisplayStatus(
    displayMode === "external"
      ? `${runtimeName} is opening an external window.`
      : `Preparing ${runtimeName} viewport...`,
  );

  const { response, data: result, base } = await fetchNativeQemuJson("start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      arch: nativeArchitecture(),
      profile: nativeProfile(),
      runtime: runtimeName,
      displayMode,
      isoPath: els.nativeIsoPath.value.trim(),
      cpuGhz: selectedProcessorSpeedGhz(),
      memoryMb: selectedMemoryMb(),
      bootOrder: els.bootOrder.value,
      createDisk: els.nativeCreateDisk.checked,
      diskSizeGb: Number(els.nativeDiskSize.value),
    }),
  });
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "Native QEMU failed to start.");
  }

  if (displayMode === "external" && result.displayMode !== "external") {
    try {
      await fetchNativeQemuJson("stop", { method: "POST" });
    } catch {
      // The bridge mismatch message below is more useful than a stop failure here.
    }
    showNativeDisplayStatus("External mode needs the updated local bridge.");
    throw new Error(
      `${runtimeName} external display needs the updated local bridge. Restart npm.cmd run dev -- --port 5174 and try again.`,
    );
  }

  const rfb = result.vncPath ? connectNativeDisplay(base, result.vncPath, runtimeName) : null;
  state.nativeRfb = rfb;
  state.nativeRuntimeName = runtimeName;
  state.emulator = {
    stop: async () => {
      rfb?.disconnect();
      await fetchNativeQemuJson("stop", { method: "POST" });
    },
    destroy: async () => {
      rfb?.disconnect();
    },
  };
  state.running = true;
  const nativeLabel =
    result.profile === "ubuntu-arm64"
      ? `${runtimeName} ARM64 / Ubuntu`
      : result.arch === "aarch64"
        ? `${runtimeName} ARM64 / Windows`
        : `${runtimeName} x64`;
  setPowerState(nativeLabel, "running");
  updateButtons();
  monitorNativeVm();
  log(
    `${nativeLabel} started ${
      result.displayMode === "external" ? "in an external window" : "in the browser display"
    } (pid ${result.pid}).`,
  );
  if (base !== window.location.origin) log(`Using local bridge: ${base}`);
  if (result.replacedRuntime) {
    log(`Stopped existing ${result.replacedRuntime} session before starting ${runtimeName}.`);
  }
  if (result.arch) log(`Native architecture: ${result.arch}.`);
  if (result.profile) log(`Native profile: ${result.profile}.`);
  if (result.diskPath) log(`Using install disk: ${result.diskPath}`);
  if (result.ovmf) log(`Using UEFI firmware: ${result.ovmf}`);
  if (result.ovmfVarsPath) log(`Using UEFI variables: ${result.ovmfVarsPath}`);
  if (result.vncPath) log(`${runtimeName} display is embedded in the ISO viewport.`);
  if (result.displayMode === "external") log(`${runtimeName} display is running in an external desktop window.`);
  if (runtimeName === "Hyper-V") {
    log("Hyper-V uses the Microsoft Hyper-V engine.");
  }
};

const bootEmustarHyperV = async (displayMode = "viewport") => {
  if (isNetlifyLauncher) {
    displayMode = "viewport";
    els.nativeDisplayMode.value = "viewport";
  }

  const runtimeName = "Hyper-V";
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = true;
  els.qemuTerminal.textContent = "";
  showNativeDisplayStatus(
    displayMode === "external"
      ? "Starting the Hyper-V host console..."
      : "Starting Hyper-V setup inside this browser viewport...",
  );

  await saveWindowsGuestCredentialsIfNeeded();
  applyWindowsTemplateBootLocks();

  let startFinished = false;
  const startRequest = fetchHyperVJson("start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      displayMode,
      isoPath: els.nativeIsoPath.value.trim(),
      templateDiskPath: state.windowsTemplateSelected ? state.windowsTemplateDiskPath : "",
      guestType: selectedIsoLooksLikeWindows() ? "windows" : "other",
      cpuGhz: selectedProcessorSpeedGhz(),
      memoryMb: selectedMemoryMb(),
      bootOrder: els.bootOrder.value,
      createDisk: els.nativeCreateDisk.checked,
      diskSizeGb: Number(els.nativeDiskSize.value),
    }),
  }).finally(() => {
    startFinished = true;
  });
  const recoveryRequest = waitForHyperVStartRecovery(() => startFinished);
  const startResult = await Promise.race([startRequest, recoveryRequest]);
  if (!startResult) {
    throw new Error("Hyper-V is still waiting for the host. Refresh the page to attach to any VM that already started.");
  }

  const { response, data: result, base } = startResult;
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "Hyper-V failed to start.");
  }

  setHyperVRemoteSessionId(result.remoteSessionId || "");
  state.nativeRuntimeName = runtimeName;
  state.lastNativeStopLogKey = "";
  const rfb =
    displayMode === "viewport" && result.vncReady
      ? connectNativeDisplay(base, result.vncPath, runtimeName, result.vncPassword || "")
      : null;
  state.nativeRfb = rfb;
  state.emulator = {
    stop: async () => {
      stopHyperVSetupConsole();
      rfb?.disconnect();
      await fetchHyperVJson("stop", { method: "POST" });
    },
    destroy: async () => {
      stopHyperVSetupConsole();
      rfb?.disconnect();
    },
  };
  state.running = result.vm?.state === "Running";
  setPowerState("Hyper-V", state.running ? "running" : "booting");
  updateButtons();
  monitorNativeVm();
  void updateEmustarHostInfo();

  const vm = result.vm || {};
  log(`Hyper-V started ${vm.name || "the Windows VM"}.`);
  if (result.recoveredFromSlowStart) {
    log("Recovered the Hyper-V browser display from host status after the start request stalled.");
  }
  if (result.replacedRuntime) {
    log(`Stopped existing ${result.replacedRuntime} session before starting Hyper-V.`);
  }
  if (base !== window.location.origin) log(`Using local bridge: ${base}`);
  if (vm.diskPath) log(`Using VHDX install disk: ${vm.diskPath}`);
  if (vm.isoPath) log(`Mounted installation media: ${vm.isoPath}`);
  log(`Secure Boot: ${vm.secureBoot ? "enabled" : "not enabled"}.`);
  log(`Virtual TPM: ${vm.tpm ? "enabled" : "not enabled"}.`);
  for (const warning of result.warnings || []) {
    log(`Hyper-V warning: ${warning}`);
  }

  if (displayMode === "external") {
    showNativeDisplayStatus("Hyper-V is running in the host console.");
    log("The Hyper-V setup console opened on the host computer.");
  } else if (!result.vncReady) {
    startHyperVSetupConsole(base);
    log("Using this browser viewport for Hyper-V setup until the Windows desktop display is ready.");
  }
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

const androidVersionLabel = () => `Android ${els.androidVersion.value}`;
const selectedAndroidOrientation = () =>
  els.androidOrientation.find((option) => option.checked)?.value === "landscape" ? "landscape" : "portrait";

const syncAndroidOrientation = () => {
  const landscape = selectedAndroidOrientation() === "landscape";
  els.workspace.classList.toggle("is-android-landscape", landscape);
};

const applyAndroidVersionCatalog = (versions = []) => {
  const catalog = new Map(versions.map((entry) => [Number(entry.version), entry]));
  let firstAvailable = null;
  [...els.androidVersion.options].forEach((option) => {
    const item = catalog.get(Number(option.value));
    option.disabled = !item?.available;
    option.textContent = item?.label || `Android ${option.value} (not installed)`;
    if (item?.available && firstAvailable === null) firstAvailable = option.value;
  });
  if (els.androidVersion.selectedOptions[0]?.disabled && firstAvailable !== null) {
    els.androidVersion.value = firstAvailable;
  }
  const installed = versions.filter((entry) => entry.available).map((entry) => `Android ${entry.version}`);
  els.androidImageNote.textContent = installed.length
    ? `Curated genuine images: ${installed.join(", ")}. NebulaVM only exposes these focused test versions for now.`
    : "No curated Android system images are installed on the host.";
};

const androidEra = () => {
  const version = Number(els.androidVersion.value);
  if (version <= 4) return "classic";
  if (version <= 9) return "holo";
  if (version <= 12) return "material";
  return "modern";
};

const androidAppNames = {
  browser: "Browser",
  settings: "Settings",
  files: "Files",
  clock: "Clock",
};

const androidAppButton = (view, letter, color) => `
  <button class="android-app" type="button" data-android-open="${view}">
    <span class="android-app-icon" style="--app-color: ${color}">${letter}</span>
    <span>${androidAppNames[view]}</span>
  </button>
`;

const androidAppPage = (view, content) => `
  <section class="android-app-page" aria-label="${androidAppNames[view]}">
    <header>
      <button type="button" class="android-page-back" data-android-system="back" aria-label="Back">&#8249;</button>
      <strong>${androidAppNames[view]}</strong>
    </header>
    <div class="android-app-content">${content}</div>
  </section>
`;

const renderAndroidView = () => {
  if (!isAndroidMode()) return;
  const version = androidVersionLabel();
  els.androidDevice.dataset.era = androidEra();
  els.androidDevice.dataset.version = els.androidVersion.value;

  if (state.androidView === "browser") {
    els.androidSurface.innerHTML = androidAppPage(
      "browser",
      `<div class="android-browser-bar">nebula://start</div>
       <div class="android-browser-page">
         <span class="android-browser-mark">N</span>
         <h3>Nebula Browser</h3>
         <p>The lightweight browser surface for ${version}.</p>
         <button type="button" data-android-open="home">Return home</button>
       </div>`,
    );
  } else if (state.androidView === "settings") {
    els.androidSurface.innerHTML = androidAppPage(
      "settings",
      `<div class="android-settings-list">
         <label><span>Wi-Fi<small>Nebula Network</small></span><input type="checkbox" checked /></label>
         <label><span>Bluetooth<small>Ready to pair</small></span><input type="checkbox" /></label>
         <div><span>Android version<small>${version}</small></span></div>
         <div><span>Device name<small>Nebula Android</small></span></div>
       </div>`,
    );
  } else if (state.androidView === "files") {
    els.androidSurface.innerHTML = androidAppPage(
      "files",
      `<div class="android-file-list">
         <button type="button"><span>D</span><strong>Downloads</strong><small>Empty</small></button>
         <button type="button"><span>P</span><strong>Pictures</strong><small>4 items</small></button>
         <button type="button"><span>M</span><strong>Music</strong><small>2 items</small></button>
       </div>`,
    );
  } else if (state.androidView === "clock") {
    const now = new Date();
    els.androidSurface.innerHTML = androidAppPage(
      "clock",
      `<div class="android-clock-page">
         <time>${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
         <span>${now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</span>
       </div>`,
    );
  } else if (state.androidView === "recents") {
    const cards = state.androidRecents.length
      ? state.androidRecents
          .map(
            (view) => `
              <button class="android-recent-card" type="button" data-android-open="${view}">
                <span>${androidAppNames[view]}</span>
                <small>Tap to reopen</small>
              </button>`,
          )
          .join("")
      : `<p class="android-empty-recents">No recent apps</p>`;
    els.androidSurface.innerHTML = `
      <section class="android-recents" aria-label="Recent apps">
        <header><strong>Recent apps</strong></header>
        <div>${cards}</div>
        ${state.androidRecents.length ? '<button class="android-clear-recents" type="button" data-android-clear-recents>Clear all</button>' : ""}
      </section>`;
  } else {
    state.androidView = "home";
    els.androidSurface.innerHTML = `
      <section class="android-home" aria-label="Android home screen">
        <div class="android-home-clock">
          <time>${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
          <span>${version}</span>
        </div>
        <div class="android-app-grid">
          ${androidAppButton("browser", "B", "#38bdf8")}
          ${androidAppButton("settings", "S", "#facc15")}
          ${androidAppButton("files", "F", "#4ade80")}
          ${androidAppButton("clock", "C", "#fb7185")}
        </div>
        <div class="android-search-pill">Search apps</div>
      </section>`;
  }

  els.androidBackButton.disabled = state.androidView === "home" && state.androidHistory.length <= 1;
  els.machineTitle.textContent = `${version} - ${state.androidView === "home" ? "Home" : state.androidView === "recents" ? "Recent apps" : androidAppNames[state.androidView]}`;
};

const openAndroidView = (view) => {
  if (!state.running || !androidAppNames[view]) return;
  state.androidView = view;
  state.androidHistory.push(view);
  state.androidRecents = [view, ...state.androidRecents.filter((recent) => recent !== view)].slice(0, 4);
  renderAndroidView();
};

const syncAndroidViewportModeButtons = () => {
  const sessionReady = Boolean(isAndroidMode() && state.androidNativeActive && state.emulator);
  for (const button of els.androidViewModeButtons) {
    const active = button.dataset.androidViewportMode === state.androidViewportMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = !sessionReady;
    button.title = sessionReady ? "" : "Start Android before changing the viewport mode";
  }
};

const stopAndroidStudioManagement = () => {
  state.androidStudioActive = false;
  if (state.androidStudioTimer) {
    window.clearTimeout(state.androidStudioTimer);
    state.androidStudioTimer = null;
  }
  state.androidStudioCleanup?.();
  state.androidStudioCleanup = null;
  if (state.androidStudioFrameUrl) {
    URL.revokeObjectURL(state.androidStudioFrameUrl);
    state.androidStudioFrameUrl = null;
  }
};

const sendAndroidStudioInput = async (payload) => {
  if (!state.androidStudioActive) return;
  try {
    await fetchAndroidStudioJson("input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    log(`Android Studio input failed: ${error.message}`);
  }
};

const startAndroidStudioManagement = () => {
  if (!state.androidNativeActive || !state.emulator) return;
  stopAndroidStudioManagement();
  state.androidStudioActive = true;
  els.workspace.classList.add("is-avd-management");
  els.screenPlaceholder.hidden = true;
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = true;
  els.remoteFrame.hidden = true;
  els.androidDisplay.hidden = true;
  els.nativeDisplay.hidden = false;
  els.displayKicker.textContent = "AVD Management";
  els.machineTitle.textContent = "Private Android device";

  const shell = document.createElement("div");
  shell.className = "android-avd-manager";
  shell.innerHTML = `
    <div class="android-avd-manager__header">
      <img src="/assets/android-icon.png" alt="" />
      <div>
        <p class="kicker">Private AVD</p>
        <h3>${androidVersionLabel()}</h3>
        <p>This lightweight panel manages the active device without opening Android Studio on the low-memory host.</p>
      </div>
    </div>
    <dl class="android-avd-stats">
      <div><dt>Status</dt><dd data-avd-status>Checking...</dd></div>
      <div><dt>Memory</dt><dd data-avd-memory>Checking...</dd></div>
      <div><dt>Processor</dt><dd data-avd-cpu>Checking...</dd></div>
      <div><dt>Orientation</dt><dd data-avd-orientation>Checking...</dd></div>
    </dl>
    <div class="android-avd-actions">
      <button type="button" data-avd-action="wake">Wake display</button>
      <button type="button" data-avd-action="home">Home</button>
      <button type="button" data-avd-action="recents">Recent apps</button>
      <button type="button" class="danger" data-avd-action="reboot">Restart Android</button>
    </div>
    <p class="android-avd-note" data-avd-note>Connected to your private browser session.</p>`;
  els.nativeDisplay.replaceChildren(shell);

  const actionHandler = async (event) => {
    const button = event.target.closest("[data-avd-action]");
    if (!button) return;
    const action = button.dataset.avdAction;
    const note = shell.querySelector("[data-avd-note]");
    button.disabled = true;
    try {
      await sendNativeAndroidInput(
        action === "reboot" ? { type: "reboot" } : { type: "key", key: action },
      );
      note.textContent =
        action === "reboot" ? "Android is restarting. Device mode will reconnect automatically." : `${button.textContent} sent.`;
    } finally {
      button.disabled = false;
    }
  };
  shell.addEventListener("click", actionHandler);
  state.androidStudioCleanup = () => shell.removeEventListener("click", actionHandler);

  const pollFrame = async () => {
    if (!state.androidStudioActive || state.androidViewportMode !== "management") return;
    try {
      const { response, data } = await fetchAndroidJson("status");
      if (!response.ok || !data.running) throw new Error(data.error || "Android is not running.");
      shell.querySelector("[data-avd-status]").textContent = data.booted ? "Running" : "Cold booting";
      shell.querySelector("[data-avd-memory]").textContent = `${data.specs?.memoryMb || 0} MB`;
      shell.querySelector("[data-avd-cpu]").textContent = `${data.specs?.cores || 1} core${data.specs?.cores === 1 ? "" : "s"}`;
      shell.querySelector("[data-avd-orientation]").textContent =
        data.orientation === "landscape" ? "16:9 landscape" : "9:16 portrait";
      state.androidStudioTimer = window.setTimeout(pollFrame, 1200);
    } catch (error) {
      shell.querySelector("[data-avd-note]").textContent = `AVD status unavailable: ${error.message}`;
      state.androidStudioTimer = window.setTimeout(pollFrame, 2000);
    }
  };
  void pollFrame();
  log("Opened lightweight AVD Management in the browser viewport.");
};

const setAndroidViewportMode = (mode, { force = false } = {}) => {
  if (!force && (!state.androidNativeActive || !state.emulator)) {
    syncAndroidViewportModeButtons();
    return false;
  }
  state.androidViewportMode = mode === "management" ? "management" : "device";
  syncAndroidViewportModeButtons();
  if (state.androidViewportMode === "management") {
    startAndroidStudioManagement();
    return true;
  }
  stopAndroidStudioManagement();
  els.workspace.classList.remove("is-avd-management");
  els.screenShell.style.removeProperty("--avd-frame-ratio");
  els.screenShell.style.removeProperty("aspect-ratio");
  els.nativeDisplay.hidden = true;
  if (state.emulator && isAndroidMode()) {
    els.screenPlaceholder.hidden = true;
    els.androidDisplay.hidden = false;
    els.displayKicker.textContent = "Android Emulator";
    els.machineTitle.textContent = `${androidVersionLabel()} - Real device`;
  } else {
    els.androidDisplay.hidden = true;
    els.screenPlaceholder.hidden = false;
    els.displayKicker.textContent = "Android Emulator";
    els.machineTitle.textContent = `${androidVersionLabel()} ready`;
  }
  return true;
};

const androidBack = () => {
  if (!state.running) return;
  if (state.androidNativeActive) {
    void sendNativeAndroidInput({ type: "key", key: "back" });
    return;
  }
  if (state.androidView === "recents") {
    state.androidView = state.androidHistory.at(-1) || "home";
  } else if (state.androidHistory.length > 1) {
    state.androidHistory.pop();
    state.androidView = state.androidHistory.at(-1) || "home";
  }
  renderAndroidView();
};

const androidHome = () => {
  if (!state.running) return;
  if (state.androidNativeActive) {
    void sendNativeAndroidInput({ type: "key", key: "home" });
    return;
  }
  state.androidView = "home";
  state.androidHistory = ["home"];
  renderAndroidView();
};

const androidRecents = () => {
  if (!state.running) return;
  if (state.androidNativeActive) {
    void sendNativeAndroidInput({ type: "key", key: "recents" });
    return;
  }
  state.androidView = "recents";
  renderAndroidView();
};

const stopNativeAndroidFrames = () => {
  if (state.androidNativeFrameTimer) {
    window.clearTimeout(state.androidNativeFrameTimer);
    state.androidNativeFrameTimer = null;
  }
  if (state.androidNativeFrameUrl) {
    URL.revokeObjectURL(state.androidNativeFrameUrl);
    state.androidNativeFrameUrl = null;
  }
};

const stopAndroidColdBootCountdown = () => {
  if (state.androidColdBootTimer) {
    window.clearInterval(state.androidColdBootTimer);
    state.androidColdBootTimer = null;
  }
  state.androidColdBootEndsAt = 0;
};

const formatColdBootRemaining = (seconds) => {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")} remaining`;
};

const estimateAndroidColdBootSeconds = (version, specs = {}) => {
  const memoryMb = Number(specs.memoryMb) || 1024;
  const cores = Number(specs.cores) || 1;
  let estimate = version >= 15 ? 270 : version >= 11 ? 210 : version >= 8 ? 165 : 120;
  if (memoryMb <= 512) estimate *= 1.8;
  else if (memoryMb <= 768) estimate *= 1.35;
  else if (memoryMb >= 2048) estimate *= 0.82;
  if (cores <= 1) estimate *= 1.15;
  else if (cores >= 4) estimate *= 0.88;
  return Math.round(Math.max(90, Math.min(900, estimate)));
};

const startAndroidColdBootCountdown = (element, version, specs) => {
  stopAndroidColdBootCountdown();
  state.androidColdBootEndsAt = Date.now() + estimateAndroidColdBootSeconds(version, specs) * 1000;
  const update = () => {
    if (!element.isConnected || !state.androidNativeActive) {
      stopAndroidColdBootCountdown();
      return;
    }
    element.textContent = formatColdBootRemaining((state.androidColdBootEndsAt - Date.now()) / 1000);
  };
  update();
  state.androidColdBootTimer = window.setInterval(update, 1000);
};

const stopAndroidLeaseHeartbeat = () => {
  if (!state.androidNativeLeaseTimer) return;
  window.clearInterval(state.androidNativeLeaseTimer);
  state.androidNativeLeaseTimer = null;
};

const startAndroidLeaseHeartbeat = () => {
  stopAndroidLeaseHeartbeat();
  state.androidNativeLeaseTimer = window.setInterval(async () => {
    if (!state.androidNativeActive || !state.emulator) {
      stopAndroidLeaseHeartbeat();
      return;
    }
    try {
      const { response, data } = await fetchAndroidJson("status");
      if (!response.ok || !data.running) {
        throw new Error(data.error || "The private Android session is no longer active.");
      }
    } catch (error) {
      log(`Android session heartbeat failed: ${error.message}`);
    }
  }, 15_000);
};

const sendNativeAndroidInput = async (payload) => {
  if (!state.androidNativeActive) return;
  try {
    const { response, data } = await fetchAndroidJson("input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Android rejected the input.");
    }
  } catch (error) {
    log(`Android input failed: ${error.message}`);
  }
};

const scheduleNativeAndroidFrame = (image, delay = 450) => {
  if (!state.androidNativeActive || !state.emulator) return;
  window.clearTimeout(state.androidNativeFrameTimer);
  state.androidNativeFrameTimer = window.setTimeout(() => {
    void refreshNativeAndroidFrame(image);
  }, delay);
};

const refreshNativeAndroidFrame = async (image) => {
  if (!state.androidNativeActive || !state.emulator) return;
  if (!state.running) {
    scheduleNativeAndroidFrame(image, 600);
    return;
  }

  try {
    const frame = await fetchAndroidFrame();
    const nextUrl = URL.createObjectURL(frame.blob);
    image.src = nextUrl;
    if (state.androidNativeFrameUrl) URL.revokeObjectURL(state.androidNativeFrameUrl);
    state.androidNativeFrameUrl = nextUrl;
    image.dataset.frameWidth = String(frame.width);
    image.dataset.frameHeight = String(frame.height);
    image.hidden = false;
    stopAndroidColdBootCountdown();
    els.androidSurface.querySelector(".android-native-startup")?.remove();
    scheduleNativeAndroidFrame(image);
  } catch (error) {
    const { data: status } = await fetchAndroidJson("status").catch(() => ({ data: null }));
    const startupMessage = els.androidSurface.querySelector(".android-native-startup span");
    if (status && !status.running) {
      const summary = nativeExitSummary(status.lastExit);
      stopNativeAndroidFrames();
      stopAndroidLeaseHeartbeat();
      stopAndroidColdBootCountdown();
      state.androidNativeActive = false;
      state.androidNativeInputController?.abort();
      state.androidNativeInputController = null;
      state.emulator = null;
      state.running = false;
      state.startedAt = null;
      clearStatsTimer();
      updateUptime();
      els.androidDevice.classList.remove("is-native", "is-paused");
      setPowerState("Android stopped", "off");
      if (startupMessage) startupMessage.textContent = `Android stopped: ${summary}`;
      log(`Android stopped: ${summary}`);
      updateButtons();
      return;
    }
    if (status?.booted) {
      stopAndroidColdBootCountdown();
      els.androidSurface.querySelector(".android-cold-boot-countdown")?.remove();
      if (startupMessage) startupMessage.textContent = "Android is running. Connecting the live display...";
    } else {
      if (startupMessage) startupMessage.textContent = "Cold boot in progress on the Windows host...";
    }
    scheduleNativeAndroidFrame(image, 900);
  }
};

const nativeAndroidCoordinates = (event, image) => {
  const rect = image.getBoundingClientRect();
  const frameWidth = Number(image.dataset.frameWidth) || 1080;
  const frameHeight = Number(image.dataset.frameHeight) || 1920;
  return {
    x: Math.max(0, Math.min(frameWidth, ((event.clientX - rect.left) / rect.width) * frameWidth)),
    y: Math.max(0, Math.min(frameHeight, ((event.clientY - rect.top) / rect.height) * frameHeight)),
  };
};

const bootNativeAndroid = async (status) => {
  applyAndroidVersionCatalog(status.versions || []);
  const requestedVersion = Number(els.androidVersion.value);
  if (status.busy) {
    throw new Error("Android is currently in use by another private browser session.");
  }
  if (!(status.installedVersions || []).includes(requestedVersion)) {
    throw new Error(`A genuine Android ${requestedVersion} system image is not installed on this host.`);
  }
  const orientation = selectedAndroidOrientation();
  syncAndroidOrientation();

  const { response, data } = await fetchAndroidJson("start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: requestedVersion,
      cores: Number(els.androidCores.value),
      memoryMb: Number(els.androidMemory.value),
      storageGb: Number(els.androidStorage.value),
      orientation,
    }),
  });
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "The Android Emulator could not start.");
  }

  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = true;
  els.nativeDisplay.hidden = true;
  els.remoteFrame.hidden = true;
  els.androidDisplay.hidden = false;
  els.displayKicker.textContent = "Android Emulator";
  els.androidDevice.classList.add("is-native");
  els.androidDevice.classList.remove("is-paused");
  els.androidSurface.replaceChildren();
  els.androidSurface.tabIndex = 0;
  state.androidNativeInputController?.abort();
  state.androidNativeInputController = new AbortController();

  const image = document.createElement("img");
  image.className = "android-native-frame";
  image.alt = "Live Android Emulator display";
  image.draggable = false;
  image.hidden = true;
  const startup = document.createElement("div");
  startup.className = "android-native-startup";
  startup.innerHTML = `
    <img src="/assets/android-icon.png" alt="" />
    <strong>Starting ${androidVersionLabel()}</strong>
    <span>Connecting to the private Android Emulator...</span>
    <time class="android-cold-boot-countdown">00:00:00 remaining</time>
  `;
  els.androidSurface.append(image, startup);
  const coldBootCountdown = startup.querySelector(".android-cold-boot-countdown");
  if (data.booted) {
    coldBootCountdown.remove();
  }

  image.addEventListener("pointerdown", (event) => {
    image.setPointerCapture(event.pointerId);
    state.androidNativePointer = {
      ...nativeAndroidCoordinates(event, image),
      startedAt: performance.now(),
    };
  });
  image.addEventListener("pointerup", (event) => {
    const start = state.androidNativePointer;
    state.androidNativePointer = null;
    if (!start) return;
    const end = nativeAndroidCoordinates(event, image);
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (distance < 18) {
      void sendNativeAndroidInput({ type: "tap", x: end.x, y: end.y });
    } else {
      void sendNativeAndroidInput({
        type: "swipe",
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        duration: performance.now() - start.startedAt,
      });
    }
  });
  image.addEventListener("pointercancel", () => {
    state.androidNativePointer = null;
  });
  els.androidSurface.addEventListener(
    "keydown",
    (event) => {
      if (!state.androidNativeActive) return;
      if (event.key === "Backspace") {
        event.preventDefault();
        void sendNativeAndroidInput({ type: "key", key: "back" });
      } else if (event.key === "Enter") {
        event.preventDefault();
        void sendNativeAndroidInput({ type: "key", key: "enter" });
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        void sendNativeAndroidInput({ type: "text", text: event.key });
      }
    },
    { signal: state.androidNativeInputController.signal },
  );

  state.androidNativeActive = true;
  if (!data.booted) {
    startAndroidColdBootCountdown(coldBootCountdown, requestedVersion, data.specs);
  }
  startAndroidLeaseHeartbeat();
  state.running = true;
  state.emulator = {
    stop: async () => {
      state.running = false;
      stopNativeAndroidFrames();
      els.androidDevice.classList.add("is-paused");
      setPowerState("Android paused", "paused");
      updateButtons();
    },
    run: () => {
      state.running = true;
      els.androidDevice.classList.remove("is-paused");
      setPowerState("Android running", "running");
      scheduleNativeAndroidFrame(image, 0);
      updateButtons();
    },
    destroy: async () => {
      setAndroidViewportMode("device", { force: true });
      stopNativeAndroidFrames();
      stopAndroidLeaseHeartbeat();
      stopAndroidColdBootCountdown();
      state.androidNativeActive = false;
      state.androidNativeInputController?.abort();
      state.androidNativeInputController = null;
      els.androidDevice.classList.remove("is-native", "is-paused");
      await fetchAndroidJson("stop", { method: "POST" }).catch(() => {});
      els.androidDisplay.hidden = true;
    },
    restart: () => {
      void sendNativeAndroidInput({ type: "key", key: "home" });
    },
  };

  els.machineTitle.textContent = `${androidVersionLabel()} - Real device`;
  els.ramMetric.textContent = `${data.specs?.memoryMb || els.androidMemory.value} MB RAM`;
  setPowerState(data.booted ? "Android running" : "Android starting", data.booted ? "running" : "booting");
  log(
    `${androidVersionLabel()} private AVD created with ${data.specs?.cores || els.androidCores.value} cores, ` +
      `${data.specs?.memoryMb || els.androidMemory.value} MB RAM, and ${orientation === "landscape" ? "16:9" : "9:16"} orientation.`,
  );
  if (data.specs?.memoryAdapted) {
    log(`Adaptive Android mode selected ${data.specs.memoryMb} MB RAM for the host's current capacity.`);
  }
  if (data.specs?.publicMobileRestricted) {
    log("Public mobile limits are active. This private Android session ends automatically after 20 minutes.");
  }
  scheduleNativeAndroidFrame(image, 0);
  updateButtons();
};

const bootAndroidSimulator = () => {
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = true;
  els.nativeDisplay.hidden = true;
  els.remoteFrame.hidden = true;
  els.androidDisplay.hidden = false;
  state.androidView = "home";
  state.androidHistory = ["home"];
  state.androidRecents = [];

  state.emulator = {
    stop: async () => {
      state.running = false;
      els.androidDevice.classList.add("is-paused");
      setPowerState("Android paused", "paused");
      updateButtons();
    },
    run: () => {
      state.running = true;
      els.androidDevice.classList.remove("is-paused");
      setPowerState("Android running", "running");
      updateButtons();
    },
    destroy: async () => {
      els.androidDisplay.hidden = true;
      els.androidDevice.classList.remove("is-paused");
    },
    restart: () => {
      state.androidView = "home";
      state.androidHistory = ["home"];
      state.androidRecents = [];
      state.startedAt = Date.now();
      renderAndroidView();
    },
  };
  state.running = true;
  els.ramMetric.textContent = androidVersionLabel();
  setPowerState("Android running", "running");
  renderAndroidView();
  log(`${androidVersionLabel()} browser simulator started.`);
  updateButtons();
};

const bootAndroid = async () => {
  const { response, data: status } = await fetchAndroidJson("status");
  if (!response.ok) {
    throw new Error(status.error || "The Android host could not be checked.");
  }
  applyAndroidVersionCatalog(status.versions || []);
  if (!status.available) {
    throw new Error("Android Studio Emulator and a genuine Android system image are required on the host.");
  }
  await bootNativeAndroid(status);
};

const bootEmulator = async () => {
  if (isPublicMobileClient && !isPublicMobileModeAllowed()) {
    els.emulatorMode.value = "android";
    updateBackendUi();
    log("Public mobile mode supports Android and Remote VM only.");
    return;
  }
  if (!isAndroidMode() && !isNintendoMode() && !isNativeMode() && !isRemoteMode() && !state.isoFile) return;
  if (isNintendoMode() && !state.isoFile) {
    log("Boot blocked: drop a legally owned Nintendo ROM or disc image first.");
    return;
  }
  if (isNativeMode() && !isHyperVMode() && !els.nativeIsoPath.value.trim()) {
    log(`Boot blocked: enter a local ISO path for ${nativeModeLabel()}.`);
    return;
  }
  if (isHyperVMode() && !els.nativeIsoPath.value.trim() && state.isoFile) {
    try {
      await stageSelectedIsoForEmustar();
    } catch (error) {
      log(`Boot blocked: ${error.message}`);
      return;
    }
  }
  if (isHyperVMode() && !els.nativeIsoPath.value.trim()) {
    log("Boot blocked: drop an ISO or choose an ISO path before launching Hyper-V.");
    return;
  }
  if (isHyperVMode() && looksLikeArm64Iso(els.nativeIsoPath.value.trim())) {
    log("Boot blocked: Hyper-V on this Intel PC needs the Windows 11 x64 ISO, not ARM64.");
    return;
  }
  syncNativeModeToIsoPath();
  if (isRemoteMode() && !els.remoteVmUrl.value.trim()) {
    log("Boot blocked: enter a remote VM URL.");
    return;
  }
  if (isSelectedMediaTooLarge()) {
    updateMediaWarning();
    log(`Boot blocked: ${els.mediaWarning.textContent}`);
    return;
  }

  const qemuDisplayMode = isNativeMode() ? selectedNativeDisplayMode() : "viewport";

  await stopEmulator();

  prepareBootUi();
  log("Creating virtual machine.");
  if (!isRemoteMode() && !isAndroidMode() && !isNintendoMode()) {
    log(`Hardware request: ${selectedProcessorSpeedGhz()} GHz CPU target, ${selectedMemoryMb()} MB RAM.`);
  }

  try {
    if (isAndroidMode()) {
      await bootAndroid();
    } else if (isNintendoMode()) {
      bootNintendo();
    } else if (isRemoteMode()) {
      await bootRemoteVm();
    } else if (isHyperVMode()) {
      await bootEmustarHyperV(qemuDisplayMode);
    } else if (isNativeMode()) {
      await bootNativeQemu(qemuDisplayMode);
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

els.processorSpeed.addEventListener("input", syncProcessorSpeedSlider);
els.memorySlider.addEventListener("input", () => {
  syncMemorySelectFromSlider();
  els.ramMetric.textContent = `${selectedMemoryMb()} MB RAM`;
  updateButtons();
});
els.memorySize.addEventListener("change", () => {
  syncMemorySliderFromSelect();
  els.ramMetric.textContent = `${selectedMemoryMb()} MB RAM`;
});
[els.nintendoCpuSlider, els.nintendoRamSlider, els.nintendoVramSlider].forEach((slider) => {
  slider.addEventListener("input", () => {
    syncNintendoSliders();
    if (isNintendoMode()) {
      els.ramMetric.textContent = `${selectedNintendoRamGb()} GB RAM`;
      if (state.emulator) {
        bootNintendo();
      }
    }
    updateButtons();
  });
});
els.nintendoEngine.addEventListener("change", () => {
  syncNintendoSliders();
  if (isNintendoMode() && !state.emulator) {
    els.machineTitle.textContent = `${selectedNintendoEngine().label} - ${selectedNintendoEngine().system}`;
    els.placeholderMeta.textContent = `${selectedNintendoEngine().label} handles ${selectedNintendoEngine().system}. Drop legally owned media to begin.`;
  }
  if (isNintendoMode() && state.emulator) {
    bootNintendo();
  }
  log(`Selected ${selectedNintendoEngine().label} for ${selectedNintendoEngine().system}.`);
  updateButtons();
});

const updateNativeStatus = async () => {
  if (!isNativeMode()) return;

  if (isHyperVMode()) {
    if (isNetlifyLauncher && (!state.nativeQemuApiBase || !state.nativeHostToken)) {
      const host = await connectNetlifyHostRegistry();
      if (!host) return;
    }

    try {
      const { data: status, base } = await fetchHyperVJson("status");
      const bridgeLabel = base === window.location.origin ? "" : ` via Windows host ${base}`;
      state.nativeQemuApiAvailable = true;
      state.nativeQemuReady = Boolean(status.available);
      if (status.available) {
        if (status.vm?.state && status.vm.state !== "Running") {
          setHyperVRemoteSessionId("");
        }
        const vmState = status.vm ? ` VM: ${status.vm.state}.` : "";
        els.nativeStatus.dataset.mode = "ready";
        els.nativeStatus.textContent = `Hyper-V ready${bridgeLabel}.${vmState}`;
        if (await adoptRunningHyperVViewport(status, base)) {
          els.nativeStatus.textContent = `Hyper-V display is live in the browser viewport${bridgeLabel}.`;
        }
      } else if (status.restartRequired) {
        els.nativeStatus.dataset.mode = "missing";
        els.nativeStatus.textContent =
          "Hyper-V is enabled on the Windows host. Restart that Windows PC once to finish preparing Hyper-V.";
      } else {
        els.nativeStatus.dataset.mode = "missing";
        els.nativeStatus.textContent = isNetlifyLauncher
          ? "The Windows host is reachable, but Microsoft Hyper-V is not available there."
          : "Microsoft Hyper-V is not available on this host.";
      }
    } catch (error) {
      state.nativeQemuApiAvailable = false;
      state.nativeQemuReady = false;
      els.nativeStatus.dataset.mode = "missing";
      els.nativeStatus.textContent = error.message;
    }
    updateButtons();
    return;
  }

  try {
    const { data: status, base } = await fetchNativeQemuJson(`status?arch=${nativeArchitecture()}`);
    const bridgeLabel = base === window.location.origin ? "" : ` via local bridge ${base}`;
    state.nativeQemuApiAvailable = true;
    state.nativeQemuReady = Boolean(status.available);
    if (status.available) {
      els.nativeStatus.dataset.mode = "ready";
      els.nativeStatus.textContent =
        `${nativeModeLabel()} ready${status.ovmf ? " with UEFI" : ""}${bridgeLabel}.` +
        (isStandaloneQemuMode() ? "" : " Powered by QEMU.");
    } else {
      els.nativeStatus.dataset.mode = "missing";
      els.nativeStatus.textContent =
        `${nativeRuntimeBrand()} engine not found${bridgeLabel}. Install QEMU for Windows, then restart the local bridge.`;
    }
  } catch (error) {
    state.nativeQemuApiAvailable = false;
    state.nativeQemuReady = false;
    els.nativeStatus.dataset.mode = "missing";
    els.nativeStatus.textContent = error.message;
  }

  updateButtons();
};

const formatTransferSpeed = (bytesPerSecond) => {
  const speed = Math.max(0, Number(bytesPerSecond) || 0);
  if (speed >= 1024 * 1024) {
    return `${(speed / 1024 / 1024).toFixed(1)} MB/s`;
  }
  return `${Math.round(speed / 1024)} KB/s`;
};

const resetNativeFirmware = async () => {
  if (!isNativeQemuMode() || state.emulator) return;

  els.nativeResetFirmwareButton.disabled = true;
  log(`Resetting ${nativeModeLabel()} UEFI settings.`);
  try {
    const { response, data } = await fetchNativeQemuJson("reset-firmware", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arch: nativeArchitecture(),
        profile: nativeProfile(),
      }),
    });
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "UEFI reset failed.");
    }
    els.nativeStatus.dataset.mode = "ready";
    els.nativeStatus.textContent = "UEFI settings reset. The virtual disk was preserved.";
    log(`UEFI settings reset. Backup: ${data.backupPath || "not needed"}`);
  } catch (error) {
    els.nativeStatus.dataset.mode = "missing";
    els.nativeStatus.textContent = error.message;
    log(`UEFI reset failed: ${error.message}`);
  } finally {
    updateButtons();
  }
};

const openHyperVConsole = async () => {
  if (!isHyperVMode()) return;
  els.nativeConsoleButton.disabled = true;
  try {
    const { response, data } = await fetchHyperVJson("open-console", { method: "POST" });
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "The Hyper-V console could not be opened.");
    }
    log("Opened the Hyper-V console on the host computer.");
  } catch (error) {
    log(`Host console failed: ${error.message}`);
    els.nativeStatus.dataset.mode = "missing";
    els.nativeStatus.textContent = error.message;
  } finally {
    updateButtons();
  }
};

const updateBrowserQemuCapabilities = async () => {
  if (!isBrowserQemuMode()) return;
  state.browserQemuCanMountFiles = await qemuWasmCanMountBrowserFiles();
  updateMediaWarning();
  updateButtons();
};

const updateBackendUi = () => {
  if (isPublicMobileClient && !isPublicMobileModeAllowed()) {
    els.emulatorMode.value = "android";
  }
  const qemuMode = isQemuMode();
  const nativeMode = isNativeMode();
  const nativeArm64Mode = isNativeArm64Mode();
  const nativeUbuntuArm64Mode = isNativeUbuntuArm64Mode();
  const remoteMode = isRemoteMode();
  const externalMode = isExternalMode();
  const runtimeBrand = nativeRuntimeBrand();
  const emustarMode = isEmustarEmulator(els.emulatorMode.value);
  const androidMode = isAndroidMode();
  const nintendoMode = isNintendoMode();
  if (state.windowsTemplateSelected && !emustarMode) {
    clearWindowsTemplateSelection();
  }
  syncEmulatorDropdown();
  els.workspace.classList.toggle("is-emustar-mode", emustarMode);
  els.workspace.classList.toggle("is-android-mode", androidMode);
  els.workspace.classList.toggle("is-nintendo-mode", nintendoMode);
  document.documentElement.classList.toggle("android-mode", androidMode);
  els.experimentalWarningPill.hidden = !emustarMode && !androidMode && !remoteMode;
  els.emustarInfoLink.hidden = !emustarMode;
  els.storedImagesControl.hidden = androidMode || nintendoMode;
  els.windowsTemplateButton.hidden = isMobileOrTabletDevice() || !emustarMode;
  els.dropZone.hidden = androidMode;
  els.nintendoHelpLink.hidden = !nintendoMode || androidMode;
  els.mediaWarning.hidden = androidMode;
  els.demoButton.hidden = androidMode || nintendoMode;
  els.androidConfig.hidden = !androidMode;
  els.nintendoConfig.hidden = !nintendoMode;
  els.androidViewSwitch.hidden = !androidMode || isPublicMobileClient;
  els.hostMemoryMetric.hidden = !androidMode;
  els.dropTitle.textContent = nintendoMode ? "Drop ROM or disc image" : "Drop ISO or disk image";
  els.isoInput.accept = nintendoMode ? nintendoAcceptString() : ".iso,.img,.bin,.raw";
  if (!androidMode && state.androidViewportMode !== "device") {
    setAndroidViewportMode("device", { force: true });
  }
  if (androidMode) syncAndroidOrientation();
  if (nintendoMode) syncNintendoSliders();
  els.pcSpecControls.forEach((control) => {
    control.hidden = androidMode || nintendoMode;
  });
  els.advancedOptions.hidden = androidMode || nintendoMode;
  els.mediaKicker.textContent = androidMode
    ? "Android"
    : nintendoMode
    ? "Nintendo"
    : emustarMode
      ? "Nebula Host"
      : "Media";
  els.bootSourceTitle.textContent = androidMode
    ? "Device"
    : nintendoMode
    ? "Game media"
    : emustarMode
      ? "Mission media"
      : "Boot source";
  els.displayKicker.textContent = androidMode
    ? "Android Device"
    : nintendoMode
    ? "Nintendo Emulator"
    : emustarMode
      ? "Nebula Console"
      : "Display";
  els.activityLabel.textContent = androidMode ? "Android log" : nintendoMode ? "Nintendo log" : emustarMode ? "Mission log" : "Activity";
  els.screenModeIcon.src = androidMode
    ? "/assets/android-icon.png"
    : nintendoMode
    ? "/assets/nintendo-icon.webp"
    : "/assets/hyperv-icon.svg";
  els.displayModeMark.src = androidMode
    ? "/assets/android-icon.png"
    : nintendoMode
    ? "/assets/nintendo-icon.webp"
    : "/assets/hyperv-icon.svg";
  els.screenModeIcon.hidden = !emustarMode && !androidMode && !nintendoMode;
  els.screenOrbital.hidden = emustarMode || androidMode || nintendoMode;
  els.placeholderTitle.textContent = androidMode
    ? `${androidVersionLabel()} ready`
    : nintendoMode
      ? "Nintendo emulator ready"
    : emustarMode
      ? "Hyper-V viewport standing by"
      : "Drop an ISO to begin";
  if (!state.emulator && !state.isoFile && !state.windowsTemplateSelected) {
    els.machineTitle.textContent = androidMode
      ? `${androidVersionLabel()} private device`
      : nintendoMode
        ? `${selectedNintendoEngine().label} - ${selectedNintendoEngine().system}`
      : emustarMode
        ? "Hyper-V Control Deck"
        : "Awaiting boot media";
  }
  els.processorMode.value = nativeArm64Mode ? "arm64" : qemuMode || emustarMode ? "x64" : "x86";
  els.processorMode.disabled = emustarMode;
  const currentMemoryMb = selectedMemoryMb();
  if (isNativeWindowsArm64Mode() && currentMemoryMb < 4096) {
    els.memorySize.value = "4294967296";
  } else if (nativeMode && currentMemoryMb < 2048) {
    els.memorySize.value = "2147483648";
  }
  syncProcessorSpeedSlider();
  syncMemorySliderFromSelect();
  els.nativePanel.hidden = !nativeMode;
  els.remotePanel.hidden = !remoteMode;
  if (!androidMode) {
    els.androidDisplay.hidden = true;
  }
  if (!nintendoMode) {
    els.nintendoDisplay.hidden = true;
  }
  if (nativeMode) {
    const hostedEmustarMode = emustarMode && isNetlifyLauncher;
    els.nativeRuntimeIcon.src = isStandaloneQemuMode() ? "/assets/qemu-icon.png" : "/assets/hyperv-icon.svg";
    els.nativeRuntimeName.textContent = runtimeBrand;
    els.nativeRuntimeAttribution.textContent = isStandaloneQemuMode()
      ? "Native virtualization engine"
      : hostedEmustarMode
        ? "Streams from the Windows host into this browser"
        : "Generation 2 virtualization powered by Microsoft Hyper-V";
    els.nativeResetFirmwareButton.hidden = emustarMode;
    els.nativeConsoleButton.hidden = !emustarMode || hostedEmustarMode;
    els.nativeDiskHelp.textContent = emustarMode
      ? "Uses a dynamic VHDX disk in the NebulaVM folder."
      : "Uses a qcow2 disk in the NebulaVM folder.";
    els.nativeCreateDisk.checked = true;
    els.nativeCreateDisk.disabled = emustarMode;
    const [viewportOption, externalOption] = els.nativeDisplayMode.options;
    viewportOption.textContent = hostedEmustarMode
      ? "This device's browser viewport"
      : emustarMode
        ? "Browser setup + desktop"
        : "ISO viewport";
    externalOption.textContent = emustarMode ? "Host console (this PC only)" : "External window";
    externalOption.hidden = hostedEmustarMode;
    externalOption.disabled = hostedEmustarMode;
    if (hostedEmustarMode) {
      els.nativeDisplayMode.value = "viewport";
    }
    state.nativeQemuReady = false;
    els.nativeStatus.dataset.mode = "";
    els.nativeStatus.textContent = `Checking ${nativeModeLabel()}...`;
  }
  els.vgaSize.disabled = externalMode;
  applyWindowsTemplateBootLocks();
  els.mediaType.disabled = state.windowsTemplateSelected;
  els.bootOrder.disabled = remoteMode || state.emulator || state.windowsTemplateSelected;
  els.nativeDisplayMode.disabled = (emustarMode && isNetlifyLauncher) || Boolean(state.emulator);
  els.demoButton.disabled = externalMode;
  els.autostart.disabled = externalMode;
  els.networkingHelp.textContent = nativeMode
    ? emustarMode
      ? "Uses a Hyper-V virtual switch when one is available."
      : isStandaloneQemuMode()
      ? "QEMU user-mode networking."
      : "Native runtime networking."
    : isBrowserQemuMode()
      ? "QEMU networking depends on the compiled Wasm build."
    : "Uses v86 networking support when available.";
  els.placeholderMeta.textContent = androidMode
    ? `Start ${androidVersionLabel()} with no ISO or PC hardware setup required.`
    : nintendoMode
    ? `${selectedNintendoEngine().label} handles ${selectedNintendoEngine().system}. Drop legally owned media to begin.`
    : nativeMode
    ? emustarMode
      ? "Choose or import an ISO to launch a Hyper-V machine."
      : nativeUbuntuArm64Mode
      ? `${runtimeBrand} boots Ubuntu ARM64 with a dedicated qcow2 disk.`
      : nativeArm64Mode
        ? `${runtimeBrand} boots Windows ARM64 from a local ISO.`
        : `${runtimeBrand} boots large x64 ISOs through the local runtime.`
    : remoteMode
      ? "Remote VM mode shows a VM running on another computer or cloud server."
    : isBrowserQemuMode()
      ? "x86_64 support uses QEMU Wasm and local artifacts from public/qemu."
    : "Legacy x86, 32-bit Linux, DOS, hobby OS, and vintage Windows images work best.";
  if (androidMode && !state.emulator) {
    void fetchAndroidJson("status")
      .then(({ data }) => {
        applyAndroidVersionCatalog(data.versions || []);
        updateAndroidHostMemory(data.hostMemory);
      })
      .catch((error) => {
        els.androidImageNote.textContent = error.message;
      });
  }
  els.ramMetric.textContent = androidMode
    ? Number(els.androidMemory.value) === 0
      ? "Adaptive RAM"
      : `${els.androidMemory.value} MB RAM`
    : nintendoMode
    ? `${selectedNintendoRamGb()} GB RAM`
    : `${selectedMemoryMb()} MB RAM`;
  updateMediaWarning();
  updateButtons();
  void updateEmustarHostInfo();
  void updateNativeStatus();
  if (emustarMode) {
    void refreshStoredIsos({ silent: true });
  }
  if (emustarMode && state.isoFile && !els.nativeIsoPath.value.trim() && !state.hostStagedIsoUploading) {
    void stageSelectedIsoForEmustar().catch(() => {});
  }
  void updateBrowserQemuCapabilities();
};

els.androidViewModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!isAndroidMode()) return;
    setAndroidViewportMode(button.dataset.androidViewportMode);
  });
});
els.emulatorMode.addEventListener("change", updateBackendUi);
els.androidVersion.addEventListener("change", async () => {
  if (state.androidNativeActive) {
    await stopEmulator();
    log(`Selected ${androidVersionLabel()}. Start Android to use that installed device image.`);
    updateBackendUi();
    return;
  }
  if (isAndroidMode() && state.emulator) {
    state.androidView = "home";
    state.androidHistory = ["home"];
    state.androidRecents = [];
    renderAndroidView();
    log(`Switched the simulator to ${androidVersionLabel()}.`);
  }
  updateBackendUi();
});
els.androidOrientation.forEach((option) => {
  option.addEventListener("change", async () => {
    syncAndroidOrientation();
    if (state.androidNativeActive) {
      await stopEmulator();
      log(`Selected ${selectedAndroidOrientation() === "landscape" ? "16:9 landscape" : "9:16 portrait"}. Start Android to create a new private AVD.`);
    }
    updateBackendUi();
  });
});
els.androidBackButton.addEventListener("click", androidBack);
els.androidHomeButton.addEventListener("click", androidHome);
els.androidRecentsButton.addEventListener("click", androidRecents);
els.androidSurface.addEventListener("click", (event) => {
  const systemButton = event.target.closest("[data-android-system]");
  if (systemButton?.dataset.androidSystem === "back") {
    androidBack();
    return;
  }

  const openButton = event.target.closest("[data-android-open]");
  if (openButton) {
    if (openButton.dataset.androidOpen === "home") {
      androidHome();
    } else {
      openAndroidView(openButton.dataset.androidOpen);
    }
    return;
  }

  if (event.target.closest("[data-android-clear-recents]")) {
    state.androidRecents = [];
    renderAndroidView();
  }
});
els.emustarInfoLink.addEventListener("click", () => {
  openPopupFrom(els.emustarInfoDialog, els.emustarInfoLink, els.emustarInfoOkButton);
});
els.emustarInfoOkButton.addEventListener("click", () => {
  closePopupTo(els.emustarInfoDialog, els.emustarInfoLink);
});
els.emustarInfoDialog.addEventListener("click", (event) => {
  if (event.target === els.emustarInfoDialog) {
    closePopupTo(els.emustarInfoDialog, els.emustarInfoLink);
  }
});
const closeNintendoHelpDialog = () => {
  closePopupTo(els.nintendoHelpDialog, els.nintendoHelpLink);
};
els.nintendoHelpLink.addEventListener("click", () => {
  els.nintendoHelpPanel.scrollTop = 0;
  openPopupFrom(els.nintendoHelpDialog, els.nintendoHelpLink, els.nintendoHelpPanel);
});
els.nintendoHelpOkButton.addEventListener("click", closeNintendoHelpDialog);
els.nintendoHelpDialog.addEventListener("click", (event) => {
  if (event.target === els.nintendoHelpDialog) {
    closeNintendoHelpDialog();
  }
});
let nebulaConflictTrigger = null;
const closeNebulaConflictDialog = () => {
  closePopupTo(els.nebulaConflictDialog, nebulaConflictTrigger);
};
els.nebulaConflictLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    nebulaConflictTrigger = link;
    els.nebulaConflictPanel.scrollTop = 0;
    openPopupFrom(els.nebulaConflictDialog, link, els.nebulaConflictPanel);
  });
});
els.nebulaConflictOkButton.addEventListener("click", closeNebulaConflictDialog);
els.nebulaConflictDialog.addEventListener("click", (event) => {
  if (event.target === els.nebulaConflictDialog) {
    closeNebulaConflictDialog();
  }
});
let faqTrigger = null;
const closeFaqDialog = () => {
  closePopupTo(els.faqDialog, faqTrigger);
};
els.faqLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    faqTrigger = link;
    els.faqPanel.scrollTop = 0;
    openPopupFrom(els.faqDialog, link, els.faqPanel);
  });
});
els.faqOkButton.addEventListener("click", closeFaqDialog);
els.faqDialog.addEventListener("click", (event) => {
  if (event.target === els.faqDialog) {
    closeFaqDialog();
  }
});
const commitHistoryEndpoint = isNetlifyLauncher
  ? "/.netlify/functions/commit-history"
  : "/api/commit-history";
let commitHistoryTrigger = null;
let commitHistoryRecords = [];
let commitHistoryLoaded = false;
const closeCommitHistoryDialog = () => {
  closePopupTo(els.commitHistoryDialog, commitHistoryTrigger);
};
const commitHistoryDate = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Date unavailable"
    : parsed.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};
const renderCommitHistory = () => {
  const query = els.commitHistorySearch.value.trim().toLowerCase();
  const visible = commitHistoryRecords.filter(
    (commit) =>
      !query ||
      commit.message.toLowerCase().includes(query) ||
      commit.sha.toLowerCase().includes(query),
  );
  els.commitHistoryList.replaceChildren();
  visible.forEach((commit) => {
    const button = document.createElement("button");
    button.className = "commit-history-item";
    button.type = "button";
    button.disabled = !commit.available;
    button.setAttribute(
      "aria-label",
      commit.available
        ? `Run commit ${commit.shortSha}: ${commit.message}`
        : `Commit ${commit.shortSha} has no working deployment`,
    );

    const title = document.createElement("span");
    title.className = "commit-history-item-title";
    title.textContent = commit.message;

    const metadata = document.createElement("span");
    metadata.className = "commit-history-item-meta";
    const sha = document.createElement("code");
    sha.textContent = commit.shortSha;
    const date = document.createElement("span");
    date.textContent = commitHistoryDate(commit.authoredAt);
    metadata.append(sha, date);

    const badges = document.createElement("span");
    badges.className = "commit-history-item-badges";
    if (commit.latestWorking) {
      const latest = document.createElement("strong");
      latest.textContent = "Latest working";
      badges.append(latest);
    }
    if (commit.shortSha === COMMIT_ID) {
      const current = document.createElement("strong");
      current.textContent = "Current";
      badges.append(current);
    }
    if (!commit.available) {
      const unavailable = document.createElement("em");
      unavailable.textContent = "No working deploy";
      badges.append(unavailable);
    }

    button.append(title, metadata, badges);
    if (commit.available) {
      button.addEventListener("click", () => {
        window.location.assign(commit.deployUrl);
      });
    }
    els.commitHistoryList.append(button);
  });
  els.commitHistoryStatus.textContent = visible.length
    ? `${visible.length} of ${commitHistoryRecords.length} commits`
    : "No commits match that search.";
};
const loadCommitHistory = async () => {
  if (commitHistoryLoaded) {
    renderCommitHistory();
    return;
  }
  els.commitHistoryStatus.textContent = "Loading commit history...";
  els.commitHistoryList.replaceChildren();
  try {
    const response = await fetch(commitHistoryEndpoint, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !Array.isArray(data.commits)) {
      throw new Error(data.error || "Commit history could not be loaded.");
    }
    commitHistoryRecords = data.commits;
    commitHistoryLoaded = true;
    renderCommitHistory();
  } catch (error) {
    els.commitHistoryStatus.textContent = error.message;
  }
};
els.commitHistoryLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    commitHistoryTrigger = link;
    els.commitHistoryPanel.scrollTop = 0;
    els.commitHistorySearch.value = "";
    openPopupFrom(els.commitHistoryDialog, link, els.commitHistorySearch);
    void loadCommitHistory();
  });
});
els.commitHistorySearch.addEventListener("input", renderCommitHistory);
els.commitHistoryCloseButton.addEventListener("click", closeCommitHistoryDialog);
els.commitHistoryDialog.addEventListener("click", (event) => {
  if (event.target === els.commitHistoryDialog) {
    closeCommitHistoryDialog();
  }
});
const problemReportEndpoint = isNetlifyLauncher
  ? "/.netlify/functions/report-problem"
  : "/api/report-problem";
const problemReportLockedLabel = "Can\u2019t report now. Reason: profane language.";
const problemReportOutdatedLabel =
  "Can\u2019t report right now. Reason: security feature outdated";
let problemReportTrigger = null;
let problemReportLockedUntil = 0;
let problemReportLockTimer = null;
let problemReportSending = false;
const closeProblemReportDialog = () => {
  closePopupTo(els.problemReportDialog, problemReportTrigger);
};
const updateProblemReportCharacterCount = () => {
  els.problemReportCharacterCount.textContent = String(els.problemReportDescription.value.length);
};
const problemReportingIsLocked = () =>
  isHistoricalNetlifyDeploy || problemReportLockedUntil > Date.now();
const problemReportLockLabel = () => {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((problemReportLockedUntil - Date.now()) / 1000),
  );
  const minutes = String(Math.floor(remainingSeconds / 60)).padStart(2, "0");
  const seconds = String(remainingSeconds % 60).padStart(2, "0");
  return `${problemReportLockedLabel} ${minutes}:${seconds} remaining.`;
};
const renderProblemReportPrivilege = () => {
  const locked = problemReportingIsLocked();
  const disabledLabel = isHistoricalNetlifyDeploy
    ? problemReportOutdatedLabel
    : problemReportLockLabel();
  els.problemReportLinks.forEach((link) => {
    link.dataset.reportLabel ||= link.textContent;
    link.dataset.reportHref ||= link.getAttribute("href") || "#report-problem";
    link.textContent = locked ? disabledLabel : link.dataset.reportLabel;
    link.classList.toggle("is-disabled", locked);
    link.setAttribute("aria-disabled", String(locked));
    if (locked) {
      link.removeAttribute("href");
      link.tabIndex = -1;
    } else {
      link.setAttribute("href", link.dataset.reportHref);
      link.removeAttribute("tabindex");
    }
  });
  els.problemReportSubmitButton.disabled = locked || problemReportSending;

  window.clearTimeout(problemReportLockTimer);
  problemReportLockTimer = null;
  if (locked && !isHistoricalNetlifyDeploy) {
    problemReportLockTimer = window.setTimeout(() => {
      if (problemReportingIsLocked()) {
        renderProblemReportPrivilege();
        return;
      }
      problemReportLockedUntil = 0;
      renderProblemReportPrivilege();
      void refreshProblemReportPrivilege();
    }, Math.min(1000, problemReportLockedUntil - Date.now() + 100));
  }
};
const applyProblemReportPrivilege = (data = {}) => {
  if (isHistoricalNetlifyDeploy) {
    renderProblemReportPrivilege();
    return;
  }
  const lockoutUntil = Date.parse(data.lockoutUntil || "");
  problemReportLockedUntil =
    data.canReport === false && Number.isFinite(lockoutUntil) && lockoutUntil > Date.now()
      ? lockoutUntil
      : 0;
  renderProblemReportPrivilege();
};
const refreshProblemReportPrivilege = async () => {
  if (isHistoricalNetlifyDeploy) {
    renderProblemReportPrivilege();
    return;
  }
  try {
    const response = await fetch(problemReportEndpoint, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok) applyProblemReportPrivilege(data);
  } catch {
    // A temporary status failure should not prevent the rest of NebulaVM from loading.
  }
};
els.problemReportLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (problemReportingIsLocked()) return;
    problemReportTrigger = link;
    els.problemReportFeedback.textContent = "";
    els.problemReportFeedback.className = "problem-report-feedback";
    els.problemReportPanel.scrollTop = 0;
    updateProblemReportCharacterCount();
    openPopupFrom(els.problemReportDialog, link, els.problemReportType);
  });
});
els.problemReportDescription.addEventListener("input", () => {
  els.problemReportDescription.setCustomValidity("");
  updateProblemReportCharacterCount();
});
els.problemReportBackButton.addEventListener("click", closeProblemReportDialog);
els.problemReportDialog.addEventListener("click", (event) => {
  if (event.target === els.problemReportDialog) {
    closeProblemReportDialog();
  }
});
els.problemReportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (problemReportingIsLocked()) {
    els.problemReportFeedback.className = "problem-report-feedback is-error";
    els.problemReportFeedback.textContent = isHistoricalNetlifyDeploy
      ? problemReportOutdatedLabel
      : problemReportLockedLabel;
    return;
  }
  const description = els.problemReportDescription.value.trim();
  els.problemReportDescription.setCustomValidity(
    description.length < 20 ? "Please enter at least 20 characters." : "",
  );
  if (!els.problemReportForm.reportValidity()) return;

  problemReportSending = true;
  renderProblemReportPrivilege();
  els.problemReportSubmitButton.textContent = "Sending...";
  els.problemReportFeedback.className = "problem-report-feedback";
  els.problemReportFeedback.textContent = "Sending your report...";
  try {
    const response = await fetch(problemReportEndpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bugType: els.problemReportType.value,
        description,
        email: els.problemReportEmail.value.trim(),
        website: els.problemReportWebsite.value,
        page: window.location.href,
        commit: COMMIT_ID,
        userAgent: navigator.userAgent,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if ("canReport" in data || data.lockoutUntil) {
      applyProblemReportPrivilege(data);
    }
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "The report could not be sent.");
    }
    els.problemReportForm.reset();
    updateProblemReportCharacterCount();
    els.problemReportFeedback.className = "problem-report-feedback is-success";
    els.problemReportFeedback.textContent = data.message || "Your report was sent. Thank you.";
  } catch (error) {
    els.problemReportFeedback.className = "problem-report-feedback is-error";
    els.problemReportFeedback.textContent = error.message;
  } finally {
    problemReportSending = false;
    renderProblemReportPrivilege();
    els.problemReportSubmitButton.textContent = "Submit";
  }
});
renderProblemReportPrivilege();
void refreshProblemReportPrivilege();
els.emustarCopyShareButton.addEventListener("click", async () => {
  const shareUrl = els.emustarShareUrl.value;
  if (!shareUrl) return;
  try {
    await navigator.clipboard.writeText(shareUrl);
    els.emustarShareStatus.textContent = "Browser link copied.";
  } catch {
    els.emustarShareUrl.focus();
    els.emustarShareUrl.select();
    els.emustarShareStatus.textContent = "Link selected. Copy it with Ctrl+C.";
  }
});
els.emulatorSelectButton.addEventListener("click", () => {
  setEmulatorMenuOpen(els.emulatorMenu.hidden);
});
els.emulatorMenuOptions.forEach((option) => {
  option.addEventListener("click", async () => {
    if (state.emulator && option.dataset.emulatorOption !== els.emulatorMode.value) {
      await stopEmulator();
    }
    els.emulatorMode.value = option.dataset.emulatorOption;
    setEmulatorMenuOpen(false);
    updateBackendUi();
    els.emulatorSelectButton.focus();
  });
});
els.storedImagesButton.addEventListener("click", () => {
  setStoredImagesMenuOpen(!state.storedImagesMenuOpen);
});
els.windowsTemplateButton.addEventListener("click", () => {
  void selectWindows11Template({ boot: true });
});
els.storedIsoInput.addEventListener("change", () => {
  const [file] = els.storedIsoInput.files || [];
  if (file) {
    void addStoredIsoFromFile(file);
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".emulator-dropdown")) {
    setEmulatorMenuOpen(false);
  }
  if (!event.target.closest(".stored-images-control")) {
    setStoredImagesMenuOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (state.virtualKeyboardOpen) {
      setVirtualKeyboardOpen(false);
    }
    setEmulatorMenuOpen(false);
    setStoredImagesMenuOpen(false);
    if (!els.keepIsoDialog.hidden) {
      els.keepIsoNoButton.click();
    }
    if (!els.emustarInfoDialog.hidden) {
      closePopupTo(els.emustarInfoDialog, els.emustarInfoLink);
    }
    if (!els.nebulaConflictDialog.hidden) {
      closeNebulaConflictDialog();
    }
    if (!els.faqDialog.hidden) {
      closeFaqDialog();
    }
    if (!els.commitHistoryDialog.hidden) {
      closeCommitHistoryDialog();
    }
    if (!els.problemReportDialog.hidden) {
      closeProblemReportDialog();
    }
  }
});
els.processorMode.addEventListener("change", () => {
  els.emulatorMode.value =
    els.processorMode.value === "arm64"
      ? "qemu-native-arm64-windows"
      : els.processorMode.value === "x64"
        ? "qemu-x64"
        : "v86";
  updateBackendUi();
});
els.nativeIsoPath.addEventListener("input", () => {
  clearWindowsTemplateSelection();
  updateButtons();
});
els.nativeIsoPath.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || els.nativeIsoPath.value.trim().toLowerCase() !== "meow") return;

  event.preventDefault();
  document.documentElement.classList.add("meow-theme");
  els.nativeIsoPath.value = "";
  updateButtons();
  log("Meow mode activated.");
});
els.windowsUsername.addEventListener("input", () => updateButtons());
els.windowsPassword.addEventListener("input", () => updateButtons());
els.windowsPasswordOff.addEventListener("change", () => updateButtons());
els.nativeCreateDisk.addEventListener("change", () => updateButtons());
els.nativeDisplayMode.addEventListener("change", () => {
  if (shouldForceEmustarViewport()) {
    els.nativeDisplayMode.value = "viewport";
  }
  window.localStorage.setItem("nebulavm.emustar.display", els.nativeDisplayMode.value);
});
els.nativeResetFirmwareButton.addEventListener("click", resetNativeFirmware);
els.nativeConsoleButton.addEventListener("click", openHyperVConsole);
els.remoteVmUrl.addEventListener("input", () => updateButtons());

const screenNativeFullscreenElement = () =>
  document.fullscreenElement ||
  document.webkitFullscreenElement ||
  document.msFullscreenElement ||
  null;

const isScreenNativeFullscreen = () => screenNativeFullscreenElement() === els.screenShell;
const isScreenFullscreen = () => isScreenNativeFullscreen() || state.screenAppFullscreen;
const prefersScreenAppFullscreen = () =>
  isRemoteMode() && (isPublicMobileClient || window.matchMedia?.("(pointer: coarse), (max-width: 760px)")?.matches);

const updateFullscreenButton = () => {
  setScreenVisualViewportSize();
  const isFullscreen = isScreenFullscreen();
  els.fullscreenButton.textContent = isFullscreen ? "Exit fullscreen" : "Fullscreen";
  els.screenShell.classList.toggle("is-fullscreen", isFullscreen);
  document.body.classList.toggle("screen-app-fullscreen", state.screenAppFullscreen);
  els.screenFullscreenExitButton.hidden = !isFullscreen;
  requestGuestDesktopResize(isFullscreen ? "fullscreen" : "windowed viewport");
};

const enterScreenAppFullscreen = () => {
  state.screenAppFullscreen = true;
  window.scrollTo(0, 0);
  updateFullscreenButton();
};

const exitScreenAppFullscreen = () => {
  state.screenAppFullscreen = false;
  updateFullscreenButton();
};

const requestScreenNativeFullscreen = async () => {
  const request =
    els.screenShell.requestFullscreen ||
    els.screenShell.webkitRequestFullscreen ||
    els.screenShell.msRequestFullscreen;
  if (!request) return false;
  await request.call(els.screenShell);
  return true;
};

const exitScreenNativeFullscreen = async () => {
  const exit =
    document.exitFullscreen ||
    document.webkitExitFullscreen ||
    document.msExitFullscreen;
  if (exit) await exit.call(document);
};

const toggleFullscreen = async () => {
  try {
    if (state.screenAppFullscreen) {
      exitScreenAppFullscreen();
    } else if (isScreenNativeFullscreen()) {
      await exitScreenNativeFullscreen();
    } else if (prefersScreenAppFullscreen()) {
      enterScreenAppFullscreen();
    } else {
      const nativeStarted = await requestScreenNativeFullscreen();
      if (!nativeStarted || !isScreenNativeFullscreen()) enterScreenAppFullscreen();
    }
  } catch (error) {
    enterScreenAppFullscreen();
    log(`Fullscreen used mobile fallback: ${error.message}`);
  }
  updateFullscreenButton();
};

const refreshScreenViewportSize = () => {
  setScreenVisualViewportSize();
  if (!isScreenFullscreen()) {
    requestGuestDesktopResize("browser resize");
    return;
  }
  state.hyperVConsolePollNow?.(8);
  requestGuestDesktopResize("fullscreen viewport resize");
};

els.fullscreenButton.addEventListener("click", toggleFullscreen);
els.screenFullscreenExitButton.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", updateFullscreenButton);
document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
window.addEventListener("resize", refreshScreenViewportSize);
window.addEventListener("orientationchange", refreshScreenViewportSize);
window.visualViewport?.addEventListener("resize", refreshScreenViewportSize);
window.visualViewport?.addEventListener("scroll", refreshScreenViewportSize);
setScreenVisualViewportSize();
els.virtualKeyboardButton.addEventListener("click", () => {
  setVirtualKeyboardOpen(!state.virtualKeyboardOpen);
});
els.virtualKeyboardClose.addEventListener("click", () => {
  setVirtualKeyboardOpen(false);
});
els.virtualKeyboardSend.addEventListener("click", async () => {
  const text = els.virtualKeyboardText.value;
  if (!text) return;
  await sendVirtualKeyboardText(text);
  els.virtualKeyboardText.value = "";
});
els.virtualKeyboardText.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  els.virtualKeyboardSend.click();
});
els.virtualKeyboardKeys.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) {
    event.preventDefault();
  }
});
els.virtualKeyboardKeys.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-keyboard-type]");
  if (!button) return;
  const type = button.dataset.keyboardType;
  const key = button.dataset.keyboardKey || "";

  if (type === "shift") {
    state.virtualKeyboardShift = !state.virtualKeyboardShift;
    renderVirtualKeyboard();
    return;
  }

  if (type === "text") {
    const text =
      state.virtualKeyboardShift && key.length === 1 && /[a-z]/.test(key)
        ? key.toUpperCase()
        : key;
    await sendVirtualKeyboardKey(text, { text: true });
    if (state.virtualKeyboardShift && key !== " ") {
      state.virtualKeyboardShift = false;
      renderVirtualKeyboard();
    }
    return;
  }

  await sendVirtualKeyboardKey(key);
});

els.clearLogButton.addEventListener("click", () => {
  els.logOutput.textContent = "";
});

window.addEventListener("pagehide", () => {
  void cleanupStagedHostIso({ keepalive: true, silent: true, cleanupPartial: true });
  if (state.androidNativeActive && state.nativeQemuApiBase) {
    const headers = {
      "X-NebulaVM-Session": state.nativeSessionId,
      ...(state.nativeHostToken ? { Authorization: `Bearer ${state.nativeHostToken}` } : {}),
      ...(isPublicMobileClient ? { "X-NebulaVM-Client-Class": "public-mobile" } : {}),
    };
    void fetch(`${state.nativeQemuApiBase}/api/android-emulator/stop`, {
      method: "POST",
      headers,
      keepalive: true,
    }).catch(() => {});
  }
});
window.addEventListener("beforeunload", () => {
  stopAndroidLeaseHeartbeat();
  void cleanupStagedHostIso({ keepalive: true, silent: true, cleanupPartial: true });
  void stopEmulator();
});

if (MOBILE_DEV_GATE_ENABLED) {
  initMobileDevBypass();
  void validateSavedMobileDevMode();
} else if (isMobileOrTabletDevice()) {
  applyMobileDevMode();
}

log("NebulaVM ready.");
renderStoredIsoSlots();
updateBackendUi();
void connectNetlifyHostRegistry();
state.nativeStatusRefreshTimer = window.setInterval(() => {
  if (!isNativeMode()) return;
  if (state.hostStagedIsoUploading) return;
  void updateNativeStatus();
}, 5000);
updateButtons();
