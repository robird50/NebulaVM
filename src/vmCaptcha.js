import "./vmCaptcha.css";

const endpoint = "/.netlify/functions/vm-captcha";
let pending = false;
const transitionMs = 320;

export async function verifyBrowserVmCaptcha(captchaToken) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ captchaToken }),
    signal: AbortSignal.timeout(16000),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(result.error || "hCaptcha verification failed.");
}

export function requestVmCaptcha() {
  if (pending) return Promise.reject(new Error("VM verification is already in progress."));
  if (typeof BroadcastChannel !== "function" || typeof crypto.randomUUID !== "function") {
    return Promise.reject(new Error("VM verification requires a modern browser and a secure HTTPS connection."));
  }
  pending = true;
  return new Promise((resolve, reject) => {
    const viewport = document.querySelector("#screenContainer");
    if (!viewport) {
      pending = false;
      reject(new Error("The VM viewport is unavailable."));
      return;
    }
    const channelId = crypto.randomUUID();
    const channel = new BroadcastChannel(`nebulavm-captcha-${channelId}`);
    const overlay = document.createElement("section");
    overlay.className = "vm-captcha-viewport";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Verify before starting");
    overlay.innerHTML = `<iframe id="vmCaptchaFrame" title="hCaptcha verification" src="/captcha.html#${channelId}" credentialless></iframe>`;
    viewport.append(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add("is-visible");
      overlay.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    let settled = false;
    let lastHeartbeat = 0;
    const deadline = setTimeout(() => finish(new Error("Verification timed out. Click Start to try again.")), 5 * 60000);
    const heartbeat = setInterval(() => {
      if (lastHeartbeat && Date.now() - lastHeartbeat > 15000 && !document.hidden) {
        finish(new Error("Verification panel disconnected. Click Start to try again."));
      }
    }, 1000);
    function finish(error, token) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(heartbeat);
      window.removeEventListener("message", receiveWindowMessage);
      channel.postMessage({ type: "close" });
      overlay.classList.remove("is-visible");
      overlay.classList.add("is-leaving");
      setTimeout(() => {
        channel.close();
        overlay.remove();
        pending = false;
        if (error) reject(error); else resolve(token);
      }, transitionMs);
    }
    const cancel = () => finish(Object.assign(new Error("VM start cancelled."), { name: "AbortError" }));
    const receive = (data) => {
      if (data?.type === "ready") lastHeartbeat = Date.now();
      else if (data?.type === "solved" && typeof data.token === "string" && data.token.length <= 16384) finish(null, data.token);
      else if (data?.type === "error") finish(new Error("hCaptcha is unavailable. Please try again later."));
      else if (data?.type === "cancel") cancel();
    };
    const receiveWindowMessage = (event) => {
      if (event.origin !== location.origin || event.data?.channelId !== channelId) return;
      receive(event.data);
    };
    window.addEventListener("message", receiveWindowMessage);
    channel.onmessage = ({ data }) => receive(data);
  });
}

export function animateVmViewportIn() {
  const viewport = document.querySelector("#screenContainer");
  if (!viewport) return;
  viewport.classList.remove("vm-display-entering");
  void viewport.offsetWidth;
  viewport.classList.add("vm-display-entering");
  setTimeout(() => viewport.classList.remove("vm-display-entering"), 500);
}
