import { hcaptchaConfig, publicHcaptchaConfig, verifyHcaptcha } from "../../lib/hcaptcha.mjs";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

export default async function handler(request, context) {
  try {
    const config = hcaptchaConfig();
    if (request.method === "GET") return json(publicHcaptchaConfig(config));
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const text = await request.text();
    if (text.length > 20000) return json({ error: "Request too large." }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "Invalid request." }, 400); }
    return json(await verifyHcaptcha(body?.captchaToken, config, { remoteip: context?.ip || "" }));
  } catch (error) {
    return json({ error: error.message }, error.statusCode || 500);
  }
}
