import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AgentComposedSqlError,
  composeCatalogRead,
  composeEstimatingExplain,
  composeStatisticsAvailabilityProbe,
  MAX_CATALOG_SELECTOR_LENGTH,
} from "@/lib/agent/composed-sql";
import { agentReadSqlInput, inspectAgentStatement } from "@/lib/db/operations/statement-guard";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("composeCatalogRead — the relation and index inventories (#329 T8)", () => {
  /**
   * The foreign-key read leaves `information_schema` for `pg_constraint`, and every
   * assertion below is a property measured on a live PostgreSQL 18 rather than a
   * shape that reads well (#463):
   *
   *  - the three `information_schema` constraint views are restricted to constraints
   *    on tables the role owns or holds a privilege on OTHER than `SELECT`, so the
   *    `SELECT`-only role `docs/AGENT_DEMO.md` prescribes read an EMPTY graph:
   *    measured on the seeded dvdrental as `libredb_agent`, 0 rows where
   *    `pg_constraint WHERE contype = 'f'` holds 18, and 18 rows from this read.
   *    `pg_constraint` asks only for `USAGE` on the schema.
   *  - neither view exposes an ordinal, so a composite key came back as the
   *    cross-product. `unnest(conkey, confkey) WITH ORDINALITY` pairs the two sides
   *    by position, which is the only thing here that can.
   *  - a constraint NAME is unique per table, not per schema, and the referenced
   *    side could not be narrowed by table at all. A `pg_constraint` row carries
   *    `conrelid` and `confrelid` and is never matched by name.
   *
   * Both defects compound, which is what the fixture pins: `kids(x, y) REFERENCES
   * parents(a, b)` plus a SECOND constraint also named `fk_shared` on another table
   * returned NINE rows from the old joins — three of them right, and `second` holding
   * edges to a table its constraint never mentions — where this read returns exactly
   * the three.
   */
  test("PostgreSQL reads foreign keys from pg_constraint, which a SELECT-only role can see", () => {
    const sql = composeCatalogRead("postgres", { kind: "relations" });

    expect(guardAccepts(sql)).toBe(true);
    expect(sql).toContain("pg_constraint");
    expect(sql).toContain("c.contype = 'f'");
    // None of the three privilege-filtered views, on either side of the edge.
    for (const view of ["table_constraints", "key_column_usage", "constraint_column_usage"]) {
      expect(sql).not.toContain(view);
    }
    // The projection `buildPostgresTables` reads is unchanged, which is why the fold
    // needed no edit: the same six names carry the new rows.
    for (const projected of [
      "table_schema",
      "table_name",
      "column_name",
      "referenced_schema",
      "referenced_table",
      "referenced_column",
    ]) {
      expect(sql).toContain(projected);
    }
  });

  test("a composite key is paired by ordinal, so two columns are two edges and not four", () => {
    const sql = composeCatalogRead("postgres", { kind: "relations" });

    // ONE unnest over BOTH arrays: two separate unnests would multiply again.
    expect(sql).toContain("unnest(c.conkey, c.confkey) WITH ORDINALITY");
    expect(sql).toContain("att.attrelid = c.conrelid AND att.attnum = k.attnum");
    expect(sql).toContain("fatt.attrelid = c.confrelid AND fatt.attnum = k.fattnum");
    expect(sql).toContain("ORDER BY rn.nspname, rel.relname, k.ord");
  });

  test("a constraint is identified by oid, so two same-named constraints cannot cross-match", () => {
    const sql = composeCatalogRead("postgres", { kind: "relations" });

    expect(sql).not.toContain("constraint_name");
    expect(sql).toContain("rel.oid = c.conrelid");
    expect(sql).toContain("frel.oid = c.confrelid");
  });

  test("PostgreSQL reads indexes from pg_index, carrying uniqueness and primary-key membership", () => {
    const sql = composeCatalogRead("postgres", { kind: "indexes" });

    expect(guardAccepts(sql)).toBe(true);
    expect(sql).toContain("pg_index");
    for (const projected of ["index_name", "is_unique", "is_primary", "column_name"]) {
      expect(sql).toContain(projected);
    }
  });

  /**
   * The expression case, measured on the same live server (#463).
   *
   * `indkey` stores 0 for an expression, which no `pg_attribute` row matches, so the
   * inner join dropped `CREATE INDEX ix_expr ON t (lower(name))` from the inventory
   * entirely and returned `(status, lower(name))` carrying only `status`. Unnesting
   * `indkey` WITH ORDINALITY gives every key POSITION a row, and
   * `pg_get_indexdef(indexrelid, n, true)` names what sits in that position — which
   * is the shape the SQLite side already produces, where `parseSqliteIndexDdl` keeps
   * an expression's written form in the same column list as the plain names.
   *
   * `att.attname` still wins where there is one, and that is not decoration:
   * `pg_get_indexdef` emits an identifier as PostgreSQL would have to write it, so a
   * mixed-case column comes back as `"userId"` with the quotes in it — measured — and
   * that string matches no name in the column inventory, which is what
   * `markPrimary` and the index's column list are compared against.
   */
  test("an expression index reaches the inventory with its expression, not as a missing index", () => {
    const sql = composeCatalogRead("postgres", { kind: "indexes" });

    expect(guardAccepts(sql)).toBe(true);
    expect(sql).toContain("unnest(ix.indkey) WITH ORDINALITY");
    // LEFT, so an expression's position survives having no attribute row.
    expect(sql).toContain("LEFT JOIN pg_attribute att");
    expect(sql).toContain("COALESCE(att.attname, pg_get_indexdef(ix.indexrelid, k.ord::int, true))");
    expect(sql).toContain("ORDER BY n.nspname, t.relname, i.relname, k.ord");
  });

  test("both PostgreSQL inventories narrow on the same selectors as the column one", () => {
    for (const kind of ["relations", "indexes"] as const) {
      const sql = composeCatalogRead("postgres", { kind, schema: "sales", table: "orders" });

      expect(sql, kind).toContain("'sales'");
      expect(sql, kind).toContain("'orders'");
      expect(guardAccepts(sql), kind).toBe(true);
    }
  });

  test("SQLite's relations live in the table DDL, so the relation read IS the object read", () => {
    expect(composeCatalogRead("sqlite", { kind: "relations" })).toBe(composeCatalogRead("sqlite", { kind: "columns" }));
  });

  test("SQLite reads index DDL from sqlite_master, skipping the implicit indexes that carry none", () => {
    const sql = composeCatalogRead("sqlite", { kind: "indexes" });

    expect(guardAccepts(sql)).toBe(true);
    expect(sql).toContain("'index'");
    expect(sql).toContain("sql IS NOT NULL");
  });

  /**
   * On a live engine, because an implicit index is the case a textual assertion
   * cannot pin: SQLite creates one for every UNIQUE constraint, gives it a NULL
   * `sql`, and a composition that returned it would put an index into the
   * inventory that no parser can describe.
   */
  test("the SQLite index read returns declared indexes and no implicit one, on a live engine", () => {
    const database = new Database(":memory:");
    try {
      database.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, code TEXT UNIQUE, total REAL)");
      database.run("CREATE INDEX orders_total_idx ON orders (total)");

      const implicit = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
        sql: string | null;
      }[];
      // The engine made one for the UNIQUE column, not this test.
      expect(implicit.some((row) => row.sql === null)).toBe(true);

      const rows = database.prepare(composeCatalogRead("sqlite", { kind: "indexes" })).all() as { name: string }[];

      expect(rows.map((row) => row.name)).toEqual(["orders_total_idx"]);
    } finally {
      database.close();
    }
  });

  test("every kind on every served dialect is a statement the guard admits", () => {
    for (const dialect of ["postgres", "sqlite"] as const) {
      for (const kind of ["columns", "relations", "indexes", "statistics"] as const) {
        const sql = composeCatalogRead(dialect, { kind });
        expect(agentReadSqlInput.safeParse({ sql }).success, `${dialect}/${kind}`).toBe(true);
      }
    }
  });

  test("an unserved dialect is refused for every kind, never composed on a guess", () => {
    for (const kind of ["columns", "relations", "indexes", "statistics"] as const) {
      expect(() => composeCatalogRead("mysql", { kind }), kind).toThrow(AgentComposedSqlError);
    }
  });

  test("a hostile selector is quoted on the relation and index reads too", () => {
    for (const kind of ["relations", "indexes"] as const) {
      const sql = composeCatalogRead("postgres", { kind, table: "orders'; DROP TABLE users --" });

      expect(inspectAgentStatement(sql), kind).toBeNull();
      expect(sql, kind).toContain("''");
    }
    expect(() => composeCatalogRead("sqlite", { kind: "indexes", table: "a\\" })).toThrow(AgentComposedSqlError);
  });

  test("SQLite refuses a schema selector that is not its only schema, on every kind", () => {
    for (const kind of ["columns", "relations", "indexes", "statistics"] as const) {
      expect(() => composeCatalogRead("sqlite", { kind, schema: "sales" }), kind).toThrow(AgentComposedSqlError);
      expect(guardAccepts(composeCatalogRead("sqlite", { kind, schema: "MAIN" })), kind).toBe(true);
    }
  });
});

