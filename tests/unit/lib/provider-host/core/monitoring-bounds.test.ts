/**
 * A panel read and a pool statistics read that never settle, with a real deadline, in a bounded Node child
 * (src/lib/provider-host/core/monitoring.ts; docs/providers/CONTRACT.md, clause C-73): each call's wait ends at the
 * deadline's signal and answers a stop, so the child answers within its spawn timeout. Without the wait the child
 * waits until the spawn timeout kills it, and the case fails within seconds; the child holds a referenced interval, so
 * Node cannot exit early on the unsettled call (tests/helpers/bounded-node-child.ts).
 *
 * `monitoring.test.ts` holds the same rule with caller-driven aborts in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { panelCall, poolStatsCall } from "@/lib/provider-host/core/monitoring";
import { boundedChild } from "../../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly panelCall: typeof panelCall;
  readonly poolStatsCall: typeof poolStatsCall;
}

const CORE = path.join(import.meta.dir, "..", "..", "..", "..", "..", "src", "lib", "provider-host", "core");

const child = boundedChild({
  label: "monitoring-bounds",
  imports: [{ from: path.join(CORE, "monitoring.ts"), names: ["panelCall", "poolStatsCall"] }],
  runCase: async (deps: ChildDeps, name: string) => {
    const never = () => new Promise<never>(() => {});
    const session = {
      calls: {
        console: {
          execute: { honours: [] },
          cancel: "not-offered",
          endScope: "not-offered",
          transaction: "not-offered",
        },
        objects: { tree: "not-offered" },
        maintenance: { run: "not-offered", preview: "not-offered" },
        monitoring: { panel: "offered", poolStats: "offered" },
      },
      panels: {
        overview: "offered",
        performance: "offered",
        slowQueries: "offered",
        activeSessions: "offered",
        tables: "offered",
        indexes: "offered",
        storage: "offered",
      },
      panel: never,
      poolStats: never,
    } as unknown as Parameters<typeof deps.panelCall>[0];
    const ctx = { deadline: Date.now() + 50, signal: AbortSignal.timeout(50), env: { get: () => undefined } };
    const record =
      name === "panel"
        ? await deps.panelCall(session, { panel: "overview" }, ctx, { late: () => {} })
        : await deps.poolStatsCall(session, ctx, { late: () => {} });
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

describe("a monitoring call in a bounded child", () => {
  test("a panel read that never settles is stopped at the call's deadline", async () => {
    expect(await child.run<unknown>("panel")).toBe("stopped TimeoutError");
  });

  test("a pool statistics read that never settles is stopped at the call's deadline", async () => {
    expect(await child.run<unknown>("poolStats")).toBe("stopped TimeoutError");
  });
});
