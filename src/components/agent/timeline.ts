import { AGENT_EXECUTION_POLICY, AGENT_MAX_REPAIR_ATTEMPTS } from "@/lib/agent/execution-policy";
import type { AgentPlanAccess, AgentPlanSummary } from "@/lib/agent/plan-summary";
import type { AgentLedgerEntry } from "@/lib/agent/run-store";
import type {
  AgentEvidenceReference,
  AgentReportClaim,
  AgentRunEvent,
  AgentRunFailureReason,
  AgentRunStatus,
  AgentRunStopReason,
  AgentRunWorkflowType,
  AgentToolRefusal,
} from "@/lib/agent/types";

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
 *
 * The one VALUE import from the runtime modules is `execution-policy.ts`, and it
 * is deliberate (#329 T10b): it is frozen constants with no runtime imports of its
 * own, and the budget meter's ceilings have to be the numbers the server actually
 * enforces rather than a second copy that can drift from them. Nothing else here
 * imports a value from `src/lib/agent`.
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
  /**
   * The statement this entry drafted, when it drafted one (#329 T11). Present is
   * what makes the rail offer to apply it to the editor; a user action is still what
   * applies it.
   */
  readonly applySql?: string;
  /**
   * The artifact this entry produced, when it produced one. Its rows are fetched
   * from the run's own artifact route and hydrated into the bottom panel — the rail
   * itself renders no grid.
   */
  readonly artifactId?: string;
}

/**
 * One bound the server enforces, and what the run's ledger says it has spent.
 *
 * `limit` comes from `execution-policy.ts` itself, and `used` is counted from the
 * durable entries the enforcement layer produced — never from a client-side
 * estimate of what a call "probably" cost.
 */
export interface AgentBudgetGauge {
  readonly id: "statements" | "database-time" | "repairs";
  /** The app's own words. */
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly unit: "count" | "ms";
}

/** What one claim in a report rests on, resolved out of the run's own ledger. */
export interface AgentEvidenceCitation {
  readonly id: string;
  /** The app's own words: which artifact or which capture. */
  readonly label: string;
  /** The app's own words about what the ledger holds for it. */
  readonly detail: string;
  /** False when this timeline holds no entry the reference names. */
  readonly resolved: boolean;
  /** Verbatim: the statement that produced the cited artifact, when there is one. */
  readonly quoted?: string;
  /** Verbatim: where in the evidence the model says the claim is. */
  readonly locator?: string;
  /**
   * The artifact whose rows this citation can be shown from (#329 T11). Set only on
   * a RESOLVED artifact citation: a reference this timeline holds no entry for is
   * also one whose rows there is no point asking the server for, and a snapshot is
   * not an artifact at all.
   */
  readonly artifactId?: string;
}

export interface AgentReportClaimView {
  readonly id: string;
  /** The model's own words. Rendered as quoted content, never as the app speaking. */
  readonly quoted: string;
  readonly citations: readonly AgentEvidenceCitation[];
}

export interface AgentRunReport {
  readonly claims: readonly AgentReportClaimView[];
}

export interface AgentRunTimeline {
  readonly items: readonly AgentTimelineItem[];
  /** Folded from the ledger, never from what a request once returned. */
  readonly status: AgentRunStatus;
  /**
   * A stop has been asked for and the run has not reached its checkpoint yet.
   * Read by the rail's stop control, which is why it exists at all (#329 T10b) —
   * T10a left it out precisely because nothing read it then.
   */
  readonly stopRequested: boolean;
  /**
   * Why the run failed, when the server classified a cause; null otherwise.
   *
   * Folded alongside `status` rather than derived from the last item, so the rail
   * can say why a run ended without walking the timeline it renders.
   */
  readonly failureReason: AgentRunFailureReason | null;
  readonly budget: readonly AgentBudgetGauge[];
  /** The run's composed report, or null while it has composed none. */
  readonly report: AgentRunReport | null;
}

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

/**
 * The app's own words for each reason the server may record.
 *
 * A total map rather than a lookup with a fallback: a reason added to
 * `AgentRunFailureReason` and not given a sentence here fails to compile, which is
 * the only way this stays in step with a union that lives on the server. The
 * failure's own message is deliberately absent — it is written by a model provider
 * or a driver, and the server keeps it in the log for exactly that reason.
 */
const FAILURE_SENTENCES = {
  "model-unavailable": "The model provider is not configured or could not be reached.",
  // Says what to do, because for this one there is something to do and it is not
  // opening the settings: the provider answered, and asked for less traffic.
  "model-rate-limited": "The model provider is limiting this key's requests. Waiting a minute usually clears it.",
  "model-unauthorized": "The model provider rejected the configured credentials.",
  "engine-unsupported": "The agent cannot run on this database engine: it offers no read-only execution profile.",
  "connection-unresolvable": "This run's database connection no longer resolves on the server.",
  internal: "The server could not carry this run. The reason is in the server log.",
} as const satisfies Record<AgentRunFailureReason, string>;

