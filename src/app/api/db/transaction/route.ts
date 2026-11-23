import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { pageOptionError } from "@/lib/api/page-probe";
import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { editorCacheKey } from "@/lib/db/factory";
import {
  type DatabaseProvider,
  isTransactionProvider,
  type QueryPrepareOptions,
  type TransactionProvider,
} from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { createErrorResponse } from "@/lib/api/errors";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { cachedEditorProvider, editorProvider } from "@/lib/api/editor-provider";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { readBoundParams } from "@/lib/api/bound-params";
import { rowsWithNonFiniteWords } from "@/lib/non-finite";
import { countCodeStatements, splitExecutionUnits, type ExecutionUnit } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { noteAppendedBound } from "@/lib/db/utils/query-limiter";
import { isDatabaseError, NO_ACTIVE_TRANSACTION, NO_TRANSACTION_OPENED, QueryError } from "@/lib/db/errors";
import { errorOutcome } from "@/lib/db/error-record";
import { openWithinCall } from "@/lib/api/editor-query";
import {
  beginInTransaction,
  type CredentialRollback,
  endTransaction,
  type FailedCall,
  inTransactionAnswer,
  type NotSentCall,
  readTransactionState,
  readTransactionStateOrUnknown,
  rollBackAfterCredentialChange,
  runInTransaction,
  type TransactionCaller,
  type UnansweredCall,
} from "@/lib/api/editor-transaction";
import { logger } from "@/lib/logger";
import {
  type ProviderTextScrub,
  providerTextScrub,
  withheldProviderError,
  withholdProviderError,
} from "@/lib/db/operations/provider-text";
import type { UserPayload } from "@/lib/auth";
import { clientAddress } from "@/lib/api/client-address";
import type { GovernedConnection } from "@/lib/governance/visible";
import { admitQueryExecution } from "@/lib/query-events/admission";
import { gateRun } from "@/lib/api/run-confirmation";
import { runConfirmationIssuerForSession } from "@/lib/api/run-confirmation-token";
import { queryEventStart } from "@/lib/query-events/build";
import {
  claimTransaction,
  endAsSeen,
  endTransactionEvent,
  OWNERSHIP_IDLE_MS,
  recordTransactionStatement,
  releaseIfProviderChanged,
  resolveTransaction,
  settleTransaction,
  type TransactionEnd,
  type TransactionEventDetail,
  type TransactionEventScope,
  type TransactionOwner,
  transactionKey,
  transactionOwner,
  watchTransactionTimeout,
} from "@/lib/api/transaction-ownership";

/** The label every log line of this route is written under. */
const ROUTE = "api/db/transaction";

/**
 * Run a script's statements in order on the transaction's connection, stopping at the first one
 * that fails (#1390).
 *
 * The editor sends a selection to this route whole whenever BEGIN or SANDBOX is on, and a driver
 * that runs one statement per call answers a syntax error at the second: measured on MySQL 26.7.0,
 * two UPDATE lines failed "near 'UPDATE ...' at line 2". The answer has the shape
 * `/api/db/multi-query` gives a script, which the editor already reports (the executed count, the
 * statement that failed, the last successful statement's result), plus `inTransaction`.
 *
 * A failure is part of the answer, not a thrown error: the statements before it ran inside the
 * transaction and their work is still there to commit or roll back. Only the last statement is
 * bounded, as on the script route, and only when it is a single statement and not a batch. A
 * statement that ends the transaction ends the run as well, because the next one is refused by the
 * provider ("No active transaction") rather than autocommitted. A statement's error answers the message of what
 * core's scrub answers for it, so one whose text holds a credential of the connection answers the withheld sentence.
 */
