import { NextResponse } from "next/server";
import { isAgentRuntimeEnabled } from "@/lib/agent/config";
import { driveAgentRun, getAgentRunService } from "@/lib/agent/runtime";
import type { AgentRunMode } from "@/lib/agent/types";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";
import { logger } from "@/lib/logger";
import { resolveConnection } from "@/lib/seed/resolve-connection";

/**
 * Opens an agent run (#329 T9).
 *
 * The session is verified here rather than trusted from `src/proxy.ts`, like every
 * other route that reaches a database or a model: middleware is an optimisation,
 * not the authorization boundary. What this route decides, and nothing later may
 * re-decide, is WHO the run acts as — the actor is taken from the verified session
 * and written into the run's ledger, so a drive that happens minutes later in
 * another process still authorizes against the session that opened the run.
 *
 * Two refusals are worth naming because they look like restrictions and are
 * actually the shape of the durability contract:
 *
 *  - A connection supplied inline in the body is refused. A run persists a
 *    connection ID and no credential (T2), so a resumed drive re-resolves the
 *    connection on the server; one that only a browser knows cannot be rebuilt.
 *  - The mode is fixed at start. Tool selection is a server-side function of the
 *    run's PERSISTED mode, so a later request cannot widen a planning run.
 */

const ROUTE = "POST /api/agent/runs";

/** Bounded because it is written to the ledger and into every prompt the run makes. */
const MAX_OBJECTIVE_LENGTH = 4000;

const MODES: ReadonlySet<string> = new Set<AgentRunMode>(["planning", "agent"]);

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(req: Request) {
  const guard = await guardRoute({ route: ROUTE, bucket: "ai", request: req });
  if ("response" in guard) return guard.response;

  // Ahead of the body, behind the session: an operator who has not enabled the
  // runtime has no agent surface, and an unauthenticated caller cannot tell
  // whether one exists.
  if (!isAgentRuntimeEnabled()) {
    return NextResponse.json({ error: "The agent runtime is not enabled on this server" }, { status: 404 });
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return badRequest("Request body must be JSON");
    }

    const { mode, objective, connectionId } = body;
    if (typeof mode !== "string" || !MODES.has(mode)) {
      return badRequest('mode must be "planning" or "agent"');
    }
    if (typeof objective !== "string" || objective.trim().length === 0) {
      return badRequest("objective must be a non-empty string");
    }
    if (objective.length > MAX_OBJECTIVE_LENGTH) {
      return badRequest(`objective must be at most ${MAX_OBJECTIVE_LENGTH} characters`);
    }
    if (body.connection !== undefined) {
      return badRequest("An agent run needs a server-resolvable connectionId; an inline connection cannot be resumed");
    }
    if (typeof connectionId !== "string" || connectionId.trim().length === 0) {
      return badRequest("connectionId must be a non-empty string");
    }

    const connection = await resolveConnection({ connectionId }, guard.session);
    const service = await getAgentRunService();
    const record = await service.start({
      mode: mode as AgentRunMode,
      actor: { sessionId: guard.session.username, role: guard.session.role },
      connectionId: connection.id,
      objective,
    });

    // Driven in this process rather than over a loopback hop back through this
    // same middleware. The run's durability does not depend on this call
    // surviving: everything it does is written to the ledger first, so a drive
    // that dies leaves a run that CAN be resumed — POST /api/agent/drive does
    // exactly that. What does not exist yet is anything that asks for one, so a
    // process that dies mid-run leaves it running until something calls that
    // route (`docs/BACKLOG.md` B9).
    void driveAgentRun(record.runId).catch((error: unknown) => {
      logger.error("Agent run drive ended in failure", error, { route: "api/agent/runs", runId: record.runId });
    });

    return NextResponse.json({ runId: record.runId, status: record.status, mode: record.mode }, { status: 202 });
  } catch (error) {
    return createErrorResponse(error, { route: "api/agent/runs" });
  }
}
