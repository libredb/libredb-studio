/**
 * A caller's own wait on an open that never settles, with a real timer, in a bounded Node child
 * (src/lib/provider-host/core/open-once.ts; docs/providers/CONTRACT.md, clause C-44): the caller's signal ends its wait
 * with the signal's reason, so the child answers within its spawn timeout. Without the per-caller wait the child waits
 * until the spawn timeout kills it, and the case fails within seconds; the child holds a referenced interval, so Node
 * cannot exit early on the unsettled wait (tests/helpers/bounded-node-child.ts).
 *
 * An open's own deadline (clause C-55) is held the same way: a table whose deadline aborts after 50 ms ends an open that
 * never settles for a caller with no wait of its own, who otherwise waits until the spawn timeout kills the child.
 *
 * `open-once.test.ts` holds the same rules with caller-driven aborts in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { createOpenFlights, openOnce } from "@/lib/provider-host/core/open-once";
import { boundedChild } from "../../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly createOpenFlights: typeof createOpenFlights;
  readonly openOnce: typeof openOnce;
}

const child = boundedChild({
  label: "open-once-bounds",
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
        "open-once.ts",
      ),
      names: ["createOpenFlights", "openOnce"],
    },
  ],
  runCase: async (deps: ChildDeps, name: string) => {
    if (name === "deadline-ends-open") {
      const expiring = deps.createOpenFlights<object, object>(() => {}, {
        signal: () => AbortSignal.timeout(50),
        expired: () => Object.assign(new Error("the open passed its deadline"), { name: "OpenExpired" }),
      });
      try {
        await deps.openOnce(expiring, "key", {}, () => new Promise<object>(() => {}));
        return { answered: "value" };
      } catch (error) {
        return { answered: (error as Error).name };
      }
    }
    const flights = deps.createOpenFlights<object, object>(() => {});
    try {
      await deps.openOnce(flights, "key", {}, () => new Promise<object>(() => {}), {
        signal: AbortSignal.timeout(50),
      });
      return { answered: "value" };
    } catch (error) {
      return { answered: (error as Error).name };
    }
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

describe("a caller's wait in a bounded child", () => {
  test("a caller's signal frees it from an open that never settles", async () => {
    expect(await child.run<unknown>("never-settles")).toEqual({ answered: "TimeoutError" });
  });
});

describe("an open's own deadline in a bounded child", () => {
  test("an open that never settles is ended by its own deadline", async () => {
    expect(await child.run<unknown>("deadline-ends-open")).toEqual({ answered: "OpenExpired" });
  });
});
