/**
 * The connection dialog's form data, declared in src/lib/db/connection-form.ts: a module with no React, icon or
 * component in its run-time graph, so a bundle without React (the VS Code extension's child, which serves
 * `engines/list`) can load it, and the table `DB_UI_CONFIG` is built from, entry by entry, with only an icon and a
 * colour added.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import * as uiConfig from "@/lib/db-ui-config";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import * as form from "@/lib/db/connection-form";
import {
  CONNECTION_FORM,
  CONNECTION_PICKER_ORDER,
  connectionFieldHint,
  connectionFieldPlaceholder,
  connectionFieldPlacement,
  offersSslPanel,
} from "@/lib/db/connection-form";
import type { DatabaseType } from "@/lib/types";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const MODULE = join(ROOT, "src/lib/db/connection-form.ts");
const EVERY_TYPE = [...EXTERNAL_DATABASE_TYPES, "libredb"] as DatabaseType[];
const MOVED_READERS = [
  "offersSslPanel",
  "connectionFieldLabel",
  "connectionFieldPlaceholder",
  "connectionFieldHint",
  "connectionFieldPlacement",
  "connectionFieldShown",
  "connectionFieldRefusal",
  "readOnlyHint",
] as const;

// The picker order must cover the whole DatabaseType union, because this form is also the EDIT
// form: a type missing here renders the edit dialog with no tile selected. Keyed by
// DatabaseType, so adding a provider to the union fails `typecheck` on the missing key
// instead of silently dropping it from the UI. Set an entry to false only to hide a type
// on purpose, and say why.
const PICKER_COVERAGE: Record<DatabaseType, boolean> = {
  postgres: true,
  mysql: true,
  sqlite: true,
  oracle: true,
  db2: true,
  mssql: true,
  mongodb: true,
  redis: true,
  libredb: true,
  couchbase: true,
  clickhouse: true,
  druid: true,
  // Both search ids are selectable: the same form EDITS an existing connection, so
  // an omitted type leaves the picker with nothing selected for a connection the
  // product can otherwise open (issue #424 Phase 1).
  elasticsearch: true,
  opensearch: true,
  trino: true,
  cassandra: true,
  libsql: true,
  duckdb: true,
  prometheus: true,
  kafka: true,
  etcd: true,
  neo4j: true,
  milvus: true,
  qdrant: true,
  weaviate: true,
  influxdb: true,
  influxdb3: true,
  oxia: true,
  databend: true,
  bigquery: true,
  s3: true,
  kubernetes: true,
  mqtt: true,
  firestore: true,
  rabbitmq: true,
  snowflake: true,
  spark: true,
  opcua: true,
  mtconnect: true,
  modbus: true,
  netconf: true,
  snmp: true,
  sparkplug: true,
};

/**
 * Every specifier a file loads at run time: value imports and re-exports, never a type-only one, and every
 * `import("<literal>")` call anywhere in it, because a bundler bundles a dynamic import as well.
 * With `withTypes`, the type-only imports and every `import("<literal>")` type are kept too: the files a
 * typecheck of the module has to read.
 */
