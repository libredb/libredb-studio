import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { type ProviderTextScrub, providerTextScrub } from "@/lib/db/operations/provider-text";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { cancelEditorRun, openWithinCall } from "@/lib/api/editor-query";

export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/cancel", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // Core's scrub of the resolved connection, held out here for the `catch` below: before the connection resolves no
  // provider ran.
  let scrub: ProviderTextScrub | undefined;
  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }
    const { queryId } = body;

    const connection = await resolveConnection(body, guard.session);
    scrub = providerTextScrub(connection, "any");

    if (!queryId) {
      return NextResponse.json({ error: "Connection and queryId are required" }, { status: 400 });
    }
    if (typeof queryId !== "string") {
      return NextResponse.json({ error: "queryId must be a string", cancelled: false }, { status: 400 });
    }

    // The open is waited for within its engine's connect budget and while the request stays (`openWithinCall`): a
    // request already aborted, or one that leaves while the connection opens, answers 499 not-sent; a provider already
    // open is handed over before any wait is read.
    const provider = await openWithinCall(req.signal, connection.type, (wait) =>
      getOrCreateProvider(connection, {}, editorExecutionContext(guard.session, connection), wait),
    );

    // Through the provider host core's cancel call, under the cleanup deadline and the request's own signal: a request
    // already aborted calls nothing and answers 499. A provider without the same `supportsQueryCancel` that
    // `/api/db/provider-meta` reports is not offered the cancel, so the editor does not offer a Cancel this refuses
    // (#1364).
    const answer = await cancelEditorRun(provider, queryId, req.signal, "api/db/cancel");
    if (!answer.offered) {
      return NextResponse.json(
        { error: "Query cancellation is not supported for this database type", cancelled: false },
        { status: 400 },
      );
    }

    return NextResponse.json({ cancelled: answer.cancelled });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/cancel", scrub });
  }
}
