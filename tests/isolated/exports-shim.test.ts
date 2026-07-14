import { describe, expect, test } from "bun:test";

// Load the shim the way a CJS consumer/bundler would: require(), not an ESM
// import whose CJS interop would mask resolution differences. Coverage note:
// this group runs with --nocov (see tests/run-components.sh) and the shim is
// excluded from Sonar coverage — this test guards the npm entry point
// functionally, not for lcov.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const studioExports = require("../../src/exports/index.js");

describe("exports/index.js CJS shim", () => {
  test("re-exports the TypeScript entry point for CJS consumers", () => {
    expect(typeof studioExports.createDatabaseProvider).toBe("function");
    expect(typeof studioExports.createLLMProvider).toBe("function");
    expect(studioExports.QueryEditor).toBeDefined();
    expect(studioExports.ConnectionModal).toBeDefined();
  });
});
