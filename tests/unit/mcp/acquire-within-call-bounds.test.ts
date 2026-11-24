/**
 * An MCP acquisition's wait with a real timer, in a bounded Node child (src/lib/mcp/tools/read-query-limits.ts,
 * `acquireWithinCall`; docs/providers/CONTRACT.md, clause C-81): an acquisition whose open never settles ends at the
 * call's deadline and is answered as the timeout, so the child answers within its spawn timeout. Without the deadline
 * over the acquisition, the child waits until the spawn timeout kills it, and the case fails within seconds; the child
 * holds a referenced interval, so Node cannot exit early on the unsettled wait (tests/helpers/bounded-node-child.ts).
 *
 * `read-query-limits.test.ts` holds the same rule with caller-driven aborts and a deadline already passed, in the test
 * process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { acquireWithinCall } from "@/lib/mcp/tools/read-query-limits";
import { boundedChild } from "../../helpers/bounded-node-child";

interface ChildDeps {
  readonly acquireWithinCall: typeof acquireWithinCall;
}

const SOURCE = path.join(import.meta.dir, "..", "..", "..", "src");

const child = boundedChild({
  label: "acquire-within-call-bounds",
  imports: [{ from: path.join(SOURCE, "lib", "mcp", "tools", "read-query-limits.ts"), names: ["acquireWithinCall"] }],
  runCase: async (deps: ChildDeps) => {
    // A context whose acquisition never settles and never reads its wait.
    const context = { acquire: () => new Promise<never>(() => {}) };
    const answered = await deps.acquireWithinCall(
      { context, signal: new AbortController().signal } as unknown as Parameters<typeof acquireWithinCall>[0],
      { id: "seed:stand-in", type: "postgres" } as unknown as Parameters<typeof acquireWithinCall>[1],
      "agent-read-only",
      // The call's deadline, 50 ms from now.
      Date.now() + 50,
    );
    return answered.kind;
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

describe("an MCP acquisition's wait in a bounded child", () => {
  test("an MCP acquisition whose open never settles ends at the call's deadline", async () => {
    expect(await child.run<string>("never-opens")).toBe("timeout");
  });
});
