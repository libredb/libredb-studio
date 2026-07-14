import { defineConfig, devices } from "@playwright/test";

/**
 * Channel harness for e2e/embedded-samples.spec.ts: NO webServer — the
 * server is a packaged artifact (tarball, npx, docker, deb, rpm, snap,
 * homebrew) booted by scripts/channel-embedded-sample-e2e.sh, which passes
 * its address via CHANNEL_E2E_BASE_URL. The regular playwright.config.ts
 * covers the same spec against the repo build (the next-dev channel).
 */
const baseURL = process.env.CHANNEL_E2E_BASE_URL;
if (!baseURL) {
  throw new Error("CHANNEL_E2E_BASE_URL is required - run via scripts/channel-embedded-sample-e2e.sh");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "embedded-samples.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
