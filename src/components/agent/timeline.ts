import { AGENT_MAX_REPAIR_ATTEMPTS, AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import type { AgentGoalShortfall } from "@/lib/agent/goal-verifier";
import type { AgentPlanAccess, AgentPlanSummary } from "@/lib/agent/plan-summary";
import type { AgentLedgerEntry } from "@/lib/agent/run-store";
import {
  type AgentChartSpec,
  type AgentEvidenceReference,
  type AgentReadingDenyCode,
  type AgentReportClaim,
  type AgentRunEvent,
  type AgentRunFailureReason,
  type AgentRunMode,
  type AgentRunStatus,
  type AgentRunStopReason,
  type AgentRunWorkflowType,
  type AgentToolRefusal,
  DEFAULT_AGENT_WORKFLOW_TYPE,
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
 * TWO value imports from the runtime modules, and both are deliberate (#329 T10b,
 * and the per-workflow ceilings): `execution-policy.ts`, because the budget meter's
 * ceilings have to be the numbers the server actually enforces rather than a second
 * copy that can drift from them, and `DEFAULT_AGENT_WORKFLOW_TYPE` from `types.ts`,
 * because a header written before the workflow field must fold to the same workflow
 * the server reads it as. Both modules are frozen constants and type declarations
 * with no runtime imports of their own; nothing else here imports a value from
 * `src/lib/agent`.
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
   * Prose the MODEL wrote, for a surface to render with the structure it wrote it in.
   *
   * A third field beside the two above rather than a use of either, because it is a
   * third thing. `detail` is the application speaking, and the closing statement is
   * not the application; `quoted` is content shown verbatim, which is right for a
   * statement, an engine message or the user's own objective, and wrong for the one
   * entry whose whole content is a model's markdown — measured live, a plan run's
   * output reached the user as hash marks and asterisks (#373 review).
   *
   * It is still untrusted content. What changes is that its headings and bullets are
   * rendered as headings and bullets (`renderProse`, which builds React nodes and
   * reaches no HTML parser); what does not change is that it stays in a block of its
   * own, so a reader can still see where the application stopped speaking.
   */
  readonly prose?: string;
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
  /**
   * How the run said to DRAW the artifact above, when this entry is an answer composed
   * as a chart. Carried here so the surface a shown result opens in comes from what
   * the run RECORDED rather than from what its rows happen to look like — the same
   * rule the explain surface follows. Absent on a table answer and on every other
   * entry, because neither recorded a chart.
   */
  readonly chartSpec?: AgentChartSpec;
  /**
   * Set on the ONE entry that is the run's own answer, and on nothing else.
   *
   * A read the run took along the way and the answer it composed both carry an
   * `artifactId`, and the surface that shows the answer as it arrives (`AgentRail`)
   * must not tell them apart by which optional fields happen to sit beside it: an
   * answer with a table presentation and no hand-over carries exactly what a
   * `statement-drafted` plus `tool-completed` pair carries between them. So the fold
   * names the entry rather than leaving the browser to infer it.
   */
  readonly isAnswer?: true;
  /**
   * What the RUN already did with this entry's statement, when the entry is an
   * answer the run handed to the editor (§2.3 of `docs/AGENT_ANALYST_DESIGN.md`).
   *
   * Present only for a handover that happened: `none` is the setting being off, and
   * carrying it here would ask the rail to act on a decision to do nothing. The
   * statement rides along rather than being read off `applySql`, so the text the host
   * receives is the one THIS decision was recorded with and the field is total —
   * there is no handover here without the statement it handed over.
   *
   * `applySql` stays beside it and means what it always meant: the user may take the
   * statement themselves. This field is the run's own action, and the rail performs
   * it once per entry rather than offering it.
   */
  readonly handover?: {
    readonly kind: Exclude<Extract<AgentRunEvent, { kind: "answer-composed" }>["handover"], "none">;
    readonly sql: string;
  };
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
  /**
   * What the run was opened FOR, folded from its header — and therefore which row of
   * `AGENT_WORKFLOW_BUDGETS` the server is enforcing on it. The gauges above are
   * built from that row, and the rail states the ceilings nothing counts from the
   * same one, so meter and server cannot disagree.
   */
  readonly workflowType: AgentRunWorkflowType;
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

/**
 * What an answer's `handover` means, in the app's own words.
 *
 * A total record over the field rather than a sentence written beside it: a widened
 * union stops this file compiling until somebody words the new outcome, which is
 * what stops a sentence outliving its truth.
 *
 * The `auto-executed` wording is the distinction §2.3 says must be stated rather
 * than glossed. The run handed the statement over; the editor ran it on the user's
 * own connection, against a route this runtime does not own, so there is no ledger
 * entry for what happened next and this entry does not pretend to one. What the
 * editor did is visible in the editor.
 */
const HANDOVER_SENTENCES: Readonly<Record<Extract<AgentRunEvent, { kind: "answer-composed" }>["handover"], string>> =
  Object.freeze({
    none: "Nothing was sent to the editor; applying the statement is the user's own action.",
    applied: "The statement is in your editor and was not run there.",
    "auto-executed":
      "This run handed the statement to your editor to run: it ran on your connection, under the editor's own limits, and what it did with it is visible there rather than here.",
  });

/**
 * The honesty an operational reading owes its reader, for the same reason the plan
 * caveat exists: the app says it, rather than trusting the model to remember.
 *
 * A curated reading settles as an ordinary `tool-completed`, which renders "Result
 * stored" and nothing about WHAT kind of result it is — so without this the timeline
 * would show a session list exactly as it shows a table read, and a reader would have
 * no way to tell that the rows describe an instant that has already passed. Attached
 * on the operation id, which is the only thing on the event that identifies the
 * reading.
 */
const POINT_IN_TIME_CAVEAT = "A moment, not a history: this reading says what the engine reported as it was taken.";

/** The operation a curated operational reading is stored under. */
const OPERATIONS_OPERATION_ID = "db.operations.read";

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
  operations: "an operations reading",
  "data-analysis": "a data analysis",
};

/**
 * How the loop ended, said plainly. Total over the union, so a stop reason added to
 * the durable contract cannot reach a user as an unlabelled ending.
 *
 * `report-composed` has no sentence: the report itself is already in the timeline
 * above, and a line repeating that it exists would be noise.
 *
 * **What an ending MEANS depends on the mode**, which is why this is keyed on it
 * (#350). The wording below was written for agent mode, where a run that stops with
 * no report has fallen short. In planning mode the same exit is the SUCCESSFUL one:
 * planning is toolless by contract, `compose_report` does not exist there, and
 * stopping once the plan is written is exactly how a good planning run ends. A live
 * planning run on 2026-08-12 was recorded `answered` by its own verifier and the
 * rail rendered "Run answered" above "The model stopped without composing a cited
 * report." — a headline and a sentence about the same run that contradicted each
 * other. The earlier docblock here asserted the assumption that broke ("the rest are
 * all cases where the run stopped WITHOUT answering"); it held for one mode and was
 * stated for both.
 *
 * Only `model-stopped` differs. Every other ending is a shortfall in either mode: a
 * planning run that ran out of time or was cancelled produced no plan either.
 */
const AGENT_STOP_SENTENCES = {
  "report-composed": null,
  "model-stopped": "The model stopped without composing a cited report.",
  cancelled: "Stopped because it was cancelled.",
  "deadline-exceeded": "The run reached its time limit before it finished.",
  "model-timeout": "The model did not answer in time. Starting the run again is reasonable.",
  "turn-limit": "The run reached its step limit before it finished. What it had gathered is above.",
} as const satisfies Record<AgentRunStopReason, string | null>;

const STOP_SENTENCES: Readonly<Record<AgentRunMode, Record<AgentRunStopReason, string | null>>> = {
  agent: AGENT_STOP_SENTENCES,
  planning: {
    ...AGENT_STOP_SENTENCES,
    "model-stopped": "The model finished its plan and stopped. Planning mode has no tools, so it composed no report.",
  },
};

/**
 * The one sentence an ending gets, from at most one of its two accounts.
 *
 * `reason` wins: it means the drive died before or outside the loop, which is a more
 * specific thing to have happened than any way the loop can exit. Neither present is
 * the normal case for a ledger written before these fields existed, and it yields no
 * detail rather than an invented one.
 *
 * The verdict's shortfall still wins over the stop reason in BOTH modes, so a
 * planning run that produced no plan is told that rather than told it stopped.
 */
function endingSentence(
  reason: AgentRunFailureReason | undefined,
  stopReason: AgentRunStopReason | undefined,
  verdict: AgentGoalVerdictRecord | undefined,
  mode: AgentRunMode,
): { detail?: string } {
  if (reason !== undefined) return { detail: FAILURE_SENTENCES[reason] };
  // What the run was missing, when a verifier said. More specific than the stop
  // reason: "the model stopped" says how the loop ended, and this says what the run
  // did not produce — which is the thing a user can act on.
  const shortfall = verdict?.unmet?.map((code) => SHORTFALL_SENTENCES[code]).join(" ");
  if (shortfall !== undefined && shortfall.length > 0) return { detail: shortfall };
  if (stopReason === undefined) return {};
  // BOTH indexes are optional, and for the same reason. `parseLedgerLine` checks the
  // entry kind and deliberately nothing else, so a mode and a stop reason alike are
  // whatever a possibly-newer server wrote — the unions describe what this bundle
  // knows, not what the line holds. An unrecognised value in either position yields
  // no sentence, which is a run read without a line under it rather than a rail torn
  // down mid-read.
  const sentence = STOP_SENTENCES[mode]?.[stopReason];
  return sentence === null || sentence === undefined ? {} : { detail: sentence };
}

/**
 * What a run that was asked to stop and ended anyway owes the reader (#356).
 *
 * Twice on 2026-08-12 a Stop was pressed, the request was recorded, and 2.4 seconds
 * later the run composed its report and ended `succeeded / answered`. That is
 * correct by contract — cancellation is enforced at the run's own checkpoint, and
 * the checkpoint is in the step that reaches a database, so a report already being
 * composed is not abandoned — but the rail said "Run answered" and the ending said
 * nothing about the stop. The user pressed a button that promises the run stops,
 * and read a screen that never mentioned it again.
 *
 * So the ending accounts for it. Not by calling an answered run cancelled: it
 * answered, and the verdict is about the run's output rather than about who asked
 * for what. What was missing is the fact, and the fact is on the ledger.
 */
const STOP_ARRIVED_LATE =
  "A stop was requested before this ending: the run took no further database step, and finished what it already had in hand.";

/**
 * The ending's sentence, plus the stop that did not change it.
 *
 * `stopUnhonoured` is false for a run that ended `cancelled`, where the stop IS the
 * ending and `STOP_SENTENCES` already says so — repeating it there would tell a
 * reader twice about one event.
 */
function describeEnding(
  reason: AgentRunFailureReason | undefined,
  stopReason: AgentRunStopReason | undefined,
  verdict: AgentGoalVerdictRecord | undefined,
  mode: AgentRunMode,
  stopUnhonoured: boolean,
): { detail?: string } {
  const ending = endingSentence(reason, stopReason, verdict, mode);
  if (!stopUnhonoured) return ending;
  return { detail: ending.detail === undefined ? STOP_ARRIVED_LATE : `${ending.detail} ${STOP_ARRIVED_LATE}` };
}

/** The verdict as the ledger carries it. Optional everywhere, like the fields beside it. */
type AgentGoalVerdictRecord = NonNullable<Extract<AgentRunEvent, { kind: "run-finished" }>["goalVerdict"]>;

/**
 * What a run's own goal says about it, in the app's words.
 *
 * Not the status word: a run can end `succeeded` having answered nothing, and
 * `failed` having answered nothing, and only this tells the two apart from a run
 * that did answer.
 */
const answeredHeadline = (verdict: AgentGoalVerdictRecord): string =>
  verdict.outcome === "answered" ? "Run answered" : "Run did not answer";

/**
 * What each shortfall means, in the app's own words. Total over the union, so a
 * shortfall added to the contract cannot reach a user as a raw code.
 */
const SHORTFALL_SENTENCES: Readonly<Record<AgentGoalShortfall, string>> = {
  "no-report": "The run finished without composing a cited report, so nothing it found was written down.",
  "empty-evidence": "Every result the report cited came back empty, so the answer rests on nothing.",
  "no-plan": "The run produced no plan at all.",
  "no-plan-comparison":
    "No before-and-after plan comparison was recorded, and no index was recommended: a query optimization rests on one or the other.",
  "no-plan-evidence":
    "The index was recommended without citing a plan this run read, so nothing the engine said backs it.",
  "no-table-profile": "No table was profiled, so the state of the data was never established.",
  "no-answer":
    "The run reported what it found but never produced an answer to show, so there is nothing to put in front of you.",
  "answer-uncited":
    "The run presented one result as the answer and its report rests on other evidence entirely, so the claims and the picture are not about the same thing.",
  cancelled: "The run was stopped before it could finish.",
};

/**
 * What a refused operational reading is called in the rail. The reason code is shown
 * as the detail, so the headline says which of the two happened in the reader's own
 * terms rather than repeating the constant.
 */
const READING_REFUSAL_HEADLINES: Readonly<Record<AgentReadingDenyCode, string>> = {
  KIND_UNSUPPORTED_BY_PROVIDER: "This engine serves no reading of that kind",
  READING_OVER_BUDGET: "The reading was larger than the run may carry",
};

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
    case "reading-refused":
      return { headline: READING_REFUSAL_HEADLINES[refusal.reasonCode], detail: refusal.reasonCode };
    default:
      return { headline: "The database refused the statement", quoted: refusal.message };
  }
}

