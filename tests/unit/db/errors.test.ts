import { describe, test, expect } from "bun:test";
import {
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PermissionDeniedError,
  PoolExhaustedError,
  QueryError,
  OffsetUnsupportedError,
  TimeoutError,
  QueryCancelledError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  waitedSeconds,
  connectPhase,
  connectFailureReason,
} from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import {
  describeOracleClientLoadFailure,
  describeOracleThinModeRefusal,
} from "@/lib/db/providers/sql/oracle-driver-errors";
import { ApiErrorCode } from "@/lib/api/error-codes";

// ============================================================================
// Error Classes
// ============================================================================

describe("DatabaseError", () => {
  test('sets name to "DatabaseError"', () => {
    const err = new DatabaseError("test message");
    expect(err.name).toBe("DatabaseError");
  });

  test("stores message, provider, code, and query", () => {
    const err = new DatabaseError("msg", "postgres", ApiErrorCode.DATABASE_ERROR, "SELECT 1");
    expect(err.message).toBe("msg");
    expect(err.provider).toBe("postgres");
    expect(err.code).toBe(ApiErrorCode.DATABASE_ERROR);
    expect(err.query).toBe("SELECT 1");
  });

  test("is instanceof Error", () => {
    const err = new DatabaseError("test");
    expect(err).toBeInstanceOf(Error);
  });

  test("toJSON() returns structured object", () => {
    const err = new DatabaseError("test", "mysql", ApiErrorCode.QUERY_ERROR, "SELECT 1");
    const json = err.toJSON();
    expect(json).toEqual({
      name: "DatabaseError",
      message: "test",
      provider: "mysql",
      code: ApiErrorCode.QUERY_ERROR,
      query: "SELECT 1",
    });
  });

  test("toJSON() preserves a query at the preview limit", () => {
    const query = "A".repeat(100);
    const json = new DatabaseError("msg", "postgres", undefined, query).toJSON();
    expect(json.query).toBe(query);
    expect(json.query?.endsWith("...")).toBe(false);
  });

  test("toJSON() marks a query just beyond the preview limit", () => {
    const query = "A".repeat(101);
    const json = new DatabaseError("msg", "postgres", undefined, query).toJSON();
    expect(json.query).toBe("A".repeat(100) + "...");
    expect(json.query?.length).toBe(103);
    expect(json.query?.endsWith("...")).toBe(true);
  });

  test("toJSON() truncates query to 100 chars", () => {
    const longQuery = "A".repeat(200);
    const err = new DatabaseError("msg", "postgres", undefined, longQuery);
    const json = err.toJSON();
    expect((json.query as string).length).toBe(103); // substring(0,100) + '...'
    expect((json.query as string).endsWith("...")).toBe(true);
  });

  test("toJSON() returns undefined query when no query provided", () => {
    const err = new DatabaseError("msg");
    const json = err.toJSON();
    expect(json.query).toBeUndefined();
  });
});

