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
  test("health reports the unavailable cache-ratio sentinel, never a fabricated 0", async () => {
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const health = await provider.getHealth();
    expect(health.cacheHitRatio).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions).toEqual([]);
    await provider.disconnect();
  });

  test("performance metrics are an empty object so an absent cache ratio reads as healthy", async () => {
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
    expect(overview.databaseSize).toBe("N/A");
    expect(overview.maxConnections).toBe(0);
    await provider.disconnect();
  });

  test("getOverview leaves the neutral version when the permission-gated read is denied", async () => {
    queryShouldThrowFor = (sql) => sql.includes("ENV_GET_INST_INFO");
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    const overview = await provider.getOverview();
    // The denied read is swallowed rather than failing the whole overview.
    expect(overview.version).toBe("Unknown");
    await provider.disconnect();
  });

  test("the remaining monitoring panels return neutral empties rather than throwing", async () => {
    const provider = new Db2Provider(baseConfig);
    await provider.connect();
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    await provider.disconnect();
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
