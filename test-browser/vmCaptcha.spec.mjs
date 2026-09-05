import { test, expect } from "@playwright/test";

// Stub the provider, not the gate. No real VM, CAPTCHA, or third-party traffic is used.
const provider = `window.hcaptcha = {
  render(id, options) {
    const button = document.createElement('button');
    button.textContent = 'Solve test challenge';
    button.onclick = () => options.callback('test-response-token');
    document.getElementById(id).append(button);
    const expire = document.createElement('button');
    expire.textContent = 'Expire test challenge';
    expire.onclick = () => options['expired-callback']();
    document.getElementById(id).append(expire);
    return 1;
  }, reset() {}
}; window.nebulaCaptchaReady();`;

async function prepare(page, { valid = true, configured = true } = {}) {
  const calls = { starts: [], verifies: 0 };
  const context = page.context();
  await context.route("https://js.hcaptcha.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: provider }));
  await context.route("**/.netlify/functions/vm-captcha", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: configured ? 200 : 503, json: configured ? { ok: true, sitekey: "test-site" } : { error: "Not configured" } });
    calls.verifies++;
    return route.fulfill({ status: valid ? 200 : 403, json: valid ? { ok: true } : { error: "Verification rejected" } });
  });
  await context.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/start")) {
      calls.starts.push(route.request().postDataJSON());
      return route.fulfill({ status: 403, json: { error: "Test stopped before launching a real VM." } });
    }
    if (path.endsWith("/windows11-template")) return route.fulfill({ json: { ok: true, available: true, isoPath: "", diskPath: "C:\\Test\\template.vhdx", name: "Windows 11 Template" } });
    return route.fulfill({ json: { ok: true, available: true, vm: { state: "Off" }, shareUrls: [], images: [], versions: [], installedVersions: [], limit: 2 } });
  });
  await context.route("**/v86/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#bootButton")).toBeVisible();
  return calls;
}

