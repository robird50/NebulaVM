import { getStore } from "@netlify/blobs";
import {
  MOBILE_DEVICE_COOKIE,
  SOURCE_APPROVED_IPV6_HASHES,
  createDeviceRecord,
  createDeviceToken,
  isApprovedIpv6,
  isDeviceTokenValid,
  isIpv6,
  normalizeIp,
  parseAllowedIpv6,
  parseCookies,
  renewDeviceRecord,
  safeEqualHex,
  serializeDeviceCookie,
  sha256Hex,
} from "../../lib/mobileDevAccess.mjs";

const STORE_NAME = "nebulavm-mobile-dev-unlock";
const APPROVED_DEVICE_KEY = "approved-device";
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

const baseHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const json = (status, payload, extraHeaders = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...baseHeaders, ...extraHeaders },
  });

const configuredCodeHash = () => {
  const directHash = String(process.env.NEBULAVM_MOBILE_DEV_CODE_HASH || "").trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(directHash)) return directHash;

  const rawCode = String(process.env.NEBULAVM_MOBILE_DEV_CODE || "").trim();
  return /^\d{6}$/.test(rawCode) ? sha256Hex(rawCode) : "";
};

const requestClientIp = (request, context = {}) =>
  normalizeIp(
    context.ip ||
      request.headers.get("x-nf-client-connection-ip") ||
      request.headers.get("x-forwarded-for") ||
      "",
  );

const clientKey = (request, context) => {
  const userAgent = String(request.headers.get("user-agent") || "").slice(0, 180);
  return `attempt-${sha256Hex(`${requestClientIp(request, context)}|${userAgent}`)}`;
};

const remainingMs = (lockUntil) => Math.max(0, Number(lockUntil || 0) - Date.now());

const deviceCookie = (request) =>
  parseCookies(request.headers.get("cookie"))[MOBILE_DEVICE_COOKIE] || "";

const saveApprovedDevice = async (store, record) => {
  await store.setJSON(APPROVED_DEVICE_KEY, record);
};

const approvedDevice = async (store) =>
  (await store.get(APPROVED_DEVICE_KEY, { type: "json" }).catch(() => null)) || null;

const deviceSuccess = async (store, record, token, deviceEnrolled) => {
  const renewed = renewDeviceRecord(record);
  await saveApprovedDevice(store, renewed);
  return json(
    200,
    { ok: true, deviceEnrolled },
    { "Set-Cookie": serializeDeviceCookie(token) },
  );
};

const denied = () =>
  json(403, { ok: false, error: "Your IP has not been granted permission to view this page" });

export default async (request, context = {}) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders });
  }
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed." });
  }

  const expectedHash = configuredCodeHash();
  if (!expectedHash) {
    return json(503, { ok: false, error: "Mobile developer unlock is not configured." });
  }

  const body = await request.json().catch(() => ({}));
  const store = getStore(STORE_NAME);
  const clientIp = requestClientIp(request, context);
  if (!isIpv6(clientIp)) return denied();

  const token = deviceCookie(request);
  const record = await approvedDevice(store);
  const hasValidDevice = isDeviceTokenValid(record, token);

  if (body.validateDevice === true) {
    return hasValidDevice ? deviceSuccess(store, record, token, false) : denied();
  }

  const code = String(body.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return json(400, { ok: false, error: "Enter the 6-digit developer code." });
  }

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

  if (safeEqualHex(sha256Hex(code), expectedHash)) {
    if (hasValidDevice) {
      await store.setJSON(key, { attempts: 0, lockUntil: 0, updatedAt: new Date().toISOString() });
      return deviceSuccess(store, record, token, false);
    }

    const allowedIps = parseAllowedIpv6(process.env.NEBULAVM_MOBILE_DEV_ALLOWED_IPS);
    if (!allowedIps.size && !SOURCE_APPROVED_IPV6_HASHES.size) {
      return json(503, { ok: false, error: "Mobile developer IP access is not configured." });
    }
    if (!isApprovedIpv6(clientIp, allowedIps)) return denied();

    const newToken = createDeviceToken();
    const newRecord = createDeviceRecord(newToken);
    await store.setJSON(key, { attempts: 0, lockUntil: 0, updatedAt: new Date().toISOString() });
    await saveApprovedDevice(store, newRecord);
    return json(
      200,
      { ok: true, deviceEnrolled: true },
      { "Set-Cookie": serializeDeviceCookie(newToken) },
    );
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
