import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { readBoundParams } from "@/lib/api/bound-params";

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

    const provider = await getOrCreateProvider(connection);
    const prepared = provider.prepareQuery(sql, options);

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