/**
 * The statistics inventory (plan-mode SQL generator, work item 1).
 *
 * Every assertion here is about one of two things: that the composition reads the
 * engine's OWN estimates rather than computing anything (a scan is what makes this
 * mode unsafe to point at production), and that a table the engine holds no
 * estimate for stays IN the inventory as a table without statistics — because the
 * consumer must be able to tell "no statistics" from "zero rows", and an omitted
 * table reads as silence.
 */
describe("composeCatalogRead — the statistics inventory", () => {
  test("PostgreSQL reads the estimates the catalog already holds, and computes nothing", () => {
    const sql = composeCatalogRead("postgres", { kind: "statistics" });

    expect(guardAccepts(sql)).toBe(true);
    expect(sql).toContain("pg_class");
    expect(sql).toContain("reltuples");
    expect(sql).toContain("pg_stats");
    expect(sql).toContain("n_distinct");
    expect(sql).toContain("null_frac");
    // A scan is the thing this composition exists to avoid; COUNT is how it would
    // arrive, and ANALYZE is how the estimates would be refreshed (a write).
    expect(sql.toUpperCase()).not.toContain("COUNT(");
    expect(sql.toUpperCase()).not.toContain("ANALYZE");
  });

  test("PostgreSQL keeps a never-analysed table in the inventory rather than dropping it", () => {
    // The LEFT JOIN is the whole mechanism: pg_stats holds no row for a table that
    // was never ANALYZEd, so an inner join would omit it and the reader could not
    // distinguish "no statistics" from "table not there".
    expect(composeCatalogRead("postgres", { kind: "statistics" })).toContain("LEFT JOIN pg_stats");
  });

  test("PostgreSQL emits n_distinct raw, leaving the negative-ratio conversion to the reader", () => {
    const sql = composeCatalogRead("postgres", { kind: "statistics" });

    // pg_stats.n_distinct is negative when it expresses a ratio of the row count.
    // Converting it here would put a derived number on the wire under the same name
    // as the raw one, and the reader could no longer label the result as derived.
    expect(sql).not.toContain("CASE");
    expect(sql).toContain("s.n_distinct AS n_distinct");
  });

  test("PostgreSQL narrows on the same selectors as every other kind", () => {
    const sql = composeCatalogRead("postgres", { kind: "statistics", schema: "sales", table: "orders" });

    expect(sql).toContain("n.nspname = 'sales'");
    expect(sql).toContain("c.relname = 'orders'");
    expect(guardAccepts(sql)).toBe(true);
  });

  test("SQLite reads sqlite_stat1, joined from sqlite_master so unanalysed tables stay listed", () => {
    const sql = composeCatalogRead("sqlite", { kind: "statistics" });

    expect(guardAccepts(sql)).toBe(true);
    expect(sql).toContain("sqlite_master");
    expect(sql).toContain("LEFT JOIN sqlite_stat1");
    expect(sql.toUpperCase()).not.toContain("COUNT(");
  });

  test("SQLite narrows on a table selector and hides its own internal objects", () => {
    const sql = composeCatalogRead("sqlite", { kind: "statistics", table: "orders" });

    expect(sql).toContain("m.name = 'orders'");
    expect(sql).toContain("sqlite@_%");
    expect(guardAccepts(sql)).toBe(true);
  });

  test("a hostile selector is quoted here too", () => {
    for (const dialect of ["postgres", "sqlite"] as const) {
      const sql = composeCatalogRead(dialect, { kind: "statistics", table: "orders'; DROP TABLE users --" });

      expect(inspectAgentStatement(sql), dialect).toBeNull();
      expect(sql, dialect).toContain("''");
    }
  });

  test("an unserved dialect is refused with UNSUPPORTED_DIALECT rather than composed on a guess", () => {
    for (const dialect of ["mysql", "oracle", "mssql", "mongodb", "redis"] as const) {
      try {
        composeCatalogRead(dialect, { kind: "statistics" });
        throw new Error(`expected a refusal for ${dialect}`);
      } catch (error) {
        expect(error, dialect).toBeInstanceOf(AgentComposedSqlError);
        expect((error as AgentComposedSqlError).reasonCode, dialect).toBe("UNSUPPORTED_DIALECT");
      }
    }
  });
});

