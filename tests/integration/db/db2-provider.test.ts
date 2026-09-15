import { describe, test, expect, beforeEach, mock } from "bun:test";
import { ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { maintenanceControl } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import type { ProviderCapabilities } from "@/lib/db/types";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import { callerBoundTruncationReason, isSourcePartUnavailable } from "@/lib/db/object-kinds";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

// ---------------------------------------------------------------------------
// Mock ibm_db BEFORE loading the provider.
//
// The driver's high-level surface is `open(connStr, cb) -> conn`, and the connection
// answers `query(sql, cb)` with an array of row objects and `close(cb)`. The provider
// declares that slice locally (its published typings do not describe a promise API), so
// the mock only has to honour those three calls. `mockRowsFor` lets a test decide what a
// given SQL string returns, which is how the object surface is exercised without a live server.
// ---------------------------------------------------------------------------

let mockRowsFor: (sql: string, params?: unknown[]) => Record<string, unknown>[];
let openShouldFail: boolean;
let queryShouldThrowFor: (sql: string) => boolean;
const capturedConnStrings: string[] = [];
const capturedQueries: string[] = [];
// Every query's bound-parameter array, in call order. A 2-arg `query(sql, cb)` call
// records `undefined` (no params slot), which is how a param-binding regression is
// told apart from an unbound call: the fix must pass the array through, and the
// no-params path must NOT invent an empty array (ibm_db reads a function in the
// params slot as the callback, and some builds reject an empty array against a
// marker-less statement with CLI0100E).
const capturedParams: Array<unknown[] | undefined> = [];

const makeMockConnection = () => ({
  query: (
    sql: string,
    paramsOrCb: unknown[] | ((err: Error | null, rows: Record<string, unknown>[]) => void),
    maybeCb?: (err: Error | null, rows: Record<string, unknown>[]) => void,
  ) => {
    // The real driver treats a function in the params slot as the callback. Mirror
    // that so the provider's two call shapes — `query(sql, cb)` and
    // `query(sql, params, cb)` — are both honoured and distinguishable.
    const cb = (typeof paramsOrCb === "function" ? paramsOrCb : maybeCb)!;
    const params = typeof paramsOrCb === "function" ? undefined : paramsOrCb;
    capturedQueries.push(sql);
    capturedParams.push(params);
    if (queryShouldThrowFor(sql)) {
      cb(new Error("SQL0551N the user does not have the required authorization"), []);
      return;
    }
    cb(null, mockRowsFor(sql, params));
  },
  close: (cb: (err: Error | null) => void) => cb(null),
});

mock.module("ibm_db", () => {
  const open = (connStr: string, cb: (err: Error | null, conn: ReturnType<typeof makeMockConnection>) => void) => {
    capturedConnStrings.push(connStr);
    if (openShouldFail) {
      cb(new Error("SQL30081N a communication error has been detected"), makeMockConnection());
      return;
    }
    cb(null, makeMockConnection());
  };
  return { default: { open }, open };
});

const { Db2Provider } = await import("@/lib/db/providers/sql/db2");

const baseConfig: DatabaseConnection = {
  id: "db2-test",
  name: "Db2 Test",
  type: "db2",
  host: "localhost",
  port: 50000,
  database: "testdb",
  user: "db2inst1",
  password: "secret",
  createdAt: new Date(),
};

beforeEach(() => {
  mockRowsFor = () => [];
  openShouldFail = false;
  queryShouldThrowFor = () => false;
  capturedConnStrings.length = 0;
  capturedQueries.length = 0;
  capturedParams.length = 0;
});

describe("Db2Provider validation", () => {
  test("throws when host is missing and no connectionString", () => {
    expect(() => new Db2Provider({ ...baseConfig, host: undefined })).toThrow(DatabaseConfigError);
  });

  test("throws when database is missing and no connectionString", () => {
    expect(() => new Db2Provider({ ...baseConfig, database: undefined })).toThrow(DatabaseConfigError);
  });

  test("a connectionString bypasses host/database validation", () => {
    expect(
      () => new Db2Provider({ ...baseConfig, host: undefined, database: undefined, connectionString: "db2://h/db" }),
    ).not.toThrow();
  });

  // The DRDA attribute list has no escaping for its `;` delimiter, so a field value that
  // contains one would misparse (password `pa;ss` → auth on `pa`) or inject an attribute
  // (`PWD=x;SECURITY=NONE` connects). The field-built path must refuse the delimiter.
  test("rejects a ';' in the password (connection-string injection guard)", () => {
    expect(() => new Db2Provider({ ...baseConfig, password: "pa;ss" })).toThrow(DatabaseConfigError);
  });

  test("rejects a ';' in the username", () => {
    expect(() => new Db2Provider({ ...baseConfig, user: "u;SECURITY=NONE" })).toThrow(DatabaseConfigError);
  });

  test("rejects a ';' in the database name", () => {
    expect(() => new Db2Provider({ ...baseConfig, database: "db;PORT=1" })).toThrow(DatabaseConfigError);
  });

  test("a pasted connection string is the user's own responsibility and is not delimiter-checked", () => {
    // The user typed the whole attribute list, so a ';' there is theirs to get right —
    // the guard is only for values WE interpolate into the list.
    expect(
      () =>
        new Db2Provider({
          ...baseConfig,
          host: undefined,
          database: undefined,
          connectionString: "DATABASE=x;HOSTNAME=h;PORT=50000;UID=u;PWD=p;",
        }),
    ).not.toThrow();
  });
});

describe("Db2Provider capabilities", () => {
  const caps = new Db2Provider(baseConfig).getCapabilities();

  test("declares the DRDA default port", () => {
    expect(caps.defaultPort).toBe(50000);
  });

  test("explain is disabled initially (MSSQL/#126 posture)", () => {
    expect(caps.supportsExplain).toBe(false);
    expect(caps.explainFormat).toBeUndefined();
  });

  test("declares no transaction session yet, but inline row edit and connection strings", () => {
    expect(caps.supportsTransactions).toBe(false);
    expect(caps.supportsInlineRowEdit).toBe(true);
    expect(caps.supportsConnectionString).toBe(true);
  });

  test("offers only the maintenance operations that are wired (analyze, optimize)", () => {
    expect(caps.maintenanceOperations.sort()).toEqual(["analyze", "optimize"]);
  });
});

describe("Db2Provider labels", () => {
  const labels = new Db2Provider(baseConfig).getLabels();

  test("relabels the maintenance verbs to Db2's own (RUNSTATS / REORG)", () => {
    expect(labels.analyzeAction).toBe("Run Statistics");
    // Db2 has no VACUUM; the vacuum slot points at REORG (`optimize`).
    expect(labels.vacuumAction).toBe("Reorganize Table");
    expect(labels.vacuumActionOperation).toBe("optimize");
  });

  test("the slow-query empty state names Db2's monitoring metrics, not pg_stat_statements", () => {
    // The Queries panel falls back to a Postgres "install pg_stat_statements" message when a
    // provider declares none; that is false for Db2, whose timings come from mon_req_metrics.
    expect(labels.slowQueriesEmptyState).toBeDefined();
    expect(labels.slowQueriesEmptyState).toMatch(/mon_req_metrics|monitoring metrics/i);
    expect(labels.slowQueriesEmptyState).not.toMatch(/pg_stat_statements/i);
  });
});

describe("Db2Provider maintenance is per-table only (no whole-database form)", () => {
  const caps = new Db2Provider(baseConfig).getCapabilities();

  test("analyze and optimize are perEntity but NOT global", () => {
    // RUNSTATS and REORG each target one table on Db2 LUW; there is no whole-database
    // statement, so a global card would fire the operation with no target and fail. Both
    // specs declare global:false so the Operations tab renders no global card for them.
    expect(caps.maintenanceOperationSpecs?.analyze).toEqual({
      label: "Run Statistics",
      perEntity: true,
      global: false,
    });
    expect(caps.maintenanceOperationSpecs?.optimize).toEqual({
      label: "Reorganize Table",
      perEntity: true,
      global: false,
    });
  });

  test("the global (no-target) maintenance controls are not offered", () => {
    // maintenanceControl gates the global placement on the spec's `global` flag.
    expect(maintenanceControl(caps, "analyze", "global").offered).toBe(false);
    expect(maintenanceControl(caps, "optimize", "global").offered).toBe(false);
    // …but the per-table controls ARE offered, so the operation still has a home.
    expect(maintenanceControl(caps, "analyze", "perEntity").offered).toBe(true);
    expect(maintenanceControl(caps, "optimize", "perEntity").offered).toBe(true);
  });
});

describe("Db2Provider prepareQuery (FETCH FIRST)", () => {
  const provider = new Db2Provider(baseConfig);

  test("injects FETCH FIRST for an unbounded SELECT", () => {
    const prepared = provider.prepareQuery("SELECT * FROM users", { limit: 50 });
    expect(prepared.wasLimited).toBe(true);
    expect(prepared.query).toContain("FETCH FIRST 50 ROWS ONLY");
    expect(prepared.query).not.toContain("LIMIT");
  });

  test("uses OFFSET n ROWS FETCH NEXT for a paged SELECT", () => {
    const prepared = provider.prepareQuery("SELECT * FROM users", { limit: 25, offset: 50 });
    expect(prepared.wasLimited).toBe(true);
    expect(prepared.query).toContain("OFFSET 50 ROWS FETCH NEXT 25 ROWS ONLY");
  });

  test("leaves a statement that already declares FETCH FIRST untouched", () => {
    const sql = "SELECT * FROM users FETCH FIRST 10 ROWS ONLY";
    const prepared = provider.prepareQuery(sql, { limit: 50 });
    expect(prepared.wasLimited).toBe(false);
    expect(prepared.query).toBe(sql);
  });

  test("does not limit a non-SELECT", () => {
    const prepared = provider.prepareQuery("UPDATE users SET active = 1", { limit: 50 });
    expect(prepared.wasLimited).toBe(false);
  });

  test("splices the clause before a trailing semicolon rather than after it", () => {
    // The clause must land between the statement and its trailing trivia; appended after a
    // ';' it would be a syntax error, and Db2 (like Oracle) rejects a trailing ';' on a
    // plain statement. Pins the #280 shape for Db2.
    const prepared = provider.prepareQuery("SELECT * FROM users;", { limit: 10 });
    expect(prepared.wasLimited).toBe(true);
    expect(prepared.query).toContain("FETCH FIRST 10 ROWS ONLY");
    // The FETCH clause is before the ';', not after it.
    expect(prepared.query.indexOf("FETCH FIRST")).toBeLessThan(prepared.query.lastIndexOf(";"));
  });

  test("does not append a clause inside a trailing line comment", () => {
    // A `-- comment` after the statement must not swallow the appended clause.
    const prepared = provider.prepareQuery("SELECT * FROM users -- trailing", { limit: 10 });
    if (prepared.wasLimited) {
      // If it rewrote, the clause is NOT inside the comment (it precedes it).
      expect(prepared.query.indexOf("FETCH FIRST")).toBeLessThan(prepared.query.indexOf("-- trailing"));
    } else {
      // Or it declined to rewrite, which is the safe alternative the guard allows.
      expect(prepared.query).toBe("SELECT * FROM users -- trailing");
    }
  });
});

describe("Db2Provider connect", () => {
  test("builds a DRDA attribute string from the fields", async () => {
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    const connStr = capturedConnStrings[0];
    expect(connStr).toContain("DATABASE=testdb");
    expect(connStr).toContain("HOSTNAME=localhost");
    expect(connStr).toContain("PORT=50000");
    expect(connStr).toContain("UID=db2inst1");
    expect(connStr).toContain("PROTOCOL=TCPIP");
    await provider.disconnect();
  });

  test("adds SECURITY=SSL when TLS is requested", async () => {
    const provider = new Db2Provider({ ...baseConfig, ssl: { mode: "require" } });
    await provider.connect();
    expect(capturedConnStrings[0]).toContain("SECURITY=SSL");
    await provider.disconnect();
  });

  test("passes a pasted connection string through unchanged", async () => {
    const raw = "DATABASE=x;HOSTNAME=h;PORT=50000;UID=u;PWD=p;SECURITY=SSL;";
    const provider = new Db2Provider({ ...baseConfig, connectionString: raw });
    await provider.connect();
    expect(capturedConnStrings[0]).toBe(raw);
    await provider.disconnect();
  });

  test("wraps a failed open in a ConnectionError", async () => {
    openShouldFail = true;
    const provider = new Db2Provider(baseConfig);
    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe("Db2Provider query", () => {
  test("derives fields from the first row and omits columnTypes (unverified)", async () => {
    mockRowsFor = () => [{ ID: 1, NAME: "a" }];
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const result = await provider.query("SELECT id, name FROM users");
    expect(result.fields).toEqual(["ID", "NAME"]);
    expect(result.rowCount).toBe(1);
    // columnTypes is deliberately absent — the high-level ibm_db surface does not
    // expose declared types, and absence is the signal the grid reads (#273).
    expect(result.columnTypes).toBeUndefined();
    await provider.disconnect();
  });

  test("an empty result yields no fields rather than throwing", async () => {
    mockRowsFor = () => [];
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const result = await provider.query("SELECT id FROM empty_table");
    expect(result.fields).toEqual([]);
    expect(result.rowCount).toBe(0);
    await provider.disconnect();
  });

  // Regression: the first cut ignored the `params` argument entirely, so a bound
  // statement reached the driver with its `?` markers unfilled and Db2 answered
  // `CLI0100E Wrong number of parameters` — which broke inline row edit, the very
  // capability the provider advertises (`supportsInlineRowEdit: true`). The grid
  // sends `UPDATE t SET "c" = ? WHERE "id" = ?` with a values array (issue #290), so
  // the provider must forward it positionally.
  test("binds positional params, passing the values array through to the driver", async () => {
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    await provider.query('UPDATE LIBREDB_EDIT SET "NAME" = ? WHERE "ID" = ?', ["alpha-edited", 1]);
    await provider.disconnect();

    const idx = capturedQueries.findIndex((q) => q.startsWith("UPDATE LIBREDB_EDIT"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(capturedParams[idx]).toEqual(["alpha-edited", 1]);
  });

  // The other half of the same fix: a call with no params (or an empty array) must
  // use the two-arg `query(sql, cb)` form, never `query(sql, [], cb)`. ibm_db reads a
  // function in the params slot as the callback, and an empty array bound against a
  // marker-less statement can itself raise CLI0100E — so passing it would reintroduce
  // the bug on every ordinary SELECT.
  test("omits the params slot entirely when there are none", async () => {
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    await provider.query("SELECT id FROM users");
    await provider.disconnect();

    const idx = capturedQueries.findIndex((q) => q.startsWith("SELECT id FROM users"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(capturedParams[idx]).toBeUndefined();
  });

  test("treats an empty params array as no params (two-arg form)", async () => {
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    await provider.query("SELECT id FROM users", []);
    await provider.disconnect();

    const idx = capturedQueries.findIndex((q) => q.startsWith("SELECT id FROM users"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(capturedParams[idx]).toBeUndefined();
  });
});

// The object surface (#789) lives in its own block at the end of this file.

describe("Db2Provider getHealth and monitoring", () => {
  test("health reports the unavailable cache-ratio sentinel when the read is refused", async () => {
    queryShouldThrowFor = (sql) => sql.includes("BP_HITRATIO") || sql.includes("MON_GET_CONNECTION");
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const health = await provider.getHealth();
    expect(health.cacheHitRatio).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions).toEqual([]);
    // A refused connection-count read leaves the field ABSENT, never a fabricated 0.
    expect(health.activeConnections).toBeUndefined();
    await provider.disconnect();
  });

  test("health reports a measured cache hit ratio and connection count when readable", async () => {
    mockRowsFor = (sql) => {
      if (sql.includes("BP_HITRATIO")) return [{ LOGICAL_READS: "1000", PHYSICAL_READS: "50" }];
      if (sql.includes("MON_GET_CONNECTION") && sql.includes("COUNT")) return [{ N: "7" }];
      return [];
    };
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const health = await provider.getHealth();
    // (1000 - 50) / 1000 = 95.0%
    expect(health.cacheHitRatio).toBe("95.0");
    expect(health.activeConnections).toBe(7);
    await provider.disconnect();
  });

  test("performance metrics carry the cache ratio and deadlocks when readable", async () => {
    mockRowsFor = (sql) => {
      if (sql.includes("BP_HITRATIO")) return [{ LOGICAL_READS: "200", PHYSICAL_READS: "0" }];
      if (sql.includes("DEADLOCKS")) return [{ DEADLOCKS: "3" }];
      return [];
    };
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    expect(await provider.getPerformanceMetrics()).toEqual({ cacheHitRatio: 100, deadlocks: 3 });
    await provider.disconnect();
  });

  test("a buffer pool with no reads yet yields no ratio rather than a fabricated 0", async () => {
    mockRowsFor = (sql) => (sql.includes("BP_HITRATIO") ? [{ LOGICAL_READS: "0", PHYSICAL_READS: "0" }] : []);
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    expect(await provider.getPerformanceMetrics()).toEqual({});
    await provider.disconnect();
  });

  test("getOverview reads the Db2 service level for the version", async () => {
    mockRowsFor = (sql) => (sql.includes("ENV_GET_INST_INFO") ? [{ SERVICE_LEVEL: "DB2 v12.1.0.0" }] : []);
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const overview = await provider.getOverview();
    expect(overview.version).toBe("DB2 v12.1.0.0");
    // With no catalog/activation/tablespace rows, the derived fields stay neutral.
    expect(overview.databaseSize).toBe("N/A");
    expect(overview.uptime).toBe("N/A");
    expect(overview.maxConnections).toBe(0);
    await provider.disconnect();
  });

  test("getOverview fills counts, uptime and database size when their reads succeed", async () => {
    mockRowsFor = (sql) => {
      if (sql.includes("ENV_GET_INST_INFO")) return [{ SERVICE_LEVEL: "DB2 v11.5.9.0" }];
      if (sql.includes("SYSCAT.TABLES") && sql.includes("SYSCAT.INDEXES"))
        return [{ TABLE_COUNT: "1135", INDEX_COUNT: "3300" }];
      if (sql.includes("UPTIME_SECONDS")) return [{ UPTIME_SECONDS: "3600" }];
      if (sql.includes("maxappls")) return [{ VALUE: "397" }];
      if (sql.includes("BP_HITRATIO")) return [];
      if (sql.includes("MON_GET_TABLESPACE"))
        return [
          { TBSP_NAME: "USERSPACE1", TBSP_USED_PAGES: "1000", TBSP_PAGE_SIZE: "4096" },
          { TBSP_NAME: "SYSCATSPACE", TBSP_USED_PAGES: "500", TBSP_PAGE_SIZE: "4096" },
        ];
      return [];
    };
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const overview = await provider.getOverview();
    await provider.disconnect();

    expect(overview.tableCount).toBe(1135);
    expect(overview.indexCount).toBe(3300);
    expect(overview.maxConnections).toBe(397);
    // (1000 + 500) pages * 4096 = 6,144,000 bytes → formatted, non-"N/A", with the numeric
    // byte figure set so fleet-health and the Overview total can sum it.
    expect(overview.databaseSize).not.toBe("N/A");
    expect(overview.databaseSizeBytes).toBe(6144000);
    // Uptime is derived from DB_CONN_TIME, so it is a real duration string, not the sentinel.
    expect(overview.uptime).not.toBe("N/A");
    await provider.disconnect();
  });

  // Regression: uptime is computed in the database (elapsed seconds), not by parsing the
  // activation timestamp in JS — a UTC server read as local time produced a NEGATIVE uptime.
  // A negative/nonsensical value must fall back to "N/A", never render as "-3600000ms".
  test("getOverview rejects a negative uptime rather than rendering it", async () => {
    mockRowsFor = (sql) => {
      if (sql.includes("ENV_GET_INST_INFO")) return [{ SERVICE_LEVEL: "DB2 v11.5.9.0" }];
      if (sql.includes("UPTIME_SECONDS")) return [{ UPTIME_SECONDS: "-5" }];
      return [];
    };
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const overview = await provider.getOverview();
    await provider.disconnect();
    expect(overview.uptime).toBe("N/A");
  });

  test("getOverview surfaces the active-connection count when readable", async () => {
    mockRowsFor = (sql) => {
      if (sql.includes("ENV_GET_INST_INFO")) return [{ SERVICE_LEVEL: "DB2 v11.5.9.0" }];
      if (sql.includes("MON_GET_CONNECTION") && sql.includes("COUNT")) return [{ N: "12" }];
      return [];
    };
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const overview = await provider.getOverview();
    expect(overview.activeConnections).toBe(12);
    await provider.disconnect();
  });

  test("getOverview leaves the neutral version when the permission-gated read is denied", async () => {
    queryShouldThrowFor = (sql) => sql.includes("ENV_GET_INST_INFO");
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const overview = await provider.getOverview();
    // The denied read is swallowed rather than failing the whole overview.
    expect(overview.version).toBe("Unknown");
    // A denied connection-count read leaves the field absent, never a fabricated 0.
    expect(overview.activeConnections).toBeUndefined();
    await provider.disconnect();
  });

  test("getIndexStats maps SYSCAT.INDEXES structural fields plus MON_GET_INDEX scans", async () => {
    mockRowsFor = (sql) =>
      sql.includes("SYSCAT.INDEXES")
        ? [
            {
              INDSCHEMA: "APPDATA",
              INDNAME: "PK_ORDERS",
              TABNAME: "ORDERS",
              UNIQUERULE: "P",
              INDEXTYPE: "REG",
              COLS: "ORDER_ID",
              SCANS: "42",
            },
            {
              INDSCHEMA: "APPDATA",
              INDNAME: "NU_ORDERS_CUST",
              TABNAME: "ORDERS",
              UNIQUERULE: "D",
              INDEXTYPE: "REG",
              COLS: "CUSTOMER_ID,CREATED_AT",
              SCANS: "0",
            },
          ]
        : [];
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const indexes = await provider.getIndexStats();
    await provider.disconnect();

    expect(indexes).toHaveLength(2);
    // 'P' → primary AND unique, single column, real scan count.
    expect(indexes[0]).toMatchObject({
      schemaName: "APPDATA",
      tableName: "ORDERS",
      indexName: "PK_ORDERS",
      indexType: "REG",
      columns: ["ORDER_ID"],
      isUnique: true,
      isPrimary: true,
      indexSize: "N/A",
      scans: 42,
    });
    expect(indexes[0].indexSizeBytes).toBeUndefined();
    // 'D' → neither primary nor unique; multi-column split from the LISTAGG string.
    expect(indexes[1]).toMatchObject({
      indexName: "NU_ORDERS_CUST",
      columns: ["CUSTOMER_ID", "CREATED_AT"],
      isUnique: false,
      isPrimary: false,
      scans: 0,
    });
  });

  // The permission-gated monitoring reads must return empty, never throw, when the
  // connecting account cannot read the MON_GET_* functions (tryRun swallows the refusal).
  test("slow queries / sessions / storage return empty when the monitoring reads are refused", async () => {
    queryShouldThrowFor = (sql) => sql.includes("MON_GET_");
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    await provider.disconnect();
  });

  test("getSlowQueries maps the package-cache statement rows with a derived average", async () => {
    mockRowsFor = (sql) =>
      sql.includes("MON_GET_PKG_CACHE_STMT")
        ? [
            {
              STMT_TEXT: "SELECT * FROM ORDERS",
              NUM_EXECUTIONS: "4",
              NUM_EXEC_WITH_METRICS: "4",
              TOTAL_ACT_TIME: "800",
              ROWS_READ: "40",
            },
          ]
        : [];
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const slow = await provider.getSlowQueries();
    await provider.disconnect();
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({
      query: "SELECT * FROM ORDERS",
      calls: 4,
      totalTime: 800,
      avgTime: 200, // 800 / 4
      rows: 40,
    });
  });

  test("getActiveSessions maps MON_GET_CONNECTION rows, reporting no invented state/query", async () => {
    mockRowsFor = (sql) =>
      sql.includes("MON_GET_CONNECTION") && !sql.includes("COUNT")
        ? [
            {
              APPLICATION_HANDLE: "4059",
              APPLICATION_NAME: "sample_app",
              CLIENT_IPADDR: "192.0.2.10",
              SYSTEM_AUTH_ID: "APPDATA",
              TOTAL_APP_COMMITS: "3",
            },
          ]
        : [];
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const sessions = await provider.getActiveSessions();
    await provider.disconnect();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      pid: "4059",
      user: "APPDATA",
      applicationName: "sample_app",
      clientAddr: "192.0.2.10",
      state: "active",
      query: "",
    });
  });

  test("getStorageStats maps tablespace pages to bytes and fill percentage", async () => {
    mockRowsFor = (sql) =>
      sql.includes("MON_GET_TABLESPACE")
        ? [{ TBSP_NAME: "USERSPACE1", TBSP_TOTAL_PAGES: "1000", TBSP_USED_PAGES: "250", TBSP_PAGE_SIZE: "4096" }]
        : [];
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const storage = await provider.getStorageStats();
    await provider.disconnect();
    expect(storage).toHaveLength(1);
    expect(storage[0]).toMatchObject({
      name: "USERSPACE1",
      sizeBytes: 250 * 4096, // used pages * page size
      usagePercent: 25, // 250 / 1000
    });
  });

  // getTableStats is NOT a neutral empty: SYSCAT.TABLES publishes a real row count (CARD)
  // and the RUNSTATS timestamp (STATS_TIME), so the provider surfaces them for the admin
  // Tables panel. The currency caveat is the whole point of these assertions.
  test("getTableStats maps CARD to rowCount and STATS_TIME to lastAnalyze", async () => {
    mockRowsFor = (sql) => {
      if (!sql.includes("SYSCAT.TABLES")) return [];
      return [{ TABSCHEMA: "APPDATA", TABNAME: "ORDERS", CARD: "1000000", STATS_TIME: "2020-01-15 12:00:00.000000" }];
    };
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const stats = await provider.getTableStats();
    await provider.disconnect();

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      schemaName: "APPDATA",
      tableName: "ORDERS",
      rowCount: 1000000,
      // Size is not read per table (too heavy across a whole schema), so the required
      // fields carry the honest placeholder and the byte fields are absent.
      totalSize: "N/A",
      totalSizeBytes: 0,
    });
    expect(stats[0].tableSizeBytes).toBeUndefined();
    // STATS_TIME becomes lastAnalyze, so a reader can see how stale the count is.
    expect(stats[0].lastAnalyze).toBeInstanceOf(Date);
    expect(stats[0].lastAnalyze?.getFullYear()).toBe(2020);
  });

  // A table that never had RUNSTATS reports CARD = -1 and STATS_TIME = NULL. That must read
  // as "no stats" (rowCount 0, no lastAnalyze), never as a literal -1 row count.
  test("getTableStats treats CARD = -1 / NULL STATS_TIME as no-stats, not a -1 count", async () => {
    mockRowsFor = (sql) => {
      if (!sql.includes("SYSCAT.TABLES")) return [];
      return [{ TABSCHEMA: "APPDATA", TABNAME: "FRESHLY_CREATED", CARD: "-1", STATS_TIME: null }];
    };
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const stats = await provider.getTableStats();
    await provider.disconnect();

    expect(stats).toHaveLength(1);
    expect(stats[0].rowCount).toBe(0);
    expect(stats[0].lastAnalyze).toBeUndefined();
  });
});

describe("Db2Provider runMaintenance", () => {
  test("analyze issues RUNSTATS through ADMIN_CMD", async () => {
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const result = await provider.runMaintenance("analyze", "users");
    expect(result.success).toBe(true);
    const stmt = capturedQueries.find((q) => q.includes("RUNSTATS"));
    expect(stmt).toContain("CALL SYSPROC.ADMIN_CMD");
    expect(stmt).toContain('RUNSTATS ON TABLE "users"');
    await provider.disconnect();
  });

  test("optimize issues REORG TABLE through ADMIN_CMD", async () => {
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const result = await provider.runMaintenance("optimize", "users");
    expect(result.success).toBe(true);
    const stmt = capturedQueries.find((q) => q.includes("REORG"));
    expect(stmt).toContain('REORG TABLE "users"');
    await provider.disconnect();
  });

  test("analyze without a target is refused rather than sent", async () => {
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    await expect(provider.runMaintenance("analyze")).rejects.toBeInstanceOf(DatabaseConfigError);
    await provider.disconnect();
  });

  test("optimize without a target is refused rather than sent", async () => {
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    await expect(provider.runMaintenance("optimize")).rejects.toBeInstanceOf(DatabaseConfigError);
    await provider.disconnect();
  });

  test("an operation Db2 does not offer is refused", async () => {
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    // `vacuum` is not in maintenanceOperations, so it reaches the unsupported branch.
    await expect(provider.runMaintenance("vacuum", "users")).rejects.toBeInstanceOf(DatabaseConfigError);
    await provider.disconnect();
  });
});

// ---------------------------------------------------------------------------
// The object surface (#786, #789)
//
// `catalogRows` mirrors `docker/db2-init/01-object-fixture.sql` as Db2 12.1 answered it on
// 2026-09-15, including the two shapes a hand-typed double would get wrong: a SCHEMA column
// is blank-padded to eight characters while an object name is not, and a trigger may live in
// a schema other than its table's. Each answer is chosen by the catalog view the statement
// reads and by its BOUND values, never by the statement's exact spelling.
// ---------------------------------------------------------------------------

const VIEW_TEXT = "CREATE VIEW APP.ORDER_SUMMARY AS\n  SELECT C.NAME, SUM(O.TOTAL) AS TOTAL -- author comment";
const MQT_TEXT =
  "CREATE TABLE APP.ORDER_TOTALS AS (SELECT CUSTOMER_ID, SUM(TOTAL) AS TOTAL FROM APP.ORDERS GROUP BY CUSTOMER_ID) DATA INITIALLY DEFERRED REFRESH DEFERRED";
const PROC_TEXT =
  "CREATE PROCEDURE APP.ADD_ORDER (IN P_ID INTEGER)\nLANGUAGE SQL\nBEGIN\n  INSERT INTO APP.ORDERS (ID) VALUES (P_ID);\nEND";
const FN_TEXT = "CREATE FUNCTION APP.ORDER_TOTAL (P_ID INTEGER) RETURNS DECIMAL(12, 2) RETURN 1";
const TRIGGER_TEXT = "CREATE TRIGGER APP.ORDERS_NOTE_DEFAULT\nNO CASCADE BEFORE INSERT ON APP.ORDERS";
const AUDIT_TEXT = "CREATE TRIGGER REPORTING.ORDERS_AUDIT AFTER UPDATE ON APP.ORDERS FOR EACH ROW";

const TABLES = [
  { TABSCHEMA: "APP     ", TABNAME: "CUSTOMERS", TYPE: "T", STATUS: "N", CARD: "2", VALID: null },
  { TABSCHEMA: "APP     ", TABNAME: "ORDERS", TYPE: "T", STATUS: "N", CARD: "-1", VALID: null },
  { TABSCHEMA: "APP     ", TABNAME: "Mixed Case", TYPE: "T", STATUS: "C", CARD: "-1", VALID: null },
  { TABSCHEMA: "APP     ", TABNAME: "ORDER_SUMMARY", TYPE: "V", STATUS: "N", CARD: "-1", VALID: "Y" },
  { TABSCHEMA: "APP     ", TABNAME: "SCRATCH_VIEW", TYPE: "V", STATUS: "N", CARD: "-1", VALID: "N" },
  { TABSCHEMA: "APP     ", TABNAME: "ORDER_TOTALS", TYPE: "S", STATUS: "N", CARD: "0", VALID: "Y" },
  { TABSCHEMA: "APP     ", TABNAME: "CLIENTS", TYPE: "A", STATUS: "N", CARD: "-1", VALID: null },
  { TABSCHEMA: "REPORTING", TABNAME: "DAILY", TYPE: "T", STATUS: "N", CARD: "-1", VALID: null },
];
const VIEW_TEXTS: Record<string, string> = {
  ORDER_SUMMARY: VIEW_TEXT,
  SCRATCH_VIEW: "CREATE VIEW APP.SCRATCH_VIEW AS SELECT ID FROM APP.SCRATCH",
  ORDER_TOTALS: MQT_TEXT,
};
const ROUTINES = [
  {
    ROUTINESCHEMA: "APP",
    SPECIFICNAME: "SQL260915014426733",
    ROUTINENAME: "ADD_ORDER",
    ROUTINETYPE: "P",
    VALID: "Y",
    ORIGIN: "Q",
    TEXT: PROC_TEXT,
  },
  {
    ROUTINESCHEMA: "APP",
    SPECIFICNAME: "ORDER_TOTAL_BY_ID",
    ROUTINENAME: "ORDER_TOTAL",
    ROUTINETYPE: "F",
    VALID: "Y",
    ORIGIN: "Q",
    TEXT: FN_TEXT,
  },
  {
    ROUTINESCHEMA: "APP",
    SPECIFICNAME: "SQL260915014426735",
    ROUTINENAME: "ORDER_TOTAL",
    ROUTINETYPE: "F",
    VALID: "Y",
    ORIGIN: "Q",
    TEXT: FN_TEXT,
  },
  {
    ROUTINESCHEMA: "APP",
    SPECIFICNAME: "SQL260915014426740",
    ROUTINENAME: "EXT_FN",
    ROUTINETYPE: "F",
    VALID: "Y",
    ORIGIN: "E",
    TEXT: null,
  },
];
const TRIGGERS = [
  {
    TRIGSCHEMA: "APP",
    TRIGNAME: "ORDERS_NOTE_DEFAULT",
    TABSCHEMA: "APP",
    TABNAME: "ORDERS",
    VALID: "Y",
    TEXT: TRIGGER_TEXT,
  },
  {
    TRIGSCHEMA: "REPORTING",
    TRIGNAME: "ORDERS_AUDIT",
    TABSCHEMA: "APP",
    TABNAME: "ORDERS",
    VALID: "Y",
    TEXT: AUDIT_TEXT,
  },
];
const COLUMNS: Record<string, Record<string, unknown>[]> = {
  ORDERS: [
    {
      COLUMN_NAME: "ID",
      TYPENAME: "INTEGER",
      LENGTH: 4,
      SCALE: 0,
      CODEPAGE: 0,
      NULLS: "N",
      DEFAULT_VALUE: null,
      KEYSEQ: 1,
    },
    {
      COLUMN_NAME: "CUSTOMER_ID",
      TYPENAME: "INTEGER",
      LENGTH: 4,
      SCALE: 0,
      CODEPAGE: 0,
      NULLS: "Y",
      DEFAULT_VALUE: null,
      KEYSEQ: null,
    },
    {
      COLUMN_NAME: "TOTAL",
      TYPENAME: "DECIMAL",
      LENGTH: 12,
      SCALE: 2,
      CODEPAGE: 0,
      NULLS: "Y",
      DEFAULT_VALUE: "0",
      KEYSEQ: null,
    },
    {
      COLUMN_NAME: "NOTE",
      TYPENAME: "VARCHAR",
      LENGTH: 200,
      SCALE: 0,
      CODEPAGE: 1208,
      NULLS: "Y",
      DEFAULT_VALUE: null,
      KEYSEQ: null,
    },
  ],
  CUSTOMERS: [
    {
      COLUMN_NAME: "ID",
      TYPENAME: "INTEGER",
      LENGTH: 4,
      SCALE: 0,
      CODEPAGE: 0,
      NULLS: "N",
      DEFAULT_VALUE: null,
      KEYSEQ: 1,
    },
    {
      COLUMN_NAME: "NAME",
      TYPENAME: "VARCHAR",
      LENGTH: 100,
      SCALE: 0,
      CODEPAGE: 1208,
      NULLS: "Y",
      DEFAULT_VALUE: null,
      KEYSEQ: null,
    },
  ],
  DAILY: [
    {
      COLUMN_NAME: "DAY",
      TYPENAME: "DATE",
      LENGTH: 4,
      SCALE: 0,
      CODEPAGE: 0,
      NULLS: "N",
      DEFAULT_VALUE: null,
      KEYSEQ: 1,
    },
    {
      COLUMN_NAME: "CUSTOMER_ID",
      TYPENAME: "INTEGER",
      LENGTH: 4,
      SCALE: 0,
      CODEPAGE: 0,
      NULLS: "N",
      DEFAULT_VALUE: null,
      KEYSEQ: 2,
    },
  ],
};
const FOREIGN_KEYS: Record<string, Record<string, unknown>[]> = {
  ORDERS: [{ COLUMN_NAME: "CUSTOMER_ID", REF_SCHEMA: "APP", REF_TABLE: "CUSTOMERS", REF_COLUMN: "ID" }],
  DAILY: [{ COLUMN_NAME: "CUSTOMER_ID", REF_SCHEMA: "APP", REF_TABLE: "CUSTOMERS", REF_COLUMN: "ID" }],
};
const INDEXES: Record<string, Record<string, unknown>[]> = {
  ORDERS: [
    { INDEX_SCHEMA: "APP", INDEX_NAME: "ORDERS_CUSTOMER_IX", UNIQUERULE: "D", COLUMN_NAME: "CUSTOMER_ID" },
    { INDEX_SCHEMA: "APP", INDEX_NAME: "ORDERS_CUSTOMER_IX", UNIQUERULE: "D", COLUMN_NAME: "TOTAL" },
    { INDEX_SCHEMA: "APP", INDEX_NAME: "ORDERS_PK", UNIQUERULE: "P", COLUMN_NAME: "ID" },
  ],
};

const trimmed = (value: unknown) => String(value).trimEnd();
const withName = (name: string, rows: Record<string, unknown>[] = []) =>
  rows.map((row) => ({ OBJECT_NAME: name, ...row }));

function catalogRows(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const [schema] = params;
  if (sql.includes("SYSCAT.SCHEMATA")) {
    return [
      { NAME: "REPORTING", IS_SESSION_DEFAULT: 0 },
      { NAME: "APP", IS_SESSION_DEFAULT: 1 },
    ];
  }
  if (sql.includes("COUNT(*)")) {
    const tables = TABLES.filter((row) => trimmed(row.TABSCHEMA) === schema);
    const byType = (type: string) => tables.filter((row) => row.TYPE === type).length;
    const routines = ROUTINES.filter((row) => row.ROUTINESCHEMA === schema);
    return [
      ...["T", "V", "S", "A"]
        .filter((type) => byType(type) > 0)
        .map((type) => ({ KIND: `TABLES:${type}`, N: byType(type) })),
      { KIND: "SEQUENCES", N: schema === "APP" ? 1 : 0 },
      { KIND: "MODULES", N: schema === "APP" ? 1 : 0 },
      ...["P", "F"]
        .map((type) => ({ KIND: `ROUTINES:${type}`, N: routines.filter((row) => row.ROUTINETYPE === type).length }))
        .filter((row) => row.N > 0),
      { KIND: "TRIGGERS", N: TRIGGERS.filter((row) => row.TRIGSCHEMA === schema).length },
    ];
  }
  // Bulk reads: a target listing, then detail rows restricted to that target.
  if (sql.includes("AS OBJECT_NAME")) {
    const [, type, bound] = params;
    const target = TABLES.filter((row) => trimmed(row.TABSCHEMA) === schema && row.TYPE === type)
      .map((row) => row.TABNAME)
      .sort();
    const limited = typeof bound === "number" ? target.slice(0, bound) : target;
    if (sql.includes("SYSCAT.COLUMNS")) return limited.flatMap((name) => withName(name, COLUMNS[name]));
    if (sql.includes("SYSCAT.REFERENCES")) return limited.flatMap((name) => withName(name, FOREIGN_KEYS[name]));
    if (sql.includes("SYSCAT.INDEXES")) return limited.flatMap((name) => withName(name, INDEXES[name]));
    return limited.map((name) => ({ OBJECT_NAME: name }));
  }
  if (sql.includes("SYSCAT.COLUMNS")) return COLUMNS[String(params[1])] ?? [];
  if (sql.includes("SYSCAT.REFERENCES")) return FOREIGN_KEYS[String(params[1])] ?? [];
  if (sql.includes("SYSCAT.INDEXES")) return INDEXES[String(params[1])] ?? [];
  if (sql.includes("SYSCAT.VIEWS") && sql.includes("TEXT")) {
    const [, name, type] = params;
    const row = TABLES.find((t) => trimmed(t.TABSCHEMA) === schema && t.TABNAME === name && t.TYPE === type);
    return row ? [{ TEXT: VIEW_TEXTS[String(name)] }] : [];
  }
  if (sql.includes("SYSCAT.TABLES")) {
    return TABLES.filter((row) => trimmed(row.TABSCHEMA) === schema && row.TYPE === params[1]).map((row) => ({
      NAME: row.TABNAME,
      STATUS: row.STATUS,
      CARD: row.CARD,
      VALID: row.VALID,
    }));
  }
  if (sql.includes("SYSCAT.SEQUENCES")) return schema === "APP" ? [{ NAME: "ORDER_SEQ" }] : [];
  if (sql.includes("SYSCAT.MODULES")) return schema === "APP" ? [{ NAME: "ORDER_MOD" }] : [];
  if (sql.includes("SYSCAT.ROUTINES")) {
    if (sql.includes("TEXT")) {
      const [, specific, type] = params;
      return ROUTINES.filter(
        (r) => r.ROUTINESCHEMA === schema && r.SPECIFICNAME === specific && r.ROUTINETYPE === type,
      );
    }
    return ROUTINES.filter((row) => row.ROUTINESCHEMA === schema && row.ROUTINETYPE === params[1]).map((row) => ({
      SEGMENT: row.SPECIFICNAME,
      NAME: row.ROUTINENAME,
      VALID: row.VALID,
    }));
  }
  if (sql.includes("SYSCAT.TRIGGERS")) {
    if (sql.includes("TEXT")) {
      // [schema, name] for a trigger hanging off the schema, [schema, table, name] under its table.
      return TRIGGERS.filter((row) =>
        params.length === 3
          ? row.TRIGSCHEMA === schema &&
            row.TABNAME === params[1] &&
            row.TRIGNAME === params[2] &&
            row.TABSCHEMA === schema
          : row.TRIGSCHEMA === schema && row.TRIGNAME === params[1] && row.TABSCHEMA !== schema,
      );
    }
    return TRIGGERS.filter((row) => row.TRIGSCHEMA === schema).map((row) => ({
      NAME: row.TRIGNAME,
      PARENT: row.TABSCHEMA === row.TRIGSCHEMA ? row.TABNAME : null,
      VALID: row.VALID,
    }));
  }
  return [];
}

async function connectedProvider() {
  const provider = new Db2Provider(baseConfig);
  await provider.connect();
  return provider;
}

describe("Db2Provider object declarations", () => {
  const caps = new Db2Provider(baseConfig).getCapabilities();

  test("one container level, the schema", () => {
    expect(caps.containerLevels).toEqual([{ id: "schema", label: "Schema", labelPlural: "Schemas" }]);
  });

  test("declares the nine kinds SYSCAT answers for, in tree order", () => {
    expect(caps.objectKinds?.map((kind) => kind.id)).toEqual([
      "table",
      "view",
      "materialized_query_table",
      "alias",
      "sequence",
      "module",
      "procedure",
      "function",
      "trigger",
    ]);
  });

  test("source is declared exactly where SYSCAT keeps the statement text", () => {
    const withSource = caps.objectKinds?.filter((kind) => kind.hasSource === true).map((kind) => kind.id);
    expect(withSource).toEqual(["view", "materialized_query_table", "procedure", "function", "trigger"]);
    for (const kind of caps.objectKinds ?? []) {
      if (kind.hasSource === true) expect(kind.sourceLanguage).toBe("sql");
      expect(kind.acceptsSourceEdits).toBeUndefined();
    }
  });

  test("a trigger hangs off a table, a module groups routines, and only a table takes row writes", () => {
    const byId = Object.fromEntries((caps.objectKinds ?? []).map((kind) => [kind.id, kind]));
    expect(byId.trigger.attachedTo).toBe("table");
    expect(byId.module.childKinds).toEqual(["procedure", "function"]);
    expect((caps.objectKinds ?? []).filter((kind) => kind.acceptsRowWrites === true).map((kind) => kind.id)).toEqual([
      "table",
    ]);
  });
});

describe("Db2Provider object surface", () => {
  test("conforms against the fixture mirror", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    await assertObjectSurface(provider, {
      containers: [["APP"], ["REPORTING"]],
      kinds: {
        table: 3,
        view: 2,
        materialized_query_table: 1,
        alias: 1,
        sequence: 1,
        module: 1,
        procedure: 1,
        function: 3,
        trigger: 1,
      },
      sampleObject: { path: ["APP", "ORDERS"], kind: "table" },
      absentSource: { path: ["APP", "NO_SUCH_VIEW"], kind: "view" },
    });
    await provider.disconnect();
  });

  test("the second schema answers its own objects, including a trigger on another schema's table", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    expect(await provider.listObjects(["REPORTING"], "table")).toEqual([
      { path: ["REPORTING", "DAILY"], name: "DAILY", kind: "table" },
    ]);
    // Its table is APP.ORDERS, which is not in REPORTING, so there is no row in this schema
    // to nest it under: it hangs off the schema itself.
    expect(await provider.listObjects(["REPORTING"], "trigger")).toEqual([
      { path: ["REPORTING", "ORDERS_AUDIT"], name: "ORDERS_AUDIT", kind: "trigger" },
    ]);
    await provider.disconnect();
  });
});

describe("Db2Provider listContainers", () => {
  test("lists schemas sorted by name, flags the session default, and hides the reserved ones", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    expect(await provider.listContainers()).toEqual([
      { path: ["APP"], name: "APP", level: 0, isSessionDefault: true },
      { path: ["REPORTING"], name: "REPORTING", level: 0, isSessionDefault: false },
    ]);
    const statement = capturedQueries.find((sql) => sql.includes("SYSCAT.SCHEMATA"));
    // Owner type cannot separate them: an implicitly created user schema is OWNER SYSIBM too.
    expect(statement).toContain("NOT LIKE 'SYS%'");
    expect(statement).toContain("RTRIM(SCHEMANAME)");
    await provider.disconnect();
  });

  test("nothing nests under a schema", async () => {
    const provider = await connectedProvider();
    expect(await provider.listContainers(["APP"])).toEqual([]);
    expect(capturedQueries).toHaveLength(0);
    await provider.disconnect();
  });
});

describe("Db2Provider countObjects", () => {
  test("seeds every declared kind at zero and binds the schema", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    const counts = await provider.countObjects(["REPORTING"]);
    expect(counts).toEqual({
      table: { count: 1 },
      view: { count: 0 },
      materialized_query_table: { count: 0 },
      alias: { count: 0 },
      sequence: { count: 0 },
      module: { count: 0 },
      procedure: { count: 0 },
      function: { count: 0 },
      trigger: { count: 1 },
    });
    const index = capturedQueries.findIndex((sql) => sql.includes("COUNT(*)"));
    expect(capturedParams[index]).toEqual(["REPORTING", "REPORTING", "REPORTING", "REPORTING", "REPORTING"]);
    await provider.disconnect();
  });

  test("a refused read reports Db2's own sentence against every kind, never a zero", async () => {
    queryShouldThrowFor = (sql) => sql.includes("COUNT(*)");
    const provider = await connectedProvider();
    const counts = await provider.countObjects(["APP"]);
    expect(Object.keys(counts)).toHaveLength(9);
    for (const count of Object.values(counts)) {
      expect(count).toEqual({ unavailable: "SQL0551N the user does not have the required authorization" });
    }
    await provider.disconnect();
  });

  test("a container path that is not one schema is refused rather than read as empty", async () => {
    const provider = await connectedProvider();
    await expect(provider.countObjects([])).rejects.toThrow(/container path is \[schema\]/);
    await expect(provider.listObjects(["DB", "APP"], "table")).rejects.toThrow(QueryError);
    await provider.disconnect();
  });
});

describe("Db2Provider listObjects", () => {
  test("a table carries a measured row count and the status a reader acts on", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    expect(await provider.listObjects(["APP"], "table")).toEqual([
      { path: ["APP", "CUSTOMERS"], name: "CUSTOMERS", kind: "table", rowCount: 2 },
      // CARD -1 is "RUNSTATS never ran", an absence, so no rowCount at all.
      { path: ["APP", "Mixed Case"], name: "Mixed Case", kind: "table", status: "SET INTEGRITY PENDING" },
      { path: ["APP", "ORDERS"], name: "ORDERS", kind: "table" },
    ]);
    await provider.disconnect();
  });

  test("an invalid view is marked and a valid one is not", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    expect(await provider.listObjects(["APP"], "view")).toEqual([
      { path: ["APP", "ORDER_SUMMARY"], name: "ORDER_SUMMARY", kind: "view" },
      { path: ["APP", "SCRATCH_VIEW"], name: "SCRATCH_VIEW", kind: "view", status: "INVALID" },
    ]);
    await provider.disconnect();
  });

  test("an overloaded function is addressed by its specific name and labelled by its routine name", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    expect(await provider.listObjects(["APP"], "function")).toEqual([
      { path: ["APP", "ORDER_TOTAL_BY_ID"], name: "ORDER_TOTAL", kind: "function" },
      { path: ["APP", "SQL260915014426735"], name: "ORDER_TOTAL", kind: "function" },
      { path: ["APP", "SQL260915014426740"], name: "EXT_FN", kind: "function" },
    ]);
    const statement = capturedQueries.find((sql) => sql.includes("SYSCAT.ROUTINES"));
    // A module's routines belong to the module, and a built-in or system-generated one to nobody.
    expect(statement).toContain("ROUTINEMODULENAME IS NULL");
    await provider.disconnect();
  });

  test("a trigger in its table's schema nests under the table", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    expect(await provider.listObjects(["APP"], "trigger")).toEqual([
      { path: ["APP", "ORDERS", "ORDERS_NOTE_DEFAULT"], name: "ORDERS_NOTE_DEFAULT", kind: "trigger" },
    ]);
    await provider.disconnect();
  });

  test("routine and trigger validity use Db2's codes", async () => {
    mockRowsFor = (sql) => {
      if (sql.includes("SYSCAT.ROUTINES")) return [{ SEGMENT: "P1", NAME: "P1", VALID: "X" }];
      if (sql.includes("SYSCAT.TRIGGERS")) return [{ NAME: "T1", PARENT: null, VALID: "N" }];
      return [];
    };
    const provider = await connectedProvider();
    expect(await provider.listObjects(["APP"], "procedure")).toEqual([
      { path: ["APP", "P1"], name: "P1", kind: "procedure", status: "INOPERATIVE" },
    ]);
    expect(await provider.listObjects(["APP"], "trigger")).toEqual([
      { path: ["APP", "T1"], name: "T1", kind: "trigger", status: "INVALID" },
    ]);
    await provider.disconnect();
  });

  test("sequences, modules and aliases list by name", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    expect(await provider.listObjects(["APP"], "sequence")).toEqual([
      { path: ["APP", "ORDER_SEQ"], name: "ORDER_SEQ", kind: "sequence" },
    ]);
    expect(await provider.listObjects(["APP"], "module")).toEqual([
      { path: ["APP", "ORDER_MOD"], name: "ORDER_MOD", kind: "module" },
    ]);
    expect(await provider.listObjects(["APP"], "alias")).toEqual([
      { path: ["APP", "CLIENTS"], name: "CLIENTS", kind: "alias" },
    ]);
    await provider.disconnect();
  });

  test("a kind Db2 does not declare is refused, not answered empty", async () => {
    const provider = await connectedProvider();
    await expect(provider.listObjects(["APP"], "package")).rejects.toThrow('Db2 declares no object kind "package"');
    expect(capturedQueries).toHaveLength(0);
    await provider.disconnect();
  });

  test("a failed listing is mapped rather than answered empty", async () => {
    queryShouldThrowFor = (sql) => sql.includes("SYSCAT.SEQUENCES");
    const provider = await connectedProvider();
    await expect(provider.listObjects(["APP"], "sequence")).rejects.toThrow(/SQL0551N/);
    await provider.disconnect();
  });
});

