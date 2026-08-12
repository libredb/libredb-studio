import { NextResponse } from "next/server";
import { readAgentArtifact } from "@/lib/agent/runtime";
import type { AgentRunEvent } from "@/lib/agent/types";
import { accessAgentRun } from "@/lib/api/agent-run-access";

/**
 * One artifact's rows, for the surfaces that already render rows (#329 T11).
 *
 * The rail shows what a run cited; a user who asks to SEE a cited result gets it
 * here, and the bottom panel's existing grid and explain view render it. Nothing new
 * renders results, so there is one grid in this app and one place its behaviour lives.
 *
 * Two things this route refuses to do:
 *
 *  - **It never asks the artifact store first.** That store is process-wide and holds
 *    every live run's results, keyed by an audit correlation id. The run's own ledger
 *    is what decides whether an id belongs to it, so a caller naming their own run and
 *    somebody else's correlation id gets the same answer as for an id that never
 *    existed. `accessAgentRun` has already established that the run is this session's.
 *  - **It does not pretend a released result is a missing one.** Results live in
 *    process memory and are released when the run ends (`releaseExecutionRun`), so a
 *    finished run's rows are legitimately gone — and so are the rows of a run driven
 *    by another replica. That is reported as its own outcome, because a user reading a
 *    report needs to tell "this citation was never real" from "these rows are no
 *    longer held".
 */

type ArtifactParams = { params: Promise<{ runId: string; correlationId: string }> };

export async function GET(req: Request, { params }: ArtifactParams) {
  const { runId, correlationId } = await params;
  const access = await accessAgentRun({
    route: "GET /api/agent/runs/[runId]/artifacts/[correlationId]",
    request: req,
    runId,
  });
  if ("response" in access) return access.response;

  const recorded = access.report.record.events.find(
    (event): event is Extract<AgentRunEvent, { kind: "tool-completed" }> =>
      event.kind === "tool-completed" && event.artifact.correlationId === correlationId,
  );
  if (recorded === undefined) {
    return NextResponse.json({ error: "No such artifact" }, { status: 404 });
  }

  const held = readAgentArtifact(correlationId, Date.now());
  if (held === undefined || held.runId !== runId) {
    return NextResponse.json(
      {
        error: "This result is no longer held: a run's results are released when it ends.",
        reason: "released",
      },
      { status: 410 },
    );
  }

  return NextResponse.json({
    runId,
    correlationId,
    // The registry-resolved operation id, from the ledger entry rather than from the
    // in-memory copy: the ledger is the record that outlives the process.
    operationId: recorded.artifact.operationId,
    // The rows and nothing beside them: the ledger's `summary` describes the same
    // result the rows already carry, and two statements of one fact are two things
    // a reader could find disagreeing (the rule T2 states for the run record).
    result: held.value,
  });
}
