import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { createErrorResponse } from "@/lib/api/errors";
import { connectionTextScrub, type ProviderTextScrub } from "@/lib/db/operations/provider-text";
import { legacyProviderType } from "@/lib/db/server-catalog";
import { resolveServedConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { editorConsoleTarget } from "@/lib/api/editor-provider";
import { cancelEditorRun, openWithinBudget } from "@/lib/api/editor-query";
import { type PackageAnswers, packageAnswers } from "@/lib/api/package-errors";
import { packageConnectBudget } from "@/lib/provider-host/open-context";

const ROUTE = "api/db/cancel";

/**
 * POST /api/db/cancel
 * Cancels the run `queryId` names, for any engine the server serves (docs/providers/CONTRACT.md, clause C-107), through
 * the host core's cancel call on the connection's editor session (`editorConsoleTarget`), the session the run's own
 * query opened: a legacy provider's bridged session, or a provider package's own, whose `console.cancel` is sent the run
 * id its execute was sent. Where no session is cached the cancel opens one, which finds no run and answers
 * `cancelled: false`. A session that does not offer `console.cancel` is answered the route's one refusal for every
 * engine, 400 with `cancelled: false`, calling nothing (clause C-30). A package's failure, of its open or of its cancel,
 * is answered and logged once through the request's `PackageAnswers` (clause C-112), so the route writes no second line.
 */
export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/cancel", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // Core's scrub of the resolved connection and the request's record of a package's failures, held out here for the
  // `catch` below: before the connection resolves no provider ran.
  let scrub: ProviderTextScrub | undefined;
  let answers: PackageAnswers | undefined;
  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }
    const { queryId } = body;

    const { connection, engine } = await resolveServedConnection(body, guard.session);
    scrub = connectionTextScrub(connection, legacyProviderType(engine), "any");
    answers = packageAnswers(engine, scrub, ROUTE);
    const answering = answers;

    if (!queryId) {
      return NextResponse.json({ error: "Connection and queryId are required" }, { status: 400 });
    }
    if (typeof queryId !== "string") {
      return NextResponse.json({ error: "queryId must be a string", cancelled: false }, { status: 400 });
    }

    // The open is waited for within the connect budget the engine's record states (`packageConnectBudget`) and while
    // the request stays (`openWithinBudget`): a request already aborted, or one that leaves while the connection opens,
    // answers 499 not-sent; a session already open is handed over before any wait is read. A failure of the open is the
    // package's open's.
    const target = await openWithinBudget(req.signal, packageConnectBudget(engine), (wait) =>
      editorConsoleTarget(guard.session, connection, engine, wait),
    ).catch((error: unknown) => {
      throw answering.answer("open", error);
    });

    // Through the provider host core's cancel call, under the cleanup deadline and the request's own signal: a request
    // already aborted calls nothing and answers 499. A legacy provider without the same `supportsQueryCancel` that
    // `/api/db/provider-meta` reports is not offered the cancel, so the editor does not offer a Cancel this refuses
    // (#1364).
    const answer = await cancelEditorRun(target, queryId, req.signal, ROUTE).catch((error: unknown) => {
      throw answering.answer("cancel", error);
    });
    if (!answer.offered) {
      return NextResponse.json(
        { error: "Query cancellation is not supported for this database type", cancelled: false },
        { status: 400 },
      );
    }

    return NextResponse.json({ cancelled: answer.cancelled });
  } catch (error) {
    return createErrorResponse(error, { route: ROUTE, scrub, logged: answers?.logged(error) === true });
  }
}
