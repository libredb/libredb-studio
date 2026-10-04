/**
 * The dialect registry's neutral proof: every reader-visible answer for every shipped type-id is byte for byte
 * the one the per-dialect arms gave before the registry replaced them.
 *
 * `tests/fixtures/dialect-registry/golden-dialect-outputs.json` was generated on the base commit, before the
 * registry existed, by the module this test runs; its docblock says how to regenerate it on purpose. It runs here,
 * in a process of its own, because it builds every provider through the real `createDatabaseProvider`, which the
 * api layer's tests mock (the reason `tests/isolated/object-source-declarations.test.ts` gives).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenDialectOutputs } from "../fixtures/dialect-registry/golden-dialect-outputs";

const GOLDEN = join(import.meta.dir, "..", "fixtures", "dialect-registry", "golden-dialect-outputs.json");

describe("the dialect registry's golden file", () => {
  test("every shipped type-id answers exactly what the committed golden file records", async () => {
    expect(await goldenDialectOutputs()).toBe(readFileSync(GOLDEN, "utf8"));
  });
});
