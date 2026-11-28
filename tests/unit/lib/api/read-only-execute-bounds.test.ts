/**
 * A read-only execute whose provider never answers, with a real deadline and a real host core, in a bounded Node child
 * (src/lib/api/read-only-execute.ts; docs/providers/CONTRACT.md, clause C-79): the statement waits until its own
 * deadline, the statement timeout from its start, so it answers `StudioTimeBudgetRefusal` in the time budget's sentence
 * within the child's spawn timeout, with the stopped call's settlement handed to the caller's hold. Without the
 * deadline the child waits until the spawn timeout kills it, and the case fails within seconds; the child holds a
 * referenced interval, so Node cannot exit early on the unsettled statement (tests/helpers/bounded-node-child.ts).
 *
 * `read-only-execute.test.ts` holds the same rule with a short real deadline settled by a plain await, and a caller's
 * leaving driven by the test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { runReadOnlyExecute } from "@/lib/api/read-only-execute";
import type { DatabaseProvider } from "@/lib/db/types";
import type { errorKind, errorOutcome } from "@/lib/db/error-record";
import type { createHostCore } from "@/lib/provider-host/core/host-core";
import type { installHostCore } from "@/lib/provider-host/instance";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly runReadOnlyExecute: typeof runReadOnlyExecute;
  readonly createHostCore: typeof createHostCore;
  readonly installHostCore: typeof installHostCore;
  readonly errorKind: typeof errorKind;
  readonly errorOutcome: typeof errorOutcome;
}

const SRC = path.join(import.meta.dir, "..", "..", "..", "..", "src");

const child = boundedChild({
  label: "read-only-execute-bounds",
  imports: [
    { from: path.join(SRC, "lib", "api", "read-only-execute.ts"), names: ["runReadOnlyExecute"] },
    { from: path.join(SRC, "lib", "provider-host", "core", "host-core.ts"), names: ["createHostCore"] },
    { from: path.join(SRC, "lib", "provider-host", "instance.ts"), names: ["installHostCore"] },
    { from: path.join(SRC, "lib", "db", "error-record.ts"), names: ["errorKind", "errorOutcome"] },
  ],
  runCase: async (deps: ChildDeps) => {
    deps.installHostCore(deps.createHostCore(), "test");
    const provider = {
      type: "postgres",
      config: { id: "c1", name: "Prod", type: "postgres", host: "db" },
      queryReadOnly: () => new Promise<never>(() => {}),
    } as unknown as DatabaseProvider;
    let held = 0;
    try {
      await deps.runReadOnlyExecute(
        { form: "provider", provider },
        {
          type: "postgres",
          statement: "SELECT 1",
          budget: { statementTimeoutMs: 50, maxResultRows: 200, maxResultBytes: 262144 },
          caller: new AbortController().signal,
          route: "bounds",
          holdUntilSettled: () => {
            held += 1;
          },
        },
      );
      return "answered";
    } catch (error) {
      return `${(error as Error).name} ${deps.errorKind(error)} ${deps.errorOutcome(error)} ${(error as Error).message} held ${held}`;
    }
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

describe("a read-only execute in a bounded child", () => {
  test("a read-only execute whose provider never answers ends at its own deadline in the time budget's sentence", async () => {
    expect(await child.run<unknown>("never-answers")).toBe(
      "QueryError studio-time-budget-refusal unknown Read-only execution exceeded the time budget: no answer within 50ms held 1",
    );
  });
});
