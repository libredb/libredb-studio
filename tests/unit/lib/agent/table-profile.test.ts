import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { parseSqliteTableDdl } from "@/lib/agent/sqlite-ddl";
import {
  DIGIT_RUN_LENGTH,
  HIGH_NULL_RATIO,
  MIN_ROWS_FOR_RATIO_FINDINGS,
  composeTableProfile,
  findUnindexedForeignKeys,
  readTableProfile,
} from "@/lib/agent/table-profile";
import { inspectAgentStatement } from "@/lib/db/operations/statement-guard";
import type { ColumnSchema } from "@/lib/types";
import type { AgentInventoryObject } from "@/lib/agent/types";

/**
 * Bounded per-table profiling (#330 T3).
 *
 * The invariant the whole module exists to hold is asserted first and repeatedly:
 * **a profile records counts, never values.** Every composed aggregate is a
 * `count(...)`, and no test here can produce a statement that would return a name,
 * an address or an account number — which is what makes profiling a table of
 * personal data acceptable at all.
 */

const column = (name: string, type = "text"): ColumnSchema => ({ name, type, nullable: true, isPrimary: false });

const COLUMNS: ColumnSchema[] = [column("id", "integer"), column("email", "character varying"), column("status")];

describe("the composed statement", () => {
  test.each(["postgres", "sqlite", "mssql"] as const)(
    "%s: passes the same statement guard a model-drafted read does",
    (dialect) => {
      for (const depth of ["basic", "distribution", "pattern"] as const) {
        const sql = composeTableProfile(dialect, { segments: ["employee"], depth }, COLUMNS);
        expect(inspectAgentStatement(sql), `${dialect}/${depth}`).toBeNull();
      }
    },
  );

  test("every projected expression is a count, so no value can come back", () => {
    const sql = composeTableProfile("postgres", { segments: ["employee"], depth: "pattern" }, COLUMNS);
    const projection = sql.slice("SELECT ".length, sql.indexOf(" FROM "));

    for (const part of projection.split(", ")) expect(part.startsWith("count("), part).toBe(true);
    // The conventional profiler statistics that WOULD return a value.
    expect(sql).not.toContain("min(");
    expect(sql).not.toContain("max(");
  });

  test("deepening adds aggregates rather than replacing them", () => {
    const basic = composeTableProfile("postgres", { segments: ["t"], depth: "basic" }, COLUMNS);
    const distribution = composeTableProfile("postgres", { segments: ["t"], depth: "distribution" }, COLUMNS);
    const pattern = composeTableProfile("postgres", { segments: ["t"], depth: "pattern" }, COLUMNS);

    expect(basic).not.toContain("DISTINCT");
    expect(distribution).toContain("count(DISTINCT");
    expect(distribution).not.toContain("LIKE");
    expect(pattern).toContain("LIKE");
  });

  test("the shape tests are applied only to columns whose declared type is textual", () => {
    // Comparing an integer column to a string pattern is an error on PostgreSQL,
    // and casting every column to text would turn a bounded read into a full
    // conversion of the table.
    const sql = composeTableProfile("postgres", { segments: ["t"], depth: "pattern" }, COLUMNS);

    expect(sql).toContain('count(CASE WHEN "email" LIKE');
    expect(sql).not.toContain('count(CASE WHEN "id" LIKE');
    expect(sql).toContain('count(CASE WHEN "email" ~ ');
    expect(sql).not.toContain('count(CASE WHEN "id" ~ ');
  });

  // B26: `LIKE` cannot express a run of digits — `_` means "any character", so a
  // length test would match almost any text. Each engine spells it its own way, and
  // both spellings were run against a live engine; see the live-execution test
  // below and the module comment for the PostgreSQL 18 measurement.
  test("the digit-run test is the dialect's own operator, not a shared LIKE", () => {
    const postgres = composeTableProfile("postgres", { segments: ["t"], depth: "pattern" }, COLUMNS);
    const sqlite = composeTableProfile("sqlite", { segments: ["t"], depth: "pattern" }, COLUMNS);

    expect(postgres).toContain(`"email" ~ '[0-9]{${DIGIT_RUN_LENGTH},}'`);
    expect(postgres).not.toContain("GLOB");
    expect(sqlite).toContain(`"email" GLOB '*${"[0-9]".repeat(DIGIT_RUN_LENGTH)}*'`);
    expect(sqlite).not.toContain(" ~ ");
  });

  test("both shape tests still project a count and nothing else on every dialect", () => {
    for (const dialect of ["postgres", "sqlite", "mssql"] as const) {
      const sql = composeTableProfile(dialect, { segments: ["t"], depth: "pattern" }, COLUMNS);
      const projection = sql.slice("SELECT ".length, sql.indexOf(" FROM "));

      for (const part of projection.split(", ")) expect(part.startsWith("count("), `${dialect}: ${part}`).toBe(true);
      expect(inspectAgentStatement(sql), dialect).toBeNull();
    }
  });

  test("an identifier carrying the closing quote is escaped, not interpolated", () => {
    const sql = composeTableProfile("postgres", { segments: ['we"ird'], depth: "basic" }, [column('c"1')]);

    expect(sql).toContain('"we""ird"');
    expect(sql).toContain('"c""1"');
    expect(inspectAgentStatement(sql)).toBeNull();
  });

  test("a schema is qualified when given and omitted when not", () => {
    expect(composeTableProfile("postgres", { segments: ["public", "t"], depth: "basic" }, COLUMNS)).toContain(
      'FROM "public"."t"',
    );
    expect(composeTableProfile("sqlite", { segments: ["t"], depth: "basic" }, COLUMNS)).toContain('FROM "t"');
  });

  /**
   * The target is EVERY segment of the resolved address, each quoted on its own (#789).
   *
   * It was a schema and a table, and that pair is enough for the two dialects composed here
   * and for nothing else. The address a resolution now produces is as deep as the object
   * read made it, and joining the leading segments into one string before quoting them
   * composes `"shop.sales"."orders"`: a single identifier no engine holds, built out of two
   * that it does. A refusal would be safe; a fabricated identifier is not, so the shape that
   * can only ever be right is one quoted segment per segment.
   */
  test("every leading segment is quoted on its own, never joined into one identifier", () => {
    const sql = composeTableProfile("postgres", { segments: ["shop", "sales", "orders"], depth: "basic" }, COLUMNS);
    expect(sql).toContain('FROM "shop"."sales"."orders"');
    expect(sql).not.toContain('"shop.sales"');
  });

  test("an address with no segments at all is refused rather than composed", () => {
    expect(() => composeTableProfile("postgres", { segments: [], depth: "basic" }, COLUMNS)).toThrow(/usable length/);
  });

  test("an unverified dialect and an empty column list are refused rather than composed", () => {
    expect(() => composeTableProfile("oracle", { segments: ["t"], depth: "basic" }, COLUMNS)).toThrow(
      /no verified profile/,
    );
    expect(() => composeTableProfile("postgres", { segments: ["t"], depth: "basic" }, [])).toThrow(/no columns/);
    expect(() => composeTableProfile("postgres", { segments: ["  "], depth: "basic" }, COLUMNS)).toThrow(
      /usable length/,
    );
  });
});

