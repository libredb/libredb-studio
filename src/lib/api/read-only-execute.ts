import {
  BATCH_MAX_BYTES,
  type Column,
  deadlineSignal,
  type ExecuteAnswer,
  type ExecuteRequest,
  PAGE_MAX_BYTES,
  type PageBound,
  type PumpLimits,
} from "@libredb/provider-sdk/calls";
import { contextOn, hostPorts } from "@/lib/api/editor-query";
import { isPackageFailure, packageStatementFailure, packageWarnings } from "@/lib/api/package-errors";
import { markedCall, type ReadOnlyStatementTarget, readOnlyPageResult } from "@/lib/api/session-target";
import { markNotSent, QueryError, StudioTimeBudgetRefusal } from "@/lib/db/errors";
import { scrubProviderWarnings } from "@/lib/db/operations/provider-text";
import { holdReadOnlyRows } from "@/lib/db/operations/read-only-statement";
import { assertReadOnlyBudget, TIME_BUDGET_PREFIX } from "@/lib/db/read-only-budget";
import { legacyProviderType, servedEngineRecord } from "@/lib/db/server-catalog";
import { assertStatementsReviewed } from "@/lib/db/statement-review";
import type { ReadOnlyStatementBudget, ReadOnlyStatementMode } from "@/lib/db/types";
import { type BudgetView, budgetRefusalError, budgetStopError } from "@/lib/provider-host/access";
import type { HostCore } from "@/lib/provider-host/core/host-core";
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
 * src/lib/agent/tools.ts), and the editor's hand-over replay (src/app/api/agent/runs/[runId]/handover/route.ts). Each
 * runs on a target (`ReadOnlyStatementTarget` in ./session-target): a legacy provider's, which the paragraphs below
 * describe, or a provider package's read-only statement session's, which the last paragraph describes.
 *
 * In this order, for both forms: the engine is refused by name when Studio's review record does not list it
 * (`assertStatementsReviewed`), then a budget that is not whole positive numbers (`assertReadOnlyBudget`), so neither
 * reads the host core or reaches the provider. Then the process's host core is read (`hostCore`, clause C-52), so a
 * call made before the install fails by name, and, for a legacy provider, the legacy bridge's read-only statement
 * session is opened over the provider (`bridgedReadOnlyStatements`, clause C-50), which refuses a provider without
 * `queryReadOnly` by name, so the plain `query()` is never the fallback (clause C-39). The session is a read-only
 * statement session because each caller acquired its provider under a profile whose open policy has both `readOnly` and
 * `sendsStatements` (`agent-read-only` and `agent-handover`, MCP's under `agent-read-only`), or opened a provider
 * package's read-only statement session (`getOrCreateReadOnlyStatementSession` in src/lib/db/factory.ts); a census
 * holds the callers to those profiles and that opener.
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
 *
 * On a provider package's read-only statement session (`readOnlySessionPage`), which the provider factory opened through
 * the package under the read-only statement policy (clauses C-78 and C-109), the call is the same one host core
 * execute, with the session's declared environment, counted on its cache entry while it runs and until a stopped call
 * settles (`markedCall`). A call of every row asks for one row past the row budget from the first row, which makes an
 * answer past the budget a refusal, never a cut, except an estimating plan, which asks every row and is held to the
 * host's 32 MiB page alone, so a plan longer than the row budget is answered whole as the provider arm answers it; a
 * paged call sends the caller's page; the host core refuses a non-zero offset the package does not honour before the call, which the
 * accessor answers as `StudioOffsetRefusal`, not-sent (clause C-111). The request carries the budget's rows and bytes and the caller's mode in `readOnly` and no billed-read
 * allowance, which stays with the host (clause C-78). The page is read into a result (`readOnlyPageResult` in
 * ./session-target), a page the host cut at its 32 MiB refused as `StudioByteBudgetRefusal` with none of its rows, held
 * again to the budget as the provider arm's, and its warnings answered by the engine record's words grant: as Studio's
 * one sentence naming their count, each logged once through core's scrub (`packageWarnings` in ./package-errors), where
 * the grant is code-only, and through the scrub where it is scrubbed. A failure the package raised, or a refusal of what
 * it answered, is a statement failure, a `QueryError` as a legacy provider's statement failure is, in the words its
 * record grants (`packageStatementFailure` in ./package-errors, clause C-112), logged once and handed to the caller's
 * `packageAnswered`; Studio's own failures pass as raised. A row budget past the largest whose one-row-past page is a safe integer, `Number.MAX_SAFE_INTEGER - 1`, is
 * refused as a not-sent `QueryError` before anything is sent, on every mode and page, since the arm asks for one row
 * past the budget and the host's pump takes no page limit past the largest safe integer.
 */

/** One read-only statement for the host core, with the budget its answer is held to. */
export interface ReadOnlyExecuteCall {
  /**
   * The connection's type, an engine id, named in a refusal. It decides the review-record gate, so it must be the type
   * of the connection the provider was acquired for, or the engine of the provider package's session.
   */
  readonly type: string;
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
  /**
   * Handed each failure a provider package's record answered as the package's (`packageStatementFailure`), the value
   * then thrown, so a caller tells it by identity from Studio's own failures, which pass as raised.
   */
  readonly packageAnswered?: (answer: unknown) => void;
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
 * Runs `call.statement` on `target`'s read-only statement session through the host core and holds the answer to
 * `call.budget`, with every row as its page.
 *
 * @throws {StudioProfileRefusal} For an engine off the review record, or a provider without `queryReadOnly`.
 * @throws {QueryError} For a budget that is not whole positive numbers.
 * @throws {HostCoreBootOrderError} Before the host core is installed.
 * @throws {StudioTimeBudgetRefusal} For a statement its deadline stopped or refused.
 * @throws {QueryCancelledError} For a statement whose caller left.
 * @throws {StudioRowBudgetRefusal} Past the row budget, except for an estimating plan.
 * @throws {StudioByteBudgetRefusal} Past the byte budget, or for a row larger than one page.
 * @throws The provider's error, by reference, or a provider package's failure as its record answers it.
 */
export async function runReadOnlyExecute(
  target: ReadOnlyStatementTarget,
  call: ReadOnlyExecuteCall,
): Promise<QueryResult> {
  return (await runReadOnlyPage(target, { ...call, page: { unlimited: true } })).result;
}

/** The budget view of `call`: its caller, and the time refusal its statement timeout builds, naming `type`. */
function budgetViewOf(call: ReadOnlyExecuteCall, type: DatabaseType | undefined): BudgetView {
  return {
    caller: call.caller,
    timeRefusal: () =>
      new StudioTimeBudgetRefusal(
        `${TIME_BUDGET_PREFIX}: no answer within ${call.budget.statementTimeoutMs}ms`,
        type,
        call.statement,
      ),
  };
}

/**
 * Runs `call.statement` on `target`'s read-only statement session through the host core with `call.page` as its page,
 * holds the answer to `call.budget`, and answers whether the session applied the page (clause C-85).
 *
 * @throws {StudioProfileRefusal} For an engine off the review record, or a provider without `queryReadOnly`.
 * @throws {QueryError} For a budget that is not whole positive numbers.
 * @throws {HostCoreBootOrderError} Before the host core is installed.
 * @throws {Error} A host defect, for a legacy provider's target whose call names a provider package's engine.
 * @throws {StudioOffsetRefusal} For a non-zero offset the provider's prepare or the package did not apply, before
 *   anything is sent.
 * @throws {StudioTimeBudgetRefusal} For a statement its deadline stopped or refused.
 * @throws {QueryCancelledError} For a statement whose caller left.
 * @throws {StudioRowBudgetRefusal} Past the row budget, except for an estimating plan.
 * @throws {StudioByteBudgetRefusal} Past the byte budget, or for a row larger than one page.
 * @throws The provider's error, its prepare's included, by reference, or a provider package's failure as its record
 *   answers it.
 */
export async function runReadOnlyPage(
  target: ReadOnlyStatementTarget,
  call: ReadOnlyPageCall,
): Promise<ReadOnlyPageAnswer> {
  const { type, statement, budget, mode } = call;
  assertStatementsReviewed(type);
  // The type a refusal names: the published type of a legacy engine, none for a provider package's.
  const named = legacyProviderType(servedEngineRecord(type));
  assertReadOnlyBudget(budget, named);
  const core = hostCore();
  if (target.form === "session") return readOnlySessionPage(core, target, call);
  if (named === undefined) {
    throw new Error(
      `A read-only execute named the engine "${type}", which a provider package serves, on a legacy provider: a host defect.`,
    );
  }
  const bridged = bridgedReadOnlyStatements(target.provider, {
    type: named,
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
  const view = budgetViewOf(call, named);
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
      type: named,
      statement,
      maxRows: mode === "estimate-plan" ? null : budget.maxResultRows,
      maxBytes: budget.maxResultBytes,
    });
    return { result, pageApplied: record.pageApplied };
  } finally {
    record.release();
  }
}

/** The largest row budget whose one-row-past page, the session arm's every-row page, is a safe integer. */
const LARGEST_SESSION_ROW_BUDGET = Number.MAX_SAFE_INTEGER - 1;

/**
 * The session arm of `runReadOnlyPage`: `call` on `target`, a provider package's read-only statement session, through
 * `core`'s one execute call; see the module's last paragraph.
 *
 * @throws {Error} A host defect, for a call that names another engine than the session's.
 * @throws {QueryError} Not-sent, for a row budget whose one-row-past page is no safe integer.
 * @throws As `runReadOnlyPage` throws, a package's failure as a statement failure (`packageStatementFailure`).
 */
async function readOnlySessionPage(
  core: HostCore,
  target: Extract<ReadOnlyStatementTarget, { form: "session" }>,
  call: ReadOnlyPageCall,
): Promise<ReadOnlyPageAnswer> {
  const { type, statement, budget, mode } = call;
  const { engine, session, scrub } = target;
  if (type !== engine.id) {
    throw new Error(
      `A read-only execute named the engine "${type}" on the read-only statement session of "${engine.id}": a host defect.`,
    );
  }
  if (budget.maxResultRows > LARGEST_SESSION_ROW_BUDGET) {
    const refused = new QueryError(
      `Read-only execution budget field maxResultRows must be a positive integer <= ${LARGEST_SESSION_ROW_BUDGET} on a provider package's read-only statement session, which Studio asks for one row past it`,
    );
    markNotSent(refused);
    throw refused;
  }
  // Every row of an executing statement is one row past the row budget from the first row, so an answer past the
  // budget is refused, never cut; every row of an estimating plan is every row, held to the page's bytes alone.
  const page: PageBound =
    "unlimited" in call.page && mode !== "estimate-plan" ? { limit: budget.maxResultRows + 1, offset: 0 } : call.page;
  const deadline = Date.now() + budget.statementTimeoutMs;
  const request: ExecuteRequest = {
    statement,
    page,
    readOnly: {
      budget: { maxRows: budget.maxResultRows, maxBytes: budget.maxResultBytes },
      ...(mode === undefined ? {} : { mode }),
    },
  };
  // The first result's columns, kept from the answer the pump reads, since a page record carries none.
  let columns: readonly Column[] = [];
  const pumpLimits = (answer: ExecuteAnswer): PumpLimits => {
    columns = answer.results[0]?.columns ?? [];
    const maxRows = "unlimited" in page ? Number.MAX_SAFE_INTEGER : page.limit;
    return { maxRows, maxBytes: PAGE_MAX_BYTES, batchMaxBytes: BATCH_MAX_BYTES };
  };
  const packageAnswer = (error: unknown) => {
    const answer = packageStatementFailure(engine, error, scrub, call.route);
    if (isPackageFailure(engine, error)) call.packageAnswered?.(answer);
    return answer;
  };
  const view = budgetViewOf(call, undefined);
  let record: Awaited<ReturnType<HostCore["executeCall"]>>;
  try {
    record = await markedCall(target, () =>
      core.executeCall(
        session,
        request,
        contextOn(deadline, deadlineSignal(deadline, call.caller), target.env),
        pumpLimits,
        hostPorts(call.route),
      ),
    );
  } catch (error) {
    throw packageAnswer(error);
  }
  if (record.kind === "stopped") {
    call.holdUntilSettled?.(record.settled);
    throw budgetStopError(record.reason, view);
  }
  if (record.kind === "refused") throw packageAnswer(budgetRefusalError(record, view));
  try {
    const result = readOnlyPageResult(record, columns);
    holdReadOnlyRows(result.rows, {
      type: undefined,
      statement,
      maxRows: mode === "estimate-plan" ? null : budget.maxResultRows,
      maxBytes: budget.maxResultBytes,
    });
    const warnings =
      engine.grants.ownWords === "scrubbed"
        ? scrubProviderWarnings(scrub, record.warnings)
        : packageWarnings("execute", record.warnings, scrub, call.route);
    return { result: warnings.length === 0 ? result : { ...result, warnings }, pageApplied: record.pageApplied };
  } finally {
    record.release();
  }
}
