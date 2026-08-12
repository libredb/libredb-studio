import { NextResponse } from "next/server";
import { isAgentRuntimeEnabled } from "@/lib/agent/config";
import type { AgentRunService, AgentRunStatusReport } from "@/lib/agent/run-service";
import { AgentRunStoreError } from "@/lib/agent/run-store";
import { getAgentRunService } from "@/lib/agent/runtime";
import { guardRoute } from "@/lib/api/require-session";
import type { UserPayload } from "@/lib/auth";

/**
 * The one gate every per-run route passes through (#329 T9): session, feature flag,
 * existence and ownership, answered once so three routes cannot drift apart.
 *
 * Ownership is decided against the run's PERSISTED actor, which is the same
 * authority a tool call is authorized by. Two consequences are deliberate:
 *
 *  - **An admin is not exempt.** A run is not an administrative object; it is one
 *    session's investigation, and its ledger cites data that session was allowed to
 *    read. Reading somebody else's run is a product decision this milestone did not
 *    make, so it is refused rather than quietly allowed to the higher role.
 *  - **Somebody else's run answers exactly like a run that does not exist.** A 403
 *    would confirm the run id, which is the one thing a caller guessing ids learns
 *    from.
 */

export type AgentRunAccess =
  | { readonly response: NextResponse }
  | {
      readonly session: UserPayload;
      readonly service: AgentRunService;
      readonly report: AgentRunStatusReport;
    };

/** Deliberately identical for "no such run", "not yours" and "runtime is off". */
function notFound(): NextResponse {
  return NextResponse.json({ error: "No such agent run" }, { status: 404 });
}

export async function accessAgentRun(opts: {
  /** "GET /api/agent/runs/[runId]" - recorded verbatim in the audit trail. */
  route: string;
  request: Request;
  runId: string;
}): Promise<AgentRunAccess> {
  const guard = await guardRoute({ route: opts.route, bucket: "ai", request: opts.request });
  if ("response" in guard) return guard;
  if (!isAgentRuntimeEnabled()) return { response: notFound() };

  const service = await getAgentRunService();

  /*
    A run id the LEDGER cannot name joins the same bucket. The store refuses one before
    it touches anything (`AGENT_RUN_ID_PATTERN` — a run id becomes a stream name), which
    is the guard doing its job; what was missing is that the refusal had no HTTP
    meaning, so asking for `../../etc/passwd` produced a bodyless 500 instead of an
    answer. It cannot exist, so it answers like a run that does not — the same reason a
    run belonging to somebody else does. Only THAT reason is caught: a malformed ledger
    or a backend that is genuinely broken must still surface as a server error.
  */
  let report: AgentRunStatusReport | null;
  try {
    report = await service.status(opts.runId);
  } catch (error) {
    if (error instanceof AgentRunStoreError && error.reasonCode === "INVALID_RUN_ID") {
      return { response: notFound() };
    }
    throw error;
  }

  if (report === null || report.record.actor.sessionId !== guard.session.username) {
    return { response: notFound() };
  }

  return { session: guard.session, service, report };
}
