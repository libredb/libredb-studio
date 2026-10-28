/**
 * The libSQL agent read-only profile's reading of an answer against the budget (`agent-read.ts`).
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  AGENT_ENVELOPE_ALLOWANCE_BYTES,
  AGENT_WIRE_EXPANSION,
  agentBodyCap,
  readAgentAnswer,
} from "@/lib/db/providers/sql/libsql/agent-read";
import type { LibSQLStatementResult } from "@/lib/db/providers/sql/libsql/transport";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";

const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 2, maxResultBytes: 1_000 };

function answer(
  rows: Record<string, unknown>[],
  overrides: Partial<LibSQLStatementResult> = {},
): LibSQLStatementResult {
  return {
    rows,
    fieldNames: rows.length > 0 ? Object.keys(rows[0] as object) : [],
    columnTypes: {},
    affectedRowCount: 0,
    lastInsertRowId: null,
    executionTimeMs: 3.4,
    ...overrides,
  };
}

describe("agentBodyCap", () => {
  test("is the byte budget times the wire's expansion, plus the envelope", () => {
    expect(AGENT_WIRE_EXPANSION).toBe(6);
    expect(AGENT_ENVELOPE_ALLOWANCE_BYTES).toBe(1024 * 1024);
    expect(agentBodyCap(BUDGET)).toBe(6_000 + 1024 * 1024);
  });
});

describe("readAgentAnswer", () => {
  test("hands back the rows, the declared names, the count and the engine's own time", () => {
    const result = readAgentAnswer(
      answer([{ id: 1, name: "a" }], { columnTypes: { id: "INTEGER" } }),
      BUDGET,
      "SELECT id, name FROM t",
      9,
    );

    expect(result).toEqual({
      rows: [{ id: 1, name: "a" }],
      fields: ["id", "name"],
      rowCount: 1,
      executionTime: 3,
      columnTypes: { id: "INTEGER" },
    });
  });

  test("falls back to the measured time when the engine reports under a millisecond, and omits no declared type", () => {
    const result = readAgentAnswer(answer([], { executionTimeMs: 0.02 }), BUDGET, "SELECT 1 WHERE 0", 7);

    expect(result).toEqual({ rows: [], fields: [], rowCount: 0, executionTime: 7 });
  });

  test("refuses a result past the row budget with the shared sentence", () => {
    const run = () => readAgentAnswer(answer([{ a: 1 }, { a: 2 }, { a: 3 }]), BUDGET, "SELECT a FROM t", 1);

    expect(run).toThrow(QueryError);
    expect(run).toThrow("Read-only execution exceeded the row budget: 3 rows > 2 allowed");
  });

  test("refuses a result past the byte budget with the shared sentence", () => {
    const run = () => readAgentAnswer(answer([{ a: "x".repeat(2_000) }]), BUDGET, "SELECT a FROM t", 1);

    expect(run).toThrow("Read-only execution exceeded the byte budget: 2010 bytes > 1000 allowed");
  });
});
