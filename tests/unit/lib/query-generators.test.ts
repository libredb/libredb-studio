import { describe, test, expect } from "bun:test";
import {
  generateTableQuery,
  generateSelectQuery,
  shouldRefreshSchema,
  quoteIdentifier,
  quoteObjectPath,
} from "@/lib/query-generators";
// The whole module, for the one assertion that is about what it does NOT export.
import * as generators from "@/lib/query-generators";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";
import { metricSelector } from "@/lib/db/providers/timeseries/prometheus/promql";
import { parseReadRequest } from "@/lib/db/providers/stream/kafka/request";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";

// ============================================================================
// Helpers
// ============================================================================

function makeCaps(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    queryLanguage: "sql",
    supportsExplain: true,
    supportsExternalQueryLimiting: true,
    supportsCreateTable: true,
    supportsInlineRowEdit: true,
    supportsMaintenance: true,
    maintenanceOperations: [],
    supportsConnectionString: true,
    defaultPort: 5432,
    schemaRefreshPattern: "CREATE|ALTER|DROP|TRUNCATE",
    ...overrides,
  };
}

const sampleColumns: ColumnSchema[] = [
  { name: "id", type: "integer", nullable: false, isPrimary: true },
  { name: "name", type: "varchar(255)", nullable: false, isPrimary: false },
];

// ============================================================================
// generateTableQuery
// ============================================================================

describe("generateTableQuery", () => {
  test("SQL (postgres/mysql/sqlite) carries no row bound of its own", () => {
    // #816: the preview cap travels as the `limit` EXECUTION OPTION, not as text. A
    // bound in the statement is indistinguishable from one the user typed, and the
    // limiter returns a self-bounded statement untouched - dropping the offset with
    // it, so page two would be page one. See the module docblock.
    const result = generateTableQuery(["users"], makeCaps({ defaultPort: 5432 }));
    expect(result).toBe("SELECT * FROM users;");
  });

  test("JSON (MongoDB) generates JSON find query", () => {
    const result = generateTableQuery(["users"], makeCaps({ queryLanguage: "json", defaultPort: null }));
    const parsed = JSON.parse(result);
    expect(parsed.collection).toBe("users");
    expect(parsed.operation).toBe("find");
    expect(parsed.options.limit).toBe(50);
    // A one-segment path names no database, so no `database` key is emitted.
    expect(parsed.database).toBeUndefined();
  });

  test("Oracle (port 1521) carries no row bound either", () => {
    const result = generateTableQuery(["users"], makeCaps({ defaultPort: 1521 }));
    expect(result).not.toContain("FETCH FIRST");
    // Oracle folds unquoted identifiers to UPPERCASE, so a lowercase name is
    // quoted to preserve it.
    expect(result).toContain('SELECT * FROM "users"');
  });

  test("MSSQL (port 1433) carries no TOP", () => {
    const result = generateTableQuery(["users"], makeCaps({ defaultPort: 1433 }));
    expect(result).toBe("SELECT * FROM users;");
  });

  // #424 Phase 1, measured 2026-08-19 against Elasticsearch 9.1.4 and OpenSearch
  // 3.8.0. Elasticsearch SQL has no statement terminator in its grammar: the
  // generator's own `SELECT * FROM orders LIMIT 50;` answered
  // `line 1:30: extraneous input ';' expecting <EOF>`, so the FIRST click on an
  // index in the schema tree failed. OpenSearch tolerates the `;`, and omitting it
  // runs on both, so one answer serves both products.
  test("a dialect that declares no terminator gets no trailing semicolon", () => {
    const caps = makeCaps({ defaultPort: 9200, statementTerminator: "none" });
    expect(generateTableQuery(["orders"], caps)).toBe("SELECT * FROM orders");
  });

  test('LibreDB dialect: a ":*" prefix group scans with prefix', () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    expect(generateTableQuery(["users:*"], caps)).toBe("prefix users:");
  });

  test("LibreDB dialect: a bare (no-colon) group reads with get", () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    expect(generateTableQuery(["orphan"], caps)).toBe("get orphan");
  });

  // "Scan Keys" AUTO-EXECUTES through `handleTableClick`, and a key name is
  // server data interpolated raw into a line-oriented grammar. For a key named
  // `x\ndelete billing:2024` this used to return `get x\ndelete billing:2024`:
  // only `get x` ran, but line 2 sat in the editor as a runnable
  // `delete billing:2024`, one Run Selected away. Same answer as the cheatsheet
  // gives — emit the note, emit no command (U11).
  test("LibreDB dialect: a newline-bearing key name emits the note and NO command", () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    const out = generateTableQuery(["x\ndelete billing:2024"], caps);
    const runnable = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    expect(runnable).toEqual([]);
    expect(out).toContain("# This key's name contains a line break.");
  });

  test("LibreDB dialect: a bare CR in a key name refuses the same way (U11)", () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    expect(generateTableQuery(["x\rdelete billing:2024"], caps)).not.toContain("get x");
  });

  test("LibreDB dialect: a newline-bearing PREFIX GROUP refuses too (U11)", () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    expect(generateTableQuery(["x\ndelete billing:2024:*"], caps)).not.toContain("prefix ");
  });

  // The two LibreDB branches must not drift: Scan Keys and the cheatsheet emit
  // the identical note text for the identical name (U11).
  test("LibreDB dialect: Scan Keys and the cheatsheet share one refusal note (U11)", () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    const note = generateTableQuery(["x\ndelete billing:2024"], caps);
    expect(generateSelectQuery(["x\ndelete billing:2024"], [], caps)).toContain(note);
  });
});

// ============================================================================
// generateSelectQuery — a dialect with no statement terminator
// ============================================================================

describe("generateSelectQuery — no statement terminator", () => {
  // The twin of the generateTableQuery case above: "Generate Query" emits the
  // multi-column shape, and on Elasticsearch its `LIMIT 100;` answered
  // `line 6:10: extraneous input ';' expecting <EOF>` (measured 2026-08-19).
  test("omits the trailing semicolon the other dialects carry", () => {
    const caps = makeCaps({ defaultPort: 9200, statementTerminator: "none" });
    const out = generateSelectQuery(["orders"], sampleColumns, caps);
    expect(out.endsWith("LIMIT 100")).toBe(true);
    expect(out).not.toContain(";");
  });
});

// ============================================================================
// generateSelectQuery — LibreDB dialect
// ============================================================================

describe("generateSelectQuery — LibreDB dialect", () => {
  const libreCaps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
  const kvColumns: ColumnSchema[] = [
    { name: "key", type: "string", nullable: false, isPrimary: true },
    { name: "value", type: "string", nullable: true, isPrimary: false },
  ];
  const relationalColumns: ColumnSchema[] = [
    { name: "id", type: "string", nullable: false, isPrimary: true },
    { name: "age", type: "number", nullable: false, isPrimary: false },
    { name: "active", type: "boolean", nullable: false, isPrimary: false },
  ];

  // The runnable command lines (drop the use-case comments and blank lines).
  const commandLines = (out: string) =>
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));

  test("output carries explanatory # comments", () => {
    const out = generateSelectQuery(["users:*"], kvColumns, libreCaps);
    expect(out.split("\n").some((l) => l.trim().startsWith("#"))).toBe(true);
  });

  test("a node name containing a newline emits a note and NO command line (#427)", () => {
    // A key name is server data. `get`/`put`/`delete` interpolate it raw, so its
    // second line rendered as a runnable command of its own — `delete billing:2024`
    // below would have been executed by Run Selected. LibreDB has no lossless JSON
    // command form to fall back to, so the cheatsheet declines to guess.
    const out = generateSelectQuery(["x\ndelete billing:2024"], kvColumns, libreCaps);
    expect(out.split("\n")[0]).toBe(
      '# LibreDB commands for "x\\ndelete billing:2024" — select a line and Run Selected.',
    );
    expect(commandLines(out)).toEqual([]);
    expect(out).toContain("# This key's name contains a line break.");
    expect(out).not.toContain("delete billing:2024\n");
  });

  test("a node name containing a bare CR emits the same note (#427)", () => {
    // A lone CR ends a line for an editor and for Run Selected just as LF does.
    const out = generateSelectQuery(["x\rdelete billing:2024"], kvColumns, libreCaps);
    expect(commandLines(out)).toEqual([]);
  });

  test("a PREFIX GROUP whose name contains a newline emits the same note (#427)", () => {
    const out = generateSelectQuery(["x\ndelete billing:2024:*"], kvColumns, libreCaps);
    expect(commandLines(out)).toEqual([]);
  });

  test("an ordinary node name still renders unescaped in the header (#427)", () => {
    expect(generateSelectQuery(["users:*"], kvColumns, libreCaps).split("\n")[0]).toBe(
      '# LibreDB commands for "users:*" — select a line and Run Selected.',
    );
  });

  test("relational group: put example is a concrete JSON object from the columns", () => {
    const out = generateSelectQuery(["users:*"], relationalColumns, libreCaps);
    expect(commandLines(out)).toEqual([
      "prefix users:",
      "get users:1",
      `put users:1 '{"id":"example","age":1,"active":true}'`,
      "delete users:1",
    ]);
  });

  test("raw kv group (key/value columns): put example uses a plain value", () => {
    const out = generateSelectQuery(["config:*"], kvColumns, libreCaps);
    expect(commandLines(out)).toEqual(["prefix config:", "get config:1", "put config:1 example", "delete config:1"]);
  });

  test("bare (no-colon) group: get/put/delete on the key itself, no prefix scan", () => {
    const out = generateSelectQuery(["orphan"], kvColumns, libreCaps);
    expect(commandLines(out)).toEqual(["get orphan", "put orphan example", "delete orphan"]);
  });

  test("relational group: object and unknown column types map to example JSON values", () => {
    const exoticColumns: ColumnSchema[] = [
      { name: "id", type: "string", nullable: false, isPrimary: true },
      { name: "meta", type: "object", nullable: true, isPrimary: false },
      { name: "notes", type: "text", nullable: true, isPrimary: false },
    ];
    const out = generateSelectQuery(["things:*"], exoticColumns, libreCaps);
    expect(commandLines(out)).toContain(`put things:1 '{"id":"example","meta":{},"notes":"example"}'`);
  });

  test("document collection (id/document columns): put example is a small JSON object", () => {
    const docColumns: ColumnSchema[] = [
      { name: "id", type: "string", nullable: false, isPrimary: true },
      { name: "document", type: "object", nullable: true, isPrimary: false },
    ];
    const out = generateSelectQuery(["articles:*"], docColumns, libreCaps);
    expect(commandLines(out)).toContain(`put articles:1 '{"name":"example"}'`);
  });

  test("every command line is a concrete, directly-runnable verb (no placeholders)", () => {
    const out = generateSelectQuery(["people:*"], kvColumns, libreCaps);
    for (const line of commandLines(out)) {
      expect(["prefix", "get", "put", "delete"]).toContain(line.split(" ")[0]);
      expect(line).not.toContain("<"); // no <key>/<value> placeholders
    }
  });
});