/**
 * `sqlite_stat1` does not exist until an explicit `ANALYZE` has run, and SQLite
 * resolves table names at PREPARE time — so a statement mentioning it cannot
 * degrade gracefully on a database that has never been analysed. The probe is how
 * that case is answered without failing the run; these tests pin it to the engine
 * rather than to the intention.
 */
describe("composeStatisticsAvailabilityProbe", () => {
  test("SQLite gets a sqlite_master probe the guard admits", () => {
    const sql = composeStatisticsAvailabilityProbe("sqlite");

    expect(sql).not.toBeNull();
    expect(sql).toContain("sqlite_master");
    expect(sql).toContain("'sqlite_stat1'");
    expect(agentReadSqlInput.safeParse({ sql }).success).toBe(true);
  });

  test("PostgreSQL needs none, because absence is already expressed in the read itself", () => {
    expect(composeStatisticsAvailabilityProbe("postgres")).toBeNull();
  });

  test("an unserved dialect is refused rather than answered with null", () => {
    try {
      composeStatisticsAvailabilityProbe("mysql");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentComposedSqlError);
      expect((error as AgentComposedSqlError).reasonCode).toBe("UNSUPPORTED_DIALECT");
    }
  });

  /**
   * On a live engine, because the whole design of the SQLite side rests on two
   * facts a textual assertion cannot establish: that the statistics read really
   * does fail on a database nobody has analysed (so the probe is load-bearing, not
   * decoration), and that after `ANALYZE` a table SQLite wrote no statistics for is
   * still returned with a NULL stat instead of vanishing.
   */
  test("the probe answers before ANALYZE, and the read fails without it, on a live engine", () => {
    const database = new Database(":memory:");
    try {
      database.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)");
      database.run("CREATE INDEX orders_total_idx ON orders (total)");
      // No index, so SQLite writes no sqlite_stat1 row for it even after ANALYZE.
      database.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
      database.run("INSERT INTO orders (total) VALUES (1.0), (2.0), (3.0)");

      const probe = composeStatisticsAvailabilityProbe("sqlite") as string;
      expect(database.prepare(probe).all()).toEqual([]);
      // The reason the probe exists: the read is unpreparable, not empty.
      expect(() => database.prepare(composeCatalogRead("sqlite", { kind: "statistics" }))).toThrow(
        "no such table: sqlite_stat1",
      );

      database.run("ANALYZE");

      expect(database.prepare(probe).all()).toEqual([{ name: "sqlite_stat1" }]);
      const rows = database.prepare(composeCatalogRead("sqlite", { kind: "statistics" })).all() as {
        table_name: string;
        index_name: string | null;
        stat: string | null;
      }[];

      // `notes` is present WITHOUT statistics, which is the distinction the reader
      // needs; `orders` carries SQLite's own estimate, whose first field is the row
      // count the engine believes.
      expect(rows).toEqual([
        { table_name: "notes", index_name: null, stat: null },
        { table_name: "orders", index_name: "orders_total_idx", stat: "3 1" },
      ]);
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

  /*
    Measured on 21 calls across 16 optimization runs, 12 of them refused, and at least three
    runs lost outright to it. `qwen3:8b` does it in 9 of its 15 runs on that surface.

    This composer prepends the prefix itself, so `inspect_plan({sql: "EXPLAIN SELECT …"})`
    sent `EXPLAIN QUERY PLAN EXPLAIN SELECT …` and the model was handed one line of SQLite:

        near "EXPLAIN": syntax error

    That is unactionable when the model did not write the outer EXPLAIN, and the shared
    rules then tell it not to retry the same statement. One run tried
    `EXPLAIN QUERY PLAN SELECT …` — the only repair reachable from that message — and got
    the same error. Three runs abandoned the tool and reported nothing.

    The prefix is STRIPPED rather than refused, because the intent is unambiguous: the model
    asked for the plan of a statement and named the operation twice. This layer already
    trims whitespace without asking.
  */
  test("a statement the model already prefixed with the estimating EXPLAIN is not double-prefixed", () => {
    expect(composeEstimatingExplain("sqlite", "EXPLAIN QUERY PLAN SELECT id FROM orders")).toBe(
      "EXPLAIN QUERY PLAN SELECT id FROM orders",
    );
    expect(composeEstimatingExplain("sqlite", "EXPLAIN SELECT id FROM orders")).toBe(
      "EXPLAIN QUERY PLAN SELECT id FROM orders",
    );
    expect(composeEstimatingExplain("postgres", "EXPLAIN SELECT id FROM orders")).toBe(
      "EXPLAIN (FORMAT JSON) SELECT id FROM orders",
    );
    expect(composeEstimatingExplain("postgres", "EXPLAIN (FORMAT JSON) SELECT id FROM orders")).toBe(
      "EXPLAIN (FORMAT JSON) SELECT id FROM orders",
    );
  });

  test("EXPLAIN ANALYZE is left alone, because it asks to EXECUTE", () => {
    // A different request, and one this run may not make. Stripping it would quietly turn a
    // refused execution into an accepted estimate — the guard that refuses it must still see
    // it. Composing here is what puts the word in front of the policy layer.
    expect(composeEstimatingExplain("postgres", "EXPLAIN ANALYZE SELECT id FROM orders")).toContain("ANALYZE");
  });

  test("a statement that merely mentions explain in a value is untouched", () => {
    expect(composeEstimatingExplain("sqlite", "SELECT 'EXPLAIN' AS word FROM orders")).toBe(
      "EXPLAIN QUERY PLAN SELECT 'EXPLAIN' AS word FROM orders",
    );
  });
});

// ============================================================================
// DuckDB (#424 Phase 6)
// ============================================================================

/*
  The DuckDB arms live in this file rather than beside the provider because every
  assertion below RUNS the composed statement against a real embedded DuckDB, and the
  coverage authority for `composed-sql.ts` is this process: a separate test file left
  the string-continuation lines of the four composers reading as uncovered phantoms in
  the merged lcov, because the process that executes them emits no DA record for them
  while every process that merely loads the module does.

  An embedded engine is available in the test process, so a shape assertion alone would
  only prove the composer agrees with itself - and the defect these arms exist to fix
  was exactly that kind of agreement. DuckDB reached `AGENT_EXECUTION_ENGINES` with NO
  entry in `CATALOG_COMPOSERS`, so `POST /api/agent/runs` accepted the
  `query-optimization` and `database-assessment` workflows on it while `inspect_schema`,
  `profile_table` and `inspect_plan` could only ever refuse.

  Gate 4 pin: DuckDB v1.5.5 via @duckdb/node-api 1.5.5-r.4. The fixture carries the two
  shapes that broke the other engines' catalog reads - a COMPOSITE foreign key (B8's
  cross-product) and a constraint-backed index carrying no DDL text (B25) - so a
  regression in either shows up as wrong rows rather than as a passing string test.
*/

let workDir: string;
let connection: { runAndReadAll: (sql: string) => Promise<{ getRowObjectsJson: () => unknown[] }> };
let closeAll: () => void;

/** Runs a composed statement on the fixture and hands back its rows as plain JSON. */
async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const result = await connection.runAndReadAll(sql);
  return result.getRowObjectsJson() as Record<string, unknown>[];
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "libredb-duckdb-composer-"));
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(join(workDir, "fixture.duckdb"));
  const open = await instance.connect();
  connection = open;
  closeAll = () => {
    open.disconnectSync();
    instance.closeSync();
  };

  await open.run("CREATE SCHEMA sales");
  // A composite primary key on the parent, so the composite foreign key below has
  // something to reference: DuckDB requires the referenced columns to carry one.
  await open.run("CREATE TABLE pair_parent(a INTEGER, b INTEGER, PRIMARY KEY (a, b))");
  await open.run(
    "CREATE TABLE child(x INTEGER, y INTEGER, note VARCHAR, FOREIGN KEY (x, y) REFERENCES pair_parent(a, b))",
  );
  await open.run("CREATE TABLE sales.orders(id INTEGER PRIMARY KEY, sku VARCHAR UNIQUE)");
  await open.run("CREATE INDEX idx_child_note ON child(note)");
  await open.run("INSERT INTO pair_parent VALUES (1, 2)");
  await open.run("INSERT INTO child VALUES (1, 2, 'n')");
});