describe("reading the aggregate row back", () => {
  const row = (values: Record<string, unknown>) => [values];

  test("a driver's bigint and node-postgres's numeric string both read as counts", () => {
    // `count()` comes back as a bigint on some drivers, and node-postgres returns
    // int8 as text to avoid losing precision.
    const profile = readTableProfile("t", "basic", [column("a")], row({ row_count: "40", present_0: BigInt(40) }));

    expect(profile?.rowCount).toBe(40);
    expect(profile?.columns[0]?.present).toBe(40);
  });

  test("a statistic the engine did not report is absent, never zero", () => {
    const profile = readTableProfile("t", "basic", [column("a")], row({ row_count: 10, present_0: 10 }));

    expect(profile?.columns[0]?.distinct).toBeUndefined();
    expect(profile?.columns[0]?.shaped).toBeUndefined();
    expect(profile?.columns[0]?.digitRun).toBeUndefined();
  });

  test("a result with no row, or no row count, is unreadable rather than a profile of nothing", () => {
    expect(readTableProfile("t", "basic", [column("a")], [])).toBeNull();
    expect(readTableProfile("t", "basic", [column("a")], row({ present_0: 3 }))).toBeNull();
  });
});

describe("the findings, derived from the numbers", () => {
  const codes = (profile: ReturnType<typeof readTableProfile>) => profile?.findings.map((f) => f.code) ?? [];

  test("a mostly empty column is high_null, with the ratio in the app's own words", () => {
    const rows = MIN_ROWS_FOR_RATIO_FINDINGS * 5;
    const profile = readTableProfile(
      "t",
      "basic",
      [column("note")],
      [{ row_count: rows, present_0: Math.floor(rows * (1 - HIGH_NULL_RATIO)) - 1 }],
    );

    expect(codes(profile)).toContain("high_null");
    expect(profile?.findings[0]?.detail).toMatch(/% of \d+ rows have no value/);
  });

  test("a sparse column in a tiny table is not reported, because the ratio would say more about the sample", () => {
    const profile = readTableProfile("t", "basic", [column("note")], [{ row_count: 4, present_0: 0 }]);

    expect(codes(profile)).toEqual([]);
  });

  test("one distinct value across many rows is constant, not low cardinality", () => {
    const profile = readTableProfile(
      "t",
      "distribution",
      [column("flag")],
      [{ row_count: 500, present_0: 500, distinct_0: 1 }],
    );

    expect(codes(profile)).toEqual(["constant"]);
  });

  test("a handful of values across many rows is low_cardinality", () => {
    const profile = readTableProfile(
      "t",
      "distribution",
      [column("status")],
      [{ row_count: 5000, present_0: 5000, distinct_0: 3 }],
    );

    expect(codes(profile)).toEqual(["low_cardinality"]);
  });

  test("a column named like personal data is suspected, and the finding says its values were not read", () => {
    const profile = readTableProfile("t", "basic", [column("email_address")], [{ row_count: 10, present_0: 10 }]);

    expect(codes(profile)).toEqual(["suspected_pii"]);
    expect(profile?.findings[0]?.detail).toContain("values were not inspected");
  });

  test("a column whose values are mostly email-shaped is suspected even when its name says nothing", () => {
    const profile = readTableProfile(
      "t",
      "pattern",
      [column("col_7")],
      [{ row_count: 100, present_0: 100, distinct_0: 100, shaped_0: 99 }],
    );

    expect(codes(profile)).toEqual(["suspected_pii"]);
    // Still no value: the ratio was computed inside the database.
    expect(profile?.findings[0]?.detail).toContain("No value was read out of the database");
  });

  test("a column whose values are mostly digit runs is suspected, and the finding names that shape", () => {
    const profile = readTableProfile(
      "t",
      "pattern",
      [column("col_7")],
      [{ row_count: 100, present_0: 100, distinct_0: 100, shaped_0: 0, digits_0: 96 }],
    );

    expect(codes(profile)).toEqual(["suspected_pii"]);
    expect(profile?.findings[0]?.detail).toContain(`a run of ${DIGIT_RUN_LENGTH} or more digits`);
    expect(profile?.findings[0]?.detail).not.toContain("email");
    expect(profile?.findings[0]?.detail).toContain("No value was read out of the database");
  });

  test("a column matching both shapes reports one finding naming both", () => {
    const profile = readTableProfile(
      "t",
      "pattern",
      [column("col_7")],
      [{ row_count: 100, present_0: 100, distinct_0: 100, shaped_0: 80, digits_0: 70 }],
    );

    expect(codes(profile)).toEqual(["suspected_pii"]);
    expect(profile?.findings[0]?.detail).toContain("an email address");
    expect(profile?.findings[0]?.detail).toContain(`a run of ${DIGIT_RUN_LENGTH} or more digits`);
  });

  test("a column with a few incidental digit runs is not suspected on that ground", () => {
    const profile = readTableProfile(
      "t",
      "pattern",
      [column("col_7")],
      [{ row_count: 100, present_0: 100, distinct_0: 100, shaped_0: 1, digits_0: 3 }],
    );

    expect(codes(profile)).toEqual([]);
  });

  test("a column with a few incidental matches is not suspected", () => {
    const profile = readTableProfile(
      "t",
      "pattern",
      [column("col_7")],
      [{ row_count: 100, present_0: 100, distinct_0: 100, shaped_0: 2 }],
    );

    expect(codes(profile)).toEqual([]);
  });

  test("no finding carries a value, only counts and the app's own words", () => {
    const profile = readTableProfile(
      "t",
      "pattern",
      [column("email")],
      [{ row_count: 100, present_0: 40, distinct_0: 2, shaped_0: 40 }],
    );

    for (const finding of profile?.findings ?? []) {
      expect(finding.detail).not.toContain("@");
    }
  });
});