describe("DatabaseConfigError", () => {
  test('sets name to "DatabaseConfigError"', () => {
    const err = new DatabaseConfigError("bad config");
    expect(err.name).toBe("DatabaseConfigError");
  });

  test("sets code to CONFIG_ERROR", () => {
    const err = new DatabaseConfigError("bad config", "postgres");
    expect(err.code).toBe("CONFIG_ERROR");
  });

  test("is instanceof DatabaseError and Error", () => {
    const err = new DatabaseConfigError("bad config");
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("ConnectionError", () => {
  test('sets name to "ConnectionError"', () => {
    const err = new ConnectionError("conn fail");
    expect(err.name).toBe("ConnectionError");
  });

  test("stores host and port", () => {
    const err = new ConnectionError("fail", "postgres", "localhost", 5432);
    expect(err.host).toBe("localhost");
    expect(err.port).toBe(5432);
    expect(err.code).toBe("CONNECTION_ERROR");
  });

  test("is instanceof DatabaseError", () => {
    const err = new ConnectionError("fail");
    expect(err).toBeInstanceOf(DatabaseError);
  });
});

describe("AuthenticationError", () => {
  test('sets name to "AuthenticationError"', () => {
    const err = new AuthenticationError("auth fail");
    expect(err.name).toBe("AuthenticationError");
  });

  test("sets code to AUTH_ERROR", () => {
    const err = new AuthenticationError("auth fail", "mysql");
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.provider).toBe("mysql");
  });

  test("is instanceof DatabaseError", () => {
    const err = new AuthenticationError("fail");
    expect(err).toBeInstanceOf(DatabaseError);
  });
});

describe("PermissionDeniedError", () => {
  test('sets name to "PermissionDeniedError"', () => {
    expect(new PermissionDeniedError("denied").name).toBe("PermissionDeniedError");
  });

  test("sets code to PERMISSION_DENIED and keeps the provider and the statement", () => {
    const err = new PermissionDeniedError("denied", "postgres", "INSERT INTO orders VALUES (1)");
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.provider).toBe("postgres");
    expect(err.query).toBe("INSERT INTO orders VALUES (1)");
  });

  test("is a DatabaseError and not a refused credential", () => {
    const err = new PermissionDeniedError("denied");
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err).not.toBeInstanceOf(AuthenticationError);
  });
});

describe("PoolExhaustedError", () => {
  test('sets name to "PoolExhaustedError"', () => {
    const err = new PoolExhaustedError("pool full");
    expect(err.name).toBe("PoolExhaustedError");
  });

  test("stores poolSize", () => {
    const err = new PoolExhaustedError("pool full", "postgres", 10);
    expect(err.poolSize).toBe(10);
    expect(err.code).toBe("POOL_EXHAUSTED");
  });

  test("is instanceof DatabaseError", () => {
    const err = new PoolExhaustedError("fail");
    expect(err).toBeInstanceOf(DatabaseError);
  });
});

describe("QueryError", () => {
  test('sets name to "QueryError"', () => {
    const err = new QueryError("syntax error");
    expect(err.name).toBe("QueryError");
  });

  test("stores position and detail", () => {
    const err = new QueryError("fail", "postgres", "SELECT * FORM", 12, "near FORM");
    expect(err.position).toBe(12);
    expect(err.detail).toBe("near FORM");
    expect(err.query).toBe("SELECT * FORM");
    expect(err.code).toBe("QUERY_ERROR");
  });

  test("is instanceof DatabaseError", () => {
    const err = new QueryError("fail");
    expect(err).toBeInstanceOf(DatabaseError);
  });
});

describe("OffsetUnsupportedError", () => {
  test("is a QueryError a caller can tell apart from any other, with the provider's own sentence", () => {
    const err = new OffsetUnsupportedError("CQL has no OFFSET clause.", "cassandra", "SELECT * FROM t");
    expect(err).toBeInstanceOf(QueryError);
    expect(err.name).toBe("OffsetUnsupportedError");
    expect(err.message).toBe("CQL has no OFFSET clause.");
    expect(err.code).toBe("QUERY_ERROR");
    expect(err.provider).toBe("cassandra");
    expect(err.query).toBe("SELECT * FROM t");
    expect(new QueryError("syntax")).not.toBeInstanceOf(OffsetUnsupportedError);
  });
});

describe("TimeoutError", () => {
  test('sets name to "TimeoutError"', () => {
    const err = new TimeoutError("timed out");
    expect(err.name).toBe("TimeoutError");
  });

  test("stores timeout and query", () => {
    const err = new TimeoutError("timed out", "postgres", 30000, "SELECT pg_sleep(60)");
    expect(err.timeout).toBe(30000);
    expect(err.query).toBe("SELECT pg_sleep(60)");
    expect(err.code).toBe("TIMEOUT_ERROR");
  });

  test("is instanceof DatabaseError", () => {
    const err = new TimeoutError("fail");
    expect(err).toBeInstanceOf(DatabaseError);
  });
});

// ============================================================================
// Type Guards
// ============================================================================

describe("isDatabaseError", () => {
  test("returns true for DatabaseError instances", () => {
    expect(isDatabaseError(new DatabaseError("err"))).toBe(true);
  });

  test("returns true for subclass instances", () => {
    expect(isDatabaseError(new ConnectionError("err"))).toBe(true);
    expect(isDatabaseError(new QueryError("err"))).toBe(true);
  });

  test("returns false for plain Error", () => {
    expect(isDatabaseError(new Error("plain"))).toBe(false);
  });

  test("returns false for non-error values", () => {
    expect(isDatabaseError("string")).toBe(false);
    expect(isDatabaseError(null)).toBe(false);
    expect(isDatabaseError(undefined)).toBe(false);
  });
});

describe("isConnectionError", () => {
  test("returns true for ConnectionError", () => {
    expect(isConnectionError(new ConnectionError("err"))).toBe(true);
  });

  test("returns false for other DatabaseError subclasses", () => {
    expect(isConnectionError(new QueryError("err"))).toBe(false);
    expect(isConnectionError(new DatabaseError("err"))).toBe(false);
  });
});

describe("isQueryError", () => {
  test("returns true for QueryError", () => {
    expect(isQueryError(new QueryError("err"))).toBe(true);
  });

  test("returns false for non-QueryError", () => {
    expect(isQueryError(new ConnectionError("err"))).toBe(false);
  });
});

describe("isTimeoutError", () => {
  test("returns true for TimeoutError", () => {
    expect(isTimeoutError(new TimeoutError("err"))).toBe(true);
  });

  test("returns false for non-TimeoutError", () => {
    expect(isTimeoutError(new ConnectionError("err"))).toBe(false);
  });
});

describe("isAuthenticationError", () => {
  test("returns true for AuthenticationError", () => {
    expect(isAuthenticationError(new AuthenticationError("err"))).toBe(true);
  });

  test("returns false for non-AuthenticationError", () => {
    expect(isAuthenticationError(new DatabaseError("err"))).toBe(false);
  });
});

// ============================================================================
// isRetryableError
// ============================================================================

describe("isRetryableError", () => {
  test("ConnectionError is retryable", () => {
    expect(isRetryableError(new ConnectionError("fail"))).toBe(true);
  });

  test("TimeoutError is retryable", () => {
    expect(isRetryableError(new TimeoutError("timed out"))).toBe(true);
  });

  test("AuthenticationError is NOT retryable", () => {
    expect(isRetryableError(new AuthenticationError("bad creds"))).toBe(false);
  });

  test("PermissionDeniedError is NOT retryable", () => {
    expect(isRetryableError(new PermissionDeniedError("permission denied for table orders"))).toBe(false);
  });

  test("DatabaseConfigError is NOT retryable", () => {
    expect(isRetryableError(new DatabaseConfigError("bad config"))).toBe(false);
  });

  test("QueryError with position is NOT retryable", () => {
    expect(isRetryableError(new QueryError("syntax", "postgres", "q", 5))).toBe(false);
  });

  test("plain Error is NOT retryable", () => {
    expect(isRetryableError(new Error("generic"))).toBe(false);
  });

  test('TypeError with "fetch" IS retryable (network error)', () => {
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
  });

  test("PoolExhaustedError is retryable (inherits from DatabaseError)", () => {
    expect(isRetryableError(new PoolExhaustedError("pool"))).toBe(true);
  });
});

// ============================================================================
// mapDatabaseError
// ============================================================================

describe("mapDatabaseError", () => {
  test("returns existing DatabaseError as-is", () => {
    const original = new ConnectionError("already mapped");
    const result = mapDatabaseError(original, "postgres");
    expect(result).toBe(original);
  });

  test("non-Error input is converted to DatabaseError with String()", () => {
    const result = mapDatabaseError("raw string error", "postgres");
    expect(result).toBeInstanceOf(DatabaseError);
    expect(result.message).toBe("raw string error");
    expect(result.provider).toBe("postgres");
  });

  test("ECONNREFUSED maps to ConnectionError", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const result = mapDatabaseError(err, "postgres");
    expect(result).toBeInstanceOf(ConnectionError);
    expect(result.message).toContain("Failed to connect");
  });

  test('"password" in message maps to AuthenticationError', () => {
    const err = new Error('password authentication failed for user "test"');
    const result = mapDatabaseError(err, "postgres");
    expect(result).toBeInstanceOf(AuthenticationError);
    expect(result.message).toContain("Authentication failed");
  });

  test('"timeout" in message maps to TimeoutError', () => {
    const err = new Error("query timeout exceeded");
    const result = mapDatabaseError(err, "mysql", "SELECT SLEEP(100)");
    const result2 = result as TimeoutError;
    expect(result2).toBeInstanceOf(TimeoutError);
    expect(result2.query).toBe("SELECT SLEEP(100)");
  });

  test("Oracle ORA-01017 maps to AuthenticationError", () => {
    const err = new Error("ORA-01017: invalid username/password; logon denied");
    const result = mapDatabaseError(err, "oracle");
    expect(result).toBeInstanceOf(AuthenticationError);
  });

  test("Oracle ORA-12541 maps to ConnectionError", () => {
    const err = new Error("ORA-12541: TNS:no listener");
    const result = mapDatabaseError(err, "oracle");
    expect(result).toBeInstanceOf(ConnectionError);
  });

  test("Oracle ORA-12154 maps to ConnectionError", () => {
    const err = new Error("ORA-12154: TNS:could not resolve the connect identifier");
    const result = mapDatabaseError(err, "oracle");
    expect(result).toBeInstanceOf(ConnectionError);
  });

  test("Oracle ORA-00942 maps to QueryError", () => {
    const err = new Error("ORA-00942: table or view does not exist");
    const query = "SELECT * FROM nonexistent";
    const result = mapDatabaseError(err, "oracle", query);
    expect(result).toBeInstanceOf(QueryError);
  });

  test("Oracle NJS-138 (pre-12.1 server, Thin mode incompatible) maps to non-retryable DatabaseConfigError", () => {
    const err = new Error(
      "NJS-138: connections to this database server version are not supported by node-oracledb in Thin mode",
    );
    const result = mapDatabaseError(err, "oracle");
    expect(result).toBeInstanceOf(DatabaseConfigError);
    expect(isRetryableError(result)).toBe(false);
    expect(result.message).toContain("ORACLE_CLIENT_LIB_DIR");
  });

  // NJS-138 was the first Thin-mode refusal to get this treatment (#228). The
  // rest fell through to the generic retryable ConnectionError until #538,
  // which is the same defect class: a DBA-visible "you must use Thick mode"
  // arriving as "try again later".
  test("Oracle NJS-116 (10G-only password verifier) maps to non-retryable DatabaseConfigError", () => {
    const err = new Error("NJS-116: password verifier type 0x939 is not supported by node-oracledb in Thin mode");
    const result = mapDatabaseError(err, "oracle");
    // The driver's own text contains "password", so the generic authentication
    // branch would swallow this one if the Oracle check did not run first.
    expect(result).toBeInstanceOf(DatabaseConfigError);
    expect(isRetryableError(result)).toBe(false);
    expect(result.message).toContain("ORACLE_CLIENT_LIB_DIR");
    // The DBA-side way out, which needs no Instant Client at all.
    expect(result.message).toContain("12C");
  });

  test("Oracle NJS-533 (native network encryption) maps to non-retryable DatabaseConfigError", () => {
    const err = new Error(
      "NJS-533: Advanced Networking Option service negotiation failed. Native Network Encryption " +
        "and DataIntegrity are only supported in node-oracledb thick mode",
    );
    const result = mapDatabaseError(err, "oracle");
    expect(result).toBeInstanceOf(DatabaseConfigError);
    expect(isRetryableError(result)).toBe(false);
    expect(result.message).toContain("ORACLE_CLIENT_LIB_DIR");
  });

  test("Oracle NJS-089 (unimplemented Thin-mode feature) maps to non-retryable DatabaseConfigError", () => {
    const err = new Error("NJS-089: Kerberos authentication is not supported by node-oracledb in Thin mode");
    const result = mapDatabaseError(err, "oracle");
    expect(result).toBeInstanceOf(DatabaseConfigError);
    expect(isRetryableError(result)).toBe(false);
    expect(result.message).toContain("ORACLE_CLIENT_LIB_DIR");
  });

  test("Oracle NJS-529 (sso-only wallet) maps to non-retryable DatabaseConfigError", () => {
    // The driver's own text (ERR_WALLET_TYPE_NOT_SUPPORTED) says nothing about
    // Thin mode, so the generic substring branch never sees it.
    const err = new Error("NJS-529: Invalid wallet content format. Supported format is PEM");
    const result = mapDatabaseError(err, "oracle");
    expect(result).toBeInstanceOf(DatabaseConfigError);
    expect(isRetryableError(result)).toBe(false);
    expect(result.message).toContain("PEM");
    expect(result.message).toContain("ORACLE_CLIENT_LIB_DIR");
  });

  test('a bare "not supported by node-oracledb in Thin mode" with no NJS code still maps to DatabaseConfigError', () => {
    const err = new Error("LDAP naming is not supported by node-oracledb in Thin mode");
    const result = mapDatabaseError(err, "oracle");
    expect(result).toBeInstanceOf(DatabaseConfigError);
    expect(isRetryableError(result)).toBe(false);
  });

  test('MSSQL "login failed" maps to AuthenticationError', () => {
    const err = new Error('Login failed for user "sa"');
    const result = mapDatabaseError(err, "mssql");
    expect(result).toBeInstanceOf(AuthenticationError);
  });

  test('MSSQL "cannot open database" maps to ConnectionError', () => {
    const err = new Error('Cannot open database "testdb" requested by the login');
    const result = mapDatabaseError(err, "mssql");
    expect(result).toBeInstanceOf(ConnectionError);
  });

  // The server's real 4060 sentence ENDS in "The login failed.", so it satisfies the
  // "login failed" substring too - the more specific branch has to be read first (#1451).
  test('the full 4060 sentence maps to ConnectionError, not the "login failed" it ends with', () => {
    const err = new Error('Cannot open database "nope_db" requested by the login. The login failed.');
    const result = mapDatabaseError(err, "mssql");
    expect(result).toBeInstanceOf(ConnectionError);
  });

  test('"syntax error" maps to QueryError', () => {
    const err = new Error('syntax error at or near "FORM"');
    const result = mapDatabaseError(err, "postgres", "SELECT * FORM users");
    expect(result).toBeInstanceOf(QueryError);
  });

  test('"pool" in message maps to PoolExhaustedError', () => {
    const err = new Error("pool is full, cannot allocate connection");
    const result = mapDatabaseError(err, "postgres");
    expect(result).toBeInstanceOf(PoolExhaustedError);
  });

  test("generic error maps to base DatabaseError", () => {
    const err = new Error("something unexpected happened");
    const result = mapDatabaseError(err, "sqlite", "SELECT 1");
    expect(result).toBeInstanceOf(DatabaseError);
    expect(result.message).toBe("something unexpected happened");
    expect(result.provider).toBe("sqlite");
    expect(result.query).toBe("SELECT 1");
  });

  test('"connection refused" maps to ConnectionError', () => {
    const err = new Error("connection refused to host");
    const result = mapDatabaseError(err, "mysql");
    expect(result).toBeInstanceOf(ConnectionError);
  });

  test('"access denied" maps to AuthenticationError', () => {
    const err = new Error("Access denied for user");
    const result = mapDatabaseError(err, "mysql");
    expect(result).toBeInstanceOf(AuthenticationError);
  });

  test('returns QueryCancelledError for "kill query" message', () => {
    const error = new Error("kill query 12345");
    const result = mapDatabaseError(error, "mysql");
    expect(result).toBeInstanceOf(QueryCancelledError);
    expect(result.message).toBe("Query was cancelled");
  });
});

