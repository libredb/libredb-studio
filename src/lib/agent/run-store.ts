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
 *  - **This module enforces no lifecycle policy.** `appendEvent` does not check
 *    that the run exists, is not terminal, or is allowed to emit that event. The
 *    run service reads the view before every operation and owns those decisions;
 *    keeping them out of here means one round trip per append rather than two.
 *    Two costs of the split, both real and both measured rather than assumed:
 *    appending to a run that was never opened produces a headerless ledger, which
 *    every later read then refuses; and appending AFTER `close` resolves
 *    successfully while `read` never returns the entry, because the backend stops
 *    a snapshot at the stream's end marker. Silent loss is the worse of the two,
 *    which is why the service refuses every operation on a terminal run rather
 *    than relying on this layer to notice.
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
  type AgentRunActor,
  type AgentRunEvent,
  type AgentRunMode,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentRunWorkflowType,
  DEFAULT_AGENT_WORKFLOW_TYPE,
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
    "context-captured": true,
    "statement-drafted": true,
    "tool-invoked": true,
    "tool-completed": true,
    "tool-refused": true,
    "report-composed": true,
    "table-profiled": true,
    "plan-comparison": true,
    recommendation: true,
    "closing-statement": true,
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

export type AgentRunStoreReason = "INVALID_RUN_ID" | "RUN_ALREADY_OPEN" | "MALFORMED_LEDGER" | "RUNTIME_DISABLED";

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

  /** Ends the run's stream, so every live reader of its timeline completes. */
  async close(runId: string): Promise<void> {
    const id = assertRunId(runId);
    await this.world.closeStream(ledgerStreamName(id), id);
  }

  private async append(runId: string, entry: AgentLedgerEntry): Promise<void> {
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
 * Refuses while the runtime is disabled — the default. Nothing may build a world
 * off a flag that is off, and the import is dynamic (mirroring
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
