/**
 * Global test setup — preloaded before every test file via bunfig.toml
 */
import { afterEach } from 'bun:test';

// ─── Environment Variables ──────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests-32ch';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.USER_PASSWORD = 'test-user-password';
process.env.NODE_ENV = 'test';

// ─── In-memory localStorage mock (SSR/test environment) ────────────────────
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const localStorageMock: Storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (index: number) => {
      const keys = Array.from(store.keys());
      return keys[index] ?? null;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });
}

// ─── window mock (many source files check typeof window) ────────────────────
if (typeof globalThis.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', { value: globalThis, writable: true });
}

// ─── Cleanup between tests ─────────────────────────────────────────────────
afterEach(() => {
  globalThis.localStorage.clear();
});