async function choose(page, mode) {
  await page.locator("#emulatorMode").selectOption(mode, { force: true });
  if (mode === "remote-vm") {
    await page.locator("#remoteVmUrl").evaluate((el) => { el.value = "https://nebulavm.online/remote.html?session=test"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  } else if (mode.startsWith("qemu-native") || mode === "emustar-hyperv") {
    await page.locator("#nativeIsoPath").evaluate((el) => { el.value = "C:\\Test\\antiX.iso"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  } else {
    await page.locator("#isoInput").setInputFiles({ name: mode === "nintendo" ? "homebrew.gba" : "test.iso", mimeType: "application/octet-stream", buffer: Buffer.alloc(512) });
  }
  await expect(page.locator("#bootButton")).toBeEnabled();
}

async function begin(page, button = "#bootButton") {
  await page.locator(button).click();
  await expect(page.getByRole("dialog", { name: "Verify before starting" })).toBeVisible();
  const frame = page.frameLocator("#vmCaptchaFrame");
  await expect(frame.getByRole("button", { name: "Solve test challenge" })).toBeVisible();
  return frame;
}

for (const mode of ["v86", "qemu-x64", "emustar-hyperv", "qemu-native-x64", "qemu-native-arm64-windows", "qemu-native-arm64-ubuntu", "nintendo", "remote-vm"]) {
  test(`${mode}: Start requires a new challenge and cancel never starts a VM`, async ({ page }) => {
    const calls = await prepare(page);
    await choose(page, mode);
    const challenge = await begin(page);
    await expect(page.locator("#bootButton")).toBeDisabled();
    expect(calls.starts).toHaveLength(0);
    expect(calls.verifies).toBe(0);
    await challenge.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("#bootButton")).toBeEnabled();
    const retry = await begin(page);
    await retry.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(calls.starts).toHaveLength(0);
  });
}

test("Windows template uses the gate even with only a prepared disk", async ({ page }) => {
  const calls = await prepare(page);
  await page.locator("#emulatorMode").selectOption("emustar-hyperv", { force: true });
  const challenge = await begin(page, "#windowsTemplateButton");
  await challenge.getByRole("button", { name: "Solve test challenge" }).click();
  await expect.poll(() => calls.starts.length).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(calls.starts[0].captchaToken).toBe("test-response-token");
  expect(calls.starts[0].templateDiskPath).toBe("C:\\Test\\template.vhdx");
  expect(calls.verifies).toBe(0); // The host start endpoint verifies the token, not Netlify twice.
});

test("browser runtime verifies on the server; rejected callback does not boot", async ({ page }) => {
  const calls = await prepare(page, { valid: false });
  await choose(page, "v86");
  const challenge = await begin(page);
  await challenge.getByRole("button", { name: "Solve test challenge" }).click();
  await expect.poll(() => calls.verifies).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#bootButton")).toBeEnabled();
  await expect(page.getByText("Boot blocked: Verification rejected", { exact: false })).toBeVisible();
  expect(calls.starts).toHaveLength(0);
});

test("accepted browser verification proceeds to boot", async ({ page }) => {
  const calls = await prepare(page);
  await choose(page, "v86");
  const challenge = await begin(page);
  await challenge.getByRole("button", { name: "Solve test challenge" }).click();
  await expect.poll(() => calls.verifies).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Creating virtual machine.", { exact: false })).toBeVisible();
  await expect(page.locator("#screenContainer")).toHaveClass(/vm-display-entering/);
});

test("expiration keeps the VM blocked until a fresh solve", async ({ page }) => {
  const calls = await prepare(page);
  await choose(page, "v86");
  const challenge = await begin(page);
  await challenge.getByRole("button", { name: "Expire test challenge" }).click();
  await expect(challenge.getByRole("status")).toContainText("expired");
  expect(calls.verifies).toBe(0);
  await challenge.getByRole("button", { name: "Solve test challenge" }).click();
  await expect.poll(() => calls.verifies).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the verification frame fades inside the viewport while app isolation stays enabled", async ({ page }) => {
  await prepare(page);
  await choose(page, "v86");
  const challenge = await begin(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const captchaFrame = page.frames().find((frame) => frame.url().includes("/captcha.html"));
  expect(captchaFrame).toBeTruthy();
  await expect(challenge.locator("#challenge")).toBeVisible();
  await expect(page.locator(".vm-captcha-viewport")).toHaveClass(/is-visible/);
  await page.screenshot({ path: "test-results/captcha-desktop.png" });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator(".vm-captcha-viewport").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/captcha-mobile.png" });
  expect(await challenge.locator("html").evaluate((element) => element.scrollWidth <= innerWidth)).toBe(true);
  await challenge.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("missing configuration fails closed and unlocks Start", async ({ page }) => {
  const calls = await prepare(page, { configured: false });
  await choose(page, "v86");
  await page.locator("#bootButton").click();
  await expect(page.getByText("Boot blocked: hCaptcha is unavailable.", { exact: false })).toBeVisible();
  await expect(page.locator("#bootButton")).toBeEnabled();
  expect(calls.starts).toHaveLength(0);
});

test("verification is embedded and does not open a separate window", async ({ page }) => {
  const calls = await prepare(page);
  await choose(page, "v86");
  const challenge = await begin(page);
  expect(page.context().pages()).toHaveLength(1);
  expect(calls.starts).toHaveLength(0);
  await challenge.getByRole("button", { name: "Solve test challenge" }).click();
  await expect.poll(() => calls.verifies).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("cancelling embedded verification does not leave Start disabled", async ({ page }) => {
  const calls = await prepare(page);
  await choose(page, "v86");
  const challenge = await begin(page);
  await challenge.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#bootButton")).toBeEnabled();
  expect(calls.starts).toHaveLength(0);
  expect(calls.verifies).toBe(0);
});
