import { test, expect } from "@playwright/test";

async function openFidget(page, screenshotPath) {
  await page.goto("/");
  const zone = page.locator("#logoFidgetZone");
  await zone.scrollIntoViewIfNeeded();
  await expect(zone).toHaveClass(/is-ready/, { timeout: 20000 });
  const canvas = page.locator("#logoFidgetCanvas");
  await expect(canvas).toBeVisible();
  await zone.screenshot({ path: screenshotPath });
  return { zone, canvas };
}

test("3D logo fidget renders and moves under physics", async ({ page }) => {
  const { canvas } = await openFidget(page, "test-results/logo-fidget-desktop.png");
  const coloredPixels = await canvas.evaluate((element) => {
    element.dispatchEvent(new Event("nebulavm-probe-frame"));
    const gl = element.getContext("webgl2") || element.getContext("webgl");
    const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 8) count++;
    return count;
  });
  expect(coloredPixels).toBeGreaterThan(500);
  const before = await canvas.screenshot();
  await page.waitForTimeout(450);
  const after = await canvas.screenshot();
  expect(after.equals(before)).toBe(false);
});

test("3D logo fidget fits a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { zone } = await openFidget(page, "test-results/logo-fidget-mobile.png");
  expect(await zone.evaluate((element) => element.scrollWidth <= innerWidth)).toBe(true);
});
