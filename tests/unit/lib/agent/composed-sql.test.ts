import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  AgentComposedSqlError,
  composeCatalogRead,
  composeEstimatingExplain,
  composeStatisticsAvailabilityProbe,
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

describe("composeCatalogRead — the relation and index inventories (#329 T8)", () => {
  /**
   * The foreign-key read leaves `information_schema` for `pg_constraint`, and every
   * assertion below is a property measured on a live PostgreSQL 18 rather than a
   * shape that reads well (`docs/BACKLOG.md` B8, B44):
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
   * The expression case, measured on the same live server (`docs/BACKLOG.md` B7).
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
});
