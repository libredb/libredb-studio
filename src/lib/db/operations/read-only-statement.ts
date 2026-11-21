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
 *   (`rowBudgetSentence`).
 * - **Bytes.** The UTF-8 JSON bytes of each served row are summed (`measureRowBytes`, a bigint cell counting as its
 *   decimal text), stopping at the row that carries the sum past `maxResultBytes`, which is refused in the byte
 *   sentence (`byteBudgetSentence`). The per-row sum is never more than the whole array's JSON, which adds brackets
 *   and commas, so no answer a provider measured either way and admitted is refused here. It is the size of the rows a
 *   prompt, an MCP answer or a hand-over response carries, which is why MongoDB's BSON measure on the wire is followed
 *   by this one.
 * - **Time.** With `wait: "statement-timeout"` this function stops waiting at `statementTimeoutMs` and refuses in the
 *   time sentence (`TIME_BUDGET_PREFIX`). The abandoned call keeps a rejection handler, so its late failure is never an
 *   unhandled rejection, and it is not cancelled: the provider's own deadline ends the statement. A provider that runs
 *   a statement synchronously on the event loop (SQLite without its worker) cannot be interrupted by any timer, so its
 *   own check once the statement returns stays the bound there. Because a timed-out statement may still be running,
 *   a run's next statement can start beside it on another session; `maxConcurrentExecutions` counts the run's
 *   executions, not the engine's sessions. With `wait: "caller-deadline"` the caller already races its own deadline
 *   over this call (MCP's `raceDeadline`), so no second timer is set.
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
  if (result.rows.length > budget.maxResultRows) {
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

/** `answered`, or the time refusal once `statementTimeoutMs` has passed; the timer is cleared on every path. */
function withinStatementTimeout(answered: Promise<QueryResult>, call: ReadOnlyStatementCall): Promise<QueryResult> {
  const { statementTimeoutMs } = call.budget;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new QueryError(`${TIME_BUDGET_PREFIX}: no answer within ${statementTimeoutMs}ms`, call.type, call.statement),
        ),
      statementTimeoutMs,
    );
  });
  // Promise.race subscribes to `answered`, so a rejection that arrives after the timer won is handled, not unhandled.
  return Promise.race([answered, timedOut]).finally(() => clearTimeout(timer));
}
