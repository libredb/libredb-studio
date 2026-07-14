import { describe, expect, test } from "bun:test";
// Import the CJS shim itself (not index.ts) so the shim line executes under coverage.
import * as studioExports from "@/exports/index.js";

describe("exports/index.js CJS shim", () => {
  test("re-exports the TypeScript entry point for CJS consumers", () => {
    expect(typeof studioExports.createDatabaseProvider).toBe("function");
    expect(typeof studioExports.createLLMProvider).toBe("function");
    expect(studioExports.QueryEditor).toBeDefined();
    expect(studioExports.ConnectionModal).toBeDefined();
  });
});
