import type { ExecuteRequest } from "@libredb/provider-sdk/calls";
import { composedStatementOn } from "@/lib/api/composed-statement";
import { callContext, executeDeadline, executeViews, hostPorts, pageBound } from "@/lib/api/editor-query";
import type { DatabaseProvider } from "@/lib/db/types";
import { refusalError, stopError } from "@/lib/provider-host/access";
import type { RefusedRecord, StoppedRecord } from "@/lib/provider-host/core/console";
import { hostCore } from "@/lib/provider-host/instance";
import { bridgedConsole } from "@/lib/provider-host/legacy-bridge";
import type { QueryResult } from "@/lib/types";

/*
 * THE DATA PROFILE'S READS ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clause C-86).
 *
 * `openProfileReads` is the caller facade of `POST /api/db/profile` (src/app/api/db/profile/route.ts): every read the
 * route sends is one host core execute (clause C-48), so the route calls no provider statement member. A read the route
 * composes, the row count, a column's measures and its null count, MongoDB's sample aggregate and its count, runs on
 * the legacy bridge's composed statement session (clause C-50) through its one opener, `composedStatementOn`
 * (src/lib/api/composed-statement.ts), so it reaches the provider exactly as written, with every row as its page: the
 * console session's prepare would append a page bound to every aggregate. The SQL sample runs on the bridge's console
 * session (`bridgedConsole`) asking a page of the given rows and nothing else, so the provider writes its own bound,
 * one row past the page (`probePastPage`), and at most the page's rows are answered.
 *
 * The process's host core is read and the views built when the reads are opened, synchronously, so a profile run before
 * the install throws `HostCoreBootOrderError` before any read and outside every measure's refusal (clause C-52). Each
 * read builds its request and its context fresh when it starts: its own deadline, the statement timeout plus the host's
 * slack from that read's start read off `now` (`executeDeadline`), a signal that aborts at it or when the request
 * leaves, and the empty environment. The host pumps the first result within its 32 MiB page (clause C-53): a row larger
 * than one page is refused `StudioByteBudgetRefusal` with the page's sentence, and an answer over 1 MiB waits for the
 * core's large-page slot within the read's deadline. A page is answered by reference and its record released in a
 * `finally` (clause C-51).
 *
 * A read that answers no page answers the accessor's class (src/lib/provider-host/access.ts): `QueryCancelledError`
 * when the request left, `StudioTimeoutRefusal` with the editor statement's sentence when its deadline ended it, each
 * not-sent when refused at its start, outcome unknown otherwise. No read sends a run id, so no cancel is sent, and a
 * read's failure after the stop is logged under the route by kind and code, never its text (`hostPorts`). A provider's
 * error passes as the same object.
 */

/** The reads of one profile, each one host core execute under a deadline of its own and the request's signal. */
export interface ProfileReads {
  /** Runs `statement` exactly as written and answers the provider's result by reference. */
  composed(statement: string): Promise<QueryResult>;
  /** Runs `statement` asking a page of `rows` and answers at most that many of the provider's rows, by reference. */
  sample(statement: string, rows: number): Promise<readonly Record<string, unknown>[]>;
}

/**
 * Opens the reads of one profile on `provider` for the request whose signal is `caller`, its late failures logged under
 * `route`. `now` is the clock each read's deadline is read from when the read starts.
 *
 * @throws {HostCoreBootOrderError} Synchronously, before the host core is installed, before any read.
 */
export function openProfileReads(
  provider: DatabaseProvider,
  caller: AbortSignal,
  route: string,
  now: () => number = Date.now,
): ProfileReads {
  const core = hostCore();
  const views = executeViews(provider, caller);
  const end = (record: RefusedRecord | StoppedRecord): Error =>
    record.kind === "refused" ? refusalError(record, views.view) : stopError(record.reason, views.stopView(record));
  const context = () => callContext(executeDeadline(provider, now()), caller);
  return {
    composed: (statement) => composedStatementOn(core, provider, { statement, context: context(), route, end }),
    sample: async (statement, rows) => {
      const bridged = bridgedConsole(provider, { limit: rows });
      const request: ExecuteRequest = { statement, page: pageBound({ limit: rows }) };
      const record = await core.executeCall(bridged.session, request, context(), bridged.pumpLimits, hostPorts(route));
      if (record.kind !== "page") throw end(record);
      try {
        return bridged.answered().result.rows.slice(0, Math.min(rows, record.page.rows.length));
      } finally {
        record.release();
      }
    },
  };
}
