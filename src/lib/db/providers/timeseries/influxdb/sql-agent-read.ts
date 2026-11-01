/**
 * The `influxdb3` agent read-only execution profile's own rules: the server line the boundary was measured on, the
 * `system` schema fence, the response cap taken from the byte budget, the strict shaping of an answer, and the budget
 * refusals a failed request becomes.
 *
 * The boundary is the engine's. `/api/v3/query_sql` carries free statement text, and InfluxDB 3.12.0 Core's planner
 * refuses every write, DDL, COPY, SET, PREPARE and transaction statement on it, behind EXPLAIN and WITH too, whatever
 * the token (tests/fixtures/influxdb/3.12.0-core/write-refusal/, replayed by the provider's integration test). Core
 * mints only admin tokens, so no credential can carry the boundary: it is the planner of a measured line, and a server
 * outside `INFLUXDB3_CHECKED_RELEASES` is refused at open until its own answers are captured. `evaluateInfluxSql`, which
 * every text passes first, and the fence below are parser-only defence in front of it.
 *
 * Budgets refuse rather than truncate: the request's response cap comes from the byte budget, and the answer is shaped
 * in the `refuse` mode of `shapeJsonlBody`, so a row past the row budget, a row past the cell budget and rows past the
 * byte budget each throw the shared sentence of `read-only-budget.ts` before anything is returned.
 */
import { ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  assertReadOnlyBudget,
  byteBudgetSentence,
  measureResultBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { INFLUX_CELL_BUDGET } from "./connection-options";
import { InfluxShapeOverflowError, shapeJsonlBody } from "./sql-results";
import type { InfluxServerVersion } from "./versions";

/**
 * The releases, as the version's first two numbers, whose write refusals were captured from a live server: 3.12.0 Core.
 * Enterprise was not measured, and a server that names no version (a resource token's `/ping` 403) cannot be placed.
 */
export const INFLUXDB3_CHECKED_RELEASES: readonly string[] = Object.freeze(["3.12"]);
const CHECKED_BUILD = "Core";

/** Refuses a server outside the measured line, before any agent statement is sent. */
export function assertCheckedServer(version: InfluxServerVersion): void {
  const checked = `InfluxDB 3 ${CHECKED_BUILD} ${INFLUXDB3_CHECKED_RELEASES.join(", ")}`;
  const release = /^v?(\d+\.\d+)\./.exec(version.reported ?? "")?.[1];
  if (release === undefined || version.build === null) {
    throw new ExecutionProfileError(
      `The agent read-only profile is checked on ${checked}, and this server reports no version and build, so it is refused`,
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  if (version.build !== CHECKED_BUILD || !INFLUXDB3_CHECKED_RELEASES.includes(release)) {
    throw new ExecutionProfileError(
      `The agent read-only profile is checked on ${checked}, and this server is InfluxDB 3 ${version.build} ${version.reported}: its write refusals have not been captured, so it is refused`,
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
}

const SYSTEM_SCHEMA = "system";
const READABLE_SYSTEM_TABLE = "influxdb_schema";
const SYSTEM_TABLE_REFUSAL =
  "The agent reads no table of InfluxDB 3's system schema but system.influxdb_schema: the others hold other queries' text, files and engine logs";

const STRING_QUALIFIER_REFUSAL =
  "The agent reads no name written as a string before a `.`, since InfluxDB 3 reads it as a schema or table name and the system schema fence reads only names: write the name bare or in double quotes";

/** One token of a statement's code: a name (bare, folded, or quoted, unquoted), a string, a `.`, or anything else. */
type Token = { readonly kind: "name"; readonly name: string } | { readonly kind: "string" | "dot" | "other" };

const WORD_AT = /[A-Za-z0-9_]+/y;

/**
 * The statement's code as tokens, read with the DataFusion grammar row: whitespace and comments dropped, a string one
 * opaque token of its own kind, a quoted name its text with `""` undone. A `[` is stepped over one character at a time, as the read
 * policy steps into a subscript, so the code inside it is read too. The policy has already refused text that never
 * closes, a `$` and a character outside ASCII outside quotes.
 */
function tokens(sql: string): Token[] {
  const grammar = resolveSqlGrammar("influxdb3");
  const found: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const ch = sql[index];
    const span = ch === "[" ? null : readSqlSpan(sql, index, grammar);
    if (span !== null) {
      if (span.kind === "quoted-identifier") {
        found.push({ kind: "name", name: sql.slice(index + 1, span.end - 1).replaceAll('""', '"') });
      } else if (span.kind === "string") {
        found.push({ kind: "string" });
      } else if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") {
        found.push({ kind: "other" });
      }
      index = span.end;
      continue;
    }
    WORD_AT.lastIndex = index;
    const word = WORD_AT.exec(sql)?.[0];
    if (word !== undefined) {
      found.push({ kind: "name", name: word });
      index += word.length;
      continue;
    }
    found.push({ kind: ch === "." ? "dot" : "other" });
    index++;
  }
  return found;
}

const isNamed = (token: Token | undefined, name: string): boolean =>
  token?.kind === "name" && token.name.toLowerCase() === name;

/**
 * Refuses a statement that names a table of the `system` schema other than `system.influxdb_schema`: `system.queries`
 * holds the text of every query the server ran, `system.parquet_files` the store's file paths and
 * `system.processing_engine_logs` the plugins' output. A name `system` followed by a `.` is the schema, whatever its
 * case or quoting and whatever stands before it (`public.system.queries`), and only `influxdb_schema` may follow it.
 * DataFusion also reads a string before a `.` as a name (`'system'.queries` is answered with the rows of
 * `system.queries`), and its content can be escaped past any reading of it, so a string before a `.` is refused
 * whatever it holds: no read needs one. Parser-only defence: the engine itself serves these tables to any Core token. Raised as `RefusedBeforeSendError`,
 * since the statement is never sent.
 */
export function assertNoSystemTable(sql: string): void {
  const read = tokens(sql);
  for (let index = 0; index < read.length; index++) {
    if (read[index].kind === "string" && read[index + 1]?.kind === "dot")
      throw new RefusedBeforeSendError(STRING_QUALIFIER_REFUSAL, "influxdb3", sql);
    if (!isNamed(read[index], SYSTEM_SCHEMA) || read[index + 1]?.kind !== "dot") continue;
    if (!isNamed(read[index + 2], READABLE_SYSTEM_TABLE))
      throw new RefusedBeforeSendError(SYSTEM_TABLE_REFUSAL, "influxdb3", sql);
  }
}

/** Refuses a budget any field of which is not a positive integer in range, as every agent read path does. */
export function assertAgentBudget(budget: ReadOnlyStatementBudget): void {
  assertReadOnlyBudget(budget, "influxdb3");
}

/**
 * How many wire bytes one byte of the answer, as the caller receives it, may take. A jsonl line carries each value as
 * the caller's row does, minus the null cells it omits; the one way it is longer is a character outside ASCII written
 * as a `\uXXXX` escape, six bytes for one of two to four, at most three times as many. So an answer past three times
 * the budget is past the budget once shaped.
 */
export const AGENT_WIRE_EXPANSION = 3;

/** Room beside the rows for an answer the server words as an error, which is not a row. */
export const AGENT_ENVELOPE_ALLOWANCE_BYTES = 64 * 1024;

/** The most bytes an agent answer may carry on the wire. */
export function agentResponseCap(budget: ReadOnlyStatementBudget): number {
  return budget.maxResultBytes * AGENT_WIRE_EXPANSION + AGENT_ENVELOPE_ALLOWANCE_BYTES;
}

/** A jsonl answer as the agent's fields and rows, or the shared refusal: the row and cell bounds, then the byte bound. */
export function shapeAgentAnswer(
  text: string,
  budget: ReadOnlyStatementBudget,
  sql: string,
): { fields: string[]; rows: Record<string, unknown>[] } {
  let shaped: ReturnType<typeof shapeJsonlBody>;
  try {
    shaped = shapeJsonlBody(text, { rowCut: budget.maxResultRows, cellBudget: INFLUX_CELL_BUDGET }, "refuse");
  } catch (error) {
    if (!(error instanceof InfluxShapeOverflowError)) throw error;
    throw new QueryError(rowBudgetSentence(error.rows, error.allowedRows), "influxdb3", sql);
  }
  const rows = [...shaped.rows];
  const bytes = measureResultBytes(rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "influxdb3", sql);
  }
  return { fields: [...shaped.fields], rows };
}

/**
 * A failed agent request as the shared refusal it is: an answer past the response cap (more than the cap, so the
 * sentence names one byte past it) or a request past its deadline. Anything else is undefined, for the provider's own
 * error table to word.
 */
export function agentReadFailure(error: unknown, budget: ReadOnlyStatementBudget, sql: string): QueryError | undefined {
  if (!(error instanceof TransportError)) return undefined;
  if (error.kind === "too-large") {
    return new QueryError(byteBudgetSentence(agentResponseCap(budget) + 1, budget.maxResultBytes), "influxdb3", sql);
  }
  if (error.kind === "timeout") {
    return new QueryError(`${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`, "influxdb3", sql);
  }
  return undefined;
}
