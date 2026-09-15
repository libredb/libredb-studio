import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { readBoundParams } from "@/lib/api/bound-params";
import { getExplainStrategy, type ExplainMode } from "@/lib/explain";
import type { DatabaseProvider, ExplainFormat, OpenQueryTransactionOutcome } from "@/lib/db/types";

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

/**
 * Whether this provider can end a transaction its own `query()` path left open.
 *
 * The same runtime shape check `/api/db/multi-query` makes, spelled the same way and for
 * the same reason: the method is optional on `DatabaseProvider` because only a provider
 * that can name the session its statements ran on can answer truthfully
 * (`endOpenQueryTransaction`'s declaration argues why). `postgres`, `sqlite` and `duckdb`
 * implement it; on the rest this route leaves the handle exactly as it found it, because
 * inventing a rollback there would be guessing at another engine's state (D75).
 */
function endsOpenTransactions(
  provider: DatabaseProvider,
): provider is DatabaseProvider & Required<Pick<DatabaseProvider, "endOpenQueryTransaction">> {
  return typeof provider.endOpenQueryTransaction === "function";
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

    // MAY ONE STATEMENT LEAVE A TRANSACTION OPEN? No, and this finally is the answer (D74).
    //
    // It takes a single request. MEASURED 2026-09-15 against PostgreSQL 18.4 through this
    // handler with the real provider and the real cache: a lone `BEGIN` answered 200 and
    // released its pooled client in status `T`, and the next request on the same cached
    // provider ran its `CREATE TABLE` inside that transaction, answered 200, and an
    // independent reader saw no such table. The same `BEGIN` followed by a statement
    // naming a missing relation left the client in `E`, and the next request answered
    // HTTP 500 "current transaction is aborted, commands ignored until end of transaction
    // block". `/api/db/multi-query` needed a script to reach this; one word reaches it here.
    //
    // WHO CAN SEE WHAT, because the handle is not private. `getOrCreateProvider` caches one
    // provider per `connection.id` for the whole process, so two different signed-in users
    // of one stored connection share one pooled client, and a transaction left open on it
    // stops being the opener's the moment the response is sent. What this finally ends is
    // the transaction the statement of THIS request left open, on the client that request's
    // statement ran on, before the handle is reachable by anyone else: the only work it can
    // discard is the caller's own, and the caller is told in the same response. What it
    // never touches is the interactive session `POST /api/db/transaction` drives, which
    // holds a connection of its own that `query()` never borrows.
    //
    // A finally and not a line after the call: the failure path is where the poisoned
    // handle is actually produced, and an error must not be able to skip the rollback.
    // Not a guard on the word BEGIN either, and not an unconditional ROLLBACK: the same two
    // arguments `/api/db/multi-query` makes, with the same one-call provider surface.
    let openTransaction: OpenQueryTransactionOutcome = "none";
    let result;
    try {
      // Pass queryId to provider for cancellation tracking
      const supportsCancel = "cancelQuery" in provider;
      result =
        supportsCancel && queryId
          ? await (
              provider as unknown as {
                query(sql: string, params?: unknown[], queryId?: string): ReturnType<typeof provider.query>;
              }
            ).query(prepared.query, bound.params, queryId)
          : await provider.query(prepared.query, bound.params);
    } finally {
      if (endsOpenTransactions(provider)) {
        openTransaction = await provider.endOpenQueryTransaction();
      }
    }

    const hasMore = result.rows.length === prepared.limit;

    return NextResponse.json({
      ...result,
      ...(explainFormat !== undefined && { explainFormat }),
      // Present only when there was a transaction to end, the rule every additive channel
      // on this route follows: a client renders the notice from the field's presence alone,
      // so an always-present "none" would announce something that did not happen.
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