/**
 * The honesty a plan comparison owes its reader, written by the app rather than
 * left to the model to remember.
 *
 * Every plan the agent can obtain is an ESTIMATE. The executing form of EXPLAIN is
 * default-denied because it runs the statement, and no tool reaches it — so a
 * comparison that read as a measurement would be describing something this runtime
 * is not permitted to do.
 */
const PLAN_ESTIMATE_CAVEAT =
  "Estimates only: these plans were described, not executed. EXPLAIN ANALYZE is policy-denied because it would run the statement.";

/** Said on every recommendation, because the run does not make the change. */
const NOT_APPLIED_CAVEAT = "Not applied: nothing here runs this statement.";

/** How an engine reaches the rows, in words. Total, so a new access kind cannot render blank. */
const ACCESS_WORDS: Readonly<Record<AgentPlanAccess, string>> = {
  "full-scan": "a full scan",
  index: "an index",
  mixed: "a mix of index and full scan",
  unknown: "an access path this reading could not interpret",
};

/** One side of a comparison, with the engine's own estimate when it reported one. */
function describeAccess(summary: AgentPlanSummary): string {
  const estimates = [
    summary.estimatedRows === undefined ? null : `${summary.estimatedRows} row(s)`,
    summary.estimatedCost === undefined ? null : `cost ${summary.estimatedCost}`,
  ].filter((part) => part !== null);
  return estimates.length === 0
    ? ACCESS_WORDS[summary.access]
    : `${ACCESS_WORDS[summary.access]} (${estimates.join(", ")})`;
}

/**
 * What a run is FOR, in words rather than in the contract's identifiers. Total over
 * the union, so a workflow type added to the contract cannot reach a user as a raw
 * kebab-case token.
 */
const WORKFLOW_WORDS: Readonly<Record<AgentRunWorkflowType, string>> = {
  investigation: "an investigation",
  "query-optimization": "query optimization",
  "database-assessment": "a database assessment",
};

/**
 * How the loop ended, said plainly. Total over the union, so a stop reason added to
 * the durable contract cannot reach a user as an unlabelled ending.
 *
 * `report-composed` has no sentence: the report itself is already in the timeline
 * above, and a line repeating that it exists would be noise. The rest are all cases
 * where the run stopped WITHOUT answering, which is precisely what a reader cannot
 * otherwise tell from `succeeded` or `failed` alone.
 */
const STOP_SENTENCES = {
  "report-composed": null,
  "model-stopped": "The model stopped without composing a cited report.",
  cancelled: "Stopped because it was cancelled.",
  "deadline-exceeded": "The run reached its time limit before it finished.",
  "model-timeout": "The model did not answer in time. Starting the run again is reasonable.",
  "turn-limit": "The run reached its step limit before it finished. What it had gathered is above.",
} as const satisfies Record<AgentRunStopReason, string | null>;

/**
 * The one sentence an ending gets, from at most one of its two accounts.
 *
 * `reason` wins: it means the drive died before or outside the loop, which is a more
 * specific thing to have happened than any way the loop can exit. Neither present is
 * the normal case for a ledger written before these fields existed, and it yields no
 * detail rather than an invented one.
 */
function describeEnding(
  reason: AgentRunFailureReason | undefined,
  stopReason: AgentRunStopReason | undefined,
): { detail?: string } {
  if (reason !== undefined) return { detail: FAILURE_SENTENCES[reason] };
  if (stopReason === undefined) return {};
  const sentence = STOP_SENTENCES[stopReason];
  return sentence === null ? {} : { detail: sentence };
}

/**
 * The sentence for a reason, for a surface that shows it outside the timeline.
 *
 * Exported so the rail's status line and the timeline entry cannot drift into two
 * wordings of the same failure.
 */