describe("foreign keys with no covering index", () => {
  const table = (overrides: Partial<AgentInventoryObject>): AgentInventoryObject => ({
    name: "orders",
    columns: [column("id", "integer"), column("customer_id", "integer")],
    indexes: [],
    ...overrides,
  });

  test("an uncovered foreign key is reported, in words that say what was actually checked", () => {
    const findings = findUnindexedForeignKeys(
      table({ foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }] }),
    );

    expect(findings.map((f) => f.code)).toEqual(["fk_unindexed"]);
    // Not "this foreign key is unindexed": the inventory has known blind spots.
    expect(findings[0]?.detail).toContain("in the captured inventory");
  });

  test("an index LEADING on the column covers it; one that merely mentions it does not", () => {
    const covered = findUnindexedForeignKeys(
      table({
        indexes: [{ name: "ix", columns: ["customer_id", "created_at"], unique: false }],
        foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
      }),
    );
    const trailing = findUnindexedForeignKeys(
      table({
        indexes: [{ name: "ix", columns: ["created_at", "customer_id"], unique: false }],
        foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
      }),
    );

    expect(covered).toEqual([]);
    expect(trailing.map((f) => f.code)).toEqual(["fk_unindexed"]);
  });

  test("a primary-key column is covered without an index row of its own", () => {
    const findings = findUnindexedForeignKeys(
      table({
        columns: [{ name: "customer_id", type: "integer", nullable: false, isPrimary: true }],
        foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
      }),
    );

    expect(findings).toEqual([]);
  });

  test("a composite key is SKIPPED rather than guessed at", () => {
    // PostgreSQL's catalog read returns a composite foreign key as the cross
    // product of both sides (#463), so its columns cannot be
    // regrouped into the key they belong to — and a covering test over the wrong
    // grouping would be an answer about a key that does not exist.
    const findings = findUnindexedForeignKeys(
      table({
        foreignKeys: [
          { columnName: "a", referencedTable: "parents", referencedColumn: "x" },
          { columnName: "b", referencedTable: "parents", referencedColumn: "y" },
        ],
      }),
    );

    expect(findings).toEqual([]);
  });

  test("a table with no foreign keys at all reports nothing", () => {
    expect(findUnindexedForeignKeys(table({}))).toEqual([]);
  });

  test("the same column named twice is reported once", () => {
    const findings = findUnindexedForeignKeys(
      table({
        foreignKeys: [
          { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
          { columnName: "customer_id", referencedTable: "buyers", referencedColumn: "id" },
        ],
      }),
    );

    expect(findings).toHaveLength(1);
  });
});

