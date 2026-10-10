import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";
import { typeIdsOfProviderFile } from "../../helpers/provider-directory-map";

/**
 * `containerPathShapes` as every shipped type-id declares it (#1147).
 *
 * The expectation is transcribed from the issue's table and never derived from the build.
 * The eighteen providers that call `assertContainerPathShape` declare a value explicitly; the
 * seven that call no kernel check and declare no container level (elasticsearch, opensearch,
 * prometheus, kafka, etcd, qdrant, influxdb3) leave it absent, which the kernel reads as `exact`: the same `[]`-only set
 * their own `container.length !== 0` checks accept. neo4j leaves it absent too: its one level is the
 * database, and `GraphBaseProvider` refuses any container but `[database]` with a check of its own,
 * which is the `exact` reading the kernel gives the absent field.
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
  db2: "exact",
  clickhouse: "exact",
  druid: "exact",
  cassandra: "exact",
  mongodb: "exact",
  redis: "exact",
  milvus: "exact",
  // Its one level is the database (InfluxDB spec I11), checked in influxql-provider.ts.
  influxdb: "exact",
  // Two levels, the catalog and the database, each path exactly as deep (design 2.4).
  databend: "exact",
  // No container level at all: buckets are object rows, so no path shape is declared.
  s3: "absent",
  libredb: "exact",
  duckdb: "prefixes",
  mssql: "prefixes",
  trino: "prefixes",
  couchbase: "prefixes",
  elasticsearch: "absent",
  opensearch: "absent",
  prometheus: "absent",
  kafka: "absent",
  etcd: "absent",
  neo4j: "absent",
  qdrant: "absent",
  // No container level (R16): its tables are top-level objects of the session database, the Qdrant shape.
  influxdb3: "absent",
  oxia: "absent",
});

const TYPES = Object.keys(EXPECTED_CONTAINER_PATH_SHAPES) as DatabaseType[];

describe("containerPathShapes (#1147)", () => {
  test.each(TYPES)("%s declares the container path shapes the issue's table names", async (type) => {
    const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
    const declared = Object.hasOwn(capabilities, "containerPathShapes") ? capabilities.containerPathShapes : "absent";
    expect(declared).toBe(EXPECTED_CONTAINER_PATH_SHAPES[type]);
  });
});

// Anchored to this file rather than to `process.cwd()`, because a runner that launched this
// file from anywhere but the repository root would otherwise read nothing.
const ROOT = path.resolve(import.meta.dir, "../../..");
const SRC = path.join(ROOT, "src");
const FIELD = "containerPathShapes";

/** `path.relative` spells the separator by HOST; the pinned list below is POSIX-spelled. */
const repoRelative = (file: string): string => path.relative(ROOT, file).split(path.sep).join("/");

/**
 * The extensions the scan reads: `.ts`, `.tsx` and `.js`, which are the script extensions src/
 * holds (`.js` for `src/exports/index.js`). src/ holds no `.mjs`, `.cjs`, `.mts` or `.cts` file,
 * so none of those is scanned; a first one needs adding here.
 */
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js"] as const;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(full);
  }
  return found;
}

/**
 * The type-id a provider file serves: its basename, or its directory's name when the provider is
 * split across modules (`trino/objects.ts` is trino), or, in a directory that serves two type-ids,
 * the one its declared table names (`timeseries/influxdb/influxql-objects.ts` is influxdb, InfluxDB
 * spec F1). A shared file of such a directory serves both, so it maps to the two names joined, which
 * no type-id is, and a caller there is reported as unmappable rather than credited to either.
 */
function providerTypeId(file: string): string {
  const mapped = typeIdsOfProviderFile(file);
  if (mapped !== null) return mapped.join(",");
  const base = path.basename(file, ".ts");
  return base === "objects" || base === "index" ? path.basename(path.dirname(file)) : base;
}

/**
 * Each file whose mapped name is no type-id this census knows, paired with that name.
 *
 * A caller in a third layout (`sql/helpers.ts`, `trino/statements.ts`) maps to a name no engine
 * has, and without this the only failure is a set mismatch that names neither the file nor why.
 */
