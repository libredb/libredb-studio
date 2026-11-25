import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { resolvePackageAwareConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { testConnection, testPackageConnection } from "@/lib/api/test-connection";
import { type ProviderTextScrub, providerTextScrub } from "@/lib/db/operations/provider-text";

export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/test-connection", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // Core's scrub of the resolved connection, held out here for the `catch` below: before the connection resolves no
  // provider ran.
  let scrub: ProviderTextScrub | undefined;
  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ success: false, error: INVALID_REQUEST_BODY }, { status: 400 });
    }

    // Support both formats: { connectionId: "seed:X" }, { connection: {...} }, or bare connection object. The one route
    // that serves an engine of an admitted provider package: its connection is read by the engine's field rules, then
    // refused at the open (docs/providers/CONTRACT.md, clause C-107).
    const resolved = await resolvePackageAwareConnection(
      body.connectionId ? body : body.connection ? body : { connection: body },
      guard.session,
    );
    if (resolved.kind === "package") testPackageConnection(resolved.connection, resolved.engine);
    const { connection } = resolved;
    scrub = providerTextScrub(connection, "any");

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
    return createErrorResponse(error, { route: "api/db/test-connection", scrub });
  }
}