describe("Db2Provider describeObject", () => {
  test("columns carry the engine's type with its length, the key, the default and nullability", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    const detail = await provider.describeObject(["APP", "ORDERS"], "table");
    expect(detail).toEqual({
      path: ["APP", "ORDERS"],
      columns: [
        { name: "ID", type: "INTEGER", nullable: false, isPrimary: true },
        { name: "CUSTOMER_ID", type: "INTEGER", nullable: true, isPrimary: false },
        { name: "TOTAL", type: "DECIMAL(12,2)", nullable: true, isPrimary: false, defaultValue: "0" },
        { name: "NOTE", type: "VARCHAR(200)", nullable: true, isPrimary: false },
      ],
      indexes: [
        { name: "ORDERS_CUSTOMER_IX", columns: ["CUSTOMER_ID", "TOTAL"], unique: false },
        { name: "ORDERS_PK", columns: ["ID"], unique: true },
      ],
      foreignKeys: [{ columnName: "CUSTOMER_ID", referencedTable: "CUSTOMERS", referencedColumn: "ID" }],
    });
    // Every read is bound to one schema and one object, and nothing is interpolated.
    for (const [index, sql] of capturedQueries.entries()) {
      if (sql.includes("SYSCAT.")) expect(capturedParams[index]).toEqual(["APP", "ORDERS"]);
    }
    await provider.disconnect();
  });

  test("a foreign key into another schema names that schema", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    const detail = await provider.describeObject(["REPORTING", "DAILY"], "table");
    expect(detail.foreignKeys).toEqual([
      { columnName: "CUSTOMER_ID", referencedTable: "APP.CUSTOMERS", referencedColumn: "ID" },
    ]);
    expect(detail.columns.filter((column) => column.isPrimary).map((column) => column.name)).toEqual([
      "DAY",
      "CUSTOMER_ID",
    ]);
    await provider.disconnect();
  });

  test("the referenced key is joined on its table, because a constraint name is unique per table", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    await provider.describeObject(["APP", "ORDERS"], "table");
    const statement = capturedQueries.find((sql) => sql.includes("SYSCAT.REFERENCES"));
    expect(statement).toContain("pk.TABNAME = r.REFTABNAME");
    await provider.disconnect();
  });

  test("a kind that is not a relation answers empty detail without a round trip", async () => {
    const provider = await connectedProvider();
    expect(await provider.describeObject(["APP", "ORDER_SEQ"], "sequence")).toEqual({
      path: ["APP", "ORDER_SEQ"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(capturedQueries).toHaveLength(0);
    await provider.disconnect();
  });

  test("a path of the wrong shape is refused by name", async () => {
    const provider = await connectedProvider();
    await expect(provider.describeObject(["APP"], "table")).rejects.toThrow(/"table" path is \[schema, name\]/);
    await expect(provider.describeObject(["APP", "T", "X", "Y"], "trigger")).rejects.toThrow(
      /\[schema, table, name\] or \[schema, name\]/,
    );
    await expect(provider.describeObject(["APP", "X"], "nope")).rejects.toThrow('Db2 declares no object kind "nope"');
    await provider.disconnect();
  });
});

describe("Db2Provider describeObjects", () => {
  test("describes a whole kind in four round trips, sorted by path", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    const batch = await provider.describeObjects(["APP"], "table");
    expect(batch.truncated).toBeUndefined();
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["APP", "CUSTOMERS"],
      ["APP", "Mixed Case"],
      ["APP", "ORDERS"],
    ]);
    const single = await new Db2Provider(baseConfig).getCapabilities();
    expect(single.objectKinds).toBeDefined();
    const orders = batch.details.find((detail) => detail.path[1] === "ORDERS");
    expect(orders).toEqual(await provider.describeObject(["APP", "ORDERS"], "table"));
    await provider.disconnect();
  });

  test("a caller's bound reads one row more and reports the truncation in the caller's number", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    const batch = await provider.describeObjects(["APP"], "table", 2);
    expect(batch.details).toHaveLength(2);
    expect(batch.truncated).toEqual({ limit: 2, reason: callerBoundTruncationReason(2) });
    const target = capturedQueries.findIndex((sql) => sql.includes("AS OBJECT_NAME"));
    expect(capturedParams[target]).toEqual(["APP", "T", 3]);
    await provider.disconnect();
  });

  test("an exact bound is not marked truncated", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    const batch = await provider.describeObjects(["APP"], "table", 3);
    expect(batch.details).toHaveLength(3);
    expect(batch.truncated).toBeUndefined();
    await provider.disconnect();
  });

  test("an empty kind costs one round trip and a non-relation none", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    expect(await provider.describeObjects(["REPORTING"], "view")).toEqual({ details: [] });
    expect(capturedQueries).toHaveLength(1);
    expect(await provider.describeObjects(["APP"], "procedure")).toEqual({ details: [] });
    expect(capturedQueries).toHaveLength(1);
    await provider.disconnect();
  });

  test("a bound that is not a positive whole number is refused", async () => {
    const provider = await connectedProvider();
    await expect(provider.describeObjects(["APP"], "table", 0)).rejects.toThrow(/positive whole number/);
    await expect(provider.describeObjects(["APP"], "table", 1.5)).rejects.toThrow(/positive whole number/);
    await expect(provider.describeObjects(["APP"], "nope")).rejects.toThrow('Db2 declares no object kind "nope"');
    await provider.disconnect();
  });
});