function unknownTypeIds(files: readonly string[]): Array<[string, string]> {
  return files
    .map((file): [string, string] => [repoRelative(file), providerTypeId(file)])
    .filter(([, name]) => !(TYPES as readonly string[]).includes(name));
}

describe("the declaration follows the check (#1147)", () => {
  test("a caller in a layout the census cannot map is named with the name it mapped to", () => {
    const providers = path.join(SRC, "lib/db/providers");
    expect(
      unknownTypeIds([
        path.join(providers, "sql/trino/objects.ts"),
        path.join(providers, "sql/mssql.ts"),
        path.join(providers, "sql/helpers.ts"),
        path.join(providers, "sql/trino/statements.ts"),
        path.join(providers, "timeseries/influxdb/influxql-objects.ts"),
        path.join(providers, "timeseries/influxdb/client.ts"),
      ]),
    ).toEqual([
      ["src/lib/db/providers/sql/helpers.ts", "helpers"],
      ["src/lib/db/providers/sql/trino/statements.ts", "statements"],
      ["src/lib/db/providers/timeseries/influxdb/client.ts", "influxdb,influxdb3"],
    ]);
  });

  test("the type-ids that declare a value are exactly the engines whose providers call assertContainerPathShape", () => {
    // Read from the code on both sides: a new caller that declares nothing, or a declaration
    // left behind by a provider that stopped calling the check, fails here.
    const callerFiles = sourceFiles(path.join(SRC, "lib/db/providers")).filter((file) =>
      fs.readFileSync(file, "utf8").includes("assertContainerPathShape("),
    );
    expect(unknownTypeIds(callerFiles)).toEqual([]);
    const callers = callerFiles.map(providerTypeId).sort();
    const declaring = TYPES.filter((type) => EXPECTED_CONTAINER_PATH_SHAPES[type] !== "absent").sort();
    expect(callers).toHaveLength(19);
    expect(callers).toEqual(declaring);
  });
});

/**
 * How many times this source READS the field, in any spelling.
 *
 * Parsed rather than scanned, so comments are trivia and never count. A read is a property
 * access by that name, a destructuring that binds it (renamed or not), or the name as a string
 * outside a type position and outside a quoted declaration key; the last covers an element
 * access, an `in` test, `Object.hasOwn` and `Reflect.get`, and it counts an element access
 * through its argument so nothing is counted twice. A destructuring ASSIGNMENT reads it too, in
 * all three spellings (`({ containerPathShapes: x } = c)`, `({ containerPathShapes } = c)` and the
 * quoted key), so an object literal's key counts when that literal is an assignment target. The
 * interface member in `types.ts` and the `containerPathShapes:` keys of the providers' literals
 * are declarations, not reads. It reads the files `SCANNED_EXTENSIONS` names, and no other.
 */
function countReads(file: string, source: string): number {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  let reads = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === FIELD) reads += 1;
    else if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) && key.text === FIELD) reads += 1;
      else if (ts.isStringLiteral(key) && key.text === FIELD) reads += 1;
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isObjectLiteralExpression(node.parent) &&
      isAssignmentTarget(node.parent)
    ) {
      if ((ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === FIELD) reads += 1;
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

/** Whether this literal is the target of a destructuring assignment, however deeply nested. */
function isAssignmentTarget(literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): boolean {
  let child: ts.Node = literal;
  let parent = literal.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isBinaryExpression(parent))
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === child;
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === child;
  if (ts.isArrayLiteralExpression(parent)) return isAssignmentTarget(parent);
  if (ts.isPropertyAssignment(parent) && parent.initializer === child && ts.isObjectLiteralExpression(parent.parent)) {
    return isAssignmentTarget(parent.parent);
  }
  return false;
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
      "({ containerPathShapes: assigned } = c);",
      "({ containerPathShapes } = c);",
      '({ "containerPathShapes": quotedAssigned } = c);',
    ].join("\n");
    expect(countReads("reads.ts", reads)).toBe(12);

    const nonReads = [
      'type P = ProviderCapabilities["containerPathShapes"];',
      'const d = { containerPathShapes: "exact" };',
      'const q = { "containerPathShapes": "exact" };',
      "const s = { containerPathShapes };",
      "x = { containerPathShapes: y };",
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
