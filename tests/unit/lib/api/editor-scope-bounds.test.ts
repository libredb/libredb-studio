/**
 * The end of an editor run's scope with real timers, in a bounded Node child (src/lib/api/editor-query.ts;
 * docs/providers/CONTRACT.md, clauses C-47 and C-60): a provider whose transaction ender never answers is cut at the
 * end's own cleanup deadline, `CLEANUP_DEADLINE_MS` after the statement answered, and the run answers
 * `StudioTimeoutRefusal` naming the end, well before the statement's own deadline. Without the end's deadline the child
 * waits until the spawn timeout kills it, and the case fails by its exit; the child holds a referenced interval, so Node
 * cannot exit early on the unsettled call (tests/helpers/bounded-node-child.ts).
 *
 * The case waits the real 10 s cleanup deadline, so it carries a test timeout of its own. `editor-query.test.ts` holds
 * the same rule with a core of the test's own that answers a stopped end, in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { runEditorQuery } from "@/lib/api/editor-query";
import type { providerConsoleTarget } from "@/lib/api/session-target";
import type { providerTextScrub } from "@/lib/db/operations/provider-text";
import type { errorKind, errorOutcome } from "@/lib/db/error-record";
import type { createHostCore } from "@/lib/provider-host/core/host-core";
import type { installHostCore } from "@/lib/provider-host/instance";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly runEditorQuery: typeof runEditorQuery;
  readonly providerConsoleTarget: typeof providerConsoleTarget;
  readonly providerTextScrub: typeof providerTextScrub;
  readonly errorKind: typeof errorKind;
  readonly errorOutcome: typeof errorOutcome;
  readonly createHostCore: typeof createHostCore;
  readonly installHostCore: typeof installHostCore;
}

const SOURCE = path.join(import.meta.dir, "..", "..", "..", "..", "src");

const child = boundedChild({
  label: "editor-scope-bounds",
  imports: [
    { from: path.join(SOURCE, "lib", "api", "editor-query.ts"), names: ["runEditorQuery"] },
    { from: path.join(SOURCE, "lib", "api", "session-target.ts"), names: ["providerConsoleTarget"] },
    { from: path.join(SOURCE, "lib", "db", "operations", "provider-text.ts"), names: ["providerTextScrub"] },
    { from: path.join(SOURCE, "lib", "db", "error-record.ts"), names: ["errorKind", "errorOutcome"] },
    { from: path.join(SOURCE, "lib", "provider-host", "core", "host-core.ts"), names: ["createHostCore"] },
    { from: path.join(SOURCE, "lib", "provider-host", "instance.ts"), names: ["installHostCore"] },
  ],
  runCase: async (deps: ChildDeps) => {
    deps.installHostCore(deps.createHostCore(), "test");
    const config = { id: "c", name: "c", type: "postgres", createdAt: new Date(0), queryTimeout: 60_000 };
    let answeredAt = 0;
    // A statement that answers at once, on a provider whose transaction ender never answers.
    const provider = {
      type: "postgres",
      config,
      prepareQuery: (sql: string) => ({ query: sql, wasLimited: false, limit: 1, offset: 0 }),
      // The bridge reads the session's object model from the provider; this one states none.
      getCapabilities: () => ({}),
      query: async () => {
        answeredAt = Date.now();
        return { rows: [{ n: 1 }], fields: ["n"], rowCount: 1, executionTime: 1 };
      },
      endOpenQueryTransaction: () => new Promise<never>(() => {}),
    } as never;
    try {
      await deps.runEditorQuery(deps.providerConsoleTarget(provider), {
        statement: "SELECT n FROM t",
        options: { limit: 1 },
        signal: new AbortController().signal,
        route: "bounds",
        scrub: deps.providerTextScrub(config as never, "any"),
      });
      return "answered";
    } catch (error) {
      const waited = Math.round((Date.now() - answeredAt) / 1_000);
      return `${(error as Error).name} ${deps.errorKind(error)} ${deps.errorOutcome(error)} after ${waited} s: ${(error as Error).message}`;
    }
  },
  heapLimitMiB: 256,
  timeoutMs: 30_000,
});

beforeAll(async () => {
  await child.build();
});

afterAll(() => {
  child.remove();
});

describe("the end of an editor run's scope in a bounded child", () => {
  test("an end that never answers is cut at the cleanup deadline, and the run answers StudioTimeoutRefusal naming it", async () => {
    expect(await child.run<string>("end-never-answers")).toBe(
      "TimeoutError studio-timeout-refusal unknown after 10 s: Ending the transaction this request may have left open did not answer within 10 seconds, so Studio stopped waiting for it.",
    );
  }, 40_000);
});
