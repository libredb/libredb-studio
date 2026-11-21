/**
 * The one core call of a provider's read-only statement path (`DatabaseProvider.queryReadOnly`).
 *
 * The agent's statement path, the editor's hand-over replay and every MCP statement tool reach a provider's
 * `queryReadOnly` through `runReadOnlyStatement` and nothing else, which `tests/unit/db/operations/read-only-statement-callers.test.ts`
 * holds. Each provider already refuses a result past the row or byte budget it is handed, and bounds the statement by
 * the budget's timeout as its engine allows; this function holds the provider's answer to the same budget again, so
 * the caps are Studio's and not only a claim each provider makes:
 *
 * - **Rows.** An answer with more rows than `maxResultRows` is refused in the row sentence every provider raises
 *   (`rowBudgetSentence`). An estimating plan (`mode: "estimate-plan"`) is held to the byte budget only: its rows are
 *   the optimizer's operators, not data rows (SQL Server's SHOWPLAN answers one per operator, 340 for an ordinary
 *   union of one view with itself), and SQL Server's provider exempts them from its row budget the same way. The mode
 *   is the caller's own choice (`composeEstimatingExplain`, `mongoInspectPlanTool`), not a provider's claim, and the
 *   exemption rests on the obligation `ReadOnlyStatementMode` states: a provider handed `"estimate-plan"` answers a
 *   plan or refuses, so the byte budget is then the only cap core holds that answer to.
 * - **Bytes.** The UTF-8 JSON bytes of each served row are summed (`measureRowBytes`, a bigint cell counting as its
 *   decimal text), stopping at the row that carries the sum past `maxResultBytes`, which is refused in the byte
 *   sentence (`byteBudgetSentence`); a row after that one is never serialised. The per-row sum is never more than the
 *   whole array's JSON, which adds brackets and commas, so no answer a provider admitted by measuring the rows it
 *   serves is refused here. It is the size of the rows a prompt, an MCP answer or a hand-over response carries, which
 *   is why MongoDB's BSON measure on the wire is followed by this one.
 * - **Time.** With `wait: "statement-timeout"` this function stops waiting at `statementTimeoutMs` and refuses in the
 *   time sentence (`TIME_BUDGET_PREFIX`). The wait starts when the provider's `queryReadOnly` returns its promise, so it
 *   includes the provider's own connection checkout: a statement refused here may not have started yet, and may still
 *   start once a connection frees, and a connection that failed to open after the timer is answered in the same time
 *   sentence. The abandoned call is not cancelled. It runs on until the engine's own deadline ends it, where the
 *   engine has one, and to its end where it has none (DuckDB, Db2 LUW, Cassandra, Elasticsearch and OpenSearch, the
 *   engine table in `docs/MCP.md` "Limits"); on a provider that runs its statements on one connection, as DuckDB does,
 *   the run's next statement waits behind it and can itself be refused in the time sentence without having run. So a
 *   run can have more than one statement in flight at the engine: `maxConcurrentExecutions` counts the executions
 *   Studio waits on, not the engine's work. The abandoned call keeps a handler, so its late failure is never an
 *   unhandled rejection, and how it settled (answered or failed, the failure's class, and when) is written to the
 *   server log. A provider that runs a statement synchronously on the event loop (LibreDB, SQLite without its worker)
 *   returns its promise only once the statement has ended, so no timer bounds it, and its own check once the statement
 *   returns stays the bound there. With `wait: "caller-deadline"` the caller already races its own deadline over this
 *   call (MCP's `raceDeadline`), so no second timer is set.
 *
 * The refusals are the sentences the providers raise (`read-only-budget.ts`), so every reader that classifies a
 * provider's refusal by its opening (`READ_ONLY_REFUSAL_OPENINGS`) reads this function's the same way.
 *
 * A provider with no `queryReadOnly` is refused by name, in the words the execution-profile acquisition uses; `query()`
 * is never the fallback.
 */

