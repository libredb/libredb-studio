/**
 * The editor call's open allowance with a real timer, in a bounded Node child (src/lib/api/editor-query.ts,
 * `openWithinCall`; docs/providers/CONTRACT.md, clauses C-44 and C-51): an open that never settles, shared through the
 * host core's open table as the factory shares it, is cut at the call's allowance and answered not-sent, so the child
 * answers within its spawn timeout. Without the call's wait reaching the open table, the child waits until the spawn
 * timeout kills it, and the case fails within seconds; the child holds a referenced interval, so Node cannot exit early
 * on the unsettled wait (tests/helpers/bounded-node-child.ts).
 *
 * `editor-query.test.ts` holds the same rule with caller-driven aborts and an allowance already passed, in the test
 * process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { openWithinCall } from "@/lib/api/editor-query";
import type { connectBudgetFor } from "@/lib/db/connect-budget";
import type { errorKind, errorOutcome } from "@/lib/db/error-record";
import type { StudioTimeoutRefusal } from "@/lib/db/errors";
import type { createOpenFlights, openOnce } from "@/lib/provider-host/core/open-once";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly connectBudgetFor: typeof connectBudgetFor;
  readonly openWithinCall: typeof openWithinCall;
  readonly createOpenFlights: typeof createOpenFlights;
  readonly openOnce: typeof openOnce;
  readonly errorKind: typeof errorKind;
  readonly errorOutcome: typeof errorOutcome;
  readonly StudioTimeoutRefusal: typeof StudioTimeoutRefusal;
}

const SOURCE = path.join(import.meta.dir, "..", "..", "..", "..", "src");

const child = boundedChild({
  label: "editor-open-bounds",
  imports: [
    { from: path.join(SOURCE, "lib", "api", "editor-query.ts"), names: ["openWithinCall"] },
    { from: path.join(SOURCE, "lib", "db", "connect-budget.ts"), names: ["connectBudgetFor"] },
    {
      from: path.join(SOURCE, "lib", "provider-host", "core", "open-once.ts"),
      names: ["createOpenFlights", "openOnce"],
    },
    { from: path.join(SOURCE, "lib", "db", "error-record.ts"), names: ["errorKind", "errorOutcome"] },
    { from: path.join(SOURCE, "lib", "db", "errors.ts"), names: ["StudioTimeoutRefusal"] },
  ],
  runCase: async (deps: ChildDeps) => {
    const flights = deps.createOpenFlights<object, object>(() => {});
    try {
      await deps.openWithinCall(
        new AbortController().signal,
        "postgres",
        (wait) => deps.openOnce(flights, "key", {}, () => new Promise<object>(() => {}), wait),
        // The allowance, the engine's connect budget, ends 50 ms from now.
        Date.now() - deps.connectBudgetFor("postgres") + 50,
      );
      return "answered";
    } catch (error) {
      const named = error instanceof deps.StudioTimeoutRefusal ? "StudioTimeoutRefusal" : (error as Error).name;
      return `${named} ${deps.errorKind(error)} ${deps.errorOutcome(error)}`;
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

describe("the editor call's open allowance in a bounded child", () => {
  test("an open that never settles is cut at the call's open allowance, not-sent", async () => {
    expect(await child.run<string>("never-opens")).toBe("StudioTimeoutRefusal studio-timeout-refusal not-sent");
  });
});
