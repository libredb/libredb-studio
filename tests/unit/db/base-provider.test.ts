import { describe, test, expect, spyOn } from "bun:test";
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { maintenanceControl, offersCodeGeneration, offersColumnProfiling, offersSchemaDiagram } from "@/lib/db/types";
import { AuthenticationError, ConnectionError, DatabaseConfigError, DatabaseError } from "@/lib/db/errors";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import { MONITORING_PANELS } from "@/lib/db/engine-facets/types";
import type {
  DatabaseConnection,
  QueryResult,
  Container,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  HealthInfo,
  DatabaseProvider,
  MaintenanceOperation,
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

  async listContainers(): Promise<Container[]> {
    return [];
  }

  async countObjects(): Promise<Record<string, KindCount>> {
    return {};
  }

  async listObjects(): Promise<DatabaseObject[]> {
    return [];
  }

  async describeObject(path: readonly string[]): Promise<ObjectDetail> {
    return { path, columns: [], indexes: [], foreignKeys: [] };
  }

  async describeObjects(): Promise<ObjectDetailBatch> {
    return { details: [] };
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
      // No grammar by default: a subclass offers the Create Table form only once it declares the grammar the form
      // writes, rather than inheriting a form in another engine's dialect (#648, #1822).
      expect(caps.createTable).toBeUndefined();
      expect(caps.supportsInlineRowEdit).toBe(true);
      // The opposite default to the line above, and deliberately: this class
      // implements no transaction methods, so a subclass that does not add them has
      // none and POST /api/db/transaction refuses the call. Only the four providers
      // that hold a session for one declare `true` (#464).
      expect(caps.supportsTransactions).toBe(false);
      // False too: a subclass that inherits the default has not said its engine takes the
      // Generate Test Data dialog's rows, so the row menus do not offer it (#1468).
      expect(caps.supportsTestDataGeneration).toBe(false);
      // Compile-time pin, checked by `bun run typecheck`: `ProviderCapabilities` is
      // published (`src/exports/types.ts`), so a capability added later must be
      // OPTIONAL or every external implementer of the type stops compiling. Omitting
      // it here is the whole assertion; the UI gates on `=== true`, so an absent
      // flag reads as unsupported. Reported by review on PR #289.
      const externalImplementer: ProviderCapabilities = {
        queryLanguage: "sql",
        supportsExplain: false,
        supportsExternalQueryLimiting: false,
        supportsMaintenance: false,
        maintenanceOperations: [],
        supportsConnectionString: false,
        defaultPort: null,
        schemaRefreshPattern: "",
      };
      expect(externalImplementer.supportsInlineRowEdit).toBeUndefined();
      expect(externalImplementer.createTable).toBeUndefined();
      expect(externalImplementer.supportsTransactions).toBeUndefined();
      expect(externalImplementer.supportsTestDataGeneration).toBeUndefined();
      expect(externalImplementer.declaresForeignKeys).toBeUndefined();
      // The conservative default for `containerPathShapes` lives in the kernel reader and never in a
      // base declaration: absent here, so every provider that declares a value declares it itself,
      // and one that forgets it reads as `exact` through `acceptedContainerShapes()` (#1147).
      expect(caps.containerPathShapes).toBeUndefined();
      expect(externalImplementer.containerPathShapes).toBeUndefined();
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
      // the card had (#464). The literal below is the compile-time half of that,
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
      expect(data.notOffered).toEqual([]);
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

  test("rejects when every panel it read rejected, carrying every distinct sentence", async () => {
    const provider = new TestProvider(makeConfig());
    await provider.connect();
    const lost = async () => {
      throw new Error("connection lost");
    };
    provider.getOverview = lost;
    provider.getPerformanceMetrics = lost;
    provider.getSlowQueries = async () => {
      throw new Error("no slow log");
    };
    provider.getActiveSessions = async () => {
      throw new Error(STARROCKS);
    };
    provider.getTableStats = lost;
    provider.getIndexStats = lost;
    provider.getStorageStats = lost;

    // Duplicated sentences appear once: seven reads against one dead socket say the
    // same thing, and repeating it is noise, not information.
    await expect(provider.getMonitoringData()).rejects.toThrow(`connection lost; no slow log; ${STARROCKS}`);
  });

  test("one sentence from every panel it read rethrows the original error, keeping its class", async () => {
    const provider = new TestProvider(makeConfig());
    await provider.connect();
    // A dead connection answers the same sentence on every read. The first rejection is
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
    provider.getTableStats = throwRefused;
    provider.getIndexStats = throwRefused;
    provider.getStorageStats = throwRefused;

    await expect(provider.getMonitoringData()).rejects.toBe(refused);
  });

  test("the core reads rejecting while a table read answers is a partial answer", async () => {
    const provider = new TestProvider(makeConfig());
    await provider.connect();
    const lost = async () => {
      throw new Error("connection lost");
    };
    provider.getOverview = lost;
    provider.getPerformanceMetrics = lost;
    provider.getSlowQueries = lost;
    provider.getActiveSessions = lost;

    const data = await provider.getMonitoringData();

    expect(data.tables).toBeArray();
    expect(data.indexes).toBeArray();
    expect(data.storage).toBeArray();
    expect(data.errors).toEqual({
      overview: "connection lost",
      performance: "connection lost",
      slowQueries: "connection lost",
      activeSessions: "connection lost",
    });
  });

  test("getMonitoringData reads the declaration of the connection's own type", async () => {
    const provider = new TestProvider(makeConfig({ type: "kafka" }));
    await provider.connect();
    const methods = {
      overview: "getOverview",
      performance: "getPerformanceMetrics",
      slowQueries: "getSlowQueries",
      activeSessions: "getActiveSessions",
      tables: "getTableStats",
      indexes: "getIndexStats",
      storage: "getStorageStats",
    } as const;
    const spies = MONITORING_PANELS.map((panel) => [panel, spyOn(provider, methods[panel])] as const);
    const offer = ENGINE_FACETS.kafka.monitoring;
    const notOffered = MONITORING_PANELS.filter((panel) => offer[panel] === "not-offered");

    const data = await provider.getMonitoringData();

    expect(notOffered.length).toBeGreaterThan(0);
    expect(data.notOffered).toEqual(notOffered);
    for (const [panel, spy] of spies) {
      expect(spy, panel).toHaveBeenCalledTimes(offer[panel] === "offered" ? 1 : 0);
    }
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
// maintenanceControl() — the one gate both maintenance surfaces ask (#496)
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

  test("a spec that names its kinds is offered on a row of those kinds only (#786)", () => {
    // Db2's views are relations, and RUNSTATS on one answers SQLSTATE 428DY.
    const db2Shaped = caps({
      maintenanceOperations: ["analyze"],
      maintenanceOperationSpecs: {
        analyze: {
          label: "Run Statistics",
          perEntity: true,
          global: false,
          kinds: ["table", "materialized_query_table"],
        },
      },
    });

    expect(maintenanceControl(db2Shaped, "analyze", "perEntity", "table").offered).toBe(true);
    expect(maintenanceControl(db2Shaped, "analyze", "perEntity", "materialized_query_table").offered).toBe(true);
    expect(maintenanceControl(db2Shaped, "analyze", "perEntity", "view")).toEqual({
      offered: false,
      label: "Run Statistics",
    });
    // A caller that names no kind, the Tables and Operations tabs listing tables, is not asked.
    expect(maintenanceControl(db2Shaped, "analyze", "perEntity").offered).toBe(true);
    // And a spec that names none still answers for every kind.
    const sqliteShaped = caps({
      maintenanceOperationSpecs: { analyze: { label: "Analyze Table", perEntity: true, global: true } },
    });
    expect(maintenanceControl(sqliteShaped, "analyze", "perEntity", "view").offered).toBe(true);
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

  test("a spec that declares no card field answers exactly what it answered before (#1089)", () => {
    // `toStrictEqual` and the key list, because an answer carrying `title: undefined` would be a different object
    // to a caller that lists its keys, and no provider but etcd declares any of the three fields.
    const sqliteShaped = caps({
      maintenanceOperationSpecs: { vacuum: { label: "Vacuum Database", perEntity: false, global: true } },
    });

    expect(maintenanceControl(sqliteShaped, "vacuum", "global")).toStrictEqual({
      offered: true,
      label: "Vacuum Database",
    });
    expect(Object.keys(maintenanceControl(sqliteShaped, "vacuum", "perEntity"))).toEqual(["offered", "label"]);
  });

  test("a declared card's title, description and typed confirmation travel with the answer, each on its own (#1089)", () => {
    const etcdShaped = caps({
      maintenanceOperations: ["compact", "defragment", "disarm"],
      maintenanceOperationSpecs: {
        compact: {
          label: "Compact history",
          title: "Compact history",
          description: "Removes every revision before the current one.",
          perEntity: false,
          global: true,
          confirmation: "typed",
        },
        defragment: { label: "Defragment", title: "Defragment the member", perEntity: false, global: true },
      },
    });
    const compactCard = {
      label: "Compact history",
      title: "Compact history",
      description: "Removes every revision before the current one.",
      confirmation: "typed" as const,
    };

    expect(maintenanceControl(etcdShaped, "compact", "global")).toStrictEqual({ offered: true, ...compactCard });
    // The fields describe the operation's card, not a placement: the per-row answer carries them and stays refused.
    expect(maintenanceControl(etcdShaped, "compact", "perEntity")).toStrictEqual({ offered: false, ...compactCard });
    expect(maintenanceControl(etcdShaped, "defragment", "global")).toStrictEqual({
      offered: true,
      label: "Defragment",
      title: "Defragment the member",
    });
    // An operation with no spec is offered under the caller's own card, as before.
    expect(maintenanceControl(etcdShaped, "disarm", "global")).toStrictEqual({ offered: true });
  });
});

describe("MaintenanceOperation", () => {
  test("every operation a provider may declare can be handed to runMaintenance, etcd's three included (#1089)", () => {
    // `POST /api/db/maintenance` hands a provider exactly what its `maintenanceOperations` declared, so the
    // interface and the base class both take `MaintenanceOperation`. The two assignments below are the
    // compile-time half of that, checked by `bun run typecheck`: a parameter narrowed back to `MaintenanceType`
    // fails there. `MaintenanceType` keeps its six because `MongoDBProvider.runMaintenance` switches over
    // exactly those, and this stub's own `runMaintenance` above takes the six as every such provider does.
    const etcdOperations: readonly MaintenanceOperation[] = ["compact", "defragment", "disarm"];
    const toTheInterface: readonly Parameters<DatabaseProvider["runMaintenance"]>[0][] = etcdOperations;
    const toTheBaseClass: readonly Parameters<BaseDatabaseProvider["runMaintenance"]>[0][] = etcdOperations;
    expect(toTheInterface).toBe(etcdOperations);
    expect(toTheBaseClass).toBe(etcdOperations);
  });
});

// ============================================================================
// offersColumnProfiling() and offersCodeGeneration(): the language gates both row menus and
// POST /api/db/profile ask (#1085)
// ============================================================================

/**
 * A declaration varied in the two language fields and nothing else. Both gates read only those
 * two, so every `false` below sits beside a `true` for a declaration that differs from it in
 * the one field under test, and a refusal cannot come from a fixture that is missing something.
 */
const languageCaps = (overrides: Partial<ProviderCapabilities>): ProviderCapabilities =>
  overrides as ProviderCapabilities;

describe("offersColumnProfiling", () => {
  test("SQL and MongoDB's JSON are profiled: those are the two statements the route builds", () => {
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "sql" }))).toBe(true);
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "json" }))).toBe(true);
  });

  test("JSON in a dialect of its own is not the MongoDB document the route builds", () => {
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "json", queryDialect: "redis" }))).toBe(false);
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "json", queryDialect: "libredb" }))).toBe(false);
    // A Kafka read request is JSON of this product's own schema (#1088), no MongoDB document either.
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "json", queryDialect: "kafka" }))).toBe(false);
    // An etcd command is a line of etcdctl's (#1089), no MongoDB document either.
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "json", queryDialect: "etcd" }))).toBe(false);
    // The control: the same language with the dialect removed.
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "json" }))).toBe(true);
  });

  test("Cypher is not profiled, because the route writes no Cypher (Neo4j spec 6.5)", () => {
    // Correct as a fall-through: the gate names the two languages the route writes.
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "cypher" }))).toBe(false);
  });

  test("PromQL is not profiled, because the route writes no PromQL", () => {
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "promql" }))).toBe(false);
    // The control: the same declaration in SQL.
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "sql" }))).toBe(true);
  });

  test("InfluxQL is not profiled, because the route writes no InfluxQL (InfluxDB spec 6.7)", () => {
    // Correct as a fall-through: the gate names the two languages the route writes. InfluxDB 3 declares SQL and
    // keeps Profile, which runs the route's SQL on its session database (InfluxDB spec R25).
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "influxql" }))).toBe(false);
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "sql" }))).toBe(true);
  });

  test("undefined capabilities are a denial, not a permission", () => {
    // /api/db/provider-meta answers with nothing both while it is in flight and when it
    // failed, which is the rule maintenanceControl already keeps.
    expect(offersColumnProfiling(undefined)).toBe(false);
    expect(offersColumnProfiling(languageCaps({ queryLanguage: "sql" }))).toBe(true);
  });
});