// ============================================================================
// generateSelectQuery
// ============================================================================

describe("generateSelectQuery", () => {
  test("SQL with columns generates column list and LIMIT 100", () => {
    const result = generateSelectQuery(["users"], sampleColumns, makeCaps({ defaultPort: 5432 }));
    expect(result).toContain("id");
    expect(result).toContain("name");
    expect(result).toContain("LIMIT 100");
    expect(result).toContain("WHERE 1=1");
  });

  test("JSON (MongoDB) generates projection", () => {
    const result = generateSelectQuery(
      ["users"],
      sampleColumns,
      makeCaps({ queryLanguage: "json", defaultPort: null }),
    );
    const parsed = JSON.parse(result);
    expect(parsed.collection).toBe("users");
    expect(parsed.options.projection.id).toBe(1);
    expect(parsed.options.projection.name).toBe(1);
    expect(parsed.options.limit).toBe(100);
  });

  test("Oracle uses FETCH FIRST 100 ROWS ONLY", () => {
    const result = generateSelectQuery(["users"], sampleColumns, makeCaps({ defaultPort: 1521 }));
    expect(result).toContain("FETCH FIRST 100 ROWS ONLY");
    expect(result).toContain("id");
    expect(result).toContain("name");
  });

  test("MSSQL uses TOP 100", () => {
    const result = generateSelectQuery(["users"], sampleColumns, makeCaps({ defaultPort: 1433 }));
    expect(result).toContain("SELECT TOP 100");
    expect(result).toContain("id");
    expect(result).toContain("name");
  });
});

// ============================================================================
// Couchbase (SQL++) — issue #262, decision 5
// ============================================================================

describe("Couchbase (SQL++) generation", () => {
  const couchbaseCaps = makeCaps({ defaultPort: 8091 });

  // A collection's fields as the INFER-based introspection reports them: the
  // document key first, under the same "__id" alias the generated projection uses.
  const hotelColumns: ColumnSchema[] = [
    { name: "__id", type: "string", nullable: false, isPrimary: true },
    { name: "city", type: "string", nullable: true, isPrimary: false },
  ];

  test("generateTableQuery aliases the keyspace and projects the document key", () => {
    expect(generateTableQuery(["hotel"], couchbaseCaps)).toBe("SELECT META(d).id AS __id, d.* FROM `hotel` AS d;");
  });

  test("generateTableQuery quotes every segment of a scope-qualified collection", () => {
    expect(generateTableQuery(["inventory", "hotel"], couchbaseCaps)).toBe(
      "SELECT META(d).id AS __id, d.* FROM `inventory`.`hotel` AS d;",
    );
  });

  test("generateSelectQuery projects fields through the alias and the key through META", () => {
    expect(generateSelectQuery(["inventory", "hotel"], hotelColumns, couchbaseCaps)).toBe(
      "SELECT\n  META(d).id AS __id,\n  d.`city`\nFROM `inventory`.`hotel` AS d\nWHERE 1=1\nLIMIT 100;",
    );
  });

  test("generateSelectQuery falls back to the wildcard when no columns are known", () => {
    expect(generateSelectQuery(["hotel"], [], couchbaseCaps)).toBe(
      "SELECT\n  META(d).id AS __id,\n  d.*\nFROM `hotel` AS d\nWHERE 1=1\nLIMIT 100;",
    );
  });

  test("generateSelectQuery adds the key projection even when the columns carry no key", () => {
    const cityOnly: ColumnSchema[] = [{ name: "city", type: "string", nullable: true, isPrimary: false }];
    const out = generateSelectQuery(["hotel"], cityOnly, couchbaseCaps);
    expect(out).toContain("META(d).id AS __id");
    expect(out).not.toContain("d.`__id`");
  });

  test("quoteIdentifier always backtick-quotes, so SQL++ reserved words parse", () => {
    // `bucket` and `scope` are reserved words: unquoted they are a syntax error.
    expect(quoteIdentifier("bucket", couchbaseCaps)).toBe("`bucket`");
    expect(quoteIdentifier("city", couchbaseCaps)).toBe("`city`");
  });

  test("quoteIdentifier doubles an embedded backtick so it cannot terminate its quoting", () => {
    expect(quoteIdentifier("we`ird", couchbaseCaps)).toBe("`we``ird`");
  });

  test("quoteObjectPath quotes each segment independently", () => {
    expect(quoteObjectPath(["inventory", "hotel"], couchbaseCaps)).toBe("`inventory`.`hotel`");
  });
});

// ============================================================================
// ClickHouse (issue #264) — no dialect branch of its own, and that is the claim
// under test: every string below was run against ClickHouse 26.7.1 and accepted.
// ============================================================================

describe("ClickHouse (8123) generation", () => {
  const clickhouseCaps = makeCaps({ defaultPort: 8123 });

  test("generateTableQuery emits the bare statement", () => {
    expect(generateTableQuery(["events"], clickhouseCaps)).toBe("SELECT * FROM events;");
  });

  test("generateTableQuery qualifies and quotes a database-scoped table per segment", () => {
    // Cross-database tables are addressed as `database.table`, so the dot must stay
    // a separator; ClickHouse is case-sensitive, so a mixed-case name needs quoting.
    expect(generateTableQuery(["demo", "Events"], clickhouseCaps)).toBe('SELECT * FROM demo."Events";');
  });

  test("generateSelectQuery emits a double-quoted column list and LIMIT 100", () => {
    const cols: ColumnSchema[] = [
      { name: "id", type: "Int32", nullable: false, isPrimary: true },
      { name: "Name", type: "Nullable(String)", nullable: true, isPrimary: false },
    ];
    expect(generateSelectQuery(["demo", "regtest"], cols, clickhouseCaps)).toBe(
      'SELECT\n  id,\n  "Name"\nFROM demo.regtest\nWHERE 1=1\nLIMIT 100;',
    );
  });

  test("no generated bound at all, so there is none to misplace (#264 re-aimed)", () => {
    // The old shape of this guard pinned the generated `LIMIT 50` as the LAST clause,
    // because `... FORMAT TSV LIMIT 1` is a syntax error while `... LIMIT 1 FORMAT TSV`
    // is not. #816 removed the generated bound, so there is nothing here to misplace.
    //
    // THE HAZARD MOVED, it did not go away: the limiter still appends a bound to
    // whatever the user typed. Its answer for a statement ending in `FORMAT` or
    // `SETTINGS` - return it untouched with `wasLimited: false`, which is why the
    // route then offers no Load More - is pinned in
    // tests/integration/db/clickhouse-provider.test.ts, not here.
    const out = generateTableQuery(["events"], clickhouseCaps);
    expect(out).toBe("SELECT * FROM events;");
    expect(out).not.toContain("LIMIT");
  });

  test("quoteIdentifier keeps plain lowercase bare and double-quotes anything else", () => {
    // ClickHouse never folds case, so quoting is only about parseability, and its
    // quote character is the double quote the default branch already emits.
    expect(quoteIdentifier("events", clickhouseCaps)).toBe("events");
    expect(quoteIdentifier("Events", clickhouseCaps)).toBe('"Events"');
    expect(quoteIdentifier("weird name", clickhouseCaps)).toBe('"weird name"');
    expect(quoteIdentifier('we"ird', clickhouseCaps)).toBe('"we""ird"');
  });

  test("quoteObjectPath keeps the database separator intact", () => {
    expect(quoteObjectPath(["demo", "regtest"], clickhouseCaps)).toBe("demo.regtest");
    expect(quoteObjectPath(["demo", "Events"], clickhouseCaps)).toBe('demo."Events"');
  });
});

