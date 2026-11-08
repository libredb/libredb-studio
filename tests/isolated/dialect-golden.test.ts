/**
 * The dialect registry's neutral proof: every reader-visible answer for every shipped type-id is byte for byte
 * the one the per-dialect arms gave before the registry replaced them.
 *
 * `tests/fixtures/dialect-registry/golden-dialect-outputs.json` was generated on the base commit, before the
 * registry existed, by the module this test runs; its docblock says how to regenerate it on purpose. It runs here,
 * in a process of its own, because it builds every provider through the real `createDatabaseProvider`, which the
 * api layer's tests mock (the reason `tests/isolated/object-source-declarations.test.ts` gives).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenDialectOutputs } from "../fixtures/dialect-registry/golden-dialect-outputs";

const GOLDEN = join(import.meta.dir, "..", "fixtures", "dialect-registry", "golden-dialect-outputs.json");

describe("the dialect registry's golden file", () => {
  let answered = "";

  // Setup with its own budget: the oracle's first run imports every provider module, 376 of its 377 ms (2.8 s on one
  // busy core), and a second run takes 1 ms, so the test's 5000 ms default would be spent on the imports.
  beforeAll(async () => {
    answered = await goldenDialectOutputs();
  }, 60_000);

  test("every shipped type-id answers exactly what the committed golden file records", () => {
    expect(answered).toBe(readFileSync(GOLDEN, "utf8"));
  });
});
