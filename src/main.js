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
const GOOGLE_PICKER_API_KEY = import.meta.env.VITE_GOOGLE_API_KEY || "";
const GOOGLE_PICKER_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const GOOGLE_PICKER_APP_ID =
  import.meta.env.VITE_GOOGLE_APP_ID || (GOOGLE_PICKER_CLIENT_ID.match(/^\d+/)?.[0] || "");
const GOOGLE_DRIVE_PICKER_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_DRIVE_OAUTH_STATE_KEY = "nebulavm.googleDrive.oauthState";
const isNetlifyLauncher = /\.netlify\.app$/i.test(window.location.hostname);

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

if (isMobileOrTabletDevice()) {
  document.documentElement.classList.add("is-mobile-device");
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

const googleDriveOAuthParams = new URLSearchParams(window.location.hash.slice(1));
const expectedGoogleDriveOAuthState = window.sessionStorage.getItem(GOOGLE_DRIVE_OAUTH_STATE_KEY) || "";
const googleDriveOAuthStateMatches =
  expectedGoogleDriveOAuthState && googleDriveOAuthParams.get("state") === expectedGoogleDriveOAuthState;
const googleDriveOAuthAccessTokenFromUrl = googleDriveOAuthStateMatches
  ? googleDriveOAuthParams.get("access_token") || ""
  : "";
const googleDriveOAuthExpiresInFromUrl = googleDriveOAuthStateMatches
  ? Number(googleDriveOAuthParams.get("expires_in") || 3600) || 3600
  : 0;
const googleDriveOAuthErrorFromUrl = googleDriveOAuthStateMatches
  ? googleDriveOAuthParams.get("error_description") || googleDriveOAuthParams.get("error") || ""
  : "";
const shouldResumeGoogleDrivePicker = Boolean(googleDriveOAuthAccessTokenFromUrl);
if (googleDriveOAuthStateMatches) {
  window.sessionStorage.removeItem(GOOGLE_DRIVE_OAUTH_STATE_KEY);
  for (const key of [
    "access_token",
    "authuser",
    "error",
    "error_description",
    "expires_in",
    "hd",
    "prompt",
    "scope",
    "state",
    "token_type",
  ]) {
    googleDriveOAuthParams.delete(key);
  }
  const cleanHash = googleDriveOAuthParams.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${cleanHash ? `#${cleanHash}` : ""}`,
  );
}

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
  nativeRfb: null,
  nativeRuntimeName: null,
  nativeMonitorTimer: null,
  hyperVConsoleTimer: null,
  hyperVConsoleActive: false,
  hyperVConsoleCleanup: null,
  hyperVConsoleFrameUrl: null,
  guestResizeTimer: null,
  lastGuestResize: "",
  viewportSummaryTimer: null,
  driveImportPolling: false,
  activeDriveImportId: null,
  googlePickerAccessToken: "",
  googlePickerTokenExpiresAt: 0,
  hostStagedIsoBase: "",
  hostStagedIsoFileKey: "",
  hostStagedIsoPath: "",
  hostStagedIsoSessionId: "",
  hostStagedIsoUploadPromise: null,
  hostStagedIsoUploading: false,
};
if (googleDriveOAuthAccessTokenFromUrl) {
  state.googlePickerAccessToken = googleDriveOAuthAccessTokenFromUrl;
  state.googlePickerTokenExpiresAt = Date.now() + googleDriveOAuthExpiresInFromUrl * 1000;
}

app.innerHTML = `
  <main class="mobile-unsupported" aria-labelledby="mobileUnsupportedTitle">
    <img class="mobile-unsupported-image" src="/assets/mobile-not-supported.png" alt="NebulaVM mobile and tablet devices not supported" />
    <section class="mobile-unsupported-copy">
      <h1 id="mobileUnsupportedTitle">Mobile and Tablet Not Supported</h1>
      <p>NebulaVM is currently available only on desktop and laptop browsers. Mobile and tablet support is still in development.</p>
      <p>Please visit this page from a computer to launch a virtual machine. Thank you for your patience!</p>
    </section>
    <small class="commit-id">Commit ${COMMIT_ID} <a href="https://github.com/robird50/NebulaVM">Source Code</a></small>
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
        NebulaVM is an open-source, browser-based virtual machine platform that makes running operating systems simple. Launch lightweight virtual machines directly in your browser, or use the optional EMUSTAR host for more flexible virtualization and support for modern 64-bit operating systems like Windows 11. With drag-and-drop ISO support, configurable hardware, fullscreen mode, and a clean interface, NebulaVM brings virtualization to the web while remaining <strong>free forever</strong>.
      </p>
      <div class="status-pill" id="powerState">
        <span class="status-dot"></span>
        <span>Powered off</span>
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
              <option value="emustar-hyperv">EMUSTAR x64 / Hyper-V</option>
              <option value="qemu-native-x64">QEMU x64 / large ISO</option>
              <option value="qemu-native-arm64-windows">QEMU ARM64 / Windows</option>
              <option value="qemu-native-arm64-ubuntu">QEMU ARM64 / Ubuntu</option>
              <option value="remote-vm">Remote VM / browser stream</option>
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
                  <img class="emulator-menu-icon" src="/assets/emustar-icon.png" alt="" />
                  <span>EMUSTAR x64 / Hyper-V</span>
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
              </div>
            </div>
            <button class="emustar-info-link" id="emustarInfoLink" type="button" hidden>
              What in the world is EMUSTAR?
            </button>
          </div>

          <label class="field full-span">
            <span>Processor</span>
            <select id="processorMode">
              <option value="x86">32-bit x86 processor</option>
              <option value="x64">64-bit x86_64 processor</option>
              <option value="arm64">64-bit ARM64 processor</option>
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

        <details class="advanced-options" id="advancedOptions">
          <summary>
            <span>More options</span>
            <small>Runtime, storage, network, and state tools</small>
          </summary>

          <div class="advanced-options-body">
            <div class="native-panel" id="nativePanel" hidden>
              <div class="emustar-runtime-heading">
                <img id="nativeRuntimeIcon" src="/assets/emustar-icon.png" alt="" />
                <span>
                  <span class="emustar-console-kicker">Nebula Console</span>
                  <strong id="nativeRuntimeName">EMUSTAR</strong>
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

              <div class="drive-import-panel">
                <div class="drive-import-heading">
                  <img src="/assets/google-drive-icon.webp" alt="" />
                  <span>Google Drive import</span>
                </div>
                <div class="drive-import-actions">
                  <button class="secondary" id="drivePickerButton" type="button">Choose from Drive</button>
                </div>
                <small id="driveImportStatus">No Drive import running.</small>
                <div class="drive-import-progress" id="driveImportProgress" hidden>
                  <div
                    class="drive-import-track"
                    role="progressbar"
                    aria-label="Google Drive ISO import progress"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow="0"
                  >
                    <span id="driveImportProgressFill"></span>
                  </div>
                  <div class="drive-import-stats">
                    <span id="driveImportProgressText">0% - 0 B</span>
                    <span id="driveImportSpeed">0 KB/s</span>
                  </div>
                </div>
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
                title="Open the EMUSTAR setup console on this host"
                hidden
              >Open host console</button>

              <p class="native-status" id="nativeStatus">Checking EMUSTAR...</p>
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
            <img class="emustar-console-mark" src="/assets/emustar-icon.png" alt="" />
            <div>
              <p class="kicker" id="displayKicker">Display</p>
              <h2 id="machineTitle">Awaiting boot media</h2>
            </div>
          </div>
          <div class="metric-row">
            <span id="uptimeMetric">00:00</span>
            <span class="ai-summary-pill" id="viewportSummaryMetric" aria-live="polite">
              <span class="ai-summary-stage">
                <span class="ai-summary-text is-current">Waiting for boot media to start</span>
              </span>
            </span>
            <span id="ramMetric">128 MB RAM</span>
            <button class="secondary compact-button" id="fullscreenButton" type="button">Fullscreen</button>
          </div>
        </div>

        <div class="screen-shell" id="screenShell">
          <div id="screenContainer" class="screen-container">
            <div class="vga-text"></div>
            <canvas class="vga-canvas"></canvas>
            <pre class="qemu-terminal" id="qemuTerminal" hidden></pre>
            <div class="native-display" id="nativeDisplay" hidden></div>
            <iframe class="remote-frame" id="remoteFrame" title="Remote VM display" hidden></iframe>
            <div class="screen-placeholder" id="screenPlaceholder">
              <img class="screen-mode-icon" id="screenModeIcon" src="/assets/emustar-icon.png" alt="" hidden />
              <span class="orbital" id="screenOrbital"></span>
              <strong id="placeholderTitle">Drop an ISO to begin</strong>
              <small id="placeholderMeta">Legacy x86, 32-bit Linux, DOS, hobby OS, and vintage Windows images work best.</small>
            </div>
          </div>
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
    <footer class="commit-id">Commit ${COMMIT_ID} <a href="https://github.com/robird50/NebulaVM">Source Code</a></footer>
  </main>

  <div class="display-choice-overlay" id="emustarInfoDialog" role="dialog" aria-modal="true" aria-labelledby="emustarInfoTitle" hidden>
    <section class="display-choice-panel emustar-info-panel">
      <img class="emustar-info-icon" src="/assets/emustar-icon.png" alt="" />
      <h2 id="emustarInfoTitle">EMUSTAR</h2>
      <div class="emustar-info-copy">
        <p>
          EMUSTAR is NebulaVM's Windows virtualization runtime. It creates and controls a Generation 2 Hyper-V machine with its own VHDX disk, Secure Boot capability, virtual TPM, ISO drive, memory, processors, and boot order.
        </p>
        <p>
          Microsoft Hyper-V performs the hardware virtualization; QEMU is not involved. EMUSTAR handles the friendlier controls and keeps the intimidating switches behind the curtain, where intimidating switches are happiest.
        </p>
      </div>
      <div class="emustar-info-actions">
        <button class="primary" id="emustarInfoOkButton" type="button">OK</button>
      </div>
    </section>
  </div>
`;

const els = {
  dropZone: document.querySelector("#dropZone"),
  isoInput: document.querySelector("#isoInput"),
  isoMeta: document.querySelector("#isoMeta"),
  mediaWarning: document.querySelector("#mediaWarning"),
  demoButton: document.querySelector("#demoButton"),
  emulatorMode: document.querySelector("#emulatorMode"),
  emulatorSelectButton: document.querySelector("#emulatorSelectButton"),
  emulatorSelectedIcon: document.querySelector("#emulatorSelectedIcon"),
  emulatorSelectedText: document.querySelector("#emulatorSelectedText"),
  emulatorMenu: document.querySelector("#emulatorMenu"),
  emulatorMenuOptions: [...document.querySelectorAll("[data-emulator-option]")],
  workspace: document.querySelector("#workspace"),
  mediaKicker: document.querySelector("#mediaKicker"),
  bootSourceTitle: document.querySelector("#bootSourceTitle"),
  emustarInfoLink: document.querySelector("#emustarInfoLink"),
  emustarInfoDialog: document.querySelector("#emustarInfoDialog"),
  emustarInfoOkButton: document.querySelector("#emustarInfoOkButton"),
  processorMode: document.querySelector("#processorMode"),
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
  drivePickerButton: document.querySelector("#drivePickerButton"),
  driveImportStatus: document.querySelector("#driveImportStatus"),
  driveImportProgress: document.querySelector("#driveImportProgress"),
  driveImportProgressFill: document.querySelector("#driveImportProgressFill"),
  driveImportProgressText: document.querySelector("#driveImportProgressText"),
  driveImportSpeed: document.querySelector("#driveImportSpeed"),
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
  nativeDisplay: document.querySelector("#nativeDisplay"),
  remoteFrame: document.querySelector("#remoteFrame"),
  placeholderMeta: document.querySelector("#placeholderMeta"),
  placeholderTitle: document.querySelector("#placeholderTitle"),
  screenModeIcon: document.querySelector("#screenModeIcon"),
  screenOrbital: document.querySelector("#screenOrbital"),
  displayKicker: document.querySelector("#displayKicker"),
  activityLabel: document.querySelector("#activityLabel"),
  machineTitle: document.querySelector("#machineTitle"),
  powerState: document.querySelector("#powerState"),
  uptimeMetric: document.querySelector("#uptimeMetric"),
  viewportSummaryMetric: document.querySelector("#viewportSummaryMetric"),
  ramMetric: document.querySelector("#ramMetric"),
  logOutput: document.querySelector("#logOutput"),
  clearLogButton: document.querySelector("#clearLogButton"),
};

const savedNativeDisplayMode = window.localStorage.getItem("nebulavm.emustar.display");
if (savedNativeDisplayMode === "viewport" || savedNativeDisplayMode === "external") {
  els.nativeDisplayMode.value = savedNativeDisplayMode;
}

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
  ? "NebulaVM is looking for a live host session. Keep the Windows host PC online, then refresh this page."
  : "Native runtimes need the local NebulaVM bridge. Run NebulaVM locally with npm run host, then keep this page open.";

const fetchNativeQemuJson = async (path, options) => {
  const bridgeBases = [
    state.nativeQemuApiBase,
    window.location.origin,
    "http://127.0.0.1:5174",
    "http://localhost:5174",
  ].filter(Boolean);
  const uniqueBridgeBases = [...new Set(bridgeBases.map((base) => base.replace(/\/$/, "")))];
  let lastError = new Error(nativeQemuBridgeMessage);

  for (const base of uniqueBridgeBases) {
    try {
      const headers = new Headers(options?.headers || {});
      if (state.nativeHostToken) {
        headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      }
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

const fetchHyperVJson = async (path, options) => {
  const bridgeBases = [
    state.nativeQemuApiBase,
    window.location.origin,
    "http://127.0.0.1:5174",
    "http://localhost:5174",
  ].filter(Boolean);
  const uniqueBridgeBases = [...new Set(bridgeBases.map((base) => base.replace(/\/$/, "")))];
  let lastError = new Error(nativeQemuBridgeMessage);

  for (const base of uniqueBridgeBases) {
    try {
      const headers = new Headers(options?.headers || {});
      if (state.nativeHostToken) {
        headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      }
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

const fetchHyperVFrame = async () => {
  const bridgeBases = [
    state.nativeQemuApiBase,
    window.location.origin,
    "http://127.0.0.1:5174",
    "http://localhost:5174",
  ].filter(Boolean);
  const uniqueBridgeBases = [...new Set(bridgeBases.map((base) => base.replace(/\/$/, "")))];
  let lastError = new Error(nativeQemuBridgeMessage);

  for (const base of uniqueBridgeBases) {
    try {
      const headers = new Headers();
      if (state.nativeHostToken) {
        headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      }
      const response = await fetch(`${base}/api/emustar-hyperv/console-frame`, {
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

const viewportDesktopSize = () => {
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

  rfb.background = "#05070a";
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  window.requestAnimationFrame(() => {
    if (state.nativeRfb === rfb && typeof rfb._requestRemoteResize === "function") {
      rfb._requestRemoteResize();
    }
  });
};

const requestGuestDesktopResize = (reason = "viewport") => {
  requestRfbDesktopResize();

  if (els.emulatorMode.value !== "emustar-hyperv" || state.nativeRuntimeName !== "EMUSTAR" || !state.running) {
    return;
  }

  window.clearTimeout(state.guestResizeTimer);
  state.guestResizeTimer = window.setTimeout(async () => {
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
        log(`Extended EMUSTAR desktop to ${data.width}x${data.height} for ${reason}.`);
      } else {
        log("Asked the guest to extend its desktop; if it refuses, NebulaVM will keep the image contained without stretching.");
      }
    } catch (error) {
      log(`Guest display resize unavailable: ${error.message}`);
    }
  }, 350);
};

const fetchEmustarHostJson = async (path, options) => {
  const bridgeBases = [
    state.nativeQemuApiBase,
    window.location.origin,
    "http://127.0.0.1:5174",
    "http://localhost:5174",
  ].filter(Boolean);
  const uniqueBridgeBases = [...new Set(bridgeBases.map((base) => base.replace(/\/$/, "")))];
  let lastError = new Error(nativeQemuBridgeMessage);

  for (const base of uniqueBridgeBases) {
    try {
      const headers = new Headers(options?.headers || {});
      if (state.nativeHostToken) {
        headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
      }
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

  throw new Error(lastError.message || nativeQemuBridgeMessage);
};

const emustarHostBaseCandidates = () => {
  const bridgeBases = [
    state.nativeQemuApiBase,
    window.location.origin,
    "http://127.0.0.1:5174",
    "http://localhost:5174",
  ].filter(Boolean);
  return [...new Set(bridgeBases.map((base) => base.replace(/\/$/, "")))];
};

const browserIsoFileKey = (file) => (file ? `${file.name}:${file.size}:${file.lastModified || 0}` : "");

const uploadBrowserIsoToBase = (base, file, onProgress) =>
  new Promise((resolveUpload, rejectUpload) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}/api/emustar-host/upload-iso`, true);
    xhr.responseType = "json";
    if (state.nativeHostToken) {
      xhr.setRequestHeader("Authorization", `Bearer ${state.nativeHostToken}`);
    }
    xhr.setRequestHeader("X-NebulaVM-Filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-NebulaVM-Session", state.nativeSessionId);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress?.(Math.max(0, Math.min(100, (event.loaded / event.total) * 100)));
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
    xhr.onabort = () => rejectUpload(new Error("Browser ISO upload was canceled."));
    xhr.send(file);
  });