// ============================================================================
// Apache Druid (issue #265) — Druid has a dialect branch of its own that quotes
// UNCONDITIONALLY, and that is the claim under test: every string below was run
// against Apache Druid 37.0.0 through POST /druid/v2/sql and accepted.
// ============================================================================

describe("Druid (8888) generation", () => {
  const druidCaps = makeCaps({ defaultPort: 8888 });

  test("generateTableQuery quotes the datasource and emits the bare statement", () => {
    expect(generateTableQuery(["libredb_demo"], druidCaps)).toBe('SELECT * FROM "libredb_demo";');
  });

  // The trap that makes the default branch correct for Druid rather than merely
  // adequate: Druid rejects ORDER BY on a non-__time column of a plain table scan
  // with 400 "SQL query requires ordering a table by non-time column [[qty]], which
  // is not supported." A generator that ordered by the primary key - the obvious
  // thing to do for a "top 50" - would produce a query that cannot be planned on
  // any Druid datasource. So no provider-generated scan may ever carry ORDER BY.
  test("no generated Druid statement carries ORDER BY", () => {
    expect(generateTableQuery(["libredb_demo"], druidCaps)).not.toContain("ORDER BY");
    expect(generateSelectQuery(["libredb_demo"], sampleColumns, druidCaps)).not.toContain("ORDER BY");
  });

  test("generateSelectQuery emits a double-quoted column list and LIMIT 100", () => {
    const cols: ColumnSchema[] = [
      { name: "id", type: "BIGINT", nullable: true, isPrimary: false },
      { name: "region", type: "VARCHAR", nullable: true, isPrimary: false },
    ];
    expect(generateSelectQuery(["libredb_demo"], cols, druidCaps)).toBe(
      'SELECT\n  "id",\n  "region"\nFROM "libredb_demo"\nWHERE 1=1\nLIMIT 100;',
    );
  });

  test("the __time column is quoted like every other column", () => {
    // __time is mandatory on every datasource, so it is in almost every generated
    // projection. It parses both bare and quoted; quoting it needs no exception.
    const cols: ColumnSchema[] = [{ name: "__time", type: "TIMESTAMP", nullable: false, isPrimary: true }];
    expect(generateSelectQuery(["libredb_demo"], cols, druidCaps)).toContain('  "__time"');
  });

  // The defect this branch exists for (issue #265 review): Calcite reserves a large
  // set of plain lowercase words, so a bare one is a SYNTAX error, not a
  // column-not-found. Verified against Apache Druid 37.0.0:
  //   SELECT count FROM libredb_demo LIMIT 1
  //     -> 400 "Received an unexpected token [count FROM] (line [1], column [8])"
  //   SELECT "count" FROM libredb_demo LIMIT 1
  //     -> 400 "Column 'count' not found in any table"   (syntax fine, no such column)
  // `count` matters most: it is Druid's conventional rollup metric name, so the
  // standard rollup ingestion produces a datasource that has one.
  test("quoteIdentifier quotes reserved words, so a rollup metric column parses", () => {
    for (const word of [
      "count",
      "value",
      "start",
      "end",
      "date",
      "time",
      "year",
      "rows",
      "result",
      "system",
      "window",
      "position",
      "language",
      "period",
      "range",
    ]) {
      expect(quoteIdentifier(word, druidCaps)).toBe(`"${word}"`);
    }
  });

  test("quoteIdentifier quotes unconditionally, reserved or not", () => {
    // No safe unquoted subset is worth detecting: Calcite's reserved list is large
    // and version-dependent, so an ordinary-looking name gets the same treatment.
    expect(quoteIdentifier("libredb_demo", druidCaps)).toBe('"libredb_demo"');
    expect(quoteIdentifier("snowflake_id", druidCaps)).toBe('"snowflake_id"');
    expect(quoteIdentifier("Region", druidCaps)).toBe('"Region"');
    expect(quoteIdentifier("weird name", druidCaps)).toBe('"weird name"');
  });

  test("quoteIdentifier doubles an embedded double quote so it cannot terminate its quoting", () => {
    // Verified via `SELECT 1 AS "we""ird"`, which returns the column name `we"ird`.
    expect(quoteIdentifier('we"ird', druidCaps)).toBe('"we""ird"');
  });

  test("quoteObjectPath quotes each segment and keeps the schema separator intact", () => {
    // Druid's single catalog exposes one user schema, `druid`, and both the bare and
    // the schema-qualified form resolve, so the dot must stay a separator:
    // `SELECT * FROM "druid"."libredb_demo" LIMIT 1` -> HTTP 200.
    expect(quoteObjectPath(["druid", "libredb_demo"], druidCaps)).toBe('"druid"."libredb_demo"');
  });

  test("generateSelectQuery with no columns falls back to a bare star, not a quoted one", () => {
    // `SELECT "*"` would be a column literally named `*`; the star must stay bare.
    expect(generateSelectQuery(["libredb_demo"], [], druidCaps)).toBe(
      'SELECT\n  *\nFROM "libredb_demo"\nWHERE 1=1\nLIMIT 100;',
    );
  });
});

// ============================================================================
// Trino (issue #424 Phase 2) - the first engine here that reaches the generators
// through DECLARED capabilities alone: 8080 is a generic HTTP port and no branch
// may infer a dialect from it, so `identifierQuoting: "double"` and
// `statementTerminator: "none"` are what steer every string below. Each was run
// against Trino 476 through POST /v1/statement and accepted.
// ============================================================================

describe("Trino (declared capabilities, port 8080) generation", () => {
  const trinoCaps = makeCaps({
    defaultPort: 8080,
    identifierQuoting: "double",
    statementTerminator: "none",
  });

  test("generateTableQuery emits no trailing semicolon", () => {
    // Not cosmetic. Measured: `SELECT * FROM tpch.sf1.nation LIMIT 50;` is
    // "line 1:39: mismatched input ';'. Expecting: <EOF>" - the terminator is not in
    // Trino's grammar, so a generated statement carrying one cannot run at all.
    expect(generateTableQuery(["nation"], trinoCaps)).toBe("SELECT * FROM nation");
  });

  test("generateSelectQuery emits the column list unquoted and no terminator", () => {
    // Live: the same five lines answer the two columns. Unquoted lowercase names
    // round-trip because Trino folds an unquoted identifier to lower case.
    expect(generateSelectQuery(["nation"], sampleColumns, trinoCaps)).toBe(
      "SELECT\n  id,\n  name\nFROM nation\nWHERE 1=1\nLIMIT 100",
    );
  });

  test("quoteIdentifier quotes only a name that would not round-trip bare", () => {
    // The declared "double" arm, reached before the port heuristic. Measured on 476:
    // `SELECT nationkey FROM tpch.sf1.nation LIMIT 1` and `SELECT "nationkey" ...`
    // both return the column, so quoting a plain lowercase name would only add noise.
    expect(quoteIdentifier("nationkey", trinoCaps)).toBe("nationkey");
    expect(quoteIdentifier("NationKey", trinoCaps)).toBe('"NationKey"');
    expect(quoteIdentifier("weird name", trinoCaps)).toBe('"weird name"');
  });

  test("quoteIdentifier doubles an embedded double quote so it cannot terminate its quoting", () => {
    // Verified via `SELECT 1 AS "a""b"`, which returns the column name `a"b`.
    expect(quoteIdentifier('a"b', trinoCaps)).toBe('"a""b"');
  });

  test("quoteObjectPath keeps the catalog.schema.table separators intact", () => {
    // Three levels rather than two, which is what a catalog adds: measured,
    // `SELECT * FROM tpch.sf1.nation LIMIT 50` resolves fully qualified.
    expect(quoteObjectPath(["tpch", "sf1", "nation"], trinoCaps)).toBe("tpch.sf1.nation");
    expect(quoteObjectPath(["tpch", "sf1", "Nation"], trinoCaps)).toBe('tpch.sf1."Nation"');
  });

  test("a backtick is never emitted for this dialect", () => {
    // The trap #424 Phase 1 recorded, in the other direction: the port cannot say
    // which quote character an HTTP engine uses. Measured, Trino refuses a backtick
    // outright - "backquoted identifiers are not supported; use double quotes to
    // quote identifiers" - so a generator that guessed MySQL's form from a generic
    // port would produce a statement no Trino coordinator can parse.
    expect(quoteIdentifier("Weird", trinoCaps)).not.toContain("`");
    expect(generateSelectQuery(["nation"], sampleColumns, trinoCaps)).not.toContain("`");
  });
});

