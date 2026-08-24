/**
 * Global test setup — preloaded before every test file via bunfig.toml
 */
import { afterEach } from "bun:test";

// ─── Environment Variables ──────────────────────────────────────────────────
process.env.JWT_SECRET = "test-jwt-secret-for-unit-tests-32ch";
process.env.ADMIN_EMAIL = "admin@libredb.org";
process.env.ADMIN_PASSWORD = "LibreDB.2026";
process.env.USER_EMAIL = "user@libredb.org";
process.env.USER_PASSWORD = "LibreDB.2026";
process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
(process.env as Record<string, string>).NODE_ENV = "test";
/*
  Deleted rather than set, because there is no value that means "the shipped measurements" —
  the variable's own absence is what means it.

  The lines above pin a developer's `.env` out of the way so a local credential cannot decide a
  test's outcome. This one is the same rule for the agent's model tuning, and it is here because
  the consequence is worse than a wrong assertion: a mounted document adds its models to the
  merged register, two pinned tables in `model-resolution-table.test.ts` stop covering it, and
  the suite goes red on a machine whose code is fine. The pre-commit hook runs that suite, so
  the operator feature Studio ships would block committing to Studio.
*/
delete process.env.AGENT_MODEL_TUNING_PATH;

// ─── In-memory localStorage mock (SSR/test environment) ────────────────────
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const localStorageMock: Storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (index: number) => {
      const keys = Array.from(store.keys());
      return keys[index] ?? null;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, writable: true });
}

// ─── window mock (many source files check typeof window) ────────────────────
if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, writable: true });
}

// ─── Cleanup between tests ─────────────────────────────────────────────────
afterEach(() => {
  globalThis.localStorage.clear();
});
