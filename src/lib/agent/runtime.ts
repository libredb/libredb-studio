/**
 * The composition root for an agent run (#329 T9, epic #325).
 *
 * Every other module in `src/lib/agent/` takes what it needs as a parameter, which
 * is what made them testable without a database, a model or a world. Something has
 * to actually assemble those parts on a server, and this is the one place that
 * does: the routes below `src/app/api/agent/` carry HTTP concerns only, and no
 * route builds a tool context of its own.
 *
 * Three properties are deliberate:
 *
 *  - **A run's connection is re-resolved from its persisted id, never from a
 *    request.** T2 forbids persisting a credential, so a run records a connection
 *    ID and nothing more; a drive therefore has to look the connection up again on
 *    the server. That is why an agent run requires a server-resolvable connection
 *    (`seed:…`): a connection defined only in a browser cannot be rebuilt by a
 *    process that is resuming somebody else's run, and taking one from the drive
 *    request's body would let a caller keep the id while pointing the run at a
 *    different server.
 *  - **The actor is read from the ledger, never from the caller.** `resolveConnection`
 *    is given the run's own persisted role, so a run resumed by anything at all still
 *    resolves exactly the connections its opener was allowed to see.
 *  - **Budget accounting and artifacts are process-wide and paired.** They are keyed
 *    by run id and released together when a run ends (`releaseExecutionRun`), so they
 *    have to outlive the request that started the run and be the SAME pair the next
 *    drive of that run sees.
 */