// ============================================================================
// Apache Cassandra (issue #424 Phase 4) - the engine that needed NO branch, and the
// tests that establish that rather than assuming it. Port 9042 is Cassandra's alone,
// so the port heuristic is not asked to answer for two dialects, and every string
// below was run against a live 5.0.9 over the native protocol.
// ============================================================================

describe("Apache Cassandra (port 9042) generation", () => {
  const cassandraCaps = makeCaps({ defaultPort: 9042 });

  test("the fallthrough statement is valid CQL, terminator included", () => {
    // Measured: `SELECT * FROM probe.customers;` returns rows - CQL accepts a trailing
    // semicolon on a single statement - so no `statementTerminator` is declared and no
    // branch is added. The preview cap is no longer in the text at all: it travels as the
    // `limit` execution option and the limiter appends the `LIMIT 50` this dialect takes
    // (#816), which is what keeps Cassandra's preview at 50 rows without a control it
    // cannot serve.
    expect(generateTableQuery(["customers"], cassandraCaps)).toBe("SELECT * FROM customers;");
  });

  test("a keyspace-qualified name keeps its separator", () => {
    expect(quoteObjectPath(["probe", "customers"], cassandraCaps)).toBe("probe.customers");
  });

  test("names are double-quoted only when they would not round-trip bare", () => {
    // The default branch, and it is measured-correct here rather than inherited by
    // luck: `SELECT "id" FROM probe.customers` returns the column, the bare form
    // works too, and a backtick is "no viable alternative at character '`'". A
    // quoted name in CQL is case-SENSITIVE, which is why a mixed-case one must be
    // quoted and a lowercase one must not.
    expect(quoteIdentifier("id", cassandraCaps)).toBe("id");
    expect(quoteIdentifier("CustomerId", cassandraCaps)).toBe('"CustomerId"');
    expect(quoteIdentifier("Weird", cassandraCaps)).not.toContain("`");
  });
});

// ============================================================================
// quoteIdentifier (dialect-aware, quote-only-when-needed)
// ============================================================================

describe("quoteIdentifier", () => {
  test("PostgreSQL: leaves plain lowercase names unquoted", () => {
    expect(quoteIdentifier("users", makeCaps({ defaultPort: 5432 }))).toBe("users");
  });

  test("PostgreSQL: double-quotes mixed-case names (the reported bug)", () => {
    expect(quoteIdentifier("Customer", makeCaps({ defaultPort: 5432 }))).toBe('"Customer"');
    expect(quoteIdentifier("ContractExtractionPromptTemplate", makeCaps({ defaultPort: 5432 }))).toBe(
      '"ContractExtractionPromptTemplate"',
    );
  });

  test("SQLite (defaultPort null): double-quotes mixed-case names", () => {
    expect(quoteIdentifier("users", makeCaps({ defaultPort: null }))).toBe("users");
    expect(quoteIdentifier("Customer", makeCaps({ defaultPort: null }))).toBe('"Customer"');
  });

  test("Oracle: leaves plain UPPERCASE unquoted, quotes anything else", () => {
    expect(quoteIdentifier("USERS", makeCaps({ defaultPort: 1521 }))).toBe("USERS");
    // lowercase/mixed must be quoted because Oracle folds unquoted to UPPER
    expect(quoteIdentifier("customer", makeCaps({ defaultPort: 1521 }))).toBe('"customer"');
    expect(quoteIdentifier("Customer", makeCaps({ defaultPort: 1521 }))).toBe('"Customer"');
  });

  test("MySQL: preserves case unquoted, backticks only special names", () => {
    expect(quoteIdentifier("Customer", makeCaps({ defaultPort: 3306 }))).toBe("Customer");
    expect(quoteIdentifier("weird-name", makeCaps({ defaultPort: 3306 }))).toBe("`weird-name`");
  });

  test("SQL Server: preserves case unquoted, bracket-quotes special names", () => {
    expect(quoteIdentifier("Customer", makeCaps({ defaultPort: 1433 }))).toBe("Customer");
    expect(quoteIdentifier("weird name", makeCaps({ defaultPort: 1433 }))).toBe("[weird name]");
  });

  test("MongoDB (json): never quotes (collection name used as-is)", () => {
    expect(quoteIdentifier("Customer", makeCaps({ queryLanguage: "json", defaultPort: null }))).toBe("Customer");
  });

  test("escapes embedded quote characters per dialect", () => {
    // Postgres/SQLite: embedded double-quote is doubled
    expect(quoteIdentifier('we"ird', makeCaps({ defaultPort: 5432 }))).toBe('"we""ird"');
    // MySQL: embedded backtick is doubled
    expect(quoteIdentifier("we`ird", makeCaps({ defaultPort: 3306 }))).toBe("`we``ird`");
    // SQL Server: embedded closing bracket is doubled
    expect(quoteIdentifier("we]ird", makeCaps({ defaultPort: 1433 }))).toBe("[we]]ird]");
    // Oracle: embedded double-quote is doubled
    expect(quoteIdentifier('we"ird', makeCaps({ defaultPort: 1521 }))).toBe('"we""ird"');
  });

  test("generateTableQuery quotes a mixed-case Postgres table", () => {
    expect(generateTableQuery(["Customer"], makeCaps({ defaultPort: 5432 }))).toBe('SELECT * FROM "Customer";');
  });

  test("schema-qualified names are quoted per-segment, not as one identifier", () => {
    // lowercase schema.table → no quotes (Postgres)
    expect(quoteObjectPath(["employees", "department"], makeCaps({ defaultPort: 5432 }))).toBe("employees.department");
    // mixed-case table in a schema → only the table segment is quoted
    expect(quoteObjectPath(["public", "Order"], makeCaps({ defaultPort: 5432 }))).toBe('public."Order"');
    // a one-segment address is unchanged
    expect(quoteObjectPath(["Customer"], makeCaps({ defaultPort: 5432 }))).toBe('"Customer"');
  });

  test("generateTableQuery on a schema-qualified table does NOT wrap the dot (regression)", () => {
    // Was producing the broken `"employees.department"`; must be `employees.department`.
    expect(generateTableQuery(["employees", "department"], makeCaps({ defaultPort: 5432 }))).toBe(
      "SELECT * FROM employees.department;",
    );
  });

  test("generateSelectQuery quotes mixed-case table and columns (Postgres)", () => {
    const cols: ColumnSchema[] = [
      { name: "Id", type: "integer", nullable: false, isPrimary: true },
      { name: "full_name", type: "text", nullable: true, isPrimary: false },
    ];
    const result = generateSelectQuery(["Customer"], cols, makeCaps({ defaultPort: 5432 }));
    expect(result).toContain('FROM "Customer"');
    expect(result).toContain('"Id"');
    expect(result).toContain("full_name"); // lowercase stays unquoted
  });
});

// ============================================================================
// shouldRefreshSchema
// ============================================================================

describe("shouldRefreshSchema", () => {
  const pattern = "CREATE|ALTER|DROP|TRUNCATE";

  test("CREATE TABLE triggers refresh", () => {
    expect(shouldRefreshSchema("CREATE TABLE users (id INT)", pattern)).toBe(true);
  });

  test("ALTER TABLE triggers refresh", () => {
    expect(shouldRefreshSchema("ALTER TABLE users ADD COLUMN email TEXT", pattern)).toBe(true);
  });

  test("DROP TABLE triggers refresh", () => {
    expect(shouldRefreshSchema("DROP TABLE users", pattern)).toBe(true);
  });

  test("TRUNCATE triggers refresh", () => {
    expect(shouldRefreshSchema("TRUNCATE TABLE users", pattern)).toBe(true);
  });

  test("SELECT does NOT trigger refresh", () => {
    expect(shouldRefreshSchema("SELECT * FROM users", pattern)).toBe(false);
  });

  test("INSERT does NOT trigger refresh", () => {
    expect(shouldRefreshSchema("INSERT INTO users VALUES (1)", pattern)).toBe(false);
  });
});

// ============================================================================
// Redis dialect (#427)
// ============================================================================

const redisCaps = makeCaps({ queryLanguage: "json", defaultPort: 6379, queryDialect: "redis" });

/** The three columns `redis.ts` `getSchema()` builds for every key-prefix row. */
function typeCols(sample: string): ColumnSchema[] {
  return [
    { name: "key", type: "string", nullable: false, isPrimary: true },
    { name: "value", type: sample.split(", ").join("/"), nullable: true, isPrimary: false },
    { name: "type", type: sample, nullable: false, isPrimary: false },
  ];
}

