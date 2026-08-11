import { NextResponse } from "next/server";
import { isAgentRuntimeEnabled } from "@/lib/agent/config";
import { AGENT_DRIVE_HEADER, verifyAgentDriveToken } from "@/lib/agent/drive-token";
import { AgentRunServiceError } from "@/lib/agent/run-service";
import { driveAgentRun } from "@/lib/agent/runtime";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { RateLimitError, consumeRateLimit } from "@/lib/api/rate-limit";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * Pick this run up and drive it (#329 T9): the resume path, for a caller that is a
 * machine rather than a person.
 *
 * Stated plainly because the name suggests otherwise: **nothing calls this yet.**
 * The workflow runtime is used as the ledger's durable substrate only, so no queue
 * delivery arrives here, and a run whose process died stays running until something
 * asks. `docs/BACKLOG.md` B9 records what a producer has to bring with it (a sweep,
 * and single-flight per run). What this route establishes now is the authenticated
 * seam that producer will use, and the property that seam must never lose.
 *
 * The only route in the application a caller reaches without a user session, so
 * three things are true of it and each is deliberate:
 *
 *  - **It is not exempt from `src/proxy.ts`.** The public-path list is unchanged;
 *    the middleware admits this request only because it carries a credential this
 *    server minted, and this handler verifies that credential again itself.
 *  - **The credential names the run.** Not the body, which is read for nothing at
 *    all. A caller holding a token for one run cannot drive another.
 *  - **It grants nothing.** The run acts as the actor its own ledger records — a
 *    session and a role written when the run was opened — so this token cannot
 *    escalate a run, only continue it.
 *
 * The response is deliberately the drive's outcome rather than an immediate
 * acknowledgement: the local backend's queue treats a non-2xx as a delivery to
 * retry, and a drive that failed halfway is exactly a delivery worth retrying.
 */

const ROUTE = "POST /api/agent/drive";

/** Ended for good; a later delivery of the same message must not resurrect it. */
const TERMINAL_REASONS: ReadonlySet<string> = new Set(["RUN_NOT_RESUMABLE", "RUN_ALREADY_TERMINAL"]);

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "A valid agent drive credential is required" }, { status: 401 });
}

export async function POST(req: Request) {
  const runId = await verifyAgentDriveToken(req.headers.get(AGENT_DRIVE_HEADER));
  if (runId === null) {
    const ip = clientAddress(req);
    // Metered like every other unauthenticated denial: the refusal is
    // unconditional, only the audit line is rate limited, so a caller probing
    // this path cannot fill a container log volume.
    const notice = consumeRateLimit("anon", ip);
    if (notice.allowed || notice.tripped) {
      try {
        emitAuditEvent({
          type: "permission_denied",
          action: "denied",
          target: ROUTE,
          user: "anonymous",
          result: "failure",
          reason: "no_agent_drive_token",
          ip,
        });
      } catch (auditError) {
        logger.error("Failed to record permission_denied audit event", auditError, { route: ROUTE });
      }
    }
    return unauthorized();
  }

  // After the credential check: an unauthenticated caller learns nothing about
  // whether this server runs agents.
  if (!isAgentRuntimeEnabled()) {
    return NextResponse.json({ error: "The agent runtime is not enabled on this server" }, { status: 404 });
  }

  // Keyed on the run, not on the caller's address: the transport is this server
  // itself, so every delivery shares one address and a per-address budget would
  // let one run's retries starve every other run's.
  const decision = consumeRateLimit("ai", `agent-drive:${runId}`);
  if (!decision.allowed) {
    return createErrorResponse(new RateLimitError(decision.retryAfterSeconds), { route: ROUTE });
  }

  try {
    return NextResponse.json(await driveAgentRun(runId));
  } catch (error) {
    if (error instanceof AgentRunServiceError) {
      if (error.reasonCode === "RUN_NOT_FOUND") {
        return NextResponse.json({ error: "No such agent run" }, { status: 404 });
      }
      if (TERMINAL_REASONS.has(error.reasonCode)) {
        // 409, not 5xx: the run ended, so redelivering this message will never
        // succeed and the queue should stop trying.
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
    }
    return createErrorResponse(error, { route: "api/agent/drive" });
  }
}