describe("types with no equality operator", () => {
  // Found by review on #345. PostgreSQL answers `could not identify an equality
  // operator for type json`, and one unsupported column aborts the WHOLE aggregate —
  // so a single json column would have failed distribution and pattern profiling for
  // every other column in the table.
  test.each(["json", "jsonb", "xml", "point", "polygon"])("%s gets no distinct count", (type) => {
    const sql = composeTableProfile("postgres", { segments: ["t"], depth: "distribution" }, [
      column("payload", type),
      column("name", "text"),
    ]);

    expect(sql).not.toContain('count(DISTINCT "payload")');
    // And the comparable column beside it is still counted.
    expect(sql).toContain('count(DISTINCT "name")');
  });

  test("a skipped distinct count reads as absent rather than zero", () => {
    // Which is exactly true: the engine was never asked.
    const profile = readTableProfile(
      "t",
      "distribution",
      [column("payload", "jsonb")],
      [{ row_count: 10, present_0: 10 }],
    );

    expect(profile?.columns[0]?.distinct).toBeUndefined();
    expect(profile?.findings).toEqual([]);
  });

  test("presence is still counted for a type nothing can compare", () => {
    const sql = composeTableProfile("postgres", { segments: ["t"], depth: "distribution" }, [
      column("payload", "json"),
    ]);

    expect(sql).toContain('count("payload")');
  });
});