describe("generateTableQuery — Redis dialect", () => {
  test("prefix group scans with SCAN 0 MATCH ... COUNT 50", () => {
    expect(generateTableQuery(["user:*"], redisCaps, typeCols("string"))).toBe("SCAN 0 MATCH user:* COUNT 50");
  });

  test("prefix group SCANs regardless of the sampled type", () => {
    expect(generateTableQuery(["session:*"], redisCaps, typeCols("hash"))).toBe("SCAN 0 MATCH session:* COUNT 50");
  });

  test("bare key, string sample -> GET", () => {
    expect(generateTableQuery(["counter"], redisCaps, typeCols("string"))).toBe("GET counter");
  });

  test("bare key, hash sample -> HGETALL", () => {
    expect(generateTableQuery(["counter"], redisCaps, typeCols("hash"))).toBe("HGETALL counter");
  });

  test("bare key, list sample -> LRANGE k 0 -1", () => {
    expect(generateTableQuery(["counter"], redisCaps, typeCols("list"))).toBe("LRANGE counter 0 -1");
  });

  test("bare key, set sample -> SMEMBERS", () => {
    expect(generateTableQuery(["counter"], redisCaps, typeCols("set"))).toBe("SMEMBERS counter");
  });

  test("bare key, zset sample -> ZRANGE k 0 -1 WITHSCORES", () => {
    expect(generateTableQuery(["counter"], redisCaps, typeCols("zset"))).toBe("ZRANGE counter 0 -1 WITHSCORES");
  });

  test('bare key, mixed sample ("string, hash") -> TYPE', () => {
    expect(generateTableQuery(["counter"], redisCaps, typeCols("string, hash"))).toBe("TYPE counter");
  });

  test('bare key, unrecognised sample ("stream") -> TYPE', () => {
    expect(generateTableQuery(["counter"], redisCaps, typeCols("stream"))).toBe("TYPE counter");
  });

  test('bare key, empty sample ("") -> TYPE', () => {
    expect(generateTableQuery(["counter"], redisCaps, typeCols(""))).toBe("TYPE counter");
  });

  test("bare key with no columns argument -> TYPE", () => {
    expect(generateTableQuery(["counter"], redisCaps)).toBe("TYPE counter");
  });

  test('bare key with columns that have no "type" column -> TYPE', () => {
    expect(generateTableQuery(["counter"], redisCaps, sampleColumns)).toBe("TYPE counter");
  });

  test("glob metacharacters in the prefix are escaped in MATCH", () => {
    // The escape introduces a backslash, which the plain tokenizer cannot be
    // trusted to carry, so the line switches to the lossless JSON form (#427).
    expect(generateTableQuery(["a[b:*"], redisCaps, typeCols("string"))).toBe(
      '{"command":"SCAN","args":["0","MATCH","a\\\\[b:*","COUNT","50"]}',
    );
  });

  test("a key containing a double quote falls back to the JSON form (#427)", () => {
    // Plain `GET "say"hi""` tokenizes to the key `sayhi` — a different key.
    expect(generateTableQuery(['say"hi"'], redisCaps, typeCols("string"))).toBe(
      '{"command":"GET","args":["say\\"hi\\""]}',
    );
  });

  test("a key containing a single quote falls back to the JSON form (#427)", () => {
    expect(generateTableQuery(["it's"], redisCaps, typeCols("hash"))).toBe('{"command":"HGETALL","args":["it\'s"]}');
  });

  test("a quoted prefix group falls back to the JSON form (#427)", () => {
    expect(generateTableQuery(['a"b:*'], redisCaps, typeCols("string"))).toBe(
      '{"command":"SCAN","args":["0","MATCH","a\\"b:*","COUNT","50"]}',
    );
  });

  test("an argument containing whitespace is quoted", () => {
    expect(generateTableQuery(["my key"], redisCaps, typeCols(""))).toBe('TYPE "my key"');
  });

  test("returns exactly one line", () => {
    expect(generateTableQuery(["user:*"], redisCaps, typeCols("string"))).not.toContain("\n");
    expect(generateTableQuery(["counter"], redisCaps, typeCols("string"))).not.toContain("\n");
  });

  test("Redis no longer emits MongoDB JSON (#427 regression)", () => {
    const result = generateTableQuery(["user:*"], redisCaps, typeCols("string"));
    expect(() => JSON.parse(result)).toThrow();
  });
});

