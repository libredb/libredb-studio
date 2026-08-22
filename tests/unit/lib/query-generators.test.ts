import { describe, test, expect } from "bun:test";
import {
  generateTableQuery,
  generateSelectQuery,
  shouldRefreshSchema,
  quoteIdentifier,
  quoteQualifiedName,
} from "@/lib/query-generators";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";

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
  test("SQL (postgres/mysql/sqlite) uses LIMIT 50", () => {
    const result = generateTableQuery("users", makeCaps({ defaultPort: 5432 }));
    expect(result).toBe("SELECT * FROM users LIMIT 50;");
  });

  test("JSON (MongoDB) generates JSON find query", () => {
    const result = generateTableQuery("users", makeCaps({ queryLanguage: "json", defaultPort: null }));
    const parsed = JSON.parse(result);
    expect(parsed.collection).toBe("users");
    expect(parsed.operation).toBe("find");
    expect(parsed.options.limit).toBe(50);
  });

  test("Oracle (port 1521) uses FETCH FIRST 50 ROWS ONLY", () => {
    const result = generateTableQuery("users", makeCaps({ defaultPort: 1521 }));
    expect(result).toContain("FETCH FIRST 50 ROWS ONLY");
    // Oracle folds unquoted identifiers to UPPERCASE, so a lowercase name is
    // quoted to preserve it.
    expect(result).toContain('SELECT * FROM "users"');
  });

  test("MSSQL (port 1433) uses TOP 50", () => {
    const result = generateTableQuery("users", makeCaps({ defaultPort: 1433 }));
    expect(result).toBe("SELECT TOP 50 * FROM users;");
  });

  // #424 Phase 1, measured 2026-08-19 against Elasticsearch 9.1.4 and OpenSearch
  // 3.8.0. Elasticsearch SQL has no statement terminator in its grammar: the
  // generator's own `SELECT * FROM orders LIMIT 50;` answered
  // `line 1:30: extraneous input ';' expecting <EOF>`, so the FIRST click on an
  // index in the schema tree failed. OpenSearch tolerates the `;`, and omitting it
  // runs on both, so one answer serves both products.
  test("a dialect that declares no terminator gets no trailing semicolon", () => {
    const caps = makeCaps({ defaultPort: 9200, statementTerminator: "none" });
    expect(generateTableQuery("orders", caps)).toBe("SELECT * FROM orders LIMIT 50");
  });

  test('LibreDB dialect: a ":*" prefix group scans with prefix', () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    expect(generateTableQuery("users:*", caps)).toBe("prefix users:");
  });

  test("LibreDB dialect: a bare (no-colon) group reads with get", () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    expect(generateTableQuery("orphan", caps)).toBe("get orphan");
  });

  // "Scan Keys" AUTO-EXECUTES through `handleTableClick`, and a key name is
  // server data interpolated raw into a line-oriented grammar. For a key named
  // `x\ndelete billing:2024` this used to return `get x\ndelete billing:2024`:
  // only `get x` ran, but line 2 sat in the editor as a runnable
  // `delete billing:2024`, one Run Selected away. Same answer as the cheatsheet
  // gives — emit the note, emit no command (U11).
  test("LibreDB dialect: a newline-bearing key name emits the note and NO command", () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    const out = generateTableQuery("x\ndelete billing:2024", caps);
    const runnable = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    expect(runnable).toEqual([]);
    expect(out).toContain("# This key's name contains a line break.");
  });

  test("LibreDB dialect: a bare CR in a key name refuses the same way (U11)", () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    expect(generateTableQuery("x\rdelete billing:2024", caps)).not.toContain("get x");
  });

  test("LibreDB dialect: a newline-bearing PREFIX GROUP refuses too (U11)", () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    expect(generateTableQuery("x\ndelete billing:2024:*", caps)).not.toContain("prefix ");
  });

  // The two LibreDB branches must not drift: Scan Keys and the cheatsheet emit
  // the identical note text for the identical name (U11).
  test("LibreDB dialect: Scan Keys and the cheatsheet share one refusal note (U11)", () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    const note = generateTableQuery("x\ndelete billing:2024", caps);
    expect(generateSelectQuery("x\ndelete billing:2024", [], caps)).toContain(note);
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
    const out = generateSelectQuery("orders", sampleColumns, caps);
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
    const out = generateSelectQuery("users:*", kvColumns, libreCaps);
    expect(out.split("\n").some((l) => l.trim().startsWith("#"))).toBe(true);
  });

  test("a node name containing a newline emits a note and NO command line (#427)", () => {
    // A key name is server data. `get`/`put`/`delete` interpolate it raw, so its
    // second line rendered as a runnable command of its own — `delete billing:2024`
    // below would have been executed by Run Selected. LibreDB has no lossless JSON
    // command form to fall back to, so the cheatsheet declines to guess.
    const out = generateSelectQuery("x\ndelete billing:2024", kvColumns, libreCaps);
    expect(out.split("\n")[0]).toBe(
      '# LibreDB commands for "x\\ndelete billing:2024" — select a line and Run Selected.',
    );
    expect(commandLines(out)).toEqual([]);
    expect(out).toContain("# This key's name contains a line break.");
    expect(out).not.toContain("delete billing:2024\n");
  });

  test("a node name containing a bare CR emits the same note (#427)", () => {
    // A lone CR ends a line for an editor and for Run Selected just as LF does.
    const out = generateSelectQuery("x\rdelete billing:2024", kvColumns, libreCaps);
    expect(commandLines(out)).toEqual([]);
  });

  test("a PREFIX GROUP whose name contains a newline emits the same note (#427)", () => {
    const out = generateSelectQuery("x\ndelete billing:2024:*", kvColumns, libreCaps);
    expect(commandLines(out)).toEqual([]);
  });

  test("an ordinary node name still renders unescaped in the header (#427)", () => {
    expect(generateSelectQuery("users:*", kvColumns, libreCaps).split("\n")[0]).toBe(
      '# LibreDB commands for "users:*" — select a line and Run Selected.',
    );
  });

  test("relational group: put example is a concrete JSON object from the columns", () => {
    const out = generateSelectQuery("users:*", relationalColumns, libreCaps);
    expect(commandLines(out)).toEqual([
      "prefix users:",
      "get users:1",
      `put users:1 '{"id":"example","age":1,"active":true}'`,
      "delete users:1",
    ]);
  });

  test("raw kv group (key/value columns): put example uses a plain value", () => {
    const out = generateSelectQuery("config:*", kvColumns, libreCaps);
    expect(commandLines(out)).toEqual(["prefix config:", "get config:1", "put config:1 example", "delete config:1"]);
  });

  test("bare (no-colon) group: get/put/delete on the key itself, no prefix scan", () => {
    const out = generateSelectQuery("orphan", kvColumns, libreCaps);
    expect(commandLines(out)).toEqual(["get orphan", "put orphan example", "delete orphan"]);
  });

  test("relational group: object and unknown column types map to example JSON values", () => {
    const exoticColumns: ColumnSchema[] = [
      { name: "id", type: "string", nullable: false, isPrimary: true },
      { name: "meta", type: "object", nullable: true, isPrimary: false },
      { name: "notes", type: "text", nullable: true, isPrimary: false },
    ];
    const out = generateSelectQuery("things:*", exoticColumns, libreCaps);
    expect(commandLines(out)).toContain(`put things:1 '{"id":"example","meta":{},"notes":"example"}'`);
  });

  test("document collection (id/document columns): put example is a small JSON object", () => {
    const docColumns: ColumnSchema[] = [
      { name: "id", type: "string", nullable: false, isPrimary: true },
      { name: "document", type: "object", nullable: true, isPrimary: false },
    ];
    const out = generateSelectQuery("articles:*", docColumns, libreCaps);
    expect(commandLines(out)).toContain(`put articles:1 '{"name":"example"}'`);
  });

  test("every command line is a concrete, directly-runnable verb (no placeholders)", () => {
    const out = generateSelectQuery("people:*", kvColumns, libreCaps);
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
    const result = generateSelectQuery("users", sampleColumns, makeCaps({ defaultPort: 5432 }));
    expect(result).toContain("id");
    expect(result).toContain("name");
    expect(result).toContain("LIMIT 100");
    expect(result).toContain("WHERE 1=1");
  });

  test("JSON (MongoDB) generates projection", () => {
    const result = generateSelectQuery("users", sampleColumns, makeCaps({ queryLanguage: "json", defaultPort: null }));
    const parsed = JSON.parse(result);
    expect(parsed.collection).toBe("users");
    expect(parsed.options.projection.id).toBe(1);
    expect(parsed.options.projection.name).toBe(1);
    expect(parsed.options.limit).toBe(100);
  });

  test("Oracle uses FETCH FIRST 100 ROWS ONLY", () => {
    const result = generateSelectQuery("users", sampleColumns, makeCaps({ defaultPort: 1521 }));
    expect(result).toContain("FETCH FIRST 100 ROWS ONLY");
    expect(result).toContain("id");
    expect(result).toContain("name");
  });

  test("MSSQL uses TOP 100", () => {
    const result = generateSelectQuery("users", sampleColumns, makeCaps({ defaultPort: 1433 }));
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
    expect(generateTableQuery("hotel", couchbaseCaps)).toBe(
      "SELECT META(d).id AS __id, d.* FROM `hotel` AS d LIMIT 50;",
    );
  });

  test("generateTableQuery quotes every segment of a scope-qualified collection", () => {
    expect(generateTableQuery("inventory.hotel", couchbaseCaps)).toBe(
      "SELECT META(d).id AS __id, d.* FROM `inventory`.`hotel` AS d LIMIT 50;",
    );
  });

  test("generateSelectQuery projects fields through the alias and the key through META", () => {
    expect(generateSelectQuery("inventory.hotel", hotelColumns, couchbaseCaps)).toBe(
      "SELECT\n  META(d).id AS __id,\n  d.`city`\nFROM `inventory`.`hotel` AS d\nWHERE 1=1\nLIMIT 100;",
    );
  });

  test("generateSelectQuery falls back to the wildcard when no columns are known", () => {
    expect(generateSelectQuery("hotel", [], couchbaseCaps)).toBe(
      "SELECT\n  META(d).id AS __id,\n  d.*\nFROM `hotel` AS d\nWHERE 1=1\nLIMIT 100;",
    );
  });

  test("generateSelectQuery adds the key projection even when the columns carry no key", () => {
    const cityOnly: ColumnSchema[] = [{ name: "city", type: "string", nullable: true, isPrimary: false }];
    const out = generateSelectQuery("hotel", cityOnly, couchbaseCaps);
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

  test("quoteQualifiedName quotes each segment independently", () => {
    expect(quoteQualifiedName("inventory.hotel", couchbaseCaps)).toBe("`inventory`.`hotel`");
  });
});

