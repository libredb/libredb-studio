/**
 * A tree call that never settles, with a real deadline, in a bounded Node child (src/lib/provider-host/core/objects.ts;
 * docs/providers/CONTRACT.md, clause C-64): the call's wait ends at the deadline's signal and answers a stop, so the
 * child answers within its spawn timeout. Without the wait the child waits until the spawn timeout kills it, and the
 * case fails within seconds; the child holds a referenced interval, so Node cannot exit early on the unsettled call
 * (tests/helpers/bounded-node-child.ts).
 *
 * `objects.test.ts` holds the same rule with caller-driven aborts in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { treeCall } from "@/lib/provider-host/core/objects";
import { boundedChild } from "../../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly treeCall: typeof treeCall;
}

const CORE = path.join(import.meta.dir, "..", "..", "..", "..", "..", "src", "lib", "provider-host", "core");

const child = boundedChild({
  label: "objects-bounds",
  imports: [{ from: path.join(CORE, "objects.ts"), names: ["treeCall"] }],
  runCase: async (deps: ChildDeps) => {
    const session = {
      calls: {
        console: {
          execute: { honours: [] },
          cancel: "not-offered",
          endScope: "not-offered",
          transaction: "not-offered",
        },
        objects: { tree: "offered" },
        maintenance: { run: "not-offered", preview: "not-offered" },
        monitoring: { panel: "not-offered", poolStats: "not-offered" },
      },
      tree: () => new Promise<never>(() => {}),
    } as unknown as Parameters<typeof deps.treeCall>[0];
    const record = await deps.treeCall(
      session,
      { action: "containers" },
      { deadline: Date.now() + 50, signal: AbortSignal.timeout(50), env: { get: () => undefined } },
      { late: () => {} },
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

describe("a tree call in a bounded child", () => {
  test("a tree call that never settles is stopped at the call's deadline", async () => {
    expect(await child.run<unknown>("never-settles")).toBe("stopped TimeoutError");
  });
});
