"use client";

import type { ReactNode } from "react";
import { LoaderCircle, PencilLine, RotateCcw, Square, TriangleAlert } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { renderProse } from "@/components/rich-text";
import type { AgentChartSpec, AgentRunStatus } from "@/lib/agent/types";
import type { ProviderCapabilities } from "@/lib/db/types";
import { editorLanguageForTabType, resolveTabType } from "@/lib/editor/tab-language";
import { cn } from "@/lib/utils";
import {
  applyStatementName,
  guardObjectionLine,
  guardReading,
  type GuardReading,
  guardSummaryLine,
  HydrationControls,
  InfoNote,
  LIVE_STATUSES,
  QuotedBlock,
} from "./rail-parts";
import {
  type AgentBudgetGauge,
  type AgentCaptureView,
  type AgentPlanStatementView,
  type AgentRunTimeline,
  type AgentTimelineItem,
  describeFailureReason,
} from "./timeline";

/**
 * The run's outcome, at the top of the rail (the agent rail UX redesign of 2026-08-21).
 *
 * It is a SECOND rendering of entries the timeline already holds, and that is the whole
 * shape of it: everything on this card is folded out of the run's ledger, so there is no
 * field here a run did not record and no sentence about a run that is not already the
 * app's own words somewhere else. The transcript below still holds the chronology; this
 * says what came of it, without a scroll.
 *
 * Three properties are correctness rather than layout, and each is pinned by a test:
 *
 *  - **`Apply to editor` keeps the accessible name `applyStatementName` builds.** That
 *    name is WCAG 2.5.3 and it carries the guard's marks — the one thing a control which
 *    can put a `DELETE` in the user's editor may not lose by being moved.
 *  - **On an engine whose statements are not SQL there is no read-only chip.** Nothing
 *    examined the draft, so a chip saying it was read would be a claim no code in this
 *    product made. It gets the amber `not checked` chip and the two existing sentences
 *    instead.
 *  - **A statement is tinted by the engine's language**, the ladder `tab-language.ts`
 *    walks. Where no capabilities are to hand it falls back to what the LEDGER says the
 *    guard could read, never to SQL: a Mongo aggregation painted as SQL is the same
 *    overstatement #414 removed from the sentences beside it.
 *
 * What it deliberately does NOT do is offer a control for something this build cannot
 * perform. A refusal names no "capture more schema" button and a failure's retry appears
 * only where the host passed one, the rule the rest of this rail follows: nothing here is
 * a disabled button standing in for a capability that does not exist.
 */

export interface AnswerCardProps {
  /** The run, folded from its ledger. Every claim on this card comes from here. */
  readonly timeline: AgentRunTimeline;
  /**
   * The engine's capabilities, for the statement block's language. `null` or absent is
   * the honest state while nothing has answered for the connection — and it is read as
   * "unknown", never as SQL.
   */
  readonly capabilities?: ProviderCapabilities | null;
  /** Puts a statement into the host's editor. Absent hosts are offered no control. */
  readonly onApplyStatement?: (sql: string) => void;
  /** Asks the host to show a result the run stored. Same signature the rail passes on. */
  readonly onShowArtifact?: (correlationId: string, chartSpec: AgentChartSpec | undefined) => void;
  readonly onStop?: () => void;
  readonly onRetry?: () => void;
}

/** Which of the run's five outcomes this card is rendering. */
type AnswerState = "failed" | "plan" | "report" | "refused" | "running";

/**
 * The word above the card. "Answer" only where the run produced one: a refusal and a
 * failure are outcomes and not answers, and calling them answers is the kind of small
 * overstatement this rail spends its comments avoiding.
 */
const EYEBROWS: Readonly<Record<AnswerState, string>> = Object.freeze({
  plan: "Answer",
  report: "Answer",
  running: "Working",
  refused: "Outcome",
  failed: "Outcome",
});

/**
 * The pill's tone per status, as a TOTAL map: a status added to `AgentRunStatus` and not
 * given a tone here fails to compile, which is the only thing that keeps this in step
 * with a union that lives on the server.
 */
const STATUS_TONES: Readonly<Record<AgentRunStatus, string>> = Object.freeze({
  queued: "bg-blue-500/10 text-blue-300",
  running: "bg-blue-500/10 text-blue-300",
  succeeded: "bg-emerald-500/10 text-emerald-300",
  failed: "bg-rose-500/10 text-rose-300",
  cancelled: "bg-amber-500/10 text-amber-300",
});

