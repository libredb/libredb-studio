import { NextResponse } from "next/server";
import { accessAgentRun } from "@/lib/api/agent-run-access";
import { createErrorResponse } from "@/lib/api/errors";

/**
 * One run: what it is doing, and asking it to stop (#329 T9).
 *
 * Both verbs answer from the durable ledger rather than from anything this process
 * remembers, so a run started by a process that has since died reports the same
 * thing here as it does to the loop that resumes it.
 */

type RunParams = { params: Promise<{ runId: string }> };

export async function GET(req: Request, { params }: RunParams) {
  const { runId } = await params;
  const access = await accessAgentRun({ route: "GET /api/agent/runs/[runId]", request: req, runId });
  if ("response" in access) return access.response;

  return NextResponse.json(access.report);
}

/**
 * Asks the run to stop. What this does NOT do is stop it here: cancellation is
 * enforced by the run's own loop at its next checkpoint, which is the only place a
 * run's budget and artifacts can be released with nothing in flight. A queued run
 * that no loop has picked up ends immediately, because it has no checkpoint to
 * reach.
 */
export async function DELETE(req: Request, { params }: RunParams) {
  const { runId } = await params;
  const access = await accessAgentRun({ route: "DELETE /api/agent/runs/[runId]", request: req, runId });
  if ("response" in access) return access.response;

  try {
    const actor = access.report.record.actor;
    return NextResponse.json(await access.service.cancel(runId, actor));
  } catch (error) {
    return createErrorResponse(error, { route: "api/agent/runs/[runId]" });
  }
}
