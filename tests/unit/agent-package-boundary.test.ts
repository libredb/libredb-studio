/**
 * The published package's agent boundary (#329 T12).
 *
 * The milestone's sixth acceptance item says the agent surface is absent from the
 * embedded shell and the published build gains none of the agent runtime's types.
 * `tests/unit/agent-dependency-boundary.test.ts` already pins the DEPENDENCY half
 * (the runtime packages never reach a consumer's install). This file pins the
 * MODULE half: what the six `tsup` entry points can actually pull in.
 *
 * It is asserted on the source graph rather than on `dist/`, because `dist/` is
 * built by `bun run build:lib` and does not exist during `bun run test` — a scan
 * that skips when the directory is missing would pass vacuously in exactly the run
 * that matters. The graph is the thing the bundler walks, so walking it here gives
 * the same answer without depending on a build artifact. The emitted `.d.ts` claim
 * is additionally verified against a real build in the task's gate run
 * (`build:lib` + `attw`).
 *
 * Two walks are taken, because code and declarations are reached differently: one
 * over value edges (what lands in `dist/*.mjs`) and one over value AND type edges,
 * transitively (what the `dts` rollup can pull into `dist/*.d.ts`).
 *
 * The scanner reads double-quoted specifiers only, which is exact here rather than
 * lucky: `biome.json` sets `quoteStyle: "double"` and `bun run format` is a
 * mandatory gate, so a single-quoted specifier cannot survive a commit. A
 * template-literal dynamic import (`` import(`@/…/${name}`) `` ) would be missed —
 * there is none in `src/`, and it would defeat the bundler's own static analysis
 * too, so it is a limit worth knowing rather than one worth coding around. The
 * same goes for comment stripping: a `/*` sequence inside a string literal would
 * blank the edges after it, which no file in `src/` contains today.
 *
 * One honest caveat, so nobody reads these assertions as broader than they are:
 * `BottomPanel` itself ships in `dist/workspace.mjs`, and it carries the branch
 * that renders an agent run's provenance badge (#329 T11). That branch is inert
 * there — the prop is optional, `StudioWorkspace` never passes it, and no entry
 * point exports `BottomPanel` for a host to reach directly. What the package gains
 * is that dormant markup, not an agent module, an agent type, or a runtime package,
 * and it is those three that the tests below pin.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKSPACE_FEATURES } from "@/workspace/types";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

// ---------------------------------------------------------------------------
// Reading the import graph
// ---------------------------------------------------------------------------

interface Edge {
  /** The specifier as written, e.g. `@/components/studio/index`. */
  specifier: string;
  /** `import type` / `export type` — erased before anything is emitted. */
  typeOnly: boolean;
  /** An `export … from` edge: what it names becomes part of the entry's surface. */
  isExport: boolean;
}

/**
 * Comments are stripped first: a specifier quoted inside a comment is not an
 * edge, and this file's whole job is to be exact about which edges exist.
 * Line comments are stripped only when they own the whole line, so a `https://`
 * inside a string survives.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function edgesOf(source: string): Edge[] {
  const stripped = stripComments(source);
  const edges: Edge[] = [];

  // `import ... from "x"`, `export ... from "x"`, `import "x"`, with an optional
  // leading `type` keyword marking the statement as erased.
  for (const match of stripped.matchAll(/(?:^|[\n;])\s*(import|export)\s+(type\s+)?(?:[^"';]*?\bfrom\s*)?"([^"]+)"/g)) {
    edges.push({ specifier: match[3], typeOnly: match[2] !== undefined, isExport: match[1] === "export" });
  }
  // Dynamic and CJS forms are always value edges, and never re-exports: a lazy
  // `import("…")` pulls the module into the bundle just as surely as a static one.
  for (const match of stripped.matchAll(/\b(?:import|require)\s*\(\s*"([^"]+)"/g)) {
    edges.push({ specifier: match[1], typeOnly: false, isExport: false });
  }
  return edges;
}

/**
 * Resolve a specifier to a file under `src/`, mirroring what the `@/` alias plugin
 * in `tsup.config.ts` does. Returns null for a bare package, a stylesheet, or
 * anything that does not resolve to a source file — bare specifiers are handled
 * separately, since the runtime packages are what matters about them.
 */
function resolveToSource(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }

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

