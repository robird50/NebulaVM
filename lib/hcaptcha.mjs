const fail = (message, statusCode = 403) => Object.assign(new Error(message), { statusCode });

export const hcaptchaConfig = (readEnv = (name) => process.env[name]) => ({
  sitekey: String(readEnv("HCAPTCHA_SITE_KEY") || "").trim(),
  secret: String(readEnv("HCAPTCHA_SECRET") || "").trim(),
});

export const publicHcaptchaConfig = (config) => {
  if (!config.sitekey || !config.secret) {
    throw fail("VM verification is not configured on the server yet. Please try again later.", 503);
  }
  return { ok: true, sitekey: config.sitekey };
};

export async function verifyHcaptcha(token, config, { fetchImpl = fetch, remoteip = "" } = {}) {
  publicHcaptchaConfig(config);
  if (typeof token !== "string" || !token.trim() || token.length > 16384) {
    throw fail("Complete hCaptcha before starting a VM.");
  }
  const body = new URLSearchParams({ secret: config.secret, sitekey: config.sitekey, response: token });
  if (remoteip) body.set("remoteip", remoteip);
  let result;
  try {
    const response = await fetchImpl("https://api.hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error("Verification service unavailable");
    result = await response.json();
  } catch {
    throw fail("hCaptcha could not be verified. Please try again; the VM has not started.", 503);
  }
  // Tokens are single-use. Never cache a success or accept a client-only callback.
  if (result?.success !== true) {
    throw fail("hCaptcha expired or was not accepted. Please solve a new challenge.");
  }
  return { ok: true };
}
