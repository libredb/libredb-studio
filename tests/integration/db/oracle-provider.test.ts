import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type oracledb from "oracledb";
import { ConnectionError, DatabaseConfigError, DatabaseError, QueryError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import { asBytes } from "@/lib/export/binary";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

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
      // One held connection carries the transaction, so the trio is offered (#464).
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

  describe("getSchema()", () => {});

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

      // Still a valid health object even though every V$ view refused: the reads that
      // do not need a V$ grant answer. This used to assert `activeConnections` was 0,
      // which pinned the fabrication rather than the degradation - see the pair below.
      expect(health).toBeDefined();
      expect(health.databaseSize).toBe("256 MB");
      expect(health.slowQueries).toEqual([]);
      expect(health.activeSessions).toEqual([]);
    });

    test("an unprivileged V$SESSION leaves activeConnections absent, never a measured 0", async () => {
      // A user granted only CREATE SESSION cannot read the V$ views at all. What was
      // measured 2026-08-23 on Oracle AI Database 26ai Free is the same ORA-00942 on
      // the cache-ratio view (`table or view "SYS"."V_$SYSSTAT" does not exist`, the
      // getPerformanceMetrics test below); the count needs the same grant, so this
      // fixture reproduces the shape with the view this block reads.
      // The block was guarded, but `let activeConnections = 0` then published the
      // refusal as a server with no active sessions - and `HealthInfo` is what the
      // agent's curated health reading forwards to the model, so that zero was a
      // measurement about a figure Oracle never gave.
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$SESSION") && upper.includes("COUNT")) {
          throw new Error('ORA-00942: table or view "SYS"."V_$SESSION" does not exist');
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const health = await provider.getHealth();

      expect("activeConnections" in health).toBe(false);
      // Only the refused count goes absent; the other reads still answer.
      expect(health.cacheHitRatio).toBe("97.5%");
      expect(health.databaseSize).toBe("256 MB");
    });

    test("an instance with no active sessions keeps its measured zero connections", async () => {
      // The anti-vacuity twin of the test above. Absence must never be spelled with a
      // falsy test (`activeConnections || undefined`): an idle instance measures 0 and
      // that 0 is a reading, not a refusal.
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$SESSION") && upper.includes("COUNT")) {
          return { rows: [{ CNT: 0 }], metaData: [{ name: "CNT" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const health = await provider.getHealth();

      expect("activeConnections" in health).toBe(true);
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
    // Database 26ai Free on 2026-08-25, then re-run after this fix (#496).
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
      // Not `toBe(0)` any more: this assertion pinned the fabrication rather than the
      // degradation. `maxConnections` is different and stays 0 - its own docblock in
      // src/lib/db/types.ts says 0 MEANS "no limit published" there, so 0 and absence
      // are the same fact for the ceiling and different facts for the count.
      expect("activeConnections" in overview).toBe(false);
      expect(overview.maxConnections).toBe(0);
      // Same correction, one field over. This read `toBe(0)` until #565 and pinned the
      // fabrication too: `DatabaseOverview.databaseSizeBytes` is optional for the same
      // reason the count above is, and `USER_SEGMENTS` refusing tells us nothing about
      // the schema's size. The string travels with it, as in the merged libSQL (#569)
      // and search (#517) shapes - "N/A" beside an absent figure, never "0 bytes"
      // beside "No storage size information available."
      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
      expect(overview.tableCount).toBe(0);
      expect(overview.indexCount).toBe(0);
    });

    test("an unprivileged V$SESSION leaves overview activeConnections absent, never a measured 0", async () => {
      // The same defect getHealth() was already corrected for, in the same file: the
      // block was guarded but `let activeConnections = 0` published the refusal as an
      // instance with no user session. Oracle's own Database Reference states that
      // "after installation, only user SYS or anyone with SYSDBA privilege has access
      // to the dynamic performance tables", so a plain schema user is the ORDINARY
      // case here, not an exotic one - and the refusal shape was measured 2026-08-23
      // on Oracle AI Database 26ai Free against a user granted only CREATE SESSION
      // (`ORA-00942: table or view "SYS"."V_$SYSSTAT" does not exist`); V_$SESSION
      // answers in the same shape when the grant is missing.
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$SESSION") && upper.includes("COUNT")) {
          throw new Error('ORA-00942: table or view "SYS"."V_$SESSION" does not exist');
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect("activeConnections" in overview).toBe(false);
      // Only the refused count goes absent; every other read still answers.
      expect(overview.version).toContain("Oracle");
      expect(overview.tableCount).toBe(10);
      expect(overview.databaseSizeBytes).toBe(268435456);
    });

    test("an instance with no user session keeps its measured zero connections", async () => {
      // The anti-vacuity twin of the test above. Absence must never be spelled with a
      // falsy test (`Number(...) || undefined`): an instance whose only USER session is
      // this very pool's own could still count 0 at the moment of the read, and that 0
      // is a reading rather than a refusal.
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$SESSION") && upper.includes("COUNT")) {
          return { rows: [{ CNT: 0 }], metaData: [{ name: "CNT" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect("activeConnections" in overview).toBe(true);
      expect(overview.activeConnections).toBe(0);
    });

    test("keeps the measured count when only the sessions ceiling is refused", async () => {
      // Both reads share one try block, and the count is assigned before the ceiling
      // is attempted - so a V$PARAMETER refusal must not carry the count away with it.
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$PARAMETER")) {
          throw new Error('ORA-00942: table or view "SYS"."V_$PARAMETER" does not exist');
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect(overview.activeConnections).toBe(8);
      expect(overview.maxConnections).toBe(0);
    });

    test("a schema that owns no segment keeps its measured zero size", async () => {
      // The anti-vacuity twin of the absence pinned above, and why the guard is spelled
      // `=== undefined` rather than a falsy test. `SUM(BYTES) FROM USER_SEGMENTS` over a
      // schema that owns no segment is not a refusal: Oracle answers one row whose
      // aggregate is NULL. The provider deliberately treats that returned null aggregate
      // as a measured 0 for a schema that really does hold nothing. A falsy test would erase exactly this
      // reading, and StorageTab.tsx would say "No storage size information available"
      // about a schema Oracle had just measured.
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("USER_SEGMENTS") && upper.includes("SUM(BYTES)")) {
          return { rows: [{ TOTAL: null }], metaData: [{ name: "TOTAL" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(true);
      expect(overview.databaseSizeBytes).toBe(0);
      expect(overview.databaseSize).toBe("0 B");
      // Only the size reading is at stake; every other read still answers.
      expect(overview.activeConnections).toBe(8);
      expect(overview.tableCount).toBe(10);
    });

    test("a size read with no result row leaves overview size absent", async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("USER_SEGMENTS") && upper.includes("SUM(BYTES)")) {
          return { rows: [], metaData: [{ name: "TOTAL" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
    });

    test("a size result without the expected column leaves overview size absent", async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("USER_SEGMENTS") && upper.includes("SUM(BYTES)")) {
          return { rows: [{ unrelated: 1 }], metaData: [{ name: "UNRELATED" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
    });

    test("a non-finite size leaves overview size absent", async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("USER_SEGMENTS") && upper.includes("SUM(BYTES)")) {
          return { rows: [{ TOTAL: Number.POSITIVE_INFINITY }], metaData: [{ name: "TOTAL" }] };
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
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
      // The old message said "verify the path" for every failure. DPI-1047 on
      // Linux is usually not a path problem at all: libclntsh has no RUNPATH,
      // so the directory has to be on the loader path too (#538).
      expect((caught as Error).message).toContain("ldconfig");
    });

    test("reports a missing Thick-mode binary (NJS-045) as a packaging defect, not a bad path", () => {
      process.env.ORACLE_CLIENT_LIB_DIR = "/opt/oracle/instantclient_19_28";
      mockInitOracleClientFn.mockImplementationOnce(() => {
        throw new Error("NJS-045: cannot load a node-oracledb Thick mode binary for Node.js");
      });

      let caught: unknown;
      try {
        new OracleProvider(baseConfig);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DatabaseConfigError);
      expect((caught as Error).message).toContain("NJS-045");
      expect((caught as Error).message).toContain(`${process.platform}-${process.arch}`);
      expect((caught as Error).message).toContain("packaging");
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

// ---------------------------------------------------------------------------
// The object surface (#789), and the bug it closes (#765)
// ---------------------------------------------------------------------------

/**
 * `makeProvider()` is local rather than shared with the blocks above: these tests each
 * install their own `mockExecuteFn` before connecting, so they need a provider built after
 * that assignment and no `afterEach` reaching for a shared handle.
 */
describe("object surface", () => {
  beforeEach(() => {
    mockExecuteFn = async (sql: string) => defaultExecute(sql);
    mockConnCloseFn = async () => {};
    mockBreakFn = async () => {};
    mockPoolCloseFn = async () => {};
    mockCreatePoolFn = async () => createMockPool();
  });

  function makeProvider(overrides: Partial<DatabaseConnection> = {}) {
    return new OracleProvider({ ...baseConfig, ...overrides });
  }

  test("declares the kinds Oracle has, with the package spec and body as one kind", () => {
    const capabilities = makeProvider().getCapabilities();
    const kinds = capabilities.objectKinds ?? [];

    expect(kinds.map((k) => k.id).sort()).toEqual([
      "function",
      "materialized_view",
      "package",
      "procedure",
      "sequence",
      "synonym",
      "table",
      "trigger",
      "view",
    ]);
    // A package is one tree node holding routines, not two rows and not a routine itself.
    expect(kinds.find((k) => k.id === "package")?.role).toBe("group");
    expect(kinds.find((k) => k.id === "package")?.childKinds).toEqual(["procedure", "function"]);
    expect(kinds.find((k) => k.id === "trigger")?.attachedTo).toBe("table");
    expect(kinds.find((k) => k.id === "table")?.acceptsRowWrites).toBe(true);
    // Oracle updates a key-preserved view and refuses the rest, which is a per-object fact
    // this per-kind declaration cannot state; a materialized view takes no write at all.
    expect(kinds.find((k) => k.id === "view")?.acceptsRowWrites).toBeUndefined();
    expect(kinds.find((k) => k.id === "materialized_view")?.acceptsRowWrites).toBeUndefined();
    // No `index` kind: Oracle models an index as an attribute of the table it is on, so it
    // belongs in describeObject's output rather than in a folder of its own.
    expect(kinds.find((k) => k.id === "index")).toBeUndefined();
    expect(capabilities.containerLevels).toEqual([{ id: "schema", label: "Schema", labelPlural: "Schemas" }]);
  });

  test("the container is the connecting user, and other owners are reachable", async () => {
    const statements: string[] = [];
    mockExecuteFn = async (sql: string) => {
      statements.push(sql);
      if (!sql.includes("ALL_USERS")) return { rows: [] };
      return {
        rows: [
          { NAME: "APP", IS_SESSION_DEFAULT: 1 },
          { NAME: "REPORTING", IS_SESSION_DEFAULT: 0 },
        ],
      };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const containers = await provider.listContainers();
    expect(containers.map((c) => c.name)).toEqual(["APP", "REPORTING"]);
    expect(containers.map((c) => c.path)).toEqual([["APP"], ["REPORTING"]]);
    expect(containers.find((c) => c.name === "APP")?.isSessionDefault).toBe(true);
    expect(containers.find((c) => c.name === "REPORTING")?.isSessionDefault).toBe(false);
    // The confinement this task lifts. getSchema() hard-scopes every read to
    // OWNER = <connecting user>, which is why the app showed exactly one schema; the
    // container read is bound to nothing at all.
    expect(statements[0]).not.toContain(":1");
    expect(statements[0]).toContain("ALL_USERS");
    // Oracle's own answer for who is connected, rather than the configured user: it is
    // right under external authentication and right for a quoted lower-case user, and it
    // is what keeps the session's own owner in the list when Oracle maintains it.
    expect(statements[0]).toContain("SYS_CONTEXT('USERENV','SESSION_USER')");
    await provider.disconnect();
  });

  test("a package spec and its body collapse to one object carrying both statuses", async () => {
    // Three packages, not one, and the rows are deliberately not in a consistent order.
    // A test with only a valid package cannot tell a working collapse from no collapse at
    // all, and a single ordering cannot tell a merge from "the first row wins" or "the
    // last row wins".
    mockExecuteFn = async (sql: string) => {
      if (!sql.includes("ALL_OBJECTS")) return { rows: [] };
      return {
        rows: [
          { NAME: "APP_BROKEN_PKG", OBJECT_TYPE: "PACKAGE", STATUS: "VALID" },
          { NAME: "APP_BROKEN_PKG", OBJECT_TYPE: "PACKAGE BODY", STATUS: "INVALID" },
          { NAME: "APP_ORDERS_PKG", OBJECT_TYPE: "PACKAGE BODY", STATUS: "VALID" },
          { NAME: "APP_ORDERS_PKG", OBJECT_TYPE: "PACKAGE", STATUS: "VALID" },
          { NAME: "APP_LEGACY_PKG", OBJECT_TYPE: "PACKAGE BODY", STATUS: "INVALID" },
          { NAME: "APP_LEGACY_PKG", OBJECT_TYPE: "PACKAGE", STATUS: "VALID" },
        ],
      };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const packages = await provider.listObjects(["APP"], "package");
    expect(packages).toHaveLength(3);
    expect(packages).toEqual([
      { path: ["APP", "APP_BROKEN_PKG"], name: "APP_BROKEN_PKG", kind: "package", status: "INVALID" },
      { path: ["APP", "APP_LEGACY_PKG"], name: "APP_LEGACY_PKG", kind: "package", status: "INVALID" },
      { path: ["APP", "APP_ORDERS_PKG"], name: "APP_ORDERS_PKG", kind: "package", status: "VALID" },
    ]);
    await provider.disconnect();
  });

  test("counting does not read a single column of a single table", async () => {
    // #765: the old getSchema() ran five bulk ALL_* queries over the whole owner on
    // connect, materialising about 1.6 million rows before the UI could paint.
    const statements: string[] = [];
    mockExecuteFn = async (sql: string) => {
      statements.push(sql);
      return { rows: [{ KIND: "TABLE", N: 43512 }] };
    };
    const provider = makeProvider({ user: "sysadm" });
    await provider.connect();

    const counts = await provider.countObjects(["SYSADM"]);
    expect(statements.some((s) => s.includes("ALL_TAB_COLUMNS"))).toBe(false);
    expect(statements.some((s) => s.includes("ALL_IND_COLUMNS"))).toBe(false);
    // The control for the two negatives above: a statement WAS issued and it was the
    // dictionary read, so "never touched" is a measurement rather than an empty log.
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("ALL_OBJECTS");
    expect(counts.table).toEqual({ count: 43512 });
    // Seeded before the read: a declared kind the GROUP BY did not answer for holds none,
    // which is a different fact from a kind Oracle does not have.
    expect(counts.view).toEqual({ count: 0 });
    expect(counts.package).toEqual({ count: 0 });
    await provider.disconnect();
  });

  test("satisfies the shared object surface contract", async () => {
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      if (sql.includes("ALL_USERS")) {
        return {
          rows: [
            { NAME: "APP", IS_SESSION_DEFAULT: 1 },
            { NAME: "REPORTING", IS_SESSION_DEFAULT: 0 },
          ],
        };
      }
      if (sql.includes("GROUP BY")) {
        return {
          rows: [
            { KIND: "TABLE", N: 2 },
            { KIND: "VIEW", N: 1 },
            { KIND: "PACKAGE", N: 2 },
            { KIND: "TRIGGER", N: 1 },
          ],
        };
      }
      if (sql.includes("ALL_TRIGGERS")) {
        return { rows: [{ NAME: "APP_ORDERS_TRG", PARENT: "APP_ORDERS", STATUS: "VALID" }] };
      }
      // The bulk column read's five statements (#789), each carrying the `described` CTE.
      // Before the per-type arms below, which bind the same two parameters.
      if (sql.includes("WITH described AS")) {
        const type = (params ?? [])[1];
        const names = type === "TABLE" ? ["APP_ORDERS", "APP_CUSTOMERS"] : type === "VIEW" ? ["APP_ORDER_SUMMARY"] : [];
        const bound = sql.includes("FETCH FIRST") ? Number((params ?? [])[2]) : undefined;
        const described = bound === undefined ? names : names.slice(0, bound);
        if (sql.includes("SELECT d.NAME FROM described d")) return { rows: described.map((NAME) => ({ NAME })) };
        if (sql.includes("ALL_TAB_COLUMNS")) {
          return {
            rows: described.map((NAME) => ({
              OBJECT_NAME: NAME,
              COLUMN_NAME: "ID",
              DATA_TYPE: "NUMBER",
              NULLABLE: "N",
              DATA_DEFAULT: null,
            })),
          };
        }
        return { rows: [] };
      }
      // The FLAT reading, over the SAME objects the object surface lists (#789).
      //
      // The guard inside `assertObjectSurface` joins `getSchema()`'s names to the object
      // paths with the app's own rule, and this double answered `getSchema()` nothing at
      // all: none of its five statements matched an arm, so every one fell through to the
      // per-type block below, which keys on a parameter they do not bind, and the flat
      // reading reached the guard EMPTY.
      //
      // After the bulk block, because `SCHEMA_COLUMNS_SQL` also reads `ALL_TAB_COLUMNS`.
      //
      // The rows are the DRIVER'S rows and the naming is left to `oracle.ts`, which spells
      // a flat name BARE: the read is scoped to the connection owner by `WHERE OWNER = :1`
      // (`oracle.ts:1516`), so the owner is a fact about the statement rather than a
      // qualifier on the answer, and every name comes back unqualified against a
      // `[owner, name]` path. A fixture that returned `APP.APP_ORDERS` would assert a
      // spelling this provider never produces.
      //
      // `ALL_TABLES` holds tables alone, so the view `APP_ORDER_SUMMARY` is correctly
      // absent from the flat reading while the object surface lists it. The join has to
      // survive a flat reading NARROWER than the listing, and that is real here rather
      // than arranged.
      if (sql.includes("FROM ALL_TABLES")) {
        return {
          rows: [
            { TABLE_NAME: "APP_ORDERS", NUM_ROWS: 2 },
            { TABLE_NAME: "APP_CUSTOMERS", NUM_ROWS: 1 },
          ],
        };
      }
      if (sql.includes("ALL_TAB_COLUMNS")) {
        return {
          rows: ["APP_ORDERS", "APP_CUSTOMERS"].map((TABLE_NAME) => ({
            TABLE_NAME,
            COLUMN_NAME: "ID",
            DATA_TYPE: "NUMBER",
            NULLABLE: "N",
            DATA_DEFAULT: null,
            COLUMN_ID: 1,
          })),
        };
      }
      if (sql.includes("CONSTRAINT_TYPE = 'P'")) {
        return { rows: [{ TABLE_NAME: "APP_ORDERS", COLUMN_NAME: "ID" }] };
      }
      if (sql.includes("CONSTRAINT_TYPE = 'R'")) {
        return {
          rows: [
            {
              TABLE_NAME: "APP_ORDERS",
              COLUMN_NAME: "CUSTOMER_ID",
              REF_TABLE: "APP_CUSTOMERS",
              REF_COLUMN: "ID",
            },
          ],
        };
      }
      if (sql.includes("FROM ALL_INDEXES")) {
        return {
          rows: [
            {
              TABLE_NAME: "APP_ORDERS",
              INDEX_NAME: "APP_ORDERS_PK",
              UNIQUENESS: "UNIQUE",
              COLUMN_NAME: "ID",
              COLUMN_POSITION: 1,
            },
          ],
        };
      }
      // One row set per bound dictionary type, and they must be DISTINCT: the shared
      // helper lists every counted kind and requires paths unique within each of them.
      const type = (params ?? [])[1];
      if (type === "TABLE") {
        return {
          rows: [
            { NAME: "APP_ORDERS", STATUS: "VALID" },
            { NAME: "APP_CUSTOMERS", STATUS: "VALID" },
          ],
        };
      }
      if (type === "VIEW") return { rows: [{ NAME: "APP_ORDER_SUMMARY", STATUS: "VALID" }] };
      if (type === "PACKAGE") {
        return {
          rows: [
            { NAME: "APP_ORDERS_PKG", OBJECT_TYPE: "PACKAGE", STATUS: "VALID" },
            { NAME: "APP_ORDERS_PKG", OBJECT_TYPE: "PACKAGE BODY", STATUS: "VALID" },
            { NAME: "APP_BROKEN_PKG", OBJECT_TYPE: "PACKAGE", STATUS: "VALID" },
            { NAME: "APP_BROKEN_PKG", OBJECT_TYPE: "PACKAGE BODY", STATUS: "INVALID" },
          ],
        };
      }
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    await assertObjectSurface(provider, {
      containers: [["APP"], ["REPORTING"]],
      kinds: { table: 2, view: 1, package: 2, trigger: 1 },
      sampleObject: { path: ["APP", "APP_ORDERS"], kind: "table" },
    });
    await provider.disconnect();
  });
});

/**
 * The rest of the object surface: the dictionary reads behind each kind, the detail row,
 * and the refusals. Kept out of the block above so `-t "object surface"` still runs
 * exactly the five conformance tests.
 */
describe("Oracle object listing and detail", () => {
  beforeEach(() => {
    mockExecuteFn = async (sql: string) => defaultExecute(sql);
    mockConnCloseFn = async () => {};
    mockBreakFn = async () => {};
    mockPoolCloseFn = async () => {};
    mockCreatePoolFn = async () => createMockPool();
  });

  function makeProvider(overrides: Partial<DatabaseConnection> = {}) {
    return new OracleProvider({ ...baseConfig, ...overrides });
  }

  test("a container path that is not one owner is refused, rather than read as empty", async () => {
    mockExecuteFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    // Not [] and not a zero count: binding undefined to :1 would answer an owner holding
    // nothing, which is indistinguishable from a real empty owner.
    await expect(provider.countObjects([])).rejects.toThrow(QueryError);
    await expect(provider.listObjects(["CATALOG", "APP"], "table")).rejects.toThrow(/container path is \[schema\]/);
    await provider.disconnect();
  });

  test("nothing nests under an owner", async () => {
    mockExecuteFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    expect(await provider.listContainers(["APP"])).toEqual([]);
    await provider.disconnect();
  });

  test("a kind this engine does not declare is refused, not answered empty", async () => {
    mockExecuteFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    await expect(provider.listObjects(["APP"], "dictionary")).rejects.toThrow(/declares no object kind "dictionary"/);
    await expect(provider.describeObject(["APP", "X"], "dictionary")).rejects.toThrow(
      /declares no object kind "dictionary"/,
    );
    await provider.disconnect();
  });

  test("every owner-bound read uses the container it was asked for, not the connecting user", async () => {
    // The whole point of #765's second half, and the regression it must never take again.
    // All THREE owner-bound methods are pinned here, because each one is a separate place
    // `this.config.user.toUpperCase()` can creep back into: pinning only the listing left
    // that substitution in countObjects and describeObject passing the whole suite. Every
    // container below is deliberately NOT the connecting user, so a read that ignored its
    // argument cannot look correct by coincidence.
    const bound: unknown[][] = [];
    mockExecuteFn = async (_sql: string, params?: unknown[]) => {
      bound.push(params ?? []);
      return { rows: [{ NAME: "REPORT_DAILY", STATUS: "VALID", COLUMN_NAME: "REPORT_DAY", DATA_TYPE: "DATE" }] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const objects = await provider.listObjects(["REPORTING"], "table");
    expect(bound[0][0]).toBe("REPORTING");
    expect(objects).toEqual([
      { path: ["REPORTING", "REPORT_DAILY"], name: "REPORT_DAILY", kind: "table", status: "VALID" },
    ]);

    bound.length = 0;
    await provider.countObjects(["REPORTING"]);
    expect(bound).toHaveLength(1);
    expect(bound[0]).toEqual(["REPORTING"]);

    bound.length = 0;
    await provider.describeObject(["REPORTING", "REPORT_DAILY"], "table");
    expect(bound).toHaveLength(4);
    for (const params of bound) expect(params).toEqual(["REPORTING", "REPORT_DAILY"]);
    await provider.disconnect();
  });

  test("every declared kind binds its own dictionary spelling, and a package binds both of its rows", async () => {
    // Derived from the declaration rather than pinned to a list: a kind added to
    // objectKinds without an entry in the vocabulary table fails here instead of drawing
    // a folder nothing can fill.
    const bound = new Map<string, unknown[]>();
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const declared = (provider.getCapabilities().objectKinds ?? []).map((k) => k.id);
    expect(declared.length).toBeGreaterThan(0);
    for (const kind of declared) {
      mockExecuteFn = async (_sql: string, params?: unknown[]) => {
        bound.set(kind, params ?? []);
        return { rows: [] };
      };
      await provider.listObjects(["APP"], kind);
    }

    // Eight kinds are one ALL_OBJECTS row each; a package is two rows collapsed into one
    // node, so it binds both spellings.
    expect(bound.get("table")?.slice(1)).toEqual(["TABLE"]);
    expect(bound.get("view")?.slice(1)).toEqual(["VIEW"]);
    expect(bound.get("materialized_view")?.slice(1)).toEqual(["MATERIALIZED VIEW"]);
    expect(bound.get("synonym")?.slice(1)).toEqual(["SYNONYM"]);
    expect(bound.get("sequence")?.slice(1)).toEqual(["SEQUENCE"]);
    expect(bound.get("procedure")?.slice(1)).toEqual(["PROCEDURE"]);
    expect(bound.get("function")?.slice(1)).toEqual(["FUNCTION"]);
    expect(bound.get("package")?.slice(1)).toEqual(["PACKAGE", "PACKAGE BODY"]);
    // The trigger listing is ALL_OBJECTS too, so it binds its dictionary spelling like the
    // other eight rather than naming 'TRIGGER' in its own text.
    expect(bound.get("trigger")?.slice(1)).toEqual(["TRIGGER"]);
    expect(bound.size).toBe(declared.length);
    await provider.disconnect();
  });

  test("the count statement never counts a package body, and never counts a materialized view twice", async () => {
    // Two facts measured on Oracle Database 21c XE, both of which turn a badge into a lie
    // if they are missed. A PACKAGE BODY is a second dictionary row for one tree node.
    // CREATE MATERIALIZED VIEW writes a TABLE row of the same name for its container, and
    // an owner with 100 materialized views then reports 100 tables nobody created.
    let counted = "";
    mockExecuteFn = async (sql: string) => {
      if (sql.includes("GROUP BY")) counted = sql;
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();
    await provider.countObjects(["APP"]);

    expect(counted).toContain("ALL_OBJECTS");
    expect(counted).not.toContain("PACKAGE BODY");
    // Both halves of the container-table rule, because either one alone is inert: the
    // window only NOTICES the twin and the filter is what drops it. Oracle executes them,
    // so this is all a unit test can see; the live acceptance run measures the effect
    // (the fixture owner holds three ALL_OBJECTS TABLE rows and two tables, badge 2).
    expect(counted).toContain("CASE WHEN o.OBJECT_TYPE = 'MATERIALIZED VIEW'");
    expect(counted).toContain("OVER (PARTITION BY o.OBJECT_NAME)");
    expect(counted).toContain("WHERE NOT (KIND = 'TABLE' AND MV_TWIN > 0)");
    // The IN list is derived from the same vocabulary table the listings bind from, so it
    // carries exactly one literal per declared kind. Derived, never pinned to a number: a
    // guard that asserted "nine" would have to be edited for every kind added and would
    // then be asserting the inventory rather than the invariant.
    const declared = provider.getCapabilities().objectKinds ?? [];
    const inList = counted.match(/IN \(([^)]*)\)/)?.[1] ?? "";
    expect(inList.match(/'[A-Z ]+'/g) ?? []).toHaveLength(declared.length);
    await provider.disconnect();
  });

  test("a materialized view's container table is excluded from the table listing", async () => {
    let listed = "";
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      if ((params ?? [])[1] === "TABLE") listed = sql;
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();
    await provider.listObjects(["APP"], "table");

    // The rule needs no second dictionary view: measured on 21c XE, a TABLE and a
    // MATERIALIZED VIEW cannot share a name in one owner (ORA-00955), so a same-named
    // pair is always the materialized view's own container.
    expect(listed).toContain("NOT EXISTS");
    expect(listed).toContain("m.OBJECT_TYPE = 'MATERIALIZED VIEW'");
    await provider.disconnect();
  });

  test("a trigger nests under the object it is attached to, wherever that object lives", async () => {
    mockExecuteFn = async (sql: string) => {
      if (!sql.includes("ALL_TRIGGERS")) return { rows: [] };
      return {
        rows: [
          { NAME: "APP_ORDERS_TRG", PARENT: "APP_ORDERS", STATUS: "VALID" },
          // ALL_TRIGGERS separates OWNER from TABLE_OWNER, and a trigger on another
          // owner's table is a real case. It stays in the container that OWNS it.
          { NAME: "REPORT_DAILY_TRG", PARENT: "REPORT_DAILY", STATUS: "VALID" },
          // Two rows with no parent, for the TWO reasons the outer join answers NULL, and
          // they are deliberately indistinguishable here. A SCHEMA or DATABASE trigger has
          // no base object at all (measured: TABLE_NAME NULL, BASE_OBJECT_TYPE SCHEMA),
          // and a trigger whose base table this user cannot see has no ALL_TRIGGERS row to
          // read one from. Both hang off the container, and both are LISTED, which is what
          // keeps the folder equal to the badge.
          { NAME: "APP_LOGON_TRG", PARENT: null, STATUS: "VALID" },
          { NAME: "APP_HIDDEN_BASE_TRG", PARENT: null, STATUS: "VALID" },
        ],
      };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    expect(await provider.listObjects(["APP"], "trigger")).toEqual([
      { path: ["APP", "APP_HIDDEN_BASE_TRG"], name: "APP_HIDDEN_BASE_TRG", kind: "trigger", status: "VALID" },
      { path: ["APP", "APP_LOGON_TRG"], name: "APP_LOGON_TRG", kind: "trigger", status: "VALID" },
      { path: ["APP", "APP_ORDERS", "APP_ORDERS_TRG"], name: "APP_ORDERS_TRG", kind: "trigger", status: "VALID" },
      { path: ["APP", "REPORT_DAILY", "REPORT_DAILY_TRG"], name: "REPORT_DAILY_TRG", kind: "trigger", status: "VALID" },
    ]);
    await provider.disconnect();
  });

  test("the trigger count and the trigger listing read one catalog, so the badge cannot outrun the folder", async () => {
    // Standing ruling 5f: the listing must contain exactly what the count counted. The
    // count reads ALL_OBJECTS, and ALL_TRIGGERS is exposed by BASE-TABLE accessibility
    // rather than by ownership, so an INNER join to it silently drops triggers the count
    // already counted. On the owner this task unlocks - somebody else's - the badge would
    // then say 3 and the folder open with fewer, which is the defect ruling 5f names.
    const statements = new Map<string, string>();
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      statements.set(sql.includes("GROUP BY") ? "count" : String((params ?? [])[1]), sql);
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();
    await provider.countObjects(["REPORTING"]);
    await provider.listObjects(["REPORTING"], "trigger");

    const counted = statements.get("count") ?? "";
    const listed = statements.get("TRIGGER") ?? "";
    expect(counted).toContain("FROM ALL_OBJECTS");
    // The same spine, so the two reads see the same population.
    expect(listed).toContain("FROM ALL_OBJECTS");
    expect(listed).not.toContain("FROM ALL_TRIGGERS");
    // ALL_TRIGGERS still supplies the parent segment, and only that, outer-joined so a
    // missing row costs the segment rather than the object.
    expect(listed).toContain("LEFT JOIN ALL_TRIGGERS");
    await provider.disconnect();
  });

  test("a refused count is reported as unavailable, never as zero", async () => {
    mockExecuteFn = async () => {
      throw Object.assign(new Error("ORA-00942: table or view does not exist"), { errorNum: 942 });
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const counts = await provider.countObjects(["SALES"]);
    for (const kind of provider.getCapabilities().objectKinds ?? []) {
      expect(counts[kind.id]).toEqual({ unavailable: "ORA-00942: table or view does not exist" });
    }
    await provider.disconnect();
  });

  test("a server without ALL_USERS.ORACLE_MAINTAINED loses the filter, not the container list", async () => {
    // ORACLE_MAINTAINED arrived in 12.1. Thin mode refuses anything older (NJS-138), but
    // Thick mode is an explicit opt-in for exactly those servers, so an 11.2 instance
    // answering ORA-00904 here is a supported configuration.
    const asked: string[] = [];
    mockExecuteFn = async (sql: string) => {
      asked.push(sql);
      if (sql.includes("ORACLE_MAINTAINED")) {
        throw Object.assign(new Error('ORA-00904: "ORACLE_MAINTAINED": invalid identifier'), { errorNum: 904 });
      }
      return { rows: [{ NAME: "SYSTEM", IS_SESSION_DEFAULT: 1 }] };
    };
    const provider = makeProvider({ user: "system" });
    await provider.connect();

    expect(await provider.listContainers()).toEqual([
      { path: ["SYSTEM"], name: "SYSTEM", level: 0, isSessionDefault: true },
    ]);
    expect(asked).toHaveLength(2);
    expect(asked[1]).not.toContain("ORACLE_MAINTAINED");
    await provider.disconnect();
  });

  test("an ORA-00904 that does not name ORACLE_MAINTAINED takes the container list down", async () => {
    // The retry repairs nothing when the missing column is one the fallback keeps, so
    // answering an empty container list there would be a guess dressed as a measurement.
    //
    // The statement WITHOUT the filter answers normally here, and that is the control: a
    // mock that refused both reads would reject whether or not the retry ran, and the
    // assertion would be measuring nothing.
    const asked: string[] = [];
    mockExecuteFn = async (sql: string) => {
      asked.push(sql);
      if (sql.includes("ORACLE_MAINTAINED")) {
        throw Object.assign(new Error('ORA-00904: "USERNAME": invalid identifier'), { errorNum: 904 });
      }
      return { rows: [{ NAME: "APP", IS_SESSION_DEFAULT: 1 }] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    await expect(provider.listContainers()).rejects.toThrow(/"USERNAME": invalid identifier/);
    expect(asked).toHaveLength(1);
    await provider.disconnect();
  });

  test("the container list's own refusal is raised, mapped", async () => {
    mockExecuteFn = async () => {
      throw Object.assign(new Error("ORA-01031: insufficient privileges"), { errorNum: 1031 });
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    await expect(provider.listContainers()).rejects.toThrow(/ORA-01031: insufficient privileges/);
    await provider.disconnect();
  });

  test("a kind that is declared but has no listing statement says so, not that it is undeclared", async () => {
    // Two questions, and only the declaration answers the first. Deciding "declared" from
    // whether a statement exists would report "declares no object kind" about a kind
    // objectKinds does declare.
    mockExecuteFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();
    const real = provider.getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [...(real.objectKinds ?? []), { id: "dictionary", role: "config", label: "D", labelPlural: "Ds" }],
    });

    await expect(provider.listObjects(["APP"], "dictionary")).rejects.toThrow(
      /declares the kind "dictionary" but has no statement that lists it/,
    );
    await provider.disconnect();
  });

  test("a listing refusal is raised, mapped, quoting the statement the server received", async () => {
    mockExecuteFn = async (sql: string) => {
      if (!sql.includes("ALL_TRIGGERS")) return { rows: [] };
      throw Object.assign(new Error("ORA-01031: insufficient privileges"), { errorNum: 1031 });
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const failure = await provider.listObjects(["APP"], "trigger").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DatabaseError);
    expect((failure as DatabaseError).message).toContain("ORA-01031: insufficient privileges");
    // The statement the server actually received, so a reader is pointed at real text.
    expect((failure as DatabaseError).query).toContain("ALL_TRIGGERS");
    await provider.disconnect();
  });

  test("a table's detail carries its columns, primary key, foreign keys and indexes", async () => {
    const bound: unknown[][] = [];
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      bound.push(params ?? []);
      if (sql.includes("ALL_TAB_COLUMNS")) {
        return {
          rows: [
            { COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", NULLABLE: "N", DATA_DEFAULT: null },
            { COLUMN_NAME: "TOTAL", DATA_TYPE: "NUMBER", NULLABLE: "Y", DATA_DEFAULT: "0 " },
            { COLUMN_NAME: "NOTE", DATA_TYPE: "VARCHAR2", NULLABLE: "Y", DATA_DEFAULT: null },
          ],
        };
      }
      if (sql.includes("'P'")) return { rows: [{ COLUMN_NAME: "ID" }] };
      if (sql.includes("'R'")) {
        return {
          rows: [
            { COLUMN_NAME: "REGION_ID", REF_OWNER: "REPORTING", REF_TABLE: "REGIONS", REF_COLUMN: "ID" },
            { COLUMN_NAME: "CUSTOMER_ID", REF_OWNER: "APP", REF_TABLE: "APP_CUSTOMERS", REF_COLUMN: "ID" },
          ],
        };
      }
      return {
        rows: [
          { INDEX_NAME: "REPORT_DAILY_PK", UNIQUENESS: "UNIQUE", COLUMN_NAME: "ID" },
          { INDEX_NAME: "REPORT_DAILY_TOTAL_IX", UNIQUENESS: "NONUNIQUE", COLUMN_NAME: "TOTAL" },
          { INDEX_NAME: "REPORT_DAILY_TOTAL_IX", UNIQUENESS: "NONUNIQUE", COLUMN_NAME: "NOTE" },
        ],
      };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    // The object is in REPORTING and the session is APP, so every bind below has to come
    // from the PATH. With the container equal to the connecting user upper-cased, swapping
    // the binds for `this.config.user.toUpperCase()` leaves this test green.
    const detail = await provider.describeObject(["REPORTING", "REPORT_DAILY"], "table");
    expect(detail.path).toEqual(["REPORTING", "REPORT_DAILY"]);
    expect(detail.columns).toEqual([
      { name: "ID", type: "NUMBER", nullable: false, isPrimary: true, defaultValue: undefined },
      // DATA_DEFAULT is a LONG carrying the source text with its trailing whitespace.
      { name: "TOTAL", type: "NUMBER", nullable: true, isPrimary: false, defaultValue: "0" },
      { name: "NOTE", type: "VARCHAR2", nullable: true, isPrimary: false, defaultValue: undefined },
    ]);
    expect(detail.indexes).toEqual([
      { name: "REPORT_DAILY_PK", columns: ["ID"], unique: true },
      { name: "REPORT_DAILY_TOTAL_IX", columns: ["TOTAL", "NOTE"], unique: false },
    ]);
    // Same spelling getSchema() uses for a same-owner reference; a reference into another
    // owner is qualified, because the bare name would address the wrong table. "Same owner"
    // is the OBJECT's owner and not the session's, which is why the bare one here is the
    // REPORTING reference while the APP one is qualified.
    expect(detail.foreignKeys).toEqual([
      { columnName: "REGION_ID", referencedTable: "REGIONS", referencedColumn: "ID" },
      { columnName: "CUSTOMER_ID", referencedTable: "APP.APP_CUSTOMERS", referencedColumn: "ID" },
    ]);
    // #765 again, one level down: every detail read is narrowed to ONE owner and ONE
    // object. The five reads getSchema() issues are each scoped to the owner alone.
    expect(bound).toHaveLength(4);
    for (const params of bound) expect(params).toEqual(["REPORTING", "REPORT_DAILY"]);
    await provider.disconnect();
  });

  test("a kind with no relation behind it describes as three empty lists, without asking the server", async () => {
    // Not an optimisation and not a name test. The detail reads key the last path segment
    // against TABLE_NAME, so a trigger named APP_ORDERS on table APP_CUSTOMERS would have
    // been handed APP_ORDERS's columns as if they were its own. The KIND settles it.
    let asked = 0;
    mockExecuteFn = async () => {
      asked += 1;
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    for (const [path, kind] of [
      [["APP", "APP_ORDERS_PKG"], "package"],
      [["APP", "APP_ORDER_TOTAL"], "function"],
      [["APP", "APP_TOUCH_ORDER"], "procedure"],
      [["APP", "APP_INVOICE_SEQ"], "sequence"],
      [["APP", "APP_ORDERS_SYN"], "synonym"],
      [["APP", "APP_ORDERS", "APP_ORDERS_TRG"], "trigger"],
      [["APP", "APP_LOGON_TRG"], "trigger"],
    ] as [string[], string][]) {
      expect(await provider.describeObject(path, kind)).toEqual({
        path,
        columns: [],
        indexes: [],
        foreignKeys: [],
      });
    }
    expect(asked).toBe(0);
    await provider.disconnect();
  });

  test("a view and a materialized view describe from the same column dictionary a table does", async () => {
    mockExecuteFn = async (sql: string) => {
      if (!sql.includes("ALL_TAB_COLUMNS")) return { rows: [] };
      return { rows: [{ COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", NULLABLE: "Y", DATA_DEFAULT: null }] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    // Measured on 21c XE: ALL_TAB_COLUMNS answers for a view and for a materialized view's
    // container table, so neither needs a dictionary of its own.
    for (const kind of ["view", "materialized_view"]) {
      const detail = await provider.describeObject(["APP", "APP_ORDER_SUMMARY"], kind);
      expect(detail.columns).toEqual([
        { name: "ID", type: "NUMBER", nullable: true, isPrimary: false, defaultValue: undefined },
      ]);
    }
    await provider.disconnect();
  });

  test("an object path that is not [schema, name] is refused", async () => {
    mockExecuteFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    await expect(provider.describeObject(["APP"], "table")).rejects.toThrow(/"table" path is \[schema, name\]/);
    await expect(provider.describeObject(["A", "B", "C"], "table")).rejects.toThrow(/"table" path is \[schema, name\]/);
    // An attached kind takes either depth, and only those two: measured, a trigger's base
    // object may be a table, a view, or nothing at all.
    await expect(provider.describeObject(["A", "B", "C", "D"], "trigger")).rejects.toThrow(
      /"trigger" path is \[schema, table, name\] or \[schema, name\]/,
    );
    await expect(provider.describeObject(["A"], "trigger")).rejects.toThrow(
      /"trigger" path is \[schema, table, name\] or \[schema, name\]/,
    );
    await provider.disconnect();
  });
});

/**
 * The fifth provider method (#789): every object of one kind in one owner described in FIVE
 * round trips rather than four per object.
 *
 * This mock dispatches on the statement the provider built, which standing ruling 5b names
 * as a blind spot: a rewrite it cannot see stays green here. So the decisions a rewrite
 * would silently undo are pinned by statement TEXT below - the target set carries the
 * materialized-view container rule the listing carries, the cut is
 * `ORDER BY ... FETCH FIRST :3 ROWS ONLY` and not `ROWNUM`, and the index read keys
 * `TABLE_OWNER` rather than the index's own owner - and all of them are measured live in
 * the task report.
 */
describe("Oracle bulk column read", () => {
  beforeEach(() => {
    mockExecuteFn = async (sql: string) => defaultExecute(sql);
    mockConnCloseFn = async () => {};
    mockBreakFn = async () => {};
    mockPoolCloseFn = async () => {};
    mockCreatePoolFn = async () => createMockPool();
  });

  function makeProvider(overrides: Partial<DatabaseConnection> = {}) {
    return new OracleProvider({ ...baseConfig, ...overrides });
  }

  /** The five reads one bulk call issues, in order, with the parameters each bound. */
  function bulkFixture(issued: Array<{ sql: string; params: unknown[] }>) {
    return async (sql: string, params?: unknown[]) => {
      if (!sql.includes("WITH described AS")) return { rows: [] };
      issued.push({ sql, params: params ?? [] });
      const bound = sql.includes("FETCH FIRST") ? Number((params ?? [])[2]) : undefined;
      const names = ["APP_CUSTOMERS", "APP_ORDERS"].slice(0, bound);
      if (sql.includes("SELECT d.NAME FROM described d")) return { rows: names.map((NAME) => ({ NAME })) };
      if (sql.includes("ALL_TAB_COLUMNS")) {
        return {
          rows: [
            {
              OBJECT_NAME: "APP_ORDERS",
              COLUMN_NAME: "ID",
              DATA_TYPE: "NUMBER",
              NULLABLE: "N",
              DATA_DEFAULT: null,
            },
            {
              OBJECT_NAME: "APP_ORDERS",
              COLUMN_NAME: "TOTAL",
              DATA_TYPE: "NUMBER",
              NULLABLE: "Y",
              DATA_DEFAULT: "0 ",
            },
          ],
        };
      }
      if (sql.includes("CONSTRAINT_TYPE = 'P'")) {
        return { rows: [{ OBJECT_NAME: "APP_ORDERS", COLUMN_NAME: "ID" }] };
      }
      if (sql.includes("CONSTRAINT_TYPE = 'R'")) {
        return {
          rows: [
            {
              OBJECT_NAME: "APP_ORDERS",
              COLUMN_NAME: "CUSTOMER_ID",
              REF_OWNER: "APP",
              REF_TABLE: "APP_CUSTOMERS",
              REF_COLUMN: "ID",
            },
            {
              OBJECT_NAME: "APP_ORDERS",
              COLUMN_NAME: "REGION_ID",
              REF_OWNER: "REPORTING",
              REF_TABLE: "REPORT_REGIONS",
              REF_COLUMN: "ID",
            },
          ],
        };
      }
      return {
        rows: [
          {
            OBJECT_NAME: "APP_ORDERS",
            INDEX_NAME: "APP_ORDERS_TOTAL_IX",
            UNIQUENESS: "NONUNIQUE",
            COLUMN_NAME: "TOTAL",
          },
          {
            OBJECT_NAME: "APP_ORDERS",
            INDEX_NAME: "APP_ORDERS_TOTAL_IX",
            UNIQUENESS: "NONUNIQUE",
            COLUMN_NAME: "NOTE",
          },
        ],
      };
    };
  }

  test("describes every table of one owner in five round trips, keyed by path", async () => {
    const issued: Array<{ sql: string; params: unknown[] }> = [];
    mockExecuteFn = bulkFixture(issued);
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const batch = await provider.describeObjects(["APP"], "table");

    // FIVE statements for the whole folder, whatever the folder holds. The single read is
    // four per object, which is the N+1 the inventory route refused once - and on Oracle it
    // is the same four dictionary views that answered 910,000 rows in #765.
    expect(issued).toHaveLength(5);
    expect(issued[0].sql).toContain("ALL_OBJECTS");
    expect(issued[0].params).toEqual(["APP", "TABLE"]);
    // The target carries the materialized-view container rule the LISTING carries, so the
    // two answers hold the same objects: a MATERIALIZED VIEW writes a TABLE row of the same
    // name for its container, and describing it as a table would describe an object no
    // folder shows.
    expect(issued[0].sql).toContain("NOT EXISTS");
    expect(issued[0].sql).toContain("m.OBJECT_TYPE = 'MATERIALIZED VIEW'");
    // Unbounded: no row bound reaches the server and nothing claims truncation.
    for (const call of issued) expect(call.sql).not.toContain("FETCH FIRST");
    expect(batch.truncated).toBeUndefined();
    // The index read keys the TABLE's owner, not the index's: an index another user owns on
    // this table belongs to the table when a person is looking at the table.
    expect(issued[4].sql).toContain("ai.TABLE_OWNER = :3");
    // The owner a SECOND time, as the last value, and that arity is the thing to pin: a
    // repeated `:1` looks right and is not. Measured against a live 21c XE, oracledb maps a
    // bind ARRAY by the order the placeholders appear rather than by the number they carry,
    // so a detail statement naming `:1` twice answers `NJS-098: 3 bind placeholders were
    // used in the SQL statement but 2 bind values were provided`. A mock that dispatches on
    // statement text cannot see that (standing ruling 5b), so the arity is asserted here.
    for (const call of issued.slice(1)) expect(call.params).toEqual(["APP", "TABLE", "APP"]);

    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["APP", "APP_CUSTOMERS"],
      ["APP", "APP_ORDERS"],
    ]);
    const orders = batch.details[1];
    expect(orders.columns).toEqual([
      { name: "ID", type: "NUMBER", nullable: false, isPrimary: true, defaultValue: undefined },
      // DATA_DEFAULT is a LONG holding source text, trailing spaces included, and it is
      // trimmed by the one mapper both reads share.
      { name: "TOTAL", type: "NUMBER", nullable: true, isPrimary: false, defaultValue: "0" },
    ]);
    expect(orders.indexes).toEqual([{ name: "APP_ORDERS_TOTAL_IX", columns: ["TOTAL", "NOTE"], unique: false }]);
    // Bare within the owner, qualified outside it, exactly as the single read spells it.
    expect(orders.foreignKeys).toEqual([
      { columnName: "CUSTOMER_ID", referencedTable: "APP_CUSTOMERS", referencedColumn: "ID" },
      { columnName: "REGION_ID", referencedTable: "REPORTING.REPORT_REGIONS", referencedColumn: "ID" },
    ]);
    // An object the four detail reads answered nothing for is still IN the answer.
    expect(batch.details[0]).toEqual({
      path: ["APP", "APP_CUSTOMERS"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    await provider.disconnect();
  });

  test("the bulk read and the single read spell one object identically", async () => {
    // ONE mapper serves both, so the two answers for one table cannot disagree about a
    // foreign key, a composite index, a trimmed default or which column is the key.
    const issued: Array<{ sql: string; params: unknown[] }> = [];
    const bulk = bulkFixture(issued);
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      if (sql.includes("WITH described AS")) return bulk(sql, params);
      // The single read's four statements, answering the same rows for the same object.
      if (sql.includes("ALL_TAB_COLUMNS")) {
        return {
          rows: [
            { COLUMN_NAME: "ID", DATA_TYPE: "NUMBER", NULLABLE: "N", DATA_DEFAULT: null },
            { COLUMN_NAME: "TOTAL", DATA_TYPE: "NUMBER", NULLABLE: "Y", DATA_DEFAULT: "0 " },
          ],
        };
      }
      if (sql.includes("CONSTRAINT_TYPE = 'P'")) return { rows: [{ COLUMN_NAME: "ID" }] };
      if (sql.includes("CONSTRAINT_TYPE = 'R'")) {
        return {
          rows: [
            { COLUMN_NAME: "CUSTOMER_ID", REF_OWNER: "APP", REF_TABLE: "APP_CUSTOMERS", REF_COLUMN: "ID" },
            { COLUMN_NAME: "REGION_ID", REF_OWNER: "REPORTING", REF_TABLE: "REPORT_REGIONS", REF_COLUMN: "ID" },
          ],
        };
      }
      if (sql.includes("ALL_IND_COLUMNS")) {
        return {
          rows: [
            { INDEX_NAME: "APP_ORDERS_TOTAL_IX", UNIQUENESS: "NONUNIQUE", COLUMN_NAME: "TOTAL" },
            { INDEX_NAME: "APP_ORDERS_TOTAL_IX", UNIQUENESS: "NONUNIQUE", COLUMN_NAME: "NOTE" },
          ],
        };
      }
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const fromBulk = (await provider.describeObjects(["APP"], "table")).details.find(
      (detail) => detail.path[1] === "APP_ORDERS",
    );
    const single = await provider.describeObject(["APP", "APP_ORDERS"], "table");

    expect(fromBulk).toEqual(single);
    await provider.disconnect();
  });

  test("a bounded read binds one row more than the bound and reports its own truncation", async () => {
    const issued: Array<{ sql: string; params: unknown[] }> = [];
    mockExecuteFn = bulkFixture(issued);
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const batch = await provider.describeObjects(["APP"], "table", 1);

    // FETCH FIRST and not ROWNUM, which is the difference that matters on this engine:
    // ROWNUM is assigned BEFORE the sort, so `WHERE ROWNUM <= n ORDER BY OBJECT_NAME` keeps
    // an arbitrary set and then sorts it, while FETCH FIRST cuts the ordered set.
    expect(issued[0].sql).toContain("ORDER BY o.OBJECT_NAME");
    expect(issued[0].sql).toContain("FETCH FIRST :3 ROWS ONLY");
    expect(issued[0].sql).not.toContain("ROWNUM");
    expect(issued[0].params).toEqual(["APP", "TABLE", 2]);
    // The bound takes `:3`, so the owner's second appearance takes `:4` and its value is
    // appended after the bound. See the arity note in the test above.
    expect(issued[1].sql).toContain(":4");
    expect(issued[1].params).toEqual(["APP", "TABLE", 2, "APP"]);
    expect(batch.details.map((detail) => detail.path)).toEqual([["APP", "APP_CUSTOMERS"]]);
    expect(batch.truncated).toEqual({ limit: 1, reason: callerBoundTruncationReason(1) });
    await provider.disconnect();
  });

  test("a bounded read that fits reports nothing", async () => {
    const issued: Array<{ sql: string; params: unknown[] }> = [];
    mockExecuteFn = bulkFixture(issued);
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const batch = await provider.describeObjects(["APP"], "table", 2);

    expect(batch.details).toHaveLength(2);
    expect(batch.truncated).toBeUndefined();
    await provider.disconnect();
  });

  test("a kind Oracle holds no columns for answers empty without asking the server", async () => {
    let asked = 0;
    mockExecuteFn = async () => {
      asked += 1;
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();
    asked = 0;

    for (const kind of ["synonym", "sequence", "package", "procedure", "function", "trigger"]) {
      expect(await provider.describeObjects(["APP"], kind)).toEqual({ details: [] });
    }
    expect(asked).toBe(0);
    await provider.disconnect();
  });

  test("a materialized view describes, because the dictionary answers columns for it", async () => {
    const issued: Array<{ sql: string; params: unknown[] }> = [];
    mockExecuteFn = bulkFixture(issued);
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    await provider.describeObjects(["APP"], "materialized_view");

    // Measured on Oracle Database 21c XE: ALL_TAB_COLUMNS answers for a materialized view,
    // because it has a container table underneath - which is also why the `table` listing
    // has to drop that container.
    expect(issued[0].params).toEqual(["APP", "MATERIALIZED VIEW"]);
    await provider.disconnect();
  });

  test("an empty owner costs one round trip and not five", async () => {
    const issued: Array<{ sql: string; params: unknown[] }> = [];
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      if (sql.includes("WITH described AS")) issued.push({ sql, params: params ?? [] });
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    expect(await provider.describeObjects(["APP"], "table")).toEqual({ details: [] });
    expect(issued).toHaveLength(1);
    await provider.disconnect();
  });

  test("a kind this engine does not declare is refused, not answered empty", async () => {
    mockExecuteFn = async () => ({ rows: [] });
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    await expect(provider.describeObjects(["APP"], "dictionary")).rejects.toThrow(
      /declares no object kind "dictionary"/,
    );
    await provider.disconnect();
  });

  test("a container path that is not one owner is refused, rather than read as empty", async () => {
    mockExecuteFn = async () => ({ rows: [] });
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    await expect(provider.describeObjects([], "table")).rejects.toThrow(/container path is \[schema\]/);
    await expect(provider.describeObjects(["CATALOG", "APP"], "table")).rejects.toThrow(/container path is \[schema\]/);
    await provider.disconnect();
  });

  test("a limit that cannot bound anything is refused, rather than silently ignored", async () => {
    mockExecuteFn = async () => ({ rows: [] });
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    await expect(provider.describeObjects(["APP"], "table", 0)).rejects.toThrow(
      /limit must be a positive whole number, received 0/,
    );
    await expect(provider.describeObjects(["APP"], "table", 1.5)).rejects.toThrow(
      /limit must be a positive whole number, received 1.5/,
    );
    await provider.disconnect();
  });

  test("a refusal is raised naming the statement that earned it", async () => {
    mockExecuteFn = async (sql: string) => {
      if (sql.includes("ALL_TAB_COLUMNS")) throw new Error("ORA-01031: insufficient privileges");
      if (sql.includes("WITH described AS")) return { rows: [{ NAME: "APP_ORDERS" }] };
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const failure = await provider.describeObjects(["APP"], "table").catch((error: unknown) => error);
    expect((failure as Error).message).toContain("ORA-01031");
    expect((failure as { query?: string }).query).toContain("ALL_TAB_COLUMNS");
    await provider.disconnect();
  });

  test("the owner it reads is the container it was asked for, not the connecting user", async () => {
    // #765's regression, in the fifth method. Every container below is deliberately NOT the
    // connecting user, so a read that ignored its argument cannot look correct by accident.
    const issued: Array<{ sql: string; params: unknown[] }> = [];
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      if (sql.includes("WITH described AS")) issued.push({ sql, params: params ?? [] });
      return { rows: [{ NAME: "REPORT_DAILY" }] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    await provider.describeObjects(["REPORTING"], "table");

    expect(issued).toHaveLength(5);
    for (const call of issued) expect(call.params[0]).toBe("REPORTING");
    await provider.disconnect();
  });

  test("a two-level declaration binds the SCHEMA segment, not the first one", async () => {
    // Standing ruling 5g (#789), driven to a BOUND VALUE rather than to a refusal. Oracle
    // declares one container level, so `container[0]` and the schema segment are the same
    // string here and no fixture of this engine can tell them apart; handing this provider a
    // two-level declaration is what makes the derivation mutatable on a one-level engine.
    const issued: Array<{ sql: string; params: unknown[] }> = [];
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      if (sql.includes("WITH described AS")) issued.push({ sql, params: params ?? [] });
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...provider.getCapabilities(),
      containerLevels: [
        { id: "catalog", label: "Container", labelPlural: "Containers" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
    });

    await provider.describeObjects(["XEPDB1", "APP"], "table");

    expect(issued[0].params[0]).toBe("APP");
    await provider.disconnect();
  });

  test("the answer is sorted by path, whatever order the dictionary cut it in", async () => {
    mockExecuteFn = async (sql: string) => {
      if (!sql.includes("WITH described AS")) return { rows: [] };
      if (sql.includes("SELECT d.NAME FROM described d")) {
        return { rows: [{ NAME: "APP_ORDERS" }, { NAME: "APP_CUSTOMERS" }] };
      }
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const batch = await provider.describeObjects(["APP"], "table");

    // The dictionary's order runs under the database's NLS_SORT and decides which objects a
    // bound keeps; the order a caller reads is ours, one rule on every server, because
    // callers join the two answers on path.
    expect(batch.details.map((detail) => detail.path[1])).toEqual(["APP_CUSTOMERS", "APP_ORDERS"]);
    await provider.disconnect();
  });

  test("the paths it answers are the paths listObjects answers", async () => {
    mockExecuteFn = async (sql: string) => {
      if (sql.includes("WITH described AS")) {
        if (sql.includes("SELECT d.NAME FROM described d")) {
          return { rows: [{ NAME: "APP_ORDERS" }, { NAME: "APP_CUSTOMERS" }] };
        }
        return { rows: [] };
      }
      if (sql.includes("ALL_OBJECTS")) {
        return {
          rows: [
            { NAME: "APP_ORDERS", STATUS: "VALID" },
            { NAME: "APP_CUSTOMERS", STATUS: "VALID" },
          ],
        };
      }
      return { rows: [] };
    };
    const provider = makeProvider({ user: "app" });
    await provider.connect();

    const listed = await provider.listObjects(["APP"], "table");
    const batch = await provider.describeObjects(["APP"], "table");

    expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
    await provider.disconnect();
  });
});