describe("generateSelectQuery — Redis dialect", () => {
  // The runnable command lines (drop the use-case comments and blank lines).
  const commandLines = (out: string) =>
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));

  test("output carries explanatory # comments", () => {
    const out = generateSelectQuery(["user:*"], typeCols("string"), redisCaps);
    expect(out.split("\n").some((l) => l.trim().startsWith("#"))).toBe(true);
  });

  test("prefix group (string) emits the exact cheatsheet", () => {
    expect(generateSelectQuery(["user:*"], typeCols("string"), redisCaps)).toBe(
      [
        '# Redis commands for "user:*" — select a line and Run Selected.',
        "",
        "# List keys under this prefix — ONE scan iteration, not the whole set.",
        "# 0 is the start cursor; the reply's first row is the next cursor. Re-run",
        "# with that value in place of 0 until it comes back 0 (a page may be empty).",
        "SCAN 0 MATCH user:* COUNT 50",
        "",
        "# Check the key's type",
        "TYPE user:1",
        "",
        "# Read the value",
        "GET user:1",
        "",
        "# Create or update it — this overwrites an existing value",
        "SET user:1 example",
        "",
        "# Time to live in seconds (-1 no expiry, -2 no such key)",
        "TTL user:1",
        "",
        "# Delete the key (DEL takes a literal key name, never a pattern)",
        "DEL user:1",
      ].join("\n"),
    );
  });

  test("hash prefix group emits the exact cheatsheet", () => {
    expect(generateSelectQuery(["session:*"], typeCols("hash"), redisCaps)).toBe(
      [
        '# Redis commands for "session:*" — select a line and Run Selected.',
        "",
        "# List keys under this prefix — ONE scan iteration, not the whole set.",
        "# 0 is the start cursor; the reply's first row is the next cursor. Re-run",
        "# with that value in place of 0 until it comes back 0 (a page may be empty).",
        "SCAN 0 MATCH session:* COUNT 50",
        "",
        "# Check the key's type",
        "TYPE session:1",
        "",
        "# Read every field of the hash",
        "HGETALL session:1",
        "",
        "# Create or update one field — this overwrites an existing field",
        "HSET session:1 field example",
        "",
        "# Time to live in seconds (-1 no expiry, -2 no such key)",
        "TTL session:1",
        "",
        "# Delete the key (DEL takes a literal key name, never a pattern)",
        "DEL session:1",
      ].join("\n"),
    );
  });

  test("bare key (string) emits the exact cheatsheet", () => {
    expect(generateSelectQuery(["counter"], typeCols("string"), redisCaps)).toBe(
      [
        '# Redis commands for "counter" — select a line and Run Selected.',
        "",
        "# Check the key's type",
        "TYPE counter",
        "",
        "# Read the value",
        "GET counter",
        "",
        "# Create or update it — this overwrites an existing value",
        "SET counter example",
        "",
        "# Time to live in seconds (-1 no expiry, -2 no such key)",
        "TTL counter",
        "",
        "# Delete the key (DEL takes a literal key name, never a pattern)",
        "DEL counter",
      ].join("\n"),
    );
  });

  test("list prefix group emits LRANGE/RPUSH", () => {
    expect(commandLines(generateSelectQuery(["queue:*"], typeCols("list"), redisCaps))).toEqual([
      "SCAN 0 MATCH queue:* COUNT 50",
      "TYPE queue:1",
      "LRANGE queue:1 0 -1",
      "RPUSH queue:1 example",
      "TTL queue:1",
      "DEL queue:1",
    ]);
  });

  test("set prefix group emits SMEMBERS/SADD", () => {
    expect(commandLines(generateSelectQuery(["tags:*"], typeCols("set"), redisCaps))).toEqual([
      "SCAN 0 MATCH tags:* COUNT 50",
      "TYPE tags:1",
      "SMEMBERS tags:1",
      "SADD tags:1 example",
      "TTL tags:1",
      "DEL tags:1",
    ]);
  });

  test("zset prefix group emits ZRANGE ... WITHSCORES / ZADD", () => {
    expect(commandLines(generateSelectQuery(["score:*"], typeCols("zset"), redisCaps))).toEqual([
      "SCAN 0 MATCH score:* COUNT 50",
      "TYPE score:1",
      "ZRANGE score:1 0 -1 WITHSCORES",
      "ZADD score:1 1 example",
      "TTL score:1",
      "DEL score:1",
    ]);
  });

  test("mixed-type prefix group omits the read and write blocks", () => {
    expect(commandLines(generateSelectQuery(["misc:*"], typeCols("string, hash"), redisCaps))).toEqual([
      "SCAN 0 MATCH misc:* COUNT 50",
      "TYPE misc:1",
      "TTL misc:1",
      "DEL misc:1",
    ]);
  });

  test("bare key emits no SCAN line", () => {
    const out = generateSelectQuery(["counter"], typeCols("string"), redisCaps);
    expect(out).not.toContain("SCAN");
  });

  test("bare key with an unknown type omits the read and write blocks", () => {
    expect(commandLines(generateSelectQuery(["counter"], typeCols(""), redisCaps))).toEqual([
      "TYPE counter",
      "TTL counter",
      "DEL counter",
    ]);
  });

  test("every command line is a single runnable command", () => {
    for (const sample of ["string", "hash", "list", "set", "zset"]) {
      for (const name of ["user:*", "counter"]) {
        for (const line of commandLines(generateSelectQuery([name], typeCols(sample), redisCaps))) {
          expect(line).not.toContain("\n");
          expect(line).not.toContain("<");
          expect(line.split(" ")[0]).toBe(line.split(" ")[0].toUpperCase());
        }
      }
    }
  });

  test("no command line but SCAN takes the group name as a key argument", () => {
    const lines = commandLines(generateSelectQuery(["user:*"], typeCols("string"), redisCaps));
    for (const line of lines) {
      if (line.includes(":*")) expect(line.startsWith("SCAN ")).toBe(true);
    }
    expect(lines.filter((l) => l.includes("*"))).toEqual(["SCAN 0 MATCH user:* COUNT 50"]);
  });

  test("Redis no longer emits MongoDB JSON (#427 regression)", () => {
    const out = generateSelectQuery(["user:*"], typeCols("string"), redisCaps);
    expect(out).not.toContain('"collection"');
  });

  test("only the lines that need it fall back to the JSON form (#427)", () => {
    // Mixed forms in one cheatsheet are fine: the provider decides per run, and
    // every line is run on its own. Here the key needs JSON; nothing else does.
    const lines = commandLines(generateSelectQuery(['say"hi"'], typeCols("string"), redisCaps));
    expect(lines).toEqual([
      '{"command":"TYPE","args":["say\\"hi\\""]}',
      '{"command":"GET","args":["say\\"hi\\""]}',
      '{"command":"SET","args":["say\\"hi\\"","example"]}',
      '{"command":"TTL","args":["say\\"hi\\""]}',
      '{"command":"DEL","args":["say\\"hi\\""]}',
    ]);
  });

  test("a node name containing a newline stays inside the header comment (#427)", () => {
    // Redis keys are arbitrary byte strings. Raw interpolation put `DEL user:1
    // x" — select a line and Run Selected.` on line 2, which the provider then
    // ran as the buffer's first command.
    const out = generateSelectQuery(["a\nDEL user:1 x"], typeCols("string"), redisCaps);
    expect(out.split("\n")[0]).toBe('# Redis commands for "a\\nDEL user:1 x" — select a line and Run Selected.');
    for (const line of commandLines(out)) expect(line).not.toContain("Run Selected");
  });

  test("a node name containing CR LF and a quote stays inside the header comment (#427)", () => {
    const out = generateSelectQuery(['a\r\nDEL "user:1" x'], typeCols("hash"), redisCaps);
    expect(out.split("\n")[0]).toBe(
      '# Redis commands for "a\\r\\nDEL \\"user:1\\" x" — select a line and Run Selected.',
    );
    expect(commandLines(out)).toEqual([
      '{"command":"TYPE","args":["a\\r\\nDEL \\"user:1\\" x"]}',
      '{"command":"HGETALL","args":["a\\r\\nDEL \\"user:1\\" x"]}',
      '{"command":"HSET","args":["a\\r\\nDEL \\"user:1\\" x","field","example"]}',
      '{"command":"TTL","args":["a\\r\\nDEL \\"user:1\\" x"]}',
      '{"command":"DEL","args":["a\\r\\nDEL \\"user:1\\" x"]}',
    ]);
  });

  test("an ordinary node name still renders unescaped in the header (#427)", () => {
    expect(generateSelectQuery(["user:*"], typeCols("string"), redisCaps).split("\n")[0]).toBe(
      '# Redis commands for "user:*" — select a line and Run Selected.',
    );
  });

  test("the SCAN comment says one iteration is not the whole set (#427)", () => {
    const out = generateSelectQuery(["user:*"], typeCols("string"), redisCaps);
    expect(out).toContain("ONE scan iteration");
    expect(out).toContain("the reply's first row is the next cursor");
  });
});

// ============================================================================
// The click path: an object is addressed by its PATH (#789, Task 30)
//
// Three defects the user hit by clicking a table in the object browser, each
// reproduced in a real browser against a live engine before any of this was
// written, and each pinned here with the address and the engine that produced it.
// ============================================================================

describe("the generated statement addresses an object by its path", () => {
  const mssqlCaps = makeCaps({ defaultPort: 1433 });
  const clickhouseCaps = makeCaps({ defaultPort: 8123 });
  // What `OracleProvider.getCapabilities()` declares, including the terminator: the
  // generator reads the DECLARATION, so a fixture without it would pin nothing.
  const oracleCaps = makeCaps({ defaultPort: 1521, statementTerminator: "none" });

  // --- A. an object outside the session default container ------------------

  test("SQL Server qualifies a table in a non-default schema", () => {
    // Reproduced in the browser on SQL Server 2022 against `libredb_objects`:
    // clicking `app.customers` generated `SELECT TOP 50 * FROM customers;` and the
    // server answered `Invalid object name 'customers'.`
    expect(generateTableQuery(["libredb_objects", "app", "customers"], mssqlCaps)).toBe(
      "SELECT * FROM libredb_objects.app.customers;",
    );
  });

  test("ClickHouse qualifies a table in a non-default database", () => {
    // Reproduced on ClickHouse 25.8 with the connection defaulted to `demo`: clicking
    // `reporting.regions` generated `SELECT * FROM regions LIMIT 50;` and the server
    // answered `Code: 60 ... Maybe you meant reporting.regions?`.
    expect(generateTableQuery(["reporting", "regions"], clickhouseCaps)).toBe("SELECT * FROM reporting.regions;");
  });

  test("Oracle qualifies a table in another owner", () => {
    expect(generateTableQuery(["REPORTING", "REPORT_DAILY"], oracleCaps)).toBe("SELECT * FROM REPORTING.REPORT_DAILY");
  });

  test("qualification is emitted INSIDE the default container too", () => {
    // Deliberate, and the reason the fix is here rather than at the call site: no
    // capability declares which container a connection defaulted to, and the qualified
    // form is valid wherever the bare one is.
    expect(generateTableQuery(["demo", "orders"], clickhouseCaps)).toBe("SELECT * FROM demo.orders;");
  });

  test("Generate Query qualifies the same way Select Top N does", () => {
    const cols: ColumnSchema[] = [{ name: "id", type: "Int64", nullable: false, isPrimary: true }];
    expect(generateSelectQuery(["reporting", "regions"], cols, clickhouseCaps)).toBe(
      "SELECT\n  id\nFROM reporting.regions\nWHERE 1=1\nLIMIT 100;",
    );
  });

  // --- B. a name that contains a dot ---------------------------------------

  test("a dot inside a NAME is not read as a qualifier", () => {
    // The live case: ClickHouse holds `.inner_id.fake` in `demo`. Splitting the name
    // generated `SELECT * FROM "".inner_id.fake LIMIT 50;`, a syntax error at position 15.
    expect(generateTableQuery(["demo", ".inner_id.fake"], clickhouseCaps)).toBe('SELECT * FROM demo.".inner_id.fake";');
  });

  test("a one-segment path whose name holds dots stays ONE identifier", () => {
    expect(generateTableQuery([".inner_id.fake"], clickhouseCaps)).toBe('SELECT * FROM ".inner_id.fake";');
  });

  test("no string-splitting spelling of a name survives anywhere in the module", () => {
    // `quoteQualifiedName` was kept alive in Task 30 for ONE caller, `POST /api/db/profile`,
    // whose body carried a dotted name and no segments. Task 35 gave that route segments, so
    // the wrapper had no caller and was deleted: a name helper that splits on `.`, left in
    // the module with nobody calling it, is how this defect comes back (#789).
    expect(Object.keys(generators)).not.toContain("quoteQualifiedName");
  });

  // --- C. the Oracle terminator (pre-existing, not a PR regression) ---------

  test("Oracle emits no trailing semicolon", () => {
    // node-oracledb answers ORA-00933 for a trailing `;`, so clicking a table on Oracle
    // never worked. Reproduced in the browser on Oracle 26ai Free. #816 removed the
    // generated row bound from this statement; the terminator rule is untouched and this
    // assertion keeps its polarity, because the `;` is what the engine rejects.
    const out = generateTableQuery(["APP", "APP_CUSTOMERS"], oracleCaps);
    expect(out.endsWith(";")).toBe(false);
    expect(out).toBe("SELECT * FROM APP.APP_CUSTOMERS");
  });

  test("Generate Query on Oracle emits no trailing semicolon either", () => {
    const out = generateSelectQuery(["APP", "APP_CUSTOMERS"], sampleColumns, oracleCaps);
    expect(out.endsWith(";")).toBe(false);
    expect(out).toBe('SELECT\n  "id",\n  "name"\nFROM APP.APP_CUSTOMERS\nWHERE 1=1\nFETCH FIRST 100 ROWS ONLY');
  });

  // --- an address with no segments is refused rather than spelled ----------

  test("an empty address is refused by both generators", () => {
    expect(() => generateTableQuery([], clickhouseCaps)).toThrow("the object address has no segments");
    expect(() => generateSelectQuery([], [], clickhouseCaps)).toThrow("the object address has no segments");
  });
});

