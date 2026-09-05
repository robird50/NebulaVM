import test from "node:test";
import assert from "node:assert/strict";
import { hcaptchaConfig, publicHcaptchaConfig, verifyHcaptcha } from "../lib/hcaptcha.mjs";
import handler from "../netlify/functions/vm-captcha.mjs";

const config = { sitekey: "test-sitekey", secret: "test-secret" };

test("public configuration never exposes the secret and fails closed when absent", () => {
  assert.deepEqual(publicHcaptchaConfig(config), { ok: true, sitekey: "test-sitekey" });
  assert.throws(() => publicHcaptchaConfig({ sitekey: "test-sitekey" }), { statusCode: 503 });
  assert.throws(() => publicHcaptchaConfig({ secret: "test-secret" }), { statusCode: 503 });
  assert.deepEqual(hcaptchaConfig((key) => ({ HCAPTCHA_SITE_KEY: " site ", HCAPTCHA_SECRET: " secret " })[key]), { sitekey: "site", secret: "secret" });
});

test("missing or malformed tokens never reach hCaptcha", async () => {
  const fetchImpl = () => assert.fail("Must not make a verification request");
  for (const token of [undefined, null, {}, true, "", " ", "x".repeat(16385)]) {
    await assert.rejects(verifyHcaptcha(token, config, { fetchImpl }), { statusCode: 403 });
  }
});

test("verification sends a form with the configured sitekey and secret", async () => {
  const result = await verifyHcaptcha("response+&token", config, {
    remoteip: "192.0.2.1",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.hcaptcha.com/siteverify");
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
      assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
        secret: "test-secret", sitekey: "test-sitekey", response: "response+&token", remoteip: "192.0.2.1",
      });
      assert.ok(init.signal instanceof AbortSignal);
      return Response.json({ success: true });
    },
  });
  assert.deepEqual(result, { ok: true });
});

test("failure, expiration, replay, and malformed provider replies do not authorize a start", async () => {
  for (const result of [{ success: false }, { success: "true" }, {}, null, { success: false, "error-codes": ["expired-input-response"] }, { success: false, "error-codes": ["already-seen-response"] }]) {
    await assert.rejects(verifyHcaptcha("token", config, { fetchImpl: async () => Response.json(result) }), { statusCode: 403 });
  }
});

test("network and provider errors fail closed without leaking details", async () => {
  for (const fetchImpl of [async () => { throw new Error(config.secret); }, async () => new Response("down", { status: 500 }), async () => new Response("not json")]) {
    await assert.rejects(verifyHcaptcha("token", config, { fetchImpl }), (error) => {
      assert.equal(error.statusCode, 503);
      assert.ok(!error.message.includes(config.secret));
      return true;
    });
  }
});

test("a previous success is not cached for subsequent starts", async () => {
  let calls = 0;
  const fetchImpl = async () => Response.json({ success: ++calls === 1 });
  await verifyHcaptcha("token", config, { fetchImpl });
  await assert.rejects(verifyHcaptcha("token", config, { fetchImpl }), { statusCode: 403 });
  assert.equal(calls, 2);
});

test("function handles unconfigured, invalid, and oversized requests without accepting them", async () => {
  const original = { sitekey: process.env.HCAPTCHA_SITE_KEY, secret: process.env.HCAPTCHA_SECRET };
  try {
    delete process.env.HCAPTCHA_SITE_KEY;
    delete process.env.HCAPTCHA_SECRET;
    const missing = await handler(new Request("https://nebulavm.test/api"));
    assert.equal(missing.status, 503);
    assert.equal(missing.headers.get("Cache-Control"), "no-store");
    process.env.HCAPTCHA_SITE_KEY = config.sitekey;
    process.env.HCAPTCHA_SECRET = config.secret;
    const result = await handler(new Request("https://nebulavm.test/api"));
    assert.deepEqual(await result.json(), { ok: true, sitekey: config.sitekey });
    for (const [body, code] of [["not-json", 400], ["x".repeat(20001), 413], ["{}", 403], ["null", 403]]) {
      assert.equal((await handler(new Request("https://nebulavm.test/api", { method: "POST", body }))).status, code);
    }
    assert.equal((await handler(new Request("https://nebulavm.test/api", { method: "DELETE" }))).status, 405);
  } finally {
    if (original.sitekey === undefined) delete process.env.HCAPTCHA_SITE_KEY; else process.env.HCAPTCHA_SITE_KEY = original.sitekey;
    if (original.secret === undefined) delete process.env.HCAPTCHA_SECRET; else process.env.HCAPTCHA_SECRET = original.secret;
  }
});