describe("Db2Provider readObjectSource", () => {
  test("a view's text is the author's stored statement, complete", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    const document = await provider.readObjectSource!(["APP", "ORDER_SUMMARY"], "view");
    expect(document).toEqual({
      path: ["APP", "ORDER_SUMMARY"],
      kind: "view",
      parts: [
        { id: "definition", label: "Definition", text: VIEW_TEXT, language: "sql", form: "complete", origin: "stored" },
      ],
    });
    const index = capturedQueries.findIndex((sql) => sql.includes("SYSCAT.VIEWS"));
    expect(capturedParams[index]).toEqual(["APP", "ORDER_SUMMARY", "V"]);
    await provider.disconnect();
  });

  test("a view read under the materialized query table kind is an absence", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    await expect(provider.readObjectSource!(["APP", "ORDER_SUMMARY"], "materialized_query_table")).rejects.toThrow(
      'Db2 holds no materialized query table called "ORDER_SUMMARY" in APP',
    );
    await provider.disconnect();
  });

  test("an external routine is a refusal part naming why Db2 has no text", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    const document = await provider.readObjectSource!(["APP", "SQL260915014426740"], "function");
    expect(document.parts).toHaveLength(1);
    const [part] = document.parts;
    expect(isSourcePartUnavailable(part)).toBe(true);
    expect(part).toEqual({
      id: "definition",
      label: "Definition",
      unavailable: expect.stringContaining("EXTERNAL routine") as unknown as string,
    });
    await provider.disconnect();
  });

  test("a sourced routine and one of unknown origin each say which", async () => {
    let origin = "U";
    mockRowsFor = (sql) => (sql.includes("SYSCAT.ROUTINES") ? [{ TEXT: null, ORIGIN: origin }] : []);
    const provider = await connectedProvider();
    const sourced = await provider.readObjectSource!(["APP", "S1"], "function");
    expect(sourced.parts[0]).toMatchObject({ unavailable: expect.stringContaining("SOURCED") });
    origin = "F";
    const federated = await provider.readObjectSource!(["APP", "S1"], "function");
    expect(federated.parts[0]).toMatchObject({ unavailable: expect.stringContaining("FEDERATED") });
    origin = "Z";
    const unknown = await provider.readObjectSource!(["APP", "S1"], "function");
    expect(unknown.parts[0]).toMatchObject({ unavailable: expect.stringContaining("ORIGIN 'Z'") });
    await provider.disconnect();
  });

  test("a procedure and both trigger addresses read their stored text", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    const proc = await provider.readObjectSource!(["APP", "SQL260915014426733"], "procedure");
    expect(proc.parts[0]).toMatchObject({ text: PROC_TEXT });
    const nested = await provider.readObjectSource!(["APP", "ORDERS", "ORDERS_NOTE_DEFAULT"], "trigger");
    expect(nested.parts[0]).toMatchObject({ text: TRIGGER_TEXT });
    const loose = await provider.readObjectSource!(["REPORTING", "ORDERS_AUDIT"], "trigger");
    expect(loose.parts[0]).toMatchObject({ text: AUDIT_TEXT });
    // The same trigger under an address the listing never produced is not found.
    await expect(provider.readObjectSource!(["APP", "ORDERS_NOTE_DEFAULT"], "trigger")).rejects.toThrow(QueryError);
    await provider.disconnect();
  });

  test("a caller's bound truncates the text and says so", async () => {
    mockRowsFor = catalogRows;
    const provider = await connectedProvider();
    const document = await provider.readObjectSource!(["APP", "ORDER_SUMMARY"], "view", 10);
    expect(document.parts[0]).toMatchObject({ text: VIEW_TEXT.slice(0, 10), truncated: { limit: 10 } });
    await provider.disconnect();
  });

  test("an empty text is a refusal and a non-string text raises", async () => {
    let text: unknown = "   ";
    mockRowsFor = (sql) => (sql.includes("SYSCAT.VIEWS") ? [{ TEXT: text }] : []);
    const provider = await connectedProvider();
    const empty = await provider.readObjectSource!(["APP", "V"], "view");
    expect(isSourcePartUnavailable(empty.parts[0])).toBe(true);
    text = Buffer.from("CREATE VIEW");
    await expect(provider.readObjectSource!(["APP", "V"], "view")).rejects.toThrow(/rather than a string/);
    await provider.disconnect();
  });

  test("a kind with no stored text is refused before any round trip", async () => {
    const provider = await connectedProvider();
    await expect(provider.readObjectSource!(["APP", "ORDERS"], "table")).rejects.toThrow(
      'Db2 publishes no definition text for the kind "table"',
    );
    await expect(provider.readObjectSource!(["APP"], "view")).rejects.toThrow(/"view" path is \[schema, name\]/);
    expect(capturedQueries).toHaveLength(0);
    await provider.disconnect();
  });
});

