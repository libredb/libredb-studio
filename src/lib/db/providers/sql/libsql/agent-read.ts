/**
 * The agent read-only execution profile's statement path on libSQL: the cap on what an answer may carry, and the
 * reading of an answer against the budget.
 *
 * The boundary is the token's, proven at open (`agent-boundary.ts`). Each call is one statement in one request that
 * closes its own stream, so nothing a statement opens outlives it: sqld refuses a second statement in the same text
 * (`SQL_MANY_STATEMENTS`, measured), and the transport sends exactly one statement step per request. Hrana has no
 * server-side row or byte bound, so the transport stops reading at the cap below and the parsed rows are held to the
 * budget again; every refusal is the shared sentence of `read-only-budget.ts`.
 */
import { QueryError } from "@/lib/db/errors";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import { byteBudgetSentence, measureResultBytes, rowBudgetSentence } from "../read-only-budget";
import type { LibSQLStatementResult } from "./transport";

/**
 * How many wire bytes one byte of the answer, as the caller receives it, may take. The caller's row carries each value
 * under its column name, at least `"a":0,` (six bytes); the wire carries it positionally in a typed wrapper, at most
 * `{"type":"integer","value":"0"},` for a value of the same digits, which is five times as many. Six covers that with
 * room, so a result within the byte budget is never stopped on the wire. A value of a type this build does not decode
 * reads as null and can make the wire larger still, which only stops the read sooner: the fail-closed direction.
 */
export const AGENT_WIRE_EXPANSION = 6;

/** The answer's envelope beside its rows: the column list and the per-request results, once. */
export const AGENT_ENVELOPE_ALLOWANCE_BYTES = 1024 * 1024;

/** The most bytes an agent answer may carry on the wire. */
export function agentBodyCap(budget: ReadOnlyStatementBudget): number {
  return budget.maxResultBytes * AGENT_WIRE_EXPANSION + AGENT_ENVELOPE_ALLOWANCE_BYTES;
}

/** The transport's answer as the agent's result, or the shared refusal: the row bound first, then the byte bound. */
export function readAgentAnswer(
  answer: LibSQLStatementResult,
  budget: ReadOnlyStatementBudget,
  sql: string,
  executionTime: number,
): QueryResult {
  const rows = answer.rows;
  if (rows.length > budget.maxResultRows) {
    throw new QueryError(rowBudgetSentence(rows.length, budget.maxResultRows), "libsql", sql);
  }
  const bytes = measureResultBytes(rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "libsql", sql);
  }
  const reportedMs = Math.round(answer.executionTimeMs);
  return {
    rows,
    fields: answer.fieldNames,
    rowCount: rows.length,
    executionTime: reportedMs > 0 ? reportedMs : executionTime,
    ...(Object.keys(answer.columnTypes).length > 0 ? { columnTypes: answer.columnTypes } : {}),
  };
}