/**
 * `mssql` and `tedious` end a cancelled request with `RequestError('Canceled.', 'ECANCEL')`, a sentence that holds
 * none of the cancellation words, so the cancel is read from the driver's code. No other installed driver raises the
 * code `ECANCEL`; the POSIX `ECANCELED` is a different string and is not read as one.
 */
describe("mapDatabaseError: a cancel read from the driver's code", () => {
  const shaped = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);

  test("an ECANCEL error shaped like the mssql RequestError maps to QueryCancelledError", () => {
    const error = Object.assign(shaped("Canceled.", { code: "ECANCEL" }), { name: "RequestError" });
    const result = mapDatabaseError(error, "mssql", "WAITFOR DELAY '00:00:30'");
    expect(result).toBeInstanceOf(QueryCancelledError);
    expect(result.message).toBe("Query was cancelled");
    expect(result.query).toBe("WAITFOR DELAY '00:00:30'");
  });

  test("the bare word Canceled. without the code stays a generic DatabaseError", () => {
    const result = mapDatabaseError(new Error("Canceled."), "mssql");
    expect(result).not.toBeInstanceOf(QueryCancelledError);
    expect(result).toBeInstanceOf(DatabaseError);
  });

  test("the POSIX ECANCELED system code is not read as a query cancel", () => {
    const result = mapDatabaseError(shaped("operation canceled", { code: "ECANCELED" }), "mssql");
    expect(result).not.toBeInstanceOf(QueryCancelledError);
  });

  test.each([
    ["canceling statement due to user request", "postgres"],
    ["Query execution was interrupted", "mysql"],
    ["query was cancelled by the operator", "clickhouse"],
  ] as const)("the word-based cancel %p still maps to QueryCancelledError", (message, provider) => {
    expect(mapDatabaseError(new Error(message), provider)).toBeInstanceOf(QueryCancelledError);
  });

  test("a PostgreSQL statement timeout keeps its TimeoutError", () => {
    const error = shaped("canceling statement due to statement timeout", { code: "57014" });
    expect(mapDatabaseError(error, "postgres")).toBeInstanceOf(TimeoutError);
  });

  test("the SQL Server deadline's own budget QueryError passes through unchanged", () => {
    const budget = new QueryError(
      "Read-only execution exceeded its time budget: the statement was cancelled after 500 ms",
      "mssql",
      "SELECT 1",
    );
    expect(mapDatabaseError(budget, "mssql")).toBe(budget);
  });
});

