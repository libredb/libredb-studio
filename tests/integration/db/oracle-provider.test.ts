import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type oracledb from "oracledb";
import { ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import { asBytes } from "@/lib/export/binary";

// ---------------------------------------------------------------------------
// Mock oracledb BEFORE loading the provider
// ---------------------------------------------------------------------------

let mockExecuteFn: (sql: string, params?: unknown[], opts?: unknown) => Promise<unknown>;
let mockConnCloseFn: () => Promise<void>;
let mockBreakFn: () => Promise<void>;
let mockPoolCloseFn: () => Promise<void>;
let mockCreatePoolFn: () => Promise<unknown>;
const mockInitOracleClientFn = mock((_opts?: Record<string, unknown>) => undefined);
// The attributes `createPool` received. The connect string and the TLS attributes are
// observable nowhere else: the pool is where they are stated and it exposes neither.
let lastPoolAttrs: Record<string, unknown> = {};

// The options the last execute() received. `fetchTypeHandler` is observable
// nowhere else: it is a per-call option and the provider keeps no copy.
let lastExecuteOpts: Record<string, unknown> = {};

const createMockConnection = () => ({
  execute: (sql: string, params?: unknown[], opts?: unknown) => {
    lastExecuteOpts = (opts ?? {}) as Record<string, unknown>;
    return mockExecuteFn(sql, params, opts);
  },
  close: () => mockConnCloseFn(),
  break: () => mockBreakFn(),
  commit: async () => {},
  rollback: async () => {},
});

const createMockPool = () => ({
  getConnection: async () => createMockConnection(),
  close: () => mockPoolCloseFn(),
  connectionsOpen: 5,
  connectionsInUse: 2,
});

// The type constants a fetch-type handler is written against. They were absent
// until 2026-08-24: the mock answered every column with a plain JS value, so no test
// could produce the `Lob` stream object oracledb really returns for a CLOB,
// NCLOB or BLOB - which is exactly why nothing caught that a LOB cell reached
// the product as an unserialisable stream. The numbers are the identities that
// matter here, not oracledb's own values: the provider only ever compares a
// column's `dbType` against these same references.
//
// They are typed as the driver's own `DbType` (src/types/db-drivers.d.ts): oracledb
// 6.10.0 ships no declarations at all - no `types` field, no `.d.ts` anywhere in the
// package - so that hand-written declaration is what the provider is checked against,
// and typing the mock against the same names is what keeps the two from drifting.
const DB_TYPE_CLOB: oracledb.DbType = { num: 112, name: "DB_TYPE_CLOB" };
const DB_TYPE_NCLOB: oracledb.DbType = { num: 1112, name: "DB_TYPE_NCLOB" };
const DB_TYPE_BLOB: oracledb.DbType = { num: 113, name: "DB_TYPE_BLOB" };
const DB_TYPE_VARCHAR: oracledb.DbType = { num: 1, name: "DB_TYPE_VARCHAR" };
const DB_TYPE_RAW: oracledb.DbType = { num: 23, name: "DB_TYPE_RAW" };
// The two INTERVAL identities, as the driver numbers them (measured: 2016 and 2015).
const DB_TYPE_INTERVAL_YM: oracledb.DbType = { num: 2016, name: "DB_TYPE_INTERVAL_YM" };
const DB_TYPE_INTERVAL_DS: oracledb.DbType = { num: 2015, name: "DB_TYPE_INTERVAL_DS" };
const STRING = 2001;
const BUFFER = 2005;

mock.module("oracledb", () => {
  const oracledbMock = {
    OUT_FORMAT_OBJECT: 4002,
    DB_TYPE_CLOB,
    DB_TYPE_NCLOB,
    DB_TYPE_BLOB,
    DB_TYPE_VARCHAR,
    DB_TYPE_RAW,
    DB_TYPE_INTERVAL_YM,
    DB_TYPE_INTERVAL_DS,
    STRING,
    BUFFER,
    initOracleClient: mockInitOracleClientFn,
    outFormat: 0,
    autoCommit: false,
    createPool: (attrs: Record<string, unknown>) => {
      lastPoolAttrs = attrs;
      return mockCreatePoolFn();
    },
  };
  return { default: oracledbMock };
});

// Load the provider via dynamic import AFTER the mock is registered. A static
// import is hoisted above mock.module(), which evaluates the real oracledb
// driver first and drops oracle.ts from bun's lcov attribution entirely.
const { OracleProvider } = await import("@/lib/db/providers/sql/oracle");

// ---------------------------------------------------------------------------
// Default mock execute implementation
// ---------------------------------------------------------------------------

function defaultExecute(sql: string) {
  const upper = sql.toUpperCase();

  // V$VERSION (for getOverview version)
  if (upper.includes("V$VERSION") && upper.includes("BANNER")) {
    return {
      rows: [{ BANNER: "Oracle Database 19c Enterprise Edition Release 19.0.0.0.0" }],
      metaData: [{ name: "BANNER" }],
    };
  }

  // V$INSTANCE (for getOverview uptime)
  if (upper.includes("V$INSTANCE") && upper.includes("STARTUP_TIME")) {
    return {
      rows: [{ STARTUP_TIME: new Date(Date.now() - 86400 * 1000).toISOString(), UPTIME_SECS: 86400 }],
      metaData: [{ name: "STARTUP_TIME" }, { name: "UPTIME_SECS" }],
    };
  }

  // V$PARAMETER (for max sessions)
  if (upper.includes("V$PARAMETER") && upper.includes("SESSIONS")) {
    return {
      rows: [{ VALUE: 250 }],
      metaData: [{ name: "VALUE" }],
    };
  }

  // V$SESSION with COUNT (for getOverview connections and getHealth active connections)
  if (upper.includes("V$SESSION") && upper.includes("COUNT")) {
    return {
      rows: [{ CNT: 8 }],
      metaData: [{ name: "CNT" }],
    };
  }

  // V$SESSION active sessions detail (for getActiveSessions — has SID, SERIAL#, SQL_TEXT)
  if (upper.includes("V$SESSION") && upper.includes("SERIAL#")) {
    return {
      rows: [
        {
          SID: 101,
          "SERIAL#": 5432,
          USERNAME: "TEST_USER",
          SCHEMANAME: "TESTSCHEMA",
          PROGRAM: "sqlplus.exe",
          MACHINE: "WORKSTATION1",
          STATUS: "ACTIVE",
          SQL_ID: "abc123",
          QUERY: "SELECT * FROM USERS",
          LOGON_TIME: new Date(Date.now() - 300000).toISOString(),
          DURATION_SECS: 300,
          WAIT_CLASS: "CPU",
          EVENT: "CPU + wait for CPU",
        },
      ],
      metaData: [{ name: "SID" }, { name: "SERIAL#" }, { name: "USERNAME" }],
    };
  }

  // V$SESSION (fallback for getHealth active sessions)
  if (upper.includes("V$SESSION")) {
    return {
      rows: [
        {
          CNT: 8,
          SID: 101,
          USERNAME: "TEST_USER",
          STATUS: "ACTIVE",
          QUERY: "sel1",
          DATABASE: "ORCL",
          DURATION: "00:01:23",
        },
      ],
      metaData: [{ name: "CNT" }, { name: "SID" }],
    };
  }

  // USER_SEGMENTS size (for getHealth and getOverview)
  if (upper.includes("USER_SEGMENTS") && upper.includes("SUM(BYTES)") && upper.includes("TOTAL")) {
    return {
      rows: [{ TOTAL: 268435456 }],
      metaData: [{ name: "TOTAL" }],
    };
  }

  if (upper.includes("USER_SEGMENTS") && upper.includes("TABLESPACE_NAME")) {
    return {
      rows: [
        { NAME: "USERS", SIZE_BYTES: 134217728 },
        { NAME: "SYSTEM", SIZE_BYTES: 67108864 },
      ],
      metaData: [{ name: "NAME" }, { name: "SIZE_BYTES" }],
    };
  }

  if (upper.includes("USER_SEGMENTS")) {
    return {
      rows: [{ SIZE_MB: 256, TOTAL: 268435456 }],
      metaData: [{ name: "SIZE_MB" }],
    };
  }

  // USER_TABLES / USER_INDEXES counts (for getOverview)
  if (upper.includes("USER_TABLES") && upper.includes("TABLE_COUNT") && upper.includes("USER_INDEXES")) {
    return {
      rows: [{ TABLE_COUNT: 10, INDEX_COUNT: 15 }],
      metaData: [{ name: "TABLE_COUNT" }, { name: "INDEX_COUNT" }],
    };
  }

  if (upper.includes("V$SYSSTAT")) {
    return {
      rows: [{ HIT_RATIO: 97.5 }],
      metaData: [{ name: "HIT_RATIO" }],
    };
  }

  // V$SQL detail (for getSlowQueries — has SQL_ID, SUBSTR)
  if (upper.includes("V$SQL") && upper.includes("SQL_ID") && upper.includes("TOTAL_TIME")) {
    return {
      rows: [
        {
          QUERY_ID: "sql_abc123",
          QUERY: "SELECT * FROM big_table WHERE status = 1",
          CALLS: 42,
          TOTAL_TIME: 6300,
          AVG_TIME: 150,
          ROW_CNT: 1000,
          BUF_GETS: 500,
          DISK_READS: 20,
        },
      ],
      metaData: [{ name: "QUERY_ID" }, { name: "QUERY" }, { name: "CALLS" }],
    };
  }

  if (upper.includes("V$SQL")) {
    return {
      rows: [
        {
          QUERY: "SELECT * FROM big_table",
          CALLS: 42,
          AVGTIME: "150ms",
          QUERY_ID: "abc",
          TOTAL_TIME: 6300,
          AVG_TIME: 150,
          ROW_CNT: 1000,
          BUF_GETS: 500,
          DISK_READS: 20,
        },
      ],
      metaData: [{ name: "QUERY" }, { name: "CALLS" }, { name: "AVGTIME" }],
    };
  }

  // ALL_TABLES with table stats (for getTableStats — has USER_SEGMENTS join)
  if (upper.includes("ALL_TABLES") && upper.includes("TABLE_SIZE_BYTES") && upper.includes("INDEX_SIZE_BYTES")) {
    return {
      rows: [
        {
          TABLE_NAME: "USERS",
          ROW_COUNT: 100,
          TABLE_SIZE_BYTES: 65536,
          INDEX_SIZE_BYTES: 16384,
          LAST_ANALYZED: "2026-02-14T00:00:00Z",
        },
        {
          TABLE_NAME: "ORDERS",
          ROW_COUNT: 500,
          TABLE_SIZE_BYTES: 131072,
          INDEX_SIZE_BYTES: 32768,
          LAST_ANALYZED: "2026-02-14T00:00:00Z",
        },
      ],
      metaData: [{ name: "TABLE_NAME" }, { name: "ROW_COUNT" }],
    };
  }

  if (upper.includes("ALL_TABLES")) {
    return {
      rows: [
        { TABLE_NAME: "USERS", NUM_ROWS: 100 },
        { TABLE_NAME: "ORDERS", NUM_ROWS: 500 },
      ],
      metaData: [{ name: "TABLE_NAME" }, { name: "NUM_ROWS" }],
    };
  }

  if (upper.includes("ALL_TAB_COLUMNS")) {
    return {
      rows: [
        {
          TABLE_NAME: "USERS",
          COLUMN_NAME: "ID",
          DATA_TYPE: "NUMBER",
          NULLABLE: "N",
          DATA_DEFAULT: null,
          COLUMN_ID: 1,
        },
        {
          TABLE_NAME: "USERS",
          COLUMN_NAME: "NAME",
          DATA_TYPE: "VARCHAR2",
          NULLABLE: "Y",
          DATA_DEFAULT: null,
          COLUMN_ID: 2,
        },
        {
          TABLE_NAME: "ORDERS",
          COLUMN_NAME: "ID",
          DATA_TYPE: "NUMBER",
          NULLABLE: "N",
          DATA_DEFAULT: null,
          COLUMN_ID: 1,
        },
      ],
      metaData: [{ name: "TABLE_NAME" }, { name: "COLUMN_NAME" }],
    };
  }

  if (upper.includes("ALL_CONSTRAINTS") && upper.includes("'P'")) {
    return {
      rows: [{ TABLE_NAME: "USERS", COLUMN_NAME: "ID" }],
      metaData: [{ name: "TABLE_NAME" }, { name: "COLUMN_NAME" }],
    };
  }

  if (upper.includes("ALL_CONSTRAINTS") && upper.includes("'R'")) {
    return {
      rows: [{ TABLE_NAME: "ORDERS", COLUMN_NAME: "USER_ID", REF_TABLE: "USERS", REF_COLUMN: "ID" }],
      metaData: [{ name: "TABLE_NAME" }, { name: "COLUMN_NAME" }, { name: "REF_TABLE" }, { name: "REF_COLUMN" }],
    };
  }

  // Index stats (for getIndexStats — has INDEX_SIZE_BYTES)
  if (upper.includes("ALL_INDEXES") && upper.includes("INDEX_SIZE_BYTES")) {
    return {
      rows: [
        {
          TABLE_NAME: "USERS",
          INDEX_NAME: "IDX_USERS_PK",
          INDEX_TYPE: "NORMAL",
          UNIQUENESS: "UNIQUE",
          INDEX_SIZE_BYTES: 16384,
          LEAF_BLOCKS: 10,
          DISTINCT_KEYS: 100,
        },
        {
          TABLE_NAME: "USERS",
          INDEX_NAME: "IDX_USERS_NAME",
          INDEX_TYPE: "NORMAL",
          UNIQUENESS: "NONUNIQUE",
          INDEX_SIZE_BYTES: 8192,
          LEAF_BLOCKS: 5,
          DISTINCT_KEYS: 95,
        },
      ],
      metaData: [{ name: "TABLE_NAME" }, { name: "INDEX_NAME" }],
    };
  }

  // ALL_IND_COLUMNS for index columns (for getIndexStats second query)
  if (upper.includes("ALL_IND_COLUMNS") && upper.includes("COLUMN_POSITION") && !upper.includes("ALL_INDEXES")) {
    return {
      rows: [
        { INDEX_NAME: "IDX_USERS_PK", COLUMN_NAME: "ID", COLUMN_POSITION: 1 },
        { INDEX_NAME: "IDX_USERS_NAME", COLUMN_NAME: "NAME", COLUMN_POSITION: 1 },
      ],
      metaData: [{ name: "INDEX_NAME" }, { name: "COLUMN_NAME" }],
    };
  }

  if (upper.includes("ALL_INDEXES") || upper.includes("ALL_IND_COLUMNS")) {
    return {
      rows: [
        {
          TABLE_NAME: "USERS",
          INDEX_NAME: "IDX_USERS_NAME",
          UNIQUENESS: "NONUNIQUE",
          COLUMN_NAME: "NAME",
          COLUMN_POSITION: 1,
        },
      ],
      metaData: [{ name: "TABLE_NAME" }, { name: "INDEX_NAME" }],
    };
  }

  if (upper.includes("DBMS_STATS") || upper.includes("ALTER INDEX") || upper.includes("ALTER SYSTEM KILL")) {
    return { rows: [], metaData: [] };
  }

  if (upper.includes("USER_INDEXES")) {
    return {
      rows: [{ INDEX_NAME: "IDX_USERS_NAME" }],
      metaData: [{ name: "INDEX_NAME" }],
    };
  }

  // DBA_DATA_FILES (for getStorageStats — tablespace info)
  if (upper.includes("DBA_DATA_FILES")) {
    return {
      rows: [
        { NAME: "SYSTEM", SIZE_BYTES: 536870912 },
        { NAME: "USERS", SIZE_BYTES: 268435456 },
      ],
      metaData: [{ name: "NAME" }, { name: "SIZE_BYTES" }],
    };
  }

  // Default
  return {
    rows: [{ ID: 1, NAME: "test" }],
    metaData: [{ name: "ID" }, { name: "NAME" }],
  };
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const baseConfig: DatabaseConnection = {
  id: "test-oracle",
  name: "Test Oracle",
  type: "oracle",
  host: "localhost",
  port: 1521,
  serviceName: "ORCL",
  user: "TEST_USER",
  password: "test",
  createdAt: new Date(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OracleProvider", () => {
  let provider: InstanceType<typeof OracleProvider>;

  beforeEach(() => {
    mockExecuteFn = async (sql: string) => defaultExecute(sql);
    mockConnCloseFn = async () => {};
    mockBreakFn = async () => {};
    mockPoolCloseFn = async () => {};
    mockCreatePoolFn = async () => createMockPool();
    provider = new OracleProvider(baseConfig);
  });

  afterEach(async () => {
    try {
      await provider.disconnect();
    } catch {
      /* ignore */
    }
  });

  // =========================================================================
  // 1. Validation
  // =========================================================================

  describe("validation", () => {
    test("throws DatabaseConfigError when host is missing and no connectionString", () => {
      expect(() => {
        new OracleProvider({
          ...baseConfig,
          host: undefined,
          connectionString: undefined,
        } as unknown as DatabaseConnection);
      }).toThrow(DatabaseConfigError);
    });

    test("succeeds when connectionString is provided without host", () => {
      expect(() => {
        new OracleProvider({
          ...baseConfig,
          host: undefined,
          connectionString: "localhost:1521/ORCL",
        } as unknown as DatabaseConnection);
      }).not.toThrow();
    });
  });

  // =========================================================================
  // 1a. TLS
  // =========================================================================

  describe("the TLS attributes handed to createPool", () => {
    const connectWithSSL = async (ssl: DatabaseConnection["ssl"], extra: Partial<DatabaseConnection> = {}) => {
      provider = new OracleProvider({ ...baseConfig, ...extra, ssl });
      await provider.connect();
      return lastPoolAttrs;
    };

    test("stays on plain TCP when the connection names no SSL config", async () => {
      await provider.connect();
      expect(lastPoolAttrs.connectString).toBe("localhost:1521/ORCL");
      expect("walletContent" in lastPoolAttrs).toBe(false);
      expect("sslServerDNMatch" in lastPoolAttrs).toBe(false);
    });

    test("stays on plain TCP in mode disable", async () => {
      const attrs = await connectWithSSL({ mode: "disable" });
      expect(attrs.connectString).toBe("localhost:1521/ORCL");
      expect("sslServerDNMatch" in attrs).toBe(false);
    });

    test("mode require switches the protocol to TCPS and asks for no DN match", async () => {
      const attrs = await connectWithSSL({ mode: "require" });
      expect(attrs.connectString).toBe("tcps://localhost:1521/ORCL");
      expect(attrs.sslServerDNMatch).toBe(false);
    });

    // D26: Thin mode verifies the chain in every TCPS connection, so what verify-system adds
    // over `require` is the server-name match - the one check Oracle exposes on its own. With
    // no walletContent, tls.connect falls back to Node's bundled roots, which is precisely
    // what "verify against the system trust store" means.
    test("mode verify-system asks for the DN/hostname match with no wallet", async () => {
      const attrs = await connectWithSSL({ mode: "verify-system" });
      expect(attrs.connectString).toBe("tcps://localhost:1521/ORCL");
      expect(attrs.sslServerDNMatch).toBe(true);
      expect("walletContent" in attrs).toBe(false);
    });

    test("verify-ca checks the chain without the hostname; verify-full asks for both", async () => {
      // Thin mode always calls tls.connect with rejectUnauthorized: true, so the chain
      // is checked in every TCPS mode and the DN/hostname match is the only knob.
      expect(await connectWithSSL({ mode: "verify-ca" })).toMatchObject({
        connectString: "tcps://localhost:1521/ORCL",
        sslServerDNMatch: false,
      });
      expect(await connectWithSSL({ mode: "verify-full" })).toMatchObject({
        connectString: "tcps://localhost:1521/ORCL",
        sslServerDNMatch: true,
      });
    });

    test("the CA and client certificate bundle reaches the driver as one walletContent PEM", async () => {
      const attrs = await connectWithSSL({
        mode: "verify-full",
        caCert: "-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----",
        clientCert: "-----BEGIN CERTIFICATE-----client-----END CERTIFICATE-----",
        // Deliberately not a PEM header: `-----BEGIN PRIVATE KEY-----` alone, with no material
        // after it, is enough for gitleaks' `private-key` rule, so the realistic string fails the
        // Secret Scan gate for a secret that does not exist (the same reason
        // tests/unit/db/cassandra/wire.test.ts uses this literal). These assertions are about which
        // option name carries the value, not what the value looks like.
        clientKey: "client-key-pem",
      });
      expect(attrs.walletContent).toBe(
        "-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----\n" +
          "-----BEGIN CERTIFICATE-----client-----END CERTIFICATE-----\n" +
          "client-key-pem",
      );
    });

    test("a pasted connect string keeps its own protocol, and still gets the wallet", async () => {
      // Rewriting the string the user typed would drop what only they know (a full TNS
      // descriptor, a wallet_location, an SDU), so the protocol in it is the answer.
      // The wallet and the DN-match flag are separate pool attributes and still apply.
      const attrs = await connectWithSSL(
        { mode: "verify-full", caCert: "-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----" },
        { connectionString: "tcps://prod.example.net:2484/PDB1" },
      );
      expect(attrs.connectString).toBe("tcps://prod.example.net:2484/PDB1");
      expect(attrs.walletContent).toBe("-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----");
      expect(attrs.sslServerDNMatch).toBe(true);
    });
  });

  // =========================================================================
  // 2. Connect / Disconnect
  // =========================================================================

  describe("connect / disconnect", () => {
    test("connect creates pool and marks connected", async () => {
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("disconnect closes pool and marks disconnected", async () => {
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });

    test("double connect is idempotent", async () => {
      await provider.connect();
      await provider.connect(); // should not throw
      expect(provider.isConnected()).toBe(true);
    });

    test("connect wraps pool creation failure in ConnectionError", async () => {
      mockCreatePoolFn = async () => {
        throw new Error("ORA-12154: TNS:could not resolve the connect identifier");
      };

      await expect(provider.connect()).rejects.toThrow(ConnectionError);
      expect(provider.isConnected()).toBe(false);
    });

    test("connect wraps NJS-138 (pre-12.1 server) as a non-retryable DatabaseConfigError, not ConnectionError", async () => {
      mockCreatePoolFn = async () => {
        throw new Error(
          "NJS-138: connections to this database server version are not supported by node-oracledb in Thin mode",
        );
      };

      let caught: unknown;
      try {
        await provider.connect();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DatabaseConfigError);
      expect(caught).not.toBeInstanceOf(ConnectionError);
      expect((caught as Error).message).toContain("ORACLE_CLIENT_LIB_DIR");
      expect(provider.isConnected()).toBe(false);
    });

    test("connect uses connectionString when provided", async () => {
      const p = new OracleProvider({
        ...baseConfig,
        host: undefined,
        connectionString: "dbhost:1521/ORCLPDB1",
      } as unknown as DatabaseConnection);

      await p.connect();
      expect(p.isConnected()).toBe(true);
      await p.disconnect();
    });

    test("disconnect swallows pool close errors", async () => {
      await provider.connect();
      mockPoolCloseFn = async () => {
        throw new Error("connections still in use");
      };

      await provider.disconnect(); // should not throw
      expect(provider.isConnected()).toBe(false);
    });
  });

  // =========================================================================
  // 3. query()
  // =========================================================================

  describe("query()", () => {
    test("returns rows and fields from metaData", async () => {
      await provider.connect();
      const result = await provider.query("SELECT * FROM DUAL");
      expect(result.rows).toBeArray();
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.fields).toContain("ID");
      expect(result.fields).toContain("NAME");
      expect(result.rowCount).toBe(result.rows.length);
      expect(typeof result.executionTime).toBe("number");
    });

    // oracledb answers a non-SELECT with no `rows` array at all and its own
    // `rowsAffected`; the envelope used to be built from `rows.length`, so every
    // INSERT, UPDATE and DELETE reported 0 for work it had done. Measured through
    // `createDatabaseProvider({type:"oracle"})` against Oracle AI Database 26ai Free on
    // 2026-08-24 (rowsAffected 1 / 3 / 4 / 0 for the shapes below), with an
    // interleaved SELECT proving each statement had landed.
    test("reports the driver's rowsAffected for an INSERT", async () => {
      await provider.connect();
      mockExecuteFn = async () => ({ rowsAffected: 1 });

      const result = await provider.query("INSERT INTO r5_types VALUES (1)");
      expect(result.rowCount).toBe(1);
      expect(result.rows).toEqual([]);
      expect(result.fields).toEqual([]);
      expect(result.columnTypes).toBeUndefined();
    });

    test("reports the driver's rowsAffected for a multi-row INSERT ... SELECT", async () => {
      await provider.connect();
      mockExecuteFn = async () => ({ rowsAffected: 3 });

      const result = await provider.query("INSERT INTO r5_types SELECT * FROM src");
      expect(result.rowCount).toBe(3);
    });

    test("reports the driver's rowsAffected for an UPDATE", async () => {
      await provider.connect();
      mockExecuteFn = async () => ({ rowsAffected: 4 });

      const result = await provider.query("UPDATE r5_types SET note = 'z'");
      expect(result.rowCount).toBe(4);
    });

    test("reports 0 for a DELETE that matched nothing", async () => {
      await provider.connect();
      mockExecuteFn = async () => ({ rowsAffected: 0 });

      const result = await provider.query("DELETE FROM r5_types WHERE id = 4242");
      expect(result.rowCount).toBe(0);
    });

    // A PL/SQL block and DDL both leave `rowsAffected` unset or 0 on the wire
    // (measured: `BEGIN NULL; END;` -> undefined, CREATE TABLE / TRUNCATE -> 0), so
    // the envelope has to say 0 rather than NaN or undefined.
    test("reports 0 when the driver states no rowsAffected at all", async () => {
      await provider.connect();
      mockExecuteFn = async () => ({});

      const result = await provider.query("BEGIN NULL; END;");
      expect(result.rowCount).toBe(0);
      expect(result.rows).toEqual([]);
    });

    // An empty SELECT still carries a `rows` array, which is what separates it from
    // a DML answer - it must stay on the rows path and keep its column names.
    test("an empty SELECT keeps its fields and reports 0", async () => {
      await provider.connect();
      mockExecuteFn = async () => ({ rows: [], metaData: [{ name: "ID" }] });

      const result = await provider.query("SELECT id FROM r5_types WHERE 1 = 0");
      expect(result.rowCount).toBe(0);
      expect(result.fields).toEqual(["ID"]);
    });

    test("ignores connection close errors after execution", async () => {
      await provider.connect();
      mockConnCloseFn = async () => {
        throw new Error("close failed");
      };

      const result = await provider.query("SELECT * FROM DUAL");
      expect(result.rows.length).toBeGreaterThan(0);
    });

    // LOB columns. Without a fetch type handler oracledb answers a CLOB, an
    // NCLOB and a BLOB with a `Lob` stream object, and the row cannot be
    // serialised at all - measured on 2026-08-24 through
    // `createDatabaseProvider({type:"oracle"})` against Oracle AI Database 26ai Free with
    // oracledb 6.10.0 Thin: every one of the four LOB columns of `r6_lob` came
    // back with `constructor.name === "Lob"`, and `JSON.stringify` of the row
    // threw `TypeError: Converting circular structure to JSON ... starting at
    // object with constructor 'NVPair'` under Node 24.14.0 and
    // `TypeError: JSON.stringify cannot serialize cyclic structures` under Bun
    // 1.3.14. So `NextResponse.json` in `POST /api/db/query` could not answer at
    // all: the whole SELECT failed, not just the cell.
    describe("LOB columns", () => {
      function handler(): (meta: { dbType: unknown; name: string }) => unknown {
        return lastExecuteOpts.fetchTypeHandler as (meta: { dbType: unknown; name: string }) => unknown;
      }

      test("query() hands the driver a fetch type handler", async () => {
        await provider.connect();
        await provider.query("SELECT c, b FROM r6_lob");
        expect(typeof lastExecuteOpts.fetchTypeHandler).toBe("function");
      });

      test("a CLOB and an NCLOB are fetched as a string", async () => {
        await provider.connect();
        await provider.query("SELECT c, nc FROM r6_lob");
        expect(handler()({ dbType: DB_TYPE_CLOB, name: "C" })).toEqual({ type: STRING });
        expect(handler()({ dbType: DB_TYPE_NCLOB, name: "NC" })).toEqual({ type: STRING });
      });

      test("a BLOB is fetched as a Buffer", async () => {
        await provider.connect();
        await provider.query("SELECT b FROM r6_lob");
        expect(handler()({ dbType: DB_TYPE_BLOB, name: "B" })).toEqual({ type: BUFFER });
      });

      // Every other column keeps the driver's own default. A handler that returned
      // a type for a non-LOB column would silently restate types the product never
      // asked it to touch - RAW already arrives as a Buffer, VARCHAR2 as a string.
      test("no other column type is redirected", async () => {
        await provider.connect();
        await provider.query("SELECT name, r FROM r6_lob");
        expect(handler()({ dbType: DB_TYPE_VARCHAR, name: "NAME" })).toBeUndefined();
        expect(handler()({ dbType: DB_TYPE_RAW, name: "R" })).toBeUndefined();
      });

      test("queryInTransaction() hands the driver the same handler", async () => {
        await provider.connect();
        await provider.beginTransaction();
        await provider.queryInTransaction("SELECT c FROM r6_lob");
        expect(handler()({ dbType: DB_TYPE_CLOB, name: "C" })).toEqual({ type: STRING });
        await provider.rollbackTransaction();
      });

      // The handler is deliberately per-call rather than the process-wide
      // `oracledb.fetchAsString` / `fetchAsBuffer` globals, so the reads that never
      // select a LOB are left exactly as they were. `getSchema` is the one that
      // would notice: it reads ALL_TAB_COLUMNS.DATA_DEFAULT, a LONG.
      test("getSchema() is left alone", async () => {
        await provider.connect();
        await provider.getSchema();
        expect(lastExecuteOpts.fetchTypeHandler).toBeUndefined();
      });

      // What the fetched values then are, end to end: a CLOB is a plain string and
      // a BLOB is a Buffer, so a BLOB joins the shared byte contract that the grid,
      // the row detail sheet and the CSV all read a binary cell through
      // (`asBytes` in src/lib/export/binary.ts), in both the live shape and the
      // shape it serialises to over HTTP.
      test("the fetched values are serialisable and a BLOB is bytes", async () => {
        await provider.connect();
        mockExecuteFn = async () => ({
          rows: [{ C: "the quick brown fox", B: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]) }],
          metaData: [{ name: "C" }, { name: "B" }],
        });

        const result = await provider.query("SELECT c, b FROM r6_lob");
        const row = result.rows[0] as Record<string, unknown>;
        expect(row.C).toBe("the quick brown fox");
        expect(asBytes(row.B)).toEqual(Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]));

        const overWire = JSON.parse(JSON.stringify(result.rows)) as Record<string, unknown>[];
        expect(overWire[0].C).toBe("the quick brown fox");
        expect(asBytes(overWire[0].B)).toEqual(Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]));
      });

      // A NULL LOB stays null rather than becoming an empty string or an empty
      // buffer: measured, row 2 of `r6_lob` came back with `C === null` and
      // `B === null` once the handler was in place.
      test("a NULL LOB stays null", async () => {
        await provider.connect();
        mockExecuteFn = async () => ({ rows: [{ C: null, B: null }], metaData: [{ name: "C" }, { name: "B" }] });

        const result = await provider.query("SELECT c, b FROM r6_lob WHERE id = 2");
        expect((result.rows[0] as Record<string, unknown>).C).toBeNull();
        expect(asBytes((result.rows[0] as Record<string, unknown>).B)).toBeUndefined();
      });
    });

    // INTERVAL columns. oracledb answers them with its own `IntervalYM` /
    // `IntervalDS` objects, which no surface here reconstructs and which Oracle
    // refuses back. Measured 2026-08-24 against Oracle AI Database 26ai Free (oracledb 6.10.0,
    // Thin) over `d19_probe`: `INTERVAL '3-7' YEAR TO MONTH` arrived as
    // `{"months":7,"years":3}` and `INTERVAL '5 6:7:8.9' DAY TO SECOND` as
    // `{"fseconds":900000000,"seconds":8,"minutes":7,"hours":6,"days":5}`. The
    // literals below were all replayed into a live table and read back identical
    // (docs/providers/oracle.md 5.5).
    describe("INTERVAL columns", () => {
      const ymMeta = [
        { name: "IYM", dbType: DB_TYPE_INTERVAL_YM, dbTypeName: "INTERVAL YEAR TO MONTH" },
        { name: "K", dbType: DB_TYPE_VARCHAR, dbTypeName: "VARCHAR2" },
      ];
      const dsMeta = [{ name: "IDS", dbType: DB_TYPE_INTERVAL_DS, dbTypeName: "INTERVAL DAY TO SECOND" }];

      async function ym(value: unknown): Promise<unknown> {
        mockExecuteFn = async () => ({ rows: [{ IYM: value, K: "keep" }], metaData: ymMeta });
        const result = await provider.query("SELECT iym, k FROM d19_probe");
        return (result.rows[0] as Record<string, unknown>).IYM;
      }

      async function ds(value: unknown): Promise<unknown> {
        mockExecuteFn = async () => ({ rows: [{ IDS: value }], metaData: dsMeta });
        const result = await provider.query("SELECT ids FROM d19_probe");
        return (result.rows[0] as Record<string, unknown>).IDS;
      }

      beforeEach(async () => {
        await provider.connect();
      });

      test("an INTERVAL YEAR TO MONTH reads as the literal Oracle takes back", async () => {
        expect(await ym({ years: 3, months: 7 })).toBe("+03-07");
      });

      // Both fields carry the sign - measured, `INTERVAL '-3-7' YEAR TO MONTH`
      // arrives as `{"months":-7,"years":-3}`.
      test("a negative INTERVAL YEAR TO MONTH keeps one leading sign", async () => {
        expect(await ym({ years: -3, months: -7 })).toBe("-03-07");
      });

      test("a zero INTERVAL YEAR TO MONTH is spelled, not dropped", async () => {
        expect(await ym({ years: 0, months: 0 })).toBe("+00-00");
      });

      // Years past the two-digit default are not truncated: `INTERVAL '123456789-11'
      // YEAR(9) TO MONTH` arrived as `{"months":11,"years":123456789}` and Oracle
      // took `+123456789-11` back into the same column.
      test("a nine-digit year count keeps all its digits", async () => {
        expect(await ym({ years: 123456789, months: 11 })).toBe("+123456789-11");
      });

      test("an INTERVAL DAY TO SECOND reads as the literal Oracle takes back", async () => {
        expect(await ds({ days: 5, hours: 6, minutes: 7, seconds: 8, fseconds: 900000000 })).toBe("+05 06:07:08.9");
      });

      test("a negative INTERVAL DAY TO SECOND keeps one leading sign", async () => {
        expect(await ds({ days: -5, hours: -6, minutes: -7, seconds: -8, fseconds: -900000000 })).toBe(
          "-05 06:07:08.9",
        );
      });

      // A whole-second interval gets no fractional part at all: `INTERVAL '9 8:7:6'
      // DAY TO SECOND` arrived with `fseconds: 0`, and `+09 08:07:06` replays.
      test("a whole-second interval carries no fraction", async () => {
        expect(await ds({ days: 9, hours: 8, minutes: 7, seconds: 6, fseconds: 0 })).toBe("+09 08:07:06");
      });

      // `fseconds` is NANOseconds: the full nine digits are kept, which is what a
      // SECOND(9) column can hold and what a `Date` never could.
      test("nanosecond precision survives", async () => {
        expect(await ds({ days: 123456789, hours: 23, minutes: 59, seconds: 59, fseconds: 123456789 })).toBe(
          "+123456789 23:59:59.123456789",
        );
      });

      test("a NULL interval stays null", async () => {
        expect(await ym(null)).toBeNull();
        expect(await ds(null)).toBeNull();
      });

      // The declared type still names the Oracle type, so the SQL export writes
      // `INTERVAL YEAR TO MONTH` in its CREATE TABLE and the literal in its INSERT.
      test("the declared column type is unchanged", async () => {
        mockExecuteFn = async () => ({ rows: [{ IYM: { years: 3, months: 7 }, K: "keep" }], metaData: ymMeta });
        const result = await provider.query("SELECT iym, k FROM d19_probe");
        expect(result.columnTypes).toEqual({ IYM: "INTERVAL YEAR TO MONTH", K: "VARCHAR2" });
        expect((result.rows[0] as Record<string, unknown>).K).toBe("keep");
      });

      test("the literal survives the HTTP boundary as itself", async () => {
        mockExecuteFn = async () => ({ rows: [{ IYM: { years: 3, months: 7 }, K: "keep" }], metaData: ymMeta });
        const result = await provider.query("SELECT iym, k FROM d19_probe");
        const overWire = JSON.parse(JSON.stringify(result.rows)) as Record<string, unknown>[];
        expect(overWire[0].IYM).toBe("+03-07");
      });

      test("queryInTransaction() normalises the same way", async () => {
        await provider.beginTransaction();
        mockExecuteFn = async () => ({
          rows: [{ IDS: { days: 1, hours: 2, minutes: 3, seconds: 4, fseconds: 0 } }],
          metaData: dsMeta,
        });
        const result = await provider.queryInTransaction("SELECT ids FROM d19_probe");
        expect((result.rows[0] as Record<string, unknown>).IDS).toBe("+01 02:03:04");
        await provider.rollbackTransaction();
      });

      // A result with no interval column is handed on as the driver built it - the
      // same array, not a copy - so the common query pays nothing for this.
      test("a result with no interval column is not rewritten", async () => {
        const rows = [{ ID: 1, NAME: "a" }];
        mockExecuteFn = async () => ({
          rows,
          metaData: [
            { name: "ID", dbTypeName: "NUMBER" },
            { name: "NAME", dbTypeName: "VARCHAR2" },
          ],
        });
        const result = await provider.query("SELECT id, name FROM r5_types");
        expect(result.rows).toBe(rows);
      });
    });
  });

  // =========================================================================
  // 4. getCapabilities()
  // =========================================================================

  describe("getCapabilities()", () => {
    // #U9: `optimize` takes a TABLE and rebuilds that table's own indexes. It used to
    // take an INDEX name, so the per-table button #427 wired up sent a table and every
    // click answered ORA-01418 (reproduced against Oracle AI Database 26ai Free on 2026-08-25).
    test("declares the target grammar of every maintenance operation", () => {
      const caps = provider.getCapabilities();

      expect(caps.maintenanceOperationSpecs).toEqual({
        analyze: { label: "Gather Statistics", perEntity: true, global: true },
        optimize: { label: "Rebuild Indexes", perEntity: true, global: true },
        kill: { label: "Kill Session", perEntity: false, global: false },
      });
      expect(Object.keys(caps.maintenanceOperationSpecs ?? {}).sort()).toEqual([...caps.maintenanceOperations].sort());
    });

    test("the vacuum label names the index rebuild, and the surfaces send that", () => {
      // Oracle has no VACUUM; this slot has said "Rebuild Indexes" since the provider
      // shipped, and the global card gated on the literal `vacuum` never showed it.
      const labels = provider.getLabels();

      expect(labels.vacuumAction).toBe("Rebuild Indexes");
      expect(labels.vacuumActionOperation).toBe("optimize");
    });
    test("returns correct capabilities for Oracle", () => {
      const caps = provider.getCapabilities();
      expect(caps.defaultPort).toBe(1521);
      expect(caps.maintenanceOperations).toContain("analyze");
      expect(caps.maintenanceOperations).toContain("optimize");
      expect(caps.maintenanceOperations).toContain("kill");
      // Explain is intentionally disabled until an Oracle dialect wrapper exists (#126):
      // the UI's EXPLAIN builder has no EXPLAIN PLAN FOR / DBMS_XPLAN flow, so advertising
      // the capability made the Explain action silently run the unmodified query.
      expect(caps.supportsExplain).toBe(false);
      expect(caps.explainFormat).toBeUndefined();
      expect(caps.supportsExplain).toBe(caps.explainFormat !== undefined);
      expect(caps.supportsConnectionString).toBe(true);
      // `UPDATE t SET c = v WHERE pk = v` is core Oracle DML — the shape the inline
      // row editor builds (#269).
      expect(caps.supportsInlineRowEdit).toBe(true);
      // One held connection carries the transaction, so the trio is offered (#U13).
      expect(caps.supportsTransactions).toBe(true);
      // Inherited from the base capabilities: this engine declares foreign keys, so
      // an empty `foreignKeys` list is a fact about the schema or the role, never
      // about the engine (#414).
      expect(caps.declaresForeignKeys).toBe(true);
    });
  });

  // =========================================================================
  // 5. getLabels()
  // =========================================================================

  describe("getLabels()", () => {
    test("returns Gather Statistics as analyzeAction", () => {
      const labels = provider.getLabels();
      expect(labels.analyzeAction).toBe("Gather Statistics");
    });

    // Until #U12 the monitoring Queries panel told an Oracle DBA to install a
    // PostgreSQL extension. `getSlowQueries()` reads V$SQL and swallows a failure into
    // `[]`, so the grant on that view is what the sentence must name.
    test("names V$SQL, not a Postgres extension, as where query stats come from", () => {
      const { slowQueriesEmptyState } = provider.getLabels();

      expect(slowQueriesEmptyState).toContain("V$SQL");
      expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
    });
  });

  // =========================================================================
  // 6. prepareQuery()
  // =========================================================================

  describe("prepareQuery()", () => {
    test("SELECT without FETCH FIRST gets FETCH FIRST appended", () => {
      const result = provider.prepareQuery("SELECT * FROM USERS");
      expect(result.query).toContain("FETCH FIRST");
      expect(result.wasLimited).toBe(true);
    });

    test("SELECT with offset gets OFFSET/FETCH NEXT", () => {
      const result = provider.prepareQuery("SELECT * FROM USERS", { offset: 10, limit: 50 });
      expect(result.query).toContain("OFFSET 10 ROWS");
      expect(result.query).toContain("FETCH NEXT 50 ROWS ONLY");
      expect(result.wasLimited).toBe(true);
    });

    test("non-SELECT query is unchanged", () => {
      const sql = "INSERT INTO USERS (NAME) VALUES ('test')";
      const result = provider.prepareQuery(sql);
      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test("existing FETCH FIRST leaves query unchanged", () => {
      const sql = "SELECT * FROM USERS FETCH FIRST 10 ROWS ONLY";
      const result = provider.prepareQuery(sql);
      expect(result.wasLimited).toBe(false);
    });

    test("existing ROWNUM leaves query unchanged", () => {
      const sql = "SELECT * FROM USERS WHERE ROWNUM <= 10";
      const result = provider.prepareQuery(sql);
      expect(result.wasLimited).toBe(false);
    });

    test("trailing semicolon is preserved after the FETCH clause", () => {
      const result = provider.prepareQuery("SELECT * FROM USERS;");
      expect(result.wasLimited).toBe(true);
      expect(result.query.endsWith("FETCH FIRST 500 ROWS ONLY;")).toBe(true);
    });

    test("trailing semicolon is preserved with offset pagination", () => {
      const result = provider.prepareQuery("SELECT * FROM USERS;", { offset: 20, limit: 10 });
      expect(result.query.endsWith("OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY;")).toBe(true);
    });

    test("unlimited raises the limit to MAX_UNLIMITED_ROWS", () => {
      const result = provider.prepareQuery("SELECT * FROM USERS", { unlimited: true });
      expect(result.wasLimited).toBe(true);
      expect(result.limit).toBe(100000);
      expect(result.query).toContain("FETCH FIRST 100000 ROWS ONLY");
    });

    // ── Trailing comments (#280) ────────────────────────────────────────────
    //
    // Both branches below append their clause at the tail, so a trailing line
    // comment used to absorb it whole - the statement reached Oracle unbounded
    // while this method reported `wasLimited: true`. Oracle accepts `--` and
    // ignores `#`, so only the dash form is asserted here.

    describe("trailing comments", () => {
      test("FETCH FIRST lands before a trailing comment", () => {
        const result = provider.prepareQuery("SELECT * FROM USERS -- daily check");

        expect(result.query).toBe("SELECT * FROM USERS FETCH FIRST 500 ROWS ONLY -- daily check");
        expect(result.wasLimited).toBe(true);
      });

      test("OFFSET/FETCH NEXT lands before a trailing comment", () => {
        const result = provider.prepareQuery("SELECT * FROM USERS -- daily check", { offset: 20, limit: 10 });

        expect(result.query).toBe("SELECT * FROM USERS OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY -- daily check");
        expect(result.wasLimited).toBe(true);
      });

      test("the terminating semicolon stays outside the comment", () => {
        const result = provider.prepareQuery("SELECT * FROM USERS; -- daily check");

        expect(result.query).toBe("SELECT * FROM USERS FETCH FIRST 500 ROWS ONLY; -- daily check");
      });

      // A quote behind an odd backslash run: Oracle and MySQL close that literal
      // in different places, so there is no honest place for the clause.
      // Appending on a guess would put it after the terminator.
      test("returns a literal whose end is undeterminable untouched rather than bounding it on a guess", () => {
        const sql = "SELECT * FROM USERS WHERE PATH = 'C:\\';";

        const result = provider.prepareQuery(sql);

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
      });

      // ── The `#` grammar is Oracle's here (#292) ─────────────────────────
      //
      // `#` is a legal identifier character in Oracle and opens no comment there
      // - node-oracledb's own SQL tokenizer accepts it inside a name and starts
      // comments on `--` and `/*` only. While the shared reader had to guess, it
      // read `ID#` as MySQL would and declined to bound the statement at all;
      // told which dialect it is reading, it bounds it where Oracle wants it.
      test.each<[string, string]>([
        ["a bare identifier carrying a hash", "SELECT * FROM EMP WHERE ID# = 1"],
        ["a hash at the end of a table name", "SELECT * FROM EMP#"],
      ])("bounds %s instead of declining", (_label, sql) => {
        const result = provider.prepareQuery(sql);

        expect(result.query).toBe(`${sql} FETCH FIRST 500 ROWS ONLY`);
        expect(result.wasLimited).toBe(true);
      });

      // ── Alternate quoting is a literal here (#292) ──────────────────────
      //
      // `q'{it's}'` is how Oracle writes a literal that carries apostrophes, and
      // the shared span reader had no branch for the form: the body was walked as
      // code, so the first apostrophe inside it opened a string and everything
      // after it read one construct out of step. Two costs, both real today: a `)`
      // in the body ends a CTE body early, so the statement is typed by a keyword
      // that is inside the literal and loses its bound; and a `--` in the body
      // makes the rest of the literal look like trailing trivia, so #280's
      // insert-before-trivia rewrite splices the clause INSIDE the literal and
      // emits SQL Oracle rejects. `prepareQuery` passes its own type, and Oracle's
      // grammar has the form - node-oracledb's own tokenizer
      // (`lib/thin/statement.js`, `_parseQstring`) pairs `[ ] { } ( ) < >` and
      // closes every other delimiter with itself.
      test.each<[string, string]>([
        ["a CTE body holding an apostrophe", "WITH T AS (SELECT q'{it's}' AS S FROM DUAL) SELECT * FROM T"],
        [
          "a literal holding a close paren and a write keyword",
          "WITH T AS (SELECT q'{it's ) DELETE FROM USERS}' AS S FROM DUAL) SELECT * FROM T",
        ],
        ["a literal holding a comment marker", "SELECT q'[it's a -- note )]' AS S FROM DUAL"],
        ["an upper-case tag", "SELECT Q'<it's>' AS S FROM DUAL"],
        ["a delimiter that closes with itself", "SELECT q'!it's!' AS S FROM DUAL"],
        // The national-charset spelling of the same form (`nq'…'`, Oracle's SQL
        // Language Reference). Its comment-marker shape is the corrupting one
        // above, so it is asserted here rather than left to the reader's charity.
        ["a national-charset literal", "SELECT nq'{it's}' AS S FROM DUAL"],
        ["a national-charset literal holding a comment marker", "SELECT nq'[it's a -- note )]' AS S FROM DUAL"],
        [
          "an upper-case national-charset literal in a CTE body",
          "WITH T AS (SELECT NQ'{it's ) SELECT X}' AS S FROM DUAL) SELECT * FROM T",
        ],
      ])("bounds %s, with the clause after the literal", (_label, sql) => {
        const result = provider.prepareQuery(sql);

        expect(result.query).toBe(`${sql} FETCH FIRST 500 ROWS ONLY`);
        expect(result.wasLimited).toBe(true);
      });

      // Where the form itself cannot be read to its end there is no honest place
      // for the clause, so the statement is returned as it came.
      test.each<[string, string]>([
        ["an alternate literal that never closes", "SELECT q'{it's FROM DUAL"],
        ["a national-charset literal that never closes", "SELECT nq'{it's FROM DUAL"],
        // A name that merely ends in the tag's letters is a name: Oracle reads it
        // greedily and so does this reader, which leaves the apostrophe after it
        // opening an ordinary string that never closes.
        ["a name ending in the tag's letters", "SELECT FREQ'{it's}' AS S FROM DUAL"],
      ])("returns %s untouched rather than bounding it on a guess", (_label, sql) => {
        const result = provider.prepareQuery(sql);

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
      });

      test("a real FETCH FIRST before a comment is still honoured", () => {
        const sql = "SELECT * FROM USERS FETCH FIRST 10 ROWS ONLY -- deliberate";

        const result = provider.prepareQuery(sql);

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
      });
    });
  });

  // =========================================================================
  // 7. getSchema()
  // =========================================================================

  describe("getSchema()", () => {
    test("returns tables with columns, indexes, PKs, and FKs", async () => {
      await provider.connect();
      const schema = await provider.getSchema();

      expect(schema).toBeArray();
      expect(schema.length).toBe(2);

      const usersTable = schema.find((t) => t.name === "USERS");
      expect(usersTable).toBeDefined();
      expect(usersTable!.columns.length).toBeGreaterThanOrEqual(2);

      // Check primary key
      const idCol = usersTable!.columns.find((c) => c.name === "ID");
      expect(idCol).toBeDefined();
      expect(idCol!.isPrimary).toBe(true);

      // Check indexes exist
      expect(usersTable!.indexes).toBeArray();

      // Check foreign keys on ORDERS
      const ordersTable = schema.find((t) => t.name === "ORDERS");
      expect(ordersTable).toBeDefined();
      expect(ordersTable!.foreignKeys!.length).toBeGreaterThan(0);
      expect(ordersTable!.foreignKeys![0].referencedTable).toBe("USERS");
    });
  });

  // =========================================================================
  // 8. getHealth()
  // =========================================================================

  describe("getHealth()", () => {
    test("returns health data with graceful degradation", async () => {
      await provider.connect();
      const health = await provider.getHealth();

      expect(typeof health.activeConnections).toBe("number");
      expect(typeof health.databaseSize).toBe("string");
      expect(health.cacheHitRatio).toBe("97.5%");
      expect(health.slowQueries).toBeArray();
      expect(health.activeSessions).toBeArray();
    });

    test("reports an unreadable cache hit ratio as unavailable, not as 0%", async () => {
      // `${rows[0]?.HIT_RATIO || 0}%` produced "0%" for a NULL reading, which the
      // Overview card rates "Needs tuning" - a fault Oracle never reported.
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$SYSSTAT")) {
          return { rows: [{ HIT_RATIO: null }], metaData: [{ name: "HIT_RATIO" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const health = await provider.getHealth();

      expect(health.cacheHitRatio).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
    });

    test("keeps a measured cache hit ratio of zero in the health string", async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$SYSSTAT")) {
          return { rows: [{ HIT_RATIO: 0 }], metaData: [{ name: "HIT_RATIO" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const health = await provider.getHealth();

      expect(health.cacheHitRatio).toBe("0.0%");
      expect(health.cacheHitRatio).not.toBe(CACHE_HIT_RATIO_UNAVAILABLE);
    });

    test("degrades gracefully when V$ views throw", async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$")) {
          throw new Error("ORA-00942: table or view does not exist");
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const health = await provider.getHealth();

      // Should still return valid health object even if V$ queries fail
      expect(health).toBeDefined();
      expect(health.activeConnections).toBe(0);
    });

    test("reports database size in GB above 1024 MB", async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("USER_SEGMENTS")) {
          return { rows: [{ SIZE_MB: 2048 }], metaData: [{ name: "SIZE_MB" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const health = await provider.getHealth();

      expect(health.databaseSize).toBe("2.00 GB");
    });
  });

  // =========================================================================
  // 9. runMaintenance()
  // =========================================================================

  describe("runMaintenance()", () => {
    test("analyze calls DBMS_STATS", async () => {
      let capturedSql = "";
      mockExecuteFn = async (sql: string) => {
        capturedSql = sql;
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("analyze", "USERS");

      expect(result.success).toBe(true);
      expect(capturedSql).toContain("DBMS_STATS");
      expect(typeof result.executionTime).toBe("number");
    });

    test("analyze without target gathers schema statistics", async () => {
      let capturedSql = "";
      mockExecuteFn = async (sql: string) => {
        capturedSql = sql;
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("analyze");

      expect(result.success).toBe(true);
      expect(capturedSql).toContain("GATHER_SCHEMA_STATS");
    });

    // The target is a TABLE name, because a table name is the only thing either
    // maintenance surface has to send. Building `ALTER INDEX "<target>" REBUILD` from
    // it answered ORA-01418 for every table there is - measured against Oracle AI
    // Database 26ai Free on 2026-08-25, then re-run after this fix (#U9).
    test("optimize with a table target rebuilds the indexes THAT TABLE owns", async () => {
      const captured: string[] = [];
      let indexQueryBinds: unknown;
      mockExecuteFn = async (sql: string, binds?: unknown) => {
        captured.push(sql);
        const upper = sql.toUpperCase();
        if (upper.includes("USER_INDEXES") && upper.includes("TABLE_NAME =")) {
          indexQueryBinds = binds;
          return {
            rows: [{ INDEX_NAME: "SYS_C008646" }, { INDEX_NAME: "U9_PROBE_NAME_IX" }],
            metaData: [{ name: "INDEX_NAME" }],
          };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("optimize", "U9_PROBE");

      expect(result.success).toBe(true);
      // The table is looked up, with its name bound rather than interpolated.
      expect(indexQueryBinds).toEqual(["U9_PROBE"]);
      // Both of the table's own indexes are rebuilt, and the TABLE name is never
      // handed to ALTER INDEX - the assertion that used to hold and produced ORA-01418.
      expect(captured).toContain('ALTER INDEX "SYS_C008646" REBUILD');
      expect(captured).toContain('ALTER INDEX "U9_PROBE_NAME_IX" REBUILD');
      expect(captured.some((sql) => sql.includes('ALTER INDEX "U9_PROBE" REBUILD'))).toBe(false);
    });

    test("optimize on a table with no rebuildable index succeeds having rebuilt nothing", async () => {
      // A heap table with no index is an ordinary state, and so is a table whose only
      // index is the LOB index the catalog query filters out (the live probe's
      // SYS_IL0000073772C00003$$). "Nothing to do" is not a failure - but only for a
      // table the catalog KNOWS, which is why USER_TABLES answers a row here.
      const captured: string[] = [];
      mockExecuteFn = async (sql: string) => {
        captured.push(sql);
        const upper = sql.toUpperCase();
        if (upper.includes("USER_INDEXES") && upper.includes("TABLE_NAME =")) {
          return { rows: [], metaData: [{ name: "INDEX_NAME" }] };
        }
        if (upper.includes("USER_TABLES") && upper.includes("TABLE_NAME =")) {
          return { rows: [{ TABLE_NAME: "U9_HEAP" }], metaData: [{ name: "TABLE_NAME" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("optimize", "U9_HEAP");

      expect(result.success).toBe(true);
      expect(captured.some((sql) => sql.toUpperCase().startsWith("ALTER INDEX"))).toBe(false);
    });

    // An empty USER_INDEXES answer has TWO causes and they are different facts: a table
    // with no rebuildable index, and a target that is not a table of this schema at
    // all. Both answered `{"success":true}` in ~1 ms having done nothing - measured
    // through the provider against ldb-oracle-r5 (Oracle AI Database 26ai Free Release
    // 23.26.2.0.0) on 2026-08-25 for a name that does not exist AND for a real table
    // spelled in the wrong case.
    test("optimize on a target the catalog does not know is not a completed operation", async () => {
      const captured: string[] = [];
      let existenceBinds: unknown;
      mockExecuteFn = async (sql: string, binds?: unknown) => {
        captured.push(sql);
        const upper = sql.toUpperCase();
        if (upper.includes("USER_INDEXES") && upper.includes("TABLE_NAME =")) {
          return { rows: [], metaData: [{ name: "INDEX_NAME" }] };
        }
        if (upper.includes("USER_TABLES") && upper.includes("TABLE_NAME =")) {
          existenceBinds = binds;
          return { rows: [], metaData: [{ name: "TABLE_NAME" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("optimize", "u9real");

      expect(result.success).toBe(false);
      expect(result.message).toContain("u9real");
      // Case is Oracle's rule, not ours: the name is bound exactly as the caller wrote
      // it, so a lower-case spelling of an upper-case table is reported as unknown
      // rather than silently succeeding.
      expect(existenceBinds).toEqual(["u9real"]);
      expect(captured.some((sql) => sql.toUpperCase().startsWith("ALTER INDEX"))).toBe(false);
    });

    test("the whole-schema form asks no existence question", async () => {
      // There is no target to check, and an empty schema is not an error.
      const captured: string[] = [];
      mockExecuteFn = async (sql: string) => {
        captured.push(sql);
        const upper = sql.toUpperCase();
        if (upper.includes("USER_INDEXES")) {
          return { rows: [], metaData: [{ name: "INDEX_NAME" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("optimize");

      expect(result.success).toBe(true);
      expect(captured.some((sql) => sql.toUpperCase().includes("USER_TABLES"))).toBe(false);
    });

    test("optimize reports how many indexes it rebuilt", async () => {
      // One index failing is tolerated, so "success" alone hides how much of the
      // operation actually happened.
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("USER_INDEXES") && upper.includes("TABLE_NAME =")) {
          return {
            rows: [{ INDEX_NAME: "BAD_IDX" }, { INDEX_NAME: "GOOD_IDX" }],
            metaData: [{ name: "INDEX_NAME" }],
          };
        }
        if (sql.startsWith('ALTER INDEX "BAD_IDX"')) {
          throw new Error("ORA-01502: index is in unusable state");
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("optimize", "U9_PROBE");

      expect(result.success).toBe(true);
      expect(result.message).toContain("1 of 2");
    });

    test("optimize on a table tolerates one index failing", async () => {
      // An offline tablespace or an unusable partition stops that index alone; the
      // remaining ones still rebuild, which is the choice the whole-schema form made.
      const rebuilt: string[] = [];
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("USER_INDEXES") && upper.includes("TABLE_NAME =")) {
          return {
            rows: [{ INDEX_NAME: "BAD_IDX" }, { INDEX_NAME: "GOOD_IDX" }],
            metaData: [{ name: "INDEX_NAME" }],
          };
        }
        if (sql.startsWith('ALTER INDEX "BAD_IDX"')) {
          throw new Error("ORA-01502: index is in unusable state");
        }
        if (upper.startsWith("ALTER INDEX")) {
          rebuilt.push(sql);
          return { rows: [], metaData: [] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("optimize", "U9_PROBE");

      expect(result.success).toBe(true);
      expect(rebuilt).toEqual(['ALTER INDEX "GOOD_IDX" REBUILD']);
    });

    test("optimize reports failure when EVERY index of the table failed", async () => {
      /*
        Tolerating one failure and tolerating all of them are different facts. Measured
        against ldb-oracle-r5 (Oracle AI Database 26ai Free Release 23.26.2.0.0) on
        2026-08-25: a table whose tablespace is READ ONLY answers ORA-01647 for every
        `ALTER INDEX ... REBUILD`, and this reported `{"success":true,"message":"OPTIMIZE:
        rebuilt 0 of 2 indexes."}` in 14 ms with the ORA text discarded - the same
        success-reporting shape this whole pass exists to remove, one level in.

        The engine's own first refusal travels in the message: "rebuilt 0 of 2" says the
        count and nothing about why, and why is the only part an operator can act on.
      */
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("USER_INDEXES") && upper.includes("TABLE_NAME =")) {
          return {
            rows: [{ INDEX_NAME: "BAD_IDX" }, { INDEX_NAME: "ALSO_BAD_IDX" }],
            metaData: [{ name: "INDEX_NAME" }],
          };
        }
        if (upper.startsWith("ALTER INDEX")) {
          throw new Error("ORA-01647: tablespace 'V9RO_TS' is read-only, cannot allocate space in it");
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("optimize", "V9RO");

      expect(result.success).toBe(false);
      expect(result.message).toContain("0 of 2");
      expect(result.message).toContain("ORA-01647");
    });

    test("optimize quotes an index name that contains a double quote", async () => {
      const captured: string[] = [];
      mockExecuteFn = async (sql: string) => {
        captured.push(sql);
        const upper = sql.toUpperCase();
        if (upper.includes("USER_INDEXES") && upper.includes("TABLE_NAME =")) {
          return { rows: [{ INDEX_NAME: 'ODD"NAME' }], metaData: [{ name: "INDEX_NAME" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      await provider.runMaintenance("optimize", "U9_PROBE");

      expect(captured).toContain('ALTER INDEX "ODD""NAME" REBUILD');
    });

    test("optimize without target rebuilds all indexes and tolerates individual failures", async () => {
      const rebuilt: string[] = [];
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("USER_INDEXES") && upper.includes("INDEX_TYPE")) {
          return {
            rows: [{ INDEX_NAME: "GOOD_IDX" }, { INDEX_NAME: "BAD_IDX" }],
            metaData: [{ name: "INDEX_NAME" }],
          };
        }
        if (sql.startsWith('ALTER INDEX "BAD_IDX"')) {
          throw new Error("ORA-01418: specified index does not exist");
        }
        if (sql.startsWith("ALTER INDEX")) {
          rebuilt.push(sql);
          return { rows: [], metaData: [] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("optimize");

      expect(result.success).toBe(true);
      expect(rebuilt).toEqual(['ALTER INDEX "GOOD_IDX" REBUILD']);
    });

    test("kill with target issues ALTER SYSTEM KILL SESSION", async () => {
      let capturedSql = "";
      mockExecuteFn = async (sql: string) => {
        capturedSql = sql;
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("kill", "101,5432");

      expect(result.success).toBe(true);
      expect(capturedSql).toContain("ALTER SYSTEM KILL SESSION '101,5432'");
    });

    test("kill without target throws QueryError", async () => {
      await provider.connect();
      await expect(provider.runMaintenance("kill")).rejects.toThrow(QueryError);
    });

    test("unsupported maintenance type throws QueryError", async () => {
      await provider.connect();
      await expect(provider.runMaintenance("vacuum" as unknown as "analyze")).rejects.toThrow(QueryError);
    });
  });

  // =========================================================================
  // 10. getPoolStats()
  // =========================================================================

  describe("getPoolStats()", () => {
    test("returns pool statistics when connected", async () => {
      await provider.connect();
      const stats = provider.getPoolStats();

      expect(stats.total).toBe(5);
      expect(stats.active).toBe(2);
      expect(stats.idle).toBe(3);
      expect(typeof stats.waiting).toBe("number");
    });

    test("returns zeros when not connected", () => {
      const stats = provider.getPoolStats();
      expect(stats.total).toBe(0);
      expect(stats.idle).toBe(0);
      expect(stats.active).toBe(0);
    });
  });

  // =========================================================================
  // 11. Transaction lifecycle
  // =========================================================================

  describe("transaction lifecycle", () => {
    test("begin/commit lifecycle works", async () => {
      await provider.connect();

      expect(provider.isInTransaction()).toBe(false);
      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);

      const result = await provider.queryInTransaction("SELECT 1 FROM DUAL");
      expect(result.rows).toBeArray();

      await provider.commitTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("begin/rollback lifecycle works", async () => {
      await provider.connect();

      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);

      await provider.rollbackTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    // The same defect on the held connection. `rowsAffected` is per statement,
    // so the count is the statement's own and the commit adds nothing to it.
    test("queryInTransaction reports the driver's rowsAffected for a DML statement", async () => {
      await provider.connect();
      await provider.beginTransaction();
      mockExecuteFn = async () => ({ rowsAffected: 2 });

      const result = await provider.queryInTransaction("UPDATE r5_types SET note = 't'");
      expect(result.rowCount).toBe(2);
      expect(result.rows).toEqual([]);
      expect(result.fields).toEqual([]);

      mockExecuteFn = async (sql: string) => defaultExecute(sql);
      await provider.rollbackTransaction();
    });

    test("beginTransaction while a transaction is active throws QueryError", async () => {
      await provider.connect();
      await provider.beginTransaction();

      await expect(provider.beginTransaction()).rejects.toThrow(QueryError);
      await provider.rollbackTransaction();
    });

    test("commitTransaction without an active transaction throws QueryError", async () => {
      await provider.connect();
      await expect(provider.commitTransaction()).rejects.toThrow(QueryError);
    });

    test("rollbackTransaction without an active transaction throws QueryError", async () => {
      await provider.connect();
      await expect(provider.rollbackTransaction()).rejects.toThrow(QueryError);
    });

    test("queryInTransaction without an active transaction throws QueryError", async () => {
      await provider.connect();
      await expect(provider.queryInTransaction("SELECT 1 FROM DUAL")).rejects.toThrow(QueryError);
    });

    test("queryInTransaction maps driver errors", async () => {
      await provider.connect();
      await provider.beginTransaction();

      mockExecuteFn = async () => {
        throw new Error("ORA-00942: table or view does not exist");
      };

      await expect(provider.queryInTransaction("SELECT * FROM MISSING")).rejects.toThrow();
      expect(provider.isInTransaction()).toBe(true); // error keeps the tx open

      mockExecuteFn = async (sql: string) => defaultExecute(sql);
      await provider.rollbackTransaction();
    });
  });

  // =========================================================================
  // 12. cancelQuery()
  // =========================================================================

  describe("cancelQuery()", () => {
    test("unknown queryId returns false", async () => {
      await provider.connect();
      const cancelled = await provider.cancelQuery("non-existent-id");
      expect(cancelled).toBe(false);
    });

    test("breaks a running query and returns true", async () => {
      await provider.connect();

      let executeStarted: () => void;
      const started = new Promise<void>((resolve) => {
        executeStarted = resolve;
      });
      let releaseExecute: (value: unknown) => void;
      mockExecuteFn = () =>
        new Promise((resolve) => {
          executeStarted();
          releaseExecute = resolve;
        });

      let breakCalled = false;
      mockBreakFn = async () => {
        breakCalled = true;
      };

      const queryPromise = provider.query("SELECT * FROM BIG_TABLE", [], "run-1");
      await started;

      const cancelled = await provider.cancelQuery("run-1");
      expect(cancelled).toBe(true);
      expect(breakCalled).toBe(true);

      releaseExecute!({ rows: [], metaData: [] });
      const result = await queryPromise;
      expect(result.rowCount).toBe(0);
    });

    test("returns false when break fails", async () => {
      await provider.connect();

      let executeStarted: () => void;
      const started = new Promise<void>((resolve) => {
        executeStarted = resolve;
      });
      let releaseExecute: (value: unknown) => void;
      mockExecuteFn = () =>
        new Promise((resolve) => {
          executeStarted();
          releaseExecute = resolve;
        });

      mockBreakFn = async () => {
        throw new Error("break not supported");
      };

      const queryPromise = provider.query("SELECT * FROM BIG_TABLE", [], "run-2");
      await started;

      const cancelled = await provider.cancelQuery("run-2");
      expect(cancelled).toBe(false);

      releaseExecute!({ rows: [], metaData: [] });
      await queryPromise;
    });
  });

  // =========================================================================
  // 13. getOverview()
  // =========================================================================

  describe("getOverview()", () => {
    test("returns version, uptime, connections, size", async () => {
      await provider.connect();
      const overview = await provider.getOverview();

      expect(typeof overview.version).toBe("string");
      expect(overview.version).toContain("Oracle");
      expect(typeof overview.uptime).toBe("string");
      expect(overview.uptime.length).toBeGreaterThan(0);
      expect(typeof overview.activeConnections).toBe("number");
      expect(typeof overview.maxConnections).toBe("number");
      expect(typeof overview.databaseSize).toBe("string");
      expect(typeof overview.databaseSizeBytes).toBe("number");
      expect(typeof overview.tableCount).toBe("number");
      expect(typeof overview.indexCount).toBe("number");
    });

    test("degrades to defaults when every statistics query fails", async () => {
      mockExecuteFn = async () => {
        throw new Error("ORA-00942: table or view does not exist");
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect(overview.version).toBe("Oracle");
      expect(overview.uptime).toBe("N/A");
      expect(overview.startTime).toBeUndefined();
      expect(overview.activeConnections).toBe(0);
      expect(overview.maxConnections).toBe(0);
      expect(overview.databaseSizeBytes).toBe(0);
      expect(overview.tableCount).toBe(0);
      expect(overview.indexCount).toBe(0);
    });
  });

  // =========================================================================
  // 14. getPerformanceMetrics()
  // =========================================================================

  describe("getPerformanceMetrics()", () => {
    test("returns cache ratio, buffer pool usage, deadlocks", async () => {
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(metrics.cacheHitRatio).toBe(97.5);
      // Not a mirror of the cache hit ratio any more, and not reported at all:
      // V$SYSSTAT publishes no buffer pool occupancy.
      expect("bufferPoolUsage" in metrics).toBe(false);
    });

    test("reports nothing when V$SYSSTAT is not readable, rather than a perfect cache", async () => {
      // The ordinary case, not an exotic one. Measured 2026-08-23 on Oracle AI
      // Database 26ai Free against a user granted only CREATE SESSION:
      //   ORA-00942: table or view "SYS"."V_$SYSSTAT" does not exist
      // This assertion used to read `toBe(100)` with the comment "Default
      // fallback", so the suite protected the fabrication.
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$SYSSTAT")) {
          throw new Error('ORA-00942: table or view "SYS"."V_$SYSSTAT" does not exist');
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect("cacheHitRatio" in metrics).toBe(false);
      expect(metrics).toEqual({});
    });

    test("omits the ratio when V$SYSSTAT answers a NULL row", async () => {
      // The counter denominator can be 0, which NULLIF turns into one row whose
      // single column is NULL. Measured 2026-08-23 on Oracle AI Database 26ai Free:
      //    HIT_RATIO
      //   ----------
      //   <NULL>
      // `Number(null || 100)` read that as 100; `Number(null)` would read it as a
      // red 0.
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$SYSSTAT")) {
          return { rows: [{ HIT_RATIO: null }], metaData: [{ name: "HIT_RATIO" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect("cacheHitRatio" in metrics).toBe(false);
    });

    test("keeps a measured ratio of zero", async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$SYSSTAT")) {
          return { rows: [{ HIT_RATIO: 0 }], metaData: [{ name: "HIT_RATIO" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(metrics.cacheHitRatio).toBe(0);
    });
  });

  // =========================================================================
  // 15. getSlowQueries()
  // =========================================================================

  describe("getSlowQueries()", () => {
    test("returns from V$SQL sorted by elapsed time", async () => {
      await provider.connect();
      const slowQueries = await provider.getSlowQueries();

      expect(Array.isArray(slowQueries)).toBe(true);
      expect(slowQueries.length).toBeGreaterThan(0);

      const first = slowQueries[0];
      expect(typeof first.query).toBe("string");
      expect(typeof first.calls).toBe("number");
      expect(first.calls).toBe(42);
      expect(typeof first.totalTime).toBe("number");
      expect(typeof first.avgTime).toBe("number");
      expect(typeof first.rows).toBe("number");
      expect(typeof first.queryId).toBe("string");
    });

    test("honours the limit option", async () => {
      let capturedSql = "";
      mockExecuteFn = async (sql: string) => {
        capturedSql = sql;
        return defaultExecute(sql);
      };

      await provider.connect();
      await provider.getSlowQueries({ limit: 3 });

      expect(capturedSql).toContain("ROWNUM <= 3");
    });

    test("returns empty array when V$SQL is not accessible", async () => {
      mockExecuteFn = async (sql: string) => {
        if (sql.toUpperCase().includes("V$SQL")) {
          throw new Error("ORA-00942: table or view does not exist");
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const slowQueries = await provider.getSlowQueries();

      expect(slowQueries).toEqual([]);
    });
  });

  // =========================================================================
  // 16. getActiveSessions()
  // =========================================================================

  describe("getActiveSessions()", () => {
    test("returns from V$SESSION", async () => {
      await provider.connect();
      const sessions = await provider.getActiveSessions();

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);

      const first = sessions[0];
      expect(typeof first.pid).toBe("string"); // Oracle uses "SID,SERIAL#" format
      expect(typeof first.user).toBe("string");
      expect(typeof first.database).toBe("string");
      expect(typeof first.state).toBe("string");
      expect(typeof first.query).toBe("string");
      expect(typeof first.duration).toBe("string");
      expect(typeof first.durationMs).toBe("number");
    });

    test("formats hour, minute, and second durations and defaults missing fields", async () => {
      const sessionRow = (sid: number, secs: number, overrides: Record<string, unknown> = {}) => ({
        SID: sid,
        "SERIAL#": sid * 10,
        USERNAME: "APP",
        SCHEMANAME: "APP",
        PROGRAM: "sqlplus",
        MACHINE: "host1",
        STATUS: "ACTIVE",
        SQL_ID: `sql-${sid}`,
        QUERY: "SELECT 1 FROM DUAL",
        LOGON_TIME: new Date().toISOString(),
        DURATION_SECS: secs,
        WAIT_CLASS: "CPU",
        EVENT: "cpu time",
        ...overrides,
      });

      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$SESSION") && upper.includes("SERIAL#")) {
          return {
            rows: [
              sessionRow(1, 7200),
              sessionRow(2, 90, {
                USERNAME: null,
                SCHEMANAME: null,
                STATUS: null,
                QUERY: null,
                LOGON_TIME: null,
                WAIT_CLASS: null,
                EVENT: null,
              }),
              sessionRow(3, 30),
            ],
            metaData: [{ name: "SID" }, { name: "SERIAL#" }],
          };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const sessions = await provider.getActiveSessions({ limit: 5 });

      expect(sessions.length).toBe(3);
      expect(sessions[0].duration).toBe("2h 0m");
      expect(sessions[1].duration).toBe("1m 30s");
      expect(sessions[2].duration).toBe("30s");

      // Null columns fall back to safe defaults
      expect(sessions[1].user).toBe("unknown");
      expect(sessions[1].state).toBe("unknown");
      expect(sessions[1].query).toBe("sql-2"); // falls back to SQL_ID
      expect(sessions[1].queryStart).toBeUndefined();
      expect(sessions[1].waitEventType).toBeUndefined();
      expect(sessions[1].waitEvent).toBeUndefined();
    });

    test("returns empty array when V$SESSION is not accessible", async () => {
      mockExecuteFn = async (sql: string) => {
        if (sql.toUpperCase().includes("V$SESSION")) {
          throw new Error("ORA-00942: table or view does not exist");
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const sessions = await provider.getActiveSessions();

      expect(sessions).toEqual([]);
    });
  });

  // =========================================================================
  // 17. getTableStats()
  // =========================================================================

  describe("getTableStats()", () => {
    test("returns table stats from ALL_TABLES/DBA_SEGMENTS", async () => {
      await provider.connect();
      const stats = await provider.getTableStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);

      const first = stats[0];
      expect(typeof first.schemaName).toBe("string");
      expect(typeof first.tableName).toBe("string");
      expect(typeof first.rowCount).toBe("number");
      expect(typeof first.tableSize).toBe("string");
      expect(typeof first.tableSizeBytes).toBe("number");
      expect(typeof first.indexSize).toBe("string");
      expect(typeof first.totalSize).toBe("string");
      expect(typeof first.totalSizeBytes).toBe("number");
    });

    test("returns empty array when the stats query fails", async () => {
      mockExecuteFn = async (sql: string) => {
        if (sql.toUpperCase().includes("ALL_TABLES")) {
          throw new Error("ORA-00942: table or view does not exist");
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const stats = await provider.getTableStats();

      expect(stats).toEqual([]);
    });
  });

  // =========================================================================
  // 18. getIndexStats()
  // =========================================================================

  describe("getIndexStats()", () => {
    test("returns index stats", async () => {
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);

      const first = stats[0];
      expect(typeof first.schemaName).toBe("string");
      expect(typeof first.tableName).toBe("string");
      expect(typeof first.indexName).toBe("string");
      expect(typeof first.indexType).toBe("string");
      expect(Array.isArray(first.columns)).toBe(true);
      expect(typeof first.isUnique).toBe("boolean");
      expect(typeof first.isPrimary).toBe("boolean");
      expect(typeof first.indexSize).toBe("string");
      expect(typeof first.indexSizeBytes).toBe("number");
      expect(typeof first.scans).toBe("number");
    });

    test("returns empty array when the index query fails", async () => {
      mockExecuteFn = async (sql: string) => {
        if (sql.toUpperCase().includes("ALL_INDEXES")) {
          throw new Error("ORA-00942: table or view does not exist");
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(stats).toEqual([]);
    });
  });

  // =========================================================================
  // 19. getStorageStats()
  // =========================================================================

  describe("getStorageStats()", () => {
    test("returns tablespace info", async () => {
      await provider.connect();
      const stats = await provider.getStorageStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);

      const first = stats[0];
      expect(typeof first.name).toBe("string");
      expect(typeof first.size).toBe("string");
      expect(typeof first.sizeBytes).toBe("number");
      expect(first.sizeBytes).toBeGreaterThan(0);
    });

    test("handles permission denied gracefully", async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        // DBA_DATA_FILES requires DBA privilege
        if (upper.includes("DBA_DATA_FILES")) {
          throw new Error("ORA-00942: table or view does not exist");
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const stats = await provider.getStorageStats();

      // Should fall back to USER_SEGMENTS
      expect(Array.isArray(stats)).toBe(true);
      // May return results from fallback query or empty array
      expect(stats.length).toBeGreaterThanOrEqual(0);
    });

    test("returns empty array when the fallback also fails", async () => {
      mockExecuteFn = async () => {
        throw new Error("ORA-00942: table or view does not exist");
      };

      await provider.connect();
      const stats = await provider.getStorageStats();

      expect(stats).toEqual([]);
    });
  });

  // =========================================================================
  // 20. Error mapping
  // =========================================================================

  describe("error mapping", () => {
    test("ORA-01017 maps to auth error", async () => {
      mockExecuteFn = async () => {
        throw new Error("ORA-01017: invalid username/password; logon denied");
      };

      await provider.connect();

      try {
        await provider.query("SELECT 1 FROM DUAL");
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.name).toBe("AuthenticationError");
        expect(err.message).toContain("Authentication failed");
      }
    });

    test("ORA-12541 maps to connection error", async () => {
      mockExecuteFn = async () => {
        throw new Error("ORA-12541: TNS:no listener");
      };

      await provider.connect();

      try {
        await provider.query("SELECT 1 FROM DUAL");
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.name).toBe("ConnectionError");
        expect(err.message).toContain("Oracle");
      }
    });
  });

  // =========================================================================
  // 21. Thick-mode opt-in (ORACLE_CLIENT_LIB_DIR)
  // =========================================================================

  describe("Thick-mode opt-in (ORACLE_CLIENT_LIB_DIR)", () => {
    // The init mock records call counts across the whole file; clear them per
    // test so these assertions don't depend on execution order. The provider's
    // module-level "already initialized" flag is a process-wide singleton that
    // cannot be reset, so the tests that expect init to actually run (the
    // failing-load case and the at-most-once case) must stay ordered before any
    // test that lets a successful init flip that flag permanently.
    beforeEach(() => {
      mockInitOracleClientFn.mockClear();
    });

    afterEach(() => {
      delete process.env.ORACLE_CLIENT_LIB_DIR;
    });

    test("does not call initOracleClient when ORACLE_CLIENT_LIB_DIR is unset", () => {
      // beforeEach already constructed one provider with the env var unset;
      // construct another to be sure.
      new OracleProvider(baseConfig);
      expect(mockInitOracleClientFn).not.toHaveBeenCalled();
    });

    test("surfaces a failed Instant Client load as a DatabaseConfigError pointing at ORACLE_CLIENT_LIB_DIR", () => {
      process.env.ORACLE_CLIENT_LIB_DIR = "/nonexistent/instantclient";
      mockInitOracleClientFn.mockImplementationOnce(() => {
        throw new Error("DPI-1047: Cannot locate a 64-bit Oracle Client library");
      });

      let caught: unknown;
      try {
        new OracleProvider(baseConfig);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DatabaseConfigError);
      expect((caught as Error).message).toContain("ORACLE_CLIENT_LIB_DIR");
      expect((caught as Error).message).toContain("/nonexistent/instantclient");
      expect((caught as Error).message).toContain("DPI-1047");
    });

    test("calls initOracleClient with libDir at most once, even across multiple providers", () => {
      process.env.ORACLE_CLIENT_LIB_DIR = "/opt/oracle/instantclient";

      new OracleProvider(baseConfig);
      new OracleProvider(baseConfig);

      expect(mockInitOracleClientFn).toHaveBeenCalledTimes(1);
      expect(mockInitOracleClientFn).toHaveBeenCalledWith({ libDir: "/opt/oracle/instantclient" });
    });
  });
});

// ---------------------------------------------------------------------------
// Declared column types
// ---------------------------------------------------------------------------

/**
 * `oracledb` is the one driver of the four that hands over a NAME: `metaData[].
 * dbTypeName`, uppercase, the same word `ALL_TAB_COLUMNS.DATA_TYPE` uses. The names
 * below are verbatim from Oracle AI Database 26ai Free over `r5_types`, plus the
 * `TIMESTAMP WITH TIME ZONE` that `SYSTIMESTAMP` declares.
 */
describe("OracleProvider declared column types", () => {
  let provider: InstanceType<typeof OracleProvider>;

  beforeEach(() => {
    mockConnCloseFn = async () => {};
    mockBreakFn = async () => {};
    mockPoolCloseFn = async () => {};
    mockCreatePoolFn = async () => createMockPool();
    provider = new OracleProvider(baseConfig);
  });

  afterEach(async () => {
    if (provider?.isConnected()) await provider.disconnect();
  });

  test("query() passes dbTypeName through as Oracle's own spelling", async () => {
    mockExecuteFn = async () => ({
      rows: [{ PRICE: 19.99, TS: new Date("2026-08-23T17:46:34Z"), N: new Date("2026-08-23T17:46:34Z") }],
      metaData: [
        { name: "PRICE", dbTypeName: "NUMBER", precision: 10, scale: 2 },
        { name: "TS", dbTypeName: "TIMESTAMP", precision: 6 },
        { name: "N", dbTypeName: "TIMESTAMP WITH TIME ZONE", precision: 6 },
      ],
    });

    await provider.connect();
    const result = await provider.query("SELECT price, ts, SYSTIMESTAMP AS n FROM r5_types");

    // Precision and scale sit right beside the name and are deliberately not spelled
    // into it: `COUNT(*)` reports precision 0 and `1/3` scale -127, so a `NUMBER(p,s)`
    // built from them would claim something the engine did not.
    expect(result.columnTypes).toEqual({
      PRICE: "NUMBER",
      TS: "TIMESTAMP",
      N: "TIMESTAMP WITH TIME ZONE",
    });
  });

  test("the key is omitted entirely when the metadata names no type", async () => {
    mockExecuteFn = async () => ({ rows: [], metaData: [{ name: "X" }] });

    await provider.connect();
    const result = await provider.query("SELECT x FROM r5_types");

    expect(result.columnTypes).toBeUndefined();
    expect(Object.hasOwn(result, "columnTypes")).toBe(false);
  });

  test("queryInTransaction() declares them too", async () => {
    mockExecuteFn = async () => ({
      rows: [{ B: null }],
      metaData: [{ name: "B", dbTypeName: "BLOB" }],
    });

    await provider.connect();
    await provider.beginTransaction();
    const result = await provider.queryInTransaction("SELECT b FROM r5_types");

    expect(result.columnTypes).toEqual({ B: "BLOB" });
    await provider.rollbackTransaction();
  });
});
