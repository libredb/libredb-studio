/**
 * The SQL engines' own generator forms are read by the connection's type id, never by the port its declaration names
 * (FND-1). `SQL_ENGINE_GENERATORS` holds one row per SQL engine that writes forms of its own, read through
 * `typeIdRow`, and each of the seven generator functions reads the type it is handed once, as it is called, so a value
 * outside the `DatabaseType` union is refused by name whatever the declaration says.
 */
import { describe, expect, test } from "bun:test";
import { SQL_ENGINE_GENERATORS, sqlEngineGenerators } from "@/lib/db/query-generators";
import {
  containerSpellingOf,
  generateCountQuery,
  generateSelectQuery,
  generateTableQuery,
  quoteIdentifier,
  quoteObjectPath,
  quoteTypedName,
} from "@/lib/query-generators";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { ColumnSchema, DatabaseType } from "@/lib/types";
import { OUTSIDE_THE_UNION, refusalOf, refusalThrownBy } from "../../helpers/outside-the-union";

/** A minimal SQL declaration with no declared quoting, so only the engine's row can quote differently. */
function caps(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    queryLanguage: "sql",
    supportsExplain: false,
    supportsExternalQueryLimiting: true,
    supportsInlineRowEdit: false,
    supportsMaintenance: false,
    maintenanceOperations: [],
    supportsConnectionString: false,
    schemaRefreshPattern: "",
    defaultPort: null,
    ...overrides,
  };
}

/** Ports that are no engine's own, the PostgreSQL port among them: none of them may choose a row. */
const OTHER_PORTS: readonly (number | null)[] = [null, 5432, 3307, 1];

/** The ports the five rows were once keyed by: none of them may choose a row either. */
const ROW_PORTS: readonly number[] = [3306, 1433, 1521, 8091, 8888];

const ID: ColumnSchema = { name: "id", type: "NUMBER", nullable: false, isPrimary: true };

describe("sqlEngineGenerators", () => {
  test("answers no row with no connection", () => {
    expect(sqlEngineGenerators(undefined)).toBeUndefined();
  });

  test.each(["couchbase", "druid", "mssql", "mysql", "oracle"] as const)(
    "answers the %s row under its type id",
    (type) => {
      const row = SQL_ENGINE_GENERATORS[type];
      expect(row).toBeDefined();
      expect(sqlEngineGenerators(type)).toBe(row);
    },
  );

  test.each(["postgres", "clickhouse", "sqlite"] as const)(
    "answers no row for %s, which writes the shared forms",
    (type) => {
      expect(sqlEngineGenerators(type)).toBeUndefined();
    },
  );

  test.each(OUTSIDE_THE_UNION)("refuses %s by name", (_label, value) => {
    expect(refusalThrownBy(() => sqlEngineGenerators(value as DatabaseType))).toEqual(refusalOf(value));
  });
});

describe("the SQL engine rows follow the type id, never the port", () => {
  const ROWS: readonly (readonly [DatabaseType, string, string])[] = [
    ["mysql", "Order Items", "`Order Items`"],
    ["mssql", "Order Items", "[Order Items]"],
    ["oracle", "orders", '"orders"'],
    ["druid", "count", '"count"'],
    ["couchbase", "bucket", "`bucket`"],
  ];

  test.each(ROWS)("%s quotes with its own row whatever port its declaration names", (type, name, quoted) => {
    for (const port of OTHER_PORTS) {
      expect(quoteIdentifier(name, type, caps({ defaultPort: port }))).toBe(quoted);
    }
  });

  test("a type with no row, or no type, gets the default whatever port the declaration names", () => {
    for (const port of ROW_PORTS) {
      expect(quoteIdentifier("Order Items", "postgres", caps({ defaultPort: port }))).toBe('"Order Items"');
      expect(quoteIdentifier("Order Items", undefined, caps({ defaultPort: port }))).toBe('"Order Items"');
      expect(generateCountQuery(["dbo", "t"], "clickhouse", caps({ defaultPort: port }))).toBe(
        "SELECT COUNT(*) AS row_count\nFROM dbo.t;",
      );
    }
  });

  test("the count, the select and the table forms come from the type's row", () => {
    for (const port of OTHER_PORTS) {
      const declaration = caps({ defaultPort: port });
      expect(generateCountQuery(["dbo", "t"], "mssql", declaration)).toBe(
        "SELECT COUNT_BIG(*) AS row_count\nFROM dbo.t;",
      );
      expect(generateSelectQuery(["APP", "T"], [ID], "oracle", declaration)).toBe(
        'SELECT\n  "id"\nFROM APP.T\nWHERE 1=1\nFETCH FIRST 100 ROWS ONLY;',
      );
      expect(generateTableQuery(["b", "s", "c"], "couchbase", declaration)).toBe(
        "SELECT META(d).id AS __id, d.* FROM `b`.`s`.`c` AS d;",
      );
    }
  });

  test("quoteTypedName, quoteObjectPath and containerSpellingOf follow the same row", () => {
    for (const port of OTHER_PORTS) {
      const declaration = caps({ defaultPort: port });
      expect(quoteTypedName("Order Items", "mysql", declaration)).toBe("`Order Items`");
      expect(quoteTypedName("Order Items", "postgres", declaration)).toBe('"Order Items"');
      expect(quoteObjectPath(["app db", "Order Items"], "mssql", declaration)).toBe("[app db].[Order Items]");
      expect(quoteObjectPath(["app db", "Order Items"], undefined, declaration)).toBe('"app db"."Order Items"');
      // An engine-spelled container needs a declared quoting, which answers before any row, so the spelling's
      // addresses are the ones `quoteObjectPath` writes for the same type and declaration.
      const spelled = caps({ defaultPort: port, containerNameSpelling: "engine", identifierQuoting: "backtick" });
      for (const type of ["mysql", "postgres"] as const) {
        expect(containerSpellingOf(type, spelled)?.quotePath(["app db", "Order Items"])).toBe(
          quoteObjectPath(["app db", "Order Items"], type, spelled),
        );
      }
    }
  });
});

describe("a value outside the union is refused by name at every generator call", () => {
  const DECLARATIONS: readonly (readonly [string, ProviderCapabilities])[] = [
    ["SQL", caps()],
    ["JSON", caps({ queryLanguage: "json" })],
    ["declared-quoting", caps({ identifierQuoting: "double" })],
  ];
  const CALLS: readonly (readonly [string, (type: DatabaseType, c: ProviderCapabilities) => unknown])[] = [
    ["quoteIdentifier", (type, c) => quoteIdentifier("x", type, c)],
    ["quoteTypedName", (type, c) => quoteTypedName("orders", type, c)],
    ["quoteObjectPath", (type, c) => quoteObjectPath(["a", "b"], type, c)],
    ["containerSpellingOf", (type, c) => containerSpellingOf(type, c)],
    ["generateTableQuery", (type, c) => generateTableQuery(["a"], type, c)],
    ["generateSelectQuery", (type, c) => generateSelectQuery(["a"], [], type, c)],
    ["generateCountQuery", (type, c) => generateCountQuery(["a"], type, c)],
  ];
  const ROWS = CALLS.flatMap(([name, call]) =>
    OUTSIDE_THE_UNION.flatMap(([label, value]) =>
      DECLARATIONS.map(([kind, declaration]) => [name, label, kind, call, value, declaration] as const),
    ),
  );

  test.each(ROWS)("%s refuses %s on a %s declaration", (_name, _label, _kind, call, value, declaration) => {
    expect(refusalThrownBy(() => call(value as DatabaseType, declaration))).toEqual(refusalOf(value));
  });
});
