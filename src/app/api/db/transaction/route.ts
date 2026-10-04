import { firstResultSet } from "@/lib/api/first-result-set";
import { pageOfProbe, pageOptionError, probePastPage } from "@/lib/api/page-probe";
import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import type { BeginTransactionOptions, BeginTransactionResult, DatabaseProvider, QueryResult } from "@/lib/db/types";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { readBoundParams } from "@/lib/api/bound-params";
import { rowsWithNonFiniteWords } from "@/lib/non-finite";
import { countCodeStatements, splitExecutionUnits, type ExecutionUnit } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import {
  claimTransaction,
  OWNERSHIP_IDLE_MS,
  releaseTransaction,
  touchTransaction,
  transactionOwner,
} from "@/lib/api/transaction-ownership";

interface TransactionProvider {
  // `void` from the providers that read no transaction state when they open one.
  beginTransaction(options?: BeginTransactionOptions): Promise<BeginTransactionResult | void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  isInTransaction(): boolean;
  queryInTransaction(sql: string, params?: unknown[]): Promise<QueryResult>;
}

/**
 * Run a script's statements in order on the transaction's connection, stopping at the first one
 * that fails (#1390).
 *
 * The editor sends a selection to this route whole whenever BEGIN or SANDBOX is on, and a driver
 * that runs one statement per call answers a syntax error at the second: measured on MySQL 26.7.0,
 * two UPDATE lines failed "near 'UPDATE ...' at line 2". The answer has the shape
 * `/api/db/multi-query` gives a script, which the editor already reports (the executed count, the
 * statement that failed, the last result with rows), plus `inTransaction`.
 *
 * A failure is part of the answer, not a thrown error: the statements before it ran inside the
 * transaction and their work is still there to commit or roll back. Only the last statement is
 * bounded, as on the script route, and only when it is a single statement and not a batch. A
 * statement that ends the transaction ends the run as well, because the next one is refused by the
 * provider ("No active transaction") rather than autocommitted.
 */