afterAll(() => {
  closeAll?.();
  rmSync(workDir, { recursive: true, force: true });
});

describe("composeCatalogRead — DuckDB columns", () => {
  test("reads duckdb_columns() rather than information_schema, and answers on a live engine", async () => {
    const sql = composeCatalogRead("duckdb", {});

    expect(guardAccepts(sql)).toBe(true);
    expect(sql).toContain("duckdb_columns()");
    expect(sql).not.toContain("information_schema");

    const inventory = await rows(sql);
    expect(inventory.length).toBeGreaterThan(0);
    for (const projected of [
      "table_schema",
      "table_name",
      "column_name",
      "data_type",
      "is_nullable",
      "ordinal_position",
    ]) {
      expect(Object.keys(inventory[0] as object), projected).toContain(projected);
    }
  });

  /**
   * The trap this bounding exists for: `duckdb_schemas().internal` is TRUE for `main`
   * even in a user database, so `NOT internal` alone would drop the default schema.
   * `database_name = current_database()` is what excludes the `system` and `temp`
   * catalogs instead, and the assertion is the ROWS rather than the clause - a reader
   * cannot tell from the SQL text whether the bound actually holds.
   */
  test("lists both user schemas and no engine catalog", async () => {
    const schemas = new Set((await rows(composeCatalogRead("duckdb", {}))).map((row) => row.table_schema));

    expect(schemas.has("main")).toBe(true);
    expect(schemas.has("sales")).toBe(true);
    expect(schemas.has("information_schema")).toBe(false);
    expect(schemas.has("pg_catalog")).toBe(false);
  });

  test("narrows on a schema selector, and the narrowing is what the engine returns", async () => {
    const sql = composeCatalogRead("duckdb", { schema: "sales" });

    expect(sql).toContain("schema_name = 'sales'");
    const schemas = new Set((await rows(sql)).map((row) => row.table_schema));
    expect([...schemas]).toEqual(["sales"]);
  });

  test("narrows on a table selector", async () => {
    const sql = composeCatalogRead("duckdb", { table: "child" });

    expect(sql).toContain("table_name = 'child'");
    const names = new Set((await rows(sql)).map((row) => row.table_name));
    expect([...names]).toEqual(["child"]);
  });

  test("orders the rows, so two identical inventories serialise identically", () => {
    expect(composeCatalogRead("duckdb", {})).toContain("ORDER BY");
  });
});

