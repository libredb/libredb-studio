import { defineConfig, devices } from "@playwright/test";

/**
 * Dedicated config for the functional smoke (e2e/functional-smoke.spec.ts)
 * when run OUTSIDE the regular E2E suite - i.e. by the maintainer loop's
 * close-out gate (loop/scripts/functional-smoke.sh) or by hand on a dev
 * machine. It differs from playwright.config.ts in exactly two ways, both
 * lessons from real incidents:
 *
 * - port 3105 with reuseExistingServer disabled: a locally installed
 *   libredb-studio Snap daemon occupies 127.0.0.1:3000, and reusing it would
 *   silently run the smoke against the wrong server with the wrong
 *   credentials (the 0.9.53 E2E incident).
 * - `bun start` only (no build): the loop's gate has just built; rebuilding
 *   here would double the close-out cost. loop/scripts/functional-smoke.sh
 *   guarantees .next exists before invoking this config.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/functional-smoke.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3105",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun start",
    url: "http://localhost:3105",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: "3105",
      HOSTNAME: "127.0.0.1",
      JWT_SECRET: "test-jwt-secret-for-e2e-tests-32ch",
      ADMIN_EMAIL: "admin@libredb.org",
      ADMIN_PASSWORD: "test-admin",
      USER_EMAIL: "user@libredb.org",
      USER_PASSWORD: "test-user",
    },
  },
});
