import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { resolveServedConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { testConnection } from "@/lib/api/test-connection";
import { connectionTextScrub, type ProviderTextScrub } from "@/lib/db/operations/provider-text";
import { legacyProviderType } from "@/lib/db/server-catalog";

export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/test-connection", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // Core's scrub of the resolved connection, held out here for the `catch` below: before the connection resolves no
  // provider ran.
  let scrub: ProviderTextScrub | undefined;
  // Whether the failure the `catch` below answers was logged already, as a provider package's open failure
  // (`testConnection`), so the answer writes no second line.
  const failure = { logged: false };
  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ success: false, error: INVALID_REQUEST_BODY }, { status: 400 });
    }

    // Support both formats: { connectionId: "seed:X" }, { connection: {...} }, or bare connection object. The
    // connection resolves with every guard of every route and with the server catalog's record of its engine, an
    // admitted provider package's engine included; the resolve refuses a type that names no engine.
    const { connection, engine } = await resolveServedConnection(
      body.connectionId ? body : body.connection ? body : { connection: body },
      guard.session,
    );
    scrub = connectionTextScrub(connection, legacyProviderType(engine), "any");

    // The one test of a connection for every engine, which the VS Code extension's `connection/test` shares
    // (`src/lib/api/test-connection.ts`): what differs between engines it reads from the record.
    // The DuckDB editor file-access posture is server-derived from the session role and the resolved
    // connection (non-admin DuckDB file access), so the core opens its handle with the right posture.
    return NextResponse.json(
      await testConnection(
        connection,
        engine,
        editorExecutionContext(guard.session, connection),
        "api/db/test-connection",
        failure,
      ),
    );
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/test-connection", scrub, logged: failure.logged });
  }
}