async function runScriptInTransaction(
  provider: TransactionProvider & Pick<DatabaseProvider, "prepareQuery">,
  units: ExecutionUnit[],
  options: Record<string, unknown>,
  scrub: ProviderTextScrub,
) {
  const statements: {
    index: number;
    sql: string;
    startLine: number;
    status: "success" | "error";
    rows?: Record<string, unknown>[];
    fields?: string[];
    rowCount?: number;
    executionTime: number;
    error?: string;
  }[] = [];
  let totalExecutionTime = 0;
  for (const [index, unit] of units.entries()) {
    const isLast = index === units.length - 1;
    const sql = isLast && unit.statements.length === 1 ? provider.prepareQuery(unit.sql, options).query : unit.sql;
    const startTime = performance.now();
    const identity = { index, sql: unit.sql, startLine: unit.startLine };
    try {
      const result = await provider.queryInTransaction(sql);
      const executionTime = Math.round(performance.now() - startTime);
      totalExecutionTime += executionTime;
      statements.push({
        ...identity,
        status: "success",
        rows: rowsWithNonFiniteWords(result.rows),
        fields: result.fields,
        rowCount: result.rowCount,
        executionTime,
      });
    } catch (error) {
      noteAppendedBound(error, unit.sql, sql);
      const executionTime = Math.round(performance.now() - startTime);
      totalExecutionTime += executionTime;
      const answered = withholdProviderError(scrub, error);
      statements.push({
        ...identity,
        status: "error",
        executionTime,
        error: answered instanceof Error ? answered.message : "Unknown error",
      });
      break;
    }
  }
  // The last successful statement is the script's own outcome (#2271): a write or an empty
  // SELECT is shown as itself, not by the last result that happened to carry rows.
  const shown = [...statements].reverse().find((r) => r.status === "success");
  return {
    rows: shown?.rows ?? [],
    fields: shown?.fields ?? [],
    rowCount: shown?.rowCount ?? 0,
    executionTime: totalExecutionTime,
    multiStatement: true,
    statementCount: units.length,
    executedCount: statements.length,
    hasError: statements.some((r) => r.status === "error"),
    statements,
  };
}

// One string literal each, never a concatenation across lines: bun's line coverage under-counts the continuation lines
// of a message built that way.
const CREDENTIAL_CHANGED_ROLLED_BACK =
  "Your access to this connection changed while your transaction was open, so the transaction was rolled back and none of its changes were saved. Begin a new transaction to continue with your current access.";
const CREDENTIAL_CHANGED_UNCONFIRMED =
  "Your access to this connection changed while your transaction was open, so the transaction cannot continue. Studio asked the database to roll it back and could not confirm that it did; none of its changes were committed. Begin a new transaction to continue with your current access.";

/**
 * Roll back the transaction a governed owner opened on the provider cached under `providerKey`, the key its `begin`
 * resolved, once a request of theirs resolves another key (docs/GOVERNANCE.md#per-user-providers), and answer how it
 * ended. `providerScrub` is core's scrub of that provider's credential, the one `begin` resolved.
 *
 * A provider that is no longer cached was disconnected when it was removed, which ended its transaction, so it holds
 * none. Otherwise the state is read and the rollback sent through the provider host within Studio's own allowance,
 * `CREDENTIAL_CHANGE_ROLLBACK_MS` (`rollBackAfterCredentialChange`): a transaction its provider already ended
 * (PostgresProvider and MySQLProvider roll back after their own TX_TIMEOUT_MS) is not sent a second rollback, which the
 * provider would refuse with "No active transaction". A rollback that fails, or that the host stopped waiting for at
 * the allowance, is logged and answered as unconfirmed rather than waited for: the transaction runs on a credential its
 * owner no longer resolves, so their requests no longer reach it, and what is left of it ends with its provider.
 */
async function rollBackOnProvider(
  providerKey: string,
  providerScrub: ProviderTextScrub,
  catalog: string | undefined,
  connection: DatabaseConnection,
): Promise<CredentialRollback["kind"]> {
  let failure: unknown;
  try {
    const session = await cachedEditorProvider(providerKey, catalog);
    if (session === null || !isTransactionProvider(session)) return "none-open";
    const answer = await rollBackAfterCredentialChange(session, ROUTE);
    if (answer.kind !== "unconfirmed") return answer.kind;
    failure = answer.error;
  } catch (error) {
    failure = error;
  }
  // The provider runs on the credential its begin resolved, which this request no longer carries, so its error is
  // logged through core's scrub of that credential, kept in the transaction's record.
  const logged = withholdProviderError(providerScrub, failure);
  logger.error("A transaction whose credential changed was released without a confirmed rollback", logged, {
    route: ROUTE,
    connectionId: connection.id,
  });
  return "unconfirmed";
}

/** The actions that send a statement to the database: BEGIN, the caller's own, COMMIT and ROLLBACK. */
const STATEMENT_ACTIONS: ReadonlySet<unknown> = new Set(["begin", "query", "commit", "rollback"]);

