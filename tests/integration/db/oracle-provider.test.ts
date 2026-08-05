import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mock oracledb BEFORE loading the provider
// ---------------------------------------------------------------------------

let mockExecuteFn: (sql: string, params?: unknown[], opts?: unknown) => Promise<unknown>;
let mockConnCloseFn: () => Promise<void>;
let mockBreakFn: () => Promise<void>;
let mockPoolCloseFn: () => Promise<void>;
let mockCreatePoolFn: () => Promise<unknown>;
const mockInitOracleClientFn = mock((_opts?: Record<string, unknown>) => undefined);

const createMockConnection = () => ({
  execute: (sql: string, params?: unknown[], opts?: unknown) => mockExecuteFn(sql, params, opts),
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

mock.module("oracledb", () => {
  const oracledbMock = {
    OUT_FORMAT_OBJECT: 4002,
    initOracleClient: mockInitOracleClientFn,
    outFormat: 0,
    autoCommit: false,
    createPool: () => mockCreatePoolFn(),
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

    test("ignores connection close errors after execution", async () => {
      await provider.connect();
      mockConnCloseFn = async () => {
        throw new Error("close failed");
      };

      const result = await provider.query("SELECT * FROM DUAL");
      expect(result.rows.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4. getCapabilities()
  // =========================================================================

  describe("getCapabilities()", () => {
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
      expect(typeof health.cacheHitRatio).toBe("string");
      expect(health.slowQueries).toBeArray();
      expect(health.activeSessions).toBeArray();
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

    test("optimize with target rebuilds that index", async () => {
      const captured: string[] = [];
      mockExecuteFn = async (sql: string) => {
        captured.push(sql);
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("optimize", "IDX_USERS_NAME");

      expect(result.success).toBe(true);
      expect(captured.some((sql) => sql.includes('ALTER INDEX "IDX_USERS_NAME" REBUILD'))).toBe(true);
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

      expect(typeof metrics.cacheHitRatio).toBe("number");
      expect(metrics.cacheHitRatio).toBeGreaterThanOrEqual(0);
      expect(metrics.cacheHitRatio).toBeLessThanOrEqual(100);
      expect(metrics.cacheHitRatio).toBe(97.5);
      // bufferPoolUsage mirrors cacheHitRatio in Oracle impl
      expect(typeof metrics.bufferPoolUsage).toBe("number");
    });

    test("handles graceful degradation without DBA privs", async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("V$SYSSTAT")) {
          throw new Error("ORA-00942: table or view does not exist");
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      // Should return default values when V$ views are inaccessible
      expect(typeof metrics.cacheHitRatio).toBe("number");
      expect(metrics.cacheHitRatio).toBe(100); // Default fallback
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
