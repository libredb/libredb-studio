/**
 * The durable ledger one agent run is made of (#329, epic #325).
 *
 * A run has no mutable row anywhere: it IS its append-only ledger, and the
 * `AgentRunRecord` a caller reads is a fold over that ledger. Two consequences
 * are the whole reason for the shape:
 *
 *  - A restarted process reads back exactly what the previous one wrote, because
 *    there is no in-memory state to lose and nothing to reconcile. Status,
 *    history, which steps settled and whether a cancellation is pending are all
 *    derived from the same ordered entries.
 *  - A tool invocation can be recorded BEFORE its effect. That ordering is what
 *    makes "no tool execution is performed twice" provable after a crash: a step
 *    whose invocation is on disk is never re-performed, even when its outcome
 *    never made it there. The run service owns that rule; this module owns the
 *    durability it rests on.
 *
 * **The substrate is the durable backend T1 selects**, reached through the four
 * stream methods every sanctioned world implements (`AgentLedgerWorld`). Nothing
 * here knows which world it has: the zero-config local backend and the opt-in
 * multi-replica Postgres one satisfy the same seam, so the ledger inherits
 * whichever durability the operator configured instead of introducing a second
 * storage mechanism next to it.
 *
 * Three deliberate boundaries, each of which a reader would otherwise have to
 * infer:
 *
 *  - **This module enforces one lifecycle boundary, and only one.** `append`
 *    refuses once the run's stream has been closed in this process
 *    (`RUN_ALREADY_CLOSED`), because the backend reports success for a write to a
 *    closed stream while `read` never returns the entry — silent loss, which is the
 *    worse failure mode and the one this guard exists to make loud. Everything
 *    else stays the run service's: whether the run exists, whether it is terminal,
 *    and whether it is allowed to emit a given event are all decided there, from
 *    the view it reads before every operation, and keeping them out of here means
 *    one round trip per append rather than two. The remaining cost of the split is
 *    real and measured rather than assumed: appending to a run that was never
 *    opened produces a headerless ledger, which every later read then refuses.
 *  - **Opening a run is read-then-append with no fencing.** Two concurrent opens
 *    on one caller-supplied id therefore write two headers, and a second header is
 *    permanent corruption to the fold (below) rather than a race one side wins.
 *    Run creation has to be serialized by its caller; `docs/BACKLOG.md` B5 records
 *    that constraint and what would lift it.
 *  - **Every entry passes `assertPersistableState` before it is written**, so the
 *    inertness rule T2 defined is enforced at the only place that can enforce it —
 *    the write. A refusal there is a refusal to persist: nothing is written.
 *    Per T2, a non-`AgentStateError` throw from the guard (a genuine stack
 *    exhaustion) is a legitimate refusal channel and is deliberately not caught.
 *  - **A run id may not contain `-`.** That looks like fussiness and is not: the
 *    backend selects a stream's chunk files by the prefix `<streamName>-`, so with
 *    dashes allowed, run `a`'s ledger would also read run `a-b`'s entries — one
 *    run silently reading another's history. Verified against the installed
 *    backend, and pinned by a test. With `-` excluded from the charset, no run's
 *    stream name can be a prefix of another's chunk file, because a match would
 *    require the other id to contain the delimiter. The parser re-checks the
 *    header's own run id as a second line of defence.
 */

import { randomUUID } from "node:crypto";
import { getAgentRuntimeConfig } from "./config";
import { assertPersistableState } from "./state-guard";
import {
  type AgentThreadHeader,
  type AgentRunActor,
  type AgentRunEvent,
  type AgentRunMode,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentRunWorkflowReading,
  type AgentRunWorkflowSource,
  type AgentRunWorkflowType,
  DEFAULT_AGENT_WORKFLOW_READING,
  DEFAULT_AGENT_WORKFLOW_SOURCE,
  DEFAULT_AGENT_WORKFLOW_TYPE,
  AgentToolProtocol,
} from "./types";

/** Stream-name prefix, so one world may carry ledgers next to other streams. */
const AGENT_LEDGER_STREAM_PREFIX = "agent-ledger-";

