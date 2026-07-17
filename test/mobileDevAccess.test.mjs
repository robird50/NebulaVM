import test from "node:test";
import assert from "node:assert/strict";
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
  serializeDeviceCookie,
  sha256Hex,
} from "../lib/mobileDevAccess.mjs";

const approvedPhoneIp = "2600:8801:2120:af00:3064:125b:8c09:922f";

test("canonicalizes equivalent IPv6 spellings", () => {
  const expanded = "2600:8801:0000:0000:0000:0000:0000:0001";
  const compressed = "2600:8801::1";
  assert.equal(normalizeIp(expanded), compressed);
  assert.equal(sha256Hex(normalizeIp(expanded)), sha256Hex(normalizeIp(compressed)));
});

test("canonicalizes brackets, ports, zones, and IPv4-mapped addresses", () => {
  assert.equal(normalizeIp("[2600:8801::1]:443"), "2600:8801::1");
  assert.equal(normalizeIp("fe80::1%en0"), "fe80::1");
  assert.equal(normalizeIp("::ffff:192.0.2.4"), "192.0.2.4");
});

test("approves the configured phone only through IPv6", () => {
  assert.equal(isIpv6(approvedPhoneIp), true);
  assert.equal(
    isApprovedIpv6(approvedPhoneIp, new Set(), SOURCE_APPROVED_IPV6_HASHES),
    true,
  );
  assert.equal(isApprovedIpv6("192.0.2.4", new Set(), SOURCE_APPROVED_IPV6_HASHES), false);
});

test("normalizes configured IPv6 and drops IPv4 entries", () => {
  const allowed = parseAllowedIpv6("2600:8801:0:0:0:0:0:1, 192.0.2.4");
  assert.deepEqual([...allowed], ["2600:8801::1"]);
});

test("device token records expire and renew", () => {
  const now = Date.UTC(2026, 6, 17);
  const token = createDeviceToken();
  const record = createDeviceRecord(token, now);
  assert.equal(isDeviceTokenValid(record, token, now + 1000), true);
  assert.equal(isDeviceTokenValid(record, `${token}x`, now + 1000), false);
  assert.equal(isDeviceTokenValid(record, token, record.expiresAt + 1), false);

  const renewed = renewDeviceRecord(record, now + 5000);
  assert.ok(renewed.expiresAt > record.expiresAt);
});

test("production cookie is host-only, secure, and inaccessible to scripts", () => {
  const token = createDeviceToken();
  const cookie = serializeDeviceCookie(token);
  assert.match(cookie, new RegExp(`^${MOBILE_DEVICE_COOKIE}=`));
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Secure/);
  assert.doesNotMatch(cookie, /; Domain=/);
  assert.equal(parseCookies(cookie)[MOBILE_DEVICE_COOKIE], token);
});

test("malformed cookies are rejected without throwing", () => {
  assert.doesNotThrow(() => parseCookies(`${MOBILE_DEVICE_COOKIE}=%E0%A4%A`));
  assert.equal(parseCookies(`${MOBILE_DEVICE_COOKIE}=%E0%A4%A`)[MOBILE_DEVICE_COOKIE], "");
});
