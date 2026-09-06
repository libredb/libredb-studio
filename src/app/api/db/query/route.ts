import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { readBoundParams } from "@/lib/api/bound-params";
import { getExplainStrategy, type ExplainMode } from "@/lib/explain";
import type { ExplainFormat } from "@/lib/db/types";

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
    // An explain run describes a statement, it does not run one with values in it,
    // so the two fields are mutually exclusive rather than combined. Refused before
    // the provider is reached: nothing about the connection changes the answer.
    if (explain.explain && bound.params !== undefined && bound.params.length > 0) {
      return NextResponse.json({ error: "An explain request binds no parameters" }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);

    // The statement that actually runs. For an explain request it is the one the
    // CONNECTED provider's strategy builds, never the caller's own SQL: falling
    // back to that would execute e.g. an UPDATE the user only asked to see (#201).
    let statement = sql;
    let explainFormat: ExplainFormat | undefined;
    if (explain.explain) {
      const capabilities = provider.getCapabilities();
      const strategy = capabilities.supportsExplain ? getExplainStrategy(capabilities.explainFormat) : null;
      if (strategy === null) {
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

    // Pass queryId to provider for cancellation tracking
    const supportsCancel = "cancelQuery" in provider;
    const result =
      supportsCancel && queryId
        ? await (
            provider as unknown as {
              query(sql: string, params?: unknown[], queryId?: string): ReturnType<typeof provider.query>;
            }
          ).query(prepared.query, bound.params, queryId)
        : await provider.query(prepared.query, bound.params);

    const hasMore = result.rows.length === prepared.limit;

    return NextResponse.json({
      ...result,
      ...(explainFormat !== undefined && { explainFormat }),
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
