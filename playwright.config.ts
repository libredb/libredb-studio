import { defineConfig, devices } from "@playwright/test";

// Override with E2E_PORT when localhost:3000 is occupied by another instance.
const port = Number(process.env.E2E_PORT ?? 3000);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "html" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
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
    command: "bun run build && bun start",
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(port),
      JWT_SECRET: "test-jwt-secret-for-e2e-tests-32ch",
      ADMIN_EMAIL: "admin@libredb.org",
      ADMIN_PASSWORD: "test-admin",
      USER_EMAIL: "user@libredb.org",
      USER_PASSWORD: "test-user",
    },
  },
});