/**
 * A statement's own fault is read from the driver's code fields, never its words (#1427). Each
 * shape below is the one the installed driver raises, measured on 2026-10-04: `pg` against
 * PostgreSQL 18.6 and CockroachDB v26.3.2, `mysql2` against MySQL 26.7.0 and TiDB v8.5.8,
 * `bun:sqlite` and `node:sqlite` in process. The messages hold none of the words the substring
 * branches match, which is exactly the population that used to reach the generic 500.
 */
describe("mapDatabaseError: a statement's own fault, by driver code (#1427)", () => {
  const shaped = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);

  const statementFaults: [string, Error][] = [
    [
      "MySQL syntax error (1064, 42000)",
      shaped("You have an error in your SQL syntax; check the manual near 'SELEC 1' at line 1", {
        code: "ER_PARSE_ERROR",
        errno: 1064,
        sqlState: "42000",
      }),
    ],
    [
      "MySQL unknown table (1146, 42S02)",
      shaped("Table 'app.nope' doesn't exist", { code: "ER_NO_SUCH_TABLE", errno: 1146, sqlState: "42S02" }),
    ],
    [
      "MySQL duplicate key (1062, 23000)",
      shaped("Duplicate entry '1' for key 't1.PRIMARY'", { code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000" }),
    ],
    [
      "PostgreSQL-wire unique violation (23505)",
      shaped('duplicate key value violates unique constraint "t_pkey"', { code: "23505" }),
    ],
    ["PostgreSQL-wire bad input (22P02)", shaped('invalid input syntax for type integer: "x"', { code: "22P02" })],
    ["PostgreSQL-wire feature not supported (0A000)", shaped("REINDEX not supported yet", { code: "0A000" })],
    [
      "Db2 syntax error (SQLSTATE 42601)",
      shaped('An unexpected token "SELEC" was found. SQLSTATE=42601', { sqlstate: "42601", sqlcode: -104 }),
    ],
    [
      "SQL Server unknown procedure (2812)",
      shaped("Could not find stored procedure 'SELEC'.", { code: "EREQUEST", number: 2812, class: 16 }),
    ],
    [
      "SQL Server unique key (2627)",
      shaped("Violation of PRIMARY KEY constraint 'PK_t'.", { code: "EREQUEST", number: 2627, class: 14 }),
    ],
    ["Oracle invalid SQL statement (ORA-00900)", shaped("ORA-00900: invalid SQL statement", { errorNum: 900 })],
    ["Oracle unique constraint (ORA-00001)", shaped("ORA-00001: unique constraint violated", { errorNum: 1 })],
    [
      "Oracle check constraint (ORA-02290)",
      shaped("ORA-02290: check constraint violated", { errorNum: 2290, code: "ORA-02290" }),
    ],
    [
      "bun:sqlite unique constraint",
      shaped("UNIQUE constraint failed: t.a", { code: "SQLITE_CONSTRAINT_PRIMARYKEY", errno: 1555 }),
    ],
    ["bun:sqlite syntax error", shaped('near "SELEC": syntax-like refusal', { code: "SQLITE_ERROR", errno: 1 })],
    [
      "node:sqlite unique constraint (extended 1555)",
      shaped("UNIQUE constraint failed: t.a", { code: "ERR_SQLITE_ERROR", errcode: 1555, errstr: "constraint failed" }),
    ],
  ];

  for (const [name, error] of statementFaults) {
    test(`${name} is a QueryError carrying the engine's own message`, () => {
      const mapped = mapDatabaseError(error, "mysql", "SELEC 1");
      expect(mapped).toBeInstanceOf(QueryError);
      expect(mapped.message).toBe(error.message);
      expect(mapped.query).toBe("SELEC 1");
    });
  }

  test("a statement error naming a table called pool_items is not a pool failure (B4)", () => {
    const error = shaped("no such table: pool_items", { code: "SQLITE_ERROR", errno: 1 });
    expect(mapDatabaseError(error, "sqlite")).toBeInstanceOf(QueryError);
  });

  test("a statement error naming a table called timeouts is not a timeout", () => {
    const error = shaped("Table 'app.timeouts' doesn't exist", { errno: 1146, sqlState: "42S02" });
    expect(mapDatabaseError(error, "mysql")).toBeInstanceOf(QueryError);
  });

  // The classes that are the connection's, the transaction's or the server's keep the class the
  // rest of the mapper gives them.
  const notStatementFaults: [string, Error, new (...args: never[]) => DatabaseError][] = [
    [
      "PostgreSQL statement timeout (57014)",
      shaped("canceling statement due to statement timeout", { code: "57014" }),
      TimeoutError,
    ],
    ["PostgreSQL internal error (XX000)", shaped("Failed to run the query", { code: "XX000" }), DatabaseError],
    [
      "TiDB unsupported statement (8200, HY000)",
      shaped("OPTIMIZE TABLE is not supported", { errno: 8200, sqlState: "HY000" }),
      DatabaseError,
    ],
    [
      "SQL Server deadlock victim (1205)",
      shaped("Transaction was deadlocked", { number: 1205, class: 13 }),
      DatabaseError,
    ],
    [
      "Oracle user cancel (ORA-01013)",
      shaped("ORA-01013: user requested cancel of current operation", { errorNum: 1013 }),
      DatabaseError,
    ],
    ["SQLite busy (SQLITE_BUSY)", shaped("database is locked", { code: "SQLITE_BUSY", errno: 5 }), DatabaseError],
    [
      "node:sqlite busy (errcode 5)",
      shaped("database is locked", { code: "ERR_SQLITE_ERROR", errcode: 5 }),
      DatabaseError,
    ],
    ["a system error code", shaped("write EPIPE", { code: "EPIPE" }), DatabaseError],
    [
      "MySQL max_user_connections (1203, 42000)",
      shaped("User u already has more than 'max_user_connections' active connections", {
        errno: 1203,
        sqlState: "42000",
      }),
      DatabaseError,
    ],
    [
      "MySQL account resource limit (1226, 42000)",
      shaped("User 'u' has exceeded the 'max_questions' resource (current value: 10)", {
        errno: 1226,
        sqlState: "42000",
      }),
      DatabaseError,
    ],
  ];

  for (const [name, error, expected] of notStatementFaults) {
    test(`${name} keeps its own class`, () => {
      const mapped = mapDatabaseError(error, "postgres");
      expect(mapped).toBeInstanceOf(expected);
      expect(mapped).not.toBeInstanceOf(QueryError);
    });
  }
});

/**
 * A refused privilege is not a refused credential, and the driver's code tells them apart wherever the driver gives
 * one. Answering a missing grant as an authentication failure sent a user whose password is right to re-enter it:
 * PostgreSQL's 42501 came back as HTTP 401 "Authentication failed: permission denied for table orders". Each shape is
 * the one the installed driver raises: `pg` puts the SQLSTATE in `code`, `mysql2` the error number in `errno` beside
 * `sqlState`, `mssql` the server's number in `number`, `oracledb` in `errorNum`, `db2-node` the SQLSTATE and SQLCODE
 * in `sqlstate` and `sqlcode`, and the MongoDB driver its code and name in `code` and `codeName`. The codes and
 * texts are each engine's reference: PostgreSQL's Appendix A, the MySQL 8.4 and MariaDB error references, SQL
 * Server's Database Engine errors, Oracle's error help, Db2's SQLSTATE and SQLCODE messages and MongoDB's error codes.
 */
describe("mapDatabaseError: a refused privilege is not a refused credential", () => {
  const shaped = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);
  const mysql = (message: string, errno: number, code: string, sqlState: string) =>
    shaped(message, { code, errno, sqlState, sqlMessage: message });
  const mssql = (message: string, number: number, severity: number) =>
    shaped(message, { code: "EREQUEST", number, class: severity });
  const oracle = (message: string, errorNum: number) =>
    shaped(message, { errorNum, code: `ORA-${String(errorNum).padStart(5, "0")}` });

  const privilegeRefusals: [string, Error][] = [
    ["PostgreSQL insufficient_privilege (42501)", shaped("permission denied for table orders", { code: "42501" })],
    ["PostgreSQL ownership refusal (42501)", shaped("must be owner of table orders", { code: "42501" })],
    [
      "MySQL database access (1044)",
      mysql("Access denied for user 'reader'@'%' to database 'shop'", 1044, "ER_DBACCESS_DENIED_ERROR", "42000"),
    ],
    [
      "MySQL table privilege (1142)",
      mysql(
        "INSERT command denied to user 'reader'@'%' for table 'orders'",
        1142,
        "ER_TABLEACCESS_DENIED_ERROR",
        "42000",
      ),
    ],
    [
      "MariaDB table privilege (1142), which qualifies the table",
      mysql(
        "INSERT command denied to user 'reader'@'%' for table `shop`.`orders`",
        1142,
        "ER_TABLEACCESS_DENIED_ERROR",
        "42000",
      ),
    ],
    [
      "MySQL column privilege (1143)",
      mysql(
        "SELECT command denied to user 'reader'@'%' for column 'secret' in table 'orders'",
        1143,
        "ER_COLUMNACCESS_DENIED_ERROR",
        "42000",
      ),
    ],
    [
      "MySQL global privilege (1227)",
      mysql(
        "Access denied; you need (at least one of) the SUPER privilege(s) for this operation",
        1227,
        "ER_SPECIFIC_ACCESS_DENIED_ERROR",
        "42000",
      ),
    ],
    [
      "MySQL routine privilege (1370)",
      mysql(
        "EXECUTE command denied to user 'reader'@'%' for routine 'shop.refund'",
        1370,
        "ER_PROCACCESS_DENIED_ERROR",
        "42000",
      ),
    ],
    [
      "SQL Server object permission (229)",
      mssql("The INSERT permission was denied on the object 'orders', database 'shop', schema 'dbo'.", 229, 14),
    ],
    [
      "SQL Server column permission (230)",
      mssql(
        "The SELECT permission was denied on the column 'secret' of the object 'orders', database 'shop', schema 'dbo'.",
        230,
        14,
      ),
    ],
    ["SQL Server database permission (262)", mssql("CREATE TABLE permission denied in database 'shop'.", 262, 16)],
    ["SQL Server action permission (297)", mssql("The user does not have permission to perform this action.", 297, 16)],
    [
      "SQL Server server permission (300)",
      mssql("VIEW SERVER PERFORMANCE STATE permission was denied on object 'server', database 'master'.", 300, 14),
    ],
    [
      "SQL Server database access (916)",
      mssql(
        'The server principal "reader" is not able to access the database "hr" under the current security context.',
        916,
        14,
      ),
    ],
    ["Oracle insufficient privileges (ORA-01031)", oracle("ORA-01031: insufficient privileges", 1031)],
    [
      "Oracle CREATE SESSION missing (ORA-01045)",
      oracle("ORA-01045: Login denied. User READER does not have CREATE SESSION privilege.", 1045),
    ],
    [
      "Db2 SQL0551N (42501)",
      shaped(
        'SQL Error [SQLSTATE=42501, SQLCODE=-551]: "READER" does not have the required authorization or privilege to perform operation "INSERT" on object "SHOP.ORDERS".',
        { sqlstate: "42501", sqlcode: -551 },
      ),
    ],
    [
      "Db2 SQL0552N (42502)",
      shaped(
        'SQL Error [SQLSTATE=42502, SQLCODE=-552]: "READER" does not have the privilege to perform operation "CREATE TABLE".',
        { sqlstate: "42502", sqlcode: -552 },
      ),
    ],
    [
      "Db2 SQL1060N (no CONNECT privilege)",
      shaped('SQL Error [SQLSTATE=08004, SQLCODE=-1060]: User "READER" does not have the CONNECT privilege.', {
        sqlstate: "08004",
        sqlcode: -1060,
      }),
    ],
    [
      "MongoDB Unauthorized (13)",
      shaped('not authorized on shop to execute command { insert: "items", ordered: true }', {
        code: 13,
        codeName: "Unauthorized",
      }),
    ],
  ];

  for (const [name, error] of privilegeRefusals) {
    test(`${name} is a PermissionDeniedError that says permission was denied, in the engine's own words`, () => {
      const mapped = mapDatabaseError(error, "postgres", "INSERT INTO orders VALUES (1)");
      expect(mapped).toBeInstanceOf(PermissionDeniedError);
      expect(mapped.code).toBe(ApiErrorCode.PERMISSION_DENIED);
      expect(mapped.message).toBe(`Permission denied: ${error.message}`);
      expect(mapped.query).toBe("INSERT INTO orders VALUES (1)");
    });
  }

  test("a refused privilege keeps the SQLSTATE its driver reported", () => {
    const mapped = mapDatabaseError(shaped("permission denied for table orders", { code: "42501" }), "postgres");
    expect(mapped.sqlstate).toBe("42501");
  });

  const credentialRefusals: [string, Error][] = [
    ["PostgreSQL invalid_password (28P01)", shaped('password authentication failed for user "app"', { code: "28P01" })],
    [
      "PostgreSQL pg_hba refusal (28000)",
      shaped('no pg_hba.conf entry for host "10.0.0.7", user "app", database "shop", no encryption', { code: "28000" }),
    ],
    ["PostgreSQL unknown role (28000)", shaped('role "ghost" does not exist', { code: "28000" })],
    [
      "MySQL wrong password (1045)",
      mysql("Access denied for user 'app'@'10.0.0.7' (using password: YES)", 1045, "ER_ACCESS_DENIED_ERROR", "28000"),
    ],
    [
      "MySQL no password given (1698)",
      mysql("Access denied for user 'app'@'localhost'", 1698, "ER_ACCESS_DENIED_NO_PASSWORD_ERROR", "28000"),
    ],
    [
      "MySQL expired password (1820)",
      mysql("You must reset your password using ALTER USER statement", 1820, "ER_MUST_CHANGE_PASSWORD", "HY000"),
    ],
    [
      "MySQL expired password at login (1862)",
      mysql(
        "Your password has expired. To log in you must change it using a client that supports expired passwords.",
        1862,
        "ER_MUST_CHANGE_PASSWORD_LOGIN",
        "HY000",
      ),
    ],
    [
      "MySQL locked account (3118)",
      mysql("Access denied for user 'app'@'%'. Account is locked.", 3118, "ER_ACCOUNT_HAS_BEEN_LOCKED", "HY000"),
    ],
    [
      "MySQL account blocked after failed logins (3955)",
      mysql(
        "Access denied for user 'app'@'%'. Account is blocked for 1 day(s) (1 day(s) remaining) due to 3 consecutive failed logins.",
        3955,
        "ER_USER_ACCESS_DENIED_FOR_USER_ACCOUNT_BLOCKED_BY_PASSWORD_LOCK",
        "HY000",
      ),
    ],
    // tedious raises a refused login as ELOGIN without the server's error number (18456), so its words decide.
    ["SQL Server refused login (ELOGIN)", shaped("Login failed for user 'app'.", { code: "ELOGIN" })],
    [
      "Oracle invalid credential (ORA-01017)",
      oracle("ORA-01017: invalid credential or not authorized; logon denied", 1017),
    ],
    ["Oracle null password (ORA-01005)", oracle("ORA-01005: Login denied due to invalid password.", 1005)],
    ["Oracle locked account (ORA-28000)", oracle("ORA-28000: The account is locked; login denied.", 28000)],
    [
      "Oracle expired account (ORA-28001)",
      oracle("ORA-28001: The account has expired. The password must be changed.", 28001),
    ],
    [
      "Db2 SQL30082N (security processing failed)",
      shaped(
        'SQL Error [SQLSTATE=08001, SQLCODE=-30082]: Security processing failed with reason "24" ("USERNAME AND/OR PASSWORD INVALID").',
        { sqlstate: "08001", sqlcode: -30082 },
      ),
    ],
    [
      "MongoDB AuthenticationFailed (18)",
      shaped("Authentication failed.", { code: 18, codeName: "AuthenticationFailed" }),
    ],
  ];

  for (const [name, error] of credentialRefusals) {
    test(`${name} stays an AuthenticationError`, () => {
      const mapped = mapDatabaseError(error, "postgres");
      expect(mapped).toBeInstanceOf(AuthenticationError);
      expect(mapped.code).toBe(ApiErrorCode.AUTH_ERROR);
      expect(mapped.message).toBe(`Authentication failed: ${error.message}`);
    });
  }

  // A code that names neither refusal decides by itself, so a name that holds one of the words is not read as one: a
  // column called password is the statement's fault, not a refused credential.
  const neitherRefusal: [string, Error, new (...args: never[]) => DatabaseError][] = [
    ["PostgreSQL unknown column (42703)", shaped('column "password" does not exist', { code: "42703" }), QueryError],
    [
      "PostgreSQL unknown relation (42P01)",
      shaped('relation "user_passwords" does not exist', { code: "42P01" }),
      QueryError,
    ],
    [
      "MySQL unknown column (1054)",
      mysql("Unknown column 'password' in 'field list'", 1054, "ER_BAD_FIELD_ERROR", "42S22"),
      QueryError,
    ],
    ["SQL Server unknown column (207)", mssql("Invalid column name 'password'.", 207, 16), QueryError],
    ["Oracle invalid identifier (ORA-00904)", oracle('ORA-00904: "PASSWORD": invalid identifier', 904), QueryError],
    ["bun:sqlite unknown column", shaped("no such column: password", { code: "SQLITE_ERROR", errno: 1 }), QueryError],
    [
      "node:sqlite unknown column",
      shaped("no such column: password", { code: "ERR_SQLITE_ERROR", errcode: 1, errstr: "SQL logic error" }),
      QueryError,
    ],
    [
      "a MongoDB server error whose code is neither (2, BadValue)",
      shaped("the password field must be a string", { code: 2, codeName: "BadValue" }),
      DatabaseError,
    ],
  ];

  for (const [name, error, expected] of neitherRefusal) {
    test(`${name} naming a password is read by its code, not by its words`, () => {
      const mapped = mapDatabaseError(error, "postgres");
      expect(mapped.constructor).toBe(expected);
      expect(mapped.message).toBe(error.message);
    });
  }

  // Only an error that carries no code is read by its words, as every error used to be.
  test("an error with no code that says permission denied is a PermissionDeniedError", () => {
    const error = shaped("EACCES: permission denied, open '/data/app.duckdb'", { code: "EACCES", errno: -13 });
    const mapped = mapDatabaseError(error, "duckdb");
    expect(mapped).toBeInstanceOf(PermissionDeniedError);
    expect(mapped.message).toBe("Permission denied: EACCES: permission denied, open '/data/app.duckdb'");
  });

  test("an error with no code that names a password is an AuthenticationError", () => {
    // `pg` raises this one itself, before the server says anything, so it carries no SQLSTATE.
    const error = new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string");
    expect(mapDatabaseError(error, "postgres")).toBeInstanceOf(AuthenticationError);
  });
});

