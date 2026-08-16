import { NextResponse } from "next/server";
import { isAgentRuntimeEnabled } from "@/lib/agent/config";
import { AGENT_MAX_OBJECTIVE_LENGTH } from "@/lib/agent/execution-policy";
import { classifyAgentWorkflow } from "@/lib/agent/workflow-classifier";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";

/**
 * Reads one objective and names the workflow a run would open as
 * (`docs/superpowers/specs/2026-08-16-agent-workflow-inference-design.md`).
 *
 * **Why this is its own endpoint rather than a step inside `POST /api/agent/runs`.**
 * The rail has to know the workflow BEFORE a run exists, because one classification
 * — `data-analysis` in agent mode — changes what the user is asked next: the consent
 * step that decides whether the run may hand a statement to the editor. Folding the
 * classification into the open request would put that question after the run had
 * already started, and `src/lib/agent/types.ts` holds the invariant that every
 * widening decision is made when the run opens. Asking for consent between
 * classification and open is still consent given at open time; asking for it after
 * the ledger has a record is not.
 *
 * **Why that adds no new trust weakness.** This route decides nothing about a run.
 * The client already sends `workflowType` on the open request today and always has,
 * so the authority over what a run is for sits exactly where it sat before — in the
 * body of `POST /api/agent/runs`, which validates it against the five ids it serves
 * and refuses anything else. A caller that skipped this route entirely, or ignored
 * its answer, can reach nothing it could not reach without it.
 *
 * Two things are nevertheless deliberate here:
 *
 *  - The `ai` rate-limit bucket, the same one the run routes use. Classification
 *    doubles the per-run request count against the model provider, so charging it to
 *    a separate budget would let a caller spend twice what the bucket is sized for
 *    by alternating between two routes that both reach the same endpoint.
 *  - The session is verified BEFORE the runtime flag is read, and the flag answers
 *    404 — the shape `POST /api/agent/runs` uses. In that order an unauthenticated
 *    caller gets the same 401 whether or not this operator runs an agent at all, so
 *    the route cannot be used to probe for the surface.
 *
 * There is no failure path for classification itself. `classifyAgentWorkflow`
 * resolves for every model error, timeout and unrecognised reply, so a failed
 * classification arrives here as `outcome: "unclassified"` and is answered with 200:
 * the run the user is starting opens either way, and `outcome` is what stops the
 * rail from presenting the fallback as a verdict.
 */

const ROUTE = "POST /api/agent/classify";

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(req: Request) {
  const guard = await guardRoute({ route: ROUTE, bucket: "ai", request: req });
  if ("response" in guard) return guard.response;

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

    const { objective } = body;
    if (typeof objective !== "string" || objective.trim().length === 0) {
      return badRequest("objective must be a non-empty string");
    }
    // The same bound the run route applies, and the same constant: an objective this
    // route classified but that route would refuse is a classification spent on a run
    // that cannot open.
    if (objective.length > AGENT_MAX_OBJECTIVE_LENGTH) {
      return badRequest(`objective must be at most ${AGENT_MAX_OBJECTIVE_LENGTH} characters`);
    }

    const classification = await classifyAgentWorkflow(objective);

    return NextResponse.json(
      { workflowType: classification.workflowType, outcome: classification.outcome },
      { status: 200 },
    );
  } catch (error) {
    return createErrorResponse(error, { route: "api/agent/classify" });
  }
}
