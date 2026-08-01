import RFB from "@novnc/novnc";
import "./remote.css";

const registryUrl = "https://nebulavm.online/.netlify/functions/host-registry";
const viewport = document.querySelector("#remoteViewport");
const message = document.querySelector("#remoteMessage");
const stateLabel = document.querySelector("#remoteState");
const reconnectButton = document.querySelector("#reconnectButton");
const fullscreenButton = document.querySelector("#fullscreenButton");
const fullscreenExitButton = document.querySelector("#fullscreenExitButton");
const expectedSessionId = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("session") || "";

let rfb = null;
let mirrorTimer = null;
let mirrorFrameUrl = "";
let mirrorActive = false;
let mirrorBase = "";
let mirrorToken = "";
let mirrorPoll = null;
let appFullscreen = false;
let mirrorFastUntil = 0;

const viewportChildren = (...children) => {
  viewport.replaceChildren(message, ...children.filter(Boolean), fullscreenExitButton);
};

const nativeFullscreenElement = () =>
  document.fullscreenElement ||
  document.webkitFullscreenElement ||
  document.msFullscreenElement ||
  null;

const isNativeFullscreen = () => nativeFullscreenElement() === viewport;
const isRemoteFullscreen = () => isNativeFullscreen() || appFullscreen;

const setVisualViewportSize = () => {
  const visual = window.visualViewport;
  const width = Math.max(
    320,
    Math.round(visual?.width || window.innerWidth || document.documentElement.clientWidth || 0),
  );
  const height = Math.max(
    320,
    Math.round(visual?.height || window.innerHeight || document.documentElement.clientHeight || 0),
  );
  document.documentElement.style.setProperty("--remote-visual-width", `${width}px`);
  document.documentElement.style.setProperty("--remote-visual-height", `${height}px`);
};

const refreshRemoteViewport = () => {
  setVisualViewportSize();
  if (mirrorActive) pollMirrorFrame(20);
};

const updateFullscreenUi = () => {
  const active = isRemoteFullscreen();
  viewport.classList.toggle("is-remote-fullscreen", active);
  fullscreenButton.textContent = active ? "Exit fullscreen" : "Fullscreen";
  fullscreenButton.setAttribute("aria-pressed", String(active));
  fullscreenExitButton.hidden = !active;
  refreshRemoteViewport();
};

const enterAppFullscreen = () => {
  appFullscreen = true;
  document.body.classList.add("remote-app-fullscreen");
  window.scrollTo(0, 0);
  updateFullscreenUi();
};

const exitAppFullscreen = () => {
  appFullscreen = false;
  document.body.classList.remove("remote-app-fullscreen");
  updateFullscreenUi();
};

const requestNativeFullscreen = async () => {
  const request =
    viewport.requestFullscreen ||
    viewport.webkitRequestFullscreen ||
    viewport.msRequestFullscreen;
  if (!request) return false;
  await request.call(viewport);
  return true;
};

const exitNativeFullscreen = async () => {
  const exit =
    document.exitFullscreen ||
    document.webkitExitFullscreen ||
    document.msExitFullscreen;
  if (exit) await exit.call(document);
};

const isMobileViewport = () =>
  window.matchMedia?.("(pointer: coarse), (max-width: 760px)")?.matches || false;

const showMessage = (title, detail, state = "Waiting") => {
  message.hidden = false;
  message.querySelector("strong").textContent = title;
  message.querySelector("small").textContent = detail;
  stateLabel.textContent = state;
};

const remoteHeaders = (token, extra = {}) => ({
  ...extra,
  Authorization: `Bearer ${token}`,
  "X-NebulaVM-Client-Class": "remote-console",
});

const websocketUrl = (base, path, token) => {
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
};

const clearMirror = () => {
  mirrorActive = false;
  mirrorFastUntil = 0;
  if (mirrorTimer) {
    window.clearTimeout(mirrorTimer);
    mirrorTimer = null;
  }
  if (mirrorFrameUrl) {
    URL.revokeObjectURL(mirrorFrameUrl);
    mirrorFrameUrl = "";
  }
  mirrorPoll = null;
  viewport.querySelector(".remote-console-bridge")?.remove();
};

const clearRfb = () => {
  rfb?.disconnect();
  rfb = null;
  viewport.querySelector("canvas")?.remove();
};

