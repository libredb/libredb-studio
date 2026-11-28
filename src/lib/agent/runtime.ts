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
 *  - **The actor is read from the ledger, never from the caller.** `resolveServedConnection`
 *    is given the run's own persisted role, so a run resumed by anything at all still
 *    resolves exactly the connections its opener was allowed to see.
 *  - **Budget accounting and artifacts are process-wide and paired.** They are keyed
 *    by run id and released together when a run ends (`releaseExecutionRun`), so they
 *    have to outlive the request that started the run and be the SAME pair the next
 *    drive of that run sees.
 */

import { acquireExecutionProfileProvider, executionContextFor } from "@/lib/db/factory";
import { metadataMonitoringTarget, metadataTreeTarget } from "@/lib/api/editor-provider";
import {
  type EngineConnection,
  type EngineRecord,
  legacyConnection,
  legacyProviderType,
} from "@/lib/db/server-catalog";
import { catalogSessionConnection } from "@/lib/db/catalog-scope";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { type ExecutionArtifact, ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { connectionTextScrub, type ProviderTextScrub, withholdProviderError } from "@/lib/db/operations/provider-text";
import { LLMAuthError, LLMError, LLMRateLimitError } from "@/lib/llm/types";
import {
  type ExecutionProfileDenyCode,
  ExecutionProfileError,
  StudioProfileRefusal,
  UnknownProviderError,
} from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import { resolveServedConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import type { QueryResult } from "@/lib/types";
import { statementSessionRefusal } from "./agent-manifest";
import { AgentRunDeadline } from "./deadline";
import { agentEngineDeclarations } from "./engine-view";
import { deriveDriveCeilings } from "./drive-budget";
import { AGENT_WORKFLOW_BUDGETS } from "./execution-policy";
import { type AgentInvestigationResult, runInvestigation } from "./investigation";
import { createAgentModel } from "./model-adapter";
import { AgentRepairLedger } from "./repair-ledger";
import { AgentRunService, AgentRunServiceError } from "./run-service";
import { AgentRunStore, resolveAgentLedgerWorld } from "./run-store";
import { AGENT_WORKFLOW_SENDS_STATEMENTS, type AgentRunFailureReason } from "./types";

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
 * artifacts than it is allowed statements", which is not true of a run. A resumed
 * drive's statement, elapsed-time and artifact ceilings are now derived from the
 * run's own ledger rather than handed to it fresh (#999), so a run driven three
 * times no longer triples its statement budget or evicts the evidence an earlier
 * drive cited. One ceiling is still per drive — the repair ledger is rebuilt by
 * each drive (backlog B6) — so repair attempts do start over on resume.
 *
 * The behaviour at the cap is worth knowing rather than guessing at. The cap is
 * spent run-fairly (`ExecutionArtifactStore.put`): a store at the cap evicts the
 * OLDEST ARTIFACT OF THE RUN THAT IS STORING, so a busy run cannot make "Show
 * result" fail on a quieter one. The artifact allowance a resumed drive receives
 * is derived the same way (#999), so a long-lived run no longer evicts its own
 * earliest evidence while it is still live.
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
 * How a drive ended for a caller that answers a body: the run's result, or the failure that ended it after the run's
 * connection resolved, as it was raised, beside the scrub of that connection. The outcome holds the scrub's forms, so
 * it is never logged or spread into a log context; the failure is answered or logged only through the scrub.
 */
export type AgentDriveOutcome =
  | { readonly kind: "finished"; readonly result: AgentInvestigationResult }
  | { readonly kind: "failed"; readonly error: unknown; readonly scrub: ProviderTextScrub };

/**
 * Drives one run to its conclusion, for the callers that only log a failure (the start, unpause and resume paths):
 * the result of `driveAgentRunOutcome`, or its failure withheld with the run's scrub, so a log line never holds a
 * credential of the run's connection.
 *
 * @throws what `driveAgentRunOutcome` throws, and a failure it answers, withheld (`withholdProviderError`).
 */
export async function driveAgentRun(runId: string): Promise<AgentInvestigationResult> {
  const outcome = await driveAgentRunOutcome(runId);
  if (outcome.kind === "finished") return outcome.result;
  throw withholdProviderError(outcome.scrub, outcome.error);
}

/**
 * Drives one run to its conclusion: start it if it is queued, resume it if a
 * previous process left it running. For the drive route, which answers a failure with its own class: a failure after
 * the run's connection resolved is answered as the `failed` outcome, recorded on the run first.
 *
 * Called two ways, and both must behave identically — in-process right after the
 * run is opened, and from the authenticated drive callback when the durable
 * transport asks for the run to be picked up again. Which one is driving is not
 * something the run may observe: everything it needs is re-derived from the ledger.
 *
 * @throws AgentRunServiceError when the run does not exist or has already ended.
 * @throws AgentRunUnavailableError when the run's ledger names a statement language
 *         or goal rule this build does not have, before anything is resolved or
 *         recorded: the store refuses the read, which is this function's first step.
 * @throws SeedConnectionError when the run's connection is no longer resolvable —
 *         it was removed, or the actor's role no longer reaches it, or the run reads a
 *         database (`catalog`) and its engine's record now offers no catalog session, a
 *         provider package serving the engine the run was recorded on.
 */
export async function driveAgentRunOutcome(runId: string): Promise<AgentDriveOutcome> {
  const service = await getAgentRunService();
  const report = await service.status(runId);
  if (report === null) {
    // Deliberately outside the recording below: a run that does not exist has no
    // ledger to record a failure on, and creating one would manufacture the very
    // record whose absence is being reported.
    throw new AgentRunServiceError("RUN_NOT_FOUND", `agent run "${runId}" does not exist`);
  }

  const { actor, connectionId, catalog } = report.record;
  let connection: EngineConnection;
  let engine: EngineRecord;
  try {
    // The persisted actor is the sole authority: the role that decides which managed
    // connections are visible is the one recorded when the run was opened. The served resolve answers the record of
    // the connection's engine too, a legacy engine's or a provider package's.
    const resolved = await resolveServedConnection({ connectionId }, { role: actor.role, username: actor.sessionId });
    engine = resolved.engine;
    // On a server-level connection the run reads the one database it opened on (#1530). A session
    // in that database IS the connection naming it, so from here on this is a single-database run. A run recorded with
    // a database on an engine whose record now offers no catalog session (a provider package serves the engine it was
    // recorded on) has no such session, so its connection no longer resolves, recorded as a removed one is.
    if (catalog !== undefined && !engine.offers.catalog) {
      throw new SeedConnectionError(
        `This run reads the database "${catalog}" of connection "${connectionId}", and its engine, ${engine.displayName}, offers no catalog session in this LibreDB Studio, so the run's connection no longer resolves.`,
        409,
      );
    }
    connection =
      catalog === undefined
        ? resolved.connection
        : catalogSessionConnection(legacyConnection(engine, resolved.connection), catalog);
  } catch (error) {
    await recordUnlessDrivenElsewhere(service, runId, error);
    throw error;
  }

  // From here a provider may be built, so a failure leaves the drive beside core's scrub of the run's connection, for
  // the callers' log lines and error responses, which do not hold the connection. The ledger still records the
  // failure from the original error, by its class and code. The scrub covers every provider of the
  // connection ("any"): the capability read below is built from the connection's own credential, the statement
  // providers from the agent's, and a provider package's session opens with the connection's own credential.
  const scrub = connectionTextScrub(connection, legacyProviderType(engine), "any");
  try {
    // An agent-mode run whose workflow sends statements on an engine whose record offers no execution profiles (a
    // provider package's) is refused by name before its first model turn and before anything opens: agent mode opens no
    // read-only statement session through a package yet, and the start route refuses such a run before it exists, so
    // only a run recorded before is refused here. Recorded `engine-unsupported` (`PROFILE_REFUSAL_REASON`).
    if (
      report.record.mode === "agent" &&
      AGENT_WORKFLOW_SENDS_STATEMENTS[report.record.workflowType] &&
      !engine.offers.executionProfiles
    ) {
      throw new StudioProfileRefusal(statementSessionRefusal(engine.displayName), "PROFILE_UNSUPPORTED_BY_PROVIDER");
    }

    // The engine's capabilities and labels are read from its record without connecting
    // (`agentEngineDeclarations`): a legacy engine's are its provider's own, read the way
    // /api/db/provider-meta reads them, and a provider package's engine's are its admitted
    // declaration's. The live, read-only provider a statement actually runs on is acquired
    // per call through the execution-profile seam. One reading for both, so a run's declared
    // behaviour and its declared vocabulary can never come from two different readings.
    //
    // So no `withOneShotTunnel` wrapper here (#457): `readProviderDeclarations` builds the provider
    // without connecting it or opening its tunnel, and hands back data (FND-2 slice 5).
    // The one that runs statements comes from `acquireExecutionProfileProvider`, which
    // opens the connection's pooled tunnel itself.
    //
    // Built under the agent-mode context and never as an editor handle: every profile a run acquires opens read-only,
    // and a provider may declare less on such a handle (Sparkplug declares no tree, since every level of it is a
    // withheld id), so the grounding walk lists only what the handle it acquires will answer. The operations context
    // sends no statement, so no provider proves a statement boundary for a provider that is never connected. It carries
    // the editor posture of the run's persisted actor, as the acquirer below does, so a connection that posture denies
    // file access is refused here, before Studio reads the path it names, and one it grants is built.
    const { capabilities, labels } = await agentEngineDeclarations(
      engine,
      connection,
      executionContextFor("agent-operations", editorExecutionContext(actor, connection)),
    );

    // The ceilings a drive begins with are folded from the run's ledger, so a
    // resumed drive inherits the spend its earlier drives recorded rather than
    // starting each ceiling again.
    const ceilings = deriveDriveCeilings(report.record, Date.now());
    runResources().tracker.seedUsage(runId, {
      executedStatements: ceilings.executedStatements,
      totalElapsedMs: ceilings.executedMs,
    });
    runResources().artifacts.setRunAllowance(runId, ceilings.artifactAllowance);

    const result = await runInvestigation(runId, {
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
        deadline: new AgentRunDeadline(ceilings.deadlineMs),
        repairs: new AgentRepairLedger(),
        // Told the editor posture the run's persisted actor gets on this connection (non-admin DuckDB file access), which
        // decides whether a SQLite handle opens at all, keys the profiled cache, and picks which open single-writer
        // handle an operations acquisition may borrow.
        acquireProvider: (target, profile) =>
          acquireExecutionProfileProvider(
            legacyConnection(engine, target),
            profile,
            {},
            editorExecutionContext(actor, target),
          ),
        // The record's metadata session under the run's persisted actor, the session the tree and monitoring routes
        // read; the grounding walk and the curated readings open it on a provider package's engine only, whose run
        // holds no catalog (refused above where it was recorded with one).
        sessions: {
          metadataTree: () => metadataTreeTarget({ role: actor.role }, connection, engine),
          monitoring: () => metadataMonitoringTarget({ role: actor.role }, connection, engine, undefined),
        },
      },
    });
    return { kind: "finished", result };
  } catch (error) {
    await recordUnlessDrivenElsewhere(service, runId, error);
    return { kind: "failed", error, scrub };
  }
}

/**
 * Records a drive's failure on the run, unless the drive was refused because another already owns the run. That is
 * not a failure OF the run: it is healthy and in flight. Recording `failed` here would end the very run the first
 * drive is still carrying, so the refusal is left to the caller (the drive route answers 409) and nothing is written
 * to the ledger.
 */
async function recordUnlessDrivenElsewhere(service: AgentRunService, runId: string, error: unknown): Promise<void> {
  if (!(error instanceof AgentRunServiceError && error.reasonCode === "RUN_ALREADY_DRIVEN")) {
    await recordDriveFailure(service, runId, error);
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
 * and with no drive producer yet (backlog B9), nothing would return to it.
 *
 * Every failure of the recording itself is swallowed, on purpose. The run may have
 * ended between the throw and this call, which makes `finish` throw, and that is not
 * what the caller asked about; an execution still in flight is waited for first. Losing the
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
 * The reason a run records for each way the execution profile refuses, keyed by the
 * error's own code and never by its message. Kept beside the classifier that reads it:
 * the record exists only to split one error type into the things a user can do about it.
 *
 * Total over `ExecutionProfileDenyCode`, so a code added there does not compile until it
 * is given the reason whose sentence names its repair. Two codes share a reason only
 * where their repair is the same: the two credential faults are both the credential
 * field, and the three engine refusals are both the engine. An engine off Studio's
 * review record is one of them: until an operator grant exists, its repair is the same
 * as for an engine with no read-only statement path.
 */
const PROFILE_REFUSAL_REASON: Readonly<Record<ExecutionProfileDenyCode, AgentRunFailureReason>> = Object.freeze({
  UNSUPPORTED_PROFILE: "engine-unsupported",
  PROFILE_UNSUPPORTED_BY_PROVIDER: "engine-unsupported",
  PROFILE_ENGINE_NOT_REVIEWED: "engine-unsupported",
  PROFILE_UNSUPPORTED_TARGET: "profile-target-unsupported",
  PROFILE_PRIVILEGES_TOO_BROAD: "agent-principal-refused",
  PROFILE_PRIVILEGES_TOO_NARROW: "agent-principal-underprivileged",
  PROFILE_SERVER_UNENFORCED: "server-authorization-off",
  AGENT_CREDENTIAL_UNRESOLVABLE: "agent-credential-unusable",
  AGENT_CREDENTIAL_WITH_CONNECTION_STRING: "agent-credential-unusable",
  // The seed entry's reference, the same repair as a run whose connection no longer resolves.
  CONNECTION_SECRET_UNRESOLVABLE: "connection-unresolvable",
  // Raised by MCP alone, and the repair is the agent credential field, as for the two credential faults above.
  AGENT_CREDENTIAL_REQUIRED: "agent-credential-unusable",
  // A seed whose read roots were removed after the run opened; the repair is the seed entry's read roots.
  READ_ROOTS_REQUIRED: "read-roots-required",
  // A provider package's engine whose connection names an agent credential: the repair is the agent credential field.
  AGENT_CREDENTIAL_NOT_TAKEN: "agent-credential-unusable",
} satisfies Record<ExecutionProfileDenyCode, AgentRunFailureReason>);

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

  // A connection whose type names no provider (FND-1) is the seed entry's fault, not the
  // server's, so it is named rather than left to the `internal` branch below.
  if (error instanceof UnknownProviderError) return "provider-unknown";

  // An engine with no read-only profile is not a server fault, and calling it
  // `internal` sent a user to a log that could only tell them what their own
  // connection already says. Checked before the generic classes below because it is
  // the specific thing that happened.
  //
  // The reason code, not just the type: `resolveAgentCredential` raises this same
  // error on ANY engine for a credential that cannot be applied, and calling that
  // "engine unsupported" told a PostgreSQL operator something false about their
  // database while saying nothing about the credential they could fix (B47).
  //
  // The principal codes are the third cause, split off the same way (the SQL Server
  // work of 2026-09-18). They say the engine granted the profile and then refused the
  // USER: `sa`, which is the only SQL Server credential this repository's own
  // `database-compose.yml` ships, is refused by the profile while `libredb_agent`
  // beside it is accepted. Reported as "engine unsupported", that told an operator to
  // change engines when the fix is one CREATE LOGIN.
  //
  // A principal refused for holding too much and one refused for holding too little -
  // SQL Server's admission step needs `SHOWPLAN`, so a plain reader cannot be admitted -
  // are repaired in opposite directions, so each has its own reason and its own
  // sentence; so has a server that enforces no authorization at all, where no user is
  // the repair, and a target the profile is not measured against, where the engine is
  // not the problem. `PROFILE_REFUSAL_REASON` is the whole mapping.
  if (error instanceof ExecutionProfileError) return PROFILE_REFUSAL_REASON[error.reasonCode];

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
  if (error instanceof LLMError) {
    /*
      A run collapsed to the widest reason still says why, in the log if not in the ledger.

      `model-unavailable` is the catch-all of the three and carries nothing about WHAT the provider
      did: the ledger records the verdict and never the error behind it. Measured 2026-09-21,
      `ministral-3:3b` lost eight runs here, every one of them AFTER five to ten successful tool
      calls, and `isRetryableError` retried none - so the fault was not in the retryable class and
      widening that bound would have changed nothing. Which subclass and message it is was the only
      thing that could say what to fix, and there was no way to find out.

      An operator reading a run that died "model-unavailable" is in the same position. So the error
      is named at warn level - its class and the first 200 characters, which is what distinguishes a
      refused connection from a context overflow from a model that was pulled mid-run - while the
      reason returned to the run is unchanged.
    */
    logger.warn("LLMError mapped to model-unavailable", {
      route: "agent/runtime",
      error: error.name,
      message: error.message.slice(0, 200),
    });
    return "model-unavailable";
  }

  // Everything else, deliberately unnamed: a provider that could not be built and a
  // programming error are both "this server could not carry the run", and guessing
  // between them would put a claim on the rail that this function cannot support.
  return "internal";
}
