import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  AgentComposedSqlError,
  composeCatalogRead,
  composeEstimatingExplain,
  MAX_CATALOG_SELECTOR_LENGTH,
} from "@/lib/agent/composed-sql";
import { agentReadSqlInput, inspectAgentStatement } from "@/lib/db/operations/statement-guard";
import { quoteLiteral } from "@/lib/sql/values";

/**
 * The SQL the SERVER composes (#329 T6, planning decision P1).
 *
 * The model never supplies a catalog statement or an EXPLAIN prefix: it supplies
 * a structured selector, and this module writes the SQL per dialect. Two families
 * of assertion carry that:
 *
 *  1. every composed statement satisfies the M1 input guard, because a composed
 *     statement the guard refuses is a tool that can never run; and
 *  2. a hostile selector becomes a quoted literal rather than statement text.
 */

const guardAccepts = (sql: string) => inspectAgentStatement(sql) === null;

describe("composeCatalogRead — PostgreSQL", () => {
  test("reads information_schema.columns and excludes the system schemas", () => {
    const sql = composeCatalogRead("postgres", {});

    expect(sql).toContain("information_schema.columns");
    expect(sql).toContain("'pg_catalog'");
    expect(sql).toContain("'information_schema'");
  });

  test("projects the column inventory a snapshot needs", () => {
    const sql = composeCatalogRead("postgres", {});

    for (const column of ["table_schema", "table_name", "column_name", "data_type", "is_nullable"]) {
      expect(sql).toContain(column);
    }
  });

  test("is accepted by the bounded-read guard", () => {
    expect(inspectAgentStatement(composeCatalogRead("postgres", {}))).toBeNull();
  });

  test("is accepted by the descriptor's own input schema, selector or not", () => {
    for (const selector of [{}, { schema: "public" }, { schema: "public", table: "orders" }]) {
      const parsed = agentReadSqlInput.safeParse({ sql: composeCatalogRead("postgres", selector) });
      expect(parsed.success, `selector ${JSON.stringify(selector)}`).toBe(true);
    }
  });

  test("narrows on a schema selector", () => {
    const sql = composeCatalogRead("postgres", { schema: "sales" });

    expect(sql).toContain("table_schema = 'sales'");
  });

  test("narrows on a table selector", () => {
    const sql = composeCatalogRead("postgres", { table: "orders" });

    expect(sql).toContain("table_name = 'orders'");
  });

  test("orders the rows, so two identical inventories serialise identically", () => {
    expect(composeCatalogRead("postgres", {})).toContain("ORDER BY");
  });
});

