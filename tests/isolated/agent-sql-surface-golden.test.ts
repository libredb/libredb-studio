/**
 * The agent's SQL surface, held byte for byte to what it was before the statement-language layer (D6).
 *
 * `tests/fixtures/agent/sql-surface/golden-sql-agent-surface.json` was generated on the base commit by the module
 * this test runs; its docblock says how to regenerate it. Isolated because it builds real providers through
 * `createDatabaseProvider`, which the api layer's tests mock.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import { goldenSqlAgentSurface } from "../fixtures/agent/sql-surface/golden-sql-agent-surface";

// The agent's statements run through the host core's read-only execute, so this file installs one for its runs.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const GOLDEN = join(import.meta.dir, "..", "fixtures", "agent", "sql-surface", "golden-sql-agent-surface.json");

describe("the agent's SQL surface", () => {
  test("prompts, tool schemas, classifier prompt and verdicts are what the committed golden file records", async () => {
    expect(await goldenSqlAgentSurface()).toBe(readFileSync(GOLDEN, "utf8"));
  }, 120_000);
});