/** The entry points `tsup` builds, read from the config rather than restated. */
function tsupEntryPoints(): string[] {
  const config = fs.readFileSync(path.join(ROOT, "tsup.config.ts"), "utf8");
  const block = /entry:\s*\{([^}]*)\}/.exec(config)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => path.join(ROOT, match[1]));
}

interface Walk {
  /** Source files the walk reached. */
  reached: Set<string>;
  /** Bare package specifiers imported by a reached file. */
  packages: Set<string>;
  /** `@/` or relative specifiers that resolved to no file — a truncated walk. */
  unresolved: string[];
  /** Type-only edges out of reached files, as `from → specifier` pairs. */
  typeEdges: { from: string; specifier: string }[];
}

/**
 * Walk the graph from tsup's entry points. Two walks are taken over the same
 * code, because the emitted JavaScript and the emitted declarations are reached
 * differently:
 *
 * - `"only-values"` follows value edges alone — what ends up in `dist/*.mjs`.
 * - `"values-and-types"` follows type edges too, transitively — what `dts`
 *   rollup can pull into `dist/*.d.ts`. A type edge is erased from the emitted
 *   JavaScript, but the type itself is not erased from the declarations, and a
 *   module reached only through a type edge has type edges of its own.
 */
function walkFrom(edgeKinds: "only-values" | "values-and-types"): Walk {
  const reached = new Set<string>();
  const packages = new Set<string>();
  const unresolved: string[] = [];
  const typeEdges: { from: string; specifier: string }[] = [];
  const queue = tsupEntryPoints();

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (reached.has(file)) continue;
    reached.add(file);

    for (const edge of edgesOf(fs.readFileSync(file, "utf8"))) {
      if (edge.typeOnly) typeEdges.push({ from: file, specifier: edge.specifier });
      if (edge.typeOnly && edgeKinds === "only-values") continue;

      const resolved = resolveToSource(edge.specifier, file);
      if (resolved !== null) {
        queue.push(resolved);
      } else if (edge.specifier.startsWith(".") || edge.specifier.startsWith("@/")) {
        // An internal specifier that resolves to nothing means the walk stopped
        // early somewhere it should not have — a silent hole, so it is surfaced.
        if (!edge.specifier.endsWith(".css")) unresolved.push(`${relative(file)} → ${edge.specifier}`);
      } else {
        packages.add(edge.specifier);
      }
    }
  }

  return { reached, packages, unresolved, typeEdges };
}

/**
 * The modules an entry point re-exports, following `export … from` chains through
 * barrels. A module in here is one a host can import by name. The converse is
 * narrower than it looks: a barrel that imports a symbol and then exports the
 * binding separately (`import { X } from "…"; export { X };`) is not followed, so
 * this is a check on `export … from` chains rather than on every way a name could
 * escape. There is no such re-export in `src/` today.
 */
function reExportClosure(): Set<string> {
  const exported = new Set<string>();
  const queue = tsupEntryPoints();

  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const edge of edgesOf(fs.readFileSync(file, "utf8"))) {
      if (!edge.isExport) continue;
      const resolved = resolveToSource(edge.specifier, file);
      if (resolved === null || exported.has(resolved)) continue;
      exported.add(resolved);
      queue.push(resolved);
    }
  }
  return exported;
}

const relative = (file: string): string => path.relative(ROOT, file);

/** What the bundler emits as code. */
const emitted = walkFrom("only-values");
/** What the declaration rollup can see — a superset, reached through types too. */
const declared = walkFrom("values-and-types");

/**
 * An agent module by path: everything under an `agent/` directory, plus the
 * loose files this milestone added beside their neighbours
 * (`src/lib/api/agent-run-access.ts`, `src/hooks/use-agent-capability.ts`).
 * Path-shaped rather than a hand-listed inventory, so a file added later is
 * covered without anyone remembering to list it: any path segment that STARTS
 * with `agent` or `use-agent`, case-insensitively, so `src/lib/agent.ts` and an
 * `AgentRail.tsx` filed outside an `agent/` directory both match. Deliberately
 * over-broad — a false positive here is a conversation, a false negative is the
 * hole this file exists to close — and it costs nothing today: no module under
 * `src/` matches it except the agent modules themselves.
 */
function isAgentModule(file: string): boolean {
  return /(^|\/)(agent|use-agent)/i.test(relative(file));
}

