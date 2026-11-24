/**
 * The agent's surface on an engine with no statement family, held byte for byte to what it was before the run
 * resolver.
 *
 * `tests/fixtures/agent/no-family-surface/golden-no-family-agent-surface.json` was generated on the base commit by
 * the module this test runs; its docblock says how to regenerate it. Isolated because it builds real providers
 * through `createDatabaseProvider`, which the api layer's tests mock.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import { goldenNoFamilyAgentSurface } from "../fixtures/agent/no-family-surface/golden-no-family-agent-surface";

// The agent's grounding walk reads through the host core's tree call, so this file installs one for its runs.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const GOLDEN = join(
  import.meta.dir,
  "..",
  "fixtures",
  "agent",
  "no-family-surface",
  "golden-no-family-agent-surface.json",
);

describe("the agent's surface on an engine with no statement family", () => {
  test("prompts, tool schemas, persisted facts and the curated denial are what the committed golden file records", async () => {
    expect(await goldenNoFamilyAgentSurface()).toBe(readFileSync(GOLDEN, "utf8"));
  }, 120_000);
});
