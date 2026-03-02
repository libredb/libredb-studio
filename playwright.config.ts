import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run build && bun start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      JWT_SECRET: 'test-jwt-secret-for-e2e-tests-32ch',
      ADMIN_EMAIL: 'admin@libredb.org',
      ADMIN_PASSWORD: 'test-admin',
      USER_EMAIL: 'user@libredb.org',
      USER_PASSWORD: 'test-user',
      DEMO_DB_ENABLED: process.env.DEMO_DB_ENABLED || '',
      DEMO_DB_NAME: process.env.DEMO_DB_NAME || '',
      DEMO_DB_HOST: process.env.DEMO_DB_HOST || '',
      DEMO_DB_PORT: process.env.DEMO_DB_PORT || '',
      DEMO_DB_DATABASE: process.env.DEMO_DB_DATABASE || '',
      DEMO_DB_USER: process.env.DEMO_DB_USER || '',
      DEMO_DB_PASSWORD: process.env.DEMO_DB_PASSWORD || '',
    },
  },
});
