import type { AgentLedgerEntry } from "@/lib/agent/run-store";
import type { AgentRunEvent, AgentRunStatus, AgentToolRefusal } from "@/lib/agent/types";

/**
 * One run's ledger, turned into the timeline a user reads (#329 T10a).
 *
 * Types only from the runtime modules: this file runs in the browser, and the
 * modules that define these contracts reach the durable backend and the database
 * drivers. `import type` erases, so the rail carries the vocabulary without
 * carrying the runtime (the boundary T12 pins mechanically).
 *
 * Two properties of the translation are deliberate and tested:
 *
 *  - **Wording the app chose and text that came from elsewhere never share a
 *    field.** `headline`/`detail` are this repository's own words; `quoted` is
 *    verbatim content from the model, the engine or the user, and the rail renders
 *    it as a quoted block. Database content is untrusted input — the same rule the
 *    prompts follow — so it is never spliced into a sentence the user would read as
 *    the app speaking.
 *  - **A policy denial reads as a denial.** It is reported by its deny code, and
 *    there is no engine text to show because the refusal type carries none (T2).
 *    A database error is the only variant with a message, and that message is
 *    `quoted`, not narrated.
 */

export type AgentTimelineTone = "neutral" | "progress" | "refused" | "done";

export interface AgentTimelineItem {
  /** Stable within one render, unique even when two entries share a timestamp. */
  readonly id: string;
  readonly atMs: number;
  readonly tone: AgentTimelineTone;
  /** The app's own words. */
  readonly headline: string;
  /** The app's own words, secondary. */
  readonly detail?: string;
  /** Verbatim content from the model, the engine or the user. Rendered quoted. */
  readonly quoted?: string;
}

export interface AgentRunTimeline {
  readonly items: readonly AgentTimelineItem[];
  /** Folded from the ledger, never from what a request once returned. */
  readonly status: AgentRunStatus;
}

/*
 * A "stop requested" flag is deliberately NOT folded here. It would have no reader:
 * nothing in this task asks a run to stop, and this repository's standing position
 * (`src/workspace/types.ts:62-78`) is that a declared-but-unread field is the state
 * to avoid. The cancellation entry still becomes a timeline item, so the user sees
 * it; T10b's cancel control is what will need the flag, and adds it with its reader.
 */

const LEDGER_KINDS: ReadonlySet<string> = new Set<AgentLedgerEntry["kind"]>([
  "run-opened",
  "event",
  "cancellation-requested",
]);

/**
 * Reads one NDJSON line, or answers null for a line this build cannot use.
 *
 * Null rather than throwing, for two reasons that both happen in practice: the last
 * chunk of a stream can be a partial line, and a newer server can write an entry
 * kind this bundle has never heard of. Neither is a reason to tear down a timeline
 * the user is already reading.
 */
export function parseLedgerLine(line: string): AgentLedgerEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { kind?: unknown; event?: unknown };
  if (typeof candidate.kind !== "string" || !LEDGER_KINDS.has(candidate.kind)) return null;
  // An "event" wrapper with nothing in it would reach describeEvent as undefined.
  if (candidate.kind === "event" && (typeof candidate.event !== "object" || candidate.event === null)) return null;

  return parsed as AgentLedgerEntry;
}

const TERMINAL_TONES = {
  succeeded: "done",
  failed: "refused",
  cancelled: "refused",
} as const satisfies Record<string, AgentTimelineTone>;

function describeRefusal(refusal: AgentToolRefusal): Omit<AgentTimelineItem, "id" | "atMs" | "tone"> {
  // Narrowed by class, which is what makes the engine's text unreachable on the two
  // variants that have none: `refusal.message` does not compile before this switch.
  switch (refusal.class) {
    case "policy-denied":
      return { headline: "Refused by policy", detail: refusal.reasonCode };
    case "approval-required":
      return { headline: "Approval required", detail: refusal.operationId };
    default:
      return { headline: "The database refused the statement", quoted: refusal.message };
  }
}

function describeEvent(event: AgentRunEvent): Omit<AgentTimelineItem, "id" | "atMs"> {
  switch (event.kind) {
    case "run-started":
      return { tone: "neutral", headline: `Run started in ${event.mode} mode` };
    case "context-captured":
      return {
        tone: "progress",
        headline: "Schema captured",
        detail: `${event.tableCount} ${event.tableCount === 1 ? "table" : "tables"}, fingerprint ${event.fingerprint.slice(0, 8)}`,
      };
    case "statement-drafted":
      return { tone: "neutral", headline: "Statement drafted", detail: event.rationale, quoted: event.sql };
    case "tool-invoked":
      return {
        tone: "neutral",
        headline: "Tool invoked",
        detail: event.operationId === undefined ? event.tool : `${event.tool} via ${event.operationId}`,
      };
    case "tool-completed":
      return {
        tone: "progress",
        headline: "Result stored",
        detail: `${event.artifact.summary.rowCount} ${event.artifact.summary.rowCount === 1 ? "row" : "rows"}, ${event.artifact.summary.columnNames.length} ${event.artifact.summary.columnNames.length === 1 ? "column" : "columns"}, ${event.artifact.summary.elapsedMs} ms (${event.artifact.correlationId})`,
      };
    case "tool-refused":
      return { tone: "refused", ...describeRefusal(event.refusal) };
    case "report-composed":
      return {
        tone: "progress",
        headline: "Report composed",
        detail: `${event.claims.length} ${event.claims.length === 1 ? "claim" : "claims"}, each citing evidence`,
      };
    default:
      return { tone: TERMINAL_TONES[event.status], headline: `Run ${event.status}` };
  }
}

function describeEntry(entry: AgentLedgerEntry): Omit<AgentTimelineItem, "id"> {
  switch (entry.kind) {
    case "run-opened":
      return {
        atMs: entry.atMs,
        tone: "neutral",
        headline: `Run opened in ${entry.mode} mode`,
        quoted: entry.objective,
      };
    case "event":
      return { atMs: entry.event.atMs, ...describeEvent(entry.event) };
    default:
      return {
        atMs: entry.atMs,
        tone: "neutral",
        headline: "Stop requested",
        // Deliberately not "cancelled": the run holds its budget and whatever it has
        // in flight until its own loop reaches a checkpoint (T7a).
        detail: "the run ends at its next checkpoint",
      };
  }
}

/**
 * Folds a ledger into what the rail renders. The status comes from the ledger and
 * nowhere else — the same rule the routes follow, so a run reported here says the
 * same thing as a run reported to the process that resumes it.
 */
export function foldLedgerEntries(entries: readonly AgentLedgerEntry[]): AgentRunTimeline {
  const items: AgentTimelineItem[] = [];
  let status: AgentRunStatus = "queued";

  entries.forEach((entry, index) => {
    if (entry.kind === "event") {
      if (entry.event.kind === "run-started") status = "running";
      if (entry.event.kind === "run-finished") status = entry.event.status;
    }
    // Indexed, because two entries can legitimately be identical in content and
    // timestamp (a resumed run replaying a step), and React needs distinct keys.
    items.push({ id: `entry-${index}`, ...describeEntry(entry) });
  });

  return { items, status };
}