const fetchHostRegistry = async () => {
  const response = await fetch(registryUrl, { cache: "no-store" });
  const registry = await response.json();
  if (!response.ok || !registry.ok || !registry.host?.publicUrl) {
    throw new Error("No active NebulaVM Host is registered.");
  }
  return {
    base: String(registry.host.publicUrl).replace(/\/$/, ""),
    token: String(registry.host.accessToken || ""),
  };
};

const fetchHostStatus = async (base, token) => {
  const response = await fetch(`${base}/api/emustar-hyperv/status`, {
    cache: "no-store",
    headers: remoteHeaders(token),
  });
  const status = await response.json();
  if (!response.ok || !status.ok) {
    throw new Error(status.error || "The Hyper-V host status could not be read.");
  }
  if (
    expectedSessionId &&
    status.remoteSessionId &&
    status.remoteSessionId !== expectedSessionId
  ) {
    throw new Error("This remote link belongs to a different Hyper-V session. Copy a fresh browser link.");
  }
  if (expectedSessionId && !status.remoteSessionId) {
    throw new Error("This remote link is no longer active. Start Hyper-V again and copy a fresh link.");
  }
  return status;
};

const fetchMirrorFrame = async (contentOnly = false) => {
  const frameUrl = new URL("/api/emustar-hyperv/console-frame", mirrorBase);
  if (contentOnly) frameUrl.searchParams.set("contentOnly", "1");
  const response = await fetch(frameUrl, {
    cache: "no-store",
    headers: remoteHeaders(mirrorToken),
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
    let error = "The Hyper-V setup mirror is not ready yet.";
    if (contentType.toLowerCase().includes("application/json")) {
      const data = await response.json().catch(() => ({}));
      error = data.error || error;
    }
    throw new Error(error);
  }
  return {
    blob: await response.blob(),
    width: Number(response.headers.get("X-NebulaVM-Frame-Width")) || 0,
    height: Number(response.headers.get("X-NebulaVM-Frame-Height")) || 0,
  };
};

const sendMirrorInput = async (payload) => {
  if (!mirrorActive) return;
  mirrorFastUntil = Date.now() + 1600;
  pollMirrorFrame(8);
  try {
    await fetch(`${mirrorBase}/api/emustar-hyperv/console-input`, {
      method: "POST",
      headers: remoteHeaders(mirrorToken, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    pollMirrorFrame(8);
  } catch (error) {
    showMessage("Remote input failed", error.message || "Try again in a moment.", "Live");
  }
};

const startMirrorConsole = (base, token) => {
  clearRfb();
  clearMirror();
  mirrorActive = true;
  mirrorBase = base;
  mirrorToken = token;

  const shell = document.createElement("div");
  shell.className = "remote-console-bridge";
  shell.tabIndex = 0;

  const image = document.createElement("img");
  image.alt = "Hyper-V remote setup console";
  image.draggable = false;

  const status = document.createElement("span");
  status.className = "remote-console-status";
  status.textContent = "Opening Hyper-V setup mirror...";

  shell.append(image, status);
  viewportChildren(shell);
  message.hidden = true;
  stateLabel.textContent = "Live";
  reconnectButton.disabled = false;
  shell.focus({ preventScroll: true });

  let pointerStart = null;
  const pointerToFramePoint = (event) => {
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      type: "click",
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      contentOnly: isRemoteFullscreen(),
    };
  };

  image.addEventListener("pointerdown", (event) => {
    const point = pointerToFramePoint(event);
    if (!point) return;
    event.preventDefault();
    shell.focus({ preventScroll: true });
    image.setPointerCapture?.(event.pointerId);
    pointerStart = { id: event.pointerId, x: point.x, y: point.y };
    void sendMirrorInput(point);
  });

  image.addEventListener("pointerup", (event) => {
    const point = pointerToFramePoint(event);
    if (!point || !pointerStart || pointerStart.id !== event.pointerId) return;
    event.preventDefault();
    image.releasePointerCapture?.(event.pointerId);
    const moved = Math.hypot(point.x - pointerStart.x, point.y - pointerStart.y);
    if (moved > 18) mirrorFastUntil = Date.now() + 500;
    pointerStart = null;
  });

  image.addEventListener("pointercancel", (event) => {
    if (pointerStart?.id === event.pointerId) pointerStart = null;
  });

  shell.addEventListener("keydown", (event) => {
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
      void sendMirrorInput({ type: "text", text: event.key });
      return;
    }
    if (specialKeys.has(event.key)) {
      event.preventDefault();
      void sendMirrorInput({ type: "key", key: event.key, shiftKey: event.shiftKey });
    }
  });

  shell.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") || "";
    if (!text) return;
    event.preventDefault();
    void sendMirrorInput({ type: "text", text });
  });

  const poll = async () => {
    if (!mirrorActive) return;
    try {
      const frame = await fetchMirrorFrame(isRemoteFullscreen());
      const nextUrl = URL.createObjectURL(frame.blob);
      if (mirrorFrameUrl) URL.revokeObjectURL(mirrorFrameUrl);
      mirrorFrameUrl = nextUrl;
      image.src = nextUrl;
      if (frame.width) image.width = frame.width;
      if (frame.height) image.height = frame.height;
      status.textContent = "Click, type, Tab, arrows, Enter, and paste to control this VM.";
      const nextDelay = Date.now() < mirrorFastUntil ? 83 : 280;
      mirrorTimer = window.setTimeout(poll, nextDelay);
    } catch (error) {
      status.textContent = `Waiting for Hyper-V mirror: ${error.message}`;
      mirrorTimer = window.setTimeout(poll, 800);
    }
  };

  mirrorPoll = poll;
  pollMirrorFrame(0);
};