/** Of those, the ones that run inside the caller's transaction. */
const IN_TRANSACTION_ACTIONS: ReadonlySet<unknown> = new Set(["query", "commit", "rollback"]);

/**
 * Under governance, what every query event of a transaction the caller opens says about who and where
 * (docs/GOVERNANCE.md#query-events): the session's subject, username and role, and the connection with the grant level
 * its credential carries.
 */
function transactionEventScope(
  session: UserPayload,
  subject: string,
  connection: DatabaseConnection,
  req: NextRequest,
): TransactionEventScope {
  return {
    principal: { subject, username: session.username, role: session.role },
    connection: {
      id: connection.id,
      name: connection.name,
      engine: connection.type,
      accessLevel: (connection as Partial<GovernedConnection>).grantLevel ?? null,
    },
    clientIp: clientAddress(req),
  };
}

/** A count a query event can hold: a whole number from 0, and none for a driver that reports -1 or nothing. */
function eventRowCount(count: number | undefined): number | undefined {
  return count !== undefined && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/**
 * What a query event says of a failure (docs/GOVERNANCE.md#query-events): the SQLSTATE the driver reported, else the
 * API code the error carries, and its text. When the text holds a credential of the connection (core's scrub) the
 * event records the withheld sentence and the API code, never the SQLSTATE, which is one of the texts the scrub reads.
 */
function eventError(scrub: ProviderTextScrub, error: unknown): { errorCode?: string; errorMessage?: string } {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  const apiCode = typeof code === "string" ? code : undefined;
  const withheld = withheldProviderError(scrub, error);
  if (withheld !== null) return { errorCode: apiCode, errorMessage: withheld.message };
  const sqlstate = isDatabaseError(error) ? error.sqlstate : undefined;
  return { errorCode: sqlstate ?? apiCode, errorMessage: error instanceof Error ? error.message : String(error) };
}

/**
 * Records a statement, COMMIT or ROLLBACK of the owner's that did not answer, and settles the record by the session
 * state it left (src/lib/api/transaction-ownership.ts; docs/providers/CONTRACT.md, clause C-58). One the host refused
 * before the call left everything as it was: an `open` event, the record untouched. One the host stopped waiting for
 * left an unknown state: an `open` event, the record kept and marked unresolved. One the provider failed is settled by
 * the state read at once after it: still in a transaction, or unknown, an `open` event and the record kept; no
 * transaction left, the record released and the terminal event `closedEnd`, or `unknown` on an unresolved record.
 */
function settleFailure(
  owned: string,
  owner: TransactionOwner | null,
  failure: FailedCall | UnansweredCall | NotSentCall,
  detail: TransactionEventDetail,
  closedEnd: TransactionEnd,
): void {
  if (failure.kind === "not-sent") {
    if (owner !== null) recordTransactionStatement(owner, detail);
    return;
  }
  const state = failure.kind === "failed" ? failure.sessionState : "unknown";
  settleTransaction(owned, state);
  if (owner === null) return;
  if (state === "not-in-transaction") endTransactionEvent(owner, endAsSeen(owner, closedEnd), detail);
  else recordTransactionStatement(owner, detail);
}

/**
 * How a failed COMMIT that left no transaction ended (Q3): rolled back only when the COMMIT cannot have reached the
 * server (`not-sent`, E-5), and otherwise unknown, since the server may have committed it before the failure.
 */
function failedCommitEnd(error: unknown): TransactionEnd {
  return errorOutcome(error) === "not-sent" ? "rolled-back" : "unknown";
}

export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/db/transaction", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // Core's scrub of the providers the resolved connection builds, held out here for the `catch` below: before the
  // connection resolves no provider ran.
  let scrub: ProviderTextScrub | undefined;
  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }
    // `options` is handed on as the page options it names, as it was when the body was read untyped.
    const {
      action,
      sql,
      options = {},
    } = body as {
      options?: QueryPrepareOptions & Record<string, unknown>;
    } & Record<string, unknown>;

    const connection = await resolveConnection(body, guard.session);
    const connectionScrub = providerTextScrub(connection, "any");
    scrub = connectionScrub;

    if (!action) {
      return NextResponse.json({ error: "Connection and action are required" }, { status: 400 });
    }
    // A query action's text is read before its provider resolves. A `sql` that is present but not a string, a falsy
    // one (0, false) included, is refused in words: a truthy one answered 500 with a TypeError of its own, thrown by
    // the splitter without `params` and by the provider's prepareQuery with them, so it never reached
    // queryInTransaction. For a number the two read "input.slice is not a function" and "sql.slice is not a function".
    // A missing (null) or empty one keeps its answer below.
    if (action === "query" && sql != null && typeof sql !== "string") {
      return NextResponse.json({ error: "sql must be a string" }, { status: 400 });
    }

    // Each database of a server-level connection holds its own transaction (#1530), so ownership is per database.
    const catalog = requestCatalog(body);

    // A query action's own fields, then the server's confirmation gate (docs/API_DOCS.md, "Server confirmation of a
    // run"), both before any provider is built or the admission gate is asked, so a request either refuses opens
    // nothing and runs nothing. BEGIN, COMMIT and ROLLBACK are Studio's own statements and are not classified.
    let query:
      | { readonly sql: string; readonly params: unknown[] | undefined; readonly unconfirmed: boolean }
      | undefined;
    if (action === "query") {
      if (!sql || typeof sql !== "string") {
        return NextResponse.json({ error: "SQL query is required for transaction query" }, { status: 400 });
      }
      // The values of a generated statement are bound here as well: a row edit
      // applied while a transaction is open takes this endpoint, and it would
      // otherwise be the one path that still carried them as text (#290).
      const bound = readBoundParams(body.params);
      if (!bound.valid) {
        return NextResponse.json({ error: bound.message }, { status: 400 });
      }
      const optionError = pageOptionError(options);
      if (optionError !== null) {
        return NextResponse.json({ error: optionError }, { status: 400 });
      }
      const gate = await gateRun({
        route: "transaction",
        issuer: runConfirmationIssuerForSession(guard.session),
        connection,
        catalog,
        sql,
        params: bound.params,
        confirmation: body.confirmation,
        explain: false,
      });
      if (gate.kind === "answer") return NextResponse.json(gate.body, { status: gate.status });
      query = { sql, params: bound.params, unconfirmed: gate.unconfirmed };
    }
    // Under governance each user's transaction is held on that user's own provider
    // (docs/GOVERNANCE.md#per-user-providers), so ownership is per user as well: the key and the record carry the owner
    // the editor context names, the session's identity provider subject. Without governance there is none, and the key
    // is the one every user of the connection shares.
    const execution = editorExecutionContext(guard.session, connection);
    const subject = execution.owner;
    const owned = transactionKey(connection.id, catalog, subject);
    // Under governance the provider's cache key also frames the credential of the caller's grant level, and the record
    // keeps the key its begin resolved (src/lib/api/transaction-ownership.ts). A transaction the caller's key no longer
    // names is rolled back where it runs and answered here, for every action, before a provider of the new credential
    // is opened at all. Without governance no key is computed, and every request goes on as before.
    const providerKey = subject === undefined ? undefined : await editorCacheKey(connection, execution);
    const released = providerKey === undefined ? null : releaseIfProviderChanged(owned, providerKey);
    if (released !== null) {
      const started = queryEventStart();
      const rollback = await rollBackOnProvider(released.providerKey, released.providerScrub, catalog, connection);
      const rolledBack = rollback !== "unconfirmed";
      // Studio's own rollback ends the transaction: its terminal event, unless the reload that took the grant away
      // already recorded it (src/lib/governance/grant-diff.ts). On a record whose state was unknown only a rollback
      // that answered says how it ended; a session that held none may have committed, so that end is unknown.
      endTransactionEvent(released, rollback === "rolled-back" ? "rolled-back" : endAsSeen(released, "rolled-back"), {
        statement: "ROLLBACK",
        status: rolledBack ? "success" : "error",
        started,
      });
      return NextResponse.json(
        {
          error: rolledBack ? CREDENTIAL_CHANGED_ROLLED_BACK : CREDENTIAL_CHANGED_UNCONFIRMED,
          code: ApiErrorCode.TRANSACTION_CREDENTIAL_CHANGED,
          rolledBack,
        },
        { status: 409 },
      );
    }
    // The open is waited for within its engine's connect budget and while the request stays (`openWithinCall`), as on
    // POST /api/db/query: a wait that ends answers 504 or 499, not-sent, and the open goes on for the next request.
    const resolved = connection;
    const provider = await openWithinCall(req.signal, resolved.type, (wait) =>
      editorProvider(guard.session, resolved, catalog, wait),
    );

    if (!isTransactionProvider(provider)) {
      return NextResponse.json(
        { error: "Transaction control is not supported for this database type" },
        { status: 400 },
      );
    }

    // The provider holds ONE transaction, and without governance every Studio user who reaches it
    // drives it, so the caller's right to act on it is decided here, before any action runs. See
    // src/lib/api/transaction-ownership.ts for what was measured. Every call on the session below, this state read
    // included, runs through the provider host under a deadline the host owns and the request's signal
    // (src/lib/api/editor-transaction.ts; docs/providers/CONTRACT.md, clause C-59).
    const caller: TransactionCaller = { signal: req.signal, route: ROUTE };
    const sessionState = await readTransactionState(provider, caller);
    let owner = transactionOwner(owned);
    if (owner !== null) {
      // A session that holds no transaction ended it without a call of Studio's - PostgresProvider and MySQLProvider
      // auto-roll back after TX_TIMEOUT_MS - so the record names a transaction that no longer exists. Dropping it here
      // is what stops that record from refusing the next user; under governance its end is recorded once, whichever
      // path sees it first. A state the host could not tell keeps the record: an unknown state is never read as
      // closed (docs/providers/CONTRACT.md, clause C-58).
      resolveTransaction(owned, owner, sessionState);
      if (sessionState === "not-in-transaction") owner = null;
    }
    // Under governance the owner is the subject, and the username a display label that can change
    // (docs/GOVERNANCE.md#row-semantics).
    const ownedByYou =
      owner !== null && (subject === undefined ? owner.username === guard.session.username : owner.subject === subject);
    const heldByAnother = owner !== null && !ownedByYou;

    if (owner !== null && !ownedByYou && action !== "status") {
      // 409, not 403: the caller's credentials are fine, the connection is busy. The body carries
      // the whole answer because src/hooks/use-transaction-control.ts renders `error` verbatim in
      // a toast and nothing else reaches the user - a refusal with no deadline in it would be the
      // five-minute lockout this fix exists to avoid.
      const availableAt = new Date(owner.lastActiveAt + OWNERSHIP_IDLE_MS).toISOString();
      return NextResponse.json(
        {
          error: `This connection has an open transaction that belongs to another session, started at ${new Date(owner.startedAt).toISOString()}. Only the session that opened it can query it, commit it or roll it back. It is released for other sessions at ${availableAt} if its owner does not act on it before then.`,
          code: ApiErrorCode.TRANSACTION_NOT_OWNED,
          startedAt: new Date(owner.startedAt).toISOString(),
          availableAt,
        },
        { status: 409 },
      );
    }

    // Every action that sends a statement, a script of several included, passes the admission gate first, so
    // while the query event sink cannot record a statement's event the statement is refused rather than run
    // (docs/GOVERNANCE.md#query-events).
    if (STATEMENT_ACTIONS.has(action)) admitQueryExecution();
    // Under governance every statement this route sends belongs to a transaction the caller owns, whose record carries
    // the scope of its query events (docs/GOVERNANCE.md#query-events). Without that record a statement would reach the
    // database with no event behind it: right after the provider's own timeout (the reconcile above), or on a
    // transaction whose record is gone. Every provider that implements the transaction interface refuses a statement
    // outside a transaction with NO_ACTIVE_TRANSACTION anyway, so this is refused with that same sentence, before the
    // provider runs anything, and the editor reads it as the end of its transaction as it does the provider's.
    if (subject !== undefined && owner === null && IN_TRANSACTION_ACTIONS.has(action)) {
      throw new QueryError(NO_ACTIVE_TRANSACTION, connection.type);
    }

    switch (action) {
      case "begin": {
        // After the provider, never before: a begin that throws must leave no owner behind. Under governance the record
        // also keeps the key of the provider this transaction runs on, which the check above compares, and the scope of
        // the transaction's query events, and a timer looks for the provider's own timeout once it is due. The scrub of
        // this provider's credential is kept beside its key, for a rollback after the credential changes.
        const claim = () => {
          const events =
            subject === undefined ? undefined : transactionEventScope(guard.session, subject, connection, req);
          const claimed = claimTransaction(
            owned,
            guard.session.username,
            subject,
            providerKey,
            events,
            subject === undefined ? undefined : connectionScrub,
          );
          // The timer's read is Studio's own, under no request.
          const watcher: TransactionCaller = { signal: new AbortController().signal, route: ROUTE };
          watchTransactionTimeout(owned, claimed, () => readTransactionStateOrUnknown(provider, watcher));
        };
        // SANDBOX sends `requireReportedState: true`: it is about to promise a rollback, so a
        // server that never says whether a transaction is open is refused rather than trusted.
        const opened = await beginInTransaction(provider, body.requireReportedState === true, caller);
        if (opened.kind === "failed" || opened.kind === "not-sent") throw opened.error;
        if (opened.kind === "unanswered") {
          // Studio stopped waiting for a BEGIN that may have opened a transaction only its caller can own: it is
          // claimed for the caller, its state unknown, when no record holds the key and the session held no
          // transaction before it (docs/providers/CONTRACT.md, clause C-59).
          if (owner === null && sessionState !== "in-transaction") {
            claim();
            settleTransaction(owned, "unknown");
          }
          throw opened.error;
        }
        // A server that accepted BEGIN and opened nothing holds no transaction to claim.
        if (opened.sessionState === "not-in-transaction") throw new QueryError(NO_TRANSACTION_OPENED, connection.type);
        claim();
        settleTransaction(owned, opened.sessionState);
        // `stateReported: false` lets the UI say Studio cannot verify this transaction; `null`
        // is a provider that does not say, which is not a claim either way.
        return NextResponse.json({
          status: "active",
          message: "Transaction started",
          stateReported: opened.stateReported ?? null,
        });
      }

      case "commit": {
        const started = queryEventStart();
        const ended = await endTransaction(provider, "commit", caller);
        if (ended.kind !== "answered") {
          settleFailure(
            owned,
            owner,
            ended,
            { statement: "COMMIT", status: "error", started, ...eventError(connectionScrub, ended.error) },
            ended.kind === "failed" ? failedCommitEnd(ended.error) : "unknown",
          );
          throw ended.error;
        }
        // The reconcile above would also drop this record, on whatever call comes next. This is
        // not the authorization boundary and no test can tell it apart from that reconcile: it is
        // here so the record's lifetime matches the transaction's, rather than lasting until
        // somebody happens to touch this connection again - which for an idle connection is the
        // life of the process.
        settleTransaction(owned, ended.sessionState);
        if (owner !== null)
          endTransactionEvent(owner, "committed", { statement: "COMMIT", status: "success", started });
        return NextResponse.json({ status: "committed", message: "Transaction committed" });
      }

      case "rollback": {
        const started = queryEventStart();
        const ended = await endTransaction(provider, "rollback", caller);
        if (ended.kind !== "answered") {
          settleFailure(
            owned,
            owner,
            ended,
            { statement: "ROLLBACK", status: "error", started, ...eventError(connectionScrub, ended.error) },
            "rolled-back",
          );
          throw ended.error;
        }
        settleTransaction(owned, ended.sessionState);
        if (owner !== null) {
          endTransactionEvent(owner, "rolled-back", { statement: "ROLLBACK", status: "success", started });
        }
        return NextResponse.json({ status: "rolled_back", message: "Transaction rolled back" });
      }

      case "query": {
        // Read and gated above, before the provider: `query` is set whenever the action is "query".
        const { sql, params, unconfirmed } = query as NonNullable<typeof query>;
        const bound = { params };
        const confirmation = unconfirmed ? { confirmation: "unconfirmed" as const } : {};

        // Under governance one `open` event per query action, carrying the text the user submitted
        // (docs/GOVERNANCE.md#query-events).
        const started = queryEventStart();
        const recordStatement = (status: "success" | "error", outcome: { rowCount?: number; error?: unknown }) => {
          if (owner === null) return;
          const failure = outcome.error === undefined ? {} : eventError(connectionScrub, outcome.error);
          recordTransactionStatement(owner, {
            statement: sql,
            status,
            started,
            rowCount: outcome.rowCount,
            ...failure,
          });
        };

        // Several statements run one by one (#1390). Comment-only fragments are dropped first, so
        // a statement with a trailing `-- note` stays one statement on the path below. Never with
        // bound values: they belong to one statement's placeholders. One statement is sent as the
        // splitter read it, as `/api/db/multi-query` sends it: without the comment-only fragment
        // after it and without a script separator line (Oracle's `/`), which the engine refuses.
        let statementSql: string = sql;
        if (bound.params === undefined) {
          const grammar = resolveSqlGrammar(connection.type);
          const units = splitExecutionUnits(sql, grammar).filter((unit) => countCodeStatements(unit.sql, grammar) > 0);
          if (units.length > 1) {
            const script = await runScriptInTransaction(provider, units, options, connectionScrub);
            recordStatement(script.hasError ? "error" : "success", {});
            // The script's own statements stay on the provider until they move with POST /api/db/multi-query; the
            // state after them is read through the host (docs/providers/CONTRACT.md, clause C-50). The statements ran,
            // so a read that fails answers `unknown`, logged, as after a failure: the record stays, unresolved, and the
            // answer still reports their results (clause C-58).
            const stillOpen = await readTransactionStateOrUnknown(provider, caller);
            settleTransaction(owned, stillOpen);
            return NextResponse.json({ ...script, inTransaction: inTransactionAnswer(stillOpen), ...confirmation });
          }
          if (units.length === 1) statementSql = units[0].sql;
        }

        // One statement runs through the provider host, its page held to the host's page budget as on
        // POST /api/db/query, and answers the session state after it (`runInTransaction`).
        const ran = await runInTransaction(
          provider,
          { statement: statementSql, params: bound.params, options, scrub: connectionScrub },
          caller,
        );
        if (ran.kind !== "answered") {
          // A statement can fail and leave no transaction behind: the provider found its database session ended
          // (TRANSACTION_LOST), or the statement was a COMMIT the server ended in failure. The record goes now, with
          // the transaction's terminal event, so the next request's reconcile does not record it as timed out.
          settleFailure(
            owned,
            owner,
            ran,
            { statement: sql, status: "error", started, ...eventError(connectionScrub, ran.error) },
            "rolled-back",
          );
          throw ran.error;
        }
        recordStatement("success", { rowCount: eventRowCount(ran.body.rowCount) });

        // The provider ends its session when the SERVER says the statement ended the
        // transaction: a typed COMMIT or ROLLBACK, or a statement the engine commits implicitly (MySQL
        // DDL). Reported rather than hidden, because the caller is about to ask for a
        // ROLLBACK that would answer success and undo nothing (SANDBOX said "Changes
        // auto-rolled back" over a committed CREATE TABLE). The record goes with it.
        settleTransaction(owned, ran.sessionState);

        // THE SAME CONJUNCT AS `/api/db/query` (#816), for the same reason and on purpose: the page body is the one
        // `runEditorQuery` answers (`editorPageBody`, src/lib/api/editor-query.ts).
        //
        // This route is not a second-class copy: `use-query-execution.ts` sends a run
        // here whenever a transaction is open or the playground is driving, and that
        // includes a Load More click. `wasLimited` is the limiter saying it rewrote the
        // statement, which is the only thing that makes advancing the bound meaningful:
        // a statement returned untouched runs the same way at every offset, so a control
        // offered on one appends the rows already on screen.
        //
        // `pagination.hasMore` has one meaning wherever it is produced, and it is read
        // outside the grid as well — `lib/export/scope.ts` swings the export dialog's
        // copy on it.
        return NextResponse.json({
          ...ran.body,
          inTransaction: inTransactionAnswer(ran.sessionState),
          ...confirmation,
        });
      }

      case "status": {
        // Never refused because another session holds the transaction: this is the surface that tells
        // a user why the connection is busy and when it comes back, so refusing it would hide the
        // refusal above. (Under governance the caller's OWN transaction whose credential changed is
        // answered with 409 before this, because that is the news it would otherwise hide.) The three
        // booleans are distinguishable on purpose - an open transaction with no live owner record
        // (a restarted process, or a lapsed lease) reports `inTransaction` true with both of the
        // others false, and that state is the one any session is allowed to end.
        // `inTransaction` is null while the session state is unknown, which is neither, and the next read resolves it.
        return NextResponse.json({
          inTransaction: inTransactionAnswer(sessionState),
          ownedByYou,
          heldByAnotherSession: heldByAnother,
          startedAt: owner ? new Date(owner.startedAt).toISOString() : null,
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown transaction action: ${action}. Valid: begin, commit, rollback, query, status` },
          { status: 400 },
        );
    }
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/transaction", scrub });
  }
}