// The MongoDB declaration, as `MONGODB_CONTAINER_LEVELS` states it: one level, the database.
const mongoCaps = makeCaps({
  queryLanguage: "json",
  defaultPort: null,
  containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
});

// ============================================================================
// The four branches that must NOT be qualified, one test each (#789, Task 30)
// ============================================================================

describe("the dialects that address one key or collection, not a qualified name", () => {
  test("MongoDB names the collection and carries its database as its own key", () => {
    // A collection's path is [database, collection] (`MONGODB_CONTAINER_LEVELS`), and the
    // driver takes the collection name alone: `db.collection("sample_shop.users")` would
    // create a collection literally called that. The database rides as the `database`
    // key instead (#843), which is what makes the statement read the collection's own
    // database rather than the connected one.
    const parsed = JSON.parse(generateTableQuery(["sample_shop", "users"], mongoCaps));
    expect(parsed.collection).toBe("users");
    expect(parsed.database).toBe("sample_shop");
  });

  test("MongoDB's Generate Query names the collection and its database too", () => {
    const parsed = JSON.parse(generateSelectQuery(["sample_shop", "users"], sampleColumns, mongoCaps));
    expect(parsed.collection).toBe("users");
    expect(parsed.database).toBe("sample_shop");
  });

  test("the database is the segment the declaration assigns to its level, never path[0]", () => {
    // Standing ruling 5g. MongoDB declares one level, so `path[0]` would pass every other
    // test in this file; a second level in front of it is what tells the two apart.
    const caps = makeCaps({
      queryLanguage: "json",
      defaultPort: null,
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Database", labelPlural: "Databases" },
      ],
    });
    expect(JSON.parse(generateTableQuery(["outer", "sample_shop", "users"], caps)).database).toBe("sample_shop");
    expect(JSON.parse(generateSelectQuery(["outer", "sample_shop", "users"], sampleColumns, caps)).database).toBe(
      "sample_shop",
    );
  });

  test("a path that does not match the declared levels is refused, not addressed by guess", () => {
    // One segment on an engine that declares a database level has lost its database:
    // emitting no key would read the connected database's same-named collection, which is
    // the #843 wrong answer again.
    expect(() => generateTableQuery(["users"], mongoCaps)).toThrow("[schema, name]");
    expect(() => generateTableQuery(["a", "b", "users"], mongoCaps)).toThrow("[schema, name]");
    // A declared level that is not the database level cannot be read as one.
    const noDatabaseLevel = makeCaps({
      queryLanguage: "json",
      defaultPort: null,
      containerLevels: [{ id: "catalog", label: "Catalog", labelPlural: "Catalogs" }],
    });
    expect(() => generateTableQuery(["outer", "users"], noDatabaseLevel)).toThrow('"schema" container level');
  });

  test("Redis takes the bare key, never the database segment with it", () => {
    // A Redis key's path is [database index, key] (`redis.ts` listObjects), and a key
    // argument is a literal byte string: `GET 0.counter` reads a key nobody wrote.
    const caps = makeCaps({ queryLanguage: "json", defaultPort: 6379, queryDialect: "redis" });
    const typeCols: ColumnSchema[] = [{ name: "type", type: "string", nullable: false, isPrimary: false }];
    expect(generateTableQuery(["0", "counter"], caps, typeCols)).toBe("GET counter");
    expect(generateTableQuery(["0", "user:*"], caps, typeCols)).toBe("SCAN 0 MATCH user:* COUNT 50");
  });

  test("LibreDB takes the bare key", () => {
    // LibreDB declares NO container levels, so a key's path is one segment; this pins that
    // the command still carries the key alone if that ever changes.
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    expect(generateTableQuery(["users:*"], caps)).toBe("prefix users:");
    expect(generateTableQuery(["orphan"], caps)).toBe("get orphan");
  });

  test("Couchbase keeps the WHOLE keyspace qualification", () => {
    // The opposite case, and the reason this is four tests rather than one rule: a
    // keyspace is addressed bucket.scope.collection (`COUCHBASE_CONTAINER_LEVELS`), and
    // SQL++ needs every part of it.
    expect(generateTableQuery(["travel", "inventory", "hotel"], makeCaps({ defaultPort: 8091 }))).toBe(
      "SELECT META(d).id AS __id, d.* FROM `travel`.`inventory`.`hotel` AS d;",
    );
  });
});

// ============================================================================
// PromQL (#1085): a metric is addressed by a selector, never by a quoted path
// ============================================================================

/** The capabilities #1085 section 6.3 gives Prometheus, varied from the SQL helper only where it says. */
const promqlCaps = makeCaps({
  queryLanguage: "promql",
  defaultPort: 9090,
  statementTerminator: "none",
  supportsExplain: false,
  supportsExternalQueryLimiting: false,
  supportsCreateTable: false,
  supportsInlineRowEdit: false,
  supportsMaintenance: false,
  supportsConnectionString: false,
});

/**
 * The names #1085 S4 names, each of which a bare selector would misread or break out of: `nan` and
 * `Inf` lex as numbers, `sum` as an aggregator, and the rest carry a quote, a backslash, a line
 * feed, or a text built to close the matcher and open a second selector. Each maps to the one
 * braced selector #1085 S4 gives it, `{__name__=` then the name as a JSON string then `}`, spelled
 * as raw text so every backslash is literal.
 */
const ESCAPED_NAMES: readonly (readonly [label: string, name: string, selector: string])[] = [
  ["nan, which the lexer reads as a number", "nan", '{__name__="nan"}'],
  ["Inf, in any case", "Inf", '{__name__="Inf"}'],
  ["sum, an aggregator", "sum", '{__name__="sum"}'],
  ["a name holding a line feed", "a\nb", String.raw`{__name__="a\nb"}`],
  [
    "a name built to close the matcher and open a second selector",
    'x"} or {__name__=~".+',
    String.raw`{__name__="x\"} or {__name__=~\".+"}`,
  ],
  ["a quote", 'a"b', String.raw`{__name__="a\"b"}`],
  ["a backslash", "a\\b", String.raw`{__name__="a\\b"}`],
];

/**
 * The name a braced selector addresses, read back out of it: a `__name__` matcher holds exactly
 * one JSON-quoted string, and decoding it must give back the name the selector was built for.
 */
const nameInBracedSelector = (selector: string): string | undefined => {
  const match = /^\{__name__=("(?:[^"\\]|\\.)*")\}$/.exec(selector);
  return match === null ? undefined : (JSON.parse(match[1]!) as string);
};

/** A label name built to leave a selector if anything ever wrote a column into the text. */
const hostileLabelColumns: ColumnSchema[] = [
  { name: 'job"} or vector(1) #\nup', type: "string", nullable: true, isPrimary: false },
];

describe("PromQL tree click (#1085)", () => {
  test("a tree click on a metric runs its bare selector, and nothing else", () => {
    expect(generateTableQuery(["http_requests_total"], promqlCaps)).toBe("http_requests_total");
    // The control: the same path on the SQL helper is the SELECT a PromQL connection would have
    // been sent without the arm, so the text above is the arm's and not the name's.
    expect(generateTableQuery(["http_requests_total"], makeCaps())).toBe("SELECT * FROM http_requests_total;");
  });

  test("a legacy name with colons, a recording rule's output, stays bare", () => {
    expect(generateTableQuery(["job:http_requests:rate5m"], promqlCaps)).toBe("job:http_requests:rate5m");
  });

  test.each(ESCAPED_NAMES)(
    "a tree click on %s runs one braced selector that decodes to the name",
    (_label, name, selector) => {
      const text = generateTableQuery([name], promqlCaps);
      expect(text).toBe(selector);
      expect(text.split("\n")).toHaveLength(1);
      expect(nameInBracedSelector(text)).toBe(name);
      // One builder: the text is metricSelector's answer, never a second escaper's.
      expect(text).toBe(metricSelector(name));
    },
  );

  test("the metric's columns never reach the click's text", () => {
    expect(generateTableQuery(["up"], promqlCaps, hostileLabelColumns)).toBe("up");
  });
});

