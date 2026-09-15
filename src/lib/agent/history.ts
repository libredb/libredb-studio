/**
 * The run-history index: one append-only stream per actor, folded into the
 * conversation list the history surface reads (#830).
 *
 * The run ledger itself has no enumeration — every stream method is addressed by
 * a run id, and nothing lists ids. The history index is the enumeration: when a
 * run finishes, the service appends ONE self-contained entry to a stream named
 * after its actor, and the listing folds that stream into conversations. It is a
 * second write next to the run ledger, deliberately — the run ledger stays the
 * authority on what a run DID, and the index is only how a user finds runs to
 * open. A listing built from the index can therefore be stale or incomplete
 * without ever contradicting the ledger: the ledger is what a reopened run reads.
 *
 * Three properties the design rests on:
 *
 *  - **The stream name is a fixed-width hash.** The world selects chunk files by
 *    prefix `<streamName>-`, so a key that is a prefix of another key would read
 *    that key's chunks too (the run-id charset rule in `run-store.ts` exists for
 *    the same reason). `sha256(sessionId)` is 64 hex characters for every input,
 *    so no two keys can be prefixes of one another and a session id of any shape
 *    — an email, an OIDC subject — reaches a safe name without a charset audit.
 *  - **Entries are inert and self-contained.** Everything the listing needs is in
 *    the entry: opening one run's ledger is not required to list it, which is
 *    what keeps the listing one stream read instead of N.
 *  - **Reading is forward-tolerant.** A line that is not a `history-finished`
 *    entry — unparseable, a future kind, or a field this build does not know how
 *    to validate — is skipped rather than fatal. The run ledger must refuse
 *    malformed lines because it is the record a resumed drive acts on; the index
 *    is a pointer list, and a pointer list that refuses to read over one bad line
 *    would take down the whole history, which the ledger's own record does not.
 */

import { createHash } from "node:crypto";

import { AGENT_HISTORY_MAX_CONVERSATIONS, AGENT_HISTORY_PAGE_DEFAULT } from "./execution-policy";
import type {
  AgentConversationStep,
  AgentConversationSummary,
  AgentRunMode,
  AgentRunTerminalStatus,
  AgentRunWorkflowType,
} from "./types";

/** Stream-name prefix, so one actor's index sits beside the run ledgers it points at. */
const AGENT_HISTORY_STREAM_PREFIX = "agent-history-";

/**
 * The stream one actor's finished runs are indexed under.
 *
 * Fixed-width hex on purpose; see the module docblock. A session id is the JWT
 * payload's username — the same value `AgentRunActor.sessionId` carries — so a
 * user's history is keyed by the one identity field that survives a re-login.
 */
export function historyStreamName(sessionId: string): string {
  return `${AGENT_HISTORY_STREAM_PREFIX}${createHash("sha256").update(sessionId).digest("hex")}`;
}

/**
 * One finished run, as the index records it.
 *
 * Written once, by `run-service.ts`'s `finalize`, which is the single path every
 * terminal run goes through. There is deliberately no `history-opened` kind: a run
 * that is still queued or running is not history, it is the rail's live timeline,
 * and listing it in both places would be two answers to "where is my run".
 */
export interface AgentHistoryEntry {
  readonly kind: "history-finished";
  readonly atMs: number;
  readonly runId: string;
  readonly sessionId: string;
  /** The conversation this run belongs to; `runId` for a thread's first step. */
  readonly threadId: string;
  readonly objective: string;
  readonly workflowType: AgentRunWorkflowType;
  readonly mode: AgentRunMode;
  readonly connectionId: string;
  readonly createdAtMs: number;
  readonly status: AgentRunTerminalStatus;
  /**
   * The goal verifier's verdict: `true` when the run answered, `false` when it
   * did not, and `null` when there is no verdict to report — a run that ended
   * before it entered the loop.
   */
  readonly answered: boolean | null;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);
const MODES: ReadonlySet<string> = new Set(["planning", "agent"]);
const WORKFLOW_TYPES: ReadonlySet<string> = new Set([
  "investigation",
  "query-optimization",
  "database-assessment",
  "operations",
  "data-analysis",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one index line back, or `null` when the line is not a usable entry.
 *
 * Narrowed rather than trusted, for the reason `use-agent-run.ts`'s wire readers
 * narrow: an index survives an upgrade, so a line written by a later build must
 * read as absent rather than as a half-read entry behind a sentence about it.
 */
export function parseHistoryEntry(line: string): AgentHistoryEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.kind !== "history-finished") return null;
  const candidate = parsed as Record<string, unknown>;

  if (
    typeof candidate.atMs !== "number" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.threadId !== "string" ||
    typeof candidate.objective !== "string" ||
    !isWorkflowType(candidate.workflowType) ||
    !isMode(candidate.mode) ||
    typeof candidate.connectionId !== "string" ||
    typeof candidate.createdAtMs !== "number" ||
    !isTerminalStatus(candidate.status) ||
    !isAnswered(candidate.answered)
  ) {
    return null;
  }

  return {
    kind: "history-finished",
    atMs: candidate.atMs,
    runId: candidate.runId,
    sessionId: candidate.sessionId,
    threadId: candidate.threadId,
    objective: candidate.objective,
    workflowType: candidate.workflowType,
    mode: candidate.mode,
    connectionId: candidate.connectionId,
    createdAtMs: candidate.createdAtMs,
    status: candidate.status,
    answered: candidate.answered,
  };
}

function isTerminalStatus(value: unknown): value is AgentRunTerminalStatus {
  return typeof value === "string" && TERMINAL_STATUSES.has(value);
}

function isMode(value: unknown): value is AgentRunMode {
  return typeof value === "string" && MODES.has(value);
}

