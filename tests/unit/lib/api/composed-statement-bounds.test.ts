/**
 * A composed statement whose provider never answers, with a real deadline and a real host core, in a bounded Node child
 * (src/lib/api/composed-statement.ts; docs/providers/CONTRACT.md, clause C-80): the statement waits until its grant's
 * deadline, 50 ms out, so it answers the grant's own time refusal within the child's spawn timeout, with the stopped
 * call's settlement handed to the grant's hold. Without the deadline the child waits until the spawn timeout kills it,
 * and the case fails within seconds; the child holds a referenced interval, so Node cannot exit early on the unsettled
 * statement (tests/helpers/bounded-node-child.ts).
 *
 * `composed-statement.test.ts` holds the same rule with a short real grant settled by a plain await.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { runComposedStatement } from "@/lib/api/composed-statement";
import type { createHostCore } from "@/lib/provider-host/core/host-core";
import type { installHostCore } from "@/lib/provider-host/instance";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly runComposedStatement: typeof runComposedStatement;
  readonly createHostCore: typeof createHostCore;
  readonly installHostCore: typeof installHostCore;
}

const SRC = path.join(import.meta.dir, "..", "..", "..", "..", "src");

const child = boundedChild({
  label: "composed-statement-bounds",
  imports: [
    { from: path.join(SRC, "lib", "api", "composed-statement.ts"), names: ["runComposedStatement"] },
    { from: path.join(SRC, "lib", "provider-host", "core", "host-core.ts"), names: ["createHostCore"] },
    { from: path.join(SRC, "lib", "provider-host", "instance.ts"), names: ["installHostCore"] },
  ],
  runCase: async (deps: ChildDeps) => {
    deps.installHostCore(deps.createHostCore(), "test");
    const provider = {
      type: "mssql",
      config: { id: "c1", name: "Prod", type: "mssql", host: "db" },
      query: () => new Promise<never>(() => {}),
    } as unknown as Parameters<typeof deps.runComposedStatement>[0];
    let held = 0;
    try {
      await deps.runComposedStatement(provider, {
        statement: "SELECT 1",
        deadline: Date.now() + 50,
        timeRefusal: () => new Error("the grant's own time refusal"),
        route: "bounds",
        holdUntilSettled: () => {
          held += 1;
        },
      });
      return "answered";
    } catch (error) {
      return `${(error as Error).message}, held ${held}`;
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

describe("a composed statement in a bounded child", () => {
  test("a composed statement whose provider never answers ends at the grant's deadline in the grant's own time refusal", async () => {
    expect(await child.run<unknown>("never-answers")).toBe("the grant's own time refusal, held 1");
  });
});
