/**
 * The query generators name no engine. `src/lib/query-generators.ts` is the engine-agnostic dispatcher: every text one
 * engine writes reaches it through the registry in `src/lib/db/query-generators/index.ts`, a dialect's or a language's
 * row declared beside its provider and keyed by what the declaration says, its query dialect or its query language, or
 * an SQL engine's own forms keyed by the connection's type id, composed from the engine's declaration with Studio's SQL
 * generator function table (docs/providers/CONTRACT.md, clause M-81). The dispatcher imports no provider module, no string
 * or identifier in it names an engine, a dialect or a language other than SQL, and it reads no declaration's port.
 * MongoDB's JSON documents are the `json` language's row.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BUNDLED_SQL_GENERATORS } from "@/lib/db/engine-catalog/sql-generators.generated";
import { DIALECT_GENERATORS, LANGUAGE_GENERATORS, SQL_ENGINE_GENERATORS } from "@/lib/db/query-generators";
import { QUERY_DIALECTS } from "@/lib/db/query-dialects";
import {
  COUCHBASE_GENERATOR_QUOTE,
  COUCHBASE_GENERATOR_SELECT,
  COUCHBASE_GENERATOR_TABLE,
} from "@/lib/db/providers/document/couchbase/generators";
import { DRUID_GENERATOR_QUOTE } from "@/lib/db/providers/sql/druid/generators";
import { MSSQL_GENERATOR_QUOTE, MSSQL_GENERATOR_SELECT_LIST } from "@/lib/db/providers/sql/mssql-generators";
import { MYSQL_GENERATOR_QUOTE } from "@/lib/db/providers/sql/mysql-generators";
import { ORACLE_GENERATOR_QUOTE, ORACLE_GENERATOR_SELECT_LIST } from "@/lib/db/providers/sql/oracle-generators";

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
    // The value imports that are not a row: the generated SQL generator forms, the function table helpers the SQL
    // engine rows are composed through, and the type-id reader they are looked up through.
    const imports = importsOf(REGISTRY, { valuesOnly: true });
    const core = ["@/lib/db/engine-catalog/sql-generators.generated", "@/lib/db/function-table", "@/lib/db/type-id"];
    expect(imports.filter((specifier) => core.includes(specifier)).sort()).toEqual(core);
    const rows = imports.filter((specifier) => !core.includes(specifier));
    // One module per dialect and language row, and the five SQL engines' generator function modules.
    expect(rows.length).toBe(Object.keys(DIALECT_GENERATORS).length + Object.keys(LANGUAGE_GENERATORS).length + 5);
    expect(rows.filter((specifier) => !/^@\/lib\/db\/(providers|graph)\//.test(specifier))).toEqual([]);
  });

  test("holds a row for each query language an engine writes its own text in, and no other", () => {
    expect(Object.keys(LANGUAGE_GENERATORS).sort()).toEqual(["cypher", "influxql", "json", "promql"]);
    expect(Object.isFrozen(LANGUAGE_GENERATORS)).toBe(true);
  });

  test("holds a row for each SQL engine that writes forms of its own, keyed by its type id", () => {
    const count = (id: string) => BUNDLED_SQL_GENERATORS[id as keyof typeof BUNDLED_SQL_GENERATORS]?.countExpression;
    expect(SQL_ENGINE_GENERATORS).toEqual({
      couchbase: {
        quote: COUCHBASE_GENERATOR_QUOTE,
        table: COUCHBASE_GENERATOR_TABLE,
        select: COUCHBASE_GENERATOR_SELECT,
        countExpression: count("couchbase"),
      },
      druid: { quote: DRUID_GENERATOR_QUOTE, countExpression: count("druid") },
      mssql: {
        quote: MSSQL_GENERATOR_QUOTE,
        selectList: MSSQL_GENERATOR_SELECT_LIST,
        countExpression: count("mssql"),
      },
      mysql: { quote: MYSQL_GENERATOR_QUOTE, countExpression: count("mysql") },
      oracle: {
        quote: ORACLE_GENERATOR_QUOTE,
        selectList: ORACLE_GENERATOR_SELECT_LIST,
        countExpression: count("oracle"),
      },
    });
    // Each function by identity, as toEqual compares functions by reference.
    expect(SQL_ENGINE_GENERATORS.mssql?.selectList).toBe(MSSQL_GENERATOR_SELECT_LIST);
    expect(SQL_ENGINE_GENERATORS.mssql?.countExpression).toBe("COUNT_BIG(*)");
    expect(Object.isFrozen(SQL_ENGINE_GENERATORS)).toBe(true);
    // No row carries the port it was once keyed by.
    for (const row of Object.values(SQL_ENGINE_GENERATORS)) expect(Object.hasOwn(row, "port")).toBe(false);
  });
});