const uploadBrowserIsoToHost = async (file, onProgress) => {
  let lastError = new Error(nativeQemuBridgeMessage);
  for (const base of emustarHostBaseCandidates()) {
    try {
      state.hostStagedIsoBase = base;
      const data = await uploadBrowserIsoToBase(base, file, onProgress);
      state.nativeQemuApiBase = base;
      return { data, base };
    } catch (error) {
      lastError = error instanceof TypeError ? new Error(nativeQemuBridgeMessage) : error;
    }
  }
  throw new Error(lastError.message || nativeQemuBridgeMessage);
};

const cleanupStagedHostIso = async ({ keepalive = false, silent = false } = {}) => {
  const sessionId = state.hostStagedIsoSessionId || state.nativeSessionId;
  const shouldCleanup = Boolean(state.hostStagedIsoPath || state.hostStagedIsoSessionId);
  if (!shouldCleanup || !sessionId) return;

  const resetStagedState = () => {
    if (els.nativeIsoPath.value.trim() === state.hostStagedIsoPath) {
      els.nativeIsoPath.value = "";
    }
    state.hostStagedIsoBase = "";
    state.hostStagedIsoFileKey = "";
    state.hostStagedIsoPath = "";
    state.hostStagedIsoSessionId = "";
    state.hostStagedIsoUploadPromise = null;
    state.hostStagedIsoUploading = false;
  };

  if (keepalive) {
    const base = (state.hostStagedIsoBase || state.nativeQemuApiBase || window.location.origin).replace(/\/$/, "");
    const params = new URLSearchParams({ sessionId });
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
    if (!silent) log("Removed browser-staged ISO from the EMUSTAR host.");
  } catch (error) {
    if (!silent) log(`Could not remove browser-staged ISO: ${error.message}`);
  } finally {
    resetStagedState();
    updateButtons();
  }
};

