import { test, expect } from "@playwright/test";

async function openFidget(page, screenshotPath) {
  await page.goto("/");
  const anchor = page.locator("#logoFidgetZone");
  await anchor.scrollIntoViewIfNeeded();
  const canvas = page.locator(".logo-fidget-layer");
  const grab = page.locator(".logo-fidget-grab");
  await expect(canvas).toBeVisible();
  await expect(grab).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: screenshotPath });
  return { anchor, canvas, grab };
}

test("3D logo fidget renders and moves under physics", async ({ page }) => {
  const { anchor, canvas, grab } = await openFidget(page, "test-results/logo-fidget-desktop.png");
  expect(await anchor.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
  await expect(canvas).toHaveCSS("pointer-events", "none");
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
  const start = await grab.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  const targetX = start.x + start.width / 2 + 100;
  const targetY = Math.max(140, start.y - 260);
  await page.mouse.move(targetX, targetY, { steps: 8 });
  await page.waitForTimeout(160);
  await page.mouse.move(targetX + 1, targetY);
  const held = await grab.boundingBox();
  await page.mouse.up();
  await page.waitForTimeout(450);
  const fallen = await grab.boundingBox();
  expect(fallen.y).toBeGreaterThan(held.y + 5);
  await page.screenshot({ path: "test-results/logo-fidget-desktop-thrown.png" });
});

test("3D logo fidget fits a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { canvas, grab } = await openFidget(page, "test-results/logo-fidget-mobile.png");
  const canvasBox = await canvas.boundingBox();
  const grabBox = await grab.boundingBox();
  expect(canvasBox.width).toBeLessThanOrEqual(390);
  expect(canvasBox.height).toBeLessThanOrEqual(844);
  expect(grabBox.x).toBeGreaterThanOrEqual(0);
  expect(grabBox.x + grabBox.width).toBeLessThanOrEqual(390);
});
