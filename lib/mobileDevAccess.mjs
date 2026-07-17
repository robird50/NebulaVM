import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const MOBILE_DEVICE_COOKIE = "__Host-nebulavm-mobile-device";
export const MOBILE_DEVICE_DEV_COOKIE = "nebulavm-mobile-device-dev";
export const MOBILE_DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const SOURCE_APPROVED_IPV6_HASHES = new Set([
  "7ee703782af08ddbff3952e81b0ae298ed9ab12dedf02f995dc2e657c41c9270",
]);

export const sha256Hex = (value) =>
  createHash("sha256").update(String(value)).digest("hex");

export const safeEqualHex = (left, right) => {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export const normalizeIp = (value) => {
  let ip = String(value || "").split(",")[0].trim().replace(/^"|"$/g, "");
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) ip = bracketed[1];
  if (/^::ffff:/i.test(ip)) ip = ip.slice(7);
  const zoneIndex = ip.indexOf("%");
  if (zoneIndex >= 0) ip = ip.slice(0, zoneIndex);
  ip = ip.toLowerCase();

  if (isIP(ip) === 6) {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  }
  return isIP(ip) === 4 ? ip : "";
};

export const isIpv6 = (value) => isIP(normalizeIp(value)) === 6;

export const parseAllowedIpv6 = (value) =>
  new Set(
    String(value || "")
      .split(/[\s,]+/)
      .map(normalizeIp)
      .filter(isIpv6),
  );

export const isApprovedIpv6 = (
  value,
  configuredIps,
  sourceHashes = SOURCE_APPROVED_IPV6_HASHES,
) => {
  const ip = normalizeIp(value);
  return isIpv6(ip) && (configuredIps.has(ip) || sourceHashes.has(sha256Hex(ip)));
};

const decodeCookieValue = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
};

export const parseCookies = (headerValue) =>
  String(headerValue || "")
    .split(";")
    .reduce((cookies, pair) => {
      const separator = pair.indexOf("=");
      if (separator < 1) return cookies;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name) cookies[name] = decodeCookieValue(value);
      return cookies;
    }, {});

export const createDeviceToken = () => randomBytes(32).toString("base64url");

export const createDeviceRecord = (token, now = Date.now()) => ({
  tokenHash: sha256Hex(token),
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
  expiresAt: now + MOBILE_DEVICE_TTL_MS,
});

export const isDeviceTokenValid = (record, token, now = Date.now()) =>
  Boolean(
    record &&
      token &&
      Number(record.expiresAt) > now &&
      safeEqualHex(sha256Hex(token), String(record.tokenHash || "")),
  );

export const renewDeviceRecord = (record, now = Date.now()) => ({
  ...record,
  updatedAt: new Date(now).toISOString(),
  expiresAt: now + MOBILE_DEVICE_TTL_MS,
});

export const serializeDeviceCookie = (
  token,
  { secure = true, cookieName = secure ? MOBILE_DEVICE_COOKIE : MOBILE_DEVICE_DEV_COOKIE } = {},
) => {
  const maxAge = Math.floor(MOBILE_DEVICE_TTL_MS / 1000);
  return [
    `${cookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
};
