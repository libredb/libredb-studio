import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";

export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/cancel", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await req.json();
    const { queryId } = body;

    const connection = await resolveConnection(body, guard.session);

    if (!queryId) {
      return NextResponse.json({ error: "Connection and queryId are required" }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);

    // Check if provider supports cancellation
    if (!("cancelQuery" in provider) || typeof (provider as Record<string, unknown>).cancelQuery !== "function") {
      return NextResponse.json(
        { error: "Query cancellation is not supported for this database type", cancelled: false },
        { status: 400 },
      );
    }

    const cancelled = await (provider as { cancelQuery(queryId: string): Promise<boolean> }).cancelQuery(queryId);

    return NextResponse.json({ cancelled });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/cancel" });
  }
}