async function runScriptInTransaction(
  provider: TransactionProvider & Pick<DatabaseProvider, "prepareQuery">,
  units: ExecutionUnit[],
  options: Record<string, unknown>,
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
      const executionTime = Math.round(performance.now() - startTime);
      totalExecutionTime += executionTime;
      statements.push({
        ...identity,
        status: "error",
        executionTime,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      break;
    }
  }
  const shown = [...statements].reverse().find((r) => r.status === "success" && r.rows && r.rows.length > 0);
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

function isTransactionProvider(provider: unknown): provider is TransactionProvider {
  return (
    typeof provider === "object" &&
    provider !== null &&
    "beginTransaction" in provider &&
    "commitTransaction" in provider &&
    "rollbackTransaction" in provider
  );
}

export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/db/transaction", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await req.json();
    const { action, sql, options = {} } = body;

    const connection = await resolveConnection(body, guard.session);

    if (!action) {
      return NextResponse.json({ error: "Connection and action are required" }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection, {}, editorExecutionContext(guard.session));

    if (!isTransactionProvider(provider)) {
      return NextResponse.json(
        { error: "Transaction control is not supported for this database type" },
        { status: 400 },
      );
    }

    // The provider holds ONE transaction per connection id and every Studio user on that
    // connection drives it, so the caller's right to act on it is decided here, before any
    // action runs. See src/lib/api/transaction-ownership.ts for what was measured.
    const inTransaction = provider.isInTransaction();
    let owner = transactionOwner(connection.id);
    if (!inTransaction && owner) {
      // The provider ended the transaction without a session behind it - PostgresProvider and
      // MySQLProvider auto-roll back after TX_TIMEOUT_MS - so the record names a transaction that
      // no longer exists. Dropping it here is what stops that record from refusing the next user.
      releaseTransaction(connection.id);
      owner = null;
    }
    const ownedByYou = owner !== null && owner.username === guard.session.username;
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
          code: "TRANSACTION_NOT_OWNED",
          startedAt: new Date(owner.startedAt).toISOString(),
          availableAt,
        },
        { status: 409 },
      );
    }

    switch (action) {
      case "begin": {
        // SANDBOX sends `requireReportedState: true`: it is about to promise a rollback, so a
        // server that never says whether a transaction is open is refused rather than trusted.
        const opened = await provider.beginTransaction({ requireReportedState: body.requireReportedState === true });
        // After the provider, never before: a begin that throws must leave no owner behind.
        claimTransaction(connection.id, guard.session.username);
        // `stateReported: false` lets the UI say Studio cannot verify this transaction; `null`
        // is a provider that does not say, which is not a claim either way.
        return NextResponse.json({
          status: "active",
          message: "Transaction started",
          stateReported: opened ? opened.stateReported : null,
        });
      }

      case "commit": {
        await provider.commitTransaction();
        // The reconcile above would also drop this record, on whatever call comes next. This is
        // not the authorization boundary and no test can tell it apart from that reconcile: it is
        // here so the record's lifetime matches the transaction's, rather than lasting until
        // somebody happens to touch this connection again - which for an idle connection is the
        // life of the process.
        releaseTransaction(connection.id);
        return NextResponse.json({ status: "committed", message: "Transaction committed" });
      }

      case "rollback": {
        await provider.rollbackTransaction();
        releaseTransaction(connection.id);
        return NextResponse.json({ status: "rolled_back", message: "Transaction rolled back" });
      }

      case "query": {
        if (!sql) {
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
            const script = await runScriptInTransaction(provider, units, options);
            const stillOpen = provider.isInTransaction();
            if (stillOpen) touchTransaction(connection.id);
            else releaseTransaction(connection.id);
            return NextResponse.json({ ...script, inTransaction: stillOpen });
          }
          if (units.length === 1) statementSql = units[0].sql;
        }

        // Apply limit for SELECT queries within transaction
        const prepared = provider.prepareQuery(statementSql, options);
        // One row past the page, so a full last page is not taken for a full page (#1440).
        const probe = probePastPage(provider, statementSql, options, prepared);
        const result = await provider.queryInTransaction(probe.query, bound.params);

        // The provider ends its session when the SERVER says the statement ended the
        // transaction: a typed COMMIT or ROLLBACK, or a statement the engine commits implicitly (MySQL
        // DDL). Reported rather than hidden, because the caller is about to ask for a
        // ROLLBACK that would answer success and undo nothing (SANDBOX said "Changes
        // auto-rolled back" over a committed CREATE TABLE). The record goes with it.
        const stillInTransaction = provider.isInTransaction();
        if (stillInTransaction) touchTransaction(connection.id);
        else releaseTransaction(connection.id);

        // THE SAME CONJUNCT AS `/api/db/query` (#816), for the same reason and on purpose.
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
        const { hasMore, rows: pageRows } = pageOfProbe(prepared, result.rows);

        return NextResponse.json({
          ...firstResultSet(result),
          ...(hasMore && { rowCount: pageRows.length }),
          // NaN and the infinities as words, as on `/api/db/query` (`src/lib/non-finite.ts`).
          rows: rowsWithNonFiniteWords(pageRows),
          inTransaction: stillInTransaction,
          pagination: {
            limit: prepared.limit,
            offset: prepared.offset,
            hasMore,
            totalReturned: pageRows.length,
            wasLimited: hasMore || result.pagination?.wasLimited === true,
          },
        });
      }

      case "status": {
        // Never refused, for any caller: this is the surface that tells a user why the connection
        // is busy and when it comes back, so refusing it would hide the refusal above. The three
        // booleans are distinguishable on purpose - an open transaction with no live owner record
        // (a restarted process, or a lapsed lease) reports `inTransaction` true with both of the
        // others false, and that state is the one any session is allowed to end.
        return NextResponse.json({
          inTransaction,
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
    return createErrorResponse(error, { route: "api/db/transaction" });
  }
}
