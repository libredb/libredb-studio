/**
 * The published package's governance boundary (spec 9.4, 9.5).
 *
 * Governance runs only in the standalone server: `src/instrumentation.ts` starts it, and nothing in
 * `@libredb/studio` may reach its runtime, which opens a `pg` pool of its own, reads a keyring file and holds the
 * snapshot of a governance source, nor `src/lib/query-events`, which a later slice turns into a sink on the same
 * source. The one governance module a package module may reach is `src/lib/governance/config.ts`, the reader of the
 * governance switch and its environment, which imports nothing but the environment.
 *
 * Asserted on the source graph from the six `tsup` entry points, as `tests/unit/agent-package-boundary.test.ts`
 * does and for the reasons its header gives: `dist/` does not exist during `bun run test`, and the graph is what the
 * bundler walks. Two walks are taken, one over value edges (what lands in `dist/*.mjs`) and one over value and type
 * edges, transitively (what the declaration rollup can pull into `dist/*.d.ts`). The scanner reads double-quoted
 * specifiers only, which `bun run format` guarantees, and dynamic `import("…")` edges count as values.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

// Anchored to this file, not to process.cwd().
const ROOT = path.resolve(import.meta.dir, "../..");
const SRC = path.join(ROOT, "src");

interface Edge {
  readonly specifier: string;
  /** `import type` / `export type`: erased before anything is emitted. */
  readonly typeOnly: boolean;
}

/** A specifier quoted inside a comment is not an edge; line comments go only when they own the line. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function edgesOf(source: string): Edge[] {
  const stripped = stripComments(source);
  const edges: Edge[] = [];
  for (const match of stripped.matchAll(/(?:^|[\n;])\s*(import|export)\s+(type\s+)?(?:[^"';]*?\bfrom\s*)?"([^"]+)"/g)) {
    edges.push({ specifier: match[3], typeOnly: match[2] !== undefined });
  }
  for (const match of stripped.matchAll(/\b(?:import|require)\s*\(\s*"([^"]+)"/g)) {
    edges.push({ specifier: match[1], typeOnly: false });
  }
  return edges;
}

/** A specifier as the `@/` alias plugin of `tsup.config.ts` resolves it, or null for a package or a stylesheet. */
function resolveToSource(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The entry points `tsup` builds, read from its config rather than restated. */
function tsupEntryPoints(): string[] {
  const config = fs.readFileSync(path.join(ROOT, "tsup.config.ts"), "utf8");
  const block = /entry:\s*\{([^}]*)\}/.exec(config)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => path.join(ROOT, match[1]));
}

interface Walk {
  readonly reached: ReadonlySet<string>;
  /** `@/` or relative specifiers that resolved to no file: a walk that stopped early. */
  readonly unresolved: readonly string[];
}

const relative = (file: string): string => path.relative(ROOT, file).split(path.sep).join("/");

function walkFrom(seeds: readonly string[], edgeKinds: "only-values" | "values-and-types"): Walk {
  const reached = new Set<string>();
  const unresolved: string[] = [];
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const edge of edgesOf(fs.readFileSync(file, "utf8"))) {
      if (edge.typeOnly && edgeKinds === "only-values") continue;
      const resolved = resolveToSource(edge.specifier, file);
      if (resolved !== null) queue.push(resolved);
      else if (
        (edge.specifier.startsWith(".") || edge.specifier.startsWith("@/")) &&
        !edge.specifier.endsWith(".css")
      ) {
        unresolved.push(`${relative(file)} → ${edge.specifier}`);
      }
    }
  }
  return { reached, unresolved };
}

/** The governance reader every module may use: the switch and its environment, nothing else. */
const GOVERNANCE_CONFIG = "src/lib/governance/config.ts";

/** A module of the governance runtime, or of the query events that write to the same governance source. */
function isGovernanceRuntime(file: string): boolean {
  const name = relative(file);
  return (
    (name.startsWith("src/lib/governance/") && name !== GOVERNANCE_CONFIG) || name.startsWith("src/lib/query-events/")
  );
}

const entries = tsupEntryPoints();
const emitted = walkFrom(entries, "only-values");
const declared = walkFrom(entries, "values-and-types");

describe("the scanner reads what it claims to read", () => {
  test("the entry points come from tsup's own config", () => {
    expect(entries.map(relative).sort()).toEqual([
      "src/exports/components.ts",
      "src/exports/index.ts",
      "src/exports/providers.ts",
      "src/exports/security.ts",
      "src/exports/types.ts",
      "src/exports/workspace.ts",
    ]);
  });

  test("the graph is walked deeply and completely, in both walks", () => {
    expect([...emitted.reached].map(relative)).toContain("src/lib/db/factory.ts");
    expect(emitted.reached.size).toBeGreaterThan(50);
    expect(declared.reached.size).toBeGreaterThanOrEqual(emitted.reached.size);
    expect(emitted.unresolved).toEqual([]);
    expect(declared.unresolved).toEqual([]);
  });

  test("the predicate recognises the governance runtime and the query events, and lets the config reader through", () => {
    for (const runtime of [
      "src/lib/governance/snapshot.ts",
      "src/lib/governance/db.ts",
      "src/lib/governance/state.ts",
      "src/lib/governance/keyring.ts",
      "src/lib/query-events/redact.ts",
    ]) {
      expect(isGovernanceRuntime(path.join(ROOT, runtime))).toBe(true);
    }
    expect(isGovernanceRuntime(path.join(ROOT, GOVERNANCE_CONFIG))).toBe(false);
    expect(isGovernanceRuntime(path.join(ROOT, "src/lib/db/factory.ts"))).toBe(false);
  });

  test("a walk from the server's boot hook reaches the governance pool through its dynamic imports", () => {
    // The positive control: the boot hook starts governance through `import("…")` only, so a scanner that missed
    // dynamic edges, or stopped one hop early, would find nothing here and pass the boundary below vacuously.
    const boot = walkFrom([path.join(SRC, "instrumentation.ts")], "only-values");

    expect([...boot.reached].filter(isGovernanceRuntime).map(relative)).toEqual(
      expect.arrayContaining([
        "src/lib/governance/start.ts",
        "src/lib/governance/snapshot.ts",
        "src/lib/governance/db.ts",
      ]),
    );
  });
});

describe("the published package", () => {
  test("no tsup entry point reaches the governance runtime or src/lib/query-events", () => {
    expect([...emitted.reached].filter(isGovernanceRuntime).map(relative)).toEqual([]);
    expect([...declared.reached].filter(isGovernanceRuntime).map(relative)).toEqual([]);
  });
});
