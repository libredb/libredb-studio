/**
 * The ClickHouse agent read path's pure parts: the request settings, the table-function fence and the reading of an
 * answer against the budget. The provider wiring is in tests/integration/db/clickhouse-provider.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  AGENT_ENVELOPE_ALLOWANCE_BYTES,
  agentBodyCap,
  agentRequestSettings,
  assertNoRemoteTableFunction,
  readAgentAnswer,
  rowOverflowRefusal,
} from "@/lib/db/providers/sql/clickhouse/agent-read";
import { CLICKHOUSE_SQL_GRAMMAR } from "@/lib/db/providers/sql/clickhouse/sql-grammar";
import type { ClickHouseQueryResult } from "@/lib/db/providers/sql/clickhouse/transport";
import { DEFAULT_SQL_GRAMMAR } from "@/lib/db/sql-grammar/shared";
import { resolveSqlGrammar } from "@/lib/sql/grammar";

const BUDGET = { statementTimeoutMs: 2_500, maxResultRows: 3, maxResultBytes: 200 };
const GRAMMAR = resolveSqlGrammar("clickhouse");

function answer(overrides: Partial<ClickHouseQueryResult> = {}): ClickHouseQueryResult {
  return {
    rows: [{ id: "1" }],
    fieldNames: ["id"],
    columnTypes: { id: "UInt64" },
    executionTimeMs: 4.4,
    mutationCount: 0,
    rawText: null,
    ...overrides,
  };
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("agentRequestSettings", () => {
  test("pins readonly to 1 and carries the budget as the server's own bounds", () => {
    expect(agentRequestSettings(BUDGET)).toEqual({
      readonly: 1,
      max_execution_time: 3,
      max_result_rows: 3,
      result_overflow_mode: "throw",
      cancel_http_readonly_queries_on_client_close: 1,
    });
  });

  test("rounds the deadline up, so the server never ends a statement before the budget does", () => {
    expect(agentRequestSettings({ ...BUDGET, statementTimeoutMs: 1 }).max_execution_time).toBe(1);
    expect(agentRequestSettings({ ...BUDGET, statementTimeoutMs: 4_000 }).max_execution_time).toBe(4);
  });

  test("the body cap is the byte budget plus the envelope allowance", () => {
    expect(agentBodyCap(BUDGET)).toBe(200 + AGENT_ENVELOPE_ALLOWANCE_BYTES);
  });
});

describe("assertNoRemoteTableFunction", () => {
  test.each([
    "SELECT * FROM remote('10.0.0.1', system.one)",
    "SELECT * FROM remoteSecure('10.0.0.1', db.t, 'u', 'p')",
    "SELECT * FROM cluster('default', system.one)",
    "SELECT * FROM clusterAllReplicas('default', system.one)",
    "SELECT * FROM remote ('h', system.one)",
    "SELECT * FROM remote/* c */('h', system.one)",
    "SELECT * FROM remote -- c\n('h', system.one)",
    "SELECT * FROM \"remote\"('h', system.one)",
    "SELECT * FROM `remote`('h', system.one)",
    "SELECT * FROM `re\\x6dote`('h', system.one)",
    "SELECT * FROM `re\\mote`('h', system.one)",
    "SELECT [(SELECT count() FROM cluster('default', system.one))]",
    "SELECT * FROM # a hash comment\ncluster('default', system.one)",
  ])("refuses %p", (sql) => {
    expect(refusal(() => assertNoRemoteTableFunction(sql, GRAMMAR))).toContain("reaches another server");
  });

  test("names the call as the statement wrote it", () => {
    expect(refusal(() => assertNoRemoteTableFunction("SELECT * FROM `remote`('h', t)", GRAMMAR))).toBe(
      "Read-only execution refused the table function `remote`(), which reaches another server",
    );
  });

  test.each([
    "SELECT cluster FROM system.clusters",
    "SELECT 'remote(1)' AS s",
    "SELECT 1 /* remote('h', t) */",
    "SELECT 1 -- cluster('x', t)",
    "SELECT 1 # cluster('x', t)",
    "SELECT remotely(1)",
    "SELECT * FROM numbers(3)",
    'SELECT "remote" FROM t',
    "SELECT [1, 2, 3] AS arr",
  ])("admits %p", (sql) => {
    expect(() => assertNoRemoteTableFunction(sql, GRAMMAR)).not.toThrow();
  });

  test("refuses a statement whose literal does not close", () => {
    expect(refusal(() => assertNoRemoteTableFunction("SELECT 'open", GRAMMAR))).toContain("does not close");
  });

  // The fence reads with ClickHouse's grammar: `//` opens a line comment there and is code under the default grammar,
  // so a call written after one is hidden only from the right reader.
  test("reads with the ClickHouse grammar row, not the default one", () => {
    expect(GRAMMAR).toBe(CLICKHOUSE_SQL_GRAMMAR.grammar);
    const sql = "SELECT 1 // remote('h', t)\n";
    expect(() => assertNoRemoteTableFunction(sql, GRAMMAR)).not.toThrow();
    expect(() => assertNoRemoteTableFunction(sql, DEFAULT_SQL_GRAMMAR)).toThrow(QueryError);
  });
});