describe("a foreign key covered by a constraint-created index (#502)", () => {
  /**
   * The SQLite blind spot, end to end and against a real engine.
   *
   * SQLite stores NO DDL for the index it builds to enforce a `UNIQUE` constraint,
   * so the composed index read (`sql IS NOT NULL`) returns nothing for it and the
   * key looked uncovered. The covering index is declared in the table's own DDL, so
   * the inventory is assembled here exactly as the SQLite capture assembles it —
   * columns, foreign keys AND constraint-created indexes all out of one
   * `CREATE TABLE` — and the control table proves the finding still fires when
   * there really is no index.
   */
  const inventory = (statements: readonly string[], name: string): AgentInventoryObject => {
    const database = new Database(":memory:");
    try {
      for (const statement of statements) database.run(statement);
      const row = database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string };
      const definition = parseSqliteTableDdl(row.sql);
      return {
        name,
        columns: [...definition.columns],
        indexes: [...definition.indexes],
        foreignKeys: [...definition.foreignKeys],
      };
    } finally {
      database.close();
    }
  };

  const SCHEMA = [
    "CREATE TABLE parents (id INTEGER PRIMARY KEY)",
    "CREATE TABLE covered (id INTEGER PRIMARY KEY, parent_id INTEGER UNIQUE REFERENCES parents (id))",
    "CREATE TABLE composite (id INTEGER PRIMARY KEY, parent_id INTEGER, note TEXT, UNIQUE (parent_id, note), FOREIGN KEY (parent_id) REFERENCES parents (id))",
    "CREATE TABLE trailing (id INTEGER PRIMARY KEY, note TEXT, parent_id INTEGER, UNIQUE (note, parent_id), FOREIGN KEY (parent_id) REFERENCES parents (id))",
    "CREATE TABLE bare (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents (id))",
  ];

  test("a UNIQUE constraint covers the key, and the covering index is not presented as a user index", () => {
    const table = inventory(SCHEMA, "covered");

    expect(findUnindexedForeignKeys(table)).toEqual([]);
    expect(table.indexes.map((index) => index.name)).toEqual(["(unique constraint)"]);
  });

  test("a composite UNIQUE covers the key it LEADS on, and not one it merely mentions", () => {
    expect(findUnindexedForeignKeys(inventory(SCHEMA, "composite"))).toEqual([]);
    // Prefix, not membership: `UNIQUE (note, parent_id)` cannot serve a lookup on
    // `parent_id` alone, so the finding stands.
    expect(findUnindexedForeignKeys(inventory(SCHEMA, "trailing")).map((f) => f.code)).toEqual(["fk_unindexed"]);
  });

  test("the control: a key with no index at all is still reported", () => {
    expect(findUnindexedForeignKeys(inventory(SCHEMA, "bare")).map((f) => f.code)).toEqual(["fk_unindexed"]);
  });
});

