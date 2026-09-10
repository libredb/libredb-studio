import { defineConfig, devices } from "@playwright/test";

const prefix = "/~/libredb";
const appPort = Number(process.env.E2E_BASE_PATH_APP_PORT || 3020);
const proxyPort = Number(process.env.E2E_BASE_PATH_PROXY_PORT || 3021);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /base-path\.spec\.ts/,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${proxyPort}`, trace: "retain-on-failure" },
  webServer: [
    {
      // Run after the ordinary suite: this rebuilds .next with a different prefix.
      command: "bun run build && bun start",
      url: `http://127.0.0.1:${appPort}${prefix}/api/db/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        BASE_PATH: prefix,
        PORT: String(appPort),
        HOSTNAME: "127.0.0.1",
        JWT_SECRET: "test-jwt-secret-for-e2e-tests-32ch",
        ADMIN_EMAIL: "admin@libredb.org",
        ADMIN_PASSWORD: "test-admin",
        USER_EMAIL: "user@libredb.org",
        USER_PASSWORD: "test-user",
        STORAGE_SQLITE_PATH: "./data-e2e-base-path/libredb-storage.db",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
    {
      command: "node e2e/helpers/base-path-proxy.mjs",
      url: `http://127.0.0.1:${proxyPort}${prefix}/api/db/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        E2E_BASE_PATH: prefix,
        E2E_BASE_PATH_APP_PORT: String(appPort),
        E2E_BASE_PATH_PROXY_PORT: String(proxyPort),
      },
    },
  ],
});