/**
 * The language a statement block is tinted in, and the one value that is not a language:
 * `"unknown"` is this surface having nothing to go on, which is a different state from
 * every engine in the ladder and must not collapse into the first of them.
 */
type StatementLanguage = "sql" | "json" | "libredb" | "redis" | "unknown";

/**
 * Identity, never status. The rail spends amber on "nobody established this", rose on a
 * failure and emerald on a clean verdict, so none of those three is in this map: a tint
 * that a reader could mistake for a verdict is worse than no tint at all. `"unknown"`
 * takes the hairline, which says nothing, because nothing is what is known.
 */
const LANGUAGE_ACCENTS: Readonly<Record<StatementLanguage, string>> = Object.freeze({
  sql: "border-blue-400/40",
  json: "border-cyan-400/40",
  redis: "border-fuchsia-400/40",
  libredb: "border-violet-400/40",
  unknown: "border-hairline-strong",
});

/**
 * The block's language, from the capabilities where there are any and from the LEDGER
 * where there are none.
 *
 * `resolveTabType` answers `"sql"` for absent capabilities, which is right for a tab
 * (something has to be typed into) and wrong here: it would paint a Mongo aggregation as
 * SQL on every render before `/api/db/provider-meta` answers, and on every render after
 * one that failed. What the ledger recorded instead is whether the SQL guard could read
 * this draft at all — a fact about the run rather than about the connection as it stands
 * now, which is the same reason the inventory noun is read off the capture entry.
 */
function statementLanguage(
  capabilities: ProviderCapabilities | null | undefined,
  guardApplicable: boolean,
): StatementLanguage {
  if (capabilities !== null && capabilities !== undefined)
    return editorLanguageForTabType(resolveTabType(capabilities));
  return guardApplicable ? "sql" : "unknown";
}

/**
 * The chip per reading.
 *
 * There is no `Read-only` chip outside `checked`, and that is the point of the map rather
 * than a detail of it: `objected` is the guard having looked and not been satisfied, and
 * `unexamined` is nothing having looked, so neither may be labelled with the verdict the
 * third one earned.
 */
const GUARD_CHIPS: Readonly<Record<GuardReading, { readonly label: string; readonly className: string }>> =
  Object.freeze({
    checked: { label: "Read-only", className: "text-emerald-300" },
    // The timeline's own headline for this state, in its own words.
    objected: { label: "not classified as a read", className: "text-amber-300" },
    unexamined: { label: "not checked", className: "text-amber-300" },
  });

/*
  The sentences below are the ones the transcript's plan card already carries, moved here
  as strings rather than as JSX prose: these are claims a user reads at the moment they
  decide whether to run something, a formatter is free to reflow JSX text around an
  interpolated value, and a claim assembled from reflowed fragments is the kind that ends
  up saying what no branch intended. They are reproduced word for word, and each keeps
  the test id it carried as a paragraph on that card — `agent-plan-statement-guard-unread`,
  `agent-plan-statement-unread`, `agent-plan-statement-unchecked`,
  `agent-plan-statement-unknown` and `agent-plan-statement-caveat`.

  The id travels WITH the claim rather than being replaced by one id on the popover,
  which is the pattern `InfoNote`'s own docblock states and `agent-budget-limits` and its
  two siblings follow. It is not bookkeeping: these ids are how a test pins that the
  right sentence for THIS reading is present, and an assertion against one shared blob
  cannot tell that apart from any sentence that happens to contain the phrase — the
  `no-inventory` and `not-applicable` readings differ by exactly which of two sentences
  they may make.
*/

/** One preserved claim, and the id a test finds it by. */
interface GuardNote {
  readonly testId: string;
  readonly text: string;
}

/** Said where the guard reads SQL and the engine's statements are not. */
const GUARD_UNREAD_NOTE: GuardNote = Object.freeze({
  testId: "agent-plan-statement-guard-unread",
  text: "The statement guard reads SQL, and this engine's statements are not SQL — so nothing examined this draft. It is drafted, not run — nothing has happened to your data — but nothing here has established anything about it, for or against.",
});

/** The same fact about the NAME check, which is a second SQL reader. */
const NAMES_UNREAD_NOTE: GuardNote = Object.freeze({
  testId: "agent-plan-statement-unread",
  text: "The names in this statement were not checked: the check that would do it reads SQL, and this engine's statements are not SQL.",
});