describe("the shape tests against a live engine", () => {
  /**
   * The composed `pattern` statement, executed by SQLite itself.
   *
   * The point is the GRAMMAR: `GLOB '*[0-9]…*'` is SQLite's spelling of a digit run
   * and `~ '[0-9]{9,}'` is PostgreSQL's, so neither can be established by reading the
   * composed string. This runs the SQLite arm end to end — compose, execute, read
   * back, derive findings. The PostgreSQL arm was run the same way against a live
   * PostgreSQL 18 and returned the same counts for the same rows; the measurement is
   * recorded beside the predicate in `src/lib/agent/table-profile.ts`.
   */
  const COLUMNS_LIVE: ColumnSchema[] = [column("id", "integer"), column("contact"), column("note")];

  const profileLive = (rows: readonly (readonly [number, string | null, string])[]) => {
    const database = new Database(":memory:");
    try {
      database.run('CREATE TABLE "people" (id INTEGER, contact TEXT, note TEXT)');
      for (const row of rows) database.run('INSERT INTO "people" VALUES (?, ?, ?)', row as never);

      const sql = composeTableProfile("sqlite", { segments: ["people"], depth: "pattern" }, COLUMNS_LIVE);
      const aggregate = database.query(sql).get() as Record<string, unknown>;
      return readTableProfile("people", "pattern", COLUMNS_LIVE, [aggregate]);
    } finally {
      database.close();
    }
  };

  test("a column of national ids is counted as a digit run and suspected; a column of prose is not", () => {
    // 24 rows, so the ratio findings apply at all (MIN_ROWS_FOR_RATIO_FINDINGS).
    const rows = Array.from({ length: 24 }, (_, index) => {
      const id = `1234567${String(index).padStart(2, "0")}`;
      return [index, id, `note number ${index}`] as const;
    });

    const profile = profileLive(rows);

    expect(profile?.rowCount).toBe(24);
    // Nine consecutive digits in every `contact`, none in a `note` — SQLite agrees.
    expect(profile?.columns[1]?.digitRun).toBe(24);
    expect(profile?.columns[2]?.digitRun).toBe(0);
    expect(profile?.columns[1]?.shaped).toBe(0);

    const suspected = profile?.findings.filter((finding) => finding.code === "suspected_pii") ?? [];
    expect(suspected.map((finding) => finding.column)).toEqual(["contact"]);
    expect(suspected[0]?.detail).toContain(`a run of ${DIGIT_RUN_LENGTH} or more digits`);
  });

  test("a run one digit short of the bound does not match, so a year or a price is not a suspicion", () => {
    // Eight digits, and a four-digit year in the note.
    const rows = Array.from({ length: 24 }, (_, index) => [index, `1234567${index % 10}`, "sold in 2026"] as const);

    const profile = profileLive(rows);

    expect(profile?.columns[1]?.digitRun).toBe(0);
    expect(profile?.columns[2]?.digitRun).toBe(0);
    expect(profile?.findings.map((finding) => finding.code)).not.toContain("suspected_pii");
  });

  test("the email shape still matches on the live engine, beside the digit run", () => {
    const rows = Array.from({ length: 24 }, (_, index) => [index, `user${index}@example.com`, "hello"] as const);

    const profile = profileLive(rows);

    expect(profile?.columns[1]?.shaped).toBe(24);
    expect(profile?.columns[1]?.digitRun).toBe(0);
    expect(profile?.findings.filter((finding) => finding.code === "suspected_pii")[0]?.detail).toContain(
      "an email address",
    );
  });
});

/**
 * The SQL Server arm, pinned rather than covered incidentally.
 *
 * Every test above this block runs `postgres` or `sqlite`, so the mssql predicates,
 * the per-dialect incomparable map and the bracket quoting were only ever executed as
 * a by-product of the 100% line gate: every line ran, and nothing asserted what any of
 * them produced. The cases here assert the composed text literally, and each exclusion
 * carries the engine's own refusal as its reason. All of them were measured on
 * SQL Server 2022 CU26 against AdventureWorks2022 before they were written down.
 */
