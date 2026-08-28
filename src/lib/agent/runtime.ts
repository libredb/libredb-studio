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
import { LLMAuthError, LLMError, LLMRateLimitError } from "@/lib/llm/types";
import { type ExecutionProfileDenyCode, ExecutionProfileError } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import type { QueryResult } from "@/lib/types";
import { AgentRunDeadline } from "./deadline";
import { AGENT_WORKFLOW_BUDGETS } from "./execution-policy";
import { type AgentInvestigationResult, runInvestigation } from "./investigation";
import { createAgentModel } from "./model-adapter";
import { AgentRepairLedger } from "./repair-ledger";
import { AgentRunService, AgentRunServiceError } from "./run-service";
import { AgentRunStore, resolveAgentLedgerWorld } from "./run-store";
import type { AgentRunFailureReason } from "./types";

/**
 * How long a run's results stay readable. Sized against the run deadline rather than
 * independently: an artifact that expired while its own run was still allowed to cite
 * it would turn a verified claim into a dead reference, so the TTL is a comfortable
 * multiple of the longest a run may live.
 *
 * The LONGEST deadline any workflow may take, not one workflow's — the store is
 * process-wide and holds artifacts from every workflow at once, so a TTL derived from
 * a shorter row would expire a `data-analysis` run's earliest evidence while
 * that run was still going. A workflow with a shorter deadline simply gets more
 * headroom than the multiple promises.
 */
const AGENT_ARTIFACT_TTL_MS =
  Math.max(...Object.values(AGENT_WORKFLOW_BUDGETS).map((budget) => budget.runDeadlineMs)) * 4;

/**
 * The entry cap of the process-wide artifact store, computed rather than picked:
 * `45 statements × 4 runs = 180`. 45 is the largest per-workflow statement
 * ceiling the frozen decision table admits (`database-assessment`); 4 is the
 * number of runs this single agent process is assumed to carry at once.
 *
 * What that product bounds is FOUR DRIVES, not four runs, and the distinction was
 * stated wrongly here until #373: this comment said "a run cannot produce more
 * artifacts than it is allowed statements", which is not true of a run. Every
 * ceiling in `AGENT_WORKFLOW_BUDGETS` is per drive (`docs/BACKLOG.md` B6) — the
 * budget tracker is built by the process that drives a run — while a resumed run
 * keeps its `runId` and its artifacts are keyed by it. So a run that is driven
 * three times may hold up to three times its statement ceiling in this store,
 * and one long-lived run can pass 180 on its own.
 *
 * The behaviour when it does is worth knowing rather than guessing at. The cap is
 * spent run-fairly (`ExecutionArtifactStore.put`): a store at the cap evicts the
 * OLDEST ARTIFACT OF THE RUN THAT IS STORING, so a busy run cannot make "Show
 * result" fail on a quieter one. Applied to a resumed run at the cap, that same
 * rule means the run evicts its OWN earliest evidence — the results its first
 * drive read, which its report may still cite. Nothing about the ledger is wrong
 * afterwards: the claim and its citation are durable, and the artifact route
 * already answers "the rows are not here" for the run-ended and TTL-expired cases.
 * This just adds a third way to reach that answer while
 * the run is still live. Recorded as `docs/BACKLOG.md` B35 rather than fixed
 * here: a bound that holds ACROSS drives is the same missing mechanism B6 names,
 * and inventing a second one for artifacts alone would be a second answer to one
 * question.
 *
 * Sized for the ceiling rather than for what a policy enforces at any one moment,
 * so a statement budget lower than 45 leaves the cap correct and merely slack.
 */
export const AGENT_MAX_ARTIFACTS = 180;

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

    // Capabilities and labels are type-driven and read without connecting, the way
    // /api/db/provider-meta reads them. The live, read-only provider a statement
    // actually runs on is acquired per call through the execution-profile seam.
    // One provider for both, so a run's declared behaviour and its declared
    // vocabulary can never come from two different readings.
    //
    // So no `withOneShotTunnel` wrapper here (#457): this provider is never connected.
    // The one that runs statements comes from `acquireExecutionProfileProvider`, which
    // opens the connection's pooled tunnel itself.
    const provider = await createDatabaseProvider(connection);
    const capabilities = provider.getCapabilities();
    const labels = provider.getLabels();

    return await runInvestigation(runId, {
      service,
      model: await createAgentModel(),
      resources: {
        connection,
        capabilities,
        labels,
        registry: createCanonicalOperationRegistry(),
        scope: createTargetScope(connectionId),
        tracker: runResources().tracker,
        artifacts: runResources().artifacts,
        // The run's own workflow decides its wall clock, the same way it decides its
        // statement budget and its turn ceiling. Read from the record the ledger
        // returned, so a resumed drive is bounded by what the run was opened as.
        deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS[report.record.workflowType].runDeadlineMs),
        repairs: new AgentRepairLedger(),
        acquireProvider: acquireExecutionProfileProvider,
      },
    });
  } catch (error) {
    // A drive refused because another already owns the run is not a failure OF the
    // run: it is healthy and in flight. Recording `failed` here would end the very
    // run the first drive is still carrying, so the refusal is left to the caller
    // (the drive route answers 409) and nothing is written to the ledger.
    if (!(error instanceof AgentRunServiceError && error.reasonCode === "RUN_ALREADY_DRIVEN")) {
      await recordDriveFailure(service, runId, error);
    }
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
    await service.finish(runId, "failed", { reason });
  } catch (recordingError) {
    logger.error("Agent run failed and its ending could not be recorded", recordingError, { runId, reason });
  }
}

/**
 * The profile refusals that are about the connection's agent credential rather than
 * about the engine. Kept beside the classifier that reads them: the set exists only to
 * split one error type into the two things a user can do about it.
 */
const AGENT_CREDENTIAL_DENY_CODES: ReadonlySet<ExecutionProfileDenyCode> = new Set([
  "AGENT_CREDENTIAL_UNRESOLVABLE",
  "AGENT_CREDENTIAL_WITH_CONNECTION_STRING",
]);

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

  // An engine with no read-only profile is not a server fault, and calling it
  // `internal` sent a user to a log that could only tell them what their own
  // connection already says. Checked before the generic classes below because it is
  // the specific thing that happened.
  //
  // The reason code, not just the type: `resolveAgentCredential` raises this same
  // error on ANY engine for a credential that cannot be applied, and calling that
  // "engine unsupported" told a PostgreSQL operator something false about their
  // database while saying nothing about the credential they could fix (B47).
  if (error instanceof ExecutionProfileError) {
    return AGENT_CREDENTIAL_DENY_CODES.has(error.reasonCode) ? "agent-credential-unusable" : "engine-unsupported";
  }

  /*
    These were one label until 2026-08-12, on the reasoning that the user's next move
    is the same for all of them — look at the model settings. A live run falsified it.
    A Gemini free-tier quota (15 requests a minute) was exhausted by testing, and the
    rail told the user the provider "is not configured or could not be reached" about a
    provider that was configured and had answered seconds earlier. For a quota the next
    move is to wait a minute; for a refused key it is to fix the key; only the rest send
    anyone to the settings. The subclasses are checked before `LLMError` itself, which
    all of them extend.
  */
  if (error instanceof LLMRateLimitError) return "model-rate-limited";
  if (error instanceof LLMAuthError) return "model-unauthorized";
  if (error instanceof LLMError) return "model-unavailable";

  // Everything else, deliberately unnamed: a provider that could not be built and a
  // programming error are both "this server could not carry the run", and guessing
  // between them would put a claim on the rail that this function cannot support.
  return "internal";
}
