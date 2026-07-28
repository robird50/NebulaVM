import RFB from "@novnc/novnc";
import "./remote.css";

const registryUrl = "https://nebulavm.online/.netlify/functions/host-registry";
const viewport = document.querySelector("#remoteViewport");
const message = document.querySelector("#remoteMessage");
const stateLabel = document.querySelector("#remoteState");
const reconnectButton = document.querySelector("#reconnectButton");
const fullscreenButton = document.querySelector("#fullscreenButton");

let rfb = null;

const showMessage = (title, detail, state = "Waiting") => {
  message.hidden = false;
  message.querySelector("strong").textContent = title;
  message.querySelector("small").textContent = detail;
  stateLabel.textContent = state;
};

const websocketUrl = (base, path, token) => {
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
};

const connect = async () => {
  rfb?.disconnect();
  rfb = null;
  showMessage(
    "Finding your Windows VM…",
    "Keep NebulaVM Host and the Windows guest running.",
    "Connecting",
  );
  reconnectButton.disabled = true;

  try {
    const registryResponse = await fetch(registryUrl, { cache: "no-store" });
    const registry = await registryResponse.json();
    if (!registryResponse.ok || !registry.ok || !registry.host?.publicUrl) {
      throw new Error("No active NebulaVM Host is registered.");
    }

    const base = String(registry.host.publicUrl).replace(/\/$/, "");
    const token = String(registry.host.accessToken || "");
    const statusResponse = await fetch(`${base}/api/emustar-hyperv/status`, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-NebulaVM-Client-Class": "remote-console",
      },
    });
    const status = await statusResponse.json();
    if (!statusResponse.ok || !status.ok) {
      throw new Error(status.error || "The Windows VM status could not be read.");
    }
    if (!status.vncReady || !status.vncPath) {
      throw new Error(
        status.running
          ? "The Windows VM is running, but its browser display is not ready yet."
          : "Start the Windows VM with EMUSTAR on the host first.",
      );
    }

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
        "Windows display disconnected",
        "Press Reconnect after checking the Windows host.",
        "Offline",
      );
      reconnectButton.disabled = false;
    });
  } catch (error) {
    showMessage(
      error.message || "The Windows console could not connect.",
      "The host must stay online and its Windows VM must already be running.",
      "Offline",
    );
    reconnectButton.disabled = false;
  }
};

reconnectButton.addEventListener("click", connect);
fullscreenButton.addEventListener("click", async () => {
  try {
    await viewport.requestFullscreen();
  } catch {
    showMessage("Fullscreen was blocked", "Use your browser menu to enter fullscreen.", "Live");
  }
});

window.addEventListener("pagehide", () => rfb?.disconnect());
void connect();