describe("the SQL Server arm of the composition", () => {
  test("the digit run is spelled as nine repeated T-SQL character classes, not a regex", () => {
    // T-SQL has no regular expressions and no GLOB, and its LIKE has no quantifier,
    // so the run is nine `[0-9]`s between two `%`s. Asserted literally, because a
    // count of classes could pass while the spelling was wrong.
    const sql = composeTableProfile("mssql", { segments: ["t"], depth: "pattern" }, COLUMNS);

    expect(sql).toContain("[email] LIKE '%[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]%'");
    expect(sql).not.toContain("GLOB");
    expect(sql).not.toContain(" ~ ");
  });

  test("the email shape is the same LIKE all three dialects spell alike", () => {
    const sql = composeTableProfile("mssql", { segments: ["t"], depth: "pattern" }, COLUMNS);

    expect(sql).toContain("count(CASE WHEN [email] LIKE '%_@_%._%' THEN 1 END)");
    // And the integer column beside it gets neither shape test.
    expect(sql).not.toContain("[id] LIKE");
  });

  test("every segment of a three-part address is bracket-quoted on its own", () => {
    const sql = composeTableProfile(
      "mssql",
      { segments: ["AdventureWorks2022", "Person", "PersonPhone"], depth: "basic" },
      COLUMNS,
    );

    expect(sql).toContain("FROM [AdventureWorks2022].[Person].[PersonPhone]");
    expect(sql).not.toContain("[AdventureWorks2022.Person]");
  });

  test("a closing bracket in an identifier is escaped, not interpolated", () => {
    // Typed `nvarchar` rather than the file's default `text`, which SQL Server will
    // not count at all and which is therefore left out of the projection.
    const sql = composeTableProfile("mssql", { segments: ["we]ird"], depth: "basic" }, [column("c]1", "nvarchar")]);

    expect(sql).toContain("[we]]ird]");
    expect(sql).toContain("[c]]1]");
    expect(inspectAgentStatement(sql)).toBeNull();
  });

  // Msg 8117, "Operand data type text is invalid for count operator", for a PLAIN
  // count on each of the three. One such column in the projection fails the single
  // aggregate, so it would cost the whole table its profile.
  test.each(["text", "ntext", "image"])("a %s column is left out of the projection entirely", (type) => {
    const sql = composeTableProfile("mssql", { segments: ["t"], depth: "pattern" }, [
      column("body", type),
      column("name", "nvarchar"),
    ]);

    expect(sql).not.toContain("[body]");
    // No presence, no distinct count and no shape test - and the column beside it
    // keeps all three.
    expect(sql).toContain("count([name]) AS present_1");
    expect(sql).toContain("count(DISTINCT [name]) AS distinct_1");
    expect(sql).toContain("count(CASE WHEN [name] LIKE");
  });

  test("a table of nothing but uncountable columns still composes its row count", () => {
    const sql = composeTableProfile("mssql", { segments: ["t"], depth: "pattern" }, [column("body", "text")]);

    expect(sql).toBe("SELECT count(*) AS row_count FROM [t]");
  });

  test("PostgreSQL still counts its own text columns, which SQL Server refuses", () => {
    // The reason the uncountable set is per dialect: `text` is PostgreSQL's ordinary
    // string type and SQL Server's deprecated large-object one.
    const sql = composeTableProfile("postgres", { segments: ["t"], depth: "distribution" }, [column("body", "text")]);

    expect(sql).toContain('count("body")');
    expect(sql).toContain('count(DISTINCT "body")');
  });

  // Msg 8117 again, this time only for count(DISTINCT ...): presence still counts.
  test.each(["xml", "geography", "geometry"])("%s keeps its presence count and loses only its distinct one", (type) => {
    const sql = composeTableProfile("mssql", { segments: ["t"], depth: "distribution" }, [column("shape", type)]);

    expect(sql).toContain("count([shape]) AS present_0");
    expect(sql).not.toContain("count(DISTINCT [shape])");
  });

  // Measured, not assumed: `count(DISTINCT DocumentNode)` over `Production.Document`
  // answers 13 for 13 rows, and the same probe counts varbinary(max) and
  // uniqueidentifier. hierarchyid was listed as incomparable and is not.
  test.each(["hierarchyid", "varbinary", "uniqueidentifier"])("%s is counted DISTINCT, not excluded", (type) => {
    const sql = composeTableProfile("mssql", { segments: ["t"], depth: "distribution" }, [column("v", type)]);

    expect(sql).toContain("count(DISTINCT [v]) AS distinct_0");
  });

  /**
   * The alias-type limitation, stated as a test so it cannot drift silently.
   *
   * SQL Server reports an ALIAS type by its own name, so AdventureWorks2022's
   * `Person.PersonPhone.PhoneNumber` arrives as `Phone` and `Person.Person.FirstName`
   * as `Name` while their base types are `nvarchar`. No pattern over a user-chosen
   * alias name can tell a text alias from a numeric one, so the shape tests can only
   * be as good as the type spelling the catalog read reports: given the BASE type they
   * fire, given the alias name they do not. The fix therefore belongs in the catalog
   * composer, which must report `TYPE_NAME(c.system_type_id)`.
   */
  test("a shape test follows the type spelling the catalog reports, so it needs the base type", () => {
    const aliased = composeTableProfile("mssql", { segments: ["Person", "PersonPhone"], depth: "pattern" }, [
      column("PhoneNumber", "Phone"),
    ]);
    const base = composeTableProfile("mssql", { segments: ["Person", "PersonPhone"], depth: "pattern" }, [
      column("PhoneNumber", "nvarchar"),
    ]);

    expect(aliased).not.toContain("LIKE");
    expect(aliased).toContain("count([PhoneNumber]) AS present_0");
    expect(base).toContain("count(CASE WHEN [PhoneNumber] LIKE");
  });

  test("a column the composer left out is absent from the profile, never reported empty", () => {
    // Reading the missing presence count back as zero would make every `text` column
    // on SQL Server a high_null finding at 100%: an answer to a question nobody asked.
    const profile = readTableProfile(
      "t",
      "basic",
      [column("body", "text"), column("name", "nvarchar")],
      [{ row_count: 100, present_1: 100 }],
    );

    expect(profile?.columns.map((entry) => entry.column)).toEqual(["name"]);
    expect(profile?.columns[0]?.present).toBe(100);
    expect(profile?.findings).toEqual([]);
  });
});

