import { NextRequest, NextResponse } from "next/server";
import { createDatabaseProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";

export const dynamic = "force-dynamic";

/**
 * Return provider capabilities/labels without opening a live DB connection.
 * Metadata methods are sync and type-driven; connecting would needlessly contend
 * for exclusive file locks (SQLite / LibreDB) and network pools.
 */
export async function POST(req: NextRequest) {
  // Moved ahead of body parsing: an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/provider-meta", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    if (!body || (typeof body === "object" && Object.keys(body).length === 0)) {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    const connection = await resolveConnection(
      body.connectionId ? body : body.connection ? body : { connection: body },
      guard.session,
    );

    if (!connection.type) {
      return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
    }

    const provider = await createDatabaseProvider(connection);

    return NextResponse.json({
      capabilities: provider.getCapabilities(),
      labels: provider.getLabels(),
    });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/provider-meta" });
  }
}