/**
 * Ids are `[A-Za-z0-9_]` and bounded: no `-` (see the module docblock), no `.` (the
 * backend refuses it). Exported because it is a property of the LEDGER — a run id
 * becomes a stream name — so the drive token verifies against this one definition
 * rather than against a second copy that could drift from it.
 */
export const AGENT_RUN_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Which event kinds a ledger line may carry.
 *
 * Derived from a total record rather than written as an array, because the failure
 * mode of the array was demonstrated: adding `closing-statement` to `AgentRunEvent`
 * left this list behind, and the first run to write one made its own ledger
 * unreadable — the validator rejected an event the writer had just appended. An array
 * of the union's own type does not catch that; only exhaustiveness does. Add a kind to
 * the contract now and `bun run typecheck` fails here until it is admitted.
 */
const EVENT_KINDS: ReadonlySet<string> = new Set(
  Object.keys({
    "run-started": true,
    "driver-resolved": true,
    "context-captured": true,
    "context-unavailable": true,
    "statement-drafted": true,
    "tool-invoked": true,
    "tool-completed": true,
    "tool-refused": true,
    "report-composed": true,
    "table-profiled": true,
    "plan-comparison": true,
    recommendation: true,
    "call-held": true,
    "call-declined": true,
    "model-stopped-saying": true,
    "guidance-issued": true,
    "closing-statement": true,
    "plan-statement-drafted": true,
    "answer-composed": true,
    "run-finished": true,
  } satisfies Record<AgentRunEvent["kind"], true>),
);

/**
 * What a ledger line can be. The header is written once; `event` carries one of
 * T2's semantic events verbatim; `cancellation-requested` is a control record and
 * deliberately NOT an `AgentRunEvent` — T2 pinned that union closed, and a request
 * to stop is not something that has happened to the run yet. The run is still
 * running until its own loop reaches a checkpoint and finishes it.
 */
export type AgentLedgerEntry =
  | {
      readonly kind: "run-opened";
      readonly atMs: number;
      readonly runId: string;
      readonly mode: AgentRunMode;
      /**
       * Optional, and only on the READ side: `openRun` always writes one. A header
       * written before this field existed folds to
       * `DEFAULT_AGENT_WORKFLOW_TYPE`, which `tests/unit/lib/agent/ledger-compatibility.test.ts`
       * asserts against a real pre-change ledger rather than a hand-written one.
       */
      readonly workflowType?: AgentRunWorkflowType;
      /**
       * Optional on the READ side for the same reason `workflowType` is: `openRun`
       * always writes one, and a header written before this field existed folds to
       * `DEFAULT_AGENT_WORKFLOW_SOURCE` — `"chosen"`, because there was no classifier
       * then and every such run carried a workflow its caller sent explicitly.
       */
      readonly workflowSource?: AgentRunWorkflowSource;
      /**
       * Optional on the READ side for the same reason `workflowType` is: `openRun`
       * always writes one, and a header written before this field existed folds to
       * `DEFAULT_AGENT_WORKFLOW_READING` — `"unrecorded"`, which is the only reading
       * such a header supports: it records no classifier outcome, and neither of the
       * other two answers could be read out of its absence without inventing one.
       */
      readonly workflowReading?: AgentRunWorkflowReading;
      /**
       * Optional on the READ side for the same reason `workflowType` is: `openRun`
       * always writes one, and a header written before this field existed folds to
       * `false` — which is what was true of it, since nothing then handed a
       * statement anywhere.
       */
      readonly autoExecute?: boolean;
      /**
       * Optional for the same reason, and absent folds to `native`: every run written
       * before the prose path existed asked for tools natively, because there was no
       * other way to ask.
       */
      readonly toolProtocol?: AgentToolProtocol;
      /**
       * Optional on the READ side for the same reason `workflowType` is: `openRun`
       * writes it only when a run CONTINUES a conversation, and a header written
       * before this field existed folds to a thread of one named after itself —
       * which is what was true of it, since no run belonged to a conversation then.
       */
      readonly thread?: AgentThreadHeader;
      readonly actor: AgentRunActor;
      readonly connectionId: string;
      readonly objective: string;
    }
  | { readonly kind: "event"; readonly event: AgentRunEvent }
  | { readonly kind: "cancellation-requested"; readonly atMs: number; readonly bySessionId: string };

