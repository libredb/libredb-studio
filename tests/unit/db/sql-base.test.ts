/**
 * Unit tests for SQLBaseProvider
 * Uses a concrete TestSQLProvider to expose protected methods
 */

import { describe, test, expect } from "bun:test";
import { SQLBaseProvider } from "@/lib/db/providers/sql/sql-base";
import type {
  DatabaseConnection,
  QueryResult,
  TableSchema,
  HealthInfo,
  MaintenanceType,
  MaintenanceResult,
  ProviderOptions,
  DatabaseOverview,
  PerformanceMetrics,
  SlowQueryStats,
  ActiveSessionDetails,
  TableStats,
  IndexStats,
  StorageStats,
} from "@/lib/db/types";

// ============================================================================
// Concrete test provider
// ============================================================================

class TestSQLProvider extends SQLBaseProvider {
  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
  }

  async connect(): Promise<void> {
    this.setConnected(true);
  }
  async disconnect(): Promise<void> {
    this.setConnected(false);
  }
  async query(): Promise<QueryResult> {
    return { rows: [], fields: [], rowCount: 0, executionTime: 0 };
  }
  async getSchema(): Promise<TableSchema[]> {
    return [];
  }
  async getHealth(): Promise<HealthInfo> {
    return { activeConnections: 0, databaseSize: "0", cacheHitRatio: "0%", slowQueries: [], activeSessions: [] };
  }
  async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    void type;
    void target;
    return { success: true, executionTime: 0, message: "ok" };
  }
  async getOverview(): Promise<DatabaseOverview> {
    return {
      version: "",
      uptime: "",
      activeConnections: 0,
      maxConnections: 0,
      databaseSize: "",
      databaseSizeBytes: 0,
      tableCount: 0,
      indexCount: 0,
    };
  }
  async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return { cacheHitRatio: 0 };
  }
  async getSlowQueries(): Promise<SlowQueryStats[]> {
    return [];
  }
  async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return [];
  }
  async getTableStats(): Promise<TableStats[]> {
    return [];
  }
  async getIndexStats(): Promise<IndexStats[]> {
    return [];
  }
  async getStorageStats(): Promise<StorageStats[]> {
    return [];
  }

  // Expose protected methods
  public callEscapeIdentifier(id: string): string {
    return this.escapeIdentifier(id);
  }
  public callEscapeString(val: string): string {
    return this.escapeString(val);
  }
  public callBuildLimitClause(limit: number, offset?: number): string {
    return this.buildLimitClause(limit, offset);
  }
  public callGetPlaceholder(index: number): string {
    return this.getPlaceholder(index);
  }
  public callShouldEnableSSL(): boolean {
    return this.shouldEnableSSL();
  }
  public callGetInformationSchemaName(): string {
    return this.getInformationSchemaName();
  }
  public callGetDefaultSchema(): string {
    return this.getDefaultSchema();
  }
  public callIsReadOnlyQuery(sql: string): boolean {
    return this.isReadOnlyQuery(sql);
  }
  public callIsSchemaModifyingQuery(sql: string): boolean {
    return this.isSchemaModifyingQuery(sql);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(type: DatabaseConnection["type"], overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "test-1",
    name: "Test DB",
    type,
    host: "localhost",
    port: 5432,
    database: "testdb",
    user: "testuser",
    password: "secret",
    createdAt: new Date(),
    ...overrides,
  } as DatabaseConnection;
}

// ============================================================================
// Tests
// ============================================================================

