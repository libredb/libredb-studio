/**
 * The run service: what starts, reports, cancels, resumes and streams one agent
 * run (#329, epic #325). It is the only thing that decides a run's lifecycle, and
 * it decides it from the run's own durable ledger (`run-store.ts`) rather than
 * from anything a request body, a callback or an in-memory flag says.
 *
 * Three rules carry the milestone's durability criterion, and each is asserted
 * rather than described:
 *
 *  1. **A tool invocation is in the ledger before its effect.** `runStep` writes
 *     `tool-invoked` and waits for that write, then performs the effect. A reader
 *     — including a restarted process — therefore always sees the intent no later
 *     than the effect, never the other way around.
 *  2. **A step is performed at most once by one run loop.** A step id that already
 *     settled is replayed from the ledger; a step id whose invocation is recorded
 *     with no outcome is reported `indeterminate` and is NOT retried. That second
 *     case is the process-death window, and re-running it is precisely the
 *     duplicate execution the milestone forbids. What the run loop may do is draft
 *     a new step; what it may not do is repeat this one. The qualifier is real and
 *     not modesty: the check is read-then-append with no compare-and-append
 *     fencing, so TWO loops driving one run concurrently would both read "not
 *     invoked" and both execute. Nothing in this repository enforces single
 *     ownership of a running run — the durable backend's queue is what would, and
 *     `docs/BACKLOG.md` B5 records both the gap and what would lift it. The
 *     milestone's criterion is about a RESTART, where the dead process is gone by
 *     construction, and that case this does cover.
 *  3. **Cancellation is enforced here, not by a driver.** `cancel` records a
 *     request; the run's own loop honours it at its next step checkpoint and ends
 *     the run, releasing its budget and its artifacts together. Nothing relies on
 *     a cancel propagating out of a database driver — after the tool layer's own
 *     commit it does not (recorded in `.loop/PROGRESS.md` for T6).
 *
 * Cost, stated because it is a real trade: every operation folds the run's whole
 * ledger before acting, and the record returned after an append is re-read rather
 * than patched in memory. Both are deliberate — one fold implementation means the
 * service and a resumed process cannot disagree about a run's status, and agent
 * runs are tens of entries, not millions.
 *
 * What is NOT here, on purpose: no workflow enqueue (T7b owns the workflow that
 * drives these steps), no authorization (the persisted actor is the authority and
 * T9's routes are what check a caller against it), and no tool execution — the
 * effect is a callback, so this module reaches no database and no model.
 */

