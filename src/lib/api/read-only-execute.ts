import { deadlineSignal, type ExecuteRequest, type PageBound } from "@libredb/provider-sdk/calls";
import { contextOn, hostPorts } from "@/lib/api/editor-query";
import { StudioTimeBudgetRefusal } from "@/lib/db/errors";
import { holdReadOnlyRows } from "@/lib/db/operations/read-only-statement";
import { assertReadOnlyBudget, TIME_BUDGET_PREFIX } from "@/lib/db/read-only-budget";
import { assertStatementsReviewed } from "@/lib/db/statement-review";
import type { DatabaseProvider, ReadOnlyStatementBudget, ReadOnlyStatementMode } from "@/lib/db/types";
import { type BudgetView, budgetRefusalError, budgetStopError } from "@/lib/provider-host/access";
import { hostCore } from "@/lib/provider-host/instance";
import { bridgedReadOnlyStatements } from "@/lib/provider-host/legacy-bridge";
import type { DatabaseType, QueryResult } from "@/lib/types";

/*
 * THE AGENT'S, THE HAND-OVER'S AND MCP'S STATEMENTS ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md,
 * clauses C-79, C-81 and C-85).
 *
 * `runReadOnlyPage` is the caller facade of a read-only statement and the page it asks for: every MCP statement
 * tool's statement (`statementOnHost` in src/lib/mcp/tools/run-statement.ts, clause C-81), whose deadline is the MCP
 * call's, and whose page run_read_query bounds. `runReadOnlyExecute` is the same facade with every row as its page:
 * every statement the agent's run sends, the model's and every composed grounding statement (`runStatement` in
 * src/lib/agent/tools.ts), and the editor's hand-over replay (src/app/api/agent/runs/[runId]/handover/route.ts).
 *
 * In this order: the engine is refused by name when Studio's review record does not list it
 * (`assertStatementsReviewed`), then a budget that is not whole positive numbers (`assertReadOnlyBudget`), so neither
 * reads the host core or reaches the provider. Then the process's host core is read (`hostCore`, clause C-52), so a
 * call made before the install fails by name, and the legacy bridge's read-only statement session is opened over the
 * provider (`bridgedReadOnlyStatements`, clause C-50), which refuses a provider without `queryReadOnly` by name, so the
 * plain `query()` is never the fallback (clause C-39). The session is a read-only statement session because each
 * caller acquired its provider under a profile whose open policy has both `readOnly` and `sendsStatements`
 * (`agent-read-only` and `agent-handover`, MCP's under `agent-read-only`); a census holds the callers to those
 * profiles.
 *
 * The call is one host core execute on that session: a fresh request of the statement, the caller's page, and the
 * read-only execute of the budget's rows and bytes and the caller's mode (clause C-78), and a fresh context whose
 * deadline is the statement timeout from now and whose signal aborts at it or when the caller's does. The statement
 * timeout and the billed-read allowance reach the provider through the session's open, the allowance by reference.
 * The session applies a bounded page through the provider's own prepare, and refuses a non-zero offset the prepare did
 * not apply as `StudioOffsetRefusal` before the provider's read path is called, which passes here by reference
 * (clause C-85).
 *
 * The answer is the provider's result by reference, with whether the session applied the page, `pageApplied` as the
 * host's page record carries it, held by `holdReadOnlyRows` to the row budget, except for an
 * estimating plan, whose rows are the optimizer's operators, and to the byte budget, in the providers' sentences, the
 * page record released in a `finally`. The host pumps the first result within its 32 MiB page (clause C-53), so a row
 * larger than one page is refused as `StudioByteBudgetRefusal` with the page's sentence, outcome unknown, and a page of
 * more than one batch waits for the core's large-page slot within the deadline.
 *
 * A stop the deadline ended, at whatever wait of the run, is `StudioTimeBudgetRefusal` in today's time sentence,
 * outcome unknown, through the accessor's budget view (clause C-51); a refused start at the deadline is the same,
 * outcome not-sent. A caller that leaves is `QueryCancelledError`, outcome unknown once the call was made and not-sent
 * before. A stopped call's settlement is handed to the caller's `holdUntilSettled` before the refusal is thrown, so an
 * agent run counts the execution until the provider's call settles. The session offers no cancel, so a stopped
 * statement runs on; its later failure reaches the host's late port and is logged under the caller's route by kind and
 * code, never its text (`hostPorts`), and a later answer is released and not logged. A provider's error passes as the
 * same object.
 */