/** A run that captured nothing to check against, which is not the same state. */
const NO_INVENTORY_NOTE: GuardNote = Object.freeze({
  testId: "agent-plan-statement-unchecked",
  text: "No schema inventory was read for this run, so the names in this statement were not checked against anything.",
});

/** Names the inventory does not hold. The names themselves are chips, not part of this sentence. */
const UNKNOWN_NAMES_NOTE: GuardNote = Object.freeze({
  testId: "agent-plan-statement-unknown",
  text: "These names are not in the inventory this run read, so the statement may not run as written:",
});

/** What a checked statement is still not: permission to run. */
const EXECUTION_CAVEAT: GuardNote = Object.freeze({
  testId: "agent-plan-statement-caveat",
  text: "The run executed nothing. What was checked is what this run read of the schema, which records what exists rather than what your role is permitted to read.",
});

/**
 * The guard's own objection, with the reason it recorded — the shared first sentence,
 * continued with what the objection does and does not establish.
 */
const guardObjectionNote = (violation: string | undefined): string =>
  `${guardObjectionLine(violation)} It is drafted, not run — nothing has happened to your data — but nothing here establishes that running it would only read.`;

/** The rail's sentence for the ending a plan run reaches when it drafts nothing. */
const REFUSAL_NOTE =
  "This run drafted no statement. What it says is missing, and what it needs from you, are in its own words below.";

/**
 * The floor claim, in the words the meter's caveat paragraph already makes it in
 * (`agent-budget-caveats`). The paragraph itself stays where the ceilings are; what a
 * live figure needs beside it is the half that says the figure is not the spend.
 */
const SPEND_FLOOR_NOTE =
  "What is counted comes from the run's ledger, which records less than the server charges, so a spend shown here is a floor, never a ceiling.";

/** A failure the server carried without classifying. There is a cause; this is not it. */
const UNCLASSIFIED_FAILURE_NOTE =
  "This run ended as failed and its own record names no reason for it. The server log is where the cause is.";

