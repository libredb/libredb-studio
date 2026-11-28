/**
 * A tree read that never answers, with real timers, in a bounded Node child (src/lib/api/object-tree.ts;
 * docs/providers/CONTRACT.md, clause C-65): the read's deadline, the statement timeout plus the slack, is set 50 ms out
 * through the facade's clock, so the child answers within its spawn timeout. Without the host's wait the child waits
 * until the spawn timeout kills it, and the case fails within seconds; the child holds a referenced interval, so Node
 * cannot exit early on the unsettled read (tests/helpers/bounded-node-child.ts).
 *
 * A granted read of the grounding walk that never answers is held the same way, its grant's deadline 50 ms out, and so
 * is a within-call read of an MCP call, its call's deadline 50 ms out.
 *
 * `object-tree.test.ts` holds the same rules with a core of the test's own, in the test process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { EXECUTE_SLACK_MS } from "@/lib/api/editor-query";
import type { grantedObjectTree, objectTree, objectTreeWithinCall } from "@/lib/api/object-tree";
import type { providerTreeTarget } from "@/lib/api/session-target";
import type { errorKind, errorOutcome } from "@/lib/db/error-record";
import type { createHostCore } from "@/lib/provider-host/core/host-core";
import type { installHostCore } from "@/lib/provider-host/instance";
import { boundedChild } from "../../../helpers/bounded-node-child";

interface ChildDeps {
  readonly EXECUTE_SLACK_MS: typeof EXECUTE_SLACK_MS;
  readonly objectTree: typeof objectTree;
  readonly grantedObjectTree: typeof grantedObjectTree;
  readonly objectTreeWithinCall: typeof objectTreeWithinCall;
  readonly providerTreeTarget: typeof providerTreeTarget;
  readonly errorKind: typeof errorKind;
  readonly errorOutcome: typeof errorOutcome;
  readonly createHostCore: typeof createHostCore;
  readonly installHostCore: typeof installHostCore;
}

const SOURCE = path.join(import.meta.dir, "..", "..", "..", "..", "src");

const child = boundedChild({
  label: "object-tree-bounds",
  imports: [
    { from: path.join(SOURCE, "lib", "api", "editor-query.ts"), names: ["EXECUTE_SLACK_MS"] },
    {
      from: path.join(SOURCE, "lib", "api", "object-tree.ts"),
      names: ["objectTree", "grantedObjectTree", "objectTreeWithinCall"],
    },
    { from: path.join(SOURCE, "lib", "api", "session-target.ts"), names: ["providerTreeTarget"] },
    { from: path.join(SOURCE, "lib", "db", "error-record.ts"), names: ["errorKind", "errorOutcome"] },
    { from: path.join(SOURCE, "lib", "provider-host", "core", "host-core.ts"), names: ["createHostCore"] },
    { from: path.join(SOURCE, "lib", "provider-host", "instance.ts"), names: ["installHostCore"] },
  ],
  runCase: async (deps: ChildDeps, name: string) => {
    deps.installHostCore(deps.createHostCore(), "test");
    const queryTimeout = 1_000;
    // A provider whose object listing never settles.
    const provider = {
      type: "postgres",
      config: { id: "c", name: "c", type: "postgres", createdAt: new Date(0), queryTimeout },
      // One container level and the kind `table`, the model the reads below name.
      getCapabilities: () => ({
        containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
        objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
      }),
      listObjects: () => new Promise<never>(() => {}),
    } as never;
    if (name === "granted-never-answers") {
      let held = 0;
      // The grant's deadline ends 50 ms from now, and its time refusal is the grant's own.
      const granted = deps.grantedObjectTree(deps.providerTreeTarget(provider), {
        deadline: Date.now() + 50,
        timeRefusal: () => new Error("the grant's own time refusal"),
        route: "bounds",
        holdUntilSettled: () => {
          held += 1;
        },
      });
      try {
        await granted.listObjects(["app"], "table");
        return "answered";
      } catch (error) {
        return `${(error as Error).message}, held ${held}`;
      }
    }
    if (name === "within-call-never-answers") {
      // The call's deadline ends 50 ms from now, and its time refusal is the call's own.
      const within = deps.objectTreeWithinCall(deps.providerTreeTarget(provider), {
        deadline: Date.now() + 50,
        caller: new AbortController().signal,
        timeRefusal: () => new Error("the call's own time refusal"),
        route: "bounds",
      });
      try {
        await within.listObjects(["app"], "table");
        return "answered";
      } catch (error) {
        return (error as Error).message;
      }
    }
    const tree = deps.objectTree(
      deps.providerTreeTarget(provider),
      new AbortController().signal,
      "bounds",
      // The read's deadline, the statement timeout plus the slack, ends 50 ms from now.
      () => Date.now() - queryTimeout - deps.EXECUTE_SLACK_MS + 50,
    );
    try {
      await tree.listObjects(["app"], "table");
      return "answered";
    } catch (error) {
      return `${(error as Error).name} ${deps.errorKind(error)} ${deps.errorOutcome(error)} ${(error as Error).message}`;
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

describe("a tree read in a bounded child", () => {
  test("a tree read that never answers is stopped at its deadline, StudioTimeoutRefusal naming the read", async () => {
    expect(await child.run<unknown>("never-answers")).toBe(
      "TimeoutError studio-timeout-refusal unknown The object listing did not answer within the statement timeout of 1 second and 10 seconds more for the engine's own answer, so Studio stopped waiting for it.",
    );
  });

  test("a granted tree read that never answers ends at the grant's deadline in the grant's own time refusal", async () => {
    expect(await child.run<unknown>("granted-never-answers")).toBe("the grant's own time refusal, held 1");
  });

  test("a within-call tree read that never answers ends at the call's deadline in the call's own time refusal", async () => {
    expect(await child.run<unknown>("within-call-never-answers")).toBe("the call's own time refusal");
  });
});
