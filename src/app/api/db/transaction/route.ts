import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { readBoundParams } from "@/lib/api/bound-params";
import {
  claimTransaction,
  OWNERSHIP_IDLE_MS,
  releaseTransaction,
  touchTransaction,
  transactionOwner,
} from "@/lib/api/transaction-ownership";

interface TransactionProvider {
  beginTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  isInTransaction(): boolean;
  queryInTransaction(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; fields: string[]; rowCount: number; executionTime: number }>;
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

    const provider = await getOrCreateProvider(connection);

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
        await provider.beginTransaction();
        // After the provider, never before: a begin that throws must leave no owner behind.
        claimTransaction(connection.id, guard.session.username);
        return NextResponse.json({ status: "active", message: "Transaction started" });
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

        // Apply limit for SELECT queries within transaction
        const prepared = provider.prepareQuery(sql, options);
        const result = await provider.queryInTransaction(prepared.query, bound.params);

        touchTransaction(connection.id);

        const hasMore = result.rows.length === prepared.limit;

        return NextResponse.json({
          ...result,
          inTransaction: true,
          pagination: {
            limit: prepared.limit,
            offset: prepared.offset,
            hasMore,
            totalReturned: result.rows.length,
            wasLimited: prepared.wasLimited,
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
