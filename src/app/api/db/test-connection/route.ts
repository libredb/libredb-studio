import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { testConnection } from "@/lib/api/test-connection";

export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/test-connection", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await req.json();

    // Support both formats: { connectionId: "seed:X" }, { connection: {...} }, or bare connection object
    const connection = await resolveConnection(
      body.connectionId ? body : body.connection ? body : { connection: body },
      guard.session,
    );

    if (!connection.type) {
      return NextResponse.json({ success: false, error: "Connection configuration is required" }, { status: 400 });
    }

    // The steps of the test itself, which the VS Code extension's `connection/test` shares
    // (`src/lib/api/test-connection.ts`).
    // The DuckDB editor file-access posture is server-derived from the session role and the resolved
    // connection (non-admin DuckDB file access), so the core opens its handle with the right posture.
    return NextResponse.json(
      await testConnection(connection, editorExecutionContext(guard.session, connection), "api/db/test-connection"),
    );
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/test-connection" });
  }
}