/** One read-only statement for the host core, with the budget its answer is held to. */
export interface ReadOnlyExecuteCall {
  /**
   * The connection's type, named in a refusal. It decides the review-record gate, so it must be the type of the
   * connection the provider was acquired for.
   */
  readonly type: DatabaseType;
  readonly statement: string;
  readonly budget: ReadOnlyStatementBudget;
  /** Absent: the statement executes. */
  readonly mode?: ReadOnlyStatementMode;
  /** The caller's own signal: its abort is the caller leaving, answered `QueryCancelledError`. */
  readonly caller: AbortSignal;
  /** The label a late failure is logged under. */
  readonly route: string;
  /** Handed a stopped call's settlement, so a caller that accounts the call keeps it counted until it settles. */
  readonly holdUntilSettled?: (call: PromiseLike<unknown>) => void;
}

/** One read-only statement for the host core with the page it asks for (clause C-85). */
export interface ReadOnlyPageCall extends ReadOnlyExecuteCall {
  readonly page: PageBound;
}

/** A paged read-only execute's answer: the provider's result, and whether the provider applied the page. */
export interface ReadOnlyPageAnswer {
  readonly result: QueryResult;
  readonly pageApplied: boolean;
}

/**
 * Runs `call.statement` on `provider`'s read-only statement path through the host core and holds the answer to
 * `call.budget`, with every row as its page.
 *
 * @throws {StudioProfileRefusal} For an engine off the review record, or a provider without `queryReadOnly`.
 * @throws {QueryError} For a budget that is not whole positive numbers.
 * @throws {HostCoreBootOrderError} Before the host core is installed.
 * @throws {StudioTimeBudgetRefusal} For a statement its deadline stopped or refused.
 * @throws {QueryCancelledError} For a statement whose caller left.
 * @throws {StudioRowBudgetRefusal} Past the row budget, except for an estimating plan.
 * @throws {StudioByteBudgetRefusal} Past the byte budget, or for a row larger than one page.
 * @throws The provider's error, by reference.
 */
export async function runReadOnlyExecute(provider: DatabaseProvider, call: ReadOnlyExecuteCall): Promise<QueryResult> {
  return (await runReadOnlyPage(provider, { ...call, page: { unlimited: true } })).result;
}

/**
 * Runs `call.statement` on `provider`'s read-only statement path through the host core with `call.page` as its page,
 * holds the answer to `call.budget`, and answers whether the provider applied the page (clause C-85).
 *
 * @throws {StudioProfileRefusal} For an engine off the review record, or a provider without `queryReadOnly`.
 * @throws {QueryError} For a budget that is not whole positive numbers.
 * @throws {HostCoreBootOrderError} Before the host core is installed.
 * @throws {StudioOffsetRefusal} For a non-zero offset the provider's prepare did not apply, before anything is sent.
 * @throws {StudioTimeBudgetRefusal} For a statement its deadline stopped or refused.
 * @throws {QueryCancelledError} For a statement whose caller left.
 * @throws {StudioRowBudgetRefusal} Past the row budget, except for an estimating plan.
 * @throws {StudioByteBudgetRefusal} Past the byte budget, or for a row larger than one page.
 * @throws The provider's error, its prepare's included, by reference.
 */
export async function runReadOnlyPage(provider: DatabaseProvider, call: ReadOnlyPageCall): Promise<ReadOnlyPageAnswer> {
  const { type, statement, budget, mode } = call;
  assertStatementsReviewed(type);
  assertReadOnlyBudget(budget, type);
  const core = hostCore();
  const bridged = bridgedReadOnlyStatements(provider, {
    type,
    statementTimeoutMs: budget.statementTimeoutMs,
    ...(budget.readAllowance === undefined ? {} : { readAllowance: budget.readAllowance }),
  });
  const deadline = Date.now() + budget.statementTimeoutMs;
  const request: ExecuteRequest = {
    statement,
    page: call.page,
    readOnly: {
      budget: { maxRows: budget.maxResultRows, maxBytes: budget.maxResultBytes },
      ...(mode === undefined ? {} : { mode }),
    },
  };
  const view: BudgetView = {
    caller: call.caller,
    timeRefusal: () =>
      new StudioTimeBudgetRefusal(
        `${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`,
        type,
        statement,
      ),
  };
  const record = await core.executeCall(
    bridged.session,
    request,
    contextOn(deadline, deadlineSignal(deadline, call.caller)),
    bridged.pumpLimits,
    hostPorts(call.route),
  );
  if (record.kind === "stopped") {
    call.holdUntilSettled?.(record.settled);
    throw budgetStopError(record.reason, view);
  }
  if (record.kind === "refused") throw budgetRefusalError(record, view);
  try {
    const result = bridged.answered();
    // A plan's rows are the optimizer's operators, not data rows, so an estimating plan is held to its bytes alone.
    holdReadOnlyRows(result.rows, {
      type,
      statement,
      maxRows: mode === "estimate-plan" ? null : budget.maxResultRows,
      maxBytes: budget.maxResultBytes,
    });
    return { result, pageApplied: record.pageApplied };
  } finally {
    record.release();
  }
}
