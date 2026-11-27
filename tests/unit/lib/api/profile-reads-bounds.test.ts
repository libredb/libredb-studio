/**
 * The data profile's reads whose provider never answers, with a real deadline and a real host core, in a bounded Node
 * child (src/lib/api/profile-reads.ts; docs/providers/CONTRACT.md, clause C-86): each read waits until its own
 * deadline, set 50 ms out through the facade's clock, so it answers Studio's timeout refusal within the child's
 * spawn timeout. Without the deadline the child waits until the spawn timeout kills it, and the case fails within
 * seconds; the child holds a referenced interval, so Node cannot exit early on the unsettled read
 * (tests/helpers/bounded-node-child.ts).
 *
 * `profile-reads.test.ts` holds the same rule with a deadline 30 ms out settled by a plain await.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { EXECUTE_SLACK_MS } from "@/lib/api/editor-query";
import type { openProfileReads } from "@/lib/api/profile-reads";
import type { StudioTimeoutRefusal } from "@/lib/db/errors";
import type { createHostCore } from "@/lib/provider-host/core/host-core";
import type { installHostCore } from "@/lib/provider-host/instance";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly openProfileReads: typeof openProfileReads;
  readonly createHostCore: typeof createHostCore;
  readonly installHostCore: typeof installHostCore;
  readonly EXECUTE_SLACK_MS: typeof EXECUTE_SLACK_MS;
  readonly StudioTimeoutRefusal: typeof StudioTimeoutRefusal;
}

const SRC = path.join(import.meta.dir, "..", "..", "..", "..", "src");

const child = boundedChild({
  label: "profile-reads-bounds",
  imports: [
    { from: path.join(SRC, "lib", "api", "profile-reads.ts"), names: ["openProfileReads"] },
    { from: path.join(SRC, "lib", "api", "editor-query.ts"), names: ["EXECUTE_SLACK_MS"] },
    { from: path.join(SRC, "lib", "db", "errors.ts"), names: ["StudioTimeoutRefusal"] },
    { from: path.join(SRC, "lib", "provider-host", "core", "host-core.ts"), names: ["createHostCore"] },
    { from: path.join(SRC, "lib", "provider-host", "instance.ts"), names: ["installHostCore"] },
  ],
  runCase: async (deps: ChildDeps, name: string) => {
    deps.installHostCore(deps.createHostCore(), "test");
    const timeout = 1_000;
    const provider = {
      type: "postgres",
      config: { id: "c1", name: "Prod", type: "postgres", host: "db", queryTimeout: timeout },
      query: () => new Promise<never>(() => {}),
      // The bridge reads the session's object model from the provider; this one states none.
      getCapabilities: () => ({}),
      prepareQuery: (query: string, options: { limit: number }) => ({
        query: `${query} LIMIT ${options.limit}`,
        wasLimited: true,
        limit: options.limit,
        offset: 0,
      }),
    } as unknown as Parameters<typeof deps.openProfileReads>[0];
    // The deadline of a read starting now falls 50 ms from now.
    const clock = () => Date.now() - (timeout + deps.EXECUTE_SLACK_MS) + 50;
    const reads = deps.openProfileReads(provider, new AbortController().signal, "bounds", clock);
    try {
      await (name === "composed" ? reads.composed("SELECT 1") : reads.sample("SELECT 1", 5));
      return "answered";
    } catch (error) {
      return error instanceof deps.StudioTimeoutRefusal ? "studio timeout refusal" : (error as Error).message;
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

describe("the data profile's reads in a bounded child", () => {
  test("a profile's composed read whose provider never answers ends at its own deadline in Studio's timeout refusal", async () => {
    expect(await child.run<unknown>("composed")).toBe("studio timeout refusal");
  });

  test("a profile's sample whose provider never answers ends at its own deadline in Studio's timeout refusal", async () => {
    expect(await child.run<unknown>("sample")).toBe("studio timeout refusal");
  });
});
