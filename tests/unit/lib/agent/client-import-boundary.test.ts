/**
 * The modules a browser bundle holds must not reach server code (E2). The manifest, the posture, the engine list and
 * the client components that read them are walked through their VALUE imports (type-only imports are erased), and no
 * file reached may be a server module or a Node builtin.
 *
 * A server module is a Node or Bun builtin, one of the agent's named server modules, the provider factory, a
 * provider's `index.ts`, or a database driver package. Small constant files under `src/lib/db/providers/` (a host
 * pattern, a limit, a route table) are deliberately NOT on that list: the posture and the rail read them today, and
 * they import nothing a browser cannot hold. What matters is that no walk ever reaches the module that opens a
 * connection.
 *
 * The scanner mirrors `tests/unit/agent-package-boundary.test.ts`: double-quoted specifiers only (`biome.json` sets
 * `quoteStyle: "double"`), comments stripped first, and a statement with a leading `type` keyword treated as erased.
 * It also treats `import { type A, type B } from "x"` as erased, since every name in that list is a type.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const ENTRIES = [
  "src/lib/agent/agent-manifest.ts",
  "src/lib/agent/posture.ts",
  "src/lib/agent/engine-support.ts",
  "src/components/agent/AgentRail.tsx",
  "src/components/agent/SafetyStrip.tsx",
  "src/components/agent/ConsentCard.tsx",
];
/** The database driver packages a provider opens a connection with. */
const DRIVERS = [
  "pg",
  "mysql2",
  "mssql",
  "oracledb",
  "mongodb",
  "ioredis",
  "cassandra-driver",
  "better-sqlite3",
  "@duckdb/node-api",
  "neo4j-driver-lite",
  "db2-node",
  "@platformatic/kafka",
  "@grpc/grpc-js",
  "ssh2",
  "node-opcua-client",
  "@libredb/libredb",
];
const SERVER = [
  /^node:/,
  /^bun:/,
  /src\/lib\/agent\/(tools|investigation|statement-languages|repair-ledger|run-store|run-service|runtime)\.ts$/,
  /src\/lib\/db\/factory\.ts$/,
  /src\/lib\/db\/providers\/.*\/index\.tsx?$/,
  new RegExp(`^(${DRIVERS.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})(/|$)`),
];

/** The value specifiers one source file imports or re-exports. */
function valueSpecifiers(source: string): string[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const specifiers: string[] = [];
  for (const match of stripped.matchAll(/(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?([^"';]*?\bfrom\s*)?"([^"]+)"/g)) {
    if (match[1] !== undefined) continue;
    const named = /\{([^}]*)\}/.exec(match[2] ?? "");
    const names = named?.[1]
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const clauseHasDefault = /^\s*(import|export)?\s*[\w$]+\s*(,|from)/.test(match[2] ?? "");
    if (names !== undefined && names.length > 0 && !clauseHasDefault && names.every((name) => name.startsWith("type ")))
      continue;
    specifiers.push(match[3]);
  }
  for (const match of stripped.matchAll(/\b(?:import|require)\s*\(\s*"([^"]+)"/g)) specifiers.push(match[1]);
  return specifiers;
}

function resolveSource(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(ROOT, "src", specifier.slice(2))
    : path.resolve(path.dirname(path.join(ROOT, fromFile)), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    base,
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return path.relative(ROOT, candidate);
  }
  return null;
}

/**
 * Every source file and every bare package a value walk from `entry` reaches. Packages are listed but not followed:
 * what a package does inside itself is not this codebase's to decide, and the driver packages are named directly.
 */
function walk(entry: string): string[] {
  const reached = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const specifier of valueSpecifiers(readFileSync(path.join(ROOT, file), "utf8"))) {
      if (specifier.startsWith("@/") || specifier.startsWith(".")) {
        const resolved = resolveSource(specifier, file);
        // A specifier that resolves nowhere would silently truncate the walk, so it fails loudly instead.
        if (resolved === null) {
          if (specifier.endsWith(".css")) continue;
          throw new Error(`${file} imports ${specifier}, which resolves to no source file`);
        }
        queue.push(resolved);
      } else {
        reached.add(specifier);
      }
    }
  }
  return [...reached];
}

describe("client modules reach no server module", () => {
  test.each(ENTRIES)("%s", (entry) => {
    const reached = walk(entry);
    expect(reached.filter((file) => SERVER.some((pattern) => pattern.test(file)))).toEqual([]);
  });

  test("the walker sees a server import when one is there, the control", () => {
    expect(walk("src/lib/agent/repair-ledger.ts")).toContain("node:crypto");
  });

  test("the walker follows value edges into the factory and a driver, the control", () => {
    const reached = walk("src/lib/db/factory.ts");
    expect(reached).toContain("src/lib/db/factory.ts");
    expect(reached).toContain("pg");
  });

  test("a type-only edge is erased, in both of its spellings", () => {
    expect(valueSpecifiers('import type { A } from "x";')).toEqual([]);
    expect(valueSpecifiers('import { type A, type B } from "x";')).toEqual([]);
    expect(valueSpecifiers('export type { A } from "x";')).toEqual([]);
    expect(valueSpecifiers('import { type A, B } from "x";')).toEqual(["x"]);
    expect(valueSpecifiers('import D, { type A } from "x";')).toEqual(["x"]);
    expect(valueSpecifiers('import "x";')).toEqual(["x"]);
  });
});