export function describeFailureReason(reason: AgentRunFailureReason): string {
  return FAILURE_SENTENCES[reason];
}

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
      return {
        tone: "neutral",
        headline: "Statement drafted",
        detail: event.rationale,
        quoted: event.sql,
        applySql: event.sql,
      };
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
        artifactId: event.artifact.correlationId,
      };
    case "tool-refused":
      return { tone: "refused", ...describeRefusal(event.refusal) };
    case "report-composed":
      return {
        tone: "progress",
        headline: "Report composed",
        detail: `${event.claims.length} ${event.claims.length === 1 ? "claim" : "claims"}, each citing evidence`,
      };
    case "plan-comparison":
      return {
        tone: "progress",
        headline: "Plans compared",
        // The server's own reading of two plans the run asked for, plus the sentence
        // a reader is owed about what those plans are: nothing here was executed, and
        // the executing form of EXPLAIN is default-denied precisely because it would
        // have been. Stated by the app rather than left to the model to remember.
        detail: `${describeAccess(event.before.summary)} to ${describeAccess(event.after.summary)}. ${PLAN_ESTIMATE_CAVEAT}`,
        // The proposed statement, so the user can take it — the model's own SQL,
        // which is why it is quoted rather than narrated.
        quoted: event.after.sql,
        applySql: event.after.sql,
      };
    case "recommendation":
      return {
        tone: "progress",
        headline: event.change === "index" ? "Index recommended" : "Rewrite recommended",
        detail: `${event.rationale} ${NOT_APPLIED_CAVEAT}`,
        quoted: event.statement,
        // The whole affordance: the statement is handed to the editor and to nobody
        // else. Nothing in this runtime executes it.
        applySql: event.statement,
      };
    case "closing-statement":
      return {
        // Content the run produced, so it reads like the report entry rather than
        // like an ending — but under its own name, because it cites nothing.
        tone: "progress",
        headline: "Closing statement",
        detail: event.text,
      };
    default:
      return {
        tone: TERMINAL_TONES[event.status],
        headline: `Run ${event.status}`,
        // Absent unless the ledger recorded one. A sentence supplied by default
        // would be this component inventing a cause for every ending that had none.
        // `reason` wins when both are present: a drive that died outside the loop is
        // a more specific account of the ending than the loop's own exit.
        ...describeEnding(event.reason, event.stopReason),
      };
  }
}

