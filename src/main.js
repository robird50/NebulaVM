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
const STORED_ISO_PROMPT_KEY = "nebulavm.emustar.storedIsoPrompt";
const STORED_ISO_LIMIT = 2;
const MOBILE_DEV_UNLOCK_KEY = "nebulavm.mobile.devUnlock";
const MOBILE_DEV_ATTEMPTS_KEY = "nebulavm.mobile.devAttempts";
const MOBILE_DEV_LOCK_KEY = "nebulavm.mobile.devLockUntil";
const MOBILE_DEV_CODE_HASH = "0a6a787e2e1b6c614d5b75115e55d3546cdcf312cd632093ddaaabcb4d7aec75";
const MOBILE_DEV_MAX_ATTEMPTS = 5;
const MOBILE_DEV_LOCK_MS = 5 * 60 * 1000;
const hostedLauncherHostnames = new Set(["nebulavm.online", "www.nebulavm.online"]);
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

if (isMobileOrTabletDevice()) {
  document.documentElement.classList.add("is-mobile-device");
}

if (window.sessionStorage.getItem(MOBILE_DEV_UNLOCK_KEY) === "1") {
  document.documentElement.classList.add("mobile-dev-bypass");
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
  hostStagedIsoBase: "",
  hostStagedIsoFileKey: "",
  hostStagedIsoPath: "",
  hostStagedIsoSessionId: "",
  hostStagedIsoUploadPromise: null,
  hostStagedIsoUploading: false,
  storedIsos: [],
  storedIsoLimit: STORED_ISO_LIMIT,
  storedImagesMenuOpen: false,
  storedIsoUploading: false,
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
    <small class="commit-id">Commit ${COMMIT_ID} <span>RoBird Studios 2026</span> <a href="https://github.com/robird50/NebulaVM">Source Code</a></small>
  </main>

  <div class="mobile-bypass-overlay" id="mobileBypassDialog" role="dialog" aria-modal="true" aria-labelledby="mobileBypassText" hidden>
    <section class="mobile-bypass-panel">
      <button class="mobile-bypass-close" id="mobileBypassCloseButton" type="button" aria-label="Close developer bypass">x</button>
      <img class="mobile-bypass-lock" src="/assets/mobile-dev-lock.jpg" alt="" />
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
        NebulaVM is an open-source, browser-based virtual machine platform that makes running operating systems simple. Launch lightweight virtual machines directly in your browser, or use the optional EMUSTAR host for more flexible virtualization and support for modern 64-bit operating systems like Windows 11. With drag-and-drop ISO support, configurable hardware, fullscreen mode, and a clean interface, NebulaVM brings virtualization to the web while remaining <strong>free forever</strong>.
      </p>
      <div class="status-actions">
        <div class="status-pill" id="powerState">
          <span class="status-dot"></span>
          <span>Powered off</span>
        </div>
        <div class="stored-images-control">
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
              aria-label="EMUSTAR host staging progress"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow="0"
            >
              <span id="hostStagingProgressFill"></span>
            </span>
            <span class="host-staging-stats">
              <span id="hostStagingProgressText">0% - 0 B</span>
              <span id="hostStagingSpeed">0 KB/s</span>
            </span>
          </span>
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
    <footer class="commit-id">Commit ${COMMIT_ID} <span>RoBird Studios 2026</span> <a href="https://github.com/robird50/NebulaVM">Source Code</a></footer>
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

  <div class="display-choice-overlay" id="keepIsoDialog" role="dialog" aria-modal="true" aria-labelledby="keepIsoTitle" hidden>
    <section class="display-choice-panel keep-iso-panel">
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
  isoMeta: document.querySelector("#isoMeta"),
  hostStagingProgress: document.querySelector("#hostStagingProgress"),
  hostStagingProgressFill: document.querySelector("#hostStagingProgressFill"),
  hostStagingProgressText: document.querySelector("#hostStagingProgressText"),
  hostStagingSpeed: document.querySelector("#hostStagingSpeed"),
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
  storedImagesButton: document.querySelector("#storedImagesButton"),
  storedImagesMenu: document.querySelector("#storedImagesMenu"),
  storedImagesCount: document.querySelector("#storedImagesCount"),
  storedIsoSlots: document.querySelector("#storedIsoSlots"),
  keepIsoDialog: document.querySelector("#keepIsoDialog"),
  keepIsoDontAsk: document.querySelector("#keepIsoDontAsk"),
  keepIsoNoButton: document.querySelector("#keepIsoNoButton"),
  keepIsoYesButton: document.querySelector("#keepIsoYesButton"),
  uptimeMetric: document.querySelector("#uptimeMetric"),
  viewportSummaryMetric: document.querySelector("#viewportSummaryMetric"),
  ramMetric: document.querySelector("#ramMetric"),
  logOutput: document.querySelector("#logOutput"),
  clearLogButton: document.querySelector("#clearLogButton"),
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

const hexFromBuffer = (buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

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
  els.mobileBypassDialog.hidden = true;
  resetMobilePin();
  setMobileBypassFeedback("");
};

const openMobileBypassDialog = () => {
  els.mobileBypassDialog.hidden = false;
  resetMobilePin();
  refreshMobileBypassLockMessage();
};

const applyMobileDevMode = () => {
  document.documentElement.classList.add("mobile-dev-bypass");
  if (isMobileOrTabletDevice() && !state.running) {
    els.emulatorMode.value = "v86";
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

const shakeMobilePin = () => {
  els.mobilePinDots.classList.remove("is-shaking");
  void els.mobilePinDots.offsetWidth;
  els.mobilePinDots.classList.add("is-shaking");
};

const failMobilePin = () => {
  const attempts = Number(window.sessionStorage.getItem(MOBILE_DEV_ATTEMPTS_KEY) || 0) + 1;
  if (attempts >= MOBILE_DEV_MAX_ATTEMPTS) {
    window.sessionStorage.setItem(MOBILE_DEV_ATTEMPTS_KEY, "0");
    window.sessionStorage.setItem(MOBILE_DEV_LOCK_KEY, String(Date.now() + MOBILE_DEV_LOCK_MS));
    setMobileBypassFeedback("Locked for 5 minutes.");
  } else {
    window.sessionStorage.setItem(MOBILE_DEV_ATTEMPTS_KEY, String(attempts));
    setMobileBypassFeedback(`${MOBILE_DEV_MAX_ATTEMPTS - attempts} tries left.`);
  }
  shakeMobilePin();
  resetMobilePin();
};

const verifyMobilePin = async () => {
  if (refreshMobileBypassLockMessage()) {
    resetMobilePin();
    return;
  }

  if (!crypto.subtle) {
    setMobileBypassFeedback("This browser cannot unlock the mobile test build.");
    resetMobilePin();
    return;
  }

  const encoded = new TextEncoder().encode(mobilePinState.digits);
  const digest = hexFromBuffer(await crypto.subtle.digest("SHA-256", encoded));
  if (digest === MOBILE_DEV_CODE_HASH) {
    unlockMobileDevMode();
    return;
  }
  failMobilePin();
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
  ? "Open the private EMUSTAR browser link generated by the Windows host. The public site does not discover host tokens."
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
  const uniqueBridgeBases = nativeBridgeBases();
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
  const uniqueBridgeBases = nativeBridgeBases();
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
  const uniqueBridgeBases = nativeBridgeBases();
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

const emustarHostBaseCandidates = () => nativeBridgeBases();

const browserIsoFileKey = (file) => (file ? `${file.name}:${file.size}` : "");

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
    els.keepIsoDialog.hidden = false;

    const finish = (keep) => {
      if (els.keepIsoDontAsk.checked) {
        window.localStorage.setItem(STORED_ISO_PROMPT_KEY, keep ? "always" : "never");
      }
      els.keepIsoDialog.hidden = true;
      els.keepIsoYesButton.onclick = null;
      els.keepIsoNoButton.onclick = null;
      resolvePrompt(keep);
    };

    els.keepIsoYesButton.onclick = () => finish(true);
    els.keepIsoNoButton.onclick = () => finish(false);
    els.keepIsoYesButton.focus();
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
    const { data, base } = await uploadBrowserIsoToHost(file, ({ bytesUploaded = 0, totalBytes = file.size }) => {
      updateHostStagingProgress({ bytesUploaded, totalBytes, startedAt });
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
    els.hostStagingSpeed.textContent = "Failed";
    log(`Stored ISO upload failed: ${error.message}`);
  } finally {
    state.storedIsoUploading = false;
    renderStoredIsoSlots();
    updateButtons();
  }
};

const HOST_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
const HOST_UPLOAD_MAX_ATTEMPTS = 5;

const createHostUploadId = (file) => {
  const randomId = crypto.randomUUID
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${Date.now()}-${randomId}-${file.size}`.replace(/[^a-zA-Z0-9_-]/g, "-");
};

const wait = (ms) => new Promise((resolveWait) => window.setTimeout(resolveWait, ms));

const uploadBrowserIsoChunkToBase = (base, file, uploadId, start, end, onProgress) =>
  new Promise((resolveUpload, rejectUpload) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}/api/emustar-host/upload-iso-chunk`, true);
    xhr.responseType = "json";
    if (state.nativeHostToken) {
      xhr.setRequestHeader("Authorization", `Bearer ${state.nativeHostToken}`);
    }
    xhr.setRequestHeader("X-NebulaVM-Filename", encodeURIComponent(file.name));
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
    xhr.onabort = () => rejectUpload(new Error("Browser ISO upload was canceled."));
    xhr.send(file.slice(start, end));
  });

const uploadBrowserIsoToBase = async (base, file, onProgress) => {
  const uploadId = createHostUploadId(file);
  let uploadedBytes = 0;

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
        if (attempt < HOST_UPLOAD_MAX_ATTEMPTS) {
          onProgress?.({
            bytesUploaded: start,
            totalBytes: file.size,
            percent: Math.max(0, Math.min(100, (start / file.size) * 100)),
            retrying: true,
          });
          await wait(800 * attempt);
        }
      }
    }

    if (lastChunkError) {
      throw new Error(`Host upload dropped at ${Math.floor((start / file.size) * 100)}%. ${lastChunkError.message}`);
    }
  }

  throw new Error("Host upload finished without a final ISO path.");
};

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