/**
 * The declared type is what a person reads and the BASE type is what a reader decides on,
 * and on SQL Server they differ for every alias type. Measured on AdventureWorks2022:
 * `Person.PersonPhone.PhoneNumber` is declared `Phone` over `nvarchar`, and the provider's
 * own object read reports the declared name, so this is the path `profile_table` actually
 * takes - the catalog composer's own base-type projection feeds `inspect_schema` and never
 * reaches here.
 */
describe("composeTableProfile - an alias type is decided on by what it is built on", () => {
  const aliasText = (): ColumnSchema => ({
    name: "PhoneNumber",
    type: "Phone",
    baseType: "nvarchar",
    nullable: true,
    isPrimary: false,
  });

  test("an alias over a text type still gets its shape tests", () => {
    const sql = composeTableProfile("mssql", { segments: ["Person", "PersonPhone"], depth: "pattern" }, [aliasText()]);

    expect(sql).toContain("LIKE '%_@_%._%'");
    expect(sql).toContain(`LIKE '%${"[0-9]".repeat(9)}%'`);
  });

  test("the declared name alone is not enough, which is what the base type is for", () => {
    const { baseType: _dropped, ...declaredOnly } = aliasText();

    const sql = composeTableProfile("mssql", { segments: ["Person", "PersonPhone"], depth: "pattern" }, [declaredOnly]);

    // `Phone` matches no spelling this module knows, so nothing can fire for it.
    expect(sql).not.toContain("LIKE '%_@_%._%'");
  });

  test("an alias over an uncountable type is left out whole, as the base type is", () => {
    const column: ColumnSchema = { name: "body", type: "Article", baseType: "text", nullable: true, isPrimary: false };

    const sql = composeTableProfile("mssql", { segments: ["dbo", "t"], depth: "basic" }, [column]);

    expect(sql).not.toContain("[body]");
    expect(sql).toContain("count(*) AS row_count");
  });

  test("an alias over an incomparable type keeps its presence and loses its distinct count", () => {
    const column: ColumnSchema = { name: "doc", type: "Payload", baseType: "xml", nullable: true, isPrimary: false };

    const sql = composeTableProfile("mssql", { segments: ["dbo", "t"], depth: "distribution" }, [column]);

    expect(sql).toContain("count([doc]) AS present_0");
    expect(sql).not.toContain("count(DISTINCT [doc])");
  });

  test("an engine that draws no such distinction is unchanged, because the field is absent there", () => {
    const column: ColumnSchema = { name: "note", type: "text", nullable: true, isPrimary: false };

    const sql = composeTableProfile("postgres", { segments: ["public", "t"], depth: "pattern" }, [column]);

    // PostgreSQL's own `text` is its ordinary string type: it is counted, and it is shaped.
    expect(sql).toContain('count("note") AS present_0');
    expect(sql).toContain("LIKE '%_@_%._%'");
  });
});
