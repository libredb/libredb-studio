import { NextResponse } from "next/server";
import { admitAgentModel } from "@/lib/agent/capability-gate";
import { isAgentRuntimeEnabled } from "@/lib/agent/config";
import { AGENT_MAX_OBJECTIVE_LENGTH } from "@/lib/agent/execution-policy";
import { driveAgentRun, getAgentRunService } from "@/lib/agent/runtime";
import {
  AGENT_WORKFLOW_PRESENTS_ANSWER,
  DEFAULT_AGENT_WORKFLOW_TYPE,
  type AgentRunMode,
  type AgentRunWorkflowType,
} from "@/lib/agent/types";
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
 *  - **The workflow type is fixed at start too, and for the same reason.** It is
 *    what the run is FOR, and both the tool set and the goal verifier read it off
 *    the run's own record. It is optional in the body — omitting it opens an
 *    investigation, which is what every run before the field was — and there is no
 *    other route that accepts it, so a run cannot change what it is for after it
 *    has been opened.
 *  - **Auto-execute is fixed at start, and that is the reason it is a run field at
 *    all.** It is what the run may hand to the editor to RUN, on a path with none of
 *    the agent's own bounds, so it is decided once by the request that opens the run
 *    and read from the run's own record for the rest of its life. Absent means off;
 *    a value that is not a boolean is refused rather than coerced.
 */

const ROUTE = "POST /api/agent/runs";

/**
 * Bounded because it is written to the ledger and into every prompt the run makes.
 * Imported rather than written here: the rail bounds the same value, and the two used
 * to be separate constants kept in step by a comment (see the constant's docblock).
 */
const MAX_OBJECTIVE_LENGTH = AGENT_MAX_OBJECTIVE_LENGTH;

const MODES: ReadonlySet<string> = new Set<AgentRunMode>(["planning", "agent"]);

const WORKFLOW_TYPES: ReadonlySet<string> = new Set<AgentRunWorkflowType>([
  "investigation",
  "query-optimization",
  "database-assessment",
  "operations",
  "data-analysis",
]);

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

    const { mode, workflowType, autoExecute, objective, connectionId } = body;
    if (typeof mode !== "string" || !MODES.has(mode)) {
      return badRequest('mode must be "planning" or "agent"');
    }
    // Absent is allowed and means an investigation. An unrecognised one is REFUSED
    // rather than defaulted: a caller who names a workflow this server does not
    // serve has asked for something it will not get, and silently running a
    // different one is how a user reads a report about work nobody requested.
    if (workflowType !== undefined && (typeof workflowType !== "string" || !WORKFLOW_TYPES.has(workflowType))) {
      return badRequest(`workflowType must be one of ${[...WORKFLOW_TYPES].join(", ")}`);
    }
    // Absent means off. Anything that is not a boolean is REFUSED rather than
    // coerced: `"false"`, `0` and `null` are all truthy or falsy by accident in some
    // serialiser, and guessing wrong here gives away the editor's time limit on a
    // statement nobody agreed to run.
    if (autoExecute !== undefined && typeof autoExecute !== "boolean") {
      return badRequest("autoExecute must be a boolean");
    }
    // The setting only means something where the run can present an answer, because
    // the hand-over IS `present_answer`'s. Accepting it elsewhere would persist a run
    // record claiming a hand-over that nothing could ever perform, and would have the
    // system prompt tell the model to inspect the plan of a presentation it has no
    // tool to make. Refused rather than quietly normalised to `false`: a caller that
    // asked for this got a run that will not do it, and a silent downgrade is how a
    // user comes to believe a feature ran.
    const requestedWorkflow = (workflowType ?? DEFAULT_AGENT_WORKFLOW_TYPE) as AgentRunWorkflowType;
    if (autoExecute === true && !AGENT_WORKFLOW_PRESENTS_ANSWER[requestedWorkflow]) {
      return badRequest(
        `autoExecute is only available on workflows that present an answer: ${Object.keys(
          AGENT_WORKFLOW_PRESENTS_ANSWER,
        )
          .filter((candidate) => AGENT_WORKFLOW_PRESENTS_ANSWER[candidate as AgentRunWorkflowType])
          .join(", ")}`,
      );
    }
    // Planning is toolless whatever the run is for, so the same argument applies to
    // it in full: there is no `present_answer` in an empty tool set.
    if (autoExecute === true && mode !== "agent") {
      return badRequest("autoExecute is only available in agent mode: a planning run is offered no tools");
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

    /*
      Before a run exists, not after one has failed. A model that cannot call tools
      would otherwise open a run, spend a drive and end having answered in prose — the
      diagnosis gap `docs/BACKLOG.md` B18 describes. The gate refuses only what the
      probe positively ESTABLISHED, so nothing that merely went wrong (a quota, a bad
      key, an unreachable endpoint) reaches here as a refusal; those still start, and
      the drive reports them in its own vocabulary. 422 rather than 400: the request is
      well-formed, and it is the server's configuration that cannot honour it.
    */
    const gate = await admitAgentModel(mode as AgentRunMode);
    if (gate.kind === "refused") {
      // `disproved` travels beside `missing` because they answer different questions.
      // `missing` is what this run needed and did not get; `disproved` is what the
      // probe watched fail, which is the only half that says anything about what ELSE
      // the same model could be asked to do (#331 T4 review).
      return NextResponse.json(
        { error: gate.refusal.message, missing: gate.refusal.missing, disproved: gate.refusal.disproved },
        { status: 422 },
      );
    }

    const service = await getAgentRunService();
    const record = await service.start({
      mode: mode as AgentRunMode,
      // Spread rather than passed as `undefined`, so a body that named no workflow
      // reaches the store exactly as one written before the field did, and the
      // store's own default is the single place the answer is decided.
      ...(workflowType === undefined ? {} : { workflowType: workflowType as AgentRunWorkflowType }),
      // Spread for the same reason, and it matters more here: the store's `false` is
      // the single place "nobody asked" is turned into an answer.
      ...(autoExecute === undefined ? {} : { autoExecute }),
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

    // The PERSISTED values are echoed, never the request's: a caller that omitted a
    // workflow type learns which one its run actually opened as.
    return NextResponse.json(
      {
        runId: record.runId,
        status: record.status,
        mode: record.mode,
        workflowType: record.workflowType,
        autoExecute: record.autoExecute,
      },
      { status: 202 },
    );
  } catch (error) {
    return createErrorResponse(error, { route: "api/agent/runs" });
  }
}
