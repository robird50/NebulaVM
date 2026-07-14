import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const STORE_NAME = "nebulavm-mobile-dev-unlock";
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const json = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers,
  });

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

const configuredCodeHash = () => {
  const directHash = String(process.env.NEBULAVM_MOBILE_DEV_CODE_HASH || "").trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(directHash)) return directHash;

  const rawCode = String(process.env.NEBULAVM_MOBILE_DEV_CODE || "").trim();
  if (/^\d{6}$/.test(rawCode)) return sha256(rawCode);

  return "";
};

const safeEqualHex = (left, right) => {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const clientKey = (request) => {
  const forwardedFor = String(request.headers.get("x-forwarded-for") || "")
    .split(",")[0]
    .trim();
  const userAgent = String(request.headers.get("user-agent") || "").slice(0, 180);
  return sha256(`${forwardedFor}|${userAgent}`);
};

const remainingMs = (lockUntil) => Math.max(0, Number(lockUntil || 0) - Date.now());

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed." });
  }

  const expectedHash = configuredCodeHash();
  if (!expectedHash) {
    return json(503, { ok: false, error: "Mobile developer unlock is not configured." });
  }

  const body = await request.json().catch(() => ({}));
  const code = String(body.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return json(400, { ok: false, error: "Enter the 6-digit developer code." });
  }

  const store = getStore(STORE_NAME);
  const key = clientKey(request);
  const saved = (await store.get(key, { type: "json" }).catch(() => null)) || {
    attempts: 0,
    lockUntil: 0,
  };

  const lockRemainingMs = remainingMs(saved.lockUntil);
  if (lockRemainingMs > 0) {
    return json(429, {
      ok: false,
      error: "Too many misses. Try again later.",
      lockRemainingMs,
      remainingAttempts: 0,
    });
  }

  if (safeEqualHex(sha256(code), expectedHash)) {
    await store.setJSON(key, {
      attempts: 0,
      lockUntil: 0,
      updatedAt: new Date().toISOString(),
    });
    return json(200, { ok: true });
  }

  const attempts = Number(saved.attempts || 0) + 1;
  const shouldLock = attempts >= MAX_ATTEMPTS;
  const nextLockUntil = shouldLock ? Date.now() + LOCK_MS : 0;
  await store.setJSON(key, {
    attempts: shouldLock ? 0 : attempts,
    lockUntil: nextLockUntil,
    updatedAt: new Date().toISOString(),
  });

  return json(401, {
    ok: false,
    error: shouldLock ? "Locked for 5 minutes." : "Incorrect developer code.",
    remainingAttempts: shouldLock ? 0 : MAX_ATTEMPTS - attempts,
    lockRemainingMs: shouldLock ? LOCK_MS : 0,
  });
};
