/**
 * A maintenance narrowing `open` answers is refused by its length before any item is read (docs/providers/CONTRACT.md,
 * clause C-68), proven where a failure is bounded.
 *
 * A reader that walked the list to its `length` would loop over a sparse array of length 2^32 - 1 and push a refusal
 * per hole until the heap is gone. So no case runs in this process: each runs in a Node child under the helper's bound
 * (tests/helpers/node-child.ts) and prints one JSON line. Every line the child reaches, refinement.test.ts reaches in
 * process too.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { CallRefusal, CallRefusalError, checkRefinement, sessionMaintenance } from "@libredb/provider-sdk/calls";
import { boundedChild } from "../helpers/node-child";

/** The old space each child may use: far less than a refusal per hole of the longest array would need. */
const HEAP_LIMIT_MIB = 64;

interface ChildDeps {
  readonly checkRefinement: typeof checkRefinement;
  readonly sessionMaintenance: typeof sessionMaintenance;
}

interface ChildReport {
  readonly name: string;
  readonly refusals: readonly CallRefusal[];
}

/**
 * Runs in the child, from its text: a refinement whose maintenance narrowing is a sparse array of the longest length
 * an array can have, read by `checkRefinement` or by `sessionMaintenance`, whose thrown refusals are reported.
 */
function runCase(deps: ChildDeps, name: string): ChildReport {
  const longest: unknown[] = [];
  longest.length = 2 ** 32 - 1;
  const refine = { maintenance: longest };
  if (name === "checkRefinement") {
    const declared = {
      console: { execute: { honours: [] }, cancel: "offered", endScope: "offered", transaction: "offered" },
      objects: { tree: "offered" },
      maintenance: { run: "offered", preview: "offered" },
      monitoring: { panel: "not-offered", poolStats: "not-offered" },
    };
    return { name, refusals: deps.checkRefinement(declared as never, refine) };
  }
  try {
    deps.sessionMaintenance({ maintenance: ["vacuum"], maintenanceSpecs: [] } as never, refine as never);
  } catch (error) {
    return { name, refusals: (error as CallRefusalError).refusals };
  }
  return { name, refusals: [] };
}

const child = boundedChild({
  label: "narrowing-bounds",
  imports: [
    {
      from: path.join(import.meta.dir, "..", "..", "src", "calls", "index.ts"),
      names: ["checkRefinement", "sessionMaintenance"],
    },
  ],
  runCase,
  heapLimitMiB: HEAP_LIMIT_MIB,
  timeoutMs: 20_000,
});

beforeAll(() => child.build(), 60_000);

afterAll(() => {
  child.remove();
});

describe(`the maintenance narrowing in a Node child under --max-old-space-size=${HEAP_LIMIT_MIB}`, () => {
  test("a maintenance narrowing of the longest length is refused at the list, in a bounded child", async () => {
    for (const name of ["checkRefinement", "sessionMaintenance"]) {
      // oxlint-disable-next-line no-await-in-loop -- one child at a time, each under its own bound.
      expect(await child.run<ChildReport>(name)).toEqual({
        name,
        refusals: [{ rule: "refinement-unreadable", pointer: "/maintenance" }],
      });
    }
  }, 60_000);
});
