import { getStore } from "@netlify/blobs";

const STORE_NAME = "nebulavm-host-registry";
const CURRENT_KEY = "current";
const MAX_AGE_MS = 1000 * 60 * 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const json = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders,
  });

const cleanTryCloudflareUrl = (value) => {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname)) {
    throw new Error("Only active trycloudflare host URLs can be registered.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = "/";
  return url.toString().replace(/\/$/, "");
};

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const store = getStore(STORE_NAME);

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const publicUrl = cleanTryCloudflareUrl(body.publicUrl);
    const accessToken = String(body.accessToken || "").trim();
    if (!/^[a-f0-9]{32,}$/i.test(accessToken)) {
      return json(400, { ok: false, error: "Missing NebulaVM host token." });
    }

    const host = {
      publicUrl,
      accessToken,
      updatedAt: new Date().toISOString(),
      source: "NebulaVM Host",
    };
    await store.setJSON(CURRENT_KEY, host);
    return json(200, { ok: true, host });
  }

  if (request.method === "GET") {
    const host = await store.get(CURRENT_KEY, { type: "json" });
    if (!host) {
      return json(404, { ok: false, error: "No NebulaVM host is registered yet." });
    }

    const ageMs = Date.now() - Date.parse(host.updatedAt || 0);
    return json(200, {
      ok: true,
      stale: !Number.isFinite(ageMs) || ageMs > MAX_AGE_MS,
      host,
    });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
