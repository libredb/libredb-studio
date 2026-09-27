import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * `containerPathShapes` as every shipped type-id declares it (#1147).
 *
 * The expectation is transcribed from the issue's table and never derived from the build.
 * The fifteen providers that call `assertContainerPathShape` declare a value explicitly; the
 * four that call no kernel check and declare no container level (elasticsearch, opensearch,
 * prometheus, kafka) leave it absent, which the kernel reads as `exact`: the same `[]`-only set
 * their own `container.length !== 0` checks accept.
 *
 * It reads the field DIRECTLY on purpose. A census of the declaration must tell absent from
 * `exact`, and `acceptedContainerShapes()` collapses the two, which is its job and not this
 * file's. A Record, so a new member of `DatabaseType` is a compile error here rather than an
 * engine this census silently skips.
 *
 * Nothing here connects: `createDatabaseProvider` builds each provider from
 * `CENSUS_CONNECTION`'s unconnected configurations, which is what `POST /api/db/provider-meta`
 * does before it serialises `getCapabilities()`.
 */
const EXPECTED_CONTAINER_PATH_SHAPES: Readonly<
  Record<DatabaseType, NonNullable<ProviderCapabilities["containerPathShapes"]> | "absent">
> = Object.freeze({
  postgres: "exact",
  mysql: "exact",
  sqlite: "exact",
  libsql: "exact",
  oracle: "exact",
  clickhouse: "exact",
  druid: "exact",
  cassandra: "exact",
  mongodb: "exact",
  redis: "exact",
  libredb: "exact",
  duckdb: "prefixes",
  mssql: "prefixes",
  trino: "prefixes",
  couchbase: "prefixes",
  elasticsearch: "absent",
  opensearch: "absent",
  prometheus: "absent",
  kafka: "absent",
});

const TYPES = Object.keys(EXPECTED_CONTAINER_PATH_SHAPES) as DatabaseType[];

describe("containerPathShapes (#1147)", () => {
  test.each(TYPES)("%s declares the container path shapes the issue's table names", async (type) => {
    const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
    const declared = Object.hasOwn(capabilities, "containerPathShapes") ? capabilities.containerPathShapes : "absent";
    expect(declared).toBe(EXPECTED_CONTAINER_PATH_SHAPES[type]);
  });

  test("the fifteen that declare a value are pinned by name", () => {
    expect(TYPES.filter((type) => EXPECTED_CONTAINER_PATH_SHAPES[type] !== "absent").sort()).toEqual([
      "cassandra",
      "clickhouse",
      "couchbase",
      "druid",
      "duckdb",
      "libredb",
      "libsql",
      "mongodb",
      "mssql",
      "mysql",
      "oracle",
      "postgres",
      "redis",
      "sqlite",
      "trino",
    ]);
  });
});

// Anchored to this file rather than to `process.cwd()`, because a runner that launched this
// file from anywhere but the repository root would otherwise read nothing.
const ROOT = path.resolve(import.meta.dir, "../../..");
const SRC = path.join(ROOT, "src");
const FIELD = "containerPathShapes";

/** `path.relative` spells the separator by HOST; the pinned list below is POSIX-spelled. */
const repoRelative = (file: string): string => path.relative(ROOT, file).split(path.sep).join("/");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/**
 * How many times this source READS the field, in any spelling.
 *
 * Parsed rather than scanned, so comments are trivia and never count. A read is a property
 * access by that name, a destructuring that binds it (renamed or not), or the name as a string
 * outside a type position and outside a quoted declaration key; the last covers an element
 * access, an `in` test, `Object.hasOwn` and `Reflect.get`, and it counts an element access
 * through its argument so nothing is counted twice. The interface member in `types.ts` and the
 * `containerPathShapes:` keys of the providers' literals are declarations, not reads.
 */
function countReads(file: string, source: string): number {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  let reads = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === FIELD) reads += 1;
    else if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) && key.text === FIELD) reads += 1;
      else if (ts.isStringLiteral(key) && key.text === FIELD) reads += 1;
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === FIELD) {
      const parent = node.parent;
      const typePosition = ts.isLiteralTypeNode(parent);
      const declarationKey =
        (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)) &&
        parent.name === node;
      // A quoted destructuring key is counted once, by its binding element above.
      const bindingKey = ts.isBindingElement(parent) && parent.propertyName === node;
      if (!typePosition && !declarationKey && !bindingKey) reads += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return reads;
}

describe("the declaration has one reader (#1147)", () => {
  test("the detector counts every spelling of a read, and nothing that is not one", () => {
    const reads = [
      "const a = c.containerPathShapes;",
      "const b = c?.containerPathShapes;",
      'const e = c["containerPathShapes"];',
      'const f = "containerPathShapes" in c;',
      'const g = Object.hasOwn(c, "containerPathShapes");',
      "const h = Reflect.get(c, `containerPathShapes`);",
      "const { containerPathShapes } = c;",
      "const { containerPathShapes: renamed } = c;",
      'const { "containerPathShapes": quoted } = c;',
    ].join("\n");
    expect(countReads("reads.ts", reads)).toBe(9);

    const nonReads = [
      'type P = ProviderCapabilities["containerPathShapes"];',
      'const d = { containerPathShapes: "exact" };',
      'const q = { "containerPathShapes": "exact" };',
      'interface X { containerPathShapes?: "exact" }',
      "// c.containerPathShapes",
    ].join("\n");
    expect(countReads("non-reads.ts", nonReads)).toBe(0);
  });

  test("object-kinds.ts is the only file under src/ that reads the field, and it reads it once", () => {
    const readers: Array<[string, number]> = [];
    for (const file of sourceFiles(SRC)) {
      const count = countReads(file, fs.readFileSync(file, "utf8"));
      if (count > 0) readers.push([repoRelative(file), count]);
    }
    expect(readers).toEqual([["src/lib/db/object-kinds.ts", 1]]);
  });
});