import { releaseExecutionRun } from "@/lib/db/operations/execution";
import { logger } from "@/lib/logger";
import { verifyRunGoal } from "./goal-verifier";
import type { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import type { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import type { QueryResult } from "@/lib/types";
import { AgentRunStoreError } from "./run-store";
import type { AgentLedgerEntry, AgentRunLedgerView, AgentRunStore, AgentSettledStepEvent } from "./run-store";
import type { AgentOperationId, AgentToolName } from "./tools";
import type {
  AgentArtifactReference,
  AgentThreadHeader,
  AgentRunActor,
  AgentRunEvent,
  AgentRunMode,
  AgentRunRecord,
  AgentRunFailureReason,
  AgentRunStopReason,
  AgentRunTerminalStatus,
  AgentRunWorkflowType,
  AgentToolRefusal,
  AgentToolProtocol,
} from "./types";

/**
 * How a run ended, as the two independent things it can be: `reason` says why a drive
 * died before or outside the loop, `stopReason` says how the loop itself ended. An
 * options bag rather than two positional optionals, because `finish(id, s, undefined,
 * x)` is exactly the call site that eventually passes one in the other's place.
 */
export interface AgentRunEnding {
  readonly reason?: AgentRunFailureReason;
  readonly stopReason?: AgentRunStopReason;
}

/**
 * The events a run TELLS, as opposed to the ones that happen to it. Everything
 * outside this set is written by the lifecycle methods below, which is what keeps
 * the write-ahead ordering in one place.
 */
export type AgentRunNarrativeEvent = Extract<
  AgentRunEvent,
  {
    kind:
      | "context-captured"
      // The capture that did NOT happen, which is narrative for the same reason the
      // successful one is: the drive is telling the ledger what it established, or in
      // this case what it could not (B54). Nothing was executed by a model and no step
      // was settled — the catalog read that was refused is on the audit stream under
      // its own operation id, and this entry is the run's own account of being left
      // ungrounded.
      | "context-unavailable"
      | "statement-drafted"
      | "report-composed"
      // A call the drive turned back, with what it asked for instead. It belongs here
      // for the same reason the three below do: nothing was executed and no step was
      // settled — the run is telling the ledger a decision it made, not recording an
      // effect. Without it a held call is invisible, and a reader sees a run that
      // reported once where it in fact tried, was asked for something, and tried again.
      | "call-held"
      // A ledger-only TOOL that declined, which belongs here for the same reason the hold
      // above does and closes the same gap one layer down: these tools execute nothing, so
      // a refusal from one settles no step. A database tool that declines writes
      // `tool-refused`; before this, a ledger tool that declined wrote nothing at all, and
      // a reader could not tell a call the tool sent back from a call never made.
      | "call-declined"
      // What the model said on the turn it stopped. Narrative for the same reason the two
      // above are: nothing was executed and no step settled -- the run is recording a fact
      // about its own ending, which is the largest unexplained group in the measurements.
      | "model-stopped-saying"
      // A sentence the drive said on a turn nothing was refused. Narrative like the entries
      // above: no effect ran and no step settled, and the run is recording a decision it made.
      | "guidance-issued"
      // Both reach no database and settle no step: they record what the run has
      // ALREADY established, which is exactly what a narrative entry is.
      | "plan-comparison"
      | "recommendation"
      | "table-profiled"
      // Which result IS the answer: a decision about a read already on the ledger,
      // reaching nothing and settling no step, like the three above it.
      | "answer-composed"
      | "closing-statement"
      // The plan run's own deliverable. It reaches no database and settles no step —
      // a planning model holds no tool — so it is narrative in exactly the sense the
      // entries above it are: what the run has already established, written down.
      | "plan-statement-drafted";
  }
>;

/** Distributes over the union, so each variant loses `atMs` rather than the union collapsing. */
type WithoutTimestamp<T> = T extends unknown ? Omit<T, "atMs"> : never;

/**
 * The one event `recordDriver` writes, named here so its method's parameter cannot widen.
 *
 * Extracted rather than spelled out again: the shape lives in `AgentRunEvent` with the reasoning
 * for each of its three provenance cases, and a second copy here would be a second place for it
 * to drift from the ledger it is written into.
 */
type AgentRunDriverEvent = Extract<AgentRunEvent, { kind: "driver-resolved" }>;

/**
 * A narrative entry as a CALLER states it: everything but the timestamp, which
 * the service stamps from its own clock. A caller that supplied one could date a
 * run's history from a different clock than the one every other entry uses.
 */
export type AgentRunNarrative = WithoutTimestamp<AgentRunNarrativeEvent>;

/**
 * The run-scoped resources a run holds in THIS process: its budget accounting and
 * its artifact store. Both are keyed by run id and are released together when the
 * run ends (`releaseExecutionRun`), so neither outlives the other.
 */
export interface AgentRunResources {
  readonly tracker: ExecutionBudgetTracker;
  readonly artifacts: ExecutionArtifactStore<QueryResult>;
}

export interface AgentRunStartInput {
  readonly mode: AgentRunMode;
  /** What the run is FOR. Defaults to `DEFAULT_AGENT_WORKFLOW_TYPE`. */
  readonly workflowType?: AgentRunWorkflowType;
  /** Whether the run may hand its answer to the editor to run. Defaults to `false`. */
  readonly autoExecute?: boolean;
  /** Defaults to `native`; see `AgentRunRecord.toolProtocol`. */
  readonly toolProtocol?: AgentToolProtocol;
  /** The conversation this run continues; the route derives it, the store persists it. */
  readonly thread?: AgentThreadHeader;
  readonly actor: AgentRunActor;
  readonly connectionId: string;
  /**
   * Which database that connection addresses, as `connectionIdentity` fingerprints it.
   *
   * The route supplies it because the route is what resolved the connection: this layer
   * holds an id and never the record behind it. What it buys is on the READ side — a
   * follow-up can tell that a saved connection has been re-pointed since the
   * conversation it continues was established. See `AgentRunRecord.connectionIdentity`.
   */
  readonly connectionIdentity?: string;
  readonly objective: string;
  readonly runId?: string;
}

/** What a caller may know about a run: the record, plus whether a stop is pending. */
export interface AgentRunStatusReport {
  readonly record: AgentRunRecord;
  readonly cancellationRequested: boolean;
}

export interface AgentRunResumeReport {
  readonly record: AgentRunRecord;
  /** Steps whose result the ledger already holds; replay them, do not re-run them. */
  readonly settledStepIds: readonly string[];
  /** Steps invoked without a recorded outcome. Their result is unknown and unknowable. */
  readonly indeterminateStepIds: readonly string[];
  readonly cancellationRequested: boolean;
}

/** One step of a run: the model asked for a tool, and this is which. */
export interface AgentRunInvocation {
  readonly stepId: string;
  readonly tool: AgentToolName;
  /** Present when the tool reaches the canonical operation layer. */
  readonly operationId?: AgentOperationId;
}

/**
 * How a step ended, in the vocabulary the ledger records.
 *
 * `not-attempted` is the run loop's own outcome — a spent deadline, a repair
 * ledger refusing a statement it has already failed on, a toolless mode. Nothing
 * was asked of the database, so there is no policy answer and no engine error to
 * record, and T2's event union has no variant for it: this task does not widen
 * that union to invent one. The step therefore stays unsettled in the ledger,
 * which is why it may not be retried under the same step id.
 */
export type AgentRunStepSettlement =
  | { readonly kind: "completed"; readonly artifact: AgentArtifactReference }
  | { readonly kind: "refused"; readonly refusal: AgentToolRefusal }
  | { readonly kind: "not-attempted" };

export type AgentRunStepResult =
  | { readonly kind: "performed"; readonly settlement: AgentRunStepSettlement }
  | { readonly kind: "replayed"; readonly event: AgentSettledStepEvent }
  | { readonly kind: "indeterminate"; readonly stepId: string }
  | { readonly kind: "cancelled" };

export type AgentRunServiceReason =
  | "RUN_NOT_FOUND"
  | "RUN_ALREADY_TERMINAL"
  | "RUN_NOT_RESUMABLE"
  | "RUN_NOT_STARTABLE"
  | "RUN_NOT_RUNNING"
  | "RUN_HAS_LIVE_EXECUTION"
  /** The caller's target scope is not the connection the run was opened for. */
  | "RUN_CONNECTION_MISMATCH"
  /**
   * Another drive already owns this run in THIS process. The durable ledger has no
   * compare-and-append fence, so two drives on one run would both read a step as
   * uninvoked and both execute it (`docs/BACKLOG.md` B5). This is the process-local
   * half of that fence; the cross-process half still belongs to the durable backend.
   */
  | "RUN_ALREADY_DRIVEN";

export class AgentRunServiceError extends Error {
  readonly reasonCode: AgentRunServiceReason;

  constructor(reasonCode: AgentRunServiceReason, message: string) {
    super(message);
    this.name = "AgentRunServiceError";
    this.reasonCode = reasonCode;
    Object.setPrototypeOf(this, AgentRunServiceError.prototype);
  }
}

function report(view: AgentRunLedgerView): AgentRunStatusReport {
  return { record: view.record, cancellationRequested: view.cancellationRequestedAtMs !== null };
}

/** The runs this process is currently driving. Process memory on purpose: the
 * durable ledger's queue is the cross-process owner; this closes the in-process gap. */
const activeDrives = new Set<string>();

export class AgentRunService {
  private readonly store: AgentRunStore;
  private readonly resources: AgentRunResources;
  private readonly clock: () => number;

  constructor(options: {
    readonly store: AgentRunStore;
    readonly resources: AgentRunResources;
    readonly clock?: () => number;
  }) {
    this.store = options.store;
    this.resources = options.resources;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Claims the right to drive a run in THIS process. A second drive on the same run
   * refuses rather than waits, because two drives would both pass `runStep`'s
   * read-then-append check and execute the same step twice. The caller releases in a
   * `finally`, so a drive that throws still leaves the run claimable by the next one.
   *
   * The claim has no expiry, and needs none inside one process: the drive's `finally`
   * always releases it, a single drive is bounded by the run's own deadline, and a
   * process death drops the whole set — the cross-process case belongs to the durable
   * backend's queue (`docs/BACKLOG.md` B5).
   */
  claimDrive(runId: string): void {
    if (activeDrives.has(runId)) {
      throw new AgentRunServiceError(
        "RUN_ALREADY_DRIVEN",
        `agent run "${runId}" is already being driven in this process`,
      );
    }
    activeDrives.add(runId);
  }

  /** Releases the drive claim taken by `claimDrive`. Idempotent. */
  releaseDrive(runId: string): void {
    activeDrives.delete(runId);
  }

  /**
   * Opens a run in the durable ledger, queued. Starting the workflow that drives
   * it is T7b's; a run that nothing picks up stays queued and is cancellable.
   */
  async start(input: AgentRunStartInput): Promise<AgentRunRecord> {
    return this.store.openRun(input);
  }

  /**
   * Marks a queued run as running. The mode recorded is the run's own, never a
   * caller's.
   *
   * Deliberately NOT idempotent: a second call refuses rather than doing nothing,
   * because two `run-started` entries would mean two loops believed they owned the
   * run. A resumed run needs no call at all — its ledger already reads `running` —
   * so a handler that replays this on resume should read the status first rather
   * than treat the refusal as an error.
   */
  async markRunning(runId: string): Promise<AgentRunRecord> {
    const view = await this.readOrThrow(runId);
    if (view.record.status !== "queued") {
      throw new AgentRunServiceError("RUN_NOT_STARTABLE", `agent run "${runId}" is already ${view.record.status}`);
    }
    await this.store.appendEvent(runId, { kind: "run-started", atMs: this.clock(), mode: view.record.mode });
    return (await this.readOrThrow(runId)).record;
  }

  /**
   * Records WHAT DROVE this stretch of the run: the model, and where its settings came from.
   *
   * Its own method rather than an admission to `recordEvent`, on that method's own rule. The
   * narrative type there is the access control, and this is not something the run narrated — it
   * is a lifecycle fact, the same class as `run-started`, and it is written by the drive at the
   * moment it resolves a model rather than by anything the model did.
   *
   * Per DRIVE and not per run, which is why it is not folded into `markRunning`: that fires once,
   * and a resume can pick up a different model after an operator changed the configuration and
   * restarted. Each stretch writes what it ran on, so a resumed run carries one entry per stretch
   * and a reader can see them disagree.
   *
   * Running only, like every other write here: a queued run's ledger is not open for entries and
   * a terminal one's is closed.
   */
  async recordDriver(runId: string, driver: Omit<AgentRunDriverEvent, "atMs" | "kind">): Promise<void> {
    const view = await this.readOrThrow(runId);
    if (view.record.status !== "running") {
      throw new AgentRunServiceError("RUN_NOT_RUNNING", `agent run "${runId}" is ${view.record.status}`);
    }
    // `kind` is the method's, not the caller's: this writes exactly one event, so asking a caller
    // to restate its name is a field they can only get wrong. `recordEvent` takes it because it
    // accepts many kinds and the kind is the choice being made there.
    await this.store.appendEvent(runId, { ...driver, kind: "driver-resolved", atMs: this.clock() });
  }

  /**
   * Records something the run NARRATED — the schema it captured, a statement it
   * drafted, the report it composed. Never something that happened to a tool.
   *
   * The parameter type is the whole access control: `tool-invoked`,
   * `tool-completed` and `tool-refused` belong to `runStep`, which is what orders
   * them against the effect they describe, and `run-started`/`run-finished` belong
   * to the lifecycle methods. Admitting them here would give a caller a second way
   * to write the entries the durability argument rests on, so the type refuses at
   * compile time rather than a check refusing at run time.
   *
   * A narrative entry may only be added to a RUNNING run, for the same reason a
   * step may: a terminal run's ledger is closed, and an append after `close`
   * resolves while `read` never returns it (`run-store.ts`).
   */
  async recordEvent(runId: string, narrative: AgentRunNarrative): Promise<void> {
    const view = await this.readOrThrow(runId);
    if (view.record.status !== "running") {
      throw new AgentRunServiceError("RUN_NOT_RUNNING", `agent run "${runId}" is ${view.record.status}, not running`);
    }
    await this.store.appendEvent(runId, { ...narrative, atMs: this.clock() } as AgentRunNarrativeEvent);
  }

  /** The run as it stands, or `null` when there is no such run. */
  async status(runId: string): Promise<AgentRunStatusReport | null> {
    const view = await this.store.read(runId);
    return view === null ? null : report(view);
  }

  /**
   * Asks for a run to stop.
   *
   * A run no loop has picked up is ended here and now: there is no checkpoint to
   * wait for, and leaving it queued with a pending request would be a cancel that
   * never lands. A running run gets the request recorded — its own loop is what
   * ends it, at the next step, which is the only place where the run's resources
   * can be released with nothing in flight.
   *
   * The gap that leaves, stated rather than implied: a run whose loop DIED while
   * running keeps a pending request and is not ended by anything this service
   * does. What closes it is the next drive — `runInvestigation` reads the request at
   * its own checkpoint and ends the run before asking the model anything, which is
   * asserted in `tests/isolated/agent-investigation.test.ts`. What still has to
   * arrange for a drive to happen at all is the durable backend (the local world
   * re-enqueues pending/running runs when the world starts) plus the route that
   * starts it; no module here creates a workflow run or starts a world, so that half
   * belongs to T9.
   */
  async cancel(runId: string, by: AgentRunActor): Promise<AgentRunStatusReport> {
    try {
      const view = await this.readOrThrow(runId);
      if (view.terminal) return report(view);
      if (view.record.status === "queued") {
        return report(await this.finalize(runId, "cancelled", { stopReason: "cancelled" }));
      }
      await this.store.requestCancellation(runId, by);
      return report(await this.readOrThrow(runId));
    } catch (error) {
      /*
        A run closed between the read above and the write below was ended by another
        writer, and `finalize` — the only caller of `close` — appends `run-finished`
        BEFORE it closes. So the re-read settles it: a terminal view is the answer the
        caller asked for, and returning it beats a refusal the route would turn into a
        500 for a user who pressed stop on a run that had just ended.

        The re-read is checked rather than trusted. A closed stream over a run the
        ledger does not show as ended means the cancellation was genuinely lost, and
        answering 200 on a run still queued or running would be exactly the silent loss
        `RUN_ALREADY_CLOSED` exists to make loud — so that case rethrows.
      */
      if (error instanceof AgentRunStoreError && error.reasonCode === "RUN_ALREADY_CLOSED") {
        const settled = await this.readOrThrow(runId);
        if (settled.terminal) return report(settled);
      }
      throw error;
    }
  }

  /**
   * Ends a run and releases its budget and artifacts together.
   *
   * A pending cancellation does not override the status the caller reports: if the
   * loop reached the end before it reached a checkpoint, the work did succeed, and
   * the ledger records what happened rather than what was asked for. The request
   * stays visible in the status report instead of being rewritten into the outcome.
   */
  async finish(runId: string, status: AgentRunTerminalStatus, ending: AgentRunEnding = {}): Promise<AgentRunRecord> {
    const view = await this.readOrThrow(runId);
    if (view.terminal) {
      throw new AgentRunServiceError("RUN_ALREADY_TERMINAL", `agent run "${runId}" already ${view.record.status}`);
    }
    return (await this.finalize(runId, status, ending)).record;
  }

  /**
   * What a process taking over a run needs to know: what the ledger already
   * settled, and which steps are beyond re-deriving. A resumed run re-derives
   * from this; it does not repeat work.
   */
  async resume(runId: string): Promise<AgentRunResumeReport> {
    const view = await this.readOrThrow(runId);
    if (view.terminal) {
      throw new AgentRunServiceError("RUN_NOT_RESUMABLE", `agent run "${runId}" already ${view.record.status}`);
    }
    return {
      record: view.record,
      settledStepIds: [...view.settledSteps.keys()],
      indeterminateStepIds: view.unsettledStepIds,
      cancellationRequested: view.cancellationRequestedAtMs !== null,
    };
  }

  /** The run's timeline, replayed and then followed live. */
  async stream(runId: string, options?: { readonly startIndex?: number }): Promise<ReadableStream<AgentLedgerEntry>> {
    await this.readOrThrow(runId);
    return this.store.stream(runId, options);
  }

  /**
   * Performs one step of a run, with the ledger written ahead of the effect.
   *
   * The order is the contract: checkpoint, then the durable invocation, then the
   * effect, then the outcome. `execute` is what reaches the tool layer; this
   * module never touches a database itself. An `execute` that throws leaves the
   * invocation recorded and the step unsettled — the honest record of "it was
   * asked for and we do not know what happened".
   */
  async runStep(
    runId: string,
    invocation: AgentRunInvocation,
    execute: () => Promise<AgentRunStepSettlement>,
  ): Promise<AgentRunStepResult> {
    const view = await this.readOrThrow(runId);
    if (view.terminal) {
      throw new AgentRunServiceError("RUN_ALREADY_TERMINAL", `agent run "${runId}" already ${view.record.status}`);
    }
    // A step may only run on a run that is RUNNING. Without this, "a queued run
    // has nothing in flight" would be an assumption, and `cancel` ends a queued
    // run on the spot precisely because it believes that.
    if (view.record.status !== "running") {
      throw new AgentRunServiceError("RUN_NOT_RUNNING", `agent run "${runId}" is ${view.record.status}, not running`);
    }
    if (view.cancellationRequestedAtMs !== null) {
      await this.finalize(runId, "cancelled", { stopReason: "cancelled" });
      return { kind: "cancelled" };
    }
    const settled = view.settledSteps.get(invocation.stepId);
    if (settled !== undefined) return { kind: "replayed", event: settled };
    if (view.unsettledStepIds.includes(invocation.stepId)) {
      return { kind: "indeterminate", stepId: invocation.stepId };
    }

    await this.store.appendEvent(runId, {
      kind: "tool-invoked",
      atMs: this.clock(),
      stepId: invocation.stepId,
      tool: invocation.tool,
      ...(invocation.operationId === undefined ? {} : { operationId: invocation.operationId }),
    });

    const settlement = await execute();
    const outcome = this.settlementEvent(invocation.stepId, settlement);
    if (outcome !== null) await this.store.appendEvent(runId, outcome);
    return { kind: "performed", settlement };
  }

  private settlementEvent(stepId: string, settlement: AgentRunStepSettlement): AgentSettledStepEvent | null {
    const atMs = this.clock();
    if (settlement.kind === "completed") {
      return { kind: "tool-completed", atMs, stepId, artifact: settlement.artifact };
    }
    if (settlement.kind === "refused") {
      return { kind: "tool-refused", atMs, stepId, refusal: settlement.refusal };
    }
    return null;
  }

  /**
   * Ends a run: nothing in flight, then the ledger entry, then the resources, then
   * the stream.
   *
   * The live-execution check has to come FIRST, and the reason is a state that is
   * otherwise unrecoverable. `ExecutionBudgetTracker.endRun` refuses while an
   * execution is live — correctly, since dropping live usage would reset the
   * concurrency and total-run budgets mid-flight — but it refuses AFTER this
   * method has already written `run-finished`. A run would then be terminal on
   * disk with its budget and artifacts still held, `finish` and `cancel` would
   * both refuse it as already ended, and its stream would never close, so every
   * live reader of its timeline would hang. Checking first means the refusal
   * persists nothing and the run stays finishable once the statement lands.
   *
   * The check's strength is exactly the single-writer premise and no more: it
   * reads process-local accounting before an `await`, so an execution starting
   * during that append, or one live on another replica, is invisible to it. Both
   * need a second writer on one run, which `docs/BACKLOG.md` B5 puts outside this
   * layer's contract; within one loop the reading is reliable, because
   * `execution.ts` pairs `beginExecution`/`endExecution` on the throwing path too,
   * so nothing is in flight while the loop sits at a checkpoint.
   *
   * Closing the stream sits in a `finally` for the same reason: whatever else
   * fails, a run whose ending is recorded must not leave readers waiting forever.
   */
  private async finalize(
    runId: string,
    status: AgentRunTerminalStatus,
    ending: AgentRunEnding,
  ): Promise<AgentRunLedgerView> {
    const { reason, stopReason } = ending;
    const live = this.resources.tracker.usage(runId).activeExecutions;
    if (live > 0) {
      throw new AgentRunServiceError(
        "RUN_HAS_LIVE_EXECUTION",
        `agent run "${runId}" still has ${live} execution(s) in flight and cannot be ended`,
      );
    }
    /*
      The verdict is decided BEFORE the ending is written, from the run as it will
      be: everything the run did, under the status it is about to take. That status
      is passed explicitly rather than read back, because the verifier distinguishes
      a run a user stopped from one that simply did not answer, and until this append
      lands the ledger still reads `running`.

      `run-finished` itself contributes nothing to the verdict — it is the ending, not
      part of the work — so computing it from the events before the append is not a
      simplification, it is the correct input.

      A run that never entered the loop gets NO verdict. Its status is still `queued`
      here — no `run-started` was ever appended — which is `runtime.ts`'s
      `recordDriveFailure` path: the drive died before the run could try. Calling that
      "did not answer" would read as a judgement on a run that was never given the
      chance to, so the field is omitted and the failure reason speaks alone. Found by
      review on #347.
    */
    const record = (await this.readOrThrow(runId)).record;
    const verdict = record.status === "queued" ? null : verifyRunGoal({ ...record, status });

    // Spread rather than the fields outright: an ending that has neither writes the
    // entry it always wrote, so a ledger from before these fields and one after them
    // are the same bytes for the same event.
    await this.store.appendEvent(runId, {
      kind: "run-finished",
      atMs: this.clock(),
      status,
      ...(reason === undefined ? {} : { reason }),
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(verdict === null
        ? {}
        : {
            goalVerdict: {
              outcome: verdict.outcome,
              verifier: verdict.verifier,
              // Omitted when the run answered, so the two halves cannot disagree.
              ...(verdict.unmet.length === 0 ? {} : { unmet: verdict.unmet }),
            },
          }),
    });
    try {
      releaseExecutionRun({ runId, tracker: this.resources.tracker, artifacts: this.resources.artifacts });
    } finally {
      await this.store.close(runId);
    }
    const view = await this.readOrThrow(runId);

    /*
      Whether the run ANSWERED, said where an operator actually looks — as well as on
      the ledger above, which is what a user reads.

      Here rather than in the run loop because every terminal path goes through this
      method: the loop's own `conclude`, and the cancellation checkpoint inside
      `runStep` that ends a run without returning to it. A log line at either of those
      two sites would have covered one ending and quietly missed the other.
    */
    const verdictSentence =
      verdict === null
        ? "ended before it began"
        : verdict.outcome === "answered"
          ? `answered (${verdict.verifier})`
          : `unanswered (${verdict.verifier}: ${verdict.unmet.join(", ")})`;
    logger.info(`agent run ${runId} ${verdictSentence}`, {
      runId,
      status,
      ...(stopReason === undefined ? {} : { stopReason }),
    });
    return view;
  }

  private async readOrThrow(runId: string): Promise<AgentRunLedgerView> {
    const view = await this.store.read(runId);
    if (view === null) throw new AgentRunServiceError("RUN_NOT_FOUND", `agent run "${runId}" does not exist`);
    return view;
  }
}
