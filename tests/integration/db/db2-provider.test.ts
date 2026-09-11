import { describe, test, expect, beforeEach, mock } from "bun:test";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { maintenanceControl } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";

// ---------------------------------------------------------------------------
// Mock ibm_db BEFORE loading the provider.
//
// The driver's high-level surface is `open(connStr, cb) -> conn`, and the connection
// answers `query(sql, cb)` with an array of row objects and `close(cb)`. The provider
// declares that slice locally (its published typings do not describe a promise API), so
// the mock only has to honour those three calls. `mockRowsFor` lets a test decide what a
// given SQL string returns, which is how getSchema is exercised without a live server.
// ---------------------------------------------------------------------------

let mockRowsFor: (sql: string) => Record<string, unknown>[];
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
    cb(null, mockRowsFor(sql));
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

describe("Db2Provider getSchema", () => {
  test("assembles tables with columns, primary keys, foreign keys and indexes", async () => {
    mockRowsFor = (sql) => {
      if (sql.includes("SYSCAT.TABLES")) return [{ TABNAME: "USERS", ROW_COUNT: 42 }];
      if (sql.includes("SYSCAT.COLUMNS")) {
        return [
          { TABNAME: "USERS", COLNAME: "ID", TYPENAME: "INTEGER", NULLS: "N", DEFAULT: null, COLNO: 0 },
          { TABNAME: "USERS", COLNAME: "EMAIL", TYPENAME: "VARCHAR", NULLS: "Y", DEFAULT: null, COLNO: 1 },
        ];
      }
      if (sql.includes("TABCONST")) return [{ TABNAME: "USERS", COLNAME: "ID" }];
      if (sql.includes("SYSCAT.REFERENCES")) {
        return [{ TABNAME: "USERS", COLNAME: "ORG_ID", REF_TABLE: "ORGS", REF_COLUMN: "ID" }];
      }
      if (sql.includes("SYSCAT.INDEXES")) {
        return [{ INDNAME: "PK_USERS", TABNAME: "USERS", UNIQUERULE: "P", COLNAME: "ID", COLSEQ: 1 }];
      }
      return [];
    };

    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();

    expect(schema).toHaveLength(1);
    const users = schema[0];
    expect(users.name).toBe("USERS");
    expect(users.rowCount).toBe(42);
    expect(users.columns.map((c) => c.name)).toEqual(["ID", "EMAIL"]);
    // Type lowercased to match the schema tree's spelling convention.
    expect(users.columns[0]).toMatchObject({ name: "ID", type: "integer", nullable: false, isPrimary: true });
    expect(users.columns[1]).toMatchObject({ name: "EMAIL", type: "varchar", nullable: true, isPrimary: false });
    expect(users.foreignKeys).toEqual([{ columnName: "ORG_ID", referencedTable: "ORGS", referencedColumn: "ID" }]);
    expect(users.indexes).toEqual([{ name: "PK_USERS", columns: ["ID"], unique: true }]);
  });

  test("omits rowCount when the catalog cardinality is the -1 never-collected sentinel", async () => {
    mockRowsFor = (sql) => (sql.includes("SYSCAT.TABLES") ? [{ TABNAME: "T", ROW_COUNT: -1 }] : []);
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();
    expect(schema[0].rowCount).toBeUndefined();
  });
});

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