function isWorkflowType(value: unknown): value is AgentRunWorkflowType {
  return typeof value === "string" && WORKFLOW_TYPES.has(value);
}

function isAnswered(value: unknown): value is boolean | null {
  return value === true || value === false || value === null;
}

/** The finish timestamp of a conversation, which is the timestamp of its newest step. */
function latestAtMs(summary: AgentConversationSummary): number {
  return summary.steps[summary.steps.length - 1]?.updatedAtMs ?? 0;
}

/**
 * Folds index entries into conversations, newest first.
 *
 * Entries are already in append order, so a thread's steps end up oldest first
 * with no second sort. The retention cap is a READ bound — the index stream is
 * never trimmed — so this is the only place the cap applies.
 */
export function foldHistoryEntries(
  entries: readonly AgentHistoryEntry[],
  maxConversations: number = AGENT_HISTORY_MAX_CONVERSATIONS,
): readonly AgentConversationSummary[] {
  const byThread = new Map<string, AgentConversationStep[]>();
  // One step per run, however many times the index saw that run: `finalize` is
  // the single writer, but a retried or double-driven finish could append the
  // same run twice, and the fold must collapse that into one step rather than
  // let a duplicate rewrite the conversation. A run id is the identity, so the
  // first entry wins and any later copy of the same run is ignored.
  const seenRunIds = new Set<string>();
  for (const entry of entries) {
    if (seenRunIds.has(entry.runId)) continue;
    seenRunIds.add(entry.runId);
    const step: AgentConversationStep = {
      runId: entry.runId,
      objective: entry.objective,
      workflowType: entry.workflowType,
      mode: entry.mode,
      status: entry.status,
      answered: entry.answered,
      connectionId: entry.connectionId,
      createdAtMs: entry.createdAtMs,
      updatedAtMs: entry.atMs,
    };
    const existing = byThread.get(entry.threadId);
    if (existing === undefined) byThread.set(entry.threadId, [step]);
    else existing.push(step);
  }

  const summaries: AgentConversationSummary[] = [];
  for (const [threadId, steps] of byThread) summaries.push({ threadId, steps });

  // Newest conversation first; a tie on the finish timestamp is broken by the
  // thread id so the order is total and therefore stable across pages.
  summaries.sort((a, b) => {
    const aAt = latestAtMs(a);
    const bAt = latestAtMs(b);
    if (aAt !== bAt) return bAt - aAt;
    // Thread ids are unique by construction (one conversation per thread), so a
    // tie on the timestamp is settled by the id and the comparator never sees two
    // equal ids.
    return a.threadId < b.threadId ? -1 : 1;
  });

  return summaries.slice(0, maxConversations);
}

/** The opaque cursor one history page hands back for the page after it. */
export interface AgentHistoryCursor {
  readonly updatedAtMs: number;
  readonly threadId: string;
}

/**
 * Encodes a cursor as `<updatedAtMs>.<threadId>`.
 *
 * A thread id is a run id (`[A-Za-z0-9_]{1,64}`), so it never contains `.` and
 * the join is unambiguous. Carrying both values is what makes a page boundary
 * correct when two conversations share a finish timestamp: `<` on the pair, not
 * on the timestamp alone.
 */
export function encodeHistoryCursor(cursor: AgentHistoryCursor): string {
  return `${cursor.updatedAtMs}.${cursor.threadId}`;
}

/** Decodes a cursor, or `null` when the caller sent something this build cannot read. */
export function decodeHistoryCursor(raw: string): AgentHistoryCursor | null {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const updatedAtMs = Number(raw.slice(0, dot));
  const threadId = raw.slice(dot + 1);
  if (!Number.isInteger(updatedAtMs) || updatedAtMs < 0) return null;
  if (!/^[A-Za-z0-9_]{1,64}$/.test(threadId)) return null;
  return { updatedAtMs, threadId };
}

export interface AgentHistoryPage {
  readonly conversations: readonly AgentConversationSummary[];
  /** The cursor for the page after this one, or `null` when there is no more. */
  readonly nextCursor: string | null;
}

/**
 * Slices a bounded, already-sorted conversation list into one page.
 *
 * `cursor` is exclusive: the page starts at the first conversation strictly
 * older than the cursor's position, so a caller that replays the cursor it was
 * handed gets the rest and nothing twice.
 */
export function paginateHistory(
  summaries: readonly AgentConversationSummary[],
  options: { readonly limit?: number; readonly cursor?: AgentHistoryCursor },
): AgentHistoryPage {
  const limit = options.limit ?? AGENT_HISTORY_PAGE_DEFAULT;

  let start = 0;
  if (options.cursor !== undefined) {
    const { updatedAtMs, threadId } = options.cursor;
    // The list is sorted newest-first, with a tie on the finish timestamp
    // broken by ASCENDING thread id. The cursor is the last item of the
    // previous page, so the next page begins at the first item that sorts
    // strictly AFTER it: an older timestamp, or the same timestamp with a
    // greater thread id.
    const found = summaries.findIndex((summary) => {
      const at = latestAtMs(summary);
      if (at !== updatedAtMs) return at < updatedAtMs;
      return summary.threadId > threadId;
    });
    start = found < 0 ? summaries.length : found;
  }

  const page = summaries.slice(start, start + limit);
  const last = page[page.length - 1];
  const hasMore = start + limit < summaries.length;
  const lastStep = last?.steps[last.steps.length - 1];

  return {
    conversations: page,
    nextCursor:
      hasMore && last !== undefined && lastStep !== undefined
        ? encodeHistoryCursor({ updatedAtMs: lastStep.updatedAtMs, threadId: last.threadId })
        : null,
  };
}