describe("rowOverflowRefusal", () => {
  test("names the server's own count when it is a whole number", () => {
    const message = "Limit for result exceeded, max rows: 10.00, current rows: 11.00. (TOO_MANY_ROWS_OR_BYTES)";
    expect(rowOverflowRefusal(message, { ...BUDGET, maxResultRows: 10 }, "SELECT 1").message).toBe(
      "Read-only execution exceeded the row budget: 11 rows > 10 allowed",
    );
  });

  test("names one past the budget when the server rounded its count", () => {
    const message =
      "Limit for result exceeded, max rows: 10.00, current rows: 65.41 thousand. (TOO_MANY_ROWS_OR_BYTES)";
    expect(rowOverflowRefusal(message, { ...BUDGET, maxResultRows: 10 }, "SELECT 1").message).toBe(
      "Read-only execution exceeded the row budget: 11 rows > 10 allowed",
    );
  });
});

describe("readAgentAnswer", () => {
  test("hands the rows, fields and declared types over", () => {
    expect(readAgentAnswer(answer(), BUDGET, "SELECT 1", 9)).toEqual({
      rows: [{ id: "1" }],
      fields: ["id"],
      rowCount: 1,
      executionTime: 4,
      columnTypes: { id: "UInt64" },
    });
  });

  test("an answer that describes no columns has no fields and no types, and the measured time", () => {
    expect(
      readAgentAnswer(answer({ rows: [], fieldNames: null, columnTypes: null, executionTimeMs: 0 }), BUDGET, "x", 9),
    ).toEqual({ rows: [], fields: [], rowCount: 0, executionTime: 9 });
    expect(readAgentAnswer(answer({ columnTypes: {} }), BUDGET, "x", 9).columnTypes).toBeUndefined();
  });

  test("refuses a result in a format the statement chose", () => {
    expect(refusal(() => readAgentAnswer(answer({ rawText: "1\n" }), BUDGET, "SELECT 1 FORMAT TSV", 1))).toBe(
      "Read-only execution takes a result as rows only: remove the FORMAT clause from the statement",
    );
  });

  test("refuses rows past the row budget", () => {
    const rows = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];
    expect(refusal(() => readAgentAnswer(answer({ rows }), BUDGET, "x", 1))).toBe(
      "Read-only execution exceeded the row budget: 4 rows > 3 allowed",
    );
  });

  test("refuses rows past the byte budget", () => {
    const rows = [{ id: "x".repeat(300) }];
    expect(refusal(() => readAgentAnswer(answer({ rows }), BUDGET, "x", 1))).toBe(
      "Read-only execution exceeded the byte budget: 311 bytes > 200 allowed",
    );
  });
});