/** What the names the check could not find, or could not read, add to the popover. */
function identifierNote(draft: AgentPlanStatementView): GuardNote | null {
  if (draft.identifiers.kind === "not-applicable") return NAMES_UNREAD_NOTE;
  if (draft.identifiers.kind === "no-inventory") return NO_INVENTORY_NOTE;
  return draft.identifiers.unknownTables.length > 0 ? UNKNOWN_NAMES_NOTE : null;
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

/**
 * One gauge, read in the unit it is bounded in and named by its own label.
 *
 * The formatter is the rail's, spelled again rather than imported: `AgentRail` imports
 * this file, so nothing here can import that one, and a two-line number formatter is a
 * cheaper duplicate than moving the meter out of the rail that owns it.
 */
const readGauge = (gauge: AgentBudgetGauge): string =>
  gauge.unit === "ms"
    ? `${seconds(gauge.used)} / ${seconds(gauge.limit)} s ${gauge.label.toLowerCase()}`
    : `${gauge.used} / ${gauge.limit} ${gauge.label.toLowerCase()}`;

/**
 * How far through its budget the run is, as the FULLEST of its bounds.
 *
 * Not progress toward an answer: nothing the ledger holds measures that, and a bar
 * claiming to would be this surface inventing a number. What it honestly shows is how
 * much of the allowance is gone, and a run ends when any one bound is reached — so the
 * fullest gauge is the one that says how near the end it is. Clamped, because a bound can
 * be overrun by up to one statement and a bar past its own track reads as a larger
 * allowance than exists.
 */
const budgetFraction = (gauges: readonly AgentBudgetGauge[]): number =>
  Math.min(100, Math.max(0, ...gauges.map((gauge) => (gauge.used / gauge.limit) * 100)));

/** A chip: one fact off the ledger, small enough to scan. */
function Chip({
  testId,
  className,
  resolved,
  children,
}: {
  readonly testId: string;
  readonly className?: string;
  /**
   * Whether what this chip names was found in the run's own ledger, for the chips where
   * that is a question. Carried as data rather than only as a colour, the rule
   * `data-read-only` follows on the transcript's card: a verdict a test can assert beats
   * one a test has to infer from styling. Absent where the chip makes no such claim.
   */
  readonly resolved?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span
      data-testid={testId}
      data-resolved={resolved === undefined ? undefined : String(resolved)}
      className={cn("rounded bg-fill px-1 py-0.5 text-[0.625rem] text-fg-tertiary whitespace-nowrap", className)}
    >
      {children}
    </span>
  );
}

/**
 * The statement, quoted as it arrived and tinted by the language it is in.
 *
 * `data-language` carries the reading as DATA and not only as a class, for the reason
 * `data-read-only` does on the transcript's card: a claim a test can assert beats one a
 * test has to infer from styling.
 */
function StatementBlock({ sql, language }: { readonly sql: string; readonly language: StatementLanguage }) {
  return (
    <div
      data-testid="agent-answer-statement"
      data-language={language}
      className={cn("border-l-2 pl-1.5", LANGUAGE_ACCENTS[language])}
    >
      <QuotedBlock text={sql} testId="agent-answer-statement-copy" tone="loud" />
    </div>
  );
}

/** What the guard did, said in one line with the full claim behind the ⓘ. */
function GuardLine({ draft }: { readonly draft: AgentPlanStatementView }) {
  const reading = guardReading(draft);
  const identifier = identifierNote(draft);
  const notes: GuardNote[] = [];
  // The unexamined reading's visible line is the short form of this one, so the full
  // sentence goes in the popover. The objection's visible line IS its full sentence,
  // and repeating it below itself would say the same thing twice.
  if (reading === "unexamined") notes.push(GUARD_UNREAD_NOTE);
  if (identifier !== null) notes.push(identifier);
  notes.push(EXECUTION_CAVEAT);

  return (
    <p
      className={cn(
        "mt-1 flex items-start gap-1 text-[0.625rem]",
        reading === "checked" ? "text-fg-muted" : "text-amber-300",
      )}
    >
      {reading !== "checked" && (
        <TriangleAlert strokeWidth={1.5} className="mt-px w-3 h-3 shrink-0" aria-hidden="true" />
      )}
      {/* The testid is on the SENTENCE and not on the paragraph: the popover's own text
          is a node inside it, and a reader asserting this line must not be handed the
          line plus everything folded behind it. */}
      <span data-testid="agent-answer-guard">
        {reading === "objected" ? guardObjectionNote(draft.guardViolation) : guardSummaryLine(draft)}
      </span>
      <InfoNote
        title={reading === "unexamined" ? "Why nothing examined this draft" : "What the statement guard checked"}
        testId="agent-answer-guard-note"
      >
        {notes.map((note) => (
          <span key={note.testId} data-testid={note.testId} className="block">
            {note.text}
          </span>
        ))}
      </InfoNote>
    </p>
  );
}

/**
 * The provenance of a plan answer, as chips: every one off the ledger, none invented.
 *
 * The guard's reading and the run's grounding are TWO facts, and keeping them so is the
 * whole point of the shape here (L4, measured against live MongoDB on 2026-08-21). The
 * inventory and the fingerprint come from the run's capture — from `AgentRunTimeline`,
 * which every caller of this card already holds — so they are stated on every engine,
 * including the ones where the SQL guard could examine nothing. That is the case they
 * matter most in: where nothing read the draft, the inventory it was drafted against is
 * the only grounding claim left, and it was exactly the one that disappeared.
 */
function PlanChips({
  draft,
  capture,
}: {
  readonly draft: AgentPlanStatementView;
  readonly capture: AgentCaptureView | null;
}) {
  const reading = guardReading(draft);
  const unknown = draft.identifiers.kind === "checked" ? draft.identifiers.unknownTables : [];

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <Chip testId="agent-answer-chip-guard" className={GUARD_CHIPS[reading].className}>
        {GUARD_CHIPS[reading].label}
      </Chip>
      {unknown.length > 0 && (
        /* Model and engine text, listed as the content it is rather than spliced into a
           sentence of ours. The list is named for a reader who cannot see the ⓘ beside
           the guard line, because a bare name says nothing on its own. */
        <ul
          data-testid="agent-answer-chip-names"
          aria-label={UNKNOWN_NAMES_NOTE.text}
          className="flex flex-wrap items-center gap-1"
        >
          {unknown.map((name) => (
            <li key={name}>
              <Chip testId="agent-answer-chip-name" className="font-mono text-amber-200">
                {name}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {capture !== null && (
        <>
          <Chip testId="agent-answer-chip-inventory">
            {capture.tableCount} {capture.tableCount === 1 ? capture.noun.singular : capture.noun.plural} read
          </Chip>
          {/* Eight characters, the length every other surface prints a fingerprint at. */}
          <Chip testId="agent-answer-chip-fingerprint" className="font-mono">
            {capture.fingerprint.slice(0, 8)}
          </Chip>
        </>
      )}
    </div>
  );
}

/**
 * Which outcome this card renders, in the order the readings EXCLUDE each other — and
 * the ONE place that reading is made.
 *
 * Exported because `AgentRail` needs the same answer: the transcript withholds its copy
 * of a hand-off precisely BECAUSE this card offers it, so a suppression derived from the
 * ledger instead of from this function is a second, independent reading of the same
 * question — and two readings of one question is how the rail came to withhold the only
 * `Apply to editor` a run had while the card was showing something else entirely.
 *
 * The run's PRODUCT decides, and the status does not:
 *
 *  - whatever the ledger holds as the deliverable comes first, before the status,
 *    deliberately. A stream chunk can carry `answer-composed` and `run-finished`
 *    together, and it can also carry an answer while the run is still finishing; an
 *    answer gated on a terminal status would not be rendered in the first case at all,
 *    which is the trap the rail's own artifact delivery already records.
 *  - and `failed` is a status, not the absence of a product. `conclude` in
 *    `src/lib/agent/investigation.ts` records the closing prose and then the drafted
 *    statement BEFORE `service.finish`, and it is called with `"failed"` for a model
 *    timeout, an exhausted deadline and the turn ceiling — so a plan run that fenced a
 *    statement and then ran out of turns ends `failed` HOLDING its deliverable, and
 *    `run-finished`'s own documentation names the combination. Reading the status first
 *    replaced the statement, the marked hand-off, the guard's claims and the chips with
 *    a banner, on the one surface the marking rules exist for. The failure is stated
 *    beside the product instead (`FailureNote`), which loses nothing: the pill already
 *    prints `failed`.
 *
 * `"running"` is what is left when the ledger holds no product yet, and `null` is a run
 * with nothing recorded, or one that ended having produced nothing. Neither gets a card:
 * the transcript says what happened, and a card would have to invent a headline for it.
 */
export function answerCardState(timeline: AgentRunTimeline): AnswerState | null {
  if (timeline.items.length === 0) return null;
  if (timeline.items.some((item) => item.planStatement !== undefined)) return "plan";
  if (timeline.report !== null) return "report";
  if (timeline.items.some((item) => item.planRefusal === true)) return "refused";
  if (timeline.status === "failed") return "failed";
  return LIVE_STATUSES.has(timeline.status) ? "running" : null;
}

export function AnswerCard({
  timeline,
  capabilities,
  onApplyStatement,
  onShowArtifact,
  onStop,
  onRetry,
}: AnswerCardProps) {
  const drafted = timeline.items.find((item) => item.planStatement !== undefined)?.planStatement;
  const refusalProse = timeline.items.find((item) => item.planRefusal === true)?.prose;
  const state = answerCardState(timeline);

  if (state === null) return null;

  return (
    <section data-testid="agent-answer" className="border-b border-hairline p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[0.625rem] font-medium tracking-wide text-fg-subtle uppercase">{EYEBROWS[state]}</span>
        <span
          data-testid="agent-answer-status"
          className={cn("rounded px-1.5 py-0.5 text-[0.625rem]", STATUS_TONES[timeline.status])}
        >
          {timeline.status}
        </span>
      </div>

      {state === "plan" && drafted !== undefined && (
        <PlanAnswer
          draft={drafted}
          rationale={timeline.items.find((item) => item.planStatementRecorded === true)?.prose}
          language={statementLanguage(capabilities, drafted.guardApplicable)}
          capture={timeline.capture}
          onApplyStatement={onApplyStatement}
        />
      )}
      {state === "report" && timeline.report !== null && (
        <ReportAnswer
          report={timeline.report}
          answer={timeline.items.find((item) => item.isAnswer === true)}
          onApplyStatement={onApplyStatement}
          onShowArtifact={onShowArtifact}
        />
      )}
      {state === "refused" && refusalProse !== undefined && <RefusedAnswer prose={refusalProse} />}
      {/*
        Keyed on the STATUS and not on the state, which is the whole point of splitting it
        out: a run can end `failed` holding a statement or a report, and the reader needs
        both facts. So the product above says what the run produced and this says how it
        ended, on the same card — where the state IS `failed` it is the only thing there
        is, which is exactly what it used to be.
      */}
      {timeline.status === "failed" && <FailureNote timeline={timeline} onRetry={onRetry} />}
      {state === "running" && <RunningAnswer timeline={timeline} onStop={onStop} />}
    </section>
  );
}

/** How the run ended, for the endings the server calls failures. */
function FailureNote({
  timeline,
  onRetry,
}: {
  readonly timeline: AgentRunTimeline;
  readonly onRetry: (() => void) | undefined;
}) {
  return (
    <div data-testid="agent-answer-failed" className="mt-1.5 rounded border border-rose-500/40 bg-rose-500/5 p-2">
      <p className="flex items-center gap-1 text-xs text-rose-300">
        <TriangleAlert strokeWidth={1.5} className="w-3 h-3 shrink-0" aria-hidden="true" />
        Run failed
      </p>
      {/* The same map the timeline entry reads, so the two cannot disagree. */}
      <p data-testid="agent-answer-failure" className="mt-1 text-[0.625rem] text-fg-tertiary">
        {timeline.failureReason === null ? UNCLASSIFIED_FAILURE_NOTE : describeFailureReason(timeline.failureReason)}
      </p>
      {onRetry !== undefined && (
        <button
          type="button"
          data-testid="agent-answer-retry"
          onClick={onRetry}
          className="mt-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.625rem] text-blue-300 hover:bg-fill transition-colors"
        >
          <RotateCcw strokeWidth={1.5} className="w-3 h-3" />
          Retry
        </button>
      )}
    </div>
  );
}

/** What a plan run produced, with what the server established about it. */
function PlanAnswer({
  draft,
  rationale,
  language,
  capture,
  onApplyStatement,
}: {
  readonly draft: AgentPlanStatementView;
  readonly rationale: string | undefined;
  readonly language: StatementLanguage;
  readonly capture: AgentCaptureView | null;
  readonly onApplyStatement: ((sql: string) => void) | undefined;
}) {
  return (
    <div
      data-testid="agent-answer-plan"
      /*
        THREE values, not two, the reading #414 settled on the transcript's card: a
        consumer that tests for `"false"` must not be able to reach an objection the
        guard never made, so an unexamined draft is neither `"true"` nor `"false"`.
      */
      data-read-only={!draft.guardApplicable ? "unexamined" : draft.readOnly ? "true" : "false"}
      className="mt-1.5"
    >
      <StatementBlock sql={draft.sql} language={language} />
      {onApplyStatement !== undefined && (
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            data-testid="agent-answer-plan-apply"
            /*
              The name the rail already builds, never a label written again here: it
              carries the guard's marks, and the whole risk of moving this control up to
              the card is that the marks stay behind. `applyStatementName` lives in
              `rail-parts.tsx` precisely so both surfaces name the act the same way.
            */
            aria-label={applyStatementName(draft)}
            onClick={() => onApplyStatement(draft.sql)}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.625rem] transition-colors hover:bg-fill",
              draft.readOnly ? "bg-blue-500/15 text-blue-300" : "bg-amber-500/15 text-amber-300",
            )}
          >
            <PencilLine strokeWidth={1.5} className="w-3 h-3" />
            Apply to editor
          </button>
        </div>
      )}
      <PlanChips draft={draft} capture={capture} />
      {rationale !== undefined && (
        <details data-testid="agent-answer-why" className="mt-1.5 group">
          <summary className="cursor-pointer text-[0.625rem] text-fg-muted hover:text-fg-secondary">
            Why this statement
          </summary>
          {/*
            The model's prose, in the structure it wrote it in, with the per-block
            editor control withheld AND the statement's own block not printed a second
            time: this is the text the statement was read out of, so the same statement
            is in both places, `renderProse`'s own control cannot say what it is
            applying, and the block itself is a duplicate of what is displayed two lines
            above (L5, measured 2026-08-21 — the card showed the statement, then the same
            statement again in here, each with its own `Copy`).

            `cardedStatement` is the same shape as that withheld control rather than a
            second mechanism: the caller says what the surface beside the prose is
            already showing. Nothing is edited — every other block still renders, the
            words are untouched, and `Copy all` below carries the whole prose, fence
            included, because it takes the string the model wrote and not this rendering
            of it.
          */}
          <div
            data-testid="agent-answer-why-prose"
            className="mt-1 space-y-1 border-l border-hairline-strong pl-2 text-[0.625rem] text-fg-tertiary"
          >
            {renderProse(rationale, { cardedStatement: draft.sql })}
            <CopyButton text={rationale} testId="agent-answer-why-copy" label="Copy all" />
          </div>
        </details>
      )}
      <GuardLine draft={draft} />
    </div>
  );
}

/** What an agent run concluded, and the evidence it rests on. */
function ReportAnswer({
  report,
  answer,
  onApplyStatement,
  onShowArtifact,
}: {
  readonly report: NonNullable<AgentRunTimeline["report"]>;
  readonly answer: AgentTimelineItem | undefined;
  readonly onApplyStatement: ((sql: string) => void) | undefined;
  readonly onShowArtifact: ((correlationId: string, chartSpec: AgentChartSpec | undefined) => void) | undefined;
}) {
  const citations = report.claims.flatMap((claim) => claim.citations);

  return (
    <div data-testid="agent-answer-report" className="mt-1.5">
      {report.claims.map((claim) => (
        <div key={claim.id} data-testid="agent-answer-claim" className="mb-1.5">
          {/* The model's own words, quoted — never narrated as the app speaking. */}
          <QuotedBlock text={claim.quoted} testId="agent-answer-claim-copy" tone="loud" />
          <ul
            data-testid="agent-answer-citation-chips"
            aria-label="What this claim cites"
            className="mt-1 flex flex-wrap items-center gap-1"
          >
            {claim.citations.map((citation) => (
              <li key={citation.id}>
                {/*
                  A citation this timeline holds no entry for is marked as unresolved
                  rather than dropped: the server refused a claim it could not verify, so
                  a gap here is a gap in what the rail has READ, and saying so is honest
                  where rendering it as checked would not be.
                */}
                <Chip
                  testId="agent-answer-citation-chip"
                  resolved={citation.resolved}
                  /*
                    Wrapping on BOTH readings now, not only on the long one: every chip
                    here carries a sentence, and a chip that cannot wrap in a 384px panel
                    takes the panel sideways instead — which is the failure the statement
                    blocks in this same card were changed to avoid.
                  */
                  className={cn("font-mono whitespace-normal", citation.resolved ? undefined : "text-amber-300")}
                >
                  {/*
                    The identifier at chip length, never the whole one: a correlation id
                    is a UUID in a real run, and `Artifact
                    722b2a10-e3f2-4b9c-8177-367359a21500` was measured filling this chip
                    in a 384px panel on 2026-08-21 (L8), leaving no room for what the
                    ledger knows about that read. The whole identifier is `label`, and it
                    is printed in the `Evidence` fold below — which is the surface a
                    reader chasing a correlation id through a server log opens anyway.
                  */}
                  {citation.shortLabel}
                  {citation.locator === undefined ? "" : ` · ${citation.locator}`}
                  {/*
                    The ledger's own detail, on both readings, IN TEXT — and not only in
                    amber (WCAG 1.4.1). Hue alone used to carry the whole distinction
                    between a checked citation and one this timeline holds no entry for:
                    a screen-reader user, and anyone who cannot separate amber from a
                    neutral chip, read the two as the same fact. `detail` says which it
                    is in the app's own words either way — the rows a read returned, or
                    the sentence saying the rail has not read the entry — which is how
                    the surface this replaced said it, visibly, beside the label.

                    Two test ids for one node, by reading, because the id travels with
                    the CLAIM here as it does with the guard's sentences above: one
                    shared id would pass a test on either sentence, and these two states
                    differ by exactly which sentence is right.
                  */}
                  <span
                    data-testid={
                      citation.resolved ? "agent-answer-citation-chip-detail" : "agent-answer-citation-chip-unresolved"
                    }
                    className="font-sans"
                  >
                    {` · ${citation.detail}`}
                  </span>
                </Chip>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {/* Whatever the LEDGER offers on the answer entry, and nothing more. */}
      <HydrationControls
        sql={answer?.applySql}
        artifactId={answer?.artifactId}
        chartSpec={answer?.chartSpec}
        testIdPrefix="agent-answer-"
        /*
          Named by the rail's own name-builder, which is what all three of the hand-offs
          this path used to offer were missing (L6). `null` because there is no draft
          view to read: the run wrote this statement, ran it on the read-only session the
          engine enforced and answered from the rows, so no guard reading about it exists
          to carry — and one invented here would be a claim no code in this product made.
        */
        applyName={applyStatementName(null)}
        onApply={onApplyStatement}
        onShow={onShowArtifact}
      />
      <details data-testid="agent-answer-evidence" className="mt-1.5">
        <summary className="cursor-pointer text-[0.625rem] text-fg-muted hover:text-fg-secondary">
          Evidence · {citations.length} {citations.length === 1 ? "citation" : "citations"}
        </summary>
        <div className="mt-1 space-y-1.5">
          {citations.map((citation) => (
            <div key={citation.id} data-testid="agent-answer-evidence-citation" className="text-[0.625rem]">
              <span className={citation.resolved ? "text-fg-tertiary" : "text-amber-300"}>{citation.label}</span>
              <span className="ml-1 text-fg-subtle">{citation.detail}</span>
              {citation.quoted !== undefined && (
                <QuotedBlock text={citation.quoted} testId="agent-answer-citation-quoted-copy" className="mt-0.5" />
              )}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/**
 * The other legitimate ending of a plan run: it says the schema does not answer the
 * question.
 *
 * The card states that it drafted nothing and hands the reader the run's own words. It
 * offers no next step of its own — the mockup's "capture more schema" is not a thing this
 * build can do from here, and a button that does nothing is worse than the sentence that
 * points at what the run actually said.
 */
function RefusedAnswer({ prose }: { readonly prose: string }) {
  return (
    <div data-testid="agent-answer-refused" className="mt-1.5 rounded border border-amber-400/40 bg-amber-500/5 p-2">
      <p className="flex items-center gap-1 text-xs text-amber-300">
        <TriangleAlert strokeWidth={1.5} className="w-3 h-3 shrink-0" aria-hidden="true" />
        No statement drafted
      </p>
      <p data-testid="agent-answer-refusal-note" className="mt-1 text-[0.625rem] text-amber-300/90">
        {REFUSAL_NOTE}
      </p>
      {/* The marker it was read by is already stripped: it is a protocol token the model
          was told to emit, not something it wrote for a reader. */}
      <div
        data-testid="agent-answer-refusal-prose"
        className="mt-1 space-y-1 border-l border-hairline-strong pl-2 text-[0.625rem] text-fg-tertiary"
      >
        {renderProse(prose)}
        <CopyButton text={prose} testId="agent-answer-refusal-copy" label="Copy all" />
      </div>
    </div>
  );
}

/** Where the run has got to, and what it has spent getting there. */
function RunningAnswer({
  timeline,
  onStop,
}: {
  readonly timeline: AgentRunTimeline;
  readonly onStop: (() => void) | undefined;
}) {
  const items = timeline.items;
  const current = items[items.length - 1];
  /*
    The span the LEDGER covers, not a clock. A ticking elapsed time would run past what
    the run recorded, and a rail that reloads would start it again from zero — so what is
    shown is the distance between the first entry this rail has read and the newest one,
    which is a fact about the run rather than about this page's uptime.
  */
  const span = (current?.atMs ?? 0) - (items[0]?.atMs ?? 0);

  return (
    <div data-testid="agent-answer-running" className="mt-1.5">
      <p data-testid="agent-answer-step" className="flex items-center gap-1.5 text-xs text-fg-secondary">
        <LoaderCircle strokeWidth={1.5} className="w-3 h-3 shrink-0 animate-spin" aria-hidden="true" />
        {current?.headline}
      </p>
      {current?.detail !== undefined && <p className="mt-0.5 pl-4.5 text-[0.625rem] text-fg-muted">{current.detail}</p>}
      <p data-testid="agent-answer-elapsed" className="mt-1 text-[0.625rem] text-fg-subtle">
        {seconds(span)} s since this run&apos;s first recorded entry
      </p>
      <div className="mt-1 h-0.5 rounded-full bg-fill">
        <div
          data-testid="agent-answer-progress"
          className="h-full rounded-full bg-blue-400/60"
          style={{ width: `${budgetFraction(timeline.budget)}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span
          data-testid="agent-answer-spend"
          className="flex items-start gap-1 font-mono text-[0.625rem] text-fg-tertiary"
        >
          {timeline.budget.map(readGauge).join(" · ")}
          <InfoNote title="Figures are a floor, not the spend" testId="agent-answer-spend-note">
            {SPEND_FLOOR_NOTE}
          </InfoNote>
        </span>
        {onStop !== undefined && (
          <button
            type="button"
            data-testid="agent-answer-stop"
            onClick={onStop}
            className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[0.625rem] text-amber-300 hover:bg-amber-500/25 transition-colors"
          >
            <Square strokeWidth={1.5} className="w-3 h-3" />
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