const stageSelectedIsoForEmustar = async (file = state.isoFile) => {
  if (!isHyperVMode() || !file) return els.nativeIsoPath.value.trim();

  const fileKey = browserIsoFileKey(file);
  if (state.hostStagedIsoPath && state.hostStagedIsoFileKey === fileKey) {
    els.nativeIsoPath.value = state.hostStagedIsoPath;
    updateButtons();
    return state.hostStagedIsoPath;
  }
  if (state.hostStagedIsoUploadPromise && state.hostStagedIsoFileKey === fileKey) {
    await state.hostStagedIsoUploadPromise;
    return state.hostStagedIsoPath;
  }

  await cleanupStagedHostIso({ silent: true });
  state.hostStagedIsoUploading = true;
  state.hostStagedIsoFileKey = fileKey;
  state.hostStagedIsoSessionId = state.nativeSessionId;
  updateButtons();
  log(`Staging ${file.name} to the EMUSTAR host for this tab.`);

  state.hostStagedIsoUploadPromise = uploadBrowserIsoToHost(file, (percent) => {
    els.isoMeta.textContent = `Staging to host ${Math.floor(percent)}% - ${formatBytes(file.size)}`;
  })
    .then(({ data, base }) => {
      state.hostStagedIsoBase = base;
      state.hostStagedIsoPath = data.isoPath || "";
      state.hostStagedIsoSessionId = data.sessionId || state.nativeSessionId;
      if (!state.hostStagedIsoPath) {
        throw new Error("The EMUSTAR host did not return an ISO path.");
      }
      els.nativeIsoPath.value = state.hostStagedIsoPath;
      els.isoMeta.textContent = `${file.name} staged on host - ${formatBytes(file.size)}`;
      log(`Staged browser ISO on the EMUSTAR host: ${state.hostStagedIsoPath}`);
      return state.hostStagedIsoPath;
    })
    .catch((error) => {
      els.isoMeta.textContent = `${file.name} - host staging failed`;
      log(`Host staging failed: ${error.message}`);
      throw error;
    })
    .finally(() => {
      state.hostStagedIsoUploading = false;
      state.hostStagedIsoUploadPromise = null;
      updateButtons();
    });

  return state.hostStagedIsoUploadPromise;
};

const googlePickerConfigMessage =
  "Google Picker needs VITE_GOOGLE_API_KEY, VITE_GOOGLE_CLIENT_ID, and VITE_GOOGLE_APP_ID.";

const googlePickerConfigured = () =>
  Boolean(GOOGLE_PICKER_API_KEY && GOOGLE_PICKER_CLIENT_ID && GOOGLE_PICKER_APP_ID);

const scriptLoaders = new Map();

const loadExternalScript = (src, id) => {
  if (scriptLoaders.has(src)) return scriptLoaders.get(src);

  const loader = new Promise((resolve, reject) => {
    const existingScript = document.getElementById(id) || document.querySelector(`script[src="${src}"]`);
    if (existingScript?.dataset.loaded === "true") {
      resolve();
      return;
    }

    const script = existingScript || document.createElement("script");
    const cleanup = () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
    const handleLoad = () => {
      script.dataset.loaded = "true";
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`Could not load ${src}`));
    };

    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
    if (!existingScript) {
      script.id = id;
      script.src = src;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  });

  scriptLoaders.set(src, loader);
  loader.catch(() => scriptLoaders.delete(src));
  return loader;
};

const loadGooglePickerApi = async () => {
  if (window.google?.picker) return window.google.picker;

  await loadExternalScript("https://apis.google.com/js/api.js", "google-api-js");

  await new Promise((resolve, reject) => {
    if (!window.gapi?.load) {
      reject(new Error("Google Picker loader was not available."));
      return;
    }

    window.gapi.load("picker", {
      callback: resolve,
      onerror: () => reject(new Error("Google Picker failed to load.")),
      ontimeout: () => reject(new Error("Google Picker timed out while loading.")),
      timeout: 10000,
    });
  });

  if (!window.google?.picker) {
    throw new Error("Google Picker loaded, but the picker API was not available.");
  }
  return window.google.picker;
};

const warmGoogleDrivePicker = () => {
  void loadGooglePickerApi().catch(() => {});
};

const createNonce = () =>
  crypto.getRandomValues
    ? Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const googleDriveRedirectUri = () => `${window.location.origin}${window.location.pathname}`;

const startGoogleDriveRedirectSignIn = () => {
  const oauthState = `nebulavm-drive-${createNonce()}`;
  window.sessionStorage.setItem(GOOGLE_DRIVE_OAUTH_STATE_KEY, oauthState);

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_PICKER_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", googleDriveRedirectUri());
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("scope", GOOGLE_DRIVE_PICKER_SCOPE);
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", "consent select_account");
  authUrl.searchParams.set("state", oauthState);

  window.location.assign(authUrl.toString());
};