import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import {
  assertReadOnlyBudget,
  byteBudgetSentence,
  measureRowBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import type { DatabaseProvider, ReadOnlyStatementBudget, ReadOnlyStatementMode } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import type { DatabaseType, QueryResult } from "@/lib/types";

/** One statement for a provider's read-only statement path, with the budget core holds its answer to. */
export interface ReadOnlyStatementCall {
  /** The connection's type, named in a refusal. */
  readonly type: DatabaseType;
  readonly statement: string;
  readonly budget: ReadOnlyStatementBudget;
  readonly mode?: ReadOnlyStatementMode;
  /**
   * `"statement-timeout"`: this function stops waiting at `budget.statementTimeoutMs`. `"caller-deadline"`: the caller
   * already races its own deadline over this call, so a second timer is not set.
   */
  readonly wait: "statement-timeout" | "caller-deadline";
}

/** Runs `call.statement` on the provider's read-only statement path and holds the answer to `call.budget`. */
export async function runReadOnlyStatement(
  provider: DatabaseProvider,
  call: ReadOnlyStatementCall,
): Promise<QueryResult> {
  const { type, statement, budget, mode } = call;
  assertReadOnlyBudget(budget, type);
  if (typeof provider.queryReadOnly !== "function") {
    throw new ExecutionProfileError(
      `Provider type "${type}" implements no read-only statement path (queryReadOnly)`,
      "PROFILE_UNSUPPORTED_BY_PROVIDER",
    );
  }
  const answered = provider.queryReadOnly(statement, budget, mode);
  const result = call.wait === "statement-timeout" ? await withinStatementTimeout(answered, call) : await answered;
  // A plan's rows are the optimizer's operators, not data rows (SQL Server's SHOWPLAN answers one per operator), so an
  // estimating plan is held to the byte budget only, as SQL Server's provider holds it.
  if (mode !== "estimate-plan" && result.rows.length > budget.maxResultRows) {
    throw new QueryError(rowBudgetSentence(result.rows.length, budget.maxResultRows), type, statement);
  }
  let bytes = 0;
  for (const row of result.rows) {
    bytes += measureRowBytes(row);
    if (bytes > budget.maxResultBytes) {
      throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), type, statement);
    }
  }
  return result;
}

/**
 * `answered`, or the time refusal once `statementTimeoutMs` has passed; the timer is cleared on every path. When the
 * timer wins, how the abandoned call settles later is written to the server log (`logLateSettlement`).
 */
function withinStatementTimeout(answered: Promise<QueryResult>, call: ReadOnlyStatementCall): Promise<QueryResult> {
  const { statementTimeoutMs } = call.budget;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      logLateSettlement(answered, call.type, startedAt);
      reject(
        new QueryError(`${TIME_BUDGET_PREFIX}: no answer within ${statementTimeoutMs}ms`, call.type, call.statement),
      );
    }, statementTimeoutMs);
  });
  // Promise.race subscribes to `answered`, so a rejection that arrives after the timer won is handled, not unhandled.
  return Promise.race([answered, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * One server log line for a call this module stopped waiting for, once it settles: the connection type, whether it
 * answered or failed, the failure's class and how long after the call started it settled. A late failure can be the
 * real cause the time refusal stood in for (a connection that never opened, a pool with no free client), so it is
 * recorded rather than dropped. The statement and the error's message are never written: core has no redaction of its
 * own, and the class names the kind of failure.
 */
function logLateSettlement(answered: Promise<QueryResult>, type: DatabaseType, startedAt: number): void {
  const line = "A read-only statement settled after Studio stopped waiting for it";
  answered.then(
    () => logger.warn(line, { provider: type, outcome: "answered", settledAfterMs: Date.now() - startedAt }),
    (error: unknown) =>
      logger.warn(line, {
        provider: type,
        outcome: "failed",
        errorClass: error instanceof Error ? error.name : typeof error,
        settledAfterMs: Date.now() - startedAt,
      }),
  );
}
