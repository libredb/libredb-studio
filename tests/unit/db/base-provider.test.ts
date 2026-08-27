import { describe, test, expect, spyOn } from "bun:test";
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { maintenanceControl } from "@/lib/db/types";
import { AuthenticationError, ConnectionError, DatabaseConfigError, DatabaseError } from "@/lib/db/errors";
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
  ProviderCapabilities,
  ProviderLabels,
} from "@/lib/db/types";

// ============================================================================
// Concrete TestProvider extending the abstract BaseDatabaseProvider
// ============================================================================

class TestProvider extends BaseDatabaseProvider {
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
    return [
      { name: "users", columns: [], indexes: [], foreignKeys: [] },
      { name: "orders", columns: [], indexes: [], foreignKeys: [] },
    ];
  }

  async getHealth(): Promise<HealthInfo> {
    return {
      activeConnections: 0,
      databaseSize: "0",
      cacheHitRatio: "0%",
      slowQueries: [],
      activeSessions: [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async runMaintenance(_type: MaintenanceType, _target?: string): Promise<MaintenanceResult> {
    return { success: true, executionTime: 0, message: "ok" };
  }

  async getOverview(): Promise<DatabaseOverview> {
    return {
      version: "test",
      uptime: "0",
      activeConnections: 0,
      maxConnections: 0,
      databaseSize: "0",
      databaseSizeBytes: 0,
      tableCount: 0,
      indexCount: 0,
    };
  }

  async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return { cacheHitRatio: 99 };
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

  // ── Expose protected methods for testing ──────────────────────────────
  public callEnsureConnected(): void {
    this.ensureConnected();
  }

  public callTrackQuery<T>(fn: () => Promise<T>): Promise<T> {
    return this.trackQuery(fn);
  }

  public callMeasureExecution<T>(fn: () => Promise<T>): Promise<{ result: T; executionTime: number }> {
    return this.measureExecution(fn);
  }

  public callSetConnected(connected: boolean): void {
    this.setConnected(connected);
  }

  public callSetError(error: Error): void {
    this.setError(error);
  }

  public callGetSafeConfig(): Record<string, unknown> {
    return this.getSafeConfig();
  }

  public callGetConnectionInfo(): string {
    return this.getConnectionInfo();
  }

  public callMapError(error: unknown, query?: string): Error {
    return this.mapError(error, query);
  }

  public callLogError(operation: string, error: unknown): void {
    this.logError(operation, error);
  }

  public callFormatDuration(ms: number): string {
    return this.formatDuration(ms);
  }

  public getState() {
    return this.state;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "test-1",
    name: "Test DB",
    type: "postgres",
    host: "localhost",
    port: 5432,
    database: "testdb",
    user: "testuser",
    password: "secret123",
    createdAt: new Date(),
    ...overrides,
  } as DatabaseConnection;
}

// ============================================================================
// Tests
// ============================================================================

describe("BaseDatabaseProvider", () => {
  // ─── isConnected ───────────────────────────────────────────────────────

  describe("isConnected", () => {
    test("returns false initially", () => {
      const provider = new TestProvider(makeConfig());
      expect(provider.isConnected()).toBe(false);
    });

    test("returns true after connect", async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("returns false after disconnect", async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });
  });

  // ─── validate ──────────────────────────────────────────────────────────

  describe("validate", () => {
    test("throws DatabaseConfigError when id is missing", () => {
      const provider = new TestProvider(makeConfig({ id: "" }));
      expect(() => provider.validate()).toThrow(DatabaseConfigError);
      expect(() => provider.validate()).toThrow("Connection ID is required");
    });

    test("throws DatabaseConfigError when type is missing", () => {
      const provider = new TestProvider(makeConfig({ type: "" as DatabaseConnection["type"] }));
      expect(() => provider.validate()).toThrow(DatabaseConfigError);
      expect(() => provider.validate()).toThrow("Database type is required");
    });

    test("does not throw for valid config", () => {
      const provider = new TestProvider(makeConfig());
      expect(() => provider.validate()).not.toThrow();
    });
  });

  // ─── getCapabilities ──────────────────────────────────────────────────

  describe("getCapabilities", () => {
    test("returns default capabilities", () => {
      const provider = new TestProvider(makeConfig());
      const caps = provider.getCapabilities();

      expect(caps.queryLanguage).toBe("sql");
      expect(caps.supportsExplain).toBe(true);
      expect(caps.supportsExternalQueryLimiting).toBe(true);
      expect(caps.supportsCreateTable).toBe(true);
      expect(caps.supportsInlineRowEdit).toBe(true);
      // The opposite default to the line above, and deliberately: this class
      // implements no transaction methods, so a subclass that does not add them has
      // none and POST /api/db/transaction refuses the call. Only the four providers
      // that hold a session for one declare `true` (#U13).
      expect(caps.supportsTransactions).toBe(false);
      // Compile-time pin, checked by `bun run typecheck`: `ProviderCapabilities` is
      // published (`src/exports/types.ts`), so a capability added later must be
      // OPTIONAL or every external implementer of the type stops compiling. Omitting
      // it here is the whole assertion; the UI gates on `=== true`, so an absent
      // flag reads as unsupported. Reported by review on PR #289.
      const externalImplementer: ProviderCapabilities = {
        queryLanguage: "sql",
        supportsExplain: false,
        supportsExternalQueryLimiting: false,
        supportsCreateTable: false,
        supportsMaintenance: false,
        maintenanceOperations: [],
        supportsConnectionString: false,
        defaultPort: null,
        schemaRefreshPattern: "",
      };
      expect(externalImplementer.supportsInlineRowEdit).toBeUndefined();
      expect(externalImplementer.supportsTransactions).toBeUndefined();
      expect(externalImplementer.declaresForeignKeys).toBeUndefined();
      // The SQL default: a relational engine HAS foreign keys whether or not a given
      // schema uses any. The six engines that have none override it, so the strong
      // claim - "no reading could ever return one here" - is always declared and
      // never inherited (#414).
      expect(caps.declaresForeignKeys).toBe(true);
      // The other direction. Nothing here declares that its inventory rows are
      // groupings this server derived, because on every engine but Redis and LibreDB
      // they are objects the engine holds - so the flag is absent by default and the
      // two that answer true say so themselves (#414).
      expect(externalImplementer.tablesAreDerivedGroupings).toBeUndefined();
      expect(caps.tablesAreDerivedGroupings).toBeUndefined();
      // And the vocabulary the agent layer reads out of the labels: "Table" here, so
      // every SQL engine's prompt says table without any provider having to declare it.
      expect(provider.getLabels().entityName).toBe("Table");
      expect(provider.getLabels().entityNamePlural).toBe("Tables");
      expect(caps.supportsMaintenance).toBe(true);
      expect(caps.maintenanceOperations).toBeArray();
      expect(caps.maintenanceOperations).toContain("vacuum");
      expect(caps.maintenanceOperations).toContain("analyze");
      expect(caps.supportsConnectionString).toBe(false);
      expect(caps.defaultPort).toBeNull();
      expect(caps.schemaRefreshPattern).toBeDefined();
    });
  });

  // ─── getLabels ────────────────────────────────────────────────────────

  describe("getLabels", () => {
    test("returns default labels", () => {
      const provider = new TestProvider(makeConfig());
      const labels = provider.getLabels();

      expect(labels.entityName).toBe("Table");
      expect(labels.entityNamePlural).toBe("Tables");
      expect(labels.rowName).toBe("row");
      expect(labels.rowNamePlural).toBe("rows");
      expect(labels.selectAction).toBe("Select Top 50");
      expect(labels.searchPlaceholder).toBe("Search tables or columns...");
    });

    test("declares no global reindex wording, so the Operations card keeps its fallback", () => {
      // The `reindexGlobal*` triad is OPTIONAL on the published `ProviderLabels`
      // (`src/exports/types.ts`), unlike the analyze and vacuum triads beside it: a
      // required field added after the fact stops every external implementer of the
      // type compiling. Only the three providers that declare the `reindex`
      // maintenance operation set it, and `OperationsTab` falls back to the wording
      // the card had (#U6). The literal below is the compile-time half of that,
      // checked by `bun run typecheck`.
      const externalImplementer: ProviderLabels = {
        entityName: "Node",
        entityNamePlural: "Nodes",
        rowName: "record",
        rowNamePlural: "records",
        selectAction: "Read",
        generateAction: "Generate",
        analyzeAction: "Analyze",
        vacuumAction: "Vacuum",
        searchPlaceholder: "Search...",
        analyzeGlobalLabel: "Analyze",
        analyzeGlobalTitle: "Analyze",
        analyzeGlobalDesc: "Analyze.",
        vacuumGlobalLabel: "Vacuum",
        vacuumGlobalTitle: "Vacuum",
        vacuumGlobalDesc: "Vacuum.",
      };

      expect(externalImplementer.reindexGlobalLabel).toBeUndefined();
      expect(externalImplementer.reindexGlobalTitle).toBeUndefined();
      expect(externalImplementer.reindexGlobalDesc).toBeUndefined();
      expect(new TestProvider(makeConfig()).getLabels().reindexGlobalLabel).toBeUndefined();
    });
  });

  // ─── prepareQuery ────────────────────────────────────────────────────

  describe("prepareQuery", () => {
    test("returns query unchanged with wasLimited=false", () => {
      const provider = new TestProvider(makeConfig());
      const result = provider.prepareQuery("SELECT * FROM users");

      expect(result.query).toBe("SELECT * FROM users");
      expect(result.wasLimited).toBe(false);
      expect(result.limit).toBe(500);
      expect(result.offset).toBe(0);
    });

    test("respects custom limit and offset options", () => {
      const provider = new TestProvider(makeConfig());
      const result = provider.prepareQuery("SELECT 1", { limit: 100, offset: 50 });

      expect(result.limit).toBe(100);
      expect(result.offset).toBe(50);
    });
  });

  // ─── getTables ────────────────────────────────────────────────────────

  describe("getTables", () => {
    test("calls getSchema and returns table names", async () => {
      const provider = new TestProvider(makeConfig());
      const tables = await provider.getTables();

      expect(tables).toEqual(["users", "orders"]);
    });
  });

  // ─── ensureConnected ──────────────────────────────────────────────────

  describe("ensureConnected", () => {
    test("throws when not connected", () => {
      const provider = new TestProvider(makeConfig());
      expect(() => provider.callEnsureConnected()).toThrow("Provider is not connected. Call connect() first.");
    });

    test("does not throw when connected", async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      expect(() => provider.callEnsureConnected()).not.toThrow();
    });
  });

  // ─── trackQuery ───────────────────────────────────────────────────────

  describe("trackQuery", () => {
    test("increments and decrements activeQueries", async () => {
      const provider = new TestProvider(makeConfig());

      expect(provider.getState().activeQueries).toBe(0);

      let insideCount: number | undefined;
      await provider.callTrackQuery(async () => {
        insideCount = provider.getState().activeQueries;
        return "done";
      });

      expect(insideCount).toBe(1);
      expect(provider.getState().activeQueries).toBe(0);
    });

    test("decrements activeQueries even if fn throws", async () => {
      const provider = new TestProvider(makeConfig());

      try {
        await provider.callTrackQuery(async () => {
          throw new Error("boom");
        });
      } catch {
        // expected
      }

      expect(provider.getState().activeQueries).toBe(0);
    });
  });

  // ─── measureExecution ─────────────────────────────────────────────────

  describe("measureExecution", () => {
    test("returns result and executionTime >= 0", async () => {
      const provider = new TestProvider(makeConfig());

      const { result, executionTime } = await provider.callMeasureExecution(async () => {
        return 42;
      });

      expect(result).toBe(42);
      expect(executionTime).toBeGreaterThanOrEqual(0);
      expect(typeof executionTime).toBe("number");
    });
  });

  // ─── setConnected / setError ──────────────────────────────────────────

  describe("setConnected / setError", () => {
    test("setConnected(true) sets connected and lastConnected", () => {
      const provider = new TestProvider(makeConfig());
      provider.callSetConnected(true);

      expect(provider.getState().connected).toBe(true);
      expect(provider.getState().lastConnected).toBeInstanceOf(Date);
      expect(provider.getState().lastError).toBeUndefined();
    });

    test("setError records error and sets connected=false", () => {
      const provider = new TestProvider(makeConfig());
      provider.callSetConnected(true);

      const err = new Error("connection lost");
      provider.callSetError(err);

      expect(provider.getState().connected).toBe(false);
      expect(provider.getState().lastError).toBe(err);
    });
  });

  // ─── getSafeConfig ────────────────────────────────────────────────────

  describe("getSafeConfig", () => {
    test("excludes password and connectionString", () => {
      const provider = new TestProvider(
        makeConfig({ password: "supersecret", connectionString: "postgres://user:pass@host/db" }),
      );
      const safe = provider.callGetSafeConfig();

      expect(safe).toHaveProperty("id");
      expect(safe).toHaveProperty("name");
      expect(safe).toHaveProperty("type");
      expect(safe).toHaveProperty("host");
      expect(safe).toHaveProperty("port");
      expect(safe).toHaveProperty("database");
      expect(safe).toHaveProperty("user");
      expect(safe).not.toHaveProperty("password");
      expect(safe).not.toHaveProperty("connectionString");
    });
  });

  // ─── getConnectionInfo ────────────────────────────────────────────────

  describe("getConnectionInfo", () => {
    const infoFor = (connectionString: string) =>
      new TestProvider(makeConfig({ connectionString })).callGetConnectionInfo();

    test("returns host:port/database when no connectionString", () => {
      const provider = new TestProvider(makeConfig());
      const info = provider.callGetConnectionInfo();
      expect(info).toBe("localhost:5432/testdb");
    });

    test("masks password in connection string", () => {
      const provider = new TestProvider(
        makeConfig({ connectionString: "postgres://admin:s3cret@db.example.com:5432/mydb" }),
      );
      const info = provider.callGetConnectionInfo();

      expect(info).not.toContain("s3cret");
      expect(info).toContain(":***@");
      expect(info).toContain("db.example.com");
    });

    // A connection string does not always carry its credential in the authority. libSQL
    // passes the whole token as a query parameter, and libpq accepts `password`/`sslkey`
    // there too, so each shape below is one the authority-only mask used to let through.

    test("masks an authToken carried in the query string", () => {
      const info = infoFor("libsql://db-org.turso.io?authToken=eyJhbGciOiJFZERTQSJ9.payload.signature");

      expect(info).not.toContain("eyJhbGciOiJFZERTQSJ9");
      expect(info).toBe("libsql://db-org.turso.io?authToken=***");
    });

    test("matches credential parameter names case-insensitively", () => {
      expect(infoFor("libsql://host?AUTHTOKEN=abc")).toBe("libsql://host?AUTHTOKEN=***");
      expect(infoFor("postgres://host/db?PassWord=abc")).toBe("postgres://host/db?PassWord=***");
    });

    test("masks every credential parameter when several appear in one string", () => {
      const info = infoFor("postgres://host/db?sslmode=verify-full&password=pw&sslkey=/client.pem&token=tk");

      expect(info).toBe("postgres://host/db?sslmode=verify-full&password=***&sslkey=***&token=***");
    });

    test("masks a bracketed IPv6 authority without disturbing the brackets", () => {
      // The authority parse finds the credential at the LAST `@` and the password at the
      // authority's FIRST `:`. An IPv6 host puts colons inside `[...]`, which is the shape
      // that would break a naive first-`:`-to-first-`@` mask. It does not break this one,
      // and these pin why: with a credential the mask lands before the brackets, and with
      // no credential the colons inside them are left alone rather than read as a password
      // boundary - there is no `@`, so nothing is masked.
      expect(infoFor("postgres://user:pw@[::1]:5432/db")).toBe("postgres://user:***@[::1]:5432/db");
      expect(infoFor("postgres://user:pw@[2001:db8::1]:5432/db")).toBe("postgres://user:***@[2001:db8::1]:5432/db");
      expect(infoFor("postgres://[::1]:5432/db")).toBe("postgres://[::1]:5432/db");
      expect(infoFor("redis://[2001:db8::1]:6379")).toBe("redis://[2001:db8::1]:6379");
      // An `@` in the password, with an IPv6 host behind it: masked whole, as elsewhere.
      expect(infoFor("postgres://user:p@ss@[::1]:5432/db")).toBe("postgres://user:***@[::1]:5432/db");
      // User name and no password, and an empty password: both verbatim, as they are for a
      // named host - '***' over a value the string never carried would assert a secret.
      expect(infoFor("postgres://user@[::1]:5432/db")).toBe("postgres://user@[::1]:5432/db");
      expect(infoFor("postgres://user:@[::1]:5432/db")).toBe("postgres://user:@[::1]:5432/db");
    });

    test("the known limit: a bracketed host in the userinfo position is mangled", () => {
      // Recorded rather than fixed. `postgres://[::1]:5432@host/db` is not a URI any driver
      // or connection form produces - an IPv6 host cannot be followed by `@host` - and the
      // parse reads the bracket's first `:` as the password boundary. Bracket-awareness
      // would be a branch with no real caller, so the boundary is written down instead of
      // being left for someone to rediscover as a defect.
      expect(infoFor("postgres://[::1]:5432@host/db")).toBe("postgres://[:***@host/db");
    });

    test("masks a credential in the authority and in the query string together", () => {
      const info = infoFor("libsql://admin:s3cret@db-org.turso.io?authToken=jwt");

      expect(info).toBe("libsql://admin:***@db-org.turso.io?authToken=***");
    });

    test("masks a credential value whole, url-encoded or containing '='", () => {
      expect(infoFor("libsql://host?authToken=a%2Fb%3Dc")).toBe("libsql://host?authToken=***");
      // Base64 padding puts a literal '=' inside the value; it must not end the value.
      expect(infoFor("libsql://host?authToken=YWJj==&mode=ro")).toBe("libsql://host?authToken=***&mode=ro");
    });

    test("leaves an empty credential value empty rather than inventing a redaction", () => {
      // '***' over a value that was never there would assert a secret the string does
      // not carry, which is the absence rule wearing a redaction's clothes.
      expect(infoFor("libsql://host?authToken=&mode=ro")).toBe("libsql://host?authToken=&mode=ro");
    });

    test("over-redacts a parameter whose name merely contains a credential word", () => {
      // Deliberate. A driver spelling we have not seen is far more costly to miss than a
      // non-secret is to hide, and the second case here is exactly why: `sslpassword` is
      // a real libpq keyword that an exact-name list would have leaked.
      expect(infoFor("libsql://host?tokenLifetime=3600")).toBe("libsql://host?tokenLifetime=***");
      expect(infoFor("postgres://host/db?sslpassword=pw")).toBe("postgres://host/db?sslpassword=***");
    });

    test("leaves a non-credential parameter whose value contains a credential word intact", () => {
      // The name is matched between a delimiter and '=', so a credential word sitting in
      // somebody else's value neither triggers a mask nor mangles the string.
      expect(infoFor("postgres://host/db?applicationName=my-password-app")).toBe(
        "postgres://host/db?applicationName=my-password-app",
      );
      expect(infoFor("postgres://host/db?options=-c%20statement_timeout=5s")).toBe(
        "postgres://host/db?options=-c%20statement_timeout=5s",
      );
    });

    test("masks a semicolon-delimited credential in a string that is not a valid URL", () => {
      // An ADO-style SQL Server string has no query string and no scheme, so a redaction
      // built on URL parsing would throw on it instead of masking it.
      expect(infoFor("Server=localhost,1433;Database=db;User Id=sa;Password=P4ssw0rd")).toBe(
        "Server=localhost,1433;Database=db;User Id=sa;Password=***",
      );
    });

    test("does not mistake an '@' outside the authority for userinfo", () => {
      // ':' + text + '@' also occurs in a path and in a parameter value; masking there
      // would destroy the host the reader needs and redact nothing secret.
      expect(infoFor("postgres://host:5432/tenant@acme")).toBe("postgres://host:5432/tenant@acme");
      expect(infoFor("mongodb://host/db?replicaSet=rs:0@node")).toBe("mongodb://host/db?replicaSet=rs:0@node");
    });

    // An ADO-style string orders its parameters arbitrarily, so the credential is as
    // likely to lead as to trail. Matching a name only AFTER a delimiter returned the
    // leading one verbatim, which is the shape a review of this round measured leaking.
    test.each([
      ["Password=P4ssw0rd;Server=host", "Password=***;Server=host"],
      // Deliberately not JWT-shaped. The realistic libSQL token is pinned above, in the
      // query-string position where it belongs; here the POSITION is the subject, so a
      // high-entropy literal would buy nothing and trips the secret scanner's
      // generic-api-key rule (measured: entropy 3.98 in this exact `name=value;` shape).
      ["authToken=leading-token-value;Server=host", "authToken=***;Server=host"],
      ["SslKey=/etc/client.pem;Server=host", "SslKey=***;Server=host"],
      ["ClientSecret=s3cr3t;Server=host", "ClientSecret=***;Server=host"],
    ])("masks %s, whose credential leads the string", (given, expected) => {
      expect(infoFor(given)).toBe(expected);
    });

    test("masks a password containing an unencoded '@'", () => {
      // The authority is parsed, and the credential ends at the LAST '@' inside it: '@' is
      // a legal password character while a host name cannot hold one. A single-'@' pattern
      // left everything after the first one in the clear.
      expect(infoFor("postgres://user:p@ss@db.example.com/mydb")).toBe("postgres://user:***@db.example.com/mydb");
      expect(infoFor("mongodb://admin:a@b@c@cluster0.example.com:27017/db")).toBe(
        "mongodb://admin:***@cluster0.example.com:27017/db",
      );
    });

    test("masks an authority that no delimiter follows", () => {
      // Nothing bounds the authority on the right here, so its end is the end of the
      // string; a parse that required a '/' would return this password verbatim.
      expect(infoFor("postgres://user:s3cret@db.example.com")).toBe("postgres://user:***@db.example.com");
    });

    test.each([
      // RFC 3986 wants each of these percent-encoded in userinfo, and each one ENDS the
      // authority - so the '@' falls outside it and the parse sees no credential. Pinned
      // so the gap is visible rather than assumed closed. '/' is why: the path-holding
      // '@' pinned above (`postgres://host:5432/tenant@acme`) has the identical shape, and
      // hiding a port behind a `***` that asserts a credential the string never carried is
      // the worse error of the two.
      ["postgres://user:p/w@db.example.com/mydb"],
      ["postgres://user:p?w@db.example.com/mydb"],
      ["postgres://user:p#w@db.example.com/mydb"],
    ])("leaves %s unmasked, which is the documented limit", (given) => {
      expect(infoFor(given)).toBe(given);
    });

    test("masks the authority of a string whose scheme carries its own prefix", () => {
      // A JDBC-style URL puts a second scheme in front. Anchoring the userinfo to the
      // START of the string rather than to '://' would leave this password in the clear.
      expect(infoFor("jdbc:postgresql://user:s3cret@host/db")).toBe("jdbc:postgresql://user:***@host/db");
    });

    test("leaves an authority that carries no credential exactly as it was", () => {
      // A user name with no password, and a ':'+text+'@' that lives in the path. Neither
      // holds a secret, so replacing either would cost the reader the host or the user
      // and hide nothing - and a mask that eats the '//' is how a scheme goes missing.
      expect(infoFor("postgres://user@db.example.com/mydb")).toBe("postgres://user@db.example.com/mydb");
      expect(infoFor("postgres://host/db:owner@example.com")).toBe("postgres://host/db:owner@example.com");
      // The ':' here belongs to the PORT, which sits after the '@'. Masking from the
      // authority's first ':' without checking that it precedes the '@' would replace the
      // user name and the host with one '***'.
      expect(infoFor("postgres://user@db.example.com:5432/mydb")).toBe("postgres://user@db.example.com:5432/mydb");
      // An empty password stays empty, as it does in the parameter half.
      expect(infoFor("postgres://user:@db.example.com/mydb")).toBe("postgres://user:@db.example.com/mydb");
    });

    test("masks a credential a fragment delimits", () => {
      // '#' bounds a parameter the same way '&' does, so a credential written after one
      // must not swallow the rest of the string into its value.
      expect(infoFor("libsql://host?mode=ro#authToken=jwt")).toBe("libsql://host?mode=ro#authToken=***");
    });
  });

  // ─── getMonitoringData ─────────────────────────────────────────────────

  describe("getMonitoringData", () => {
    test("returns all core data by default", async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      const data = await provider.getMonitoringData();

      expect(data.timestamp).toBeInstanceOf(Date);
      expect(data.overview).toBeDefined();
      expect(data.performance).toBeDefined();
      expect(data.slowQueries).toBeArray();
      expect(data.activeSessions).toBeArray();
      expect(data.tables).toBeArray();
      expect(data.indexes).toBeArray();
      expect(data.storage).toBeArray();
    });

    test("excludes tables when includeTables=false", async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      const data = await provider.getMonitoringData({ includeTables: false });

      expect(data.overview).toBeDefined();
      expect(data.tables).toBeUndefined();
      expect(data.indexes).toBeArray();
      expect(data.storage).toBeArray();
    });

    test("excludes indexes when includeIndexes=false", async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      const data = await provider.getMonitoringData({ includeIndexes: false });

      expect(data.overview).toBeDefined();
      expect(data.tables).toBeArray();
      expect(data.indexes).toBeUndefined();
      expect(data.storage).toBeArray();
    });

    test("excludes storage when includeStorage=false", async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      const data = await provider.getMonitoringData({ includeStorage: false });

      expect(data.overview).toBeDefined();
      expect(data.tables).toBeArray();
      expect(data.indexes).toBeArray();
      expect(data.storage).toBeUndefined();
    });

    test("excludes all optional data", async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      const data = await provider.getMonitoringData({
        includeTables: false,
        includeIndexes: false,
        includeStorage: false,
      });

      expect(data.overview).toBeDefined();
      expect(data.performance).toBeDefined();
      expect(data.slowQueries).toBeArray();
      expect(data.activeSessions).toBeArray();
      expect(data.tables).toBeUndefined();
      expect(data.indexes).toBeUndefined();
      expect(data.storage).toBeUndefined();
    });

    test("respects slowQueryLimit option", async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      const data = await provider.getMonitoringData({ slowQueryLimit: 5 });

      // We can't assert the limit was passed through to getSlowQueries
      // (our mock returns []) but this validates the option is accepted
      expect(data.slowQueries).toBeArray();
    });

    test("respects sessionLimit option", async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      const data = await provider.getMonitoringData({ sessionLimit: 25 });
      expect(data.activeSessions).toBeArray();
    });
  });

  // ─── mapError ──────────────────────────────────────────────────────────

  describe("mapError", () => {
    test("maps connection failures to ConnectionError", () => {
      const provider = new TestProvider(makeConfig());
      const mapped = provider.callMapError(new Error("ECONNREFUSED 127.0.0.1:5432"), "SELECT 1");

      expect(mapped).toBeInstanceOf(ConnectionError);
      expect(mapped.message).toContain("Failed to connect to postgres");
    });

    test("wraps non-Error values in a DatabaseError", () => {
      const provider = new TestProvider(makeConfig());
      const mapped = provider.callMapError("plain string failure");

      expect(mapped).toBeInstanceOf(DatabaseError);
      expect(mapped.message).toBe("plain string failure");
    });
  });

  // ─── logError ──────────────────────────────────────────────────────────

  describe("logError", () => {
    test("logs sanitized operation and Error message to console.error", () => {
      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const provider = new TestProvider(makeConfig());
        provider.callLogError("connect\nphase", new Error("boom\r\nwith newlines"));

        expect(consoleSpy).toHaveBeenCalledTimes(1);
        const logged = consoleSpy.mock.calls[0][0] as string;
        expect(logged).toBe("[DB:postgres] connect phase failed: boom  with newlines");
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test("stringifies non-Error values", () => {
      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const provider = new TestProvider(makeConfig());
        provider.callLogError("query", "raw failure");

        expect(consoleSpy).toHaveBeenCalledTimes(1);
        const logged = consoleSpy.mock.calls[0][0] as string;
        expect(logged).toBe("[DB:postgres] query failed: raw failure");
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  // ─── formatDuration ────────────────────────────────────────────────────

  describe("formatDuration", () => {
    test("delegates to the shared pool-manager formatter", () => {
      const provider = new TestProvider(makeConfig());

      expect(provider.callFormatDuration(500)).toBe("500ms");
      expect(provider.callFormatDuration(1500)).toBe("1.50s");
      expect(provider.callFormatDuration(90000)).toBe("1.50m");
    });
  });
});

// ─── getMonitoringData: one failing read costs its own panel (2026-08-24) ───
//
// Measured 2026-08-24 against StarRocks 3.3 (127.0.0.1:19030) through the MySQL
// provider: six panels answered and `getActiveSessions` rejected with
// "Getting analyzing error. Detail message: Unknown table
// 'information_schema.PROCESSLIST'." - which under Promise.all discarded all six.

describe("getMonitoringData partial failures", () => {
  const STARROCKS = "Getting analyzing error. Detail message: Unknown table 'information_schema.PROCESSLIST'.";

  test("a rejected core read costs its own panel and records the engine's own sentence", async () => {
    const provider = new TestProvider(makeConfig());
    await provider.connect();
    provider.getActiveSessions = async () => {
      throw new Error(STARROCKS);
    };

    const data = await provider.getMonitoringData();

    expect(data.overview).toBeDefined();
    expect(data.performance).toBeDefined();
    expect(data.slowQueries).toBeArray();
    expect(data.tables).toBeArray();
    expect(data.indexes).toBeArray();
    expect(data.storage).toBeArray();
    expect(data.activeSessions).toBeUndefined();
    expect(data.errors).toEqual({ activeSessions: STARROCKS });
  });

  test("a rejected optional read costs its own panel only", async () => {
    const provider = new TestProvider(makeConfig());
    await provider.connect();
    provider.getStorageStats = async () => {
      throw new Error("permission denied for function pg_tablespace_size");
    };

    const data = await provider.getMonitoringData();

    expect(data.storage).toBeUndefined();
    expect(data.tables).toBeArray();
    expect(data.errors?.storage).toBe("permission denied for function pg_tablespace_size");
  });

  test("a rejected tables read is recorded, and indexes is recorded independently", async () => {
    const provider = new TestProvider(makeConfig());
    await provider.connect();
    provider.getTableStats = async () => {
      throw new Error("tables denied");
    };
    provider.getIndexStats = async () => {
      throw new Error("indexes denied");
    };

    const data = await provider.getMonitoringData();

    expect(data.tables).toBeUndefined();
    expect(data.indexes).toBeUndefined();
    expect(data.storage).toBeArray();
    expect(data.errors).toEqual({ tables: "tables denied", indexes: "indexes denied" });
  });

  test("a panel that was not requested is absent with no error entry", async () => {
    const provider = new TestProvider(makeConfig());
    await provider.connect();

    const data = await provider.getMonitoringData({
      includeTables: false,
      includeIndexes: false,
      includeStorage: false,
    });

    expect(data.tables).toBeUndefined();
    expect(data.indexes).toBeUndefined();
    expect(data.storage).toBeUndefined();
    expect(data.errors).toBeUndefined();
  });

  test("a fully successful read carries no errors key at all", async () => {
    const provider = new TestProvider(makeConfig());
    await provider.connect();

    const data = await provider.getMonitoringData();

    expect(data.errors).toBeUndefined();
  });

  test("throws when ALL FOUR core reads reject, carrying every distinct sentence", async () => {
    const provider = new TestProvider(makeConfig());
    await provider.connect();
    provider.getOverview = async () => {
      throw new Error("connection lost");
    };
    provider.getPerformanceMetrics = async () => {
      throw new Error("connection lost");
    };
    provider.getSlowQueries = async () => {
      throw new Error("no slow log");
    };
    provider.getActiveSessions = async () => {
      throw new Error(STARROCKS);
    };

    // Duplicated sentences appear once: four reads against one dead socket say the
    // same thing, and repeating it three times is noise, not information.
    await expect(provider.getMonitoringData()).rejects.toThrow(`connection lost; no slow log; ${STARROCKS}`);
  });

  test("one sentence for all four rethrows the original error, keeping its class", async () => {
    const provider = new TestProvider(makeConfig());
    await provider.connect();
    // A dead connection answers the same sentence four times. The first rejection is
    // already a mapped provider error, so it must reach the route as itself: re-wrapping
    // it would re-classify from the text and cost /api/db/monitoring the status code it
    // answered before per-panel degradation landed.
    const refused = new AuthenticationError("Authentication failed: password authentication failed", "postgres");
    const throwRefused = async () => {
      throw refused;
    };
    provider.getOverview = throwRefused;
    provider.getPerformanceMetrics = throwRefused;
    provider.getSlowQueries = throwRefused;
    provider.getActiveSessions = throwRefused;

    await expect(provider.getMonitoringData()).rejects.toBe(refused);
  });

  test("a non-Error rejection reason is stringified rather than dropped", async () => {
    const provider = new TestProvider(makeConfig());
    await provider.connect();
    provider.getSlowQueries = async () => {
      throw "slow log unavailable";
    };

    const data = await provider.getMonitoringData();

    expect(data.slowQueries).toBeUndefined();
    expect(data.errors?.slowQueries).toBe("slow log unavailable");
  });
});

// ============================================================================
// maintenanceControl() — the one gate both maintenance surfaces ask (#U9)
// ============================================================================

describe("maintenanceControl", () => {
  const caps = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities =>
    ({
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum", "analyze"],
      ...overrides,
    }) as ProviderCapabilities;

  test("undefined capabilities are a denial, not a permission", () => {
    // /api/db/provider-meta answers with nothing both while it is in flight and when
    // it failed, and failing open there is what put the dead buttons on the very
    // connections the #272/#282 gates exist for.
    expect(maintenanceControl(undefined, "vacuum", "perEntity")).toEqual({ offered: false });
    expect(maintenanceControl(undefined, "vacuum", "global")).toEqual({ offered: false });
  });

  test("an engine with no maintenance offers nothing in either placement", () => {
    const cassandraShaped = caps({ supportsMaintenance: false, maintenanceOperations: [] });

    expect(maintenanceControl(cassandraShaped, "vacuum", "perEntity").offered).toBe(false);
    expect(maintenanceControl(cassandraShaped, "analyze", "global").offered).toBe(false);
  });

  test("an operation the provider does not declare is never offered", () => {
    expect(maintenanceControl(caps(), "reindex", "perEntity").offered).toBe(false);
    expect(maintenanceControl(caps(), "reindex", "global").offered).toBe(false);
  });

  test("no spec means both placements under the CALLER's wording", () => {
    // The compatibility promise `maintenanceOperationSpecs` was made optional for:
    // an implementation that declares nothing behaves exactly as it did before #U9,
    // and gets no label of its own, so the surface keeps its generic verb.
    expect(maintenanceControl(caps(), "vacuum", "perEntity")).toEqual({ offered: true });
    expect(maintenanceControl(caps(), "vacuum", "global")).toEqual({ offered: true });
  });

  test("a spec decides each placement independently and names the control", () => {
    const sqliteShaped = caps({
      maintenanceOperations: ["vacuum", "analyze"],
      maintenanceOperationSpecs: {
        vacuum: { label: "Vacuum Database", perEntity: false, global: true },
        analyze: { label: "Analyze Table", perEntity: true, global: true },
      },
    });

    expect(maintenanceControl(sqliteShaped, "vacuum", "perEntity")).toEqual({
      offered: false,
      label: "Vacuum Database",
    });
    expect(maintenanceControl(sqliteShaped, "vacuum", "global")).toEqual({
      offered: true,
      label: "Vacuum Database",
    });
    expect(maintenanceControl(sqliteShaped, "analyze", "perEntity")).toEqual({
      offered: true,
      label: "Analyze Table",
    });
  });

  test("an operation whose target is a session id is offered in neither placement", () => {
    const withKill = caps({
      maintenanceOperations: ["kill"],
      maintenanceOperationSpecs: { kill: { label: "Terminate Backend", perEntity: false, global: false } },
    });

    expect(maintenanceControl(withKill, "kill", "perEntity").offered).toBe(false);
    expect(maintenanceControl(withKill, "kill", "global").offered).toBe(false);
  });

  test("a spec for an operation the provider does not declare cannot resurrect it", () => {
    // The two lists can drift; `maintenanceOperations` stays the authority, because
    // /api/db/maintenance validates against it and answers 400 for anything else.
    const drifted = caps({
      maintenanceOperations: ["analyze"],
      maintenanceOperationSpecs: { vacuum: { label: "Vacuum Table", perEntity: true, global: true } },
    });

    expect(maintenanceControl(drifted, "vacuum", "perEntity").offered).toBe(false);
  });
});
