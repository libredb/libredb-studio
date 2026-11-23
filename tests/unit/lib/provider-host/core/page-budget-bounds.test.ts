/**
 * A large page waiting for the one large-page slot, with a real deadline, in a bounded Node child
 * (src/lib/provider-host/core/page-budget.ts and console.ts; docs/providers/CONTRACT.md, clause C-53): page A takes the
 * slot and its next batch never answers, page B needs a second batch under a deadline 50 ms ahead, and B's call answers
 * a stop at that deadline, marked as waiting for the slot, its wait gone from the budget's queue. The child holds a referenced interval, so a wait
 * nothing ends keeps it alive until the spawn timeout kills it and the case fails within seconds
 * (tests/helpers/bounded-node-child.ts).
 *
 * `console-pages.test.ts` holds the same waits with caller-driven aborts in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { consoleCalls } from "@/lib/provider-host/core/console";
import type { createPageBudget } from "@/lib/provider-host/core/page-budget";
import { boundedChild } from "../../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly consoleCalls: typeof consoleCalls;
  readonly createPageBudget: typeof createPageBudget;
}

const CORE = path.join(import.meta.dir, "..", "..", "..", "..", "..", "src", "lib", "provider-host", "core");

const child = boundedChild({
  label: "page-budget-bounds",
  imports: [
    { from: path.join(CORE, "console.ts"), names: ["consoleCalls"] },
    { from: path.join(CORE, "page-budget.ts"), names: ["createPageBudget"] },
  ],
  runCase: async (deps: ChildDeps) => {
    const budget = deps.createPageBudget(1);
    const calls = deps.consoleCalls(budget);
    const env = { get: () => undefined };
    const limits = () => ({ maxRows: 10, maxBytes: 1_024, batchMaxBytes: 16 });
    const ports = { late: () => {}, cancelFailed: () => {} };
    const sessionOver = (source: unknown) =>
      ({
        calls: {
          console: {
            execute: { honours: [] },
            cancel: "not-offered",
            endScope: "not-offered",
            transaction: "not-offered",
          },
        },
        execute: async () => ({ results: [source], warnings: [], executionTimeMs: 1, pageApplied: true }),
      }) as unknown as Parameters<typeof calls.executeCall>[0];
    const request = { statement: "page", page: { limit: 10, offset: 0 } };

    // Page A: its first batch answers, its second pull takes the slot and never answers.
    const secondPull = Promise.withResolvers<void>();
    let pullsA = 0;
    const neverDone = {
      columns: [{ name: "v" }],
      next: () => {
        pullsA += 1;
        if (pullsA === 1) return Promise.resolve({ rows: [[1]], done: false });
        secondPull.resolve();
        return new Promise<never>(() => {});
      },
      close: async () => {},
    };
    const hourAhead = Date.now() + 3_600_000;
    calls.executeCall(
      sessionOver(neverDone),
      request,
      { deadline: hourAhead, signal: new AbortController().signal, env },
      limits,
      ports,
    );
    await secondPull.promise;

    // Page B: two batches, under a deadline 50 ms ahead.
    let pullsB = 0;
    const twoBatches = {
      columns: [{ name: "v" }],
      next: async () => {
        pullsB += 1;
        return { rows: [[pullsB]], done: pullsB >= 2 };
      },
      close: async () => {},
    };
    const deadline = Date.now() + 50;
    const record = await calls.executeCall(
      sessionOver(twoBatches),
      request,
      { deadline, signal: AbortSignal.timeout(50), env },
      limits,
      ports,
    );
    const state = budget.state();
    const stopped = record as { kind: string; reason?: Error; waitingFor?: string };
    return {
      record: record.kind === "stopped" ? `stopped ${stopped.reason?.name}` : record.kind,
      waitingFor: stopped.waitingFor ?? "nothing",
      pullsB,
      held: state.held,
      waiting: state.waiting,
    };
  },
  heapLimitMiB: 128,
  timeoutMs: 3_000,
});

beforeAll(async () => {
  await child.build();
});

afterAll(() => {
  child.remove();
});

describe("a large page in a bounded child", () => {
  test("a large page waiting behind a slot that is never released is stopped at its call's deadline", async () => {
    expect(await child.run<unknown>("slot-never-released")).toEqual({
      record: "stopped TimeoutError",
      waitingFor: "large-page-slot",
      pullsB: 1,
      held: 1,
      waiting: 0,
    });
  });
});