// ============================================================================
// Oracle Thick-mode diagnostics (#538)
// ============================================================================

describe("describeOracleThinModeRefusal", () => {
  test("returns null for an error that has nothing to do with Thin mode", () => {
    expect(describeOracleThinModeRefusal("ora-00942: table or view does not exist")).toBeNull();
  });

  test("names the pre-12.1 server for NJS-138", () => {
    expect(describeOracleThinModeRefusal("njs-138: ...")).toContain("12.1");
  });

  test("names the verifier for NJS-116", () => {
    expect(describeOracleThinModeRefusal("njs-116: password verifier type 0x939")).toContain("verifier");
  });

  test("names native network encryption for NJS-533", () => {
    expect(describeOracleThinModeRefusal("njs-533: ...")).toContain("Native Network Encryption");
  });

  test("names both ways out of an sso-only wallet for NJS-529", () => {
    const reason = describeOracleThinModeRefusal("njs-529: invalid wallet content format");
    // Thin mode reads PEM only, so converting the wallet is a real alternative
    // to installing an Instant Client.
    expect(reason).toContain("PEM");
    expect(reason).toContain("ewallet.pem");
  });
});

describe("describeOracleClientLoadFailure", () => {
  test("NJS-045 is reported as a packaging defect of the build, naming platform and arch", () => {
    const message = describeOracleClientLoadFailure(
      "/opt/oracle/instantclient_19_28",
      "Error: NJS-045: cannot load a node-oracledb Thick mode binary for Node.js",
    );

    expect(message).toContain("NJS-045");
    expect(message).toContain(`${process.platform}-${process.arch}`);
    // The operator must not go hunting for a path problem that is not one.
    expect(message).toContain("packaging");
  });

  test("DPI-1047 points at the loader path, libaio and the recipe", () => {
    const message = describeOracleClientLoadFailure(
      "/opt/oracle/instantclient_19_28",
      'Error: DPI-1047: Cannot locate a 64-bit Oracle Client library: "libnnz19.so: cannot open shared object file"',
    );

    expect(message).toContain("/opt/oracle/instantclient_19_28");
    expect(message).toContain("ldconfig");
    expect(message).toContain("LD_LIBRARY_PATH");
    expect(message).toContain("libaio.so.1");
    expect(message).toContain("docs/providers/oracle.md");
  });

  test("any other failure keeps a generic message that still names the variable", () => {
    const message = describeOracleClientLoadFailure("/tmp/ic", "Error: something else entirely");

    expect(message).toContain("ORACLE_CLIENT_LIB_DIR");
    expect(message).toContain("/tmp/ic");
    expect(message).toContain("something else entirely");
    expect(message).not.toContain("NJS-045");
  });
});

