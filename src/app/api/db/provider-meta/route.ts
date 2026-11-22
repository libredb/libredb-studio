import { NextRequest, NextResponse } from "next/server";
import { readProviderDeclarations } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { editorExecutionContext } from "@/lib/api/execution-context";

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

    // No `withOneShotTunnel` here, unlike test-connection and schema-snapshot (#457): this route never connects.
    // Capabilities and labels are type-driven and read by `readProviderDeclarations` without a socket and without
    // opening the connection's tunnel, and it hands back data, never a provider (FND-2 slice 5). The execution context
    // is passed as the other routes pass it (non-admin DuckDB file access): the factory refuses a connection whose
    // engine refuses a denied posture under one that denies it (SQLite), with the sentence its connect gives, before
    // the provider is built, so a caller who could never open it gets that refusal here too.
    const declarations = await readProviderDeclarations(connection, editorExecutionContext(guard.session, connection));

    return NextResponse.json({
      // `supportsQueryCancel` is read off the provider's surface rather than declared by
      // it: it is the cancel route's own check, so the two cannot disagree (#1364).
      capabilities: { ...declarations.capabilities, supportsQueryCancel: declarations.supportsQueryCancel },
      labels: declarations.labels,
    });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/provider-meta" });
  }
}
