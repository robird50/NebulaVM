import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test-browser",
  workers: 1,
  timeout: 20000,
  use: { baseURL: "http://127.0.0.1:5176", channel: "msedge", headless: true, screenshot: "only-on-failure" },
  webServer: {
    command: "npm run preview -- --port 5176 --strictPort",
    url: "http://127.0.0.1:5176",
    reuseExistingServer: true,
  },
});