const openGoogleDrivePickerDialog = ({ accessToken, onPicked, onCanceled, onError }) => {
  const pickerApi = window.google?.picker;
  if (!pickerApi) {
    onError(new Error("Google signed in, but the Drive Picker library was not ready."));
    return null;
  }

  try {
    const docsView = new pickerApi.DocsView(pickerApi.ViewId.DOCS)
      .setIncludeFolders(false)
      .setMode(pickerApi.DocsViewMode.LIST);
    if (typeof docsView.setEnableDrives === "function") {
      docsView.setEnableDrives(true);
    }

    let pickerBuilder = new pickerApi.PickerBuilder()
      .addView(docsView)
      .setAppId(GOOGLE_PICKER_APP_ID)
      .setOAuthToken(accessToken)
      .setDeveloperKey(GOOGLE_PICKER_API_KEY)
      .setTitle("Choose an ISO or disk image")
      .setCallback((data) => {
        const action = data[pickerApi.Response.ACTION] || data.action;
        if (action === pickerApi.Action.CANCEL || action === "cancel") {
          onCanceled();
          return;
        }
        if (action === pickerApi.Action.ERROR || action === "error") {
          onError(new Error("Google Drive Picker returned an error."));
          return;
        }
        if (action !== pickerApi.Action.PICKED && action !== "picked") return;

        const [document] = data[pickerApi.Response.DOCUMENTS] || [];
        onPicked({
          fileId: document?.[pickerApi.Document.ID] || document?.id || "",
          fileName: document?.[pickerApi.Document.NAME] || document?.name || "google-drive.iso",
        });
      });

    if (typeof pickerBuilder.setOrigin === "function") {
      pickerBuilder = pickerBuilder.setOrigin(window.location.origin);
    }
    if (pickerApi.Feature?.SUPPORT_DRIVES && typeof pickerBuilder.enableFeature === "function") {
      pickerBuilder = pickerBuilder.enableFeature(pickerApi.Feature.SUPPORT_DRIVES);
    }

    const picker = pickerBuilder.build();
    picker.setVisible(true);
    return picker;
  } catch (error) {
    onError(error);
    return null;
  }
};

const startPickerDriveImport = async (fileId, fileName, accessToken) => {
  els.drivePickerButton.disabled = true;
  els.driveImportStatus.textContent = `Starting authenticated Google Drive import for ${fileName || "selected file"}...`;
  updateDriveImportProgress({
    state: "running",
    message: "Starting authenticated Google Drive import...",
    bytesReceived: 0,
    totalBytes: 0,
    speedBytesPerSecond: 0,
  });

  try {
    const { response, data } = await fetchEmustarHostJson("drive-picker-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, fileName, accessToken }),
    });
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Google Picker import failed to start.");
    }

    state.activeDriveImportId = data.job?.id || null;
    applyDriveImportJob(data.job);
    const job = await pollDriveImport();
    if (job?.state === "complete") {
      log(`Google Picker ISO imported to ${job.isoPath}.`);
    } else if (job?.state === "error") {
      log(`Google Picker import failed: ${job.error}`);
    }
  } catch (error) {
    els.driveImportStatus.textContent = error.message;
    updateDriveImportProgress(null);
    log(`Google Picker import failed: ${error.message}`);
  } finally {
    els.drivePickerButton.disabled = false;
    updateButtons();
  }
};

const openGoogleDrivePicker = async () => {
  if (!googlePickerConfigured()) {
    els.driveImportStatus.textContent = googlePickerConfigMessage;
    log(googlePickerConfigMessage);
    return;
  }

  const tokenStillValid =
    state.googlePickerAccessToken && state.googlePickerTokenExpiresAt > Date.now() + 60 * 1000;
  if (!tokenStillValid) {
    els.drivePickerButton.disabled = true;
    els.driveImportStatus.textContent = "Opening Google Drive sign-in...";
    startGoogleDriveRedirectSignIn();
    return;
  }

  let pickerFinished = false;
  let pickerDialog = null;
  let pickerWatchdog = 0;
  const finishPicker = () => {
    pickerFinished = true;
    window.clearTimeout(pickerWatchdog);
    pickerDialog?.setVisible?.(false);
    pickerDialog = null;
  };
  const handlePickedFile = (fileId, fileName, accessToken) => {
    finishPicker();
    if (!fileId) {
      els.driveImportStatus.textContent = "Google Drive did not return a file ID.";
      els.drivePickerButton.disabled = false;
      return;
    }
    if (!accessToken) {
      els.driveImportStatus.textContent = "Google Drive did not return an access token.";
      els.drivePickerButton.disabled = false;
      return;
    }
    els.driveImportStatus.textContent = `Selected ${fileName}. Starting import...`;
    void startPickerDriveImport(fileId, fileName, accessToken);
  };
  const cancelPicker = () => {
    finishPicker();
    els.driveImportStatus.textContent = "Google Drive picker canceled.";
    els.drivePickerButton.disabled = false;
  };
  const failPicker = (message) => {
    finishPicker();
    els.driveImportStatus.textContent = message;
    els.drivePickerButton.disabled = false;
    log(`Google Drive Picker failed: ${message}`);
  };

  els.drivePickerButton.disabled = true;
  els.driveImportStatus.textContent = "Connecting to Google Drive...";

  try {
    const accessToken = state.googlePickerAccessToken;
    await loadGooglePickerApi();

    els.driveImportStatus.textContent = "Google Drive connected. Opening file list...";
    log("Google Drive account connected.");
    pickerDialog = openGoogleDrivePickerDialog({
      accessToken,
      onPicked: ({ fileId, fileName }) => handlePickedFile(fileId, fileName, accessToken),
      onCanceled: cancelPicker,
      onError: (error) => failPicker(error.message || "Google Drive Picker failed."),
    });

    if (!pickerDialog) return;

    pickerWatchdog = window.setTimeout(() => {
      if (pickerFinished || pickerDialog?.isVisible?.()) return;
      failPicker("Google Drive did not stay open. Allow pop-ups for this page and try again.");
    }, 10000);
  } catch (error) {
    failPicker(error.message || "Google Drive Picker failed.");
  }
};

