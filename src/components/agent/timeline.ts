import { AGENT_MAX_REPAIR_ATTEMPTS, AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import type { AgentGoalShortfall } from "@/lib/agent/goal-verifier";
import { type AgentInventoryNoun, TABLE_INVENTORY_NOUN } from "@/lib/agent/inventory-noun";
import type { AgentPlanAccess, AgentPlanSummary } from "@/lib/agent/plan-summary";
import { readPlanStatement } from "@/lib/agent/plan-draft";
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
  type AgentRunWorkflowReading,
  type AgentRunWorkflowSource,
  type AgentRunWorkflowType,
  type AgentToolRefusal,
  DEFAULT_AGENT_WORKFLOW_READING,
  DEFAULT_AGENT_WORKFLOW_SOURCE,
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
 * THREE value imports from the runtime modules, and all three are deliberate (#329
 * T10b, the per-workflow ceilings, and #414): `execution-policy.ts`, because the
 * budget meter's ceilings have to be the numbers the server actually enforces rather
 * than a second copy that can drift from them; `DEFAULT_AGENT_WORKFLOW_TYPE` from
 * `types.ts`, because a header written before the workflow field must fold to the same
 * workflow the server reads it as; and `TABLE_INVENTORY_NOUN` from
 * `inventory-noun.ts`, because a ledger written before the noun existed must fold to
 * the word it was written under, and spelling "table"/"tables" a second time here is
 * exactly the drift that default exists to prevent. All three modules are frozen
 * constants and type declarations whose own imports are types only, so none of them
 * puts anything in the browser bundle — the property `plan-draft-boundary.test.ts`
 * measures, and the one a directly-inspected import list once got wrong.
 */

export type AgentTimelineTone = "neutral" | "progress" | "refused" | "done";

type PlanStatementEvent = Extract<AgentRunEvent, { kind: "plan-statement-drafted" }>;

/**
 * What each sentence the drive says is called in the rail, in the reader's terms.
 *
 * A table rather than the notice's own text. This maps an identifier to a label and is not
 * coupled to model tuning at all: the wording lives in `lib/agent/models/notices.ts`, one baseline
 * every model is told, and a rail that printed the paragraph would be handing the user prose
 * written for a model to act on.
 */
const GUIDANCE_HEADLINE: Record<Extract<AgentRunEvent, { kind: "guidance-issued" }>["notice"], string> = {
  "report-reminder": "Asked to file its report",
  "plan-statement": "Asked for a runnable statement",
  "report-reserve": "Told this is its last turn",
};

/**
 * What a surface needs to render the statement a PLAN run drafted, taken from the
 * ledger's own record of it (item 7 of the plan-mode SQL-generator design of
 * 2026-08-15).
 *
 * A `Pick` of the event rather than a shape written out again: every field here is a
 * claim the SERVER made about the statement — the guard's verdict, what the identifier
 * check found — and a second declaration is a place where the rail could come to say
 * something the run never established.
 *
 * It carries the SQL and the findings and no rendering decision at all. How a write is
 * marked, and in what words, is the card's question (`AgentRail`), because that is
 * where the marking has to survive a screen reader as well as a colour.
 *
 * `guardApplicable` is the one field that is NOT picked, and is required here where the
 * event has it optional. Absent on the event means the guard applied — a ledger written
 * before #414 carries no value and every draft in one was SQL the guard did read — and
 * that default belongs in the fold below, decided once. Preserving the absence would
 * leave each consumer to re-derive it, and the obvious spelling of the derivation
 * (`if (!draft.guardApplicable)`) is the WRONG one: it would tell a reader that this
 * engine's statements are not SQL about every PostgreSQL draft recorded before #414.
 */
export type AgentPlanStatementView = Pick<PlanStatementEvent, "sql" | "readOnly" | "guardViolation" | "identifiers"> & {
  /** Whether the SQL statement guard could read this draft at all. */
  readonly guardApplicable: boolean;
  /**
   * What this run's own inventory called the objects the name check looked in
   * (#414), taken from its `context-captured` entry and defaulted to
   * `TABLE_INVENTORY_NOUN` for a run that captured nothing.
   *
   * Required here where the event's is optional, for the reason `guardApplicable` is:
   * the reading of an absent value belongs in the fold, decided once, rather than in
   * every surface that renders a card.
   */
  readonly noun: AgentInventoryNoun;
};

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
  /**
   * The statement a PLAN run drafted, when this entry is the ledger's record of one.
   *
   * Deliberately NOT `applySql`, which is the field the shared hydration control
   * reads: that control's "Apply to editor" carries no mark, and the one thing this
   * entry may not do is put a `DELETE` one unremarkable click from the user's editor.
   * A surface that renders this field renders the mark with it, or it renders neither.
   */
  readonly planStatement?: AgentPlanStatementView;
  /**
   * Set on the closing entry of a plan run that produced no statement and SAID SO —
   * the `NO STATEMENT:` outcome its rules define (item 3 of the design).
   *
   * A flag rather than the words, because the words are the model's and are already in
   * `prose`. What this says is that the entry is that outcome, so a surface can present
   * it as the ending it is instead of as a closing statement that happens to begin
   * oddly. The marker itself is stripped out of `prose` before it gets here: it is a
   * protocol token the model was instructed to emit, not something it wrote for a
   * reader.
   */
  readonly planRefusal?: true;
  /**
   * Set on the closing entry of a plan run whose ledger records a drafted statement:
   * the run's deliverable is already offered, MARKED, from the card below this entry.
   *
   * The prose this flag sits on is the text the statement was read out of, so the same
   * SQL is in both places. #389's per-block "Apply to editor" inside the prose carries
   * no mark, no accessible name and no colour — it was written for a mode that had no
   * ledger record to mark from — so a surface rendering this entry withholds it and
   * lets the card be the hand-off. That is the whole point of item 4 of the design:
   * the user must never be handed a statement unlabelled when the run knows what it
   * found in it.
   *
   * Only the editor control goes. The block still renders and still copies.
   */
  readonly planStatementRecorded?: true;
  /**
   * Set on the entries that are the run's own scaffolding rather than anything it
   * found: the header it opened with, the drive starting, and the schema capture that
   * grounded it.
   *
   * The FOLD names them, for the reason it names `isAnswer` rather than leaving the
   * browser to infer it: a surface that collapsed them by matching their headlines
   * would be reading the app's own copy as a protocol, and the first reworded
   * headline would silently promote a chrome entry to a substantive one. What is
   * chrome is a property of the EVENT KIND, which is a fact this function holds and a
   * rendered string is not.
   *
   * It is a presentation hint and not a claim: every one of these entries is still
   * folded in full, still carries its detail and its quoted objective, and a surface
   * is free to render them exactly as it renders the rest.
   */
  readonly chrome?: true;
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
  /**
   * The same words, at the length a chip can carry them.
   *
   * A correlation id is a UUID in a real run — `Artifact
   * 722b2a10-e3f2-4b9c-8177-367359a21500` was measured filling a chip in a 384px
   * panel on 2026-08-21, leaving no room for `detail`, which is the half that says
   * what the read actually returned. So the identifier is cut to the eight characters
   * this rail prints an identifier at everywhere else, `label` keeps the whole one for
   * the surface that has the width for it, and both are written by one author so they
   * cannot come to name different things.
   */
  readonly shortLabel: string;
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

/**
 * What the run's LAST schema capture covered, for the surfaces that state the
 * provenance of an answer rather than the chronology of the run.
 *
 * The last one and not the first: a run can capture more than once, and what grounded
 * the answer is the reading that was in hand when it was composed. The fields are the
 * capture event's own — `tableCount` included, which is the name of a SHAPE rather than
 * a claim about the world, so the WORD a reader sees comes from `noun` (#414).
 *
 * Null for a run that captured nothing, which is a different state from a run that
 * captured an empty schema and must not be rendered as one.
 */
export interface AgentCaptureView {
  readonly fingerprint: string;
  readonly tableCount: number;
  readonly noun: AgentInventoryNoun;
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
   * The mode the run was OPENED in, folded from whichever of the two entries carries it
   * — the header, or the `run-started` event for a stream joined after the header has
   * gone past. `agent` for a ledger holding neither, which is the wording such a fold
   * has always been described with.
   *
   * It is on the run record because the rail's own `mode` state is a SELECTION: the
   * header toggle is frozen only while a start is held, so it is live again the moment
   * the run opens and decides the NEXT run. A surface describing THIS run — the safety
   * strip's posture, and the workflow-and-mode line under the objective — reads it here,
   * or one click on Plan relabels a run that is executing reads.
   */
  readonly mode: AgentRunMode;
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
  /**
   * WHERE that workflow came from, folded from the same header.
   *
   * The surface owes a user who was handed a workflow a sentence it does not owe one
   * who picked it, plus the way out of it. That sentence is read from HERE rather than
   * from the rail's memory of the request it sent, which is the whole reason the field
   * is on the run record: a rail that reloads, or a second surface that joins the
   * stream after the run opened, holds no such memory and would otherwise present an
   * inferred run as one the user chose.
   */
  readonly workflowSource: AgentRunWorkflowSource;
  /**
   * How that reading went, folded from the same header.
   *
   * The surface says a different sentence for a workflow a classifier NAMED and for one
   * it fell back to, and both of those are different again from a run whose record does
   * not say. Folded here rather than remembered by the rail that made the request: the
   * rail's memory dies with the page, and the sentence it leaves behind — a fallback
   * read back as a verdict — is a claim about the run that its own record contradicts.
   */
  readonly workflowReading: AgentRunWorkflowReading;
  /** The run's composed report, or null while it has composed none. */
  readonly report: AgentRunReport | null;
  /** What the run's schema capture covered, or null for a run that captured nothing. */
  readonly capture: AgentCaptureView | null;
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
  // Names the credential, because that is the only thing to fix and the engine is
  // not at fault: this refusal reaches PostgreSQL and SQLite too (B47).
  "agent-credential-unusable":
    "This connection's agent credential cannot be used: check that both the agent user and password are set, that the password still decrypts under the current secret key, and that no connection string is set beside it.",
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
 * The refusal marker a plan run's rules give the model, as this layer has to spell it.
 *
 * Deliberately a second spelling of `PLAN_NO_STATEMENT_MARKER`, and not an import.
 * That module reads the shared SQL grammar and the statement guard to do its other
 * job, and this file is browser code whose stated rule is that it takes TYPES from the
 * runtime modules and values from two frozen constant modules only. The duplication is
 * the same trade `plan-statement.ts` itself records for the fence pattern it shares
 * with `rich-text.tsx`, and it is pinned rather than trusted:
 * `tests/unit/components/agent-timeline.test.ts` builds its text out of the exported
 * constant, so a marker changed on the server and not here fails that test.
 *
 * Case-insensitive for the same reason the server's reader is: the rules ask for
 * capitals, and a run that refused correctly in every other respect should not lose
 * its refusal to a lower-case letter.
 */
const PLAN_REFUSAL_MARKER = /^[ \t]*NO STATEMENT:[ \t]*/im;

/**
 * The model's own words with the marker taken off, or `null` when the run did not
 * refuse.
 *
 * Whether this IS a refusal is asked of `readPlanStatement` — the same fence-aware
 * reader the server records the ledger with — and not of the regex below (#396 review).
 * An earlier version decided it here and argued the two could not disagree because this
 * one is consulted only when the ledger holds no statement. The argument had a hole:
 * a closing ` ```text ` block containing the marker records no statement either, so the
 * regex called it a refusal, the browser showed a successful ending, and the verdict
 * called the same run `no-statement`. One reader cannot disagree with itself.
 *
 * The regex survives for the DISPLAY step only. Once the shared reader has ruled, this
 * strips the token so the user reads the run's own words rather than a protocol marker;
 * everything else — what is missing, the question asked back — is left exactly as it
 * arrived, because that is the whole content of this outcome. In the one case where a
 * fenced marker precedes a real one it strips the wrong occurrence, which is a cosmetic
 * slip in text still shown in full, not a run reported as something it was not.
 */
function readPlanRefusal(prose: string | undefined): string | null {
  if (prose === undefined || readPlanStatement(prose).kind !== "refusal") return null;
  return prose.replace(PLAN_REFUSAL_MARKER, "");
}

/**
 * What the shared statement guard said about a plan run's draft, in the app's words.
 *
 * Neither half claims more than the server established. "No objection" is exactly
 * that — the guard's own contract says a clean reading means only that THAT layer
 * found nothing — and an objection is a MARK rather than a refusal, because the owner
 * ruled that a plan run's statement stays the user's to run.
 *
 * A THIRD sentence since #414, read first and blaming the guard's reach rather than
 * the draft. The guard reads every string as SQL, so a correct MongoDB aggregation or
 * Redis reading came back `NON_READ_STATEMENT` on its leading word alone — and the
 * sentence a reader then saw, "did not read this as a bounded read", is an accusation
 * against a statement that was never examined. `guardApplicable` is the server saying
 * which of those two happened, so this says it too. A plain boolean: the caller has
 * already resolved the event's optional field against its documented default.
 */
function guardSentence(
  readOnly: boolean,
  violation: PlanStatementEvent["guardViolation"],
  guardApplicable: boolean,
): string {
  if (!guardApplicable) {
    return "The statement guard reads SQL, and this engine's statements are not SQL, so nothing here examined this draft at all. Nothing about it was established, for or against.";
  }
  return readOnly
    ? "The statement guard read this as a bounded read and had no objection, which is not a promise about what it does."
    : `The statement guard did not read this as a bounded read (${violation}). It is marked, not blocked: running it is your decision.`;
}

/**
 * What could be checked about the names the statement used — and, as carefully, what
 * that check does not amount to.
 *
 * The names themselves are model and engine text, so they are counted rather than
 * spoken here: this is the app's own sentence, and untrusted content belongs in a
 * quoted block. The last clause is the design's item 6 said where the claim is made —
 * an inventory records what EXISTS, not what a role may select from — so no reader
 * takes "everything it names exists" for "this will run".
 *
 * The objects are named in the engine's own word (#414) and not in this product's
 * storage shape: the check reads the same inventory the prompt was written from, and
 * on Druid that inventory's rows are datasources however `TableSchema` spells them.
 *
 * `not-applicable` is the third branch and, like the guard's, it is about the CHECK
 * and not about the draft (#414). It is deliberately not worded as `no-inventory` is:
 * that one says nothing was read, and on this path an inventory usually was — what is
 * missing is a reader that can find a collection name in an aggregation pipeline. A
 * reader told "no inventory was read" when one was would go looking for a grounding
 * failure that did not happen.
 */
function identifierSentence(identifiers: PlanStatementEvent["identifiers"], noun: AgentInventoryNoun): string {
  if (identifiers.kind === "not-applicable") {
    return "The name check reads SQL too, so the objects this draft names were not looked for in anything.";
  }
  if (identifiers.kind === "no-inventory") {
    return "No schema inventory was read for this run, so the names it used were not checked at all.";
  }
  const unknown = identifiers.unknownTables.length;
  return unknown === 0
    ? `Every ${noun.singular} it names is in the inventory this run read — which records what exists, not what your role is permitted to read.`
    : `${unknown} name(s) it uses are not in the inventory this run read, so it may not run as written.`;
}

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
  "no-statement":
    "The run described how it would approach the question and never wrote the statement, and it did not say what was missing either.",
  "no-plan-comparison":
    "No before-and-after plan comparison was recorded, and no index was recommended: a query optimization rests on one or the other.",
  "no-plan-evidence":
    "The index was recommended without citing a plan this run read, so nothing the engine said backs it.",
  // Stays "table" (#414): the profile is `sql.table.profile`, an SQL-only operation
  // offered on engines whose rows really are tables, so the engine's own word and this
  // one are the same word wherever this verdict can be reached.
  "no-table-profile": "No table was profiled, so the state of the data was never established.",
  // "the schema inventory this run read" rather than "this database's list of tables"
  // (#414). This is an OPERATIONS verdict and that workflow reaches Redis, where the
  // inventory's rows are key prefixes this server grouped — and a verdict is the last
  // sentence that may put a noun the engine does not use in front of a reader. It
  // takes no noun of its own because it needs none: the inventory can be named without
  // naming what is in it. `no-table-profile` below keeps its word on purpose.
  "no-reading":
    "The report rests only on the schema inventory this run read, and on no reading of what the engine is doing, so nothing it says was measured on this server.",
  "no-answer":
    "The run reported what it found but never produced an answer to show, so there is nothing to put in front of you.",
  "answer-uncited":
    "The run presented one result as the answer and its report rests on other evidence entirely, so the claims and the picture are not about the same thing.",
  cancelled: "The run was stopped before it could finish.",
};

/**
 * What a refused reading is called in the rail. The reason code is shown as the
 * detail, so the headline says which one happened in the reader's own terms rather
 * than repeating the constant.
 *
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
  noun: AgentInventoryNoun,
): Omit<AgentTimelineItem, "id" | "atMs"> {
  switch (event.kind) {
    case "run-started":
      return { tone: "neutral", chrome: true, headline: `Run started in ${event.mode} mode` };
    case "context-captured":
      return {
        tone: "progress",
        chrome: true,
        headline: "Schema captured",
        // Counted in the engine's own word (#414). The rail said "17 tables" over a
        // Redis keyspace while the sidebar beside it said Key Patterns and the model
        // had been told key patterns — the same defect the prompt half of #414 fixed,
        // in the half a user actually reads.
        detail: `${event.tableCount} ${event.tableCount === 1 ? noun.singular : noun.plural}, fingerprint ${event.fingerprint.slice(0, 8)}`,
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
    case "call-held":
      return {
        /*
          Not a failure and not progress: the server turned a call back and said what it
          wanted instead. Rendered because a reader who cannot see it reads the run as
          having reported once, when what happened is that it tried, was asked for
          something, and tried again — and on the runs where the model declines the offer,
          this entry is the only place the offer exists at all.
        */
        // `refused` is the existing tone for "the server did not run this", which is
        // exactly what happened here; a new tone would be a second colour for one fact.
        tone: "refused",
        headline: `Held back ${event.tool}`,
        detail: event.reason,
      };
    case "call-declined":
      return {
        /*
          The tool said no. Same tone as a held call, because the user-visible fact is the
          same — this server did not run it — and a second colour for one fact would make the
          rail harder to read rather than more precise.

          The reason CODE is shown rather than a translation of it. A reader looking at a run
          that produced no answer needs the word the server used, because that word is what a
          search of this repository finds; a friendlier paraphrase would be a third name for
          something that already has two.
        */
        tone: "refused",
        headline: `Declined ${event.tool}`,
        detail: event.reasonCode,
      };
    case "guidance-issued":
      return {
        /*
          Something this server said, on a turn where it refused nothing. Neutral, because
          nothing was turned back — a held call gets the `refused` tone and says so — and named
          rather than quoted: the wording is one baseline in `lib/agent/models/notices.ts`, and a
          rail that printed the whole sentence would be repeating a paragraph the user did not ask
          to read.
        */
        tone: "neutral",
        headline: GUIDANCE_HEADLINE[event.notice],
      };
    case "model-stopped-saying":
      return {
        /*
          What the model said as it stopped without filing anything. Neutral rather than
          refused: nothing was turned back and nothing failed — the run simply ended, and the
          entry exists so a reader can see WHY rather than staring at a run that trails off.

          Carried as `prose`, because these are the model's own words: `detail` is the field
          for this application's sentences, and putting a model's paragraph there once rendered
          an entire markdown answer as one run of literal characters.
        */
        tone: "neutral",
        headline: "Stopped after saying",
        prose: event.text,
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
    case "plan-statement-drafted": {
      // The one place the optional field's default is decided (#414). A ledger written
      // before the field existed carries no value and every draft in one was SQL the
      // guard did read, so absence means the guard applied — said once here rather than
      // re-derived by the headline, the detail and the card.
      const guardApplicable = event.guardApplicable ?? true;
      return {
        tone: "progress",
        // The mark rides in the HEADLINE, not only in the detail: a statement the
        // guard would not pass reaching the editor unnoticed is the one failure this
        // entry exists to prevent.
        //
        // "not CLASSIFIED as a read" and never "not a read", because `readOnly` is
        // `inspectAgentStatement(sql) === null` and four of that guard's six
        // objections say only that it could not read the text — an unclosed span, a
        // run two dialects disagree about, a second statement, no statement at all —
        // while its own header records that it over-refuses legitimate reads on
        // purpose (`#>`/`#>>`, dollar quotes, a bare non-reserved keyword). Announcing
        // a jsonb read as a write would be this surface claiming a precision the
        // server never established, about the one statement a user is most likely to
        // act on. The reason travels in the detail, where a reader can weigh it.
        //
        // The third headline is #414's, and it is here rather than only in the detail
        // because this line is what a reader skims. On an engine the guard cannot read
        // `readOnly` is `false` for a reason that has nothing to do with the draft, so
        // the two-way headline announced every correct MongoDB aggregation as one the
        // guard had objected to — the same overstatement the paragraph above refuses,
        // arrived at from the other side.
        headline: !guardApplicable
          ? "Statement drafted — not examined by the statement guard"
          : event.readOnly
            ? "Statement drafted"
            : "Statement drafted — not classified as a read",
        // The app's own words about the app's own checks, and only the app's: the
        // guard's reason is this repository's own closed vocabulary, while the table
        // names are model and engine text and are therefore COUNTED rather than
        // spoken. The statement itself is in the closing prose beside this entry.
        detail: `${guardSentence(event.readOnly, event.guardViolation, guardApplicable)} ${identifierSentence(event.identifiers, noun)}`,
        // The ledger's own record, carried whole so the card can show the statement
        // AND what was found about it in one place (item 7). Still no `applySql`: that
        // field drives the shared hydration control, whose "Apply to editor" says
        // nothing about what it is applying, and a write reaching the editor unmarked
        // is the one failure this entry exists to prevent. The card offers the
        // statement through a control whose accessible name carries the mark.
        planStatement: {
          sql: event.sql,
          readOnly: event.readOnly,
          // Normalised rather than copied through: the card reads a plain boolean.
          guardApplicable,
          ...(event.guardViolation === undefined ? {} : { guardViolation: event.guardViolation }),
          identifiers: event.identifiers,
          // The word this run's own capture used, so the card's marks and this
          // entry's detail cannot describe one inventory in two vocabularies.
          noun,
        },
      };
    }
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
  noun: AgentInventoryNoun,
): Omit<AgentTimelineItem, "id"> {
  switch (entry.kind) {
    case "run-opened":
      return {
        atMs: entry.atMs,
        tone: "neutral",
        chrome: true,
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
      return { atMs: entry.event.atMs, ...describeEvent(entry.event, mode, stopRequested, noun) };
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

/**
 * What one capture covered, and what its engine calls those rows.
 *
 * The noun is held PER CAPTURE rather than once for the run, because a citation is
 * resolved by fingerprint: it points at one particular reading, and it is that
 * reading's own vocabulary the detail should be written in.
 */
interface CitedCapture {
  readonly tableCount: number;
  readonly noun: AgentInventoryNoun;
}

interface LedgerIndex {
  readonly artifacts: ReadonlyMap<string, CitedArtifact>;
  /** step id → the statement the model drafted for it. */
  readonly statements: ReadonlyMap<string, string>;
  /** snapshot fingerprint → what that capture covered. */
  readonly captures: ReadonlyMap<string, CitedCapture>;
}

/**
 * How much of an identifier a surface too narrow for the whole one shows.
 *
 * Not a new convention: the schema-snapshot label below has been written at this
 * length since it was added, and the answer card prints a capture's fingerprint at it.
 * Named once so the artifact label cut to the same length is visibly the same rule
 * rather than a second guess at what fits.
 */
const SHORT_IDENTIFIER_CHARS = 8;

function citationOf(reference: AgentEvidenceReference, id: string, index: LedgerIndex): AgentEvidenceCitation {
  const locator = reference.locator === undefined ? {} : { locator: reference.locator };

  if (reference.source === "artifact") {
    const artifact = index.artifacts.get(reference.correlationId);
    /*
      One author for the word, so the whole identifier and the chip-length one cannot
      drift into naming different things — the reason `shortLabel` is derived here at
      all rather than by whoever renders the chip.
    */
    const name = (identifier: string): string => `Artifact ${identifier}`;
    const label = name(reference.correlationId);
    const shortLabel = name(reference.correlationId.slice(0, SHORT_IDENTIFIER_CHARS));
    if (artifact === undefined)
      return { id, label, shortLabel, detail: UNRESOLVED_DETAIL, resolved: false, ...locator };
    const sql = index.statements.get(artifact.stepId);
    return {
      id,
      label,
      shortLabel,
      detail: `${artifact.rowCount} ${artifact.rowCount === 1 ? "row" : "rows"} via ${artifact.operationId}`,
      resolved: true,
      artifactId: reference.correlationId,
      ...(sql === undefined ? {} : { quoted: sql }),
      ...locator,
    };
  }

  const capture = index.captures.get(reference.fingerprint);
  // Already written at chip length, so the two labels are the same string: a
  // fingerprint is this product's own value and nothing reads more of it than this.
  const label = `Schema snapshot ${reference.fingerprint.slice(0, SHORT_IDENTIFIER_CHARS)}`;
  if (capture === undefined)
    return { id, label, shortLabel: label, detail: UNRESOLVED_DETAIL, resolved: false, ...locator };
  return {
    id,
    label,
    shortLabel: label,
    detail: `${capture.tableCount} ${capture.tableCount === 1 ? capture.noun.singular : capture.noun.plural}`,
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
  const captures = new Map<string, CitedCapture>();
  /** The run's grounding, for the surfaces that state where an answer came from. */
  let capture: AgentCaptureView | null = null;

  /*
    What this run's engine calls the rows of its inventory (#414), carried through the
    walk so that every sentence written ABOUT that inventory uses the engine's own
    word: the capture line itself, the citations resolved out of it, and the name
    check on a plan run's draft.

    Read off the capture entry and from nowhere else. The alternative was for the rail
    to ask the connection for its labels and pass them in, and it is a worse answer for
    reasons this function's own shape makes plain: it is pure over entries, and it
    renders a run resumed long after it ran. A connection can be retyped, edited or
    deleted between a run and the reading of its history, and `useProviderMetadata`
    answers `null` for the whole of its fetch and for every failure of it — so the
    labels route would have rendered the default word first and swapped it under the
    reader, and would have described an old run in a new connection's vocabulary. What
    the objects were called when they were READ is a fact about the run, and the ledger
    is where this product keeps facts about runs.

    `TABLE_INVENTORY_NOUN` until a capture says otherwise: a ledger written before the
    field, and a run that never captured anything, both read exactly as they always
    did.
  */
  let noun: AgentInventoryNoun = TABLE_INVENTORY_NOUN;

  /*
    The two facts the closing pass below needs, gathered in the same walk rather than
    by scanning the items again: which entries are closing statements, and whether the
    SERVER read a statement out of this run at all. Both of that pass's decisions turn
    on the second one. A run that has a statement is not a run that refused, whatever
    its prose happens to contain — and it is a run whose closing prose HOLDS the
    statement, which is what the card below that entry is already offering.
  */
  const closings: { readonly index: number; readonly mode: AgentRunMode }[] = [];
  let drafted = false;

  /*
    What an ending MEANS depends on this (#350), so it is folded like the status is
    and read from whichever of the two entries carries it — the header a run is
    opened with, or the `run-started` event, since a stream can be joined after the
    header has gone past.

    `agent` is the default rather than an absence, and deliberately so: a fold that
    never saw either has always shown the agent wording, and this must not change
    what such a ledger reads as. The default is only reachable for a ledger whose
    beginning the rail does not hold.

    It is also what the rail describes an OPEN run with, on the strip and on the line
    under the objective — see `AgentRunTimeline.mode` for why a selection cannot answer
    that question.
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

  /*
    And where it came from, off the same entry and defaulted the same way
    (`DEFAULT_AGENT_WORKFLOW_SOURCE`): a header written before the field, or a ledger
    whose beginning this reader never saw, describes a workflow nobody can show was
    inferred. `"chosen"` is the reading that claims the least — it costs such a run the
    "opened as" sentence and the way out of it, where the opposite default would offer
    a user the way out of a classification that never happened.
  */
  let workflowSource: AgentRunWorkflowSource = DEFAULT_AGENT_WORKFLOW_SOURCE;

  /*
    And how the reading went, off the same entry and defaulted to
    `DEFAULT_AGENT_WORKFLOW_READING`: a header that records no outcome is one nothing
    can be read out of, so it folds to `"unrecorded"` rather than to either of the
    answers a reader would then state as fact. The rail has a sentence for it.
  */
  let workflowReading: AgentRunWorkflowReading = DEFAULT_AGENT_WORKFLOW_READING;

  entries.forEach((entry, index) => {
    if (entry.kind === "cancellation-requested") stopRequested = true;
    if (entry.kind === "run-opened") {
      mode = entry.mode;
      workflowType = entry.workflowType ?? DEFAULT_AGENT_WORKFLOW_TYPE;
      workflowSource = entry.workflowSource ?? DEFAULT_AGENT_WORKFLOW_SOURCE;
      workflowReading = entry.workflowReading ?? DEFAULT_AGENT_WORKFLOW_READING;
    }
    if (entry.kind === "event") {
      const { event } = entry;
      if (event.kind === "run-started") {
        status = "running";
        mode = event.mode;
      } else if (event.kind === "run-finished") {
        status = event.status;
        failureReason = event.reason ?? null;
      } else if (event.kind === "closing-statement") closings.push({ index: items.length, mode });
      else if (event.kind === "plan-statement-drafted") drafted = true;
      else if (event.kind === "context-captured") {
        // Before the entry is described, so the capture line is written in the word it
        // itself recorded rather than in the one the entry before it was written with.
        noun = event.noun ?? TABLE_INVENTORY_NOUN;
        captures.set(event.fingerprint, { tableCount: event.tableCount, noun });
        // Overwritten rather than kept, so a run that captured twice reports the
        // reading that was in hand when it finished. See `AgentCaptureView`.
        capture = { fingerprint: event.fingerprint, tableCount: event.tableCount, noun };
      } else if (event.kind === "statement-drafted") statementsByStep.set(event.stepId, event.sql);
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
    items.push({ id: `entry-${index}`, ...describeEntry(entry, mode, stopRequested, noun) });
  });

  /*
    What a plan run's closing entry IS, decided after the walk rather than during it
    (item 7 of the plan-mode SQL-generator design of 2026-08-15). Two outcomes, and
    the ledger's statement event settles which:

     - it recorded one, so this prose is the text that statement was read out of. The
       entry is flagged, and the surface stops offering the blocks inside it through a
       control that cannot say what it is applying — the card below does that with the
       mark on it.
     - it recorded none, so the run may have taken its other legitimate ending and
       said `NO STATEMENT:`.

    Afterwards because both decisions need the whole ledger: the statement event is
    written immediately AFTER the closing statement it was read out of, so neither is
    knowable at the moment that entry is folded. And they need the run's MODE, because
    only a plan run's contract gives either fact any meaning — an agent run's closing
    prose was never asked for the token and never has a card beneath it.

    The ledger decides, and this pass only presents: where the server recorded a
    statement nothing is re-read, so the fence-aware reader on the server and the
    line-wise one here cannot end up describing the same run differently.
  */
  for (const { index, mode: at } of closings) {
    // The mode as it stood at THAT entry, which is the same reading the entry's own
    // wording was folded with, rather than the mode a later line might have set.
    if (at !== "planning") continue;
    const item = items[index];
    if (drafted) {
      // The prose the statement was read OUT of, so the deliverable is in this text
      // as well as on the card below it. The surface is told, because the per-block
      // control inside prose cannot say what it is applying.
      items[index] = { ...item, planStatementRecorded: true };
      continue;
    }
    const refused = readPlanRefusal(item.prose);
    if (refused === null) continue;
    // The headline is the app's own account of the ending, and it is a different
    // ending: "Closing statement" over a run that says it could not answer reads as
    // an answer the reader has to find in the text.
    items[index] = { ...item, headline: "No statement drafted", prose: refused, planRefusal: true };
  }

  const budgets = AGENT_WORKFLOW_BUDGETS[workflowType].policy.budgets;
  return {
    items,
    status,
    stopRequested,
    mode,
    failureReason,
    workflowType,
    workflowSource,
    workflowReading,
    budget: [
      { id: "statements", label: "Statements", used: statements, limit: budgets.maxStatementsPerRun, unit: "count" },
      { id: "database-time", label: "Database time", used: databaseMs, limit: budgets.maxTotalRunMs, unit: "ms" },
      { id: "repairs", label: "Repair attempts", used: repairs, limit: AGENT_MAX_REPAIR_ATTEMPTS, unit: "count" },
    ],
    report: claims === null ? null : reportOf(claims, { artifacts, statements: statementsByStep, captures }),
    capture,
  };
}