function describeEntry(entry: AgentLedgerEntry): Omit<AgentTimelineItem, "id"> {
  switch (entry.kind) {
    case "run-opened":
      return {
        atMs: entry.atMs,
        tone: "neutral",
        // The workflow is named only when the header carries one. A ledger written
        // before the field says exactly what it always said, rather than being
        // narrated as an investigation it never declared itself to be.
        headline:
          entry.workflowType === undefined
            ? `Run opened in ${entry.mode} mode`
            : `Run opened in ${entry.mode} mode for ${WORKFLOW_WORDS[entry.workflowType]}`,
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
 * What the ledger holds about one artifact, so a citation can be resolved to the
 * read that produced it — and, when the run drafted one, to its statement.
 */
interface CitedArtifact {
  readonly operationId: string;
  readonly rowCount: number;
  readonly stepId: string;
}

interface LedgerIndex {
  readonly artifacts: ReadonlyMap<string, CitedArtifact>;
  /** step id → the statement the model drafted for it. */
  readonly statements: ReadonlyMap<string, string>;
  /** snapshot fingerprint → how many tables it covered. */
  readonly captures: ReadonlyMap<string, number>;
}

function citationOf(reference: AgentEvidenceReference, id: string, index: LedgerIndex): AgentEvidenceCitation {
  const locator = reference.locator === undefined ? {} : { locator: reference.locator };

  if (reference.source === "artifact") {
    const artifact = index.artifacts.get(reference.correlationId);
    const label = `Artifact ${reference.correlationId}`;
    if (artifact === undefined) return { id, label, detail: UNRESOLVED_DETAIL, resolved: false, ...locator };
    const sql = index.statements.get(artifact.stepId);
    return {
      id,
      label,
      detail: `${artifact.rowCount} ${artifact.rowCount === 1 ? "row" : "rows"} via ${artifact.operationId}`,
      resolved: true,
      artifactId: reference.correlationId,
      ...(sql === undefined ? {} : { quoted: sql }),
      ...locator,
    };
  }

  const tableCount = index.captures.get(reference.fingerprint);
  const label = `Schema snapshot ${reference.fingerprint.slice(0, 8)}`;
  if (tableCount === undefined) return { id, label, detail: UNRESOLVED_DETAIL, resolved: false, ...locator };
  return {
    id,
    label,
    detail: `${tableCount} ${tableCount === 1 ? "table" : "tables"}`,
    resolved: true,
    ...locator,
  };
}

/*
 * The server verified every reference against the run's own log before recording
 * the report (`composeReportTool` refuses a claim it cannot verify), so a citation
 * that does not resolve HERE means this timeline is missing the entry — a line the
 * reader skipped, or a stream joined after it. Saying that is honest; rendering the
 * reference as if the rail had checked it would not be.
 */
const UNRESOLVED_DETAIL = "not in the part of this run's timeline the rail has read";

function reportOf(claims: readonly AgentReportClaim[], index: LedgerIndex): AgentRunReport {
  return {
    claims: claims.map((claim, claimIndex) => ({
      id: `claim-${claimIndex}`,
      quoted: claim.claim,
      citations: claim.evidence.map((reference, evidenceIndex) =>
        citationOf(reference, `claim-${claimIndex}-evidence-${evidenceIndex}`, index),
      ),
    })),
  };
}

/**
 * Folds a ledger into what the rail renders. The status comes from the ledger and
 * nowhere else — the same rule the routes follow, so a run reported here says the
 * same thing as a run reported to the process that resumes it.
 *
 * The budget is counted the same way, and the counting rules are the enforcement
 * layer's rather than this file's inventions:
 *
 *  - A statement is charged once per execution the pipeline ALLOWED and invoked.
 *    `execution.ts` charges `statements: 1` on the success path and on the failure
 *    path alike, so a completed read and an engine error each cost one. Note that
 *    this is wider than "reached the database": `tools.ts` acquires the provider
 *    inside the allowed callback on purpose, so an acquisition failure is accounted
 *    as a spent statement although nothing ran — and it settles no step, so this
 *    fold cannot see it either (`docs/BACKLOG.md` B13).
 *  - A policy denial and an approval requirement charge nothing at all:
 *    `execution.ts` returns before `tracker.beginExecution` on any non-allow, and
 *    `AgentRepairLedger` consumes a repair attempt only for a database error.
 *  - Database time is the elapsed time completed reads reported. A statement that
 *    failed has none in the ledger, so none is invented for it — the caveat the
 *    rail shows beside the meter is what says so.
 *
 * Every figure this produces is therefore a FLOOR on what the run has spent, and
 * the rail says so rather than presenting it as exact. The ledger is narrower than
 * the tracker in four known ways, all recorded: a failed statement's duration is
 * absent (`docs/BACKLOG.md` B12), and B13 holds the other three — the run's schema
 * capture reaches `executeAuditedOperation` through `captureContextSnapshot` rather
 * than through the run loop's `runStep`, so its two-to-three catalog reads are
 * charged without writing a `tool-completed` entry; an acquisition failure is
 * charged a statement and settles no step; and a completed read reports the
 * engine's own elapsed time while the tracker charges the span around the whole
 * call. The list is what is KNOWN, not a proof that nothing else is missing.
 */
export function foldLedgerEntries(entries: readonly AgentLedgerEntry[]): AgentRunTimeline {
  const items: AgentTimelineItem[] = [];
  let status: AgentRunStatus = "queued";
  let stopRequested = false;
  let failureReason: AgentRunFailureReason | null = null;
  let statements = 0;
  let databaseMs = 0;
  let repairs = 0;
  let claims: readonly AgentReportClaim[] | null = null;

  const artifacts = new Map<string, CitedArtifact>();
  const statementsByStep = new Map<string, string>();
  const captures = new Map<string, number>();

  entries.forEach((entry, index) => {
    if (entry.kind === "cancellation-requested") stopRequested = true;
    if (entry.kind === "event") {
      const { event } = entry;
      if (event.kind === "run-started") status = "running";
      else if (event.kind === "run-finished") {
        status = event.status;
        failureReason = event.reason ?? null;
      } else if (event.kind === "context-captured") captures.set(event.fingerprint, event.tableCount);
      else if (event.kind === "statement-drafted") statementsByStep.set(event.stepId, event.sql);
      else if (event.kind === "report-composed") claims = event.claims;
      else if (event.kind === "tool-completed") {
        statements += 1;
        databaseMs += event.artifact.summary.elapsedMs;
        artifacts.set(event.artifact.correlationId, {
          operationId: event.artifact.operationId,
          rowCount: event.artifact.summary.rowCount,
          stepId: event.stepId,
        });
      } else if (event.kind === "tool-refused" && event.refusal.class === "database-error") {
        statements += 1;
        repairs += 1;
      }
    }
    // Indexed, because two entries can legitimately be identical in content and
    // timestamp (a resumed run replaying a step), and React needs distinct keys.
    items.push({ id: `entry-${index}`, ...describeEntry(entry) });
  });

  const budgets = AGENT_EXECUTION_POLICY.budgets;
  return {
    items,
    status,
    stopRequested,
    failureReason,
    budget: [
      { id: "statements", label: "Statements", used: statements, limit: budgets.maxStatementsPerRun, unit: "count" },
      { id: "database-time", label: "Database time", used: databaseMs, limit: budgets.maxTotalRunMs, unit: "ms" },
      { id: "repairs", label: "Repair attempts", used: repairs, limit: AGENT_MAX_REPAIR_ATTEMPTS, unit: "count" },
    ],
    report: claims === null ? null : reportOf(claims, { artifacts, statements: statementsByStep, captures }),
  };
}