describe("composeCatalogRead — SQLite", () => {
  test("reads sqlite_master, because the pragma table-valued functions are refused by the guard", () => {
    const sql = composeCatalogRead("sqlite", {});

    expect(sql).toContain("sqlite_master");
    expect(sql.toLowerCase()).not.toContain("pragma");
  });

  test("is accepted by the bounded-read guard", () => {
    expect(inspectAgentStatement(composeCatalogRead("sqlite", {}))).toBeNull();
  });

  test("is accepted by the descriptor's own input schema", () => {
    expect(agentReadSqlInput.safeParse({ sql: composeCatalogRead("sqlite", {}) }).success).toBe(true);
    expect(agentReadSqlInput.safeParse({ sql: composeCatalogRead("sqlite", { table: "orders" }) }).success).toBe(true);
  });

  test("returns tables and views, and hides SQLite's own internal objects", () => {
    const sql = composeCatalogRead("sqlite", {});

    expect(sql).toContain("'table'");
    expect(sql).toContain("'view'");
    expect(sql).toContain("sqlite@_%");
  });

  test("narrows on a table selector", () => {
    expect(composeCatalogRead("sqlite", { table: "orders" })).toContain("name = 'orders'");
  });

  test("accepts SQLite's only schema name and refuses any other", () => {
    expect(guardAccepts(composeCatalogRead("sqlite", { schema: "main" }))).toBe(true);

    expect(() => composeCatalogRead("sqlite", { schema: "sales" })).toThrow(AgentComposedSqlError);
  });

  test("the refusal names the selector rather than a message a caller has to parse", () => {
    try {
      composeCatalogRead("sqlite", { schema: "sales" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentComposedSqlError);
      expect((error as AgentComposedSqlError).reasonCode).toBe("SELECTOR_UNSUPPORTED_BY_DIALECT");
    }
  });

  /**
   * Run against a REAL engine, because the internal-object filter is the one part
   * of this composition that a textual assertion cannot pin. `expect(sql).toContain
   * ("sqlite@_%")` passes whether or not the `ESCAPE '@'` clause is present, and
   * without it `@` is an ordinary character, the LIKE pattern matches nothing, and
   * every internal object re-enters the inventory. `docs/providers/sqlite.md`
   * states the filter as fact, so it is asserted against the engine that decides it.
   *
   * `AUTOINCREMENT` is what makes the fixture load-bearing: it is the documented
   * way to make SQLite create `sqlite_sequence` itself, so the internal object is
   * the engine's own rather than one this test planted.
   */
  test("the internal-object filter really excludes them, on a live engine", () => {
    const database = new Database(":memory:");
    try {
      database.run("CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, total REAL)");
      database.run("INSERT INTO orders (total) VALUES (1.0)");
      database.run("CREATE VIEW recent_orders AS SELECT id FROM orders");

      // The engine created it, not this test — otherwise the filter would be
      // asserted against a fixture rather than against SQLite's own behaviour.
      const everything = database.prepare("SELECT name FROM sqlite_master").all() as { name: string }[];
      expect(everything.map((row) => row.name)).toContain("sqlite_sequence");

      const rows = database.prepare(composeCatalogRead("sqlite", {})).all() as { name: string }[];

      expect(rows.map((row) => row.name).sort()).toEqual(["orders", "recent_orders"]);
    } finally {
      database.close();
    }
  });
});

describe("composeCatalogRead — a hostile selector becomes a literal, never statement text", () => {
  test("a quote in a selector cannot close the literal", () => {
    const sql = composeCatalogRead("postgres", { table: "orders'; DROP TABLE users --" });

    expect(inspectAgentStatement(sql)).toBeNull();
    expect(sql).toContain("''");
  });

  test("the composed statement stays a single bounded read under an injection attempt", () => {
    for (const table of ["a'--", "a''", "a';SELECT 1;--", "a\nb", "a/*b*/c", "a;b"]) {
      const sql = composeCatalogRead("postgres", { table });
      expect(inspectAgentStatement(sql), `table ${JSON.stringify(table)}`).toBeNull();
    }
  });

  test("a backslash in a selector is refused rather than quoted", () => {
    // Quoting alone is not enough for this one character: the dialect-less span
    // reader the guard uses treats a backslash as an escape inside a single-quoted
    // literal, so `'a\'` never closes. Verified below, so the refusal is pinned to
    // the reason it exists rather than to a preference.
    expect(inspectAgentStatement(`SELECT 1 FROM t WHERE n = ${quoteLiteral("a\\", "postgres")}`)).toBe(
      "UNDETERMINABLE_TEXT",
    );

    for (const table of ["a\\", "a\\'; DROP TABLE users --"]) {
      try {
        composeCatalogRead("postgres", { table });
        throw new Error(`expected a refusal for ${JSON.stringify(table)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(AgentComposedSqlError);
        expect((error as AgentComposedSqlError).reasonCode).toBe("INVALID_SELECTOR");
      }
    }
  });

  test("the SQLite side quotes the same way", () => {
    const sql = composeCatalogRead("sqlite", { table: "orders'; DROP TABLE users --" });

    expect(inspectAgentStatement(sql)).toBeNull();
    expect(sql).toContain("''");
  });

  test("refuses a blank selector rather than composing a tautology", () => {
    expect(() => composeCatalogRead("postgres", { table: "   " })).toThrow(AgentComposedSqlError);
    expect(() => composeCatalogRead("postgres", { schema: "" })).toThrow(AgentComposedSqlError);
  });

  test("refuses a selector longer than any engine's identifier limit", () => {
    const tooLong = "t".repeat(MAX_CATALOG_SELECTOR_LENGTH + 1);

    expect(() => composeCatalogRead("postgres", { table: tooLong })).toThrow(AgentComposedSqlError);
    expect(guardAccepts(composeCatalogRead("postgres", { table: "t".repeat(MAX_CATALOG_SELECTOR_LENGTH) }))).toBe(true);
  });

  test("the blank refusal carries the INVALID_SELECTOR code", () => {
    try {
      composeCatalogRead("postgres", { table: " " });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as AgentComposedSqlError).reasonCode).toBe("INVALID_SELECTOR");
    }
  });
});

describe("composeCatalogRead — dialects this milestone does not serve", () => {
  test("refuses rather than composing SQL it has not verified", () => {
    for (const dialect of ["mysql", "oracle", "mssql", "mongodb", "redis"] as const) {
      expect(() => composeCatalogRead(dialect, {}), dialect).toThrow(AgentComposedSqlError);
    }
  });

  test("the refusal carries the UNSUPPORTED_DIALECT code", () => {
    try {
      composeCatalogRead("mysql", {});
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as AgentComposedSqlError).reasonCode).toBe("UNSUPPORTED_DIALECT");
    }
  });
});

describe("composeEstimatingExplain", () => {
  test("PostgreSQL gets the estimating form, never the executing one", () => {
    const sql = composeEstimatingExplain("postgres", "SELECT id FROM orders");

    expect(sql).toBe("EXPLAIN (FORMAT JSON) SELECT id FROM orders");
    expect(sql.toUpperCase()).not.toContain("ANALYZE");
    expect(sql.toUpperCase()).not.toContain("ANALYSE");
  });

  test("SQLite gets EXPLAIN QUERY PLAN, which describes without running", () => {
    expect(composeEstimatingExplain("sqlite", "SELECT id FROM orders")).toBe(
      "EXPLAIN QUERY PLAN SELECT id FROM orders",
    );
  });

  test("both composed forms are accepted by the plan-inspection input contract", () => {
    for (const dialect of ["postgres", "sqlite"] as const) {
      const sql = composeEstimatingExplain(dialect, "SELECT id FROM orders");
      expect(agentReadSqlInput.safeParse({ sql }).success, dialect).toBe(true);
    }
  });

  test("a CTE is explainable on both engines", () => {
    for (const dialect of ["postgres", "sqlite"] as const) {
      const sql = composeEstimatingExplain(dialect, "WITH t AS (SELECT 1 AS n) SELECT n FROM t");
      expect(agentReadSqlInput.safeParse({ sql }).success, dialect).toBe(true);
    }
  });

  test("a write the model smuggled in is refused by the guard rather than explained", () => {
    const sql = composeEstimatingExplain("postgres", "DROP TABLE users");
    const parsed = agentReadSqlInput.safeParse({ sql });

    expect(parsed.success).toBe(false);
    expect(inspectAgentStatement(sql)).toBe("SIDE_EFFECT_KEYWORD");
  });

  test("an ANALYZE the model wrote itself is still refused for the estimating descriptor", () => {
    const sql = composeEstimatingExplain("sqlite", "SELECT id FROM orders; ANALYZE");

    expect(agentReadSqlInput.safeParse({ sql }).success).toBe(false);
  });

  test("refuses a dialect whose estimating EXPLAIN this milestone has not verified", () => {
    expect(() => composeEstimatingExplain("mysql", "SELECT 1")).toThrow(AgentComposedSqlError);
  });

  test("refuses a blank statement rather than composing a bare EXPLAIN", () => {
    expect(() => composeEstimatingExplain("postgres", "   ")).toThrow(AgentComposedSqlError);
  });
});