// ============================================================================
// ClickHouse (issue #264) — no dialect branch of its own, and that is the claim
// under test: every string below was run against ClickHouse 26.7.1 and accepted.
// ============================================================================

describe("ClickHouse (8123) generation", () => {
  const clickhouseCaps = makeCaps({ defaultPort: 8123 });

  test("generateTableQuery uses the plain LIMIT form", () => {
    expect(generateTableQuery("events", clickhouseCaps)).toBe("SELECT * FROM events LIMIT 50;");
  });

  test("generateTableQuery qualifies and quotes a database-scoped table per segment", () => {
    // Cross-database tables are addressed as `database.table`, so the dot must stay
    // a separator; ClickHouse is case-sensitive, so a mixed-case name needs quoting.
    expect(generateTableQuery("demo.Events", clickhouseCaps)).toBe('SELECT * FROM demo."Events" LIMIT 50;');
  });

  test("generateSelectQuery emits a double-quoted column list and LIMIT 100", () => {
    const cols: ColumnSchema[] = [
      { name: "id", type: "Int32", nullable: false, isPrimary: true },
      { name: "Name", type: "Nullable(String)", nullable: true, isPrimary: false },
    ];
    expect(generateSelectQuery("demo.regtest", cols, clickhouseCaps)).toBe(
      'SELECT\n  id,\n  "Name"\nFROM demo.regtest\nWHERE 1=1\nLIMIT 100;',
    );
  });

  test("the trailing LIMIT is the last clause, so a user-appended FORMAT stays legal", () => {
    // `... FORMAT TSV LIMIT 1` is a syntax error; `... LIMIT 1 FORMAT TSV` is not.
    const out = generateTableQuery("events", clickhouseCaps);
    expect(out.trimEnd().endsWith("LIMIT 50;")).toBe(true);
  });

  test("quoteIdentifier keeps plain lowercase bare and double-quotes anything else", () => {
    // ClickHouse never folds case, so quoting is only about parseability, and its
    // quote character is the double quote the default branch already emits.
    expect(quoteIdentifier("events", clickhouseCaps)).toBe("events");
    expect(quoteIdentifier("Events", clickhouseCaps)).toBe('"Events"');
    expect(quoteIdentifier("weird name", clickhouseCaps)).toBe('"weird name"');
    expect(quoteIdentifier('we"ird', clickhouseCaps)).toBe('"we""ird"');
  });

  test("quoteQualifiedName keeps the database separator intact", () => {
    expect(quoteQualifiedName("demo.regtest", clickhouseCaps)).toBe("demo.regtest");
    expect(quoteQualifiedName("demo.Events", clickhouseCaps)).toBe('demo."Events"');
  });
});