const fetchNetlifyHostRegistry = async () => {
  if (!/\.netlify\.app$/i.test(window.location.hostname)) return null;

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

const connectNetlifyHostRegistry = async () => {
  const host = await fetchNetlifyHostRegistry();
  if (!host) return;

  if (!isHyperVMode()) {
    els.emulatorMode.value = "emustar-hyperv";
    syncEmulatorDropdown();
    updateBackendUi();
  }

  els.nativeStatus.dataset.mode = "ready";
  els.nativeStatus.textContent = host.stale
    ? "Found a registered host, but it may be stale. Choose an ISO before launching EMUSTAR."
    : "Found the current NebulaVM host. Choose an ISO before launching EMUSTAR.";
  await autoAdoptSharedHyperV();
};

const updateEmustarHostInfo = async () => {
  const emustarMode = isEmustarEmulator(els.emulatorMode.value);
  els.emustarHostShare.hidden = !emustarMode;
  if (!emustarMode) return;

  els.emustarCopyShareButton.disabled = true;
  els.emustarShareStatus.textContent = "Checking host access...";
  try {
    const headers = new Headers();
    if (state.nativeHostToken) {
      headers.set("Authorization", `Bearer ${state.nativeHostToken}`);
    }
    const response = await fetch("/api/emustar-host/info", {
      cache: "no-store",
      headers,
    });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("Host sharing is available when NebulaVM is running locally.");
    }
    const info = await response.json();
    if (!response.ok || !info.ok) {
      throw new Error(info.error || "EMUSTAR Host Mode is unavailable.");
    }

    const [hostShareUrl] = info.shareUrls || [];
    const shareUrl = isNetlifyLauncher ? window.location.origin : hostShareUrl;
    els.emustarShareUrl.value = shareUrl || "";
    els.emustarCopyShareButton.disabled = !shareUrl;
    els.emustarShareStatus.textContent = shareUrl
      ? isNetlifyLauncher
        ? "Stable launcher ready. This tab creates a private host session automatically."
        : info.publicUrl
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

const connectNativeDisplay = (base, vncPath, runtimeName, password = "") => {
  if (!vncPath) return null;

  if (runtimeName === "EMUSTAR") {
    stopHyperVSetupConsole();
  }
  state.lastGuestResize = "";
  els.nativeDisplay.hidden = false;
  const status = document.createElement("span");
  status.className = "native-display-status";
  status.textContent = `Connecting to ${runtimeName} display...`;
  els.nativeDisplay.replaceChildren(status);

  const rfb = new RFB(els.nativeDisplay, nativeWebSocketUrl(base, vncPath));
  rfb.background = "#05070a";
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.viewOnly = false;
  rfb.focusOnClick = true;
  rfb.addEventListener("credentialsrequired", () => {
    rfb.sendCredentials({ password });
  });
  rfb.addEventListener("connect", () => {
    status.remove();
    requestGuestDesktopResize(`${runtimeName} viewport`);
    log(`${runtimeName} display connected in browser.`);
  });
  rfb.addEventListener("disconnect", () => {
    if (state.nativeRfb === rfb) {
      state.nativeRfb = null;
    }
    if (state.emulator) {
      log(`${runtimeName} display disconnected.`);
    }
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
};

const sendHyperVConsoleInput = async (payload) => {
  if (!state.hyperVConsoleActive) return;
  try {
    await fetchHyperVJson("console-input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    log(`Hyper-V setup input failed: ${error.message}`);
  }
};

const startHyperVSetupConsole = (base) => {
  stopHyperVSetupConsole();

  state.hyperVConsoleActive = true;
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
  status.textContent = "Opening Hyper-V setup inside the browser viewport...";

  shell.append(image, overlay, status);
  els.nativeDisplay.replaceChildren(shell);
  shell.focus({ preventScroll: true });

  const clickHandler = (event) => {
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    shell.focus();
    void sendHyperVConsoleInput({
      type: "click",
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    });
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

  image.addEventListener("click", clickHandler);
  shell.addEventListener("keydown", keyHandler);
  shell.addEventListener("paste", pasteHandler);
  state.hyperVConsoleCleanup = () => {
    image.removeEventListener("click", clickHandler);
    shell.removeEventListener("keydown", keyHandler);
    shell.removeEventListener("paste", pasteHandler);
  };

  const pollFrame = async () => {
    if (!state.hyperVConsoleActive) return;
    try {
      const frame = await fetchHyperVFrame();
      const nextFrameUrl = URL.createObjectURL(frame.blob);
      if (state.hyperVConsoleFrameUrl) {
        URL.revokeObjectURL(state.hyperVConsoleFrameUrl);
      }
      state.hyperVConsoleFrameUrl = nextFrameUrl;
      image.src = nextFrameUrl;
      if (frame.width) image.width = frame.width;
      if (frame.height) image.height = frame.height;
      status.textContent = "Use Tab, arrows, Enter, and paste text here to finish setup.";
      setViewportSummary("Hyper-V setup is mirrored in browser");
      state.hyperVConsoleTimer = window.setTimeout(pollFrame, 1100);
    } catch (error) {
      status.textContent = `Hyper-V setup mirror waiting: ${error.message}`;
      state.hyperVConsoleTimer = window.setTimeout(pollFrame, 1800);
    }
  };

  void pollFrame();
  log("Mirroring the Hyper-V setup console inside the browser viewport.");
};

const adoptRunningHyperVViewport = async (status, base) => {
  if (!isHyperVMode() || status.vm?.state !== "Running" || !status.vncReady || !status.vncPath) {
    return false;
  }

  stopHyperVSetupConsole();
  els.nativeDisplayMode.value = "viewport";
  window.localStorage.setItem("nebulavm.emustar.display", "viewport");
  els.screenPlaceholder.hidden = true;
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = true;
  els.qemuTerminal.textContent = "";
  els.remoteFrame.hidden = true;
  els.remoteFrame.src = "about:blank";

  state.nativeRuntimeName = "EMUSTAR";
  state.nativeQemuApiBase = base;
  state.running = true;
  if (!state.startedAt) {
    state.startedAt = Date.now();
    clearStatsTimer();
    state.statsTimer = window.setInterval(updateUptime, 1000);
  }

  if (!state.nativeRfb) {
    state.nativeRfb = connectNativeDisplay(base, status.vncPath, "EMUSTAR", status.vncPassword || "");
    log("Attached to the running EMUSTAR display in the browser viewport.");
  }

  if (!state.emulator) {
    state.emulator = {
      stop: async () => {
        state.nativeRfb?.disconnect();
      },
      destroy: async () => {
        state.nativeRfb?.disconnect();
      },
    };
  }

  els.machineTitle.textContent = "EMUSTAR Control Deck";
  setPowerState("EMUSTAR Hyper-V", "running");
  setViewportSummary("EMUSTAR display is live in the browser");
  updateUptime();
  updateButtons();
  monitorNativeVm();
  await closeHyperVConsole();
  return true;
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
const isNativeQemuMode = () => isStandaloneQemuMode();
const isQemuMode = () => isBrowserQemuMode() || isNativeQemuMode();
const isExternalMode = () => isQemuMode() || isHyperVMode() || isRemoteMode();
const nativeArchitecture = () => (isNativeArm64Mode() ? "aarch64" : "x86_64");
const nativeProfile = () =>
  isNativeUbuntuArm64Mode() ? "ubuntu-arm64" : isNativeWindowsArm64Mode() ? "windows-arm64" : "generic-x64";
const nativeRuntimeBrand = () => (isHyperVMode() ? "EMUSTAR" : "QEMU");
const nativeModeLabel = () =>
  isHyperVMode()
    ? "EMUSTAR x64 / Hyper-V"
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
  value === "remote-vm";
const looksLikeArm64Iso = (path) => /(^|[^a-z0-9])(arm64|aarch64)(?=[^a-z0-9]|$)/i.test(path);
const looksLikeX64Iso = (path) => /(^|[^a-z0-9])(x64|amd64|x86_64)(?=[^a-z0-9]|$)/i.test(path);
const looksLikeUbuntuIso = (path) => /(^|[^a-z0-9])ubuntu(?=[^a-z0-9]|$)/i.test(path);
const looksLikeWindowsIso = (path) => /(^|[^a-z0-9])(windows|win\d*)(?=[^a-z0-9]|$)/i.test(path);

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
    selectedValue === "remote-vm"
      ? "/assets/remote-vm-icon.png"
      : selectedValue.startsWith("qemu-native-")
        ? "/assets/qemu-icon.png"
      : isEmustarEmulator(selectedValue)
        ? "/assets/emustar-icon.png"
        : "/assets/nebulavm-emulator-icon.png";

  els.emulatorMenuOptions.forEach((option) => {
    const selected = option.dataset.emulatorOption === selectedValue;
    option.classList.toggle("is-selected", selected);
    option.setAttribute("aria-selected", String(selected));
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
  const emustarMode = isEmustarEmulator(els.emulatorMode.value);
  const hasBootMedia = emustarMode
    ? Boolean(els.nativeIsoPath.value.trim() || state.isoFile)
    : isNativeMode()
    ? Boolean(els.nativeIsoPath.value.trim())
    : isRemoteMode()
      ? Boolean(els.remoteVmUrl.value.trim())
      : Boolean(state.isoFile);
  const nativeUnavailable =
    isNativeMode() && (state.nativeQemuApiAvailable === false || state.nativeQemuReady === false);
  els.bootButton.disabled =
    !hasBootMedia ||
    Boolean(state.emulator) ||
    isSelectedMediaTooLarge() ||
    nativeUnavailable ||
    state.hostStagedIsoUploading;
  els.pauseButton.disabled = busy || !state.emulator || externalMode;
  els.stopButton.disabled = busy || !state.emulator;
  els.resetButton.disabled = busy || !state.emulator || externalMode;
  els.saveStateButton.disabled = busy || !state.emulator || externalMode;
  els.loadStateButton.disabled = externalMode;
  els.nativeResetFirmwareButton.disabled =
    busy || !isNativeMode() || Boolean(state.emulator) || nativeUnavailable;
  els.nativeConsoleButton.disabled = busy || !isHyperVMode() || nativeUnavailable;
  els.bootButton.textContent = emustarMode ? "Launch EMUSTAR" : "Boot VM";
  els.stopButton.textContent = emustarMode ? "End session" : "Stop";
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

const measureSummaryText = (summary) => {
  const measure = document.createElement("span");
  measure.className = "ai-summary-measure";
  measure.textContent = summary;
  els.viewportSummaryMetric.append(measure);
  const width = Math.ceil(measure.getBoundingClientRect().width);
  measure.remove();
  return Math.max(42, width);
};

const setViewportSummary = (summary) => {
  const stage = els.viewportSummaryMetric.querySelector(".ai-summary-stage");
  if (!stage) return;

  const outgoing = stage.querySelector(".ai-summary-text.is-current") || stage.querySelector(".ai-summary-text");
  const outgoingWidth = outgoing?.textContent ? measureSummaryText(outgoing.textContent) : 0;
  const incomingWidth = measureSummaryText(summary);
  stage.style.setProperty("--summary-text-width", `${Math.max(outgoingWidth, incomingWidth)}px`);

  if (outgoing?.textContent === summary) return;

  const incoming = document.createElement("span");
  incoming.className = "ai-summary-text is-entering";
  incoming.textContent = summary;

  if (!outgoing) {
    incoming.classList.remove("is-entering");
    incoming.classList.add("is-current");
    stage.replaceChildren(incoming);
    return;
  }

  outgoing.classList.remove("is-current", "is-entering");
  outgoing.classList.add("is-leaving");

  stage.append(incoming);
  requestAnimationFrame(() => {
    incoming.classList.remove("is-entering");
    incoming.classList.add("is-current");
  });

  window.setTimeout(() => {
    stage.querySelectorAll(".ai-summary-text.is-leaving").forEach((text) => text.remove());
  }, 420);
};

const summarizeViewportText = (text) => {
  const value = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!value) return null;
  if (value.includes("connecting to emustar display")) return "Connecting to EMUSTAR display";
  if (/press any key.*(cd|dvd)/i.test(value)) return "CD boot prompt is waiting";
  if (value.includes("installing windows") || value.includes("windows setup")) {
    return "Windows setup is active on screen";
  }
  if (value.includes("getting ready") || value.includes("getting devices ready")) {
    return "Windows setup is preparing devices";
  }
  if (value.includes("boot manager") || value.includes("uefi") || value.includes("tianocore")) {
    return "UEFI firmware screen is showing";
  }
  if (value.includes("no bootable") || value.includes("boot failed") || value.includes("missing operating system")) {
    return "Boot media problem needs attention";
  }
  if (value.includes("nebulavm demo booted")) return "Nebula demo boot image is running";
  return null;
};

const getViewportText = () => {
  const vgaText = els.screenContainer.querySelector(".vga-text");
  return [
    !els.qemuTerminal.hidden ? els.qemuTerminal.textContent : "",
    vgaText && !vgaText.hidden ? vgaText.textContent : "",
    !els.nativeDisplay.hidden ? els.nativeDisplay.querySelector(".native-display-status")?.textContent || "" : "",
  ].join("\n");
};

const getVisibleViewportCanvas = () => {
  const canvases = !els.nativeDisplay.hidden
    ? [...els.nativeDisplay.querySelectorAll("canvas")]
    : [...els.screenContainer.querySelectorAll("canvas")];
  return canvases.find((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return rect.width > 8 && rect.height > 8 && canvas.width > 8 && canvas.height > 8;
  });
};

const summarizeViewportCanvas = (canvas) => {
  if (!canvas) return null;

  const width = 64;
  const height = 36;
  const sample = document.createElement("canvas");
  sample.width = width;
  sample.height = height;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  try {
    context.drawImage(canvas, 0, 0, width, height);
  } catch {
    return "Display is visible but protected";
  }

  let pixels;
  try {
    pixels = context.getImageData(0, 0, width, height).data;
  } catch {
    return "Display is visible but protected";
  }
  let total = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let avgRed = 0;
  let avgGreen = 0;
  let avgBlue = 0;
  let dark = 0;
  let white = 0;
  let purple = 0;
  let gray = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 16) continue;

    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const brightness = (r + g + b) / 3;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    total += 1;
    avgRed += r;
    avgGreen += g;
    avgBlue += b;

    if (brightness < 30) dark += 1;
    if (brightness > 210 && spread < 56) white += 1;
    if (r > 140 && r > g + 40 && r > b + 40) red += 1;
    if (g > 120 && g > r + 30 && g > b + 20) green += 1;
    if (b > 90 && b > r + 35 && b > g + 10) blue += 1;
    if (b > 70 && r > 35 && b > g + 24) purple += 1;
    if (brightness > 50 && brightness < 190 && spread < 28) gray += 1;
  }

  if (!total) return "Waiting for visible display pixels";

  const ratios = {
    red: red / total,
    green: green / total,
    blue: blue / total,
    dark: dark / total,
    white: white / total,
    purple: purple / total,
    gray: gray / total,
  };
  avgRed /= total;
  avgGreen /= total;
  avgBlue /= total;

  if (ratios.dark > 0.92) return "Black boot screen is waiting";
  if (ratios.blue > 0.42 && avgBlue > avgRed + 40) return "Windows setup is active on screen";
  if (ratios.purple > 0.28 || (avgBlue > avgGreen + 24 && avgRed > avgGreen + 8)) {
    return "UEFI firmware screen is showing";
  }
  if (ratios.white > 0.05 && ratios.dark > 0.5) return "Boot console text is visible";
  if (ratios.red > 0.08) return "Warning or error screen is visible";
  if (ratios.green > 0.14 && ratios.dark < 0.55) return "Desktop environment appears to be running";
  if (ratios.gray > 0.55 && ratios.white > 0.01) return "Setup screen is waiting for input";
  return "VM display is active and changing";
};

const updateViewportSummary = () => {
  if (!els.screenPlaceholder.hidden) {
    setViewportSummary("Waiting for boot media to start");
    return;
  }

  const textSummary = summarizeViewportText(getViewportText());
  if (textSummary) {
    setViewportSummary(textSummary);
    return;
  }

  setViewportSummary(
    summarizeViewportCanvas(getVisibleViewportCanvas()) ||
      (state.emulator ? "VM display is starting up" : "Waiting for boot media to start"),
  );
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
  const code = lastExit.code === null ? "" : ` (exit ${lastExit.code})`;
  return outputLine ? `${outputLine}${code}` : `The runtime stopped${code}.`;
};

const monitorNativeVm = () => {
  clearNativeMonitor();
  state.nativeMonitorTimer = window.setInterval(async () => {
    if (!state.emulator || !isNativeMode()) {
      clearNativeMonitor();
      return;
    }

    try {
      const hyperVRuntime = state.nativeRuntimeName === "EMUSTAR";
      const { data: status } = hyperVRuntime
        ? await fetchHyperVJson("status")
        : await fetchNativeQemuJson(`status?arch=${nativeArchitecture()}`);
      const running = hyperVRuntime ? status.vm?.state === "Running" : status.running;
      if (running) {
        if (
          hyperVRuntime &&
          !state.nativeRfb &&
          els.nativeDisplayMode.value === "viewport" &&
          status.vncReady
        ) {
          stopHyperVSetupConsole();
          state.nativeRfb = connectNativeDisplay(
            state.nativeQemuApiBase || window.location.origin,
            status.vncPath,
            "EMUSTAR",
            status.vncPassword || "",
          );
          log("EMUSTAR browser display is ready.");
          await closeHyperVConsole();
        } else if (
          hyperVRuntime &&
          !state.nativeRfb &&
          els.nativeDisplayMode.value === "viewport" &&
          !status.vncReady &&
          !state.hyperVConsoleActive
        ) {
          startHyperVSetupConsole(state.nativeQemuApiBase || window.location.origin);
        }
        return;
      }

      clearNativeMonitor();
      stopHyperVSetupConsole();
      state.nativeRfb?.disconnect();
      state.nativeRfb = null;
      state.emulator = null;
      state.running = false;
      state.startedAt = null;
      clearStatsTimer();
      updateUptime();
      const summary = hyperVRuntime
        ? "The Hyper-V machine is powered off."
        : nativeExitSummary(status.lastExit);
      const runtimeName = state.nativeRuntimeName || nativeRuntimeBrand();
      showNativeDisplayStatus(`${runtimeName} stopped. ${summary}`);
      setViewportSummary(`${runtimeName} stopped and reported an error`);
      setPowerState(`${runtimeName} stopped`, "off");
      log(`${runtimeName} stopped: ${summary}`);
      state.nativeRuntimeName = null;
      updateButtons();
    } catch {
      // A temporary status request failure should not disconnect a running VM.
    }
  }, 2000);
};

const setSelectedFile = (file) => {
  state.isoFile = file;
  els.isoMeta.textContent = `${file.name} - ${formatBytes(file.size)}`;
  els.machineTitle.textContent = file.name;
  els.dropZone.classList.add("has-file");
  log(`Selected ${file.name} (${formatBytes(file.size)}).`);
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
  stopHyperVSetupConsole();
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
  setViewportSummary("Waiting for boot media to start");
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
  setViewportSummary("VM display is starting up");
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
      memoryMb: Number(els.memorySize.value) / 1024 / 1024,
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
  if (result.arch) log(`Native architecture: ${result.arch}.`);
  if (result.profile) log(`Native profile: ${result.profile}.`);
  if (result.diskPath) log(`Using install disk: ${result.diskPath}`);
  if (result.ovmf) log(`Using UEFI firmware: ${result.ovmf}`);
  if (result.ovmfVarsPath) log(`Using UEFI variables: ${result.ovmfVarsPath}`);
  if (result.vncPath) log(`${runtimeName} display is embedded in the ISO viewport.`);
  if (result.displayMode === "external") log(`${runtimeName} display is running in an external desktop window.`);
  if (runtimeName === "EMUSTAR") {
    log("EMUSTAR uses the Microsoft Hyper-V engine.");
  }
};

const bootEmustarHyperV = async (displayMode = "viewport") => {
  const runtimeName = "EMUSTAR";
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = true;
  els.qemuTerminal.textContent = "";
  showNativeDisplayStatus(
    displayMode === "external"
      ? "Starting the EMUSTAR Hyper-V host console..."
      : "Starting EMUSTAR setup inside the browser viewport...",
  );

  const { response, data: result, base } = await fetchHyperVJson("start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      displayMode,
      isoPath: els.nativeIsoPath.value.trim(),
      memoryMb: Number(els.memorySize.value) / 1024 / 1024,
      bootOrder: els.bootOrder.value,
      createDisk: els.nativeCreateDisk.checked,
      diskSizeGb: Number(els.nativeDiskSize.value),
    }),
  });
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "EMUSTAR Hyper-V failed to start.");
  }

  state.nativeRuntimeName = runtimeName;
  const rfb =
    displayMode === "viewport" && result.vncReady
      ? connectNativeDisplay(base, result.vncPath, runtimeName, result.vncPassword || "")
      : null;
  state.nativeRfb = rfb;
  state.emulator = {
    stop: async () => {
      stopHyperVSetupConsole();
      rfb?.disconnect();
    },
    destroy: async () => {
      stopHyperVSetupConsole();
      rfb?.disconnect();
    },
  };
  state.running = result.vm?.state === "Running";
  setPowerState("EMUSTAR Hyper-V", state.running ? "running" : "booting");
  updateButtons();
  monitorNativeVm();

  const vm = result.vm || {};
  log(`EMUSTAR started ${vm.name || "the Windows VM"} with Microsoft Hyper-V.`);
  if (base !== window.location.origin) log(`Using local bridge: ${base}`);
  if (vm.diskPath) log(`Using VHDX install disk: ${vm.diskPath}`);
  if (vm.isoPath) log(`Mounted installation media: ${vm.isoPath}`);
  log(`Secure Boot: ${vm.secureBoot ? "enabled" : "not enabled"}.`);
  log(`Virtual TPM: ${vm.tpm ? "enabled" : "not enabled"}.`);
  for (const warning of result.warnings || []) {
    log(`EMUSTAR warning: ${warning}`);
  }

  if (displayMode === "external") {
    showNativeDisplayStatus("EMUSTAR is running in the Hyper-V host console.");
    log("The Hyper-V setup console opened on the host computer.");
  } else if (!result.vncReady) {
    startHyperVSetupConsole(base);
    log("Using the browser viewport for Hyper-V setup until the Windows desktop display is ready.");
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

const bootEmulator = async () => {
  if (!isNativeMode() && !isRemoteMode() && !state.isoFile) return;
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
    log("Boot blocked: drop an ISO, choose an ISO path, or import one from Google Drive before launching EMUSTAR.");
    return;
  }
  if (isHyperVMode() && looksLikeArm64Iso(els.nativeIsoPath.value.trim())) {
    log("Boot blocked: EMUSTAR Hyper-V on this Intel PC needs the Windows 11 x64 ISO, not ARM64.");
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

  const qemuDisplayMode = isNativeMode() ? els.nativeDisplayMode.value : "viewport";

  await stopEmulator();

  prepareBootUi();
  log("Creating virtual machine.");

  try {
    if (isRemoteMode()) {
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

els.memorySize.addEventListener("change", () => {
  els.ramMetric.textContent = `${Number(els.memorySize.value) / 1024 / 1024} MB RAM`;
});

const updateNativeStatus = async () => {
  if (!isNativeMode()) return;

  if (isHyperVMode()) {
    try {
      const { data: status, base } = await fetchHyperVJson("status");
      const bridgeLabel = base === window.location.origin ? "" : ` via local bridge ${base}`;
      state.nativeQemuApiAvailable = true;
      state.nativeQemuReady = Boolean(status.available);
      if (status.available) {
        const vmState = status.vm ? ` VM: ${status.vm.state}.` : "";
        els.nativeStatus.dataset.mode = "ready";
        els.nativeStatus.textContent = `EMUSTAR ready with Microsoft Hyper-V${bridgeLabel}.${vmState}`;
        if (state.emulator && await adoptRunningHyperVViewport(status, base)) {
          els.nativeStatus.textContent = `EMUSTAR display is live in the browser viewport${bridgeLabel}.`;
        }
      } else if (status.restartRequired) {
        els.nativeStatus.dataset.mode = "missing";
        els.nativeStatus.textContent =
          "Hyper-V is enabled. Restart Windows once to finish preparing EMUSTAR.";
      } else {
        els.nativeStatus.dataset.mode = "missing";
        els.nativeStatus.textContent = "Microsoft Hyper-V is not available on this host.";
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

const autoAdoptSharedHyperV = async () => {
  if (!state.nativeHostToken || !state.emulator) return;

  try {
    const { data: status, base } = await fetchHyperVJson("status");
    if (status.vm?.state !== "Running" || !status.vncReady) {
      return;
    }

    if (!isHyperVMode()) {
      els.emulatorMode.value = "emustar-hyperv";
      syncEmulatorDropdown();
      updateBackendUi();
    }

    await adoptRunningHyperVViewport(status, base);
    void updateEmustarHostInfo();
  } catch {
    // The shared host may still be warming up; normal status checks will keep trying.
  }
};

const driveImportStatusText = (job) => {
  if (!job) return "No Drive import running.";
  if (job.state === "complete") return `Imported to ${job.isoPath}`;
  if (job.state === "error") {
    return job.error || "Google Drive ISO import failed.";
  }
  const received = formatBytes(job.bytesReceived || 0);
  const total = job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : "";
  return `${job.message || "Importing Google Drive ISO..."} ${received}${total}`;
};

const formatTransferSpeed = (bytesPerSecond) => {
  const speed = Math.max(0, Number(bytesPerSecond) || 0);
  if (speed >= 1024 * 1024) {
    return `${(speed / 1024 / 1024).toFixed(1)} MB/s`;
  }
  return `${Math.round(speed / 1024)} KB/s`;
};

const driveImportPercent = (job) => {
  const received = Number(job?.bytesReceived) || 0;
  const total = Number(job?.totalBytes) || 0;
  if (job?.state === "complete") return 100;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (received / total) * 100));
};

const updateDriveImportProgress = (job) => {
  const hasProgress = Boolean(job) && (job.state === "running" || job.state === "complete");
  els.driveImportProgress.hidden = !hasProgress;
  if (!hasProgress) {
    els.driveImportProgressFill.style.width = "0%";
    els.driveImportProgress.querySelector(".drive-import-track").setAttribute("aria-valuenow", "0");
    els.driveImportProgressText.textContent = "0% - 0 B";
    els.driveImportSpeed.textContent = "0 KB/s";
    return;
  }

  const percent = driveImportPercent(job);
  const received = formatBytes(job.bytesReceived || 0);
  const total = job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : "";
  const percentText = job.state === "complete" ? "100%" : job.totalBytes ? `${Math.floor(percent)}%` : "Preparing";
  const speedText = job.state === "complete" ? "Complete" : formatTransferSpeed(job.speedBytesPerSecond);

  els.driveImportProgressFill.style.width = `${percent}%`;
  els.driveImportProgress.querySelector(".drive-import-track").setAttribute("aria-valuenow", String(Math.round(percent)));
  els.driveImportProgressText.textContent = `${percentText} - ${received}${total}`;
  els.driveImportSpeed.textContent = speedText;
};

const applyDriveImportJob = (job) => {
  els.driveImportStatus.textContent = driveImportStatusText(job);
  updateDriveImportProgress(job);
  const running = job?.state === "running";
  els.drivePickerButton.disabled = running;

  if (job?.state === "complete" && job.isoPath && job.id === state.activeDriveImportId) {
    els.nativeIsoPath.value = job.isoPath;
    state.activeDriveImportId = null;
    updateButtons();
  }
};

const pollDriveImport = async () => {
  if (state.driveImportPolling) return null;
  state.driveImportPolling = true;
  try {
    while (true) {
      const { data } = await fetchEmustarHostJson("drive-import");
      const job = data.job;
      applyDriveImportJob(job);

      if (!job || job.state === "complete" || job.state === "error") {
        return job;
      }
      await new Promise((resolvePoll) => window.setTimeout(resolvePoll, 1000));
    }
  } finally {
    state.driveImportPolling = false;
  }
};

const refreshDriveImportStatus = async () => {
  if (!isHyperVMode()) return;
  try {
    const { data } = await fetchEmustarHostJson("drive-import");
    applyDriveImportJob(data.job);
    if (data.job?.state === "running") {
      void pollDriveImport();
    }
  } catch {
    els.driveImportStatus.textContent = "Drive import is unavailable from this page.";
    updateDriveImportProgress(null);
  }
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
    log("Opened the EMUSTAR Hyper-V console on the host computer.");
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
  const qemuMode = isQemuMode();
  const nativeMode = isNativeMode();
  const nativeArm64Mode = isNativeArm64Mode();
  const nativeUbuntuArm64Mode = isNativeUbuntuArm64Mode();
  const remoteMode = isRemoteMode();
  const externalMode = isExternalMode();
  const runtimeBrand = nativeRuntimeBrand();
  const emustarMode = isEmustarEmulator(els.emulatorMode.value);
  syncEmulatorDropdown();
  els.workspace.classList.toggle("is-emustar-mode", emustarMode);
  els.emustarInfoLink.hidden = !emustarMode;
  els.mediaKicker.textContent = emustarMode ? "Nebula Host" : "Media";
  els.bootSourceTitle.textContent = emustarMode ? "Mission media" : "Boot source";
  els.displayKicker.textContent = emustarMode ? "Nebula Console" : "Display";
  els.activityLabel.textContent = emustarMode ? "Mission log" : "Activity";
  els.screenModeIcon.hidden = !emustarMode;
  els.screenOrbital.hidden = emustarMode;
  els.placeholderTitle.textContent = emustarMode ? "EMUSTAR viewport standing by" : "Drop an ISO to begin";
  if (!state.emulator && !state.isoFile) {
    els.machineTitle.textContent = emustarMode ? "EMUSTAR Control Deck" : "Awaiting boot media";
  }
  els.processorMode.value = nativeArm64Mode ? "arm64" : qemuMode || emustarMode ? "x64" : "x86";
  els.processorMode.disabled = emustarMode;
  const selectedMemoryMb = Number(els.memorySize.value) / 1024 / 1024;
  if (isNativeWindowsArm64Mode() && selectedMemoryMb < 4096) {
    els.memorySize.value = "4294967296";
  } else if (nativeMode && selectedMemoryMb < 2048) {
    els.memorySize.value = "2147483648";
  }
  els.nativePanel.hidden = !nativeMode;
  els.remotePanel.hidden = !remoteMode;
  if (nativeMode) {
    els.nativeRuntimeIcon.src = isStandaloneQemuMode() ? "/assets/qemu-icon.png" : "/assets/emustar-icon.png";
    els.nativeRuntimeName.textContent = runtimeBrand;
    els.nativeRuntimeAttribution.textContent = isStandaloneQemuMode()
      ? "Native virtualization engine"
      : "Generation 2 virtualization powered by Microsoft Hyper-V";
    els.nativeResetFirmwareButton.hidden = emustarMode;
    els.nativeConsoleButton.hidden = !emustarMode;
    els.nativeDiskHelp.textContent = emustarMode
      ? "Uses a dynamic VHDX disk in the NebulaVM folder."
      : "Uses a qcow2 disk in the NebulaVM folder.";
    els.nativeCreateDisk.checked = true;
    els.nativeCreateDisk.disabled = emustarMode;
    const [viewportOption, externalOption] = els.nativeDisplayMode.options;
    viewportOption.textContent = emustarMode ? "Browser setup + desktop" : "ISO viewport";
    externalOption.textContent = emustarMode ? "Hyper-V host console" : "External window";
    state.nativeQemuReady = false;
    els.nativeStatus.dataset.mode = "";
    els.nativeStatus.textContent = `Checking ${nativeModeLabel()}...`;
  }
  els.vgaSize.disabled = externalMode;
  els.bootOrder.disabled = remoteMode || state.emulator;
  els.nativeDisplayMode.disabled = Boolean(state.emulator);
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
  els.placeholderMeta.textContent = nativeMode
    ? emustarMode
      ? "Choose or import an ISO to launch an EMUSTAR Hyper-V machine."
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
  els.ramMetric.textContent = `${Number(els.memorySize.value) / 1024 / 1024} MB RAM`;
  updateMediaWarning();
  updateButtons();
  void updateEmustarHostInfo();
  void updateNativeStatus();
  if (nativeMode) {
    void refreshDriveImportStatus();
  }
  if (emustarMode && state.isoFile && !els.nativeIsoPath.value.trim() && !state.hostStagedIsoUploading) {
    void stageSelectedIsoForEmustar().catch(() => {});
  }
  void updateBrowserQemuCapabilities();
};

els.emulatorMode.addEventListener("change", updateBackendUi);
els.emustarInfoLink.addEventListener("click", () => {
  els.emustarInfoDialog.hidden = false;
  els.emustarInfoOkButton.focus();
});
els.emustarInfoOkButton.addEventListener("click", () => {
  els.emustarInfoDialog.hidden = true;
  els.emustarInfoLink.focus();
});
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
  option.addEventListener("click", () => {
    els.emulatorMode.value = option.dataset.emulatorOption;
    setEmulatorMenuOpen(false);
    updateBackendUi();
    els.emulatorSelectButton.focus();
  });
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".emulator-dropdown")) {
    setEmulatorMenuOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setEmulatorMenuOpen(false);
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
els.nativeIsoPath.addEventListener("input", () => updateButtons());
els.drivePickerButton.addEventListener("click", openGoogleDrivePicker);
if (googlePickerConfigured()) {
  window.setTimeout(warmGoogleDrivePicker, 500);
  els.drivePickerButton.addEventListener("pointerenter", warmGoogleDrivePicker, { once: true });
  els.drivePickerButton.addEventListener("focus", warmGoogleDrivePicker, { once: true });
}
els.nativeCreateDisk.addEventListener("change", () => updateButtons());
els.nativeDisplayMode.addEventListener("change", () => {
  window.localStorage.setItem("nebulavm.emustar.display", els.nativeDisplayMode.value);
});
els.nativeResetFirmwareButton.addEventListener("click", resetNativeFirmware);
els.nativeConsoleButton.addEventListener("click", openHyperVConsole);
els.remoteVmUrl.addEventListener("input", () => updateButtons());

const updateFullscreenButton = () => {
  const isFullscreen = document.fullscreenElement === els.screenShell;
  els.fullscreenButton.textContent = isFullscreen ? "Exit fullscreen" : "Fullscreen";
  els.screenShell.classList.toggle("is-fullscreen", isFullscreen);
  requestGuestDesktopResize(isFullscreen ? "fullscreen" : "windowed viewport");
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
window.addEventListener("resize", () => requestGuestDesktopResize("browser resize"));

els.clearLogButton.addEventListener("click", () => {
  els.logOutput.textContent = "";
});

window.addEventListener("pagehide", () => {
  void cleanupStagedHostIso({ keepalive: true, silent: true });
});
window.addEventListener("beforeunload", () => {
  void cleanupStagedHostIso({ keepalive: true, silent: true });
  void stopEmulator();
});

log("NebulaVM ready.");
updateBackendUi();
if (googleDriveOAuthErrorFromUrl) {
  els.driveImportStatus.textContent = `Google Drive sign-in failed: ${googleDriveOAuthErrorFromUrl}`;
  log(`Google Drive sign-in failed: ${googleDriveOAuthErrorFromUrl}`);
}
if (shouldResumeGoogleDrivePicker) {
  els.driveImportStatus.textContent = "Google Drive connected. Opening file list...";
  log("Google Drive redirect completed.");
  window.setTimeout(() => {
    void openGoogleDrivePicker();
  }, 500);
}
void autoAdoptSharedHyperV();
void connectNetlifyHostRegistry();
updateButtons();
updateViewportSummary();
state.viewportSummaryTimer = window.setInterval(updateViewportSummary, 3000);