// ---------------------------------------------------------------------------
// The scanner itself, before anything is concluded from it
// ---------------------------------------------------------------------------

describe("the scanner reads what it claims to read", () => {
  test("every import form is seen, and its type-ness recorded", () => {
    // A positive control: without it, a broken pattern makes every assertion
    // below pass by matching nothing at all.
    const fixture = [
      '// import { Ignored } from "@/lib/agent/runtime";',
      '/* import { AlsoIgnored } from "@/lib/agent/tools"; */',
      'import { Real } from "@/lib/agent/config";',
      'import type { Erased } from "@/lib/agent/types";',
      'export type { AlsoErased } from "@/lib/agent/types";',
      'export { Re } from "./neighbour";',
      'import "./side-effect.css";',
      'const lazy = await import("@/lib/agent/run-store");',
      'const cjs = require("workflow");',
      'import {\n  Multi,\n  Line,\n} from "@/components/ui/resizable";',
    ].join("\n");

    expect(edgesOf(fixture)).toEqual([
      { specifier: "@/lib/agent/config", typeOnly: false, isExport: false },
      { specifier: "@/lib/agent/types", typeOnly: true, isExport: false },
      { specifier: "@/lib/agent/types", typeOnly: true, isExport: true },
      { specifier: "./neighbour", typeOnly: false, isExport: true },
      { specifier: "./side-effect.css", typeOnly: false, isExport: false },
      { specifier: "@/components/ui/resizable", typeOnly: false, isExport: false },
      { specifier: "@/lib/agent/run-store", typeOnly: false, isExport: false },
      { specifier: "workflow", typeOnly: false, isExport: false },
    ]);
  });

  test("the entry points come from tsup's own config", () => {
    expect(tsupEntryPoints().map(relative).sort()).toEqual([
      "src/exports/components.ts",
      "src/exports/index.ts",
      "src/exports/providers.ts",
      "src/exports/security.ts",
      "src/exports/types.ts",
      "src/exports/workspace.ts",
    ]);
  });

  test("the graph is walked deeply, not just one level", () => {
    // `StudioWorkspace` is two hops from `src/exports/workspace.ts` and
    // `BottomPanel` is three, so seeing them proves the walk recurses.
    const reached = [...emitted.reached].map(relative);
    expect(reached).toContain("src/workspace/StudioWorkspace.tsx");
    expect(reached).toContain("src/components/studio/BottomPanel.tsx");
    expect(emitted.reached.size).toBeGreaterThan(50);
  });

  test("the type walk reaches strictly more than the value walk", () => {
    // Containment holds by construction — same seeds, a superset of edges — so it
    // is documentation. What is actually checked is that following type edges
    // finds modules the value walk never sees, `hydration.ts` among them: without
    // that, the declaration assertions below would be reading the value graph
    // while claiming to read a larger one.
    for (const file of emitted.reached) expect(declared.reached.has(file)).toBe(true);
    expect(declared.reached.size).toBeGreaterThan(emitted.reached.size);
    expect([...declared.reached].map(relative)).toContain("src/components/agent/hydration.ts");
    expect([...emitted.reached].map(relative)).not.toContain("src/components/agent/hydration.ts");
  });

  test("no internal specifier is left unresolved, in either walk", () => {
    // An unresolvable `@/…` or `./…` is a walk that stopped early — the exact
    // shape of hole this file exists to rule out, so it fails rather than
    // silently shrinking the graph.
    expect(emitted.unresolved).toEqual([]);
    expect(declared.unresolved).toEqual([]);
  });

  test("an agent module is recognised wherever it lives", () => {
    for (const agentFile of [
      "src/lib/agent/runtime.ts",
      "src/components/agent/AgentRail.tsx",
      "src/app/api/agent/runs/route.ts",
      "src/lib/api/agent-run-access.ts",
      "src/hooks/use-agent-capability.ts",
      // Filed beside its neighbours instead of under `agent/`, and capitalized:
      // the shape the directory-based half of this predicate would miss.
      "src/components/studio/AgentRail.tsx",
      "src/lib/agent.ts",
    ]) {
      expect(isAgentModule(path.join(ROOT, agentFile))).toBe(true);
    }
    for (const ordinaryFile of [
      "src/components/studio/BottomPanel.tsx",
      "src/lib/db/operations/execution.ts",
      "src/workspace/StudioWorkspace.tsx",
    ]) {
      expect(isAgentModule(path.join(ROOT, ordinaryFile))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe("no agent module is reachable from the published package", () => {
  test("no entry point pulls agent CODE into the bundle", () => {
    expect([...emitted.reached].filter(isAgentModule).map(relative)).toEqual([]);
  });

  test("the only agent module the DECLARATIONS can see is the hydration type", () => {
    /**
     * Transitive, not one hop: a module reached only through a type edge has type
     * edges of its own, and the declaration rollup follows them, so pinning depth
     * one would leave a deeper `export type { … } from "@/lib/agent/types"` free
     * to ship an agent type in `dist/*.d.ts` with this file green.
     *
     * The one that is here is `BottomPanel` naming `AgentArtifactHydration` to
     * type an optional prop the standalone shell passes and the embedded shell
     * never does (#329 T11). It is pinned as an inventory of one rather than
     * allowed as a category: a second one is a place an agent type could reach
     * the published declarations, and it should be looked at with a build in hand
     * rather than waved through by a rule written today.
     */
    expect([...declared.reached].filter(isAgentModule).map(relative)).toEqual(["src/components/agent/hydration.ts"]);
  });

  test("the edge into it is the one the bottom panel declares, and it is type-only", () => {
    const agentTypeEdges = declared.typeEdges
      .filter(({ specifier, from }) => {
        const resolved = resolveToSource(specifier, from);
        return resolved !== null && isAgentModule(resolved);
      })
      .map(({ from, specifier }) => `${relative(from)} → ${specifier}`);

    expect(agentTypeEdges).toEqual(["src/components/studio/BottomPanel.tsx → @/components/agent/hydration"]);
  });

  test("no entry point exports the bottom panel, so a host cannot reach its badge", () => {
    // This is what makes the dormant provenance markup in `dist/workspace.mjs`
    // unreachable rather than merely unused, and it is also why `BottomPanel`'s
    // props — the one place an agent type is named — stay out of the emitted
    // declarations. Followed through barrels rather than read off the entry
    // files, because a barrel re-export names nothing an entry file's text shows.
    const exported = [...reExportClosure()].map(relative);

    expect(exported).not.toContain("src/components/studio/BottomPanel.tsx");
    expect(exported).not.toContain("src/components/studio/index.ts");
    // The closure is proved to walk barrels at all: `SchemaExplorer` is exported
    // through one, so its module being here means an unnamed re-export would be.
    expect(exported).toContain("src/components/schema-explorer/index.ts");
  });

  test("no reachable module imports the agent runtime's packages, as code or as types", () => {
    // The dependency test proves they are not installed on a consumer; this
    // proves nothing in the published graph would want them if they were. Read
    // from the type walk as well, because `import type { … } from "ai"` emits a
    // type import into the declarations while emitting no code at all. Subpaths
    // count: `ai/mcp` is the same package arriving by another name.
    const isRuntimePackage = (name: string): boolean =>
      /^(ai|workflow)(\/|$)/.test(name) || name.startsWith("@workflow/") || name.startsWith("@ai-sdk/");

    expect([...emitted.packages].filter(isRuntimePackage)).toEqual([]);
    expect([...declared.packages].filter(isRuntimePackage)).toEqual([]);
  });
});

describe("the embedded workspace declares no agent capability", () => {
  /**
   * Deliberate, and the reason is in `src/workspace/types.ts` beside the fields:
   * Phase 1 is standalone-only, so an agent flag here would be declared and never
   * read — the state the deprecated `inlineEditing` note records this repository
   * as avoiding (#288). Pinned as an exact key set so adding one goes red here and
   * sends the reader to that note.
   *
   * Nine since #331 T2: `ai` gated the NL2SQL panel's open state and nothing else,
   * so deleting the panel left the flag reading nowhere. It was removed rather than
   * deprecated — the same note in `types.ts` says why it is not the `inlineEditing`
   * case — which is a breaking change for any consumer of the published package that
   * sets the flag.
   */
  test("the published feature flags are exactly the nine that exist today", () => {
    expect(Object.keys(DEFAULT_WORKSPACE_FEATURES).sort()).toEqual([
      "charts",
      "codeGenerator",
      "connectionManagement",
      "dataImport",
      "dataMasking",
      "inlineEditing",
      "schemaDiagram",
      "testDataGenerator",
      "transactions",
    ]);
  });
});
