/**
 * The teardown's own deadlines with real timers, in a bounded Node child (src/lib/provider-host/core/teardown.ts;
 * docs/providers/CONTRACT.md, clause C-45): a rollback and a close that never settle are each cut, so the child answers
 * within its spawn timeout. Without the deadlines the child waits until the spawn timeout kills it, and the case fails
 * within seconds; the child holds a referenced interval, so Node cannot exit early on the unsettled wait
 * (tests/helpers/bounded-node-child.ts).
 *
 * `teardown.test.ts` holds the same rules under fake timers in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { teardownWithin } from "@/lib/provider-host/core/teardown";
import { boundedChild } from "../../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly teardownWithin: typeof teardownWithin;
}

const child = boundedChild({
  label: "teardown-bounds",
  imports: [
    {
      from: path.join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "..",
        "..",
        "src",
        "lib",
        "provider-host",
        "core",
        "teardown.ts",
      ),
      names: ["teardownWithin"],
    },
  ],
  runCase: async (deps: ChildDeps) => {
    const hangs = (): Promise<void> => new Promise<void>(() => {});
    return deps.teardownWithin({ rollback: hangs, close: hangs }, { rollbackMs: 50, closeMs: 100 });
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

describe("the teardown's deadlines in a bounded child", () => {
  test("a close that never settles is cut by the teardown's own deadline", async () => {
    expect(await child.run<unknown>("never-settles")).toEqual({ rollback: "timed-out", close: "timed-out" });
  });
});