describe("composeCatalogRead — DuckDB relations", () => {
  /**
   * B8's defect, on this engine's own catalog. `duckdb_constraints()` publishes both
   * sides as LISTS and DuckDB has no `WITH ORDINALITY`, so unnesting the two
   * independently would produce the cross-product: four rows for a two-column key,
   * two of them pairing columns that were never declared together. One shared ordinal
   * from `generate_series` is what pairs them, and the row count is the proof.
   */
  test("a composite foreign key is two edges and not four", async () => {
    const sql = composeCatalogRead("duckdb", { kind: "relations" });

    expect(guardAccepts(sql)).toBe(true);
    const edges = await rows(sql);

    expect(edges).toHaveLength(2);
    expect(edges.map((edge) => [edge.column_name, edge.referenced_column])).toEqual([
      ["x", "a"],
      ["y", "b"],
    ]);
    for (const edge of edges) {
      expect(edge.table_name).toBe("child");
      expect(edge.referenced_table).toBe("pair_parent");
      expect(edge.referenced_schema).toBe("main");
    }
  });

  test("carries the same six projected names as the PostgreSQL read, so one reader folds both", async () => {
    const edge = (await rows(composeCatalogRead("duckdb", { kind: "relations" })))[0] as object;

    expect(Object.keys(edge).sort()).toEqual(
      [
        "column_name",
        "referenced_column",
        "referenced_schema",
        "referenced_table",
        "table_name",
        "table_schema",
      ].sort(),
    );
  });

  test("narrows on a table selector", async () => {
    const edges = await rows(composeCatalogRead("duckdb", { kind: "relations", table: "pair_parent" }));

    // pair_parent is the REFERENCED side, never the referencing one, so narrowing by
    // it is empty rather than the parent's own edges - the same reading the other
    // engines give, and the reason the selector names the referencing table.
    expect(edges).toEqual([]);
  });
});