import { createDatabaseProvider } from "@/lib/db";
import { acquireExecutionProfileProvider } from "@/lib/db/factory";
import { type ExecutionArtifact, ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { LLMError } from "@/lib/llm/types";
import { logger } from "@/lib/logger";
import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import type { QueryResult } from "@/lib/types";
import { AgentRunDeadline } from "./deadline";
import { AGENT_RUN_DEADLINE_MS } from "./execution-policy";
import { type AgentInvestigationResult, runInvestigation } from "./investigation";
import { createAgentModel } from "./model-adapter";
import { AgentRepairLedger } from "./repair-ledger";
import { AgentRunService, AgentRunServiceError } from "./run-service";
import { AgentRunStore, resolveAgentLedgerWorld } from "./run-store";
import type { AgentRunFailureReason } from "./types";

/**
 * How long a run's results stay readable, and how many it may hold at once. Sized
 * against the run deadline rather than independently: an artifact that expired while
 * its own run was still allowed to cite it would turn a verified claim into a dead
 * reference, so the TTL is a comfortable multiple of the longest a run may live.
 */
const AGENT_ARTIFACT_TTL_MS = AGENT_RUN_DEADLINE_MS * 4;
const AGENT_MAX_ARTIFACTS = 64;

/**
 * The process-wide pair. Lazily built so that merely importing this module — which
 * a route does at build time — allocates nothing while the runtime is off.
 */
let processResources: { tracker: ExecutionBudgetTracker; artifacts: ExecutionArtifactStore<QueryResult> } | null = null;

function runResources(): { tracker: ExecutionBudgetTracker; artifacts: ExecutionArtifactStore<QueryResult> } {
  processResources ??= {
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({
      ttlMs: AGENT_ARTIFACT_TTL_MS,
      maxArtifacts: AGENT_MAX_ARTIFACTS,
    }),
  };
  return processResources;
}

/**
 * One result this process still holds, or undefined (#329 T11).
 *
 * Undefined covers three states that are one answer to a caller: released with its
 * run, expired by the TTL, or produced by a process that is not this one. All three
 * mean the same thing — the rows are not here — and none of them is an error, which
 * is why the route that surfaces this reports it as its own outcome rather than as a
 * failure. `runId` is on the returned artifact so the caller can check the result it
 * gets back belongs to the run it asked about; this store is process-wide.
 */
export function readAgentArtifact(correlationId: string, nowMs: number): ExecutionArtifact<QueryResult> | undefined {
  return runResources().artifacts.get(correlationId, nowMs);
}

/**
 * The run service, over the durable backend T1 selected.
 *
 * @throws AgentRunStoreError with `RUNTIME_DISABLED` while the agent flag is off,
 *         which is the default. Routes check the flag first and answer 404, so
 *         reaching this throw means the flag changed under a live request.
 */
export async function getAgentRunService(): Promise<AgentRunService> {
  const world = await resolveAgentLedgerWorld();
  return new AgentRunService({ store: new AgentRunStore({ world }), resources: runResources() });
}

/**
 * Drives one run to its conclusion: start it if it is queued, resume it if a
 * previous process left it running.
 *
 * Called two ways, and both must behave identically — in-process right after the
 * run is opened, and from the authenticated drive callback when the durable
 * transport asks for the run to be picked up again. Which one is driving is not
 * something the run may observe: everything it needs is re-derived from the ledger.
 *
 * @throws AgentRunServiceError when the run does not exist or has already ended.
 * @throws SeedConnectionError when the run's connection is no longer resolvable —
 *         it was removed, or the actor's role no longer reaches it.
 */
export async function driveAgentRun(runId: string): Promise<AgentInvestigationResult> {
  const service = await getAgentRunService();
  const report = await service.status(runId);
  if (report === null) {
    // Deliberately outside the recording below: a run that does not exist has no
    // ledger to record a failure on, and creating one would manufacture the very
    // record whose absence is being reported.
    throw new AgentRunServiceError("RUN_NOT_FOUND", `agent run "${runId}" does not exist`);
  }

  try {
    const { actor, connectionId } = report.record;
    // The persisted actor is the sole authority: the role that decides which managed
    // connections are visible is the one recorded when the run was opened.
    const connection = await resolveConnection({ connectionId }, { role: actor.role, username: actor.sessionId });

    // Capabilities are type-driven and read without connecting, the way
    // /api/db/provider-meta reads them. The live, read-only provider a statement
    // actually runs on is acquired per call through the execution-profile seam.
    const capabilities = (await createDatabaseProvider(connection)).getCapabilities();

    return await runInvestigation(runId, {
      service,
      model: await createAgentModel(),
      resources: {
        connection,
        capabilities,
        registry: createCanonicalOperationRegistry(),
        scope: createTargetScope(connectionId),
        tracker: runResources().tracker,
        artifacts: runResources().artifacts,
        deadline: new AgentRunDeadline(AGENT_RUN_DEADLINE_MS),
        repairs: new AgentRepairLedger(),
        acquireProvider: acquireExecutionProfileProvider,
      },
    });
  } catch (error) {
    await recordDriveFailure(service, runId, error);
    throw error;
  }
}

/**
 * Writes the ending a dead drive owes the run, without ever replacing the reason
 * the caller needs to see.
 *
 * `runInvestigation` ends a run it entered, so this covers the window before and
 * around it: resolving the connection, reading capabilities, building the model.
 * A throw there used to unwind past the ledger completely, leaving a run at
 * `queued` with an empty timeline whose reason existed only in the server log —
 * and with no drive producer yet (`docs/BACKLOG.md` B9), nothing would return to it.
 *
 * Every failure of the recording itself is swallowed, on purpose. The run may have
 * ended between the throw and this call, or have an execution still in flight; both
 * make `finish` throw, and neither is what the caller asked about. Losing the
 * original error to a bookkeeping error would trade a diagnosable failure for a
 * confusing one.
 */
async function recordDriveFailure(service: AgentRunService, runId: string, error: unknown): Promise<void> {
  const reason = classifyDriveFailure(error);
  try {
    await service.finish(runId, "failed", reason);
  } catch (recordingError) {
    logger.error("Agent run failed and its ending could not be recorded", recordingError, { runId, reason });
  }
}

/**
 * Chooses the label a user sees from the error's TYPE.
 *
 * Never from its message: that text comes from a model provider, a driver or a
 * connection resolver, and none of them promise to keep a key, a host name or an
 * internal path out of it. The message goes to the log; only the label crosses to
 * the browser.
 */
function classifyDriveFailure(error: unknown): AgentRunFailureReason {
  // `instanceof` rather than the marker checks `mapAgentModelError` needs: both of
  // these are this repository's own classes, so there is one copy of each in the
  // bundle. The SDK's errors are the ones that arrive in duplicate.
  if (error instanceof SeedConnectionError) return "connection-unresolvable";

  // Every LLM failure reads as one label because the user's next move is the same
  // for all of them — look at the model settings. A rate limit and a refused key
  // differ to an operator, who has the logged message, not to the person deciding
  // whether to start another run.
  if (error instanceof LLMError) return "model-unavailable";

  // Everything else, deliberately unnamed: a provider that could not be built and a
  // programming error are both "this server could not carry the run", and guessing
  // between them would put a claim on the rail that this function cannot support.
  return "internal";
}
