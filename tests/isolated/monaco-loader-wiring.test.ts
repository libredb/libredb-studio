/**
 * Isolated: verifies that importing QueryEditor points Monaco's AMD loader at our own
 * origin. Must own its process — it mocks @monaco-editor/react and pulls the whole
 * QueryEditor module chain, and the assertion depends on observing the loader call made
 * at module-evaluation time (hence the dynamic import after the mock is registered).
 *
 * Without this, @monaco-editor/react silently fetches Monaco from cdn.jsdelivr.net:
 * no editor on air-gapped installs, and CI flakes whenever the CDN is unreachable.
 */
import { expect, mock, test } from "bun:test";

const configCalls: Array<{ paths?: { vs?: string } }> = [];

mock.module("@monaco-editor/react", () => ({
  default: () => null,
  loader: {
    init: () => Promise.resolve(),
    config: (config: { paths?: { vs?: string } }) => {
      configCalls.push(config);
    },
    __getMonacoInstance: () => null,
  },
}));

// Imported after the mock so the module-scope loader configuration is observable.
await import("@/components/QueryEditor");

test("importing QueryEditor configures Monaco to load from our own origin", () => {
  expect(configCalls).toEqual([{ paths: { vs: "/monaco/vs" } }]);
});

test("no configured Monaco path points at an external host", () => {
  for (const call of configCalls) {
    expect(call.paths?.vs?.startsWith("/")).toBe(true);
  }
});
