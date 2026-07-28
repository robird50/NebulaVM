import { analyzeViewport } from "../../lib/viewportAi.mjs";

const recentRequests = new Map();
const MIN_REQUEST_GAP_MS = 2_700;

const json = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

const clientKey = (request, context) =>
  String(
    context?.ip ||
      request.headers.get("x-nf-client-connection-ip") ||
      request.headers.get("x-forwarded-for") ||
      "unknown",
  )
    .split(",")[0]
    .trim();

export default async (request, context = {}) => {
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed." });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json(403, { ok: false, error: "Cross-origin AI requests are not allowed." });
  }

  const key = clientKey(request, context);
  const now = Date.now();
  const lastRequest = recentRequests.get(key) || 0;
  if (now - lastRequest < MIN_REQUEST_GAP_MS) {
    return json(429, { ok: false, error: "AI screen analysis is updating too quickly." });
  }
  recentRequests.set(key, now);

  try {
    const body = await request.json();
    const result = await analyzeViewport({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_VIEWPORT_MODEL || undefined,
      body,
    });
    return json(200, { ok: true, ...result });
  } catch (error) {
    return json(Number(error.statusCode) || 500, {
      ok: false,
      error: error.message || "AI screen analysis failed.",
    });
  }
};