const pollMirrorFrame = (delay = 0) => {
  if (!mirrorActive) return;
  if (mirrorTimer) window.clearTimeout(mirrorTimer);
  mirrorTimer = window.setTimeout(() => mirrorPoll?.(), delay);
};

const connectVnc = (base, token, status) => {
  clearMirror();
  clearRfb();
  message.hidden = false;
  viewportChildren();

  rfb = new RFB(viewport, websocketUrl(base, status.vncPath, token));
  rfb.background = "#05070a";
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.viewOnly = false;
  rfb.focusOnClick = true;
  rfb.addEventListener("credentialsrequired", () => {
    rfb?.sendCredentials({ password: status.vncPassword || "" });
  });
  rfb.addEventListener("connect", () => {
    message.hidden = true;
    stateLabel.textContent = "Live";
    reconnectButton.disabled = false;
  });
  rfb.addEventListener("disconnect", () => {
    showMessage(
      "Remote display disconnected",
      "Press Reconnect after checking the Windows host.",
      "Offline",
    );
    reconnectButton.disabled = false;
  });
};

const connect = async () => {
  clearRfb();
  clearMirror();
  viewportChildren();
  showMessage("Finding your Hyper-V VM...", "Keep NebulaVM Host running on the Windows host.", "Connecting");
  reconnectButton.disabled = true;

  try {
    const { base, token } = await fetchHostRegistry();
    const status = await fetchHostStatus(base, token);
    if (status.vncReady && status.vncPath) {
      connectVnc(base, token, status);
      return;
    }
    if (status.running || status.vm?.state === "Running") {
      startMirrorConsole(base, token);
      return;
    }
    throw new Error("Start a Hyper-V VM on NebulaVM first, then reconnect.");
  } catch (error) {
    showMessage(
      error.message || "The Hyper-V console could not connect.",
      "The host must stay online and a Hyper-V VM must be running.",
      "Offline",
    );
    reconnectButton.disabled = false;
  }
};

reconnectButton.addEventListener("click", connect);
const toggleFullscreen = async () => {
  try {
    if (appFullscreen) {
      exitAppFullscreen();
      return;
    }
    if (isNativeFullscreen()) {
      await exitNativeFullscreen();
      return;
    }
    if (isMobileViewport()) {
      enterAppFullscreen();
      return;
    }
    const nativeStarted = await requestNativeFullscreen();
    if (!nativeStarted || !isNativeFullscreen()) enterAppFullscreen();
  } catch (error) {
    enterAppFullscreen();
    if (!isRemoteFullscreen()) {
      showMessage(
        "Fullscreen was blocked",
        error.message || "Use your browser menu to enter fullscreen.",
        "Live",
      );
    }
  }
};

fullscreenButton.addEventListener("click", toggleFullscreen);
fullscreenExitButton.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  if (!isNativeFullscreen()) appFullscreen = false;
  updateFullscreenUi();
});
document.addEventListener("webkitfullscreenchange", updateFullscreenUi);
window.addEventListener("resize", refreshRemoteViewport);
window.addEventListener("orientationchange", refreshRemoteViewport);
window.visualViewport?.addEventListener("resize", refreshRemoteViewport);
window.visualViewport?.addEventListener("scroll", refreshRemoteViewport);

window.addEventListener("pagehide", () => {
  exitAppFullscreen();
  clearRfb();
  clearMirror();
});
setVisualViewportSize();
viewportChildren();
updateFullscreenUi();
void connect();
