// The browser leg (part 5 "Tests"): the results webview in Chromium under its CSP. It starts no server: the harness
// serves dist/webview through page.route, so `npm run build` runs first.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  testMatch: "**/*.spec.ts",
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  outputDir: "out/browser",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