// ============================================================================
// Kafka (#1088): a topic click is a JSON read request, never a MongoDB document
// ============================================================================

/** The capabilities #1088 section 6.2 gives Kafka, varied from the SQL helper only where it says. */
const kafkaCaps = makeCaps({
  queryLanguage: "json",
  queryDialect: "kafka",
  defaultPort: 9092,
  statementTerminator: "none",
  supportsExplain: false,
  supportsExternalQueryLimiting: false,
  supportsCreateTable: false,
  supportsInlineRowEdit: false,
  supportsMaintenance: false,
  supportsConnectionString: false,
  containerLevels: [],
});

describe("Kafka tree click (#1088)", () => {
  test("a tree click on a topic reads its latest 50 messages, as one JSON read request", () => {
    const text = generateTableQuery(["orders"], kafkaCaps);
    expect(text).toBe(JSON.stringify({ topic: "orders", from: "latest", limit: 50 }, null, 2));
    expect(JSON.parse(text)).toEqual({ topic: "orders", from: "latest", limit: 50 });
    expect(text).not.toContain('"collection"');
    // The control: the same path on a JSON engine with no dialect is the MongoDB `find` a Kafka
    // connection would have been sent without the arm, so the text above is the arm's own.
    const mongodb = makeCaps({ queryLanguage: "json", containerLevels: [] });
    expect(JSON.parse(generateTableQuery(["orders"], mongodb))).toMatchObject({
      collection: "orders",
      operation: "find",
    });
  });

  test.each([
    ["a quote", 'or"ders'],
    ["a backslash", "or\\ders"],
    ["a line feed", "or\nders"],
    ["a key-shaped name", '"},{"topic":"other'],
    ["an Object.prototype member", "__proto__"],
  ])("a topic named with %s is written through JSON.stringify and reads back unchanged", (_label, topic) => {
    const text = generateTableQuery([topic], kafkaCaps);
    const request = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(request)).toEqual(["topic", "from", "limit"]);
    expect(request.topic).toBe(topic);
    expect(text).toBe(JSON.stringify({ topic, from: "latest", limit: 50 }, null, 2));
  });

  test("the topic's own segment is read, and no column reaches the text", () => {
    // A topic row's path is one segment (no container level), and the generator reads the object's
    // own segment whatever it is handed, as the other JSON arms do.
    expect(JSON.parse(generateTableQuery(["app", "orders"], kafkaCaps, sampleColumns))).toEqual({
      topic: "orders",
      from: "latest",
      limit: 50,
    });
  });

  test("the click's text is a request the provider's own parser reads as is", () => {
    // The click auto-executes, so "runs as is" is the provider's parser reading the exact text,
    // not a claim: the latest 50 messages of the topic, across every partition.
    expect(parseReadRequest(generateTableQuery(["orders"], kafkaCaps), DEFAULT_QUERY_LIMIT)).toEqual({
      topic: "orders",
      from: { kind: "latest" },
      limit: 50,
    });
  });
});

/**
 * The lines of a PromQL text the engine evaluates. PromQL reads `#` as a comment to the end of
 * the line, and every comment these generators write is a whole line of its own, so what is left
 * once blank lines and `#` lines are dropped is the expression that runs.
 */
const runnableLines = (text: string): string[] =>
  text.split("\n").filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));

/** A metric's columns as the inventory reports them: its label names, then timestamp and value (#1085, section 4.2). */
const metricColumns: ColumnSchema[] = [
  { name: "job", type: "string", nullable: true, isPrimary: false },
  { name: "instance", type: "string", nullable: true, isPrimary: false },
  { name: "timestamp", type: "timestamp", nullable: false, isPrimary: false },
  { name: "value", type: "float", nullable: false, isPrimary: false },
];

describe("PromQL Generate Query (#1085)", () => {
  test("writes one runnable selector, with the range forms of #1085 section 5.1 as comments above it", () => {
    const text = generateSelectQuery(["http_requests_total"], metricColumns, promqlCaps);

    expect(text).toBe(
      [
        '# PromQL for the metric "http_requests_total". Only the last line runs: a line starting with # is a comment.',
        "# To try a form below, select it after its # and use Run Selected.",
        "#",
        "# Every raw sample from the last five minutes, one column per series:",
        "#   http_requests_total[5m]",
        "# For a counter: its per-second rate over the last hour, one row a minute:",
        "#   rate(http_requests_total[5m])[1h:1m]",
        "#",
        "# Every series of the metric as of now, one row per series:",
        "http_requests_total",
      ].join("\n"),
    );
    // Run as it stands, the buffer is exactly one expression: every other line is a # comment.
    expect(runnableLines(text)).toEqual(["http_requests_total"]);
  });

  test("the control: the same call on the SQL helper writes a SELECT, so the text above is the arm's", () => {
    const sql = generateSelectQuery(["http_requests_total"], metricColumns, makeCaps());
    expect(sql).toContain("SELECT");
    expect(runnableLines(sql)).not.toEqual(["http_requests_total"]);
  });

  test.each(ESCAPED_NAMES)(
    "Generate Query on %s keeps exactly one runnable line, the braced selector",
    (_label, name, selector) => {
      const text = generateSelectQuery([name], metricColumns, promqlCaps);

      expect(runnableLines(text)).toEqual([selector]);
      // Every other line is a whole comment, so no part of the name ended one early.
      for (const line of text.split("\n")) {
        if (line !== selector) expect(line.startsWith("#"), JSON.stringify(line)).toBe(true);
      }
      // The name reaches the header through commentName, JSON-quoted, and the forms carry the selector.
      expect(text).toContain(`# PromQL for the metric ${JSON.stringify(name)}.`);
      expect(text).toContain(`#   ${selector}[5m]`);
      expect(text).toContain(`#   rate(${selector}[5m])[1h:1m]`);
    },
  );

  test("no bound, no terminator and no label name reach the Generate Query text", () => {
    const text = generateSelectQuery(["up"], hostileLabelColumns, promqlCaps);

    expect(runnableLines(text)).toEqual(["up"]);
    expect(text).not.toContain("vector(1)");
    expect(text).not.toContain("LIMIT");
    expect(text).not.toContain(";");
    // The control: the SQL arm does project that column, which is exactly what this arm must not do.
    const sql = generateSelectQuery(["up"], hostileLabelColumns, makeCaps());
    expect(sql).toContain("vector(1)");
    expect(sql).toContain(";");
  });
});

/**
 * Every export of the module, classified for a PromQL connection (#1085). The two generators have
 * a PromQL arm (the two describes above). `objectSegment` answers the last path segment, which is
 * a metric's name, and has no dialect. `generateCountQuery` answers `null` for PromQL, because
 * `offersCountQuery` refuses the language (the `prometheus` row of tests/unit/lib/table-count.test.ts,
 * built from the provider's own capabilities). `shouldRefreshSchema` runs the pattern the connected
 * provider declares and has no dialect either. `quoteIdentifier` and `quoteObjectPath` write SQL
 * and MongoDB spellings, and a PromQL connection never reaches them: `POST /api/db/profile`
 * refuses the language before its SQL branch (tests/api/db/profile.test.ts), both row menus
 * withhold Generate Test Data on a metric (tests/unit/components/object-tree-row-actions.test.ts,
 * tests/components/schema-explorer/TableItem.test.tsx), and the import dialog offers no metric as
 * a target: it offers only objects whose kind declares row writes
 * (tests/components/DataImportModal.test.tsx), and no Prometheus kind declares them
 * (tests/unit/db/prometheus/objects.test.ts). `escapeGlob` escapes a Redis `MATCH` glob, and its
 * only callers outside the Redis generator arm are the key browser's patterns, a surface offered only
 * where the provider declares `keyScan` (tests/components/sidebar/Sidebar.test.tsx, and Browse Keys in
 * tests/unit/components/object-tree-row-actions.test.ts), which Prometheus does not: its whole
 * capability object is pinned in tests/unit/db/prometheus/provider.test.ts. `jsonCommandAddress` is
 * read only inside a `queryLanguage === "json"` arm: the three generators' own, the profiler's after
 * the language refusal above, and Generate Test Data's, which no metric row offers. An export added later has
 * no classification, so this list fails until somebody writes one for it.
 */
describe("the module's exports, for a PromQL connection (#1085)", () => {
  test("every export is one this file has classified", () => {
    expect(Object.keys(generators).sort()).toEqual([
      "escapeGlob",
      "generateCountQuery",
      "generateSelectQuery",
      "generateTableQuery",
      "jsonCommandAddress",
      "objectSegment",
      "quoteIdentifier",
      "quoteObjectPath",
      "shouldRefreshSchema",
    ]);
  });
});