function runTimeSpecifiers(path: string, withTypes = false): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    if (withTypes) {
      found.push(specifier.text);
      continue;
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly === true) continue;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (onlyTypes) continue;
    } else if (statement.isTypeOnly) continue;
    found.push(specifier.text);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteral(argument)) found.push(argument.text);
    }
    if (withTypes && ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteral(literal)) found.push(literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The repository file a specifier names, or null for a package. */
function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? join(dirname(from), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${specifier}, imported by ${from}, resolves to no file`);
}

/**
 * Every specifier and repository file the module's run-time import graph reaches, dynamic imports included, or with
 * `withTypes` its whole type-level graph.
 */
function reached(entry: string, withTypes = false): { specifiers: string[]; files: string[] } {
  const seen = new Set<string>();
  const specifiers = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const specifier of runTimeSpecifiers(path, withTypes)) {
      specifiers.add(specifier);
      const local = resolveLocal(path, specifier);
      if (local !== null) queue.push(local);
    }
  }
  return { specifiers: [...specifiers], files: [...seen] };
}

describe("src/lib/db/connection-form.ts", () => {
  test("its run-time graph reaches no React, icon, component or dialog-table module", () => {
    const { specifiers, files } = reached(MODULE);
    expect(
      specifiers.filter(
        (s) =>
          s === "react" ||
          s.startsWith("react/") ||
          s === "react-dom" ||
          s.startsWith("react-dom/") ||
          s === "lucide-react" ||
          s.startsWith("lucide-react/") ||
          s.startsWith("@/components/") ||
          s === "@/lib/db-ui-config",
      ),
    ).toEqual([]);
    expect(files.filter((f) => f.startsWith(join(ROOT, "src/components")))).toEqual([]);
    expect(specifiers).toContain("@/lib/db/connection-fields");
    expect(specifiers).toContain("@/lib/kubernetes/kubeconfig-import");
  });

  test("its type graph reaches no React, icon, component or dialog-table module either", () => {
    // The extension typechecks its child with jsx on, so a type-only import of the dialog table would make that
    // typecheck read every icon component to check one import of CONNECTION_FORM.
    const { specifiers, files } = reached(MODULE, true);
    expect(
      specifiers.filter(
        (s) =>
          s === "react" ||
          s.startsWith("react/") ||
          s === "lucide-react" ||
          s.startsWith("lucide-react/") ||
          s.startsWith("@/components/") ||
          s === "@/lib/db-ui-config",
      ),
    ).toEqual([]);
    expect(files.filter((f) => f.startsWith(join(ROOT, "src/components")))).toEqual([]);
    expect(specifiers).toContain("@/lib/connection-import");
  });

  test("a fresh process loads it on its own", () => {
    const run = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(MODULE)})`], { cwd: ROOT });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });

  test("DB_UI_CONFIG is CONNECTION_FORM plus an icon and a colour, for every type", () => {
    expect(Object.keys(CONNECTION_FORM).sort()).toEqual([...EVERY_TYPE].sort());
    for (const type of EVERY_TYPE) {
      const { icon, color, ...rest } = DB_UI_CONFIG[type];
      expect({ type, rest }).toEqual({ type, rest: { ...CONNECTION_FORM[type] } });
      expect({ type, keys: Object.keys(DB_UI_CONFIG[type]) }).toEqual({
        type,
        keys: ["icon", "color", ...Object.keys(CONNECTION_FORM[type])],
      });
      expect({ type, icon: icon !== undefined, color: typeof color }).toEqual({ type, icon: true, color: "string" });
      expect({ type, branded: "icon" in CONNECTION_FORM[type] || "color" in CONNECTION_FORM[type] }).toEqual({
        type,
        branded: false,
      });
    }
  });

  test("credentialWarnings stays a getter on both tables", () => {
    for (const type of EVERY_TYPE) {
      for (const [name, table] of [
        ["CONNECTION_FORM", CONNECTION_FORM],
        ["DB_UI_CONFIG", DB_UI_CONFIG],
      ] as const) {
        expect({
          type,
          name,
          getter: typeof Object.getOwnPropertyDescriptor(table[type], "credentialWarnings")?.get,
        }).toEqual({ type, name, getter: "function" });
      }
    }
  });

  test("db-ui-config re-exports the moved readers rather than copies", () => {
    const uiExports: Record<string, unknown> = { ...uiConfig };
    const formExports: Record<string, unknown> = { ...form };
    for (const name of MOVED_READERS) {
      expect({ name, same: typeof formExports[name] === "function" && uiExports[name] === formExports[name] }).toEqual({
        name,
        same: true,
      });
    }
  });

  test("offersSslPanel reads CONNECTION_FORM", () => {
    for (const type of EVERY_TYPE) {
      expect({ type, offered: offersSslPanel(type) }).toEqual({
        type,
        offered: CONNECTION_FORM[type].showSslPanel !== false,
      });
    }
  });

  test("the four v0 rows hold the values part 2's table derives", () => {
    expect(CONNECTION_FORM.postgres).toMatchObject({ label: "PostgreSQL", defaultPort: "5432" });
    expect(CONNECTION_FORM.mysql).toMatchObject({ label: "MySQL", defaultPort: "3306" });
    expect(CONNECTION_FORM.mssql).toMatchObject({ label: "SQL Server", defaultPort: "1433" });
    expect(CONNECTION_FORM.mongodb).toMatchObject({ label: "MongoDB", defaultPort: "27017" });
    for (const type of ["postgres", "mysql", "mssql", "mongodb"] as const) {
      expect({ type, defaultHost: CONNECTION_FORM[type].defaultHost, ssl: offersSslPanel(type) }).toEqual({
        type,
        defaultHost: undefined,
        ssl: true,
      });
    }
    expect(connectionFieldPlacement(CONNECTION_FORM.mssql, "instanceName")).toBe("advanced");
    expect(connectionFieldHint(CONNECTION_FORM.mssql, "instanceName")).toBe(
      "For named instances (e.g. SQLEXPRESS). Leave empty for default instance.",
    );
    expect(connectionFieldPlacement(CONNECTION_FORM.mongodb, "authSource")).toBe("open");
    expect(connectionFieldHint(CONNECTION_FORM.mongodb, "authSource")).toBe(
      "The database the user was created in, usually admin. Leave empty when the credentials live in the database above.",
    );
    expect(connectionFieldPlaceholder(CONNECTION_FORM.mongodb, "connectionString", "")).toBe(
      "mongodb://localhost:27017/mydb  or  mongodb+srv://...",
    );
  });
});

describe("CONNECTION_PICKER_ORDER", () => {
  test("offers every database type a connection can carry, each once", () => {
    const expected = Object.entries(PICKER_COVERAGE)
      .filter(([, selectable]) => selectable)
      .map(([type]) => type)
      .sort();
    const offered: string[] = [...CONNECTION_PICKER_ORDER].sort();
    expect(offered).toEqual(expected);
    expect(new Set(CONNECTION_PICKER_ORDER).size).toBe(CONNECTION_PICKER_ORDER.length);
    expect(Object.isFrozen(CONNECTION_PICKER_ORDER)).toBe(true);
  });

  test("keeps the picker's shipped order", () => {
    expect(CONNECTION_PICKER_ORDER).toEqual([
      "postgres",
      "mysql",
      "sqlite",
      "oracle",
      "mssql",
      "mongodb",
      "couchbase",
      "redis",
      "libredb",
      "clickhouse",
      "druid",
      "elasticsearch",
      "opensearch",
      "trino",
      "cassandra",
      "libsql",
      "duckdb",
      "prometheus",
      "kafka",
      "etcd",
      "db2",
      "neo4j",
      "milvus",
      "qdrant",
      "influxdb",
      "influxdb3",
      "oxia",
      "databend",
      "bigquery",
      "s3",
      "kubernetes",
      "mqtt",
      "firestore",
      "rabbitmq",
      "snowflake",
      "opcua",
      "snmp",
      "sparkplug",
      "spark",
      "mtconnect",
      "modbus",
      "netconf",
      "weaviate",
    ]);
  });

  test("puts the four v0 engines in part 2 criterion 2's order", () => {
    const v0 = ["postgres", "mssql", "mysql", "mongodb"];
    expect(CONNECTION_PICKER_ORDER.filter((type) => v0.includes(type))).toEqual([
      "postgres",
      "mysql",
      "mssql",
      "mongodb",
    ]);
  });
});
