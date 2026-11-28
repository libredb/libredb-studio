/**
 * A script unit whose provider never answers, with a real deadline and a real host core, in a bounded Node child
 * (src/lib/api/editor-script.ts; docs/providers/CONTRACT.md, clause C-83): the unit waits until its own deadline,
 * 50 ms out from the start the child hands the facade, so it answers the statement's timeout refusal within the child's
 * spawn timeout. Without the deadline the child waits until the spawn timeout kills it, and the case fails within
 * seconds; the child holds a referenced interval, so Node cannot exit early on the unsettled statement
 * (tests/helpers/bounded-node-child.ts).
 *
 * A unit of a script inside a transaction (clause C-84) whose `queryInTransaction` never settles is held to the same
 * rule in a second case of the same child.
 *
 * `editor-script.test.ts` holds the same rule with a short real deadline settled by a plain await.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { openEditorScript, openTransactionScript } from "@/lib/api/editor-script";
import type { providerConsoleTarget } from "@/lib/api/session-target";
import type { createHostCore } from "@/lib/provider-host/core/host-core";
import type { installHostCore } from "@/lib/provider-host/instance";
import type { splitExecutionUnits } from "@/lib/sql/statement-splitter";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly openEditorScript: typeof openEditorScript;
  readonly openTransactionScript: typeof openTransactionScript;
  readonly providerConsoleTarget: typeof providerConsoleTarget;
  readonly createHostCore: typeof createHostCore;
  readonly installHostCore: typeof installHostCore;
  readonly splitExecutionUnits: typeof splitExecutionUnits;
}

const SRC = path.join(import.meta.dir, "..", "..", "..", "..", "src");

const child = boundedChild({
  label: "editor-script-bounds",
  imports: [
    { from: path.join(SRC, "lib", "api", "editor-script.ts"), names: ["openEditorScript", "openTransactionScript"] },
    { from: path.join(SRC, "lib", "api", "session-target.ts"), names: ["providerConsoleTarget"] },
    { from: path.join(SRC, "lib", "provider-host", "core", "host-core.ts"), names: ["createHostCore"] },
    { from: path.join(SRC, "lib", "provider-host", "instance.ts"), names: ["installHostCore"] },
    { from: path.join(SRC, "lib", "sql", "statement-splitter.ts"), names: ["splitExecutionUnits"] },
  ],
  runCase: async (deps: ChildDeps, name: string) => {
    deps.installHostCore(deps.createHostCore(), "test");
    // A statement timeout of 1 ms, so the unit's deadline is 10,001 ms after its start.
    const provider = {
      type: "postgres",
      config: { id: "c1", name: "Prod", type: "postgres", host: "db", queryTimeout: 1 },
      query: () => new Promise<never>(() => {}),
      prepareQuery: (query: string) => ({ query, wasLimited: false, limit: 500, offset: 0 }),
      // The bridge reads the session's object model from the provider; this one states none.
      getCapabilities: () => ({}),
      beginTransaction: async () => {},
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},
      isInTransaction: () => true,
      queryInTransaction: () => new Promise<never>(() => {}),
    } as unknown as Parameters<typeof deps.providerConsoleTarget>[0];
    const units = deps.splitExecutionUnits("SELECT 1; SELECT 2");
    const signal = new AbortController().signal;
    const start = Date.now() - 10_001 + 50;
    const outcome =
      name === "transaction-never-answers"
        ? await deps
            .openTransactionScript(deps.providerConsoleTarget(provider), {
              units,
              options: {},
              signal,
              route: "bounds",
            })
            .runUnit(0, (result) => result, start)
        : await deps
            .openEditorScript(deps.providerConsoleTarget(provider), {
              units,
              options: {},
              signal,
              route: "bounds",
              // Core's scrub of a connection that holds no secret.
              scrub: { type: "postgres", forms: [] },
            })
            .runUnit(0, (result) => result, start);
    return outcome.kind === "answered"
      ? "answered"
      : `${outcome.kind} ${(outcome.error as Error).name}: ${(outcome.error as Error).message}`;
  },
  heapLimitMiB: 256,
  timeoutMs: 3_000,
});

beforeAll(async () => {
  await child.build();
});

afterAll(() => {
  child.remove();
});

describe("a script unit in a bounded child", () => {
  test("a script unit whose provider never answers ends at its deadline in the statement's timeout refusal", async () => {
    expect(await child.run<unknown>("never-answers")).toBe(
      "failed TimeoutError: The statement did not answer within its timeout of 0.1 seconds and 10 seconds more for the engine's own answer, so Studio stopped waiting for it.",
    );
  });

  test("a unit of a script inside a transaction whose provider never answers ends at its deadline in the statement's timeout refusal", async () => {
    expect(await child.run<unknown>("transaction-never-answers")).toBe(
      "unanswered TimeoutError: The statement did not answer within its timeout of 0.1 seconds and 10 seconds more for the engine's own answer, so Studio stopped waiting for it.",
    );
  });
});
