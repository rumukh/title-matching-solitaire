"use strict";
const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: ".\\tests",
  testMatch: "**/browser.spec.cjs",
  fullyParallel: true,
  workers: 2,
  timeout: 60000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true } }
  ],
  webServer: {
    command: "node tests\\server.cjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false
  }
});
