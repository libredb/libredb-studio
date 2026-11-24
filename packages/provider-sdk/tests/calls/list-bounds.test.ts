/**
 * The engine list and each engine's facet lists are refused by their length before any item is read
 * (docs/providers/CONTRACT.md, clause C-1), proven where a failure is bounded.
 *
 * A check that walked a list to its `length` would loop over a sparse array of length 2^32 - 1 and push a refusal per
 * hole until the heap is gone. So no case runs in this process: each runs in a Node child under the helper's bound
 * (tests/helpers/node-child.ts) and prints one JSON line. Every line the child reaches, define-provider.test.ts reaches
 * in process too.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { checkProviderModule, DefinitionRefusal } from "@libredb/provider-sdk/calls";
import { boundedChild } from "../helpers/node-child";

/** The old space each child may use: far less than a refusal per hole of the longest array would need. */
const HEAP_LIMIT_MIB = 64;

interface ChildDeps {
  readonly checkProviderModule: typeof checkProviderModule;
  readonly manifest: Record<string, unknown>;
}

interface ChildReport {
  readonly name: string;
  readonly refusals: readonly DefinitionRefusal[];
}

/**
 * Runs in the child, from its text: a module record whose engine list, or whose one engine's maintenance, maintenance
 * specs or agent readings list, is a sparse array of the longest length an array can have. Only the refusals of that list are
 * reported.
 */
function runCase(deps: ChildDeps, name: string): ChildReport {
  const longest: unknown[] = [];
  longest.length = 2 ** 32 - 1;
  const manifest = JSON.parse(JSON.stringify(deps.manifest));
  let pointer = "/manifest/engines";
  if (name === "engines") manifest.engines = longest;
  else {
    manifest.engines[0].facets[name] = longest;
    pointer = `/manifest/engines/0/facets/${name}`;
  }
  const impl = { open: async () => ({ handle: {} }), close: async () => {}, console: { execute: async () => ({}) } };
  const refusals = deps.checkProviderModule({ contract: "0.1", manifest, impl });
  return { name, refusals: refusals.filter((item) => item.pointer.startsWith(pointer)) };
}

const child = boundedChild({
  label: "list-bounds",
  imports: [
    { from: path.join(import.meta.dir, "..", "..", "src", "calls", "index.ts"), names: ["checkProviderModule"] },
    { from: path.join(import.meta.dir, "..", "fixtures", "minimal-manifest.json"), defaultAs: "manifest" },
  ],
  runCase,
  heapLimitMiB: HEAP_LIMIT_MIB,
  timeoutMs: 20_000,
});

beforeAll(() => child.build(), 60_000);

afterAll(() => {
  child.remove();
});

describe(`the definition check's lists in a Node child under --max-old-space-size=${HEAP_LIMIT_MIB}`, () => {
  test("an engine list of the longest length is refused at the list, in a bounded child", async () => {
    expect(await child.run<ChildReport>("engines")).toEqual({
      name: "engines",
      refusals: [{ rule: "manifest-unreadable", pointer: "/manifest/engines" }],
    });
  }, 30_000);

  test("a maintenance list of the longest length is refused at the list, in a bounded child", async () => {
    expect(await child.run<ChildReport>("maintenance")).toEqual({
      name: "maintenance",
      refusals: [{ rule: "manifest-unreadable", pointer: "/manifest/engines/0/facets/maintenance" }],
    });
  }, 30_000);

  test("a maintenance specs list of the longest length is refused at the list, in a bounded child", async () => {
    expect(await child.run<ChildReport>("maintenanceSpecs")).toEqual({
      name: "maintenanceSpecs",
      refusals: [{ rule: "manifest-unreadable", pointer: "/manifest/engines/0/facets/maintenanceSpecs" }],
    });
  }, 30_000);

  test("an agent readings list of the longest length is refused at the list, in a bounded child", async () => {
    expect(await child.run<ChildReport>("agentReadings")).toEqual({
      name: "agentReadings",
      refusals: [{ rule: "manifest-unreadable", pointer: "/manifest/engines/0/facets/agentReadings" }],
    });
  }, 30_000);
});
