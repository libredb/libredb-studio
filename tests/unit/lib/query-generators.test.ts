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

  test('LibreDB dialect: a ":*" prefix group scans with prefix', () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    expect(generateTableQuery("users:*", caps)).toBe("prefix users:");
  });

  test("LibreDB dialect: a bare (no-colon) group reads with get", () => {
    const caps = makeCaps({ queryLanguage: "json", defaultPort: null, queryDialect: "libredb" });
    expect(generateTableQuery("orphan", caps)).toBe("get orphan");
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
