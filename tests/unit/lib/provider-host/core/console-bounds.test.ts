/**
 * A console execute, a transaction call and an endScope call that never settle, with a real deadline, in a bounded Node child
 * (src/lib/provider-host/core/console.ts; docs/providers/CONTRACT.md, clause C-48): the call's wait ends at the
 * deadline's signal and answers a stop, so the child answers within its spawn timeout. Without the wait the child
 * waits until the spawn timeout kills it, and the case fails within seconds; the child holds a referenced interval, so
 * Node cannot exit early on the unsettled call (tests/helpers/bounded-node-child.ts).
 *
 * `console.test.ts` holds the same rule with caller-driven aborts in the test process.
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
  label: "console-bounds",
  imports: [
    { from: path.join(CORE, "console.ts"), names: ["consoleCalls"] },
    { from: path.join(CORE, "page-budget.ts"), names: ["createPageBudget"] },
  ],
  runCase: async (deps: ChildDeps, name: string) => {
    const { executeCall, transactionCall, endScopeCall } = deps.consoleCalls(deps.createPageBudget(1));
    const deadline = Date.now() + 50;
    const session = {
      calls: {
        console: {
          execute: { honours: [] },
          cancel: "not-offered",
          endScope: "offered",
          transaction: "offered",
        },
        objects: { tree: "not-offered" },
      },
      execute: () => new Promise<never>(() => {}),
      transaction: () => new Promise<never>(() => {}),
      endScope: () => new Promise<never>(() => {}),
    } as unknown as Parameters<typeof executeCall>[0];
    if (name === "transaction-never-settles") {
      const answered = await transactionCall(
        session,
        { action: "commit" },
        { deadline, signal: AbortSignal.timeout(50), env: { get: () => undefined } },
        { late: () => {} },
      );
      return answered.kind === "stopped" ? `stopped ${(answered.reason as Error).name}` : answered.kind;
    }
    if (name === "end-scope-never-settles") {
      const ended = await endScopeCall(
        session,
        { scope: "never" },
        { deadline, signal: AbortSignal.timeout(50), env: { get: () => undefined } },
        { late: () => {} },
      );
      return ended.kind === "stopped" ? `stopped ${(ended.reason as Error).name}` : ended.kind;
    }
    const record = await executeCall(
      session,
      { statement: "never", page: { limit: 1, offset: 0 } },
      { deadline, signal: AbortSignal.timeout(50), env: { get: () => undefined } },
      () => ({ maxRows: 1, maxBytes: 1, batchMaxBytes: 1 }),
      { late: () => {}, cancelFailed: () => {} },
    );
    return record.kind === "stopped" ? `stopped ${(record.reason as Error).name}` : record.kind;
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

describe("a console execute in a bounded child", () => {
  test("an execute that never settles is stopped at the call's deadline", async () => {
    expect(await child.run<unknown>("never-settles")).toBe("stopped TimeoutError");
  });

  test("a transaction call that never settles is stopped at the call's deadline", async () => {
    expect(await child.run<unknown>("transaction-never-settles")).toBe("stopped TimeoutError");
  });

  test("an endScope call that never settles is stopped at the call's deadline", async () => {
    expect(await child.run<unknown>("end-scope-never-settles")).toBe("stopped TimeoutError");
  });
});