describe("waitedSeconds", () => {
  test("tenths below 10 s, never fewer than 0.1", () => {
    expect(waitedSeconds(0)).toBe("0.1 seconds");
    expect(waitedSeconds(30)).toBe("0.1 seconds");
    expect(waitedSeconds(300)).toBe("0.3 seconds");
    expect(waitedSeconds(1500)).toBe("1.5 seconds");
    expect(waitedSeconds(9940)).toBe("9.9 seconds");
  });

  test("the singular for one second", () => {
    expect(waitedSeconds(1000)).toBe("1 second");
    expect(waitedSeconds(1040)).toBe("1 second");
  });

  test("whole seconds from 10 s up", () => {
    expect(waitedSeconds(9960)).toBe("10 seconds");
    expect(waitedSeconds(10_000)).toBe("10 seconds");
    expect(waitedSeconds(20_232)).toBe("20 seconds");
  });
});

describe("connectPhase", () => {
  const SENTENCE =
    /^The connection got no answer after (\d+(?:\.\d)?) seconds?: check the address, the port, the network path and that the server is running\.$/;

  test("a connect that returns returns", async () => {
    await expect(connectPhase(async () => {})).resolves.toBeUndefined();
  });

  test("a deadline in the connect is a ConnectionError naming the wait, with the provider and the cause, never a query", async () => {
    const deadline = new TimeoutError("The API server did not answer the request within 10 s.", "kubernetes", 10000);
    const error = await connectPhase(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      throw deadline;
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    const failure = error as ConnectionError;
    const match = SENTENCE.exec(failure.message);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(0.2);
    expect(Number(match?.[1])).toBeLessThan(2);
    expect(failure.provider).toBe("kubernetes");
    expect(failure.cause).toBe(deadline);
    expect(failure.message.toLowerCase()).not.toContain("query");
  });

  test("every other failure passes through as it was raised", async () => {
    const refused = new ConnectionError("No answer from db.test:6443 after 10 seconds: check the address.", "qdrant");
    const denied = new AuthenticationError("bad token", "kubernetes");
    expect(await connectPhase(() => Promise.reject(refused)).catch((e: unknown) => e)).toBe(refused);
    expect(await connectPhase(() => Promise.reject(denied)).catch((e: unknown) => e)).toBe(denied);
  });
});

describe("connectFailureReason", () => {
  test("names every address an AggregateError from a dial to localhost carries", () => {
    const error = Object.assign(
      new AggregateError(
        [new Error("connect ECONNREFUSED ::1:5432"), new Error("connect ECONNREFUSED 127.0.0.1:5432")],
        "",
      ),
      { code: "ECONNREFUSED" },
    );
    expect(connectFailureReason(error)).toBe("connect ECONNREFUSED ::1:5432, connect ECONNREFUSED 127.0.0.1:5432");
  });

  test("reads a reason that is not an Error as a string", () => {
    expect(connectFailureReason(new AggregateError(["refused", ""], ""))).toBe("refused");
  });

  test("falls back to the code when the AggregateError carries no reason", () => {
    expect(connectFailureReason(Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" }))).toBe(
      "ECONNREFUSED",
    );
    expect(connectFailureReason(new AggregateError([], ""))).toBe("");
  });

  test("keeps the message an AggregateError or a plain Error gives", () => {
    expect(connectFailureReason(new AggregateError([new Error("inner")], "outer"))).toBe("outer");
    expect(connectFailureReason(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(
      "connect ECONNREFUSED 127.0.0.1:5432",
    );
  });

  test("reads a value that is not an Error as a string", () => {
    expect(connectFailureReason("socket closed")).toBe("socket closed");
  });
});