/**
 * `stopRequested` is the fold's state at THIS entry, not the run's final state, and
 * it can only be true for an entry that follows the request — which is the only
 * ordering that makes the sentence it produces true.
 */
function describeEvent(
  event: AgentRunEvent,
  mode: AgentRunMode,
  stopRequested: boolean,
): Omit<AgentTimelineItem, "id" | "atMs"> {
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
    case "tool-completed": {
      const stored = `${event.artifact.summary.rowCount} ${event.artifact.summary.rowCount === 1 ? "row" : "rows"}, ${event.artifact.summary.columnNames.length} ${event.artifact.summary.columnNames.length === 1 ? "column" : "columns"}, ${event.artifact.summary.elapsedMs} ms (${event.artifact.correlationId})`;
      return {
        tone: "progress",
        headline: "Result stored",
        detail: event.artifact.operationId === OPERATIONS_OPERATION_ID ? `${stored} ${POINT_IN_TIME_CAVEAT}` : stored,
        artifactId: event.artifact.correlationId,
      };
    }
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
    case "table-profiled":
      return {
        tone: "progress",
        headline: `Profiled ${event.profile.table}`,
        // Counts and the app's own words for what they mean. No value from the
        // column is here, because none was read — see `table-profile.ts`.
        detail:
          event.profile.findings.length === 0
            ? `${event.profile.rowCount} row(s), ${event.profile.columns.length} column(s) at ${event.profile.depth} depth. Nothing stood out.`
            : `${event.profile.rowCount} row(s) at ${event.profile.depth} depth. ${event.profile.findings
                .map((finding) => `${finding.column}: ${finding.code} — ${finding.detail}`)
                .join(" ")}`,
      };
    case "answer-composed":
      return {
        tone: "progress",
        // The app's own words for the app's own decision. The chart TYPE is one of
        // this repository's own vocabulary, so it may be spoken here; the columns
        // are the engine's text and may not, which is why none of them appear.
        headline: "Answer composed",
        // The gate's warning is the SERVER's own sentence, not model prose and not
        // engine text, so it is spoken in this line rather than quoted. A refusal
        // that says nothing is indistinguishable from the feature being broken.
        detail: `Shown as a ${event.presentation.kind === "chart" ? `${event.presentation.spec.type} chart` : "table"}, from ${event.artifact.summary.rowCount} row(s). ${HANDOVER_SENTENCES[event.handover]}${event.handoverWarning === undefined ? "" : ` ${event.handoverWarning}`}`,
        // The model's own prose about what the chart shows, quoted as model prose. A
        // table answer has no caption, so there is nothing to quote — and it carries
        // no spec either, so showing it opens the surface a table belongs in.
        ...(event.presentation.kind === "chart"
          ? { quoted: event.presentation.spec.caption, chartSpec: event.presentation.spec }
          : {}),
        // The statement the answer rests on, offered to the editor. A user action is
        // still what applies it, and the run itself sent it nowhere.
        applySql: event.sql,
        artifactId: event.artifact.correlationId,
        // This entry IS the answer, said rather than inferred: the rail shows an
        // answer as it arrives and shows no other stored result on its own.
        isAnswer: true,
        // What the run itself did with the statement, for the host to carry out. The
        // gate's outcome is the ledger's, so the rail acts on what was RECORDED
        // rather than deciding again in the browser what may be run.
        ...(event.handover === "none" ? {} : { handover: { kind: event.handover, sql: event.sql } }),
      };
    case "closing-statement":
      return {
        // Content the run produced, so it reads like the report entry rather than
        // like an ending — but under its own name, because it cites nothing.
        tone: "progress",
        headline: "Closing statement",
        // The model's own words, and carried as such: this used to be a `detail`,
        // which is the field for the application's sentences, and the surface rendered
        // a plan run's entire markdown answer into one paragraph of literal characters.
        prose: event.text,
      };
    default:
      return {
        tone: TERMINAL_TONES[event.status],
        // The headline answers the question a user actually has. `succeeded` and
        // `answered` are different facts (B24) and the status word alone has been
        // observed saying the wrong one: a run that stopped without reporting ends
        // `succeeded`, and one that ran out of turns ends `failed`, while both
        // answered nothing. An older ledger carries no verdict and keeps the status
        // it always had.
        headline: event.goalVerdict === undefined ? `Run ${event.status}` : answeredHeadline(event.goalVerdict),
        // Absent unless the ledger recorded one. A sentence supplied by default
        // would be this component inventing a cause for every ending that had none.
        // `reason` wins when both are present: a drive that died outside the loop is
        // a more specific account of the ending than the loop's own exit.
        ...describeEnding(
          event.reason,
          event.stopReason,
          event.goalVerdict,
          mode,
          stopRequested && event.status !== "cancelled",
        ),
      };
  }
}

