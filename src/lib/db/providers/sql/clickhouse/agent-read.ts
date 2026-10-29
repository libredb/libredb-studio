/**
 * The agent read-only execution profile's statement path on ClickHouse: the settings every agent request carries,
 * the fence for the table functions that reach another server, and the reading of an answer against the budget.
 *
 * The boundary is the engine's own: every request carries `readonly = 1`, under which ClickHouse refuses every write,
 * DDL, SYSTEM statement, grant and temporary table with code 164, and refuses a change of any setting in the
 * statement, `readonly` itself included, so a trailing `SETTINGS readonly = 0` cannot lower it and a trailing
 * `SETTINGS max_result_rows = ...` cannot raise a budget (all measured on 26.7.1.1315). `readonly = 2` would let a
 * statement change settings, so the value is pinned to 1, never 2. What `readonly` does not restrict is the
 * principal's to hold, and is proved at open (`agent-boundary.ts`).
 */
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { SqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";
import { readSqlWord } from "@/lib/sql/words";
import { byteBudgetSentence, measureResultBytes, rowBudgetSentence } from "../read-only-budget";
import type { ClickHouseQueryResult } from "./transport";

const MILLISECONDS_PER_SECOND = 1000;

/**
 * The settings every agent request carries, the open's probes included.
 *
 * - `readonly: 1`: the boundary itself, see the module docblock.
 * - `max_execution_time`: the server's own deadline, in whole seconds, rounded up so it never ends a statement before
 *   the budget does; the client deadline the transport holds ends the wait at the budget itself.
 * - `max_result_rows` with `result_overflow_mode: "throw"`: the server refuses a result past the row budget (code
 *   396) rather than cutting it, measured: 10 rows under a bound of 10 answer, 11 are refused.
 * - `cancel_http_readonly_queries_on_client_close: 1`: a request the client abandons, at its deadline or at the body
 *   cap, is cancelled on the server rather than left to run to its own end.
 */
export function agentRequestSettings(budget: ReadOnlyStatementBudget): Record<string, string | number> {
  return {
    readonly: 1,
    max_execution_time: Math.ceil(budget.statementTimeoutMs / MILLISECONDS_PER_SECOND),
    max_result_rows: budget.maxResultRows,
    result_overflow_mode: "throw",
    cancel_http_readonly_queries_on_client_close: 1,
  };
}

/**
 * How far past the byte budget the raw answer may run before the transport stops reading it. The budget counts the
 * rows as the caller receives them, keyed by column name, and the raw answer carries each row as a positional array
 * plus the column list and the statistics once, so the rows are never smaller than the answer less its envelope. One
 * MiB covers the column list of any ordinary result; a result whose column list alone runs past it is refused, the
 * fail-closed direction.
 */
export const AGENT_ENVELOPE_ALLOWANCE_BYTES = 1024 * 1024;

/** The most bytes an agent answer may carry on the wire: the byte budget plus the envelope. */
export function agentBodyCap(budget: ReadOnlyStatementBudget): number {
  return budget.maxResultBytes + AGENT_ENVELOPE_ALLOWANCE_BYTES;
}

/**
 * The table functions that send a statement to another server: `remote` and `remoteSecure` name the server,
 * `cluster` and `clusterAllReplicas` reach every server of a configured cluster. Under `readonly = 1` the first two
 * are refused by the engine, since a table function needs a temporary table, but `cluster` is not, measured: an
 * unrestricted user's `SELECT * FROM cluster('default', system.one)` answered. A least-privilege principal holds no
 * REMOTE grant, which the open proves, and is refused `cluster` with code 497 (measured), so this fence is defence in
 * depth on top of both.
 *
 * Compared without case, though the server takes these names in lower case only (`REMOTE(...)` is code 46, unknown
 * table function), so no spelling the server would run is missed.
 */
const CLICKHOUSE_FENCED_TABLE_FUNCTIONS: readonly string[] = Object.freeze([
  "REMOTE",
  "REMOTESECURE",
  "CLUSTER",
  "CLUSTERALLREPLICAS",
]);

/**
 * A quoted name as the server reads it, near enough to compare: the quote stripped, a doubled quote and a backslash
 * escape each read as the character escaped, and `\xHH` as the byte it names, since the server runs
 * `` `re\x6dote`(...) `` as `remote(...)` (measured). An escape the server keeps verbatim (`"re\mote"` stays
 * `re\mote`, code 46) reads as the escaped character here, which can only fence more, never less.
 */
function unquotedName(quoted: string): string {
  const quote = quoted[0];
  return quoted
    .slice(1, -1)
    .replace(/\\x([0-9a-fA-F]{2})|\\([\s\S])/g, (_match, hex: string | undefined, escaped: string | undefined) =>
      hex === undefined ? (escaped as string) : String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replaceAll(quote + quote, quote);
}

/**
 * The name a call opens with at `index`, if one does: a word, or a quoted identifier, since the server runs
 * `"remote"(...)` and `` `remote`(...) `` as `remote(...)` (measured). Null for anything else.
 */
function nameAt(sql: string, index: number, grammar: SqlGrammar): { name: string; end: number } | null {
  const span = readSqlSpan(sql, index, grammar);
  if (span?.kind === "quoted-identifier") {
    return { name: unquotedName(sql.slice(index, span.end)).toUpperCase(), end: span.end };
  }
  if (span !== null) return null;
  const word = readSqlWord(sql, index);
  return word === null ? null : { name: word.text, end: word.end };
}

/** Whether the next code character after `index`, past whitespace and comments, is an opening parenthesis. */
function callFollows(sql: string, index: number, grammar: SqlGrammar): boolean {
  let i = index;
  for (;;) {
    const span = readSqlSpan(sql, i, grammar);
    if (
      span === null ||
      (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment")
    ) {
      return sql[i] === "(";
    }
    i = span.end;
  }
}

/**
 * Refuses a statement that calls a fenced table function, read with ClickHouse's own grammar (`resolveSqlGrammar`),
 * so a name inside a string or a comment is not a call and a call after a `#` line comment is not missed. A subscript
 * is read into rather than skipped, because an array can hold a scalar subquery. A statement whose literal or comment
 * never closes is refused too, since what follows it cannot be read. Both refusals are `RefusedBeforeSendError`: the
 * fence runs before the request, so the server never sees the statement.
 */
export function assertNoRemoteTableFunction(sql: string, grammar: SqlGrammar): void {
  let i = 0;
  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
    if (span !== null && !span.terminated) {
      throw new RefusedBeforeSendError(
        "Read-only execution refused a statement whose literal or comment does not close",
        "clickhouse",
        sql,
      );
    }
    const called = nameAt(sql, i, grammar);
    if (called !== null) {
      if (CLICKHOUSE_FENCED_TABLE_FUNCTIONS.includes(called.name) && callFollows(sql, called.end, grammar)) {
        throw new RefusedBeforeSendError(
          `Read-only execution refused the table function ${sql.slice(i, called.end)}(), which reaches another server`,
          "clickhouse",
          sql,
        );
      }
      i = called.end;
      continue;
    }
    // A subscript is entered one character in, so what it holds is read as code.
    i = span === null || span.kind === "subscript" ? i + 1 : span.end;
  }
}

/** The row count a refusal for code 396 names: the server's own, when it gave a whole number past the budget. */
function overflowRows(message: string, allowed: number): number {
  const counted = /current rows: (\d+)\.00\b/.exec(message);
  const rows = counted === null ? Number.NaN : Number(counted[1]);
  return Number.isSafeInteger(rows) && rows > allowed ? rows : allowed + 1;
}

/** The shared row refusal for an answer the server refused past `max_result_rows` (code 396). */
export function rowOverflowRefusal(message: string, budget: ReadOnlyStatementBudget, sql: string): QueryError {
  return new QueryError(
    rowBudgetSentence(overflowRows(message, budget.maxResultRows), budget.maxResultRows),
    "clickhouse",
    sql,
  );
}

/**
 * The transport's answer as the agent's result, or the shared refusal. An answer in a format the statement chose
 * itself (`FORMAT TSV`) is refused, since its rows cannot be counted or measured; the row bound is checked again on
 * the parsed rows, and the byte bound on the rows as the caller receives them.
 */
export function readAgentAnswer(
  answer: ClickHouseQueryResult,
  budget: ReadOnlyStatementBudget,
  sql: string,
  executionTime: number,
): QueryResult {
  if (answer.rawText !== null) {
    throw new QueryError(
      "Read-only execution takes a result as rows only: remove the FORMAT clause from the statement",
      "clickhouse",
      sql,
    );
  }
  const rows = answer.rows;
  if (rows.length > budget.maxResultRows) {
    throw new QueryError(rowBudgetSentence(rows.length, budget.maxResultRows), "clickhouse", sql);
  }
  const bytes = measureResultBytes(rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "clickhouse", sql);
  }
  const reportedMs = Math.round(answer.executionTimeMs);
  return {
    rows,
    fields: answer.fieldNames ?? [],
    rowCount: rows.length,
    executionTime: reportedMs > 0 ? reportedMs : executionTime,
    ...(answer.columnTypes !== null && Object.keys(answer.columnTypes).length > 0
      ? { columnTypes: answer.columnTypes }
      : {}),
  };
}
