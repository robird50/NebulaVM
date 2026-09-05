import "./vmCaptcha.css";

const endpoint = "/.netlify/functions/vm-captcha";
let pending = false;

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
    const channelId = crypto.randomUUID();
    const channel = new BroadcastChannel(`nebulavm-captcha-${channelId}`);
    const dialog = document.createElement("dialog");
    dialog.className = "vm-captcha-dialog";
    dialog.setAttribute("aria-labelledby", "vm-captcha-title");
    dialog.innerHTML = `<h2 id="vm-captcha-title">Verify before starting</h2>
      <p role="status">Waiting for hCaptcha verification.</p>
      <div class="vm-captcha-actions"><button type="button" data-open>Open verification</button>
      <button type="button" data-cancel>Cancel</button></div>`;
    document.body.append(dialog);
    dialog.showModal();
    const status = dialog.querySelector('[role="status"]');
    let popup;
    let settled = false;
    let lastHeartbeat = 0;
    const deadline = setTimeout(() => finish(new Error("Verification timed out. Click Start to try again.")), 5 * 60000);
    const heartbeat = setInterval(() => {
      if (lastHeartbeat && Date.now() - lastHeartbeat > 15000 && !document.hidden) {
        finish(new Error("Verification window disconnected. Click Start to try again."));
      }
    }, 1000);
    function finish(error, token) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(heartbeat);
      channel.postMessage({ type: "close" });
      channel.close();
      try { popup?.close(); } catch { /* COOP can sever the window reference. */ }
      dialog.close();
      dialog.remove();
      pending = false;
      if (error) reject(error); else resolve(token);
    }
    const cancel = () => finish(Object.assign(new Error("VM start cancelled."), { name: "AbortError" }));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); cancel(); });
    dialog.querySelector("[data-cancel]").addEventListener("click", cancel);
    const open = () => {
      popup = window.open(`/captcha.html#${channelId}`, `captcha-${channelId}`, "popup,width=420,height=620");
      status.textContent = popup ? "Waiting for hCaptcha verification." : "Verification window blocked. Select Open verification to continue.";
    };
    dialog.querySelector("[data-open]").addEventListener("click", open);
    channel.onmessage = ({ data }) => {
      if (data?.type === "ready") {
        lastHeartbeat = Date.now();
        dialog.querySelector("[data-open]").disabled = true;
      }
      else if (data?.type === "solved" && typeof data.token === "string" && data.token.length <= 16384) finish(null, data.token);
      else if (data?.type === "error") finish(new Error("hCaptcha is unavailable. Please try again later."));
      else if (data?.type === "cancel") cancel();
    };
    open();
  });
}