function describeEntry(
  entry: AgentLedgerEntry,
  mode: AgentRunMode,
  stopRequested: boolean,
): Omit<AgentTimelineItem, "id"> {
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
      return { atMs: entry.event.atMs, ...describeEvent(entry.event, mode, stopRequested) };
    default:
      return {
        atMs: entry.atMs,
        tone: "neutral",
        headline: "Stop requested",
        // Deliberately not "cancelled": the run holds its budget and whatever it has
        // in flight until its own loop reaches a checkpoint (T7a).
        //
        // What the checkpoint IS, rather than that there is one (#356). "The run
        // ends at its next checkpoint" was read as a promise the run ends, and twice
        // it then composed a report and answered — because the checkpoint sits in
        // the step that reaches a database, and composing a report reaches none.
        detail: "the run takes no further database step; work already in hand, such as a report, still finishes",
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
 *  - A refused operational reading charges a STATEMENT and no repair. It is decided
 *    inside the invoke callback, after the pipeline allowed the call and
 *    `beginExecution` ran, so the tracker has already counted it; and no rewording
 *    could have changed the answer, so the repair ledger does not.
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

  /*
    What an ending MEANS depends on this (#350), so it is folded like the status is
    and read from whichever of the two entries carries it — the header a run is
    opened with, or the `run-started` event, since a stream can be joined after the
    header has gone past.

    `agent` is the default rather than an absence, and deliberately so: a fold that
    never saw either has always shown the agent wording, and this must not change
    what such a ledger reads as. The default is only reachable for a ledger whose
    beginning the rail does not hold.
  */
  let mode: AgentRunMode = "agent";

  /*
    What the run may SPEND depends on this, so the gauges below cannot be built from
    a module-level constant: the server enforces the run's own workflow row, and a
    meter stating another row's numbers would be stating a ceiling nothing enforces.

    It is read from the header alone, unlike `mode`, because the header is the only
    entry that carries it — `run-started` names the mode and not the workflow. A
    ledger whose beginning the rail has not read therefore shows the default, which
    is the same reading `run-store.ts` takes: an investigation is the only thing the
    runtime could do when a header without the field was written.
  */
  let workflowType: AgentRunWorkflowType = DEFAULT_AGENT_WORKFLOW_TYPE;

  entries.forEach((entry, index) => {
    if (entry.kind === "cancellation-requested") stopRequested = true;
    if (entry.kind === "run-opened") {
      mode = entry.mode;
      workflowType = entry.workflowType ?? DEFAULT_AGENT_WORKFLOW_TYPE;
    }
    if (entry.kind === "event") {
      const { event } = entry;
      if (event.kind === "run-started") {
        status = "running";
        mode = event.mode;
      } else if (event.kind === "run-finished") {
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
      } else if (event.kind === "tool-refused" && event.refusal.class === "reading-refused") {
        // Counted as a statement and NOT as a repair, which is what actually happened:
        // the call was admitted and executed against the run's budget, and no repair
        // attempt was spent because no rewording could have changed the answer.
        statements += 1;
      }
    }
    // Indexed, because two entries can legitimately be identical in content and
    // timestamp (a resumed run replaying a step), and React needs distinct keys.
    items.push({ id: `entry-${index}`, ...describeEntry(entry, mode, stopRequested) });
  });

  const budgets = AGENT_WORKFLOW_BUDGETS[workflowType].policy.budgets;
  return {
    items,
    status,
    stopRequested,
    failureReason,
    workflowType,
    budget: [
      { id: "statements", label: "Statements", used: statements, limit: budgets.maxStatementsPerRun, unit: "count" },
      { id: "database-time", label: "Database time", used: databaseMs, limit: budgets.maxTotalRunMs, unit: "ms" },
      { id: "repairs", label: "Repair attempts", used: repairs, limit: AGENT_MAX_REPAIR_ATTEMPTS, unit: "count" },
    ],
    report: claims === null ? null : reportOf(claims, { artifacts, statements: statementsByStep, captures }),
  };
}
