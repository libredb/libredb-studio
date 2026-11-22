/**
 * The query generators name no engine. `src/lib/query-generators.ts` is the engine-agnostic dispatcher: every text one
 * engine writes is a row declared beside its provider and collected by the registry in
 * `src/lib/db/query-generators/index.ts`, keyed by what the declaration says, its query dialect or its query language,
 * or by the connection's type id for an SQL engine's own forms. The dispatcher imports no provider module, no string
 * or identifier in it names an engine, a dialect or a language other than SQL, and it reads no declaration's port.
 * MongoDB's JSON documents are the `json` language's row.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DIALECT_GENERATORS, LANGUAGE_GENERATORS, SQL_ENGINE_GENERATORS } from "@/lib/db/query-generators";
import { QUERY_DIALECTS } from "@/lib/db/query-dialects";
import { COUCHBASE_SQL_GENERATORS } from "@/lib/db/providers/document/couchbase/generators";
import { DRUID_SQL_GENERATORS } from "@/lib/db/providers/sql/druid/generators";
import { MSSQL_SQL_GENERATORS } from "@/lib/db/providers/sql/mssql-generators";
import { MYSQL_SQL_GENERATORS } from "@/lib/db/providers/sql/mysql-generators";
import { ORACLE_SQL_GENERATORS } from "@/lib/db/providers/sql/oracle-generators";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DISPATCHER = "src/lib/query-generators.ts";
const REGISTRY = "src/lib/db/query-generators/index.ts";

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);

/** Every import specifier of `file`, or only those that load a module at run time. */
function importsOf(file: string, { valuesOnly = false }: { valuesOnly?: boolean } = {}): string[] {
  return parse(file)
    .statements.filter(ts.isImportDeclaration)
    .filter((statement) => !valuesOnly || statement.importClause?.isTypeOnly !== true)
    .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
}

/** The words an engine's own text would carry: its type id, its dialect, its language, or a product name. */
const ENGINE_WORDS: readonly string[] = [
  ...SHIPPED_DATABASE_TYPES,
  ...Object.keys(QUERY_DIALECTS),
  ...Object.keys(LANGUAGE_GENERATORS),
  "couchbase",
  "druid",
  "oracle",
  "mssql",
  "mysql",
  "postgres",
  "sqlite",
  "etcd",
  "kubectl",
  "opc",
  "cypher",
  "influx",
  "prom",
  "json",
  "mongo",
];

/** Every name and string of `file` that names an engine, read from the syntax tree, so comments never count. */
function engineMentions(file: string): string[] {
  const words = new RegExp(ENGINE_WORDS.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && words.test(node.text)) found.push(node.text);
    if (ts.isTemplateExpression(node)) {
      for (const part of [node.head, ...node.templateSpans.map((span) => span.literal)]) {
        if (words.test(part.text)) found.push(part.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return found;
}

describe("the query generators' dispatcher", () => {
  test("imports no provider module: every engine's text reaches it through the registry", () => {
    const imports = importsOf(DISPATCHER);
    expect(imports).toContain("@/lib/db/query-generators");
    expect(imports.filter((specifier) => /providers|graph/.test(specifier))).toEqual([]);
  });

  test("names no engine, dialect or engine language in a name or a string", () => {
    expect(engineMentions(DISPATCHER)).toEqual([]);
  });

  test("the scan reads real code: the registry's own module names engines", () => {
    expect(engineMentions(REGISTRY).length).toBeGreaterThan(0);
  });

  test("reads no declaration's port: an SQL engine's forms follow its type id", () => {
    // Any mention of the field in the syntax tree, a property read or a destructured name alike; comments never count.
    const portReads = (file: string): string[] => {
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === "defaultPort") found.push(`${file} ${node.text}`);
        ts.forEachChild(node, visit);
      };
      visit(parse(file));
      return found;
    };
    expect([...portReads(DISPATCHER), ...portReads(REGISTRY)]).toEqual([]);
  });
});

describe("the generator registry", () => {
  test("holds one dialect row per member of the dialect registry, each declared beside its provider", () => {
    expect(Object.keys(DIALECT_GENERATORS).sort()).toEqual(Object.keys(QUERY_DIALECTS).sort());
    expect(Object.isFrozen(DIALECT_GENERATORS)).toBe(true);
    // The one value import that is not a row: the type-id reader the SQL engine rows are looked up through.
    const imports = importsOf(REGISTRY, { valuesOnly: true });
    expect(imports.filter((specifier) => specifier === "@/lib/db/type-id")).toEqual(["@/lib/db/type-id"]);
    const rows = imports.filter((specifier) => specifier !== "@/lib/db/type-id");
    expect(rows.length).toBe(Object.keys(DIALECT_GENERATORS).length + Object.keys(LANGUAGE_GENERATORS).length + 5);
    expect(rows.filter((specifier) => !/^@\/lib\/db\/(providers|graph)\//.test(specifier))).toEqual([]);
  });

  test("holds a row for each query language an engine writes its own text in, and no other", () => {
    expect(Object.keys(LANGUAGE_GENERATORS).sort()).toEqual(["cypher", "influxql", "json", "promql"]);
    expect(Object.isFrozen(LANGUAGE_GENERATORS)).toBe(true);
  });

  test("holds a row for each SQL engine that writes forms of its own, keyed by its type id", () => {
    expect(SQL_ENGINE_GENERATORS).toEqual({
      couchbase: COUCHBASE_SQL_GENERATORS,
      druid: DRUID_SQL_GENERATORS,
      mssql: MSSQL_SQL_GENERATORS,
      mysql: MYSQL_SQL_GENERATORS,
      oracle: ORACLE_SQL_GENERATORS,
    });
    expect(Object.isFrozen(SQL_ENGINE_GENERATORS)).toBe(true);
    // No row carries the port it was once keyed by.
    for (const row of Object.values(SQL_ENGINE_GENERATORS)) expect(Object.hasOwn(row, "port")).toBe(false);
  });
});
