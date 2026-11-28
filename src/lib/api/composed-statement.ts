import { type CallContext, deadlineSignal, type ExecuteRequest } from "@libredb/provider-sdk/calls";
import { contextOn, hostPorts } from "@/lib/api/editor-query";
import { type BudgetGrant, budgetGrantEnd } from "@/lib/api/provider-monitoring";
import { providerComposedRead } from "@/lib/api/session-target";
import type { DatabaseProvider } from "@/lib/db/types";
import type { RefusedRecord, StoppedRecord } from "@/lib/provider-host/core/console";
import type { HostCore } from "@/lib/provider-host/core/host-core";
import { hostCore } from "@/lib/provider-host/instance";
import type { QueryResult } from "@/lib/types";

/*
 * A STATEMENT STUDIO COMPOSED, ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clause C-80).
 *
 * `runComposedStatement` is the caller facade of a statement Studio composed and its statement guard admitted, which
 * must reach the provider exactly as composed: plan mode's statistics read under the operations profile
 * (`readStatisticsForGrounding` in src/lib/agent/tools.ts), SQL Server's estimates and libSQL's availability probe and
 * estimates. The operations profile opens no read-only statement path, and the console session's prepare would append
 * a page bound to the statement on both dialects, so it runs on the legacy bridge's composed statement session
 * (`bridgedComposedStatements`, clause C-50), whose execute sends the provider's plain `query` the statement alone,
 * built as the provider's composed read (`providerComposedRead` in src/lib/api/session-target.ts).
 * `composedStatementOn` is the one opener of that session, read by this facade and by the data profile's reads
 * (`openProfileReads`, src/lib/api/profile-reads.ts, clause C-86), each of which builds its own context and reads its
 * own end of a call that answered no page.
 *
 * The process's host core is read and the session built when this is called, synchronously, so a call made before the
 * install throws `HostCoreBootOrderError` before any promise and is never taken for a provider's failure. The call is
 * one host core execute: a fresh request of the statement and every row as its page, and a fresh context of the grant's
 * deadline, a signal that aborts at it alone, and the empty environment. The host pumps the first result within its
 * 32 MiB page (clause C-53), so a row larger than one page is refused as `StudioByteBudgetRefusal` with the page's
 * sentence, outcome unknown, and an answer over 1 MiB waits for the core's large-page slot within the deadline.
 *
 * The answer is the provider's result by reference, the page record released in a `finally`; the caller holds its rows
 * to the run's budget. A stop at whatever wait of the run, and a start refused at the deadline, is the grant's own time
 * refusal (`budgetGrantEnd`), a stopped call's settlement handed to the grant's hold first, so the run counts the call
 * until it settles; the session offers no cancel, so a stopped statement runs on, and its later failure is logged
 * under the grant's route by kind and code, never its text (`hostPorts`). A provider's error passes as the same object.
 */

/** One composed statement for the host core, and the grant it runs under. */
export interface ComposedStatementCall extends BudgetGrant {
  /** The statement exactly as Studio composed it and its statement guard admitted it. */
  readonly statement: string;
}

/**
 * Runs `call.statement` on `provider`'s plain query path through the host core, exactly as composed, within
 * `call`'s grant.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed, before any call.
 * @returns A promise of the provider's result by reference; it rejects with the grant's time refusal when the deadline
 * ended the call, with `StudioByteBudgetRefusal` for a row larger than one page, and with the provider's error as the
 * same object.
 */
export function runComposedStatement(provider: DatabaseProvider, call: ComposedStatementCall): Promise<QueryResult> {
  return composedStatementOn(hostCore(), provider, {
    statement: call.statement,
    context: contextOn(call.deadline, deadlineSignal(call.deadline)),
    route: call.route,
    end: (record) => budgetGrantEnd(record, call),
  });
}

/** One composed statement on a host core: its context, the route its late failures are logged under, and its end. */
export interface ComposedStatementOn {
  /** The statement exactly as Studio composed it. */
  readonly statement: string;
  /** The call's context, built by its facade. */
  readonly context: CallContext;
  /** The route a failure after the stop is logged under, by kind and code. */
  readonly route: string;
  /** The error a call that answered no page throws, in its facade's own reading. */
  readonly end: (record: RefusedRecord | StoppedRecord) => Error;
}

/**
 * Runs `call.statement` on `provider`'s plain query path through `core`, exactly as composed: the one opener of the
 * composed statement session (`providerComposedRead`), read by both its facades, `runComposedStatement` and the
 * data profile's reads (`openProfileReads`, src/lib/api/profile-reads.ts; clause C-86). The session is built when
 * this is called, synchronously; the call is one host core execute of a fresh request of the statement and every row
 * as its page, on `call.context`.
 *
 * @returns A promise of the provider's result by reference, the page record released in a `finally`; it rejects with
 * `call.end(record)` for a call that answered no page, and with the provider's error as the same object.
 */
export function composedStatementOn(
  core: HostCore,
  provider: DatabaseProvider,
  call: ComposedStatementOn,
): Promise<QueryResult> {
  const form = providerComposedRead(provider);
  const request: ExecuteRequest = { statement: call.statement, page: { unlimited: true } };
  return core
    .executeCall(form.session, request, call.context, form.pumpLimits, hostPorts(call.route))
    .then((record) => {
      if (record.kind !== "page") throw call.end(record);
      try {
        return form.answered();
      } finally {
        record.release();
      }
    });
}