const resetHostStagingProgress = () => {
  els.hostStagingProgress.hidden = true;
  els.hostStagingProgressFill.style.width = "0%";
  els.hostStagingProgress.querySelector(".host-staging-track").setAttribute("aria-valuenow", "0");
  els.hostStagingProgressText.textContent = "0% - 0 B";
  els.hostStagingSpeed.textContent = "0 KB/s";
};

const updateHostStagingProgress = ({ bytesUploaded = 0, totalBytes = 0, startedAt = performance.now(), complete = false } = {}) => {
  const percent = totalBytes > 0 ? Math.max(0, Math.min(100, (bytesUploaded / totalBytes) * 100)) : 0;
  const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
  const speed = complete ? 0 : bytesUploaded / elapsedSeconds;
  const percentText = complete ? "100%" : `${Math.floor(percent)}%`;
  const uploaded = formatBytes(bytesUploaded);
  const total = totalBytes ? ` / ${formatBytes(totalBytes)}` : "";

  els.hostStagingProgress.hidden = false;
  els.hostStagingProgressFill.style.width = `${percent}%`;
  els.hostStagingProgress.querySelector(".host-staging-track").setAttribute("aria-valuenow", String(Math.round(percent)));
  els.hostStagingProgressText.textContent = `${percentText} - ${uploaded}${total}`;
  els.hostStagingSpeed.textContent = complete ? "Complete" : formatTransferSpeed(speed);
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
    resetHostStagingProgress();
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
  const storedIso = await findStoredIsoForFile(file);
  if (storedIso?.isoPath) {
    await selectStoredIso(storedIso);
    return storedIso.isoPath;
  }

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
  const stagingStartedAt = performance.now();
  updateHostStagingProgress({ bytesUploaded: 0, totalBytes: file.size, startedAt: stagingStartedAt });

  state.hostStagedIsoUploadPromise = uploadBrowserIsoToHost(file, ({ bytesUploaded = 0, totalBytes = file.size }) => {
    const percent = totalBytes > 0 ? Math.max(0, Math.min(100, (bytesUploaded / totalBytes) * 100)) : 0;
    els.isoMeta.textContent = `Staging to host ${Math.floor(percent)}%`;
    updateHostStagingProgress({ bytesUploaded, totalBytes, startedAt: stagingStartedAt });
  })
    .then(async ({ data, base }) => {
      state.hostStagedIsoBase = base;
      state.hostStagedIsoPath = data.isoPath || "";
      state.hostStagedIsoSessionId = data.sessionId || state.nativeSessionId;
      if (!state.hostStagedIsoPath) {
        throw new Error("The EMUSTAR host did not return an ISO path.");
      }
      els.nativeIsoPath.value = state.hostStagedIsoPath;
      els.isoMeta.textContent = `${file.name} staged on host - ${formatBytes(file.size)}`;
      updateHostStagingProgress({
        bytesUploaded: file.size,
        totalBytes: file.size,
        startedAt: stagingStartedAt,
        complete: true,
      });
      log(`Staged browser ISO on the EMUSTAR host: ${state.hostStagedIsoPath}`);
      const storedItem = await maybeKeepStagedIsoOnHost(file, data).catch((error) => {
        log(`Stored ISO prompt failed: ${error.message}`);
        return null;
      });
      if (storedItem?.isoPath) return storedItem.isoPath;
      return state.hostStagedIsoPath;
    })
    .catch((error) => {
      els.isoMeta.textContent = `${file.name} - host staging failed`;
      els.hostStagingSpeed.textContent = "Failed";
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

const setHostedHostWaitingStatus = () => {
  state.nativeQemuApiAvailable = false;
  state.nativeQemuReady = false;
  els.nativeStatus.dataset.mode = "missing";
  els.nativeStatus.textContent =
    "Open the private EMUSTAR browser link from the Windows host. NebulaVM no longer publishes host tokens from the public site.";
};

const connectNetlifyHostRegistry = async () => {
  if (isNetlifyLauncher && isHyperVMode()) {
    setHostedHostWaitingStatus();
    updateButtons();
  }
  return null;
};

const updateEmustarHostInfo = async () => {
  const emustarMode = isEmustarEmulator(els.emulatorMode.value);
  els.emustarHostShare.hidden = !emustarMode;
  if (!emustarMode) return;

  els.emustarCopyShareButton.disabled = true;
  els.emustarShareStatus.textContent = "Checking host access...";

  if (isNetlifyLauncher) {
    els.emustarShareUrl.value = "";
    els.emustarCopyShareButton.disabled = true;
    els.emustarShareStatus.textContent =
      "Use the private browser link generated on the Windows host. Public NebulaVM pages do not store host tokens.";
    return;
  }

  try {
    const { response, data: info } = await fetchEmustarHostJson("info");
    if (!response.ok || !info.ok) {
      throw new Error(info.error || "EMUSTAR Host Mode is unavailable.");
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
  status.textContent = "Opening EMUSTAR setup in this browser viewport...";

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
      status.textContent = "Use Tab, arrows, Enter, and paste text here to control setup.";
      setViewportSummary("EMUSTAR setup is live in this browser");
      state.hyperVConsoleTimer = window.setTimeout(pollFrame, 1100);
    } catch (error) {
      status.textContent = `Hyper-V setup mirror waiting: ${error.message}`;
      state.hyperVConsoleTimer = window.setTimeout(pollFrame, 1800);
    }
  };

  void pollFrame();
  log("Mirroring EMUSTAR setup into the requesting browser viewport.");
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

const waitForHyperVStartRecovery = async (shouldStop = () => false) => {
  await wait(18000);
  let notedSlowStart = false;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (shouldStop()) return null;

    try {
      if (!notedSlowStart) {
        notedSlowStart = true;
        showNativeDisplayStatus("EMUSTAR started slowly. Looking for the live display...");
        log("EMUSTAR start request is taking a while, so NebulaVM is checking the host status directly.");
      }

      const { data: status, base } = await fetchHyperVJson("status");
      if (status.vm?.state === "Running") {
        return {
          response: { ok: true },
          data: {
            ok: true,
            recoveredFromSlowStart: true,
            vm: status.vm,
            vncReady: Boolean(status.vncReady),
            vncPath: status.vncPath || "",
            vncPassword: status.vncPassword || "",
            warnings: ["Recovered from a slow EMUSTAR start response."],
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
const isNativeQemuMode = () => isStandaloneQemuMode();
const isQemuMode = () => isBrowserQemuMode() || isNativeQemuMode();
const isExternalMode = () => isQemuMode() || isHyperVMode() || isRemoteMode();
const shouldForceEmustarViewport = () => isNetlifyLauncher && isHyperVMode();
const selectedNativeDisplayMode = () => (shouldForceEmustarViewport() ? "viewport" : els.nativeDisplayMode.value);
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
    ? "These settings will be used for the Windows account EMUSTAR prepares."
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
    throw new Error(data.error || "The EMUSTAR host could not save Windows credentials.");
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
  updateWindowsCredentialUi();
  const externalMode = isExternalMode();
  const emustarMode = isEmustarEmulator(els.emulatorMode.value);
  const hasBootMedia = emustarMode
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
    isSelectedMediaTooLarge() ||
    nativeUnavailable ||
    windowsCredentialsBlocked ||
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
          selectedNativeDisplayMode() === "viewport" &&
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
          selectedNativeDisplayMode() === "viewport" &&
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
  if (isNetlifyLauncher) {
    displayMode = "viewport";
    els.nativeDisplayMode.value = "viewport";
  }

  const runtimeName = "EMUSTAR";
  els.screenContainer.querySelector(".vga-text").hidden = true;
  els.screenContainer.querySelector(".vga-canvas").hidden = true;
  els.qemuTerminal.hidden = true;
  els.qemuTerminal.textContent = "";
  showNativeDisplayStatus(
    displayMode === "external"
      ? "Starting the EMUSTAR Hyper-V host console..."
      : "Starting EMUSTAR setup inside this browser viewport...",
  );

  await saveWindowsGuestCredentialsIfNeeded();

  let startFinished = false;
  const startRequest = fetchHyperVJson("start", {
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
  }).finally(() => {
    startFinished = true;
  });
  const recoveryRequest = waitForHyperVStartRecovery(() => startFinished);
  const startResult = await Promise.race([startRequest, recoveryRequest]);
  if (!startResult) {
    throw new Error("EMUSTAR is still waiting for the host. Refresh the page to attach to any VM that already started.");
  }

  const { response, data: result, base } = startResult;
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
  if (result.recoveredFromSlowStart) {
    log("Recovered the EMUSTAR browser display from host status after the start request stalled.");
  }
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
    log("Using this browser viewport for EMUSTAR setup until the Windows desktop display is ready.");
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
    log("Boot blocked: drop an ISO or choose an ISO path before launching EMUSTAR.");
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

  const qemuDisplayMode = isNativeMode() ? selectedNativeDisplayMode() : "viewport";

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
        const vmState = status.vm ? ` VM: ${status.vm.state}.` : "";
        els.nativeStatus.dataset.mode = "ready";
        els.nativeStatus.textContent = `EMUSTAR ready with Microsoft Hyper-V${bridgeLabel}.${vmState}`;
        if (state.emulator && await adoptRunningHyperVViewport(status, base)) {
          els.nativeStatus.textContent = `EMUSTAR display is live in the browser viewport${bridgeLabel}.`;
        }
      } else if (status.restartRequired) {
        els.nativeStatus.dataset.mode = "missing";
        els.nativeStatus.textContent =
          "Hyper-V is enabled on the Windows host. Restart that Windows PC once to finish preparing EMUSTAR.";
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
    const hostedEmustarMode = emustarMode && isNetlifyLauncher;
    els.nativeRuntimeIcon.src = isStandaloneQemuMode() ? "/assets/qemu-icon.png" : "/assets/emustar-icon.png";
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
  els.bootOrder.disabled = remoteMode || state.emulator;
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
  if (emustarMode) {
    void refreshStoredIsos({ silent: true });
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
els.storedImagesButton.addEventListener("click", () => {
  setStoredImagesMenuOpen(!state.storedImagesMenuOpen);
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
    setEmulatorMenuOpen(false);
    setStoredImagesMenuOpen(false);
    if (!els.keepIsoDialog.hidden) {
      els.keepIsoNoButton.click();
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
els.nativeIsoPath.addEventListener("input", () => updateButtons());
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

initMobileDevBypass();
if (window.sessionStorage.getItem(MOBILE_DEV_UNLOCK_KEY) === "1") {
  applyMobileDevMode();
}

log("NebulaVM ready.");
renderStoredIsoSlots();
updateBackendUi();
void connectNetlifyHostRegistry();
updateButtons();
updateViewportSummary();
state.viewportSummaryTimer = window.setInterval(updateViewportSummary, 3000);