describe("composeCatalogRead — DuckDB indexes", () => {
  /**
   * B25's hole, measured here: `duckdb_indexes()` lists ONLY indexes somebody wrote a
   * `CREATE INDEX` for. The ART index a `PRIMARY KEY` or `UNIQUE` constraint builds is
   * used by the planner and appears nowhere in it, so a foreign key covered by a unique
   * constraint would read as unindexed. It also carries the only primary-key
   * information on this engine's agent path, since the column read publishes no
   * `is_primary`.
   */
  test("the union carries constraint-backed indexes duckdb_indexes() does not list", async () => {
    const sql = composeCatalogRead("duckdb", { kind: "indexes" });

    expect(guardAccepts(sql)).toBe(true);
    const inventory = await rows(sql);
    const written = inventory.filter((row) => row.index_name === "idx_child_note");
    const primary = inventory.filter((row) => row.is_primary === true);
    const unique = inventory.filter((row) => row.is_unique === true && row.is_primary === false);

    expect(written).toHaveLength(1);
    expect(written[0]?.is_unique).toBe(false);
    // The composite primary key is two rows, in its declared order.
    expect(primary.map((row) => row.column_name)).toEqual(["a", "b", "id"]);
    expect(unique.map((row) => row.column_name)).toEqual(["sku"]);
  });

  test("a composite index reads in its own column order, not alphabetically", async () => {
    const inventory = await rows(composeCatalogRead("duckdb", { kind: "indexes", table: "pair_parent" }));

    expect(inventory.map((row) => [row.ordinal_position, row.column_name])).toEqual([
      ["1", "a"],
      ["2", "b"],
    ]);
  });

  test("the narrowing reaches BOTH halves of the union", async () => {
    const sql = composeCatalogRead("duckdb", { kind: "indexes", schema: "sales" });
    const inventory = await rows(sql);

    // Two arms, one narrowing each: if only the first carried it, main's rows would
    // arrive through the constraint-backed half.
    expect(new Set(inventory.map((row) => row.table_schema))).toEqual(new Set(["sales"]));
    expect(inventory.length).toBeGreaterThan(0);
  });
});

