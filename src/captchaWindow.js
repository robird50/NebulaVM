import "./vmCaptcha.css";

const status = document.querySelector("#status");
const channelId = location.hash.slice(1);
if (!/^[a-f0-9-]{36}$/.test(channelId)) {
  status.textContent = "Start a VM from the NebulaVM page to verify.";
} else {
  const channel = new BroadcastChannel(`nebulavm-captcha-${channelId}`);
  let finished = false;
  let widget;
  let widgetReady = false;
  const send = (data) => channel.postMessage(data);
  const heartbeat = setInterval(() => send({ type: "ready" }), 1000);
  send({ type: "ready" });
  const close = () => {
    finished = true;
    clearInterval(heartbeat);
    channel.close();
    window.close();
  };
  channel.onmessage = ({ data }) => { if (data?.type === "close") close(); };
  document.querySelector("#cancel").onclick = () => { send({ type: "cancel" }); close(); };
  window.addEventListener("pagehide", () => { if (!finished) send({ type: "cancel" }); });
  const error = () => {
    status.textContent = "Verification unavailable. Cancel and try again later.";
    send({ type: "error" });
  };
  try {
    const response = await fetch("/.netlify/functions/vm-captcha", { cache: "no-store", signal: AbortSignal.timeout(12000) });
    const config = await response.json();
    if (!response.ok || !config.sitekey) throw new Error("Not configured");
    window.nebulaCaptchaReady = () => {
      widgetReady = true;
      status.textContent = "Verification required";
      widget = window.hcaptcha.render("challenge", {
        sitekey: config.sitekey,
        theme: "dark",
        size: matchMedia("(max-width: 360px)").matches ? "compact" : "normal",
        callback: (token) => { status.textContent = "Verification completed."; send({ type: "solved", token }); },
        "expired-callback": () => { status.textContent = "Verification expired. Please try again."; window.hcaptcha.reset(widget); },
        "error-callback": error,
      });
    };
    const script = document.createElement("script");
    script.src = "https://js.hcaptcha.com/1/api.js?onload=nebulaCaptchaReady&render=explicit";
    script.async = true;
    script.onerror = error;
    document.head.append(script);
    setTimeout(() => { if (!finished && !widgetReady) error(); }, 20000);
  } catch { error(); }
}
