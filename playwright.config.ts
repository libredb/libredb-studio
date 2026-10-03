import { defineConfig, devices } from "@playwright/test";

// Ports of every Playwright configuration, so none collides with another: this file's main server
// 3000 (E2E_PORT), offline server 3010 (E2E_OFFLINE_PORT) and passkey server 3011 (E2E_PASSKEY_PORT);
// playwright.base-path.config.ts's app 3020 and proxy 3021. Override one with its variable when
// that port is occupied by another instance.
const port = Number(process.env.E2E_PORT ?? 3000);

// offline-editor.spec.ts and the kafka, etcd, neo4j and qdrant provider specs get a second server
// process on its own port - see the projects and the webServer array below for why. Override with
// E2E_OFFLINE_PORT under the same collision circumstances as E2E_PORT.
const offlinePort = Number(process.env.E2E_OFFLINE_PORT ?? 3010);

// passkey.spec.ts gets a third server process: see the chromium-passkey project for why.
const passkeyPort = Number(process.env.E2E_PASSKEY_PORT ?? 3011);

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
      // offline-editor.spec.ts and the kafka, etcd, neo4j and qdrant provider specs run under their own
      // projects below, against the second server, and passkey.spec.ts against the third.
      testIgnore:
        /(?:offline-editor|base-path|kafka-provider|etcd-provider|neo4j-provider|qdrant-provider|passkey)\.spec\.ts/,
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
      // does; the specs on that server together stay far below that bucket's 120 requests a minute.
      name: "chromium-kafka",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${offlinePort}` },
      testMatch: /kafka-provider\.spec\.ts/,
    },
    {
      // etcd-provider.spec.ts drives Test Connection too, so it takes the second server for the reason
      // kafka-provider.spec.ts does; the three specs together stay far below that bucket's 120
      // requests a minute.
      name: "chromium-etcd",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${offlinePort}` },
      testMatch: /etcd-provider\.spec\.ts/,
    },
    {
      // neo4j-provider.spec.ts drives Test Connection too (two calls, one per refusal it asserts), so it
      // takes the second server for the reason kafka-provider.spec.ts does.
      name: "chromium-neo4j",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${offlinePort}` },
      testMatch: /neo4j-provider\.spec\.ts/,
    },
    {
      // qdrant-provider.spec.ts drives Test Connection too (one call, for the refusal it asserts), so it takes the
      // second server for the reason kafka-provider.spec.ts does.
      name: "chromium-qdrant",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${offlinePort}` },
      testMatch: /qdrant-provider\.spec\.ts/,
    },
    {
      // Passkeys need an account registry, so this server runs in store mode (STORAGE_PROVIDER=sqlite)
      // with PASSKEY_ORIGIN set; the servers above keep the default local mode, where passkeys are off
      // and the Permissions-Policy still denies publickey-credentials-get. Chromium only: the virtual
      // authenticator is a Chrome DevTools Protocol feature (e2e/helpers/virtual-authenticator.ts).
      name: "chromium-passkey",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${passkeyPort}` },
      testMatch: /(^|\/)passkey\.spec\.ts$/,
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
    {
      // The same shared build as the server above. rm -rf first: the account registry lives in this
      // data dir, and a store left by an earlier run would keep its accounts and passkeys.
      command: "rm -rf data-e2e-passkey && until [ -f .next/BUILD_ID ]; do sleep 1; done; bun start",
      url: `http://localhost:${passkeyPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        PORT: String(passkeyPort),
        STORAGE_PROVIDER: "sqlite",
        STORAGE_SQLITE_PATH: "./data-e2e-passkey/libredb-storage.db",
        // The address the browser opens; WebAuthn accepts plain http only on the host name localhost.
        PASSKEY_ORIGIN: `http://localhost:${passkeyPort}`,
        // Both embedded samples off: their files take a single-writer lock no spec here needs.
        LIBREDB_EMBEDDED_SAMPLE: "false",
        SQLITE_EMBEDDED_SAMPLE: "false",
        // Without a trusted proxy every request comes from the address "unknown", so all the negative
        // cases of passkey.spec.ts share one client budget; the defaults (5 and 10) would refuse them.
        RATE_LIMIT_LOGIN_MAX: "100",
        RATE_LIMIT_PASSKEY_MAX: "100",
        ...testCredentials,
      },
    },
  ],
});