describe("composeCatalogRead — DuckDB statistics", () => {
  test("reads the estimate the catalog already holds and scans nothing", async () => {
    const sql = composeCatalogRead("duckdb", { kind: "statistics" });

    expect(guardAccepts(sql)).toBe(true);
    expect(sql).toContain("duckdb_tables()");
    expect(sql).toContain("estimated_size AS estimated_rows");
    // A scan is what this composition exists to avoid, and ANALYZE is a write.
    expect(sql.toUpperCase()).not.toContain("COUNT(");
    expect(sql.toUpperCase()).not.toContain("ANALYZE");

    const inventory = await rows(sql);
    expect(inventory.map((row) => `${row.table_schema}.${row.table_name}`)).toEqual([
      "main.child",
      "main.pair_parent",
      "sales.orders",
    ]);
  });

  test("narrows on both selectors together", async () => {
    const inventory = await rows(
      composeCatalogRead("duckdb", { kind: "statistics", schema: "sales", table: "orders" }),
    );

    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.table_name).toBe("orders");
  });
});

describe("DuckDB composed SQL — the contracts every arm shares", () => {
  const KINDS = ["columns", "relations", "indexes", "statistics"] as const;

  test("every kind satisfies the bounded-read guard and the descriptor's input schema", () => {
    for (const kind of KINDS) {
      const sql = composeCatalogRead("duckdb", { kind });
      expect(inspectAgentStatement(sql), kind).toBeNull();
      expect(agentReadSqlInput.safeParse({ sql }).success, kind).toBe(true);
    }
  });

  /**
   * A hostile selector must become a quoted LITERAL rather than statement text, and the
   * engine is the only witness that can settle it: the statement below runs, and the
   * table it names would be gone if the quoting had failed.
   */
  test("a hostile selector is a literal on every kind, and the live engine agrees", async () => {
    for (const kind of KINDS) {
      const sql = composeCatalogRead("duckdb", { kind, table: "orders'; DROP TABLE child --" });

      expect(inspectAgentStatement(sql), kind).toBeNull();
      expect(sql, kind).toContain("''");
      expect(await rows(sql), kind).toEqual([]);
    }

    const survivors = await rows("SELECT table_name FROM duckdb_tables() WHERE table_name = 'child'");
    expect(survivors).toHaveLength(1);
  });
});

