/**
 * The agent's SQL surface, held byte for byte to what it was before the statement-language layer (D6).
 *
 * `tests/fixtures/agent/sql-surface/golden-sql-agent-surface.json` was generated on the base commit by the module
 * this test runs; its docblock says how to regenerate it. Isolated because it builds real providers through
 * `createDatabaseProvider`, which the api layer's tests mock.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenSqlAgentSurface } from "../fixtures/agent/sql-surface/golden-sql-agent-surface";

const GOLDEN = join(import.meta.dir, "..", "fixtures", "agent", "sql-surface", "golden-sql-agent-surface.json");

describe("the agent's SQL surface", () => {
  test("prompts, tool schemas, classifier prompt and verdicts are what the committed golden file records", async () => {
    expect(await goldenSqlAgentSurface()).toBe(readFileSync(GOLDEN, "utf8"));
  }, 120_000);
});