describe("Db2Provider maintenance target quoting", () => {
  test("a quote in the table name cannot end the ADMIN_CMD string literal", async () => {
    const provider = await connectedProvider();
    await provider.runMaintenance("analyze", "O'Brien");
    const statement = capturedQueries.find((sql) => sql.includes("RUNSTATS")) ?? "";
    expect(statement).toContain(`RUNSTATS ON TABLE "O''Brien"`);
    await provider.runMaintenance("optimize", "O'Brien");
    expect(capturedQueries.find((sql) => sql.includes("REORG"))).toContain(`REORG TABLE "O''Brien"`);
    await provider.disconnect();
  });
});

describe("Db2Provider object surface under a changed declaration", () => {
  // The provider reads its own declaration rather than assuming it, so each of these swaps a
  // declaration in and drives the arm only a DECLARATION can reach.
  function withCapabilities(change: (caps: ProviderCapabilities) => ProviderCapabilities) {
    return class extends Db2Provider {
      public override getCapabilities(): ProviderCapabilities {
        return change(super.getCapabilities());
      }
    };
  }

  test("a declaration with no schema level is refused by name rather than bound as undefined", async () => {
    const Provider = withCapabilities((caps) => ({
      ...caps,
      containerLevels: [{ id: "catalog", label: "Database", labelPlural: "Databases" }],
    }));
    const provider = new Provider(baseConfig);
    await provider.connect();
    await expect(provider.countObjects(["TESTDB"])).rejects.toThrow(/needs a "schema" container level/);
    expect(capturedQueries).toHaveLength(0);
    await provider.disconnect();
  });

  test("a declared kind with no listing statement says so", async () => {
    const Provider = withCapabilities((caps) => ({
      ...caps,
      objectKinds: [
        ...(caps.objectKinds ?? []),
        { id: "nickname", role: "relation", label: "Nickname", labelPlural: "Nicknames" },
      ],
    }));
    const provider = new Provider(baseConfig);
    await provider.connect();
    await expect(provider.listObjects(["APP"], "nickname")).rejects.toThrow(
      'Db2 declares the kind "nickname" but has no statement that lists it',
    );
    await provider.disconnect();
  });

  test("a kind given source with no statement to read it says so", async () => {
    const Provider = withCapabilities((caps) => ({
      ...caps,
      objectKinds: (caps.objectKinds ?? []).map((kind) =>
        kind.id === "sequence" ? { ...kind, hasSource: true, sourceLanguage: "sql" } : kind,
      ),
    }));
    const provider = new Provider(baseConfig);
    await provider.connect();
    await expect(provider.readObjectSource(["APP", "ORDER_SEQ"], "sequence")).rejects.toThrow(
      'Db2 declares readable source for the kind "sequence" but has no statement that reads it',
    );
    await provider.disconnect();
  });
});
