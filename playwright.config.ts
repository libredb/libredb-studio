import { defineConfig, devices } from "@playwright/test";

// Override with E2E_PORT when localhost:3000 is occupied by another instance.
const port = Number(process.env.E2E_PORT ?? 3000);

// offline-editor.spec.ts and kafka-provider.spec.ts get a second server process on its own port -
// see the projects and the webServer array below for why. Override with E2E_OFFLINE_PORT under the
// same collision circumstances as E2E_PORT.
const offlinePort = Number(process.env.E2E_OFFLINE_PORT ?? 3010);

const testCredentials = {
  JWT_SECRET: "test-jwt-secret-for-e2e-tests-32ch",
  ADMIN_EMAIL: "admin@libredb.org",
  ADMIN_PASSWORD: "test-admin",
  USER_EMAIL: "user@libredb.org",
  USER_PASSWORD: "test-user",
};

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
    // Kept for every test DURING A MODEL SWEEP, and only then. The agent specs are the ones
    // somebody watches: a sweep runs for over an hour and the question afterwards is what the
    // rail actually did, which a passing run answers as usefully as a failing one — so
    // `retain-on-failure`, which deletes exactly those videos, is the wrong setting there.
    //
    // Scoped to the sweep's own variable rather than turned on globally, because `use` reaches
    // every project and every run: `on` here would have CI keeping a video of every passing test
    // in every job, which nobody watches and every artifact pays for. The comment used to claim
    // the first sentence while the value did the opposite; the two now agree.
    video: process.env.AGENT_MODEL_E2E ? "on" : "retain-on-failure",
    // Watchable when asked for. Unset in CI and in an ordinary run, so nothing slows down by
    // default; `PWSLOWMO=350` puts a beat between actions when somebody is watching the sweep.
    launchOptions: { slowMo: Number(process.env.PWSLOWMO ?? 0) },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // offline-editor.spec.ts and kafka-provider.spec.ts run under their own projects below,
      // against the second server.
      testIgnore: /(?:offline-editor|base-path|kafka-provider)\.spec\.ts/,
    },
    {
      // Every other spec in this suite signs in as the same shared user@libredb.org account
      // against the single shared server process above, and each fresh login auto-hydrates
      // (health, schema/list, schema/relations, provider-meta) against that account's per-process
      // "query" rate-limit bucket (src/lib/api/rate-limit.ts: 120 requests/60s by default, shared
      // by every db-reaching route). That budget is sized for one real session; it is not sized
      // for ~30 independent specs replaying "fresh login" back to back on one process, and by the
      // time offline-editor.spec.ts's own turn came up in file order, the shared account's budget
      // was already spent by everything that ran before it - a 429 on the query it runs, not a
      // product defect (see e2e/offline-editor.spec.ts's header comment). Running it against a
      // dedicated server process - same build output, different port - gives it rate-limit
      // counters nothing else has touched, without changing the limiter, the accounts, or any
      // assertion.
      name: "chromium-offline-editor",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${offlinePort}` },
      testMatch: /offline-editor\.spec\.ts/,
    },
    {
      // kafka-provider.spec.ts drives Test Connection, which spends the same per-account "query"
      // bucket, and on the shared server it met the budget the specs before it had spent: CI run
      // 36263561882 answered its refusal check "Too many requests. Try again in 38 seconds." on all
      // three attempts. It runs against the second server for the reason offline-editor.spec.ts
      // does; the two specs together stay far below that bucket's 120 requests a minute.
      name: "chromium-kafka",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${offlinePort}` },
      testMatch: /kafka-provider\.spec\.ts/,
    },
    {
      // Scoped to the CSP spec only. The desktop shell renders under WebKitGTK, and this is the
      // nearest engine available in CI; the release-time desktop smoke test remains the final
      // check on the webview.eval handoff and is listed in the Phase 1 pull request description.
      name: "webkit-security",
      use: { ...devices["Desktop Safari"] },
      testMatch: /security-headers\.spec\.ts/,
    },
  ],
  webServer: [
    {
      // rm -f first: without it, a local re-run reusing a stale .next/BUILD_ID from a previous
      // build would let the second server below start serving mid-rebuild, before this build
      // finishes overwriting it.
      command: "rm -f .next/BUILD_ID && bun run build && bun start",
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { PORT: String(port), ...testCredentials },
    },
    {
      // Reuses the SAME build output as the server above - it only ever needs to wait for that
      // build to land, never run its own. Two `next start` processes safely serving one read-only
      // .next output concurrently is exactly what horizontal-scaling replicas already do.
      //
      // STORAGE_SQLITE_PATH is its own concern: getDataDir() (src/lib/data-dir.ts) derives the
      // sample-seed directory from it regardless of STORAGE_PROVIDER, and the embedded LibreDB
      // sample takes an exclusive single-writer file lock (src/lib/db/providers/embedded/libredb.ts)
      // that a second process cannot also hold - pointing this server at a separate data dir avoids
      // fighting the primary server for that file (and for the SQLite sample file alongside it).
      command: "until [ -f .next/BUILD_ID ]; do sleep 1; done; bun start",
      url: `http://localhost:${offlinePort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        PORT: String(offlinePort),
        STORAGE_SQLITE_PATH: "./data-e2e-offline/libredb-storage.db",
        ...testCredentials,
      },
    },
  ],
});
