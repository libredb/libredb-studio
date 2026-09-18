import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { readBoundParams } from "@/lib/api/bound-params";
import { getExplainStrategy, type ExplainMode } from "@/lib/explain";
import { endsOpenQueryTransactions, newQueryCallScope } from "@/lib/db/types";
import type { ExplainFormat, OpenQueryTransactionOutcome } from "@/lib/db/types";

/**
 * The error an unreadable `explain` field gets. It names the whole allowed shape
 * rather than what was sent, the way `BOUND_PARAMS_MESSAGE` does.
 */
const EXPLAIN_REQUEST_MESSAGE = 'explain must be { "mode": "estimate" } or { "mode": "analyze" }';

type ExplainRequestResult =
  | { valid: true; explain: { mode: ExplainMode } | undefined }
  | { valid: false; message: string };

/**
 * Read a request's `explain` field: the ASK for a plan, not a statement (#574).
 *
 * The EXPLAIN statement is built on this side because the accepted form is not
 * always knowable before connecting. Measured 2026-09-06 over the MySQL wire
 * protocol (mysql2 3.24.2, text protocol): `EXPLAIN FORMAT=JSON SELECT 1` is
 * refused by TiDB v8.5.1 (errno 1105, "explain format 'json' is not supported
 * now"), Apache Doris 4.1.3 (errno 1105, "mismatched input '='"), StarRocks
 * 3.3.22 and SingleStore (both errno 1064), while a plain `EXPLAIN SELECT 1` is
 * accepted on every one of them. `POST /api/db/provider-meta` never connects
 * (#457), so the client cannot be told which form to build; it asks for a mode
 * and the connected provider's capabilities decide the rest.
 */
function readExplainRequest(value: unknown): ExplainRequestResult {
  if (value === undefined) return { valid: true, explain: undefined };
  if (typeof value !== "object" || value === null) return { valid: false, message: EXPLAIN_REQUEST_MESSAGE };

  const mode = (value as { mode?: unknown }).mode;
  if (mode !== "estimate" && mode !== "analyze") return { valid: false, message: EXPLAIN_REQUEST_MESSAGE };

  return { valid: true, explain: { mode } };
}

export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/query", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await req.json();
    const { sql, options = {}, queryId } = body;

    const connection = await resolveConnection(body, guard.session);

    if (!sql) {
      return NextResponse.json({ error: "Connection and query are required" }, { status: 400 });
    }

    // A generated statement sends its values here rather than writing them into the
    // SQL (#290). They go straight to the driver's bind path, so what may be bound
    // is decided before the provider is even reached.
    const bound = readBoundParams(body.params);
    if (!bound.valid) {
      return NextResponse.json({ error: bound.message }, { status: 400 });
    }

    const explain = readExplainRequest(body.explain);
    if (!explain.valid) {
      return NextResponse.json({ error: explain.message }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);

    // The statement that actually runs. For an explain request it is the one the
    // CONNECTED provider's strategy builds, never the caller's own SQL: falling
    // back to that would execute e.g. an UPDATE the user only asked to see (#201).
    //
    // Bound `params` may come with it and are bound to the BUILT statement: every
    // strategy only prefixes the statement, so the placeholders are the same ones
    // in the same order, which is what the background plan request of PR #304
    // relies on. Refusing them would take the plan away from every generated
    // statement that sends its values separately (#290).
    let statement = sql;
    let explainFormat: ExplainFormat | undefined;
    if (explain.explain) {
      const capabilities = provider.getCapabilities();
      // `getExplainStrategy` indexes a Record, so a format outside this build's union
      // (an external implementer of the published interface can declare anything)
      // comes back undefined rather than null; a strict null check let that reach
      // `strategy.buildSql` and surface as a TypeError 500 instead of this 400.
      const strategy = capabilities.supportsExplain ? getExplainStrategy(capabilities.explainFormat) : null;
      if (!strategy) {
        return NextResponse.json({ error: "This server does not support EXPLAIN" }, { status: 400 });
      }
      const built = strategy.buildSql(sql, explain.explain.mode);
      if (built === null) {
        return NextResponse.json({ error: "Only SELECT statements can be explained" }, { status: 400 });
      }
      statement = built;
      // Named in the response so the client stores the plan under the format that
      // really produced it, rather than under the static one provider-meta gave it.
      explainFormat = strategy.format;
    }

    const prepared = provider.prepareQuery(statement, options);

    // A SINGLE STATEMENT CAN LEAVE A TRANSACTION OPEN, SO THIS ROUTE ENDS IT (D74).
    //
    // MEASURED 2026-09-15 against PostgreSQL 18.4 through this handler with the real
    // provider and the real process-wide cache: a lone `BEGIN` answered 200 and released
    // its pooled client in status `T`, and the next request on the same cached provider —
    // which is any other signed-in user of that stored connection — ran its `CREATE TABLE`
    // inside that stranger's transaction, answered 200, and an independent reader saw no
    // such table. Driven the other way the loss is loud: a `BEGIN` followed by a statement
    // naming a missing relation leaves the client in `E` and the next request answers 500.
    //
    // This `finally` was tried once before and REVERTED, because the ender it calls named
    // one shared pointer: it rolled back whichever client anybody had recorded last, which
    // cost a concurrent `/api/db/multi-query` script its committed `CREATE TABLE` and an
    // interactive `POST /api/db/transaction` session its own. D87 fixed that in the
    // provider, where the borrowed client is in scope, and the `scope` minted here is what
    // names this request's own session: nothing this handler did not run on can be ended.
    //
    // It is a `finally` and not a line after the call because the statement that poisons a
    // client is usually the one that threw, and the response must not be able to leave by
    // a path that skips this.
    const scope = newQueryCallScope();
    let openTransaction: OpenQueryTransactionOutcome = "none";

    // Pass queryId to provider for cancellation tracking
    const supportsCancel = "cancelQuery" in provider;
    let result: Awaited<ReturnType<typeof provider.query>>;
    try {
      result = await provider.query(prepared.query, bound.params, supportsCancel ? queryId : undefined, scope);
    } finally {
      if (endsOpenQueryTransactions(provider)) {
        openTransaction = await provider.endOpenQueryTransaction(scope);
      }
    }

    const hasMore = prepared.wasLimited && result.rows.length === prepared.limit;

    return NextResponse.json({
      ...result,
      ...(explainFormat !== undefined && { explainFormat }),
      // Present only when there was a transaction to end, the way `/api/db/multi-query`
      // reports it, so an always-present "none" would announce something that did not happen.
      // `use-query-execution.ts` raises the notice off this field on BOTH paths; it used to raise
      // it only inside its `multiStatement` branch, which a lone statement never sets, so this
      // field was answered and never rendered for its whole first commit.
      ...(openTransaction === "rolled-back" && { openTransaction }),
      pagination: {
        limit: prepared.limit,
        offset: prepared.offset,
        hasMore,
        totalReturned: result.rows.length,
        wasLimited: prepared.wasLimited,
      },
    });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/query" });
  }
}