describe("offersCodeGeneration", () => {
  test("SQL and JSON are offered it, dialects included, because it names the row", () => {
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "sql" }))).toBe(true);
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "json" }))).toBe(true);
    // Redis and LibreDB keep it, as they did before (#427).
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "json", queryDialect: "redis" }))).toBe(true);
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "json", queryDialect: "libredb" }))).toBe(true);
  });

  test("PromQL is not offered it: a metric's label names model no stored record", () => {
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "promql" }))).toBe(false);
    // The control: the same declaration in SQL.
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "sql" }))).toBe(true);
  });

  test("Kafka is not offered it: a topic's columns are a read result's shape, which the models reject (#1088)", () => {
    // The models type `timestamp` as a Date where a read answers an ISO string, and `value` as a
    // record where a read answers text, base64 or a Confluent label (#1088, section 3.3).
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "json", queryDialect: "kafka" }))).toBe(false);
    // The controls: the same language with the dialect removed, and with another JSON dialect, which
    // keeps it, so the refusal is Kafka's own arm and not the dialect rule of the profiling gate.
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "json" }))).toBe(true);
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "json", queryDialect: "redis" }))).toBe(true);
  });

  test("etcd is not offered it: a key-prefix group's columns are a get row's fixed shape, no stored record (#1089)", () => {
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "json", queryDialect: "etcd" }))).toBe(false);
    // The controls: the same language with the dialect removed, and with another JSON dialect, which
    // keeps it, so the refusal is the etcd arm and not the dialect rule of the profiling gate.
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "json" }))).toBe(true);
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "json", queryDialect: "redis" }))).toBe(true);
  });

  test("Cypher is not offered it: a label's columns are sampled property keys, not a record type (Neo4j spec 6.5)", () => {
    // Correct as a fall-through: the gate names SQL and JSON, so a language added later is not offered it.
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "cypher" }))).toBe(false);
  });

  test("InfluxQL is not offered it: a measurement's columns are the tag and field keys its points carried (InfluxDB spec 6.7)", () => {
    // Correct as a fall-through, as for Cypher: the gate names SQL and JSON.
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "influxql" }))).toBe(false);
  });

  test("undefined capabilities are a denial, not a permission", () => {
    expect(offersCodeGeneration(undefined)).toBe(false);
    expect(offersCodeGeneration(languageCaps({ queryLanguage: "json" }))).toBe(true);
  });
});

describe("offersSchemaDiagram", () => {
  test("Cypher is not offered the diagram: a relationship type is no table and no column names an edge (SR20)", () => {
    expect(offersSchemaDiagram(languageCaps({ queryLanguage: "cypher" }))).toBe(false);
  });

  test("InfluxQL is not offered the diagram: a measurement declares no schema and no relation (InfluxDB spec 6.3)", () => {
    expect(offersSchemaDiagram(languageCaps({ queryLanguage: "influxql" }))).toBe(false);
  });

  test("every other language keeps it, and so does a connection whose capabilities have not answered yet", () => {
    expect(offersSchemaDiagram(languageCaps({ queryLanguage: "sql" }))).toBe(true);
    expect(offersSchemaDiagram(languageCaps({ queryLanguage: "json" }))).toBe(true);
    expect(offersSchemaDiagram(languageCaps({ queryLanguage: "json", queryDialect: "redis" }))).toBe(true);
    expect(offersSchemaDiagram(languageCaps({ queryLanguage: "promql" }))).toBe(true);
    expect(offersSchemaDiagram(undefined)).toBe(true);
  });
});
