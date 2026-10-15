/**
 * The proxy's governance boundary (docs/GOVERNANCE.md#runtime-settings).
 *
 * Route handlers apply runtime settings and the proxy never does, so the module graph of `src/proxy.ts` must not reach
 * the settings store, the governance pool, the snapshot loader or `pg`. The proxy may read the governance switch
 * (`src/lib/governance/config.ts`), which imports nothing but the environment.
 *
 * Asserted on the source graph with the scanner of tests/unit/governance-package-boundary.test.ts: it reads
 * double-quoted specifiers only, which `bun run format` guarantees, and dynamic `import("…")` edges count. Package
 * specifiers are kept, so an edge to `pg` is seen. Only value edges are walked, because what the proxy loads at run
 * time is the question: an `import type` or `export type` is erased before anything runs, and over such edges the
 * proxy's types do reach the storage and database providers, which import `pg` for the routes that use them.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

// Anchored to this file, not to process.cwd().
const ROOT = path.resolve(import.meta.dir, "../..");
const SRC = path.join(ROOT, "src");

/** A specifier quoted inside a comment is not an edge; line comments go only when they own the line. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The specifiers of every value edge: static imports and re-exports that are not type-only, and dynamic imports. */
function valueSpecifiersOf(source: string): string[] {
  const stripped = stripComments(source);
  return [
    ...[...stripped.matchAll(/(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\bfrom\s*)?"([^"]+)"/g)]
      .filter((match) => match[1] === undefined)
      .map((match) => match[2]),
    ...[...stripped.matchAll(/\b(?:import|require)\s*\(\s*"([^"]+)"/g)].map((match) => match[1]),
  ];
}

/** A specifier as the `@/` alias resolves it, or null for a package or a stylesheet. */
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

const relative = (file: string): string => path.relative(ROOT, file).split(path.sep).join("/");

interface Walk {
  /** The source files reached, relative to the repository root. */
  readonly files: ReadonlySet<string>;
  /** The package specifiers imported anywhere on the way. */
  readonly packages: ReadonlySet<string>;
  /** `@/` or relative specifiers that resolved to no file: a walk that stopped early. */
  readonly unresolved: readonly string[];
}

function walkFrom(seed: string): Walk {
  const files = new Set<string>();
  const packages = new Set<string>();
  const unresolved: string[] = [];
  const queue = [path.join(ROOT, seed)];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (files.has(relative(file))) continue;
    files.add(relative(file));
    for (const specifier of valueSpecifiersOf(fs.readFileSync(file, "utf8"))) {
      const resolved = resolveToSource(specifier, file);
      if (resolved !== null) queue.push(resolved);
      else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
        if (!specifier.endsWith(".css")) unresolved.push(`${relative(file)} -> ${specifier}`);
      } else packages.add(specifier);
    }
  }
  return { files, packages, unresolved };
}

const FORBIDDEN_MODULES = [
  "src/lib/governance/settings.ts",
  "src/lib/governance/db.ts",
  "src/lib/governance/snapshot.ts",
];

const isPg = (specifier: string): boolean => specifier === "pg" || specifier.startsWith("pg/");

describe("the scanner reads what it claims to read", () => {
  test("a type-only edge is skipped and every other edge is kept", () => {
    const source = [
      'import type { A } from "./a";',
      'export type { B } from "./b";',
      'import { type C, d } from "./c";',
      'export { e } from "./e";',
      '// import "./commented";',
      'const f = await import("./f");',
    ].join("\n");

    expect(valueSpecifiersOf(source)).toEqual(["./c", "./e", "./f"]);
  });

  test("a walk from the snapshot loader reaches the settings store, the governance pool and pg", () => {
    // The positive control: a scanner that missed an edge kind would pass the boundary below vacuously.
    const loader = walkFrom("src/lib/governance/snapshot.ts");

    expect([...loader.files]).toEqual(expect.arrayContaining(FORBIDDEN_MODULES));
    expect([...loader.packages].some(isPg)).toBe(true);
    expect(loader.unresolved).toEqual([]);
  });
});

describe("src/proxy.ts", () => {
  test("src/proxy.ts never reaches the settings store, the governance pool or pg", () => {
    const proxy = walkFrom("src/proxy.ts");

    // The walk is deep and complete: it reaches the governance switch the proxy reads, and stops nowhere.
    expect([...proxy.files]).toContain("src/lib/governance/config.ts");
    expect(proxy.files.size).toBeGreaterThan(10);
    expect(proxy.unresolved).toEqual([]);
    expect(FORBIDDEN_MODULES.filter((module) => proxy.files.has(module))).toEqual([]);
    expect([...proxy.packages].filter(isPg)).toEqual([]);
  });
});