/** The two events that settle a step: the run asked, and something answered. */
export type AgentSettledStepEvent = Extract<AgentRunEvent, { kind: "tool-completed" | "tool-refused" }>;

/**
 * Everything a run's ledger says, folded once. `record` is the product contract;
 * the rest is what the run loop needs and the record deliberately does not carry.
 */
export interface AgentRunLedgerView {
  readonly record: AgentRunRecord;
  /** The run has stopped. Terminal runs accept no further entries. */
  readonly terminal: boolean;
  /** When a stop was asked for, or `null`. Not a run event; see `AgentLedgerEntry`. */
  readonly cancellationRequestedAtMs: number | null;
  /** Step id → the event that settled it. A settled step is never re-performed. */
  readonly settledSteps: ReadonlyMap<string, AgentSettledStepEvent>;
  /**
   * Steps whose invocation is recorded with no outcome. Whether the statement ran
   * cannot be known from here — that is exactly what the write-ahead ordering
   * buys — so these are never re-performed either.
   */
  readonly unsettledStepIds: readonly string[];
}

export type AgentRunStoreReason =
  | "INVALID_RUN_ID"
  | "RUN_ALREADY_OPEN"
  | "RUN_ALREADY_CLOSED"
  | "MALFORMED_LEDGER"
  | "RUNTIME_DISABLED";

export class AgentRunStoreError extends Error {
  readonly reasonCode: AgentRunStoreReason;

  constructor(reasonCode: AgentRunStoreReason, message: string) {
    super(message);
    this.name = "AgentRunStoreError";
    this.reasonCode = reasonCode;
    Object.setPrototypeOf(this, AgentRunStoreError.prototype);
  }
}