describe("composeEstimatingExplain — DuckDB", () => {
  /**
   * The estimating form is the ONLY one this layer will compose for DuckDB, and the
   * reason is measured rather than stylistic: `EXPLAIN ANALYZE` RUNS the statement on
   * v1.5.5 (a probe table went from 0 rows to 1), and its JSON variant answers
   * `{"result": "error"}` instead of a plan. A later DuckDB fixing that JSON makes the
   * hazard worse, not better.
   */
  test("gets the estimating form, and it describes without running", async () => {
    const sql = composeEstimatingExplain("duckdb", "SELECT id FROM sales.orders");

    expect(sql).toBe("EXPLAIN (FORMAT JSON) SELECT id FROM sales.orders");
    expect(sql.toUpperCase()).not.toContain("ANALYZE");
    expect(agentReadSqlInput.safeParse({ sql }).success).toBe(true);

    const plan = await rows(sql);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.explain_key).toBe("physical_plan");
    expect(JSON.parse(String(plan[0]?.explain_value))).toBeArray();
  });

  test("an INSERT the model smuggled in is refused by the guard rather than explained", () => {
    const sql = composeEstimatingExplain("duckdb", "INSERT INTO child VALUES (9, 9, 'x')");

    expect(agentReadSqlInput.safeParse({ sql }).success).toBe(false);
    expect(inspectAgentStatement(sql)).toBe("SIDE_EFFECT_KEYWORD");
  });
});

describe("the composers are reachable, which is the defect that put this file here", () => {
  /**
   * The four DuckDB functions existed and were never registered in `CATALOG_COMPOSERS`,
   * so they were dead code that typecheck, lint and the whole test suite all passed
   * over - only the 100% line-coverage gate saw them. This test fails if the
   * registration is removed again, whatever the functions themselves still say.
   */
  test("every kind composes rather than refusing UNSUPPORTED_DIALECT", () => {
    for (const kind of ["columns", "relations", "indexes", "statistics"] as const) {
      expect(() => composeCatalogRead("duckdb", { kind }), kind).not.toThrow(AgentComposedSqlError);
    }
    expect(() => composeEstimatingExplain("duckdb", "SELECT 1")).not.toThrow(AgentComposedSqlError);
  });
});
