import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const STORE_NAME = "nebulavm-mobile-dev-unlock";
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;
const SOURCE_APPROVED_IPV6_HASHES = new Set([
  "7ee703782af08ddbff3952e81b0ae298ed9ab12dedf02f995dc2e657c41c9270",
]);

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

const normalizeIp = (value) => {
  let ip = String(value || "").split(",")[0].trim().replace(/^"|"$/g, "");
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) ip = bracketed[1];
  if (/^::ffff:/i.test(ip)) ip = ip.slice(7);
  const zoneIndex = ip.indexOf("%");
  if (zoneIndex >= 0) ip = ip.slice(0, zoneIndex);
  return ip.toLowerCase();
};

const isIpv6 = (value) => normalizeIp(value).includes(":");

const configuredAllowedIps = () =>
  new Set(
    String(process.env.NEBULAVM_MOBILE_DEV_ALLOWED_IPS || "")
      .split(/[\s,]+/)
      .map(normalizeIp)
      .filter((ip) => ip && isIpv6(ip)),
  );

const isApprovedIpv6 = (ip, configuredIps) =>
  isIpv6(ip) && (configuredIps.has(ip) || SOURCE_APPROVED_IPV6_HASHES.has(sha256(ip)));

const requestClientIp = (request, context = {}) =>
  normalizeIp(
    context.ip ||
      request.headers.get("x-nf-client-connection-ip") ||
      request.headers.get("x-forwarded-for") ||
      "",
  );

const clientKey = (request, context) => {
  const clientIp = requestClientIp(request, context);
  const userAgent = String(request.headers.get("user-agent") || "").slice(0, 180);
  return sha256(`${clientIp}|${userAgent}`);
};

const remainingMs = (lockUntil) => Math.max(0, Number(lockUntil || 0) - Date.now());

export default async (request, context = {}) => {
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
  const key = clientKey(request, context);
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
    const allowedIps = configuredAllowedIps();
    const clientIp = requestClientIp(request, context);
    if (!allowedIps.size && !SOURCE_APPROVED_IPV6_HASHES.size) {
      return json(503, { ok: false, error: "Mobile developer IP access is not configured." });
    }
    if (!isApprovedIpv6(clientIp, allowedIps)) {
      return json(403, { ok: false, error: "Your IP has not been granted permission to view this page" });
    }

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