// ============================================================================
// Apache Druid (issue #265) — Druid has a dialect branch of its own that quotes
// UNCONDITIONALLY, and that is the claim under test: every string below was run
// against Apache Druid 37.0.0 through POST /druid/v2/sql and accepted.
// ============================================================================

describe("Druid (8888) generation", () => {
  const druidCaps = makeCaps({ defaultPort: 8888 });

  test("generateTableQuery quotes the datasource and uses the plain LIMIT form", () => {
    expect(generateTableQuery("libredb_demo", druidCaps)).toBe('SELECT * FROM "libredb_demo" LIMIT 50;');
  });

  // The trap that makes the default branch correct for Druid rather than merely
  // adequate: Druid rejects ORDER BY on a non-__time column of a plain table scan
  // with 400 "SQL query requires ordering a table by non-time column [[qty]], which
  // is not supported." A generator that ordered by the primary key - the obvious
  // thing to do for a "top 50" - would produce a query that cannot be planned on
  // any Druid datasource. So no provider-generated scan may ever carry ORDER BY.
  test("no generated Druid statement carries ORDER BY", () => {
    expect(generateTableQuery("libredb_demo", druidCaps)).not.toContain("ORDER BY");
    expect(generateSelectQuery("libredb_demo", sampleColumns, druidCaps)).not.toContain("ORDER BY");
  });

  test("generateSelectQuery emits a double-quoted column list and LIMIT 100", () => {
    const cols: ColumnSchema[] = [
      { name: "id", type: "BIGINT", nullable: true, isPrimary: false },
      { name: "region", type: "VARCHAR", nullable: true, isPrimary: false },
    ];
    expect(generateSelectQuery("libredb_demo", cols, druidCaps)).toBe(
      'SELECT\n  "id",\n  "region"\nFROM "libredb_demo"\nWHERE 1=1\nLIMIT 100;',
    );
  });

  test("the __time column is quoted like every other column", () => {
    // __time is mandatory on every datasource, so it is in almost every generated
    // projection. It parses both bare and quoted; quoting it needs no exception.
    const cols: ColumnSchema[] = [{ name: "__time", type: "TIMESTAMP", nullable: false, isPrimary: true }];
    expect(generateSelectQuery("libredb_demo", cols, druidCaps)).toContain('  "__time"');
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

  test("quoteQualifiedName quotes each segment and keeps the schema separator intact", () => {
    // Druid's single catalog exposes one user schema, `druid`, and both the bare and
    // the schema-qualified form resolve, so the dot must stay a separator:
    // `SELECT * FROM "druid"."libredb_demo" LIMIT 1` -> HTTP 200.
    expect(quoteQualifiedName("druid.libredb_demo", druidCaps)).toBe('"druid"."libredb_demo"');
  });

  test("generateSelectQuery with no columns falls back to a bare star, not a quoted one", () => {
    // `SELECT "*"` would be a column literally named `*`; the star must stay bare.
    expect(generateSelectQuery("libredb_demo", [], druidCaps)).toBe(
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
    expect(generateTableQuery("nation", trinoCaps)).toBe("SELECT * FROM nation LIMIT 50");
  });

  test("generateSelectQuery emits the column list unquoted and no terminator", () => {
    // Live: the same five lines answer the two columns. Unquoted lowercase names
    // round-trip because Trino folds an unquoted identifier to lower case.
    expect(generateSelectQuery("nation", sampleColumns, trinoCaps)).toBe(
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

  test("quoteQualifiedName keeps the catalog.schema.table separators intact", () => {
    // Three levels rather than two, which is what a catalog adds: measured,
    // `SELECT * FROM tpch.sf1.nation LIMIT 50` resolves fully qualified.
    expect(quoteQualifiedName("tpch.sf1.nation", trinoCaps)).toBe("tpch.sf1.nation");
    expect(quoteQualifiedName("tpch.sf1.Nation", trinoCaps)).toBe('tpch.sf1."Nation"');
  });

  test("a backtick is never emitted for this dialect", () => {
    // The trap #424 Phase 1 recorded, in the other direction: the port cannot say
    // which quote character an HTTP engine uses. Measured, Trino refuses a backtick
    // outright - "backquoted identifiers are not supported; use double quotes to
    // quote identifiers" - so a generator that guessed MySQL's form from a generic
    // port would produce a statement no Trino coordinator can parse.
    expect(quoteIdentifier("Weird", trinoCaps)).not.toContain("`");
    expect(generateSelectQuery("nation", sampleColumns, trinoCaps)).not.toContain("`");
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
    // Measured: `SELECT * FROM probe.customers LIMIT 50;` returns rows - CQL accepts
    // a trailing semicolon on a single statement - and `LIMIT n` is its own row bound.
    // So no `statementTerminator` is declared and no branch is added.
    expect(generateTableQuery("customers", cassandraCaps)).toBe("SELECT * FROM customers LIMIT 50;");
  });

  test("a keyspace-qualified name keeps its separator", () => {
    expect(quoteQualifiedName("probe.customers", cassandraCaps)).toBe("probe.customers");
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
    expect(generateTableQuery("Customer", makeCaps({ defaultPort: 5432 }))).toBe('SELECT * FROM "Customer" LIMIT 50;');
  });

  test("schema-qualified names are quoted per-segment, not as one identifier", () => {
    // lowercase schema.table → no quotes (Postgres)
    expect(quoteQualifiedName("employees.department", makeCaps({ defaultPort: 5432 }))).toBe("employees.department");
    // mixed-case table in a schema → only the table segment is quoted
    expect(quoteQualifiedName("public.Order", makeCaps({ defaultPort: 5432 }))).toBe('public."Order"');
    // bare name (no dot) is unchanged
    expect(quoteQualifiedName("Customer", makeCaps({ defaultPort: 5432 }))).toBe('"Customer"');
  });

  test("generateTableQuery on a schema-qualified table does NOT wrap the dot (regression)", () => {
    // Was producing the broken `"employees.department"`; must be `employees.department`.
    expect(generateTableQuery("employees.department", makeCaps({ defaultPort: 5432 }))).toBe(
      "SELECT * FROM employees.department LIMIT 50;",
    );
  });

  test("generateSelectQuery quotes mixed-case table and columns (Postgres)", () => {
    const cols: ColumnSchema[] = [
      { name: "Id", type: "integer", nullable: false, isPrimary: true },
      { name: "full_name", type: "text", nullable: true, isPrimary: false },
    ];
    const result = generateSelectQuery("Customer", cols, makeCaps({ defaultPort: 5432 }));
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
    expect(generateTableQuery("user:*", redisCaps, typeCols("string"))).toBe("SCAN 0 MATCH user:* COUNT 50");
  });

  test("prefix group SCANs regardless of the sampled type", () => {
    expect(generateTableQuery("session:*", redisCaps, typeCols("hash"))).toBe("SCAN 0 MATCH session:* COUNT 50");
  });

  test("bare key, string sample -> GET", () => {
    expect(generateTableQuery("counter", redisCaps, typeCols("string"))).toBe("GET counter");
  });

  test("bare key, hash sample -> HGETALL", () => {
    expect(generateTableQuery("counter", redisCaps, typeCols("hash"))).toBe("HGETALL counter");
  });

  test("bare key, list sample -> LRANGE k 0 -1", () => {
    expect(generateTableQuery("counter", redisCaps, typeCols("list"))).toBe("LRANGE counter 0 -1");
  });

  test("bare key, set sample -> SMEMBERS", () => {
    expect(generateTableQuery("counter", redisCaps, typeCols("set"))).toBe("SMEMBERS counter");
  });

  test("bare key, zset sample -> ZRANGE k 0 -1 WITHSCORES", () => {
    expect(generateTableQuery("counter", redisCaps, typeCols("zset"))).toBe("ZRANGE counter 0 -1 WITHSCORES");
  });

  test('bare key, mixed sample ("string, hash") -> TYPE', () => {
    expect(generateTableQuery("counter", redisCaps, typeCols("string, hash"))).toBe("TYPE counter");
  });

  test('bare key, unrecognised sample ("stream") -> TYPE', () => {
    expect(generateTableQuery("counter", redisCaps, typeCols("stream"))).toBe("TYPE counter");
  });

  test('bare key, empty sample ("") -> TYPE', () => {
    expect(generateTableQuery("counter", redisCaps, typeCols(""))).toBe("TYPE counter");
  });

  test("bare key with no columns argument -> TYPE", () => {
    expect(generateTableQuery("counter", redisCaps)).toBe("TYPE counter");
  });

  test('bare key with columns that have no "type" column -> TYPE', () => {
    expect(generateTableQuery("counter", redisCaps, sampleColumns)).toBe("TYPE counter");
  });

  test("glob metacharacters in the prefix are escaped in MATCH", () => {
    // The escape introduces a backslash, which the plain tokenizer cannot be
    // trusted to carry, so the line switches to the lossless JSON form (#427).
    expect(generateTableQuery("a[b:*", redisCaps, typeCols("string"))).toBe(
      '{"command":"SCAN","args":["0","MATCH","a\\\\[b:*","COUNT","50"]}',
    );
  });

  test("a key containing a double quote falls back to the JSON form (#427)", () => {
    // Plain `GET "say"hi""` tokenizes to the key `sayhi` — a different key.
    expect(generateTableQuery('say"hi"', redisCaps, typeCols("string"))).toBe(
      '{"command":"GET","args":["say\\"hi\\""]}',
    );
  });

  test("a key containing a single quote falls back to the JSON form (#427)", () => {
    expect(generateTableQuery("it's", redisCaps, typeCols("hash"))).toBe('{"command":"HGETALL","args":["it\'s"]}');
  });

  test("a quoted prefix group falls back to the JSON form (#427)", () => {
    expect(generateTableQuery('a"b:*', redisCaps, typeCols("string"))).toBe(
      '{"command":"SCAN","args":["0","MATCH","a\\"b:*","COUNT","50"]}',
    );
  });

  test("an argument containing whitespace is quoted", () => {
    expect(generateTableQuery("my key", redisCaps, typeCols(""))).toBe('TYPE "my key"');
  });

  test("returns exactly one line", () => {
    expect(generateTableQuery("user:*", redisCaps, typeCols("string"))).not.toContain("\n");
    expect(generateTableQuery("counter", redisCaps, typeCols("string"))).not.toContain("\n");
  });

  test("Redis no longer emits MongoDB JSON (#427 regression)", () => {
    const result = generateTableQuery("user:*", redisCaps, typeCols("string"));
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
    const out = generateSelectQuery("user:*", typeCols("string"), redisCaps);
    expect(out.split("\n").some((l) => l.trim().startsWith("#"))).toBe(true);
  });

  test("prefix group (string) emits the exact cheatsheet", () => {
    expect(generateSelectQuery("user:*", typeCols("string"), redisCaps)).toBe(
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
    expect(generateSelectQuery("session:*", typeCols("hash"), redisCaps)).toBe(
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
    expect(generateSelectQuery("counter", typeCols("string"), redisCaps)).toBe(
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
    expect(commandLines(generateSelectQuery("queue:*", typeCols("list"), redisCaps))).toEqual([
      "SCAN 0 MATCH queue:* COUNT 50",
      "TYPE queue:1",
      "LRANGE queue:1 0 -1",
      "RPUSH queue:1 example",
      "TTL queue:1",
      "DEL queue:1",
    ]);
  });

  test("set prefix group emits SMEMBERS/SADD", () => {
    expect(commandLines(generateSelectQuery("tags:*", typeCols("set"), redisCaps))).toEqual([
      "SCAN 0 MATCH tags:* COUNT 50",
      "TYPE tags:1",
      "SMEMBERS tags:1",
      "SADD tags:1 example",
      "TTL tags:1",
      "DEL tags:1",
    ]);
  });

  test("zset prefix group emits ZRANGE ... WITHSCORES / ZADD", () => {
    expect(commandLines(generateSelectQuery("score:*", typeCols("zset"), redisCaps))).toEqual([
      "SCAN 0 MATCH score:* COUNT 50",
      "TYPE score:1",
      "ZRANGE score:1 0 -1 WITHSCORES",
      "ZADD score:1 1 example",
      "TTL score:1",
      "DEL score:1",
    ]);
  });

  test("mixed-type prefix group omits the read and write blocks", () => {
    expect(commandLines(generateSelectQuery("misc:*", typeCols("string, hash"), redisCaps))).toEqual([
      "SCAN 0 MATCH misc:* COUNT 50",
      "TYPE misc:1",
      "TTL misc:1",
      "DEL misc:1",
    ]);
  });

  test("bare key emits no SCAN line", () => {
    const out = generateSelectQuery("counter", typeCols("string"), redisCaps);
    expect(out).not.toContain("SCAN");
  });

  test("bare key with an unknown type omits the read and write blocks", () => {
    expect(commandLines(generateSelectQuery("counter", typeCols(""), redisCaps))).toEqual([
      "TYPE counter",
      "TTL counter",
      "DEL counter",
    ]);
  });

  test("every command line is a single runnable command", () => {
    for (const sample of ["string", "hash", "list", "set", "zset"]) {
      for (const name of ["user:*", "counter"]) {
        for (const line of commandLines(generateSelectQuery(name, typeCols(sample), redisCaps))) {
          expect(line).not.toContain("\n");
          expect(line).not.toContain("<");
          expect(line.split(" ")[0]).toBe(line.split(" ")[0].toUpperCase());
        }
      }
    }
  });

  test("no command line but SCAN takes the group name as a key argument", () => {
    const lines = commandLines(generateSelectQuery("user:*", typeCols("string"), redisCaps));
    for (const line of lines) {
      if (line.includes(":*")) expect(line.startsWith("SCAN ")).toBe(true);
    }
    expect(lines.filter((l) => l.includes("*"))).toEqual(["SCAN 0 MATCH user:* COUNT 50"]);
  });

  test("Redis no longer emits MongoDB JSON (#427 regression)", () => {
    const out = generateSelectQuery("user:*", typeCols("string"), redisCaps);
    expect(out).not.toContain('"collection"');
  });

  test("only the lines that need it fall back to the JSON form (#427)", () => {
    // Mixed forms in one cheatsheet are fine: the provider decides per run, and
    // every line is run on its own. Here the key needs JSON; nothing else does.
    const lines = commandLines(generateSelectQuery('say"hi"', typeCols("string"), redisCaps));
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
    const out = generateSelectQuery("a\nDEL user:1 x", typeCols("string"), redisCaps);
    expect(out.split("\n")[0]).toBe('# Redis commands for "a\\nDEL user:1 x" — select a line and Run Selected.');
    for (const line of commandLines(out)) expect(line).not.toContain("Run Selected");
  });

  test("a node name containing CR LF and a quote stays inside the header comment (#427)", () => {
    const out = generateSelectQuery('a\r\nDEL "user:1" x', typeCols("hash"), redisCaps);
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
    expect(generateSelectQuery("user:*", typeCols("string"), redisCaps).split("\n")[0]).toBe(
      '# Redis commands for "user:*" — select a line and Run Selected.',
    );
  });

  test("the SCAN comment says one iteration is not the whole set (#427)", () => {
    const out = generateSelectQuery("user:*", typeCols("string"), redisCaps);
    expect(out).toContain("ONE scan iteration");
    expect(out).toContain("the reply's first row is the next cursor");
  });
});