/** One page of already-written chunks, in index order. */
interface AgentStreamChunkPage {
  readonly data: readonly { readonly data: Uint8Array }[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

/**
 * The backend seam: the four stream methods of the durable world, and nothing
 * else. Structural on purpose — the store depends on the capability, not on a
 * world class, so both sanctioned backends satisfy it and a test can substitute
 * one without a mocking framework.
 */
export interface AgentLedgerWorld {
  writeToStream(name: string, runId: string, chunk: string | Uint8Array): Promise<void>;
  getStreamChunks(
    name: string,
    runId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<AgentStreamChunkPage>;
  readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>>;
  closeStream(name: string, runId: string): Promise<void>;
}

export interface AgentRunOpenInput {
  readonly mode: AgentRunMode;
  /** Defaults to `DEFAULT_AGENT_WORKFLOW_TYPE`; see `AgentRunWorkflowType`. */
  readonly workflowType?: AgentRunWorkflowType;
  /** Defaults to `DEFAULT_AGENT_WORKFLOW_SOURCE`; see `AgentRunWorkflowSource`. */
  readonly workflowSource?: AgentRunWorkflowSource;
  /** Defaults to `DEFAULT_AGENT_WORKFLOW_READING`; see `AgentRunWorkflowReading`. */
  readonly workflowReading?: AgentRunWorkflowReading;
  /** Defaults to `false`. Decided at start and never afterwards; see `AgentRunRecord`. */
  readonly autoExecute?: boolean;
  /** Defaults to `native`. Decided by the capability gate at start; see `AgentRunRecord`. */
  readonly toolProtocol?: AgentToolProtocol;
  /** The conversation this run continues; written to the header only when it does. */
  readonly thread?: AgentThreadHeader;
  readonly actor: AgentRunActor;
  readonly connectionId: string;
  readonly objective: string;
  /**
   * Supplied when the run's identity is minted elsewhere — the workflow run id, so
   * the durable run and its ledger are one thing rather than two to correlate.
   */
  readonly runId?: string;
}

export function ledgerStreamName(runId: string): string {
  return `${AGENT_LEDGER_STREAM_PREFIX}${runId}`;
}

const invalidRunIdMessage = (raw: string): string =>
  `agent run id "${raw}" is not usable as a ledger name: expected 1-64 characters of [A-Za-z0-9_]`;

function assertRunId(runId: string): string {
  if (typeof runId !== "string" || !AGENT_RUN_ID_PATTERN.test(runId)) {
    throw new AgentRunStoreError("INVALID_RUN_ID", invalidRunIdMessage(String(runId)));
  }
  return runId;
}

function mintRunId(): string {
  // Dashes stripped, not replaced: the charset excludes them, and a fixed-width
  // id is also what makes the prefix argument in the docblock hold by length.
  return `arun_${randomUUID().replaceAll("-", "")}`;
}

function malformed(runId: string, detail: string): AgentRunStoreError {
  return new AgentRunStoreError("MALFORMED_LEDGER", `agent run "${runId}" has an unreadable ledger: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one ledger line back. The ledger is written only by this module's own
 * server code, so this is a corruption tripwire rather than a parser for hostile
 * input: it establishes that the line is one of the three known entry kinds and
 * that a header belongs to the run being read, then trusts the contract.
 */
function parseEntry(runId: string, line: string): AgentLedgerEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw malformed(runId, "a ledger line is not valid JSON");
  }
  if (!isRecord(parsed)) throw malformed(runId, "a ledger line is not an object");

  if (parsed.kind === "run-opened") {
    if (parsed.runId !== runId) throw malformed(runId, `its header names run "${String(parsed.runId)}"`);
    return parsed as unknown as AgentLedgerEntry;
  }
  if (parsed.kind === "cancellation-requested") return parsed as unknown as AgentLedgerEntry;
  if (parsed.kind === "event" && isRecord(parsed.event) && EVENT_KINDS.has(String(parsed.event.kind))) {
    return parsed as unknown as AgentLedgerEntry;
  }
  throw malformed(runId, `a ledger line carries the unknown kind "${String(parsed.kind)}"`);
}

function entryAtMs(entry: AgentLedgerEntry): number {
  return entry.kind === "event" ? entry.event.atMs : entry.atMs;
}

function nextStatus(current: AgentRunStatus, event: AgentRunEvent): AgentRunStatus {
  if (event.kind === "run-started") return "running";
  if (event.kind === "run-finished") return event.status;
  return current;
}

function foldLedger(runId: string, entries: readonly AgentLedgerEntry[]): AgentRunLedgerView {
  const [header, ...rest] = entries;
  if (!header || header.kind !== "run-opened") throw malformed(runId, "it does not open with a run header");

  const events: AgentRunEvent[] = [];
  const settledSteps = new Map<string, AgentSettledStepEvent>();
  const invokedStepIds: string[] = [];
  let status: AgentRunStatus = "queued";
  let cancellationRequestedAtMs: number | null = null;

  for (const entry of rest) {
    if (entry.kind === "cancellation-requested") {
      cancellationRequestedAtMs ??= entry.atMs;
      continue;
    }
    // A run is opened once. A second header means two writers believed they owned
    // this run, so the history cannot be trusted — refuse rather than pick one.
    if (entry.kind === "run-opened") throw malformed(runId, "it carries a second run header");
    const event = entry.event;
    events.push(event);
    status = nextStatus(status, event);
    if (event.kind === "tool-invoked") invokedStepIds.push(event.stepId);
    if (event.kind === "tool-completed" || event.kind === "tool-refused") settledSteps.set(event.stepId, event);
  }

  const lastEntry = entries[entries.length - 1];
  return {
    record: {
      runId,
      mode: header.mode,
      workflowType: header.workflowType ?? DEFAULT_AGENT_WORKFLOW_TYPE,
      workflowSource: header.workflowSource ?? DEFAULT_AGENT_WORKFLOW_SOURCE,
      workflowReading: header.workflowReading ?? DEFAULT_AGENT_WORKFLOW_READING,
      autoExecute: header.autoExecute ?? false,
      // Spread rather than defaulted: `native` is the absence, so writing it would put
      // a field on every record to say what its absence already says.
      ...(header.toolProtocol === undefined ? {} : { toolProtocol: header.toolProtocol }),
      // Defaulted rather than spread, because every run HAS a conversation: one it
      // continues, or one of its own that begins here. A header written before this
      // field folds to a thread of one named after itself, which is what was true of
      // it, and a run that starts a conversation today folds to exactly the same.
      thread:
        header.thread === undefined
          ? { threadId: runId, steps: [], text: "" }
          : { ...header.thread, threadId: header.thread.threadId ?? runId },
      status,
      actor: header.actor,
      connectionId: header.connectionId,
      objective: header.objective,
      createdAtMs: header.atMs,
      updatedAtMs: entryAtMs(lastEntry),
      events,
    },
    terminal: status !== "queued" && status !== "running",
    cancellationRequestedAtMs,
    settledSteps,
    unsettledStepIds: invokedStepIds.filter((stepId) => !settledSteps.has(stepId)),
  };
}

/**
 * Runs whose stream has been closed in THIS process. Module-level and never pruned,
 * on purpose: a run's ledger is append-only for the life of the process, so a closed
 * stream never reopens, and sharing the set across every `AgentRunStore` instance is
 * what makes a `close` on one instance refuse an `append` on another. Growth is
 * bounded by the number of runs this process opens before it restarts.
 */
const closedStreams = new Set<string>();

/**
 * The run ledger. One instance per process is enough: it holds no run state of
 * its own, only the world it writes through.
 */
export class AgentRunStore {
  private readonly world: AgentLedgerWorld;
  private readonly clock: () => number;

  constructor(options: { readonly world: AgentLedgerWorld; readonly clock?: () => number }) {
    this.world = options.world;
    // Wall-clock, injected: these timestamps are read by people in the run
    // timeline. The run DEADLINE is a different clock and lives in `deadline.ts`.
    this.clock = options.clock ?? Date.now;
  }

  /** Opens a run. The header is the ledger's first entry and is written once. */
  async openRun(input: AgentRunOpenInput): Promise<AgentRunRecord> {
    const runId = input.runId === undefined ? mintRunId() : assertRunId(input.runId);
    const entry: AgentLedgerEntry = {
      kind: "run-opened",
      atMs: this.clock(),
      runId,
      mode: input.mode,
      // Written unconditionally, unlike the optional fields on `run-finished`: every
      // run HAS a workflow type, so there is no "ending that has neither" case whose
      // bytes an omission would keep identical. The compatibility is on the read side.
      workflowType: input.workflowType ?? DEFAULT_AGENT_WORKFLOW_TYPE,
      // Written unconditionally alongside the workflow it describes: a header that
      // carried one without the other would leave a reader guessing which generation
      // of writer produced it, which is the ambiguity the read-side fold exists to
      // resolve once and for all headers.
      workflowSource: input.workflowSource ?? DEFAULT_AGENT_WORKFLOW_SOURCE,
      // And the outcome of the reading that produced it, written for the same reason:
      // a header carrying a provenance without a reading is the one generation of
      // writer whose runs a reader can say nothing certain about, and there is no
      // reason to produce another.
      workflowReading: input.workflowReading ?? DEFAULT_AGENT_WORKFLOW_READING,
      // Written unconditionally too, and for the stronger reason: an omitted setting
      // and a setting recorded as `false` must be the same run, so that no ledger
      // generation can be read as having permitted something it did not.
      autoExecute: input.autoExecute ?? false,
      ...(input.toolProtocol === undefined ? {} : { toolProtocol: input.toolProtocol }),
      // Written only when a run CONTINUES a conversation, so a ledger opened before
      // this field and one that starts its own thread are the same bytes.
      ...(input.thread === undefined ? {} : { thread: input.thread }),
      actor: input.actor,
      connectionId: input.connectionId,
      objective: input.objective,
    };
    if ((await this.read(runId)) !== null) {
      throw new AgentRunStoreError("RUN_ALREADY_OPEN", `agent run "${runId}" already has a ledger`);
    }
    await this.append(runId, entry);
    return foldLedger(runId, [entry]).record;
  }

  /** Appends one semantic event. Resolves only once the entry is durable. */
  async appendEvent(runId: string, event: AgentRunEvent): Promise<void> {
    await this.append(assertRunId(runId), { kind: "event", event });
  }

  /**
   * Records that a stop was asked for. The run keeps running until its own loop
   * reaches a checkpoint — enforcement is the run service's, and this is the
   * persisted state it enforces from, which is why it survives a restart and
   * crosses process boundaries without a shared in-memory flag.
   */
  async requestCancellation(runId: string, by: AgentRunActor): Promise<void> {
    await this.append(assertRunId(runId), {
      kind: "cancellation-requested",
      atMs: this.clock(),
      bySessionId: by.sessionId,
    });
  }

  /** The whole run, folded. `null` when no such run was ever opened. */
  async read(runId: string): Promise<AgentRunLedgerView | null> {
    const id = assertRunId(runId);
    const entries = await this.readEntries(id);
    return entries.length === 0 ? null : foldLedger(id, entries);
  }

  /**
   * The run's entries, replayed from `startIndex` and then followed live. Ends
   * when the run is closed. Cancelling the returned stream releases the
   * backend's watcher, so a disconnected reader costs nothing.
   */
  async stream(runId: string, options?: { readonly startIndex?: number }): Promise<ReadableStream<AgentLedgerEntry>> {
    const id = assertRunId(runId);
    const source = await this.world.readFromStream(ledgerStreamName(id), options?.startIndex ?? 0);
    const reader = source.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    return new ReadableStream<AgentLedgerEntry>({
      async pull(controller) {
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            controller.enqueue(parseEntry(id, line));
            return;
          }
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          buffered += decoder.decode(next.value, { stream: true });
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
  }

  /**
   * Ends the run's stream, so every live reader of its timeline completes.
   *
   * The closed marker is recorded BEFORE the backend close so that an append that
   * races this call fails loudly instead of resolving against a stream the backend
   * has already cut short — the silent-loss mode `append` cannot detect, because a
   * write to a closed stream reports success while `read` never returns the entry.
   */
  async close(runId: string): Promise<void> {
    const id = assertRunId(runId);
    closedStreams.add(id);
    await this.world.closeStream(ledgerStreamName(id), id);
  }

  private async append(runId: string, entry: AgentLedgerEntry): Promise<void> {
    if (closedStreams.has(runId)) {
      throw new AgentRunStoreError(
        "RUN_ALREADY_CLOSED",
        `agent run "${runId}" has ended; its ledger accepts no further entries`,
      );
    }
    assertPersistableState(entry, "agent.run.ledger");
    // One newline-terminated entry per write. Framing is on newlines rather than
    // on chunk boundaries because a backend is free to coalesce or split chunks;
    // JSON escapes any newline inside the payload, so the framing is unambiguous.
    await this.world.writeToStream(ledgerStreamName(runId), runId, `${JSON.stringify(entry)}\n`);
  }

  private async readEntries(runId: string): Promise<readonly AgentLedgerEntry[]> {
    const name = ledgerStreamName(runId);
    const chunks: Uint8Array[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.world.getStreamChunks(name, runId, cursor === undefined ? {} : { cursor });
      for (const chunk of page.data) chunks.push(chunk.data);
      cursor = page.hasMore && page.cursor !== null ? page.cursor : undefined;
    } while (cursor !== undefined);

    // Decoded once over the concatenation: a multi-byte character may straddle a
    // chunk boundary, so per-chunk decoding would corrupt an objective written in
    // any non-ASCII script.
    const decoder = new TextDecoder();
    const text = chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => parseEntry(runId, line));
  }
}

/**
 * The world the agent runs on: the backend T1 resolved from
 * `WORKFLOW_TARGET_WORLD`, reached through the SDK's own resolution so the
 * ledger, the queue and the workflow runtime all share one instance.
 *
 * Refuses while the runtime is unavailable — no model configured, or the operator
 * switched it off. Nothing may build a world for a server that has no agent, and
 * the import is dynamic (mirroring
 * `src/lib/llm/factory.ts` and `model-adapter.ts`) so the runtime stays out of
 * the static module graph of anything that merely imports this file.
 */
export async function resolveAgentLedgerWorld(): Promise<AgentLedgerWorld> {
  const config = getAgentRuntimeConfig();
  if (!config.enabled) {
    throw new AgentRunStoreError("RUNTIME_DISABLED", "the agent runtime is disabled, so no durable backend is built");
  }
  const { getWorld } = await import("workflow/runtime");
  return getWorld();
}