describe("SQLBaseProvider", () => {
  // --------------------------------------------------------------------------
  // escapeIdentifier
  // --------------------------------------------------------------------------

  describe("escapeIdentifier()", () => {
    test("postgres wraps in double quotes", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callEscapeIdentifier("users")).toBe('"users"');
    });

    test("mysql wraps in backticks", () => {
      const p = new TestSQLProvider(makeConfig("mysql"));
      expect(p.callEscapeIdentifier("users")).toBe("`users`");
    });

    test("sqlite wraps in double quotes", () => {
      const p = new TestSQLProvider(makeConfig("sqlite"));
      expect(p.callEscapeIdentifier("users")).toBe('"users"');
    });

    test("mssql wraps in square brackets", () => {
      const p = new TestSQLProvider(makeConfig("mssql"));
      expect(p.callEscapeIdentifier("users")).toBe("[users]");
    });

    test("mssql escapes ] in identifier", () => {
      const p = new TestSQLProvider(makeConfig("mssql"));
      expect(p.callEscapeIdentifier("my]table")).toBe("[my]]table]");
    });

    test("postgres escapes embedded double quotes", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callEscapeIdentifier('my"table')).toBe('"my""table"');
    });

    test("mysql escapes embedded backticks", () => {
      const p = new TestSQLProvider(makeConfig("mysql"));
      expect(p.callEscapeIdentifier("my`table")).toBe("`my``table`");
    });
  });

  // --------------------------------------------------------------------------
  // escapeString
  // --------------------------------------------------------------------------

  describe("escapeString()", () => {
    test("escapes single quotes", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callEscapeString("O'Brien")).toBe("O''Brien");
    });

    test("no change for strings without quotes", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callEscapeString("hello")).toBe("hello");
    });
  });

  // --------------------------------------------------------------------------
  // buildLimitClause
  // --------------------------------------------------------------------------

  describe("buildLimitClause()", () => {
    test("builds LIMIT without offset", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callBuildLimitClause(100)).toBe("LIMIT 100");
    });

    test("builds LIMIT OFFSET when offset > 0", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callBuildLimitClause(50, 10)).toBe("LIMIT 50 OFFSET 10");
    });

    test("LIMIT only when offset is 0", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callBuildLimitClause(50, 0)).toBe("LIMIT 50");
    });
  });

  // --------------------------------------------------------------------------
  // getPlaceholder
  // --------------------------------------------------------------------------

  describe("getPlaceholder()", () => {
    test("postgres returns $N", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callGetPlaceholder(1)).toBe("$1");
      expect(p.callGetPlaceholder(3)).toBe("$3");
    });

    test("mysql returns ?", () => {
      const p = new TestSQLProvider(makeConfig("mysql"));
      expect(p.callGetPlaceholder(1)).toBe("?");
    });

    test("sqlite returns ?", () => {
      const p = new TestSQLProvider(makeConfig("sqlite"));
      expect(p.callGetPlaceholder(1)).toBe("?");
    });

    test("oracle returns :N", () => {
      const p = new TestSQLProvider(makeConfig("oracle"));
      expect(p.callGetPlaceholder(1)).toBe(":1");
      expect(p.callGetPlaceholder(5)).toBe(":5");
    });

    test("mssql returns @pN", () => {
      const p = new TestSQLProvider(makeConfig("mssql"));
      expect(p.callGetPlaceholder(1)).toBe("@p1");
      expect(p.callGetPlaceholder(2)).toBe("@p2");
    });
  });

  // --------------------------------------------------------------------------
  // shouldEnableSSL
  // --------------------------------------------------------------------------

  describe("shouldEnableSSL()", () => {
    test("returns false for localhost", () => {
      const p = new TestSQLProvider(makeConfig("postgres", { host: "localhost" }));
      expect(p.callShouldEnableSSL()).toBe(false);
    });

    test("returns true for supabase host", () => {
      const p = new TestSQLProvider(makeConfig("postgres", { host: "db.supabase.co" }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test("returns true for neon host", () => {
      const p = new TestSQLProvider(makeConfig("postgres", { host: "ep-cool-neon.neon.tech" }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test("returns true for render host", () => {
      const p = new TestSQLProvider(makeConfig("postgres", { host: "mydb.render.com" }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test("returns true for aws host", () => {
      const p = new TestSQLProvider(makeConfig("postgres", { host: "mydb.aws.rds.amazonaws.com" }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test("returns true for azure host", () => {
      const p = new TestSQLProvider(makeConfig("postgres", { host: "mydb.azure.postgres.database.com" }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test("returns true when options.ssl is true", () => {
      const p = new TestSQLProvider(makeConfig("postgres", { host: "localhost" }), { ssl: true });
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test("returns false for plain hostname", () => {
      const p = new TestSQLProvider(makeConfig("postgres", { host: "mydb.internal.company.com" }));
      expect(p.callShouldEnableSSL()).toBe(false);
    });

    test("returns true for planetscale host", () => {
      const p = new TestSQLProvider(makeConfig("mysql", { host: "mydb.planetscale.host" }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test("returns true for gcp host", () => {
      const p = new TestSQLProvider(makeConfig("postgres", { host: "mydb.gcp.cloudsql.com" }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test("returns true for generic cloud host", () => {
      const p = new TestSQLProvider(makeConfig("postgres", { host: "mydb.cloud.provider.com" }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getInformationSchemaName
  // --------------------------------------------------------------------------

  describe("getInformationSchemaName()", () => {
    test("returns information_schema", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callGetInformationSchemaName()).toBe("information_schema");
    });
  });

  // --------------------------------------------------------------------------
  // getDefaultSchema
  // --------------------------------------------------------------------------

  describe("getDefaultSchema()", () => {
    test("postgres returns public", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callGetDefaultSchema()).toBe("public");
    });

    test("mysql returns database name", () => {
      const p = new TestSQLProvider(makeConfig("mysql", { database: "mydb" }));
      expect(p.callGetDefaultSchema()).toBe("mydb");
    });

    test("oracle returns uppercased user", () => {
      const p = new TestSQLProvider(makeConfig("oracle", { user: "scott" }));
      expect(p.callGetDefaultSchema()).toBe("SCOTT");
    });

    test("mssql returns dbo", () => {
      const p = new TestSQLProvider(makeConfig("mssql"));
      expect(p.callGetDefaultSchema()).toBe("dbo");
    });

    test("sqlite returns empty string", () => {
      const p = new TestSQLProvider(makeConfig("sqlite"));
      expect(p.callGetDefaultSchema()).toBe("");
    });
  });

  // --------------------------------------------------------------------------
  // isReadOnlyQuery
  // --------------------------------------------------------------------------

  describe("isReadOnlyQuery()", () => {
    test("SELECT is read-only", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsReadOnlyQuery("SELECT * FROM users")).toBe(true);
    });

    test("SHOW is read-only", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsReadOnlyQuery("SHOW DATABASES")).toBe(true);
    });

    test("DESCRIBE is read-only", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsReadOnlyQuery("DESCRIBE users")).toBe(true);
    });

    test("EXPLAIN is read-only", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsReadOnlyQuery("EXPLAIN SELECT 1")).toBe(true);
    });

    test("PRAGMA is read-only", () => {
      const p = new TestSQLProvider(makeConfig("sqlite"));
      expect(p.callIsReadOnlyQuery("PRAGMA table_info(users)")).toBe(true);
    });

    test("INSERT is NOT read-only", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsReadOnlyQuery("INSERT INTO users VALUES (1, 'test')")).toBe(false);
    });

    test("UPDATE is NOT read-only", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsReadOnlyQuery("UPDATE users SET name = 'x'")).toBe(false);
    });

    test("DELETE is NOT read-only", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsReadOnlyQuery("DELETE FROM users")).toBe(false);
    });

    test("case insensitive", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsReadOnlyQuery("select * from users")).toBe(true);
    });

    test("leading whitespace handled", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsReadOnlyQuery("  SELECT 1")).toBe(true);
    });

    // A comment is not whitespace. The SQLite provider routes on this predicate
    // (`sqlite.ts` picks `all()` vs `run()`), so a commented SELECT misread as a
    // write came back with zero rows and zero changes rather than its data (#275).
    describe("leading comments", () => {
      test.each<[string, string]>([
        ["a line comment", "-- annotated\nSELECT 1"],
        ["a block comment", "/* annotated */ SELECT 1"],
        ["a hash comment", "# annotated\nSELECT 1"],
        ["stacked comments", "-- a\n/* b */\nSHOW DATABASES"],
      ])("sees a read-only statement behind %s", (_label, sql) => {
        const p = new TestSQLProvider(makeConfig("postgres"));
        expect(p.callIsReadOnlyQuery(sql)).toBe(true);
      });

      test("a commented write is still not read-only", () => {
        const p = new TestSQLProvider(makeConfig("postgres"));
        expect(p.callIsReadOnlyQuery("-- annotated\nINSERT INTO users VALUES (1)")).toBe(false);
      });

      test("a keyword inside the comment body does not make a write read-only", () => {
        const p = new TestSQLProvider(makeConfig("postgres"));
        expect(p.callIsReadOnlyQuery("-- SELECT the rows first\nUPDATE users SET name = 'x'")).toBe(false);
      });
    });

    // Deliberate strictness change that came with reading the leading keyword as a
    // whole word: `trim().startsWith("select")` counted any statement whose first
    // word merely BEGINS with a keyword, so an identifier-led statement was
    // reported read-only. Nothing valid opens this way, but the honest answer for
    // an unrecognised statement is "not read-only", not a false safe.
    test("a word that merely begins with a keyword is not that keyword", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsReadOnlyQuery("selected_rows_view AS x")).toBe(false);
      expect(p.callIsReadOnlyQuery("explains_table")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // isSchemaModifyingQuery
  // --------------------------------------------------------------------------

  describe("isSchemaModifyingQuery()", () => {
    test("CREATE is schema-modifying", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsSchemaModifyingQuery("CREATE TABLE users (id int)")).toBe(true);
    });

    test("DROP is schema-modifying", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsSchemaModifyingQuery("DROP TABLE users")).toBe(true);
    });

    test("ALTER is schema-modifying", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsSchemaModifyingQuery("ALTER TABLE users ADD col text")).toBe(true);
    });

    test("TRUNCATE is schema-modifying", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsSchemaModifyingQuery("TRUNCATE TABLE users")).toBe(true);
    });

    test("SELECT is NOT schema-modifying", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsSchemaModifyingQuery("SELECT * FROM users")).toBe(false);
    });

    test("INSERT is NOT schema-modifying", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsSchemaModifyingQuery("INSERT INTO users VALUES (1)")).toBe(false);
    });

    test("case insensitive", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsSchemaModifyingQuery("create table t(id int)")).toBe(true);
    });

    describe("leading comments", () => {
      test.each<[string, string]>([
        ["CREATE", "-- annotated\nCREATE TABLE users (id int)"],
        ["DROP", "/* annotated */ DROP TABLE users"],
        ["ALTER", "# annotated\nALTER TABLE users ADD col text"],
        ["TRUNCATE", "-- a\n/* b */\nTRUNCATE TABLE users"],
      ])("sees a commented %s as schema-modifying", (_label, sql) => {
        const p = new TestSQLProvider(makeConfig("postgres"));
        expect(p.callIsSchemaModifyingQuery(sql)).toBe(true);
      });

      test("a commented SELECT is not schema-modifying", () => {
        const p = new TestSQLProvider(makeConfig("postgres"));
        expect(p.callIsSchemaModifyingQuery("-- CREATE this later\nSELECT * FROM users")).toBe(false);
      });
    });

    // Same strictness change as `isReadOnlyQuery` above: `startsWith("create")`
    // counted a statement led by an identifier that happens to begin with a keyword.
    test("a word that merely begins with a keyword is not that keyword", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      expect(p.callIsSchemaModifyingQuery("created_at_report")).toBe(false);
      expect(p.callIsSchemaModifyingQuery("dropped_rows AS x")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery (override from SQLBaseProvider)
  // --------------------------------------------------------------------------

  describe("prepareQuery()", () => {
    test("SELECT gets LIMIT applied", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      const result = p.prepareQuery("SELECT * FROM users");
      expect(result.wasLimited).toBe(true);
      expect(result.query).toContain("LIMIT");
    });

    test("non-SELECT passes through unchanged", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      const sql = "INSERT INTO users (name) VALUES ('test')";
      const result = p.prepareQuery(sql);
      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test("respects custom limit", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      const result = p.prepareQuery("SELECT * FROM users", { limit: 25 });
      expect(result.limit).toBe(25);
    });

    test("respects offset", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      const result = p.prepareQuery("SELECT * FROM users", { limit: 50, offset: 100 });
      expect(result.offset).toBe(100);
    });

    test("unlimited mode uses MAX_UNLIMITED_ROWS", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      const result = p.prepareQuery("SELECT * FROM users", { unlimited: true });
      expect(result.limit).toBeGreaterThan(500);
    });

    test("a commented SELECT gets its LIMIT applied", () => {
      const p = new TestSQLProvider(makeConfig("postgres"));
      const result = p.prepareQuery("-- annotated\nSELECT * FROM users", { limit: 50 });

      expect(result.query).toBe("-- annotated\nSELECT * FROM users LIMIT 50");
      expect(result.wasLimited).toBe(true);
    });

    // #287. This is the seam through which the misclassification reached the
    // engine: a data-modifying CTE was typed SELECT, so a bound was appended to a
    // statement that WRITES. In PostgreSQL the bound applies to the written rows,
    // so the statement committed at most `limit` of them and reported a truncated
    // result set - the one failure in this family that re-running cannot undo.
    describe("a CTE that operates a write reaches the engine untouched", () => {
      test.each<[string, string]>([
        ["INSERT", "WITH t AS (UPDATE logs SET seen = true RETURNING id) INSERT INTO audit SELECT id FROM t"],
        ["UPDATE", "WITH stale AS (SELECT id FROM sessions) UPDATE users SET flag = 1 FROM stale"],
        ["DELETE", "WITH doomed AS (SELECT id FROM s) DELETE FROM users USING doomed WHERE users.id = doomed.id"],
        [
          "MERGE",
          "WITH src AS (SELECT 1 AS id) MERGE INTO target USING src ON target.id = src.id WHEN MATCHED THEN DELETE",
        ],
      ])("passes a CTE operating an %s through byte-identical", (_label, sql) => {
        const p = new TestSQLProvider(makeConfig("postgres"));

        const result = p.prepareQuery(sql, { limit: 500 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
      });

      test("still bounds a read-only CTE", () => {
        const p = new TestSQLProvider(makeConfig("postgres"));
        const sql = "WITH t AS (SELECT 1) SELECT * FROM t";

        const result = p.prepareQuery(sql, { limit: 500 });

        expect(result.query).toBe(`${sql} LIMIT 500`);
        expect(result.wasLimited).toBe(true);
      });
    });

    // #280. The bound used to be appended after everything, so a trailing line
    // comment swallowed it: the engine ran the statement unbounded while the
    // caller was handed `wasLimited: true` and the UI reported a capped result.
    describe("a statement ending in a comment", () => {
      test("gets its bound before the comment, not inside it", () => {
        const p = new TestSQLProvider(makeConfig("postgres"));

        const result = p.prepareQuery("SELECT * FROM users -- daily check", { limit: 50 });

        expect(result.query).toBe("SELECT * FROM users LIMIT 50 -- daily check");
        expect(result.wasLimited).toBe(true);
      });

      test("keeps its terminating semicolon outside the comment", () => {
        const p = new TestSQLProvider(makeConfig("postgres"));

        const result = p.prepareQuery("SELECT * FROM users; -- daily check", { limit: 50 });

        expect(result.query).toBe("SELECT * FROM users LIMIT 50; -- daily check");
      });

      test("is bounded even when the comment contains a bound", () => {
        const p = new TestSQLProvider(makeConfig("postgres"));

        const result = p.prepareQuery("SELECT * FROM users -- LIMIT 10", { limit: 50 });

        expect(result.query).toBe("SELECT * FROM users LIMIT 50 -- LIMIT 10");
        expect(result.wasLimited).toBe(true);
      });

      test("keeps a real bound written before the comment", () => {
        const p = new TestSQLProvider(makeConfig("postgres"));
        const sql = "SELECT * FROM users LIMIT 10 -- deliberate";

        const result = p.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
      });
    });
  });
});
