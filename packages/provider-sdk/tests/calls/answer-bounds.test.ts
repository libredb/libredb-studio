/**
 * Every list of an execute answer and of a tree answer is refused by its length before any item is read, and a list's
 * first hole ends its reading (docs/providers/CONTRACT.md, clauses C-62 and C-112), proven where a failure is bounded.
 *
 * A check that walked a list to its `length` would loop over a sparse array of length 2^32 - 1 and push a refusal per
 * hole until the heap is gone, and one that read past a hole would push a refusal per hole of a list within its bound.
 * So no case runs in this process: each runs in a Node child under the helper's bound (tests/helpers/node-child.ts)
 * and prints one JSON line. Every line the child reaches, answers.test.ts reaches in process too.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { CallRefusal, checkExecuteAnswer, checkTreeAnswer } from "@libredb/provider-sdk/calls";
import { boundedChild } from "../helpers/node-child";

/** The old space each child may use: far less than a refusal per hole of the longest array would need. */
const HEAP_LIMIT_MIB = 64;

interface ChildDeps {
  readonly checkExecuteAnswer: typeof checkExecuteAnswer;
  readonly checkTreeAnswer: typeof checkTreeAnswer;
}

interface ChildReport {
  readonly name: string;
  readonly refusals: readonly CallRefusal[];
}

/**
 * Runs in the child, from its text: an answer one of whose lists is a sparse array of the longest length an array can
 * have, or, for the two `holes` cases, a list within its bound whose every item is a hole, or, for the `shifting`
 * cases, a list whose length converts to 0 on its first conversion and to the longest length on every later one, and
 * whose every index answers an item its form refuses. Only the answer's refusals are reported.
 */
function runCase(deps: ChildDeps, name: string): ChildReport {
  const longest: unknown[] = [];
  longest.length = 2 ** 32 - 1;
  const holes: unknown[] = [];
  holes.length = 2 ** 20;
  const container = ["c"];
  const shifting = (): unknown[] => {
    let conversions = 0;
    const length = { valueOf: () => (conversions++ === 0 ? 0 : 2 ** 32 - 1) };
    const item = { value: 1, writable: true, enumerable: true, configurable: true };
    return new Proxy([] as unknown[], {
      get: (target, key) => (key === "length" ? length : Reflect.get(target, key)),
      getOwnPropertyDescriptor: (target, key) =>
        key === "length" ? { ...Reflect.getOwnPropertyDescriptor(target, key), value: length } : item,
    });
  };
  const execute = (answer: Record<string, unknown>) =>
    deps.checkExecuteAnswer({ results: [], warnings: [], executionTimeMs: 1, ...answer });
  const checks: Record<string, () => ReturnType<typeof checkExecuteAnswer> | ReturnType<typeof checkTreeAnswer>> = {
    results: () => execute({ results: longest }),
    columns: () => execute({ results: [{ columns: longest }] }),
    warnings: () => execute({ warnings: longest }),
    executeHoles: () => execute({ warnings: holes.slice(0, 2 ** 16) }),
    containers: () => deps.checkTreeAnswer({ action: "containers" }, { containers: longest }),
    path: () =>
      deps.checkTreeAnswer({ action: "containers" }, { containers: [{ path: longest, name: "c", level: 0 }] }),
    objects: () => deps.checkTreeAnswer({ action: "list", container, kind: "table" }, { objects: longest }),
    details: () => deps.checkTreeAnswer({ action: "describeMany", container, kind: "table" }, { details: longest }),
    treeHoles: () => deps.checkTreeAnswer({ action: "list", container, kind: "table" }, { objects: holes }),
    shiftingWarnings: () => execute({ warnings: shifting() }),
    shiftingObjects: () => deps.checkTreeAnswer({ action: "list", container, kind: "table" }, { objects: shifting() }),
    shiftingDetails: () =>
      deps.checkTreeAnswer({ action: "describeMany", container, kind: "table", limit: 2 }, { details: shifting() }),
  };
  const check = checks[name]();
  return { name, refusals: check.kind === "read" ? [] : check.refusals };
}

const child = boundedChild({
  label: "answer-bounds",
  imports: [
    {
      from: path.join(import.meta.dir, "..", "..", "src", "calls", "index.ts"),
      names: ["checkExecuteAnswer", "checkTreeAnswer"],
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

const execute = (pointer: string): CallRefusal => ({ rule: "execute-answer-unreadable", pointer });
const tree = (pointer: string): CallRefusal => ({ rule: "tree-answer-unreadable", pointer });

describe(`the answer checks' lists in a Node child under --max-old-space-size=${HEAP_LIMIT_MIB}`, () => {
  test.each([
    ["results", [execute("/results")]],
    ["columns", [execute("/results/0/columns")]],
    ["warnings", [execute("/warnings")]],
    ["containers", [tree("/containers")]],
    ["path", [tree("/containers/0/path")]],
    ["objects", [tree("/objects")]],
    ["details", [tree("/details")]],
  ])(
    "an answer list of the longest length, %s, is refused at the list, in a bounded child",
    async (name, refusals) => {
      expect(await child.run<ChildReport>(name)).toEqual({ name, refusals });
    },
    30_000,
  );

  test("a list within its bound whose every item is a hole is refused at its first hole alone, in a bounded child", async () => {
    expect(await child.run<ChildReport>("executeHoles")).toEqual({
      name: "executeHoles",
      refusals: [execute("/warnings/0")],
    });
    expect(await child.run<ChildReport>("treeHoles")).toEqual({ name: "treeHoles", refusals: [tree("/objects/0")] });
  }, 60_000);

  test.each([
    ["shiftingWarnings", [execute("/warnings")]],
    ["shiftingObjects", [tree("/objects")]],
    ["shiftingDetails", [tree("/details")]],
  ])(
    "a list whose length converts to 0 first and to the longest length after, %s, is refused at the list, in a bounded child",
    async (name, refusals) => {
      expect(await child.run<ChildReport>(name)).toEqual({ name, refusals });
    },
    30_000,
  );
});
