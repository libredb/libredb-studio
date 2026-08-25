"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronRight, LoaderCircle, PencilLine, Play, Square, TriangleAlert, X } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { renderProse } from "@/components/rich-text";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { isMobileViewport, useIsMobile } from "@/hooks/use-mobile";
import { describeAgentCapability } from "@/lib/agent/capability-labels";
/*
  The list the SERVER gates a profiled acquisition on, read here for one presentation:
  an engine outside it cannot execute an agent run's statement, and saying so before
  Start is pressed is cheaper for the user than a run that ends `engine-unsupported`.
  It gates nothing — the refusal is the factory's, and this is a notice about it.
*/
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import {
  AGENT_MAX_OBJECTIVE_LENGTH,
  AGENT_REPORT_RESERVE_MS,
  AGENT_REPORT_RESERVE_TURNS,
  AGENT_WORKFLOW_BUDGETS,
} from "@/lib/agent/execution-policy";
/*
  The rail's single reading of what the selected mode executes. It is the safety strip's
  whole content, and the engine notice below is the same four levels read once more — so
  neither can state a bound the other contradicts. The consent sentence lives there too,
  beside the posture that quotes it.
*/
import { agentPosture } from "@/lib/agent/posture";
import {
  AGENT_WORKFLOW_PRESENTS_ANSWER,
  DEFAULT_AGENT_WORKFLOW_TYPE,
  type AgentChartSpec,
  type AgentRunMode,
  type AgentRunWorkflowReading,
  type AgentRunWorkflowSource,
  type AgentRunWorkflowType,
} from "@/lib/agent/types";
/*
  Type-only, and deliberately so: `workflow-classifier.ts` imports the AI SDK and the
  model adapter, so a value import would pull the server's model stack into this
  bundle. The same rule `use-agent-run.ts` follows for the capability probe.
*/
import type { AgentWorkflowClassification } from "@/lib/agent/workflow-classifier";
import { getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AnswerCard, answerCardState } from "./AnswerCard";
import { ConsentCard } from "./ConsentCard";
/*
  The pieces the answer card renders too, in the module they moved to when it was split
  out of this file: this file imports that card, so anything it shares with it cannot
  live here. Same components, same comments, same accessible names — see
  `rail-parts.tsx` for why a second copy was not the answer.
*/
import { guardReading, guardSummaryLine, HydrationControls, InfoNote, LIVE_STATUSES, QuotedBlock } from "./rail-parts";
import { SafetyStrip } from "./SafetyStrip";
import {
  type AgentBudgetGauge,
  type AgentPlanStatementView,
  type AgentTimelineItem,
  type AgentTimelineTone,
  describeFailureReason,
} from "./timeline";
import type { AgentPrefillRequest } from "./use-agent-prefill";
import { useAgentRun } from "./use-agent-run";

/**
 * The standalone agent rail (#329 T10a).
 *
 * Rendered only by `src/components/Studio.tsx` and only while the runtime flag says
 * this server runs agents. It is deliberately NOT exported from
 * `src/components/studio/index.ts`: that barrel is imported by the embedded shell,
 * so anything reachable from it is in the published package, and Phase 1 is
 * standalone-only.
 *
 * Two decisions worth stating where a reader would look for them:
 *
 *  - **Planning is the mode a run opens in.** It is the toolless one, and what a
 *    mode may actually do is decided server-side from the run's persisted mode
 *    (T6) — this surface only chooses what to ask for.
 *  - **A connection the server could not rebuild cannot be investigated.** A run
 *    persists a connection id and no credential, so a process resuming it re-resolves
 *    the connection server-side; settings living only in this browser could never be
 *    rebuilt there. Which connections qualify is decided before the rail sees them
 *    (`resolveAgentRunConnectionId`); the rail says so instead of posting a request
 *    that can only be refused.
 *
 * One instance serves both presentations. Above `md` it renders in the panel Studio
 * gives it; below `md` that panel is `display:none` and the same content is hosted
 * by a sheet, so the objective being typed and the run being followed survive the
 * move rather than being two independent rails.
 */

export interface AgentRailProps {
  /** The run's connection, already narrowed to a server-resolvable id, or null. */
  readonly connectionId: string | null;
  readonly connectionName: string | null;
  /** Below `md` only: whether the sheet presentation is open. */
  readonly sheetOpen?: boolean;
  readonly onSheetOpenChange?: (open: boolean) => void;
  /**
   * A shortcut's ask to open this rail on a question (#331 T1). Applied once per
   * request id, so the same ask made twice takes effect twice; it selects the workflow
   * and fills the objective, and it never starts a run.
   */
  readonly prefill?: AgentPrefillRequest | null;
  /**
   * Puts a statement the run drafted into the host's editor (#329 T11). Absent when
   * the host has no editor to put it in, and the control is then not rendered.
   */
  readonly onApplyStatement?: (sql: string) => void;
  /**
   * The engine this run's connection speaks, or null when nothing is selected. Read
   * for one sentence only: what a long read costs is not the same fact on every
   * engine, and SQLite's is the one a user consents to when they tick auto-execute.
   */
  readonly connectionType?: DatabaseType | null;
  /**
   * Puts a statement the RUN handed over into the host's editor and runs it there,
   * at the editor's own default row limit (§2.1). Distinct from `onApplyStatement`
   * because the two are different acts: that one is the user taking a statement, this
   * one is the run delivering the answer it was told to deliver.
   *
   * A host that omits it is not offered the auto-execute checkbox at all, and a run
   * this rail opens can then never record a hand-over. The alternative — offering the
   * promise and falling back to `onApplyStatement` — placed the statement unrun while
   * the timeline entry said it had run on the user's connection, which is the one
   * thing this surface may not do (#373). Nothing is lost by the narrowing: every
   * answer entry still offers its statement through `applySql`.
   *
   * It takes the RUN as well as the statement, and the run is the operative argument
   * (#373 review). The host does not execute the text it is handed: it asks
   * `POST /api/agent/runs/[runId]/handover`, which reads the statement off that run's
   * ledger and runs it under the engine's own read-only session. The `sql` is for the
   * editor to SHOW — it is what the user reads while the answer arrives.
   */
  readonly onRunStatement?: (sql: string, runId: string) => void;
  /**
   * Asks the host to show a result the run stored. The rail hands over identifiers
   * and nothing else: the rows are fetched and rendered by the surface that already
   * renders rows, so this component instantiates no grid of its own.
   *
   * `chartSpec` rides along for the one entry that has one — an answer the run
   * composed as a chart — so the host opens the surface the RUN named. It is the
   * ledger's own record, carried rather than derived: the rail holds no rows and
   * infers nothing from them.
   */
  readonly onShowArtifact?: (reference: {
    readonly runId: string;
    readonly correlationId: string;
    readonly chartSpec?: AgentChartSpec;
  }) => void;
}

const TONE_CLASSES: Readonly<Record<AgentTimelineTone, string>> = {
  neutral: "bg-fg-subtle",
  progress: "bg-blue-400",
  refused: "bg-amber-400",
  done: "bg-emerald-400",
};

const MODE_LABELS: Readonly<Record<AgentRunMode, string>> = {
  planning: "Plan",
  agent: "Agent",
};

/**
 * What the run is FOR, as opposed to how it executes. Offered in BOTH modes.
 *
 * It was agent-only until review pointed out that this made the rail unable to open
 * a planning run of a query optimization — "how would you make this faster?" — which
 * the epic's independent axes exist to allow. Toollessness decides which TOOLS a run
 * is offered, not what the run is about; the server frames the objective by workflow
 * in either mode.
 */
const WORKFLOW_LABELS: Readonly<Record<AgentRunWorkflowType, string>> = {
  investigation: "Investigate",
  "query-optimization": "Optimize",
  "database-assessment": "Assess",
  operations: "Operate",
  "data-analysis": "Analyze",
};

/**
 * What the user selected on the workflow axis: one of the five, or the server's
 * reading of the objective they wrote.
 *
 * `"automatic"` is the DEFAULT, and it is not a sixth workflow — no run ever opens for
 * it. It is the absence of a decision, resolved into one of the five by
 * `POST /api/agent/classify` at the moment Start is pressed, which is the earliest
 * moment the objective exists to read.
 */
type AgentWorkflowChoice = AgentRunWorkflowType | "automatic";

/**
 * The connection a start was asked ON, taken at the click and carried from there.
 *
 * `connectionId` is a prop: it is the connection the SHELL is on now, and `Studio` moves
 * it the moment the user selects another database. A start is no longer synchronous —
 * it waits on a classification, and may then wait on the user answering the consent step
 * — so reading the prop when the run is finally opened reads whatever is true THEN, not
 * what was true when Start was pressed. That is a run opened against a different
 * database from the one the rail displayed, and from the one the consent copy described
 * ("on the connection the run was opened on"), which is the one promise that copy makes
 * about where the statement lands.
 *
 * So it is snapshotted with the rest of the decision, exactly as the mode and workflow
 * axes are frozen for the same window (`startHeld`). The engine travels with it because
 * the consent copy has a sentence that is true of SQLite and of nothing else, and a
 * warning that disappears while the run still opens on SQLite is the same defect in a
 * smaller print size.
 */
interface AgentStartConnection {
  readonly id: string;
  readonly name: string | null;
  readonly type: DatabaseType | null;
}

/** One start, entirely decided: nothing below reads a control again. */
interface AgentDecidedStart {
  readonly workflowType: AgentRunWorkflowType;
  readonly source: AgentRunWorkflowSource;
  /** What the reading produced, or `"unrecorded"` where no reading was made. */
  readonly reading: AgentRunWorkflowReading;
  readonly objective: string;
  readonly connection: AgentStartConnection;
  /**
   * Whether opening this run has to STOP one first. Carried on the held start rather
   * than done at the click that decided the workflow: a start held at the consent
   * step is one the user can still abandon, and cancelling before they answered
   * would destroy the open run for a replacement that is never opened.
   */
  readonly replacesOpenRun: boolean;
}

/**
 * What the rail says about a workflow nobody chose — one sentence per recorded reading,
 * and three of them because the record has three answers and they are three different
 * statements.
 *
 * A total record rather than a chain of conditionals, which is the rule this file
 * follows for every union it renders: a reading added to `AgentRunWorkflowReading`
 * without a sentence here fails to compile instead of falling through to whichever arm
 * happens to be last.
 *
 * The third one is the reason the whole reading is persisted. It is what a rail says
 * about a run whose header carries a provenance and no outcome — the state a reload
 * used to resolve by ASSUMING success, so a run whose classification had failed was
 * read back to the user as "read from your objective". A record that does not say is
 * said as one that does not say.
 */
const OPENED_AS_SENTENCES: Readonly<Record<AgentRunWorkflowReading, (label: string) => string>> = Object.freeze({
  classified: (label) => `Opened as ${label}, read from your objective.`,
  unclassified: (label) =>
    `Opened as ${label}: your objective could not be classified, so the run investigates rather than being told what it is for.`,
  unrecorded: (label) =>
    `Opened as ${label}. Nobody here chose it, and this run's record does not say whether your objective was read into it or fallen back from.`,
} satisfies Record<AgentRunWorkflowReading, (label: string) => string>);

/**
 * How long this browser waits for `POST /api/agent/classify` before opening the run
 * without a classification.
 *
 * Stated here rather than imported from `workflow-classifier.ts`, which is a server
 * module: importing it would pull the AI SDK into this bundle, and the two numbers are
 * bounds on different things anyway — that one bounds a model call, this one bounds a
 * request and its response.
 *
 * Deliberately longer than the server's own ceiling (8 seconds, and stated in that
 * module) so it never preempts it: a classification the server is still within its
 * bound to produce must not be thrown away by the client. What this catches is the case
 * the server's bound cannot reach at all — a response that never arrives, from a proxy
 * holding the connection, a dropped socket, or a server restarted mid-request. Without
 * it the rail would sit on "Reading your objective" indefinitely with Start disabled.
 */
const CLASSIFY_REQUEST_TIMEOUT_MS = 15_000;

/** Whether a value the classify route returned is a workflow this build knows. */
const isWorkflowType = (value: unknown): value is AgentRunWorkflowType =>
  typeof value === "string" && Object.hasOwn(WORKFLOW_LABELS, value);

/**
 * How near the bottom still counts as the bottom, for the timeline that follows its
 * newest entry.
 *
 * Not zero: a fractional layout and a partly visible last entry both leave a few
 * pixels, and a user who dragged to the end should not have to land on the exact
 * pixel to be followed again.
 */
const TIMELINE_BOTTOM_SLACK_PX = 24;

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

/** The meter's own reading of one gauge, in the unit that gauge is bounded in. */
function readGauge(gauge: AgentBudgetGauge): string {
  if (gauge.unit === "ms") return `${seconds(gauge.used)} / ${seconds(gauge.limit)} s`;
  return `${gauge.used} / ${gauge.limit}`;
}

/**
 * What the run has left of that gauge, as a proportion. Clamped rather than
 * trusted: a bound can be overrun by up to one statement (`budgets.ts` says so),
 * and a bar past its own track would read as a larger allowance than exists.
 */
const gaugeFraction = (gauge: AgentBudgetGauge): number => Math.min(100, (gauge.used / gauge.limit) * 100);

/**
 * What a user whose model was refused can still do — in three registers, because a
 * refusal supports three different true statements (#331 T4 review).
 *
 * Each line is written out in full rather than composed from clauses: this is the copy a
 * user reads at the moment the product told them no, and a sentence assembled from
 * fragments is the kind that ends up claiming something no branch intended.
 *
 *  - Plan mode is on the table. Said as an invitation, never as a guarantee: the probe
 *    only ever sends a request WITH tools, so no refusal it can reach establishes that a
 *    toolless one would be served. "Still works with this model" was the claim before,
 *    and it was one the probe could not keep.
 *  - The endpoint was watched failing to stream. Then plan mode is not on the table —
 *    it reads the same `streamText().fullStream` — and saying so is more use than an
 *    offer that would end in a `succeeded` run with nothing in it.
 *  - Neither: a verdict raised for plan mode itself, which only a server that probes
 *    planning could produce. Pointing that user at the mode they are in says nothing, so
 *    the line is what remains true.
 */
function refusalActionText(planModeOffered: boolean, streamingDisproved: boolean): string {
  if (planModeOffered) {
    // "without reading the database" until 2026-08-15, when plan mode began grounding
    // itself: the SERVER reads the catalog and the engine's estimated statistics before
    // the first turn. What is still true is the sentence the mode is actually sold on,
    // and it is the one the user is given here.
    return "Plan mode needs no tools, so it may still work with this model: it reasons about your question and drafts a statement for you to run yourself. It runs no statement of yours and writes nothing. Try it, or configure a different model — one that passes the probe — for a run that investigates the database itself.";
  }
  if (streamingDisproved) {
    return "This endpoint answered without streaming, and plan mode reads the same stream, so it would produce nothing here either. A different model, or an endpoint that streams, is what gets an answer.";
  }
  return "A different model, one that passes the probe, is what gets a run that reads the database.";
}

/**
 * Prose the model wrote, in the structure it wrote it in (#389, #373 review).
 *
 * A component rather than inline JSX because it is now rendered in two places: bare
 * beside its entry, and inside the refusal card below, where the run's explanation of
 * what it could not do IS the card's content. The block itself is identical either
 * way — same test id, same border — so the "where the application stopped speaking"
 * boundary does not move depending on which ending a run reached.
 */
function ProseBlock({
  text,
  onApplySql,
  cardedStatement,
  className,
}: {
  readonly text: string;
  readonly onApplySql: ((sql: string) => void) | undefined;
  /**
   * This run's drafted statement, when the card beside this prose is already offering
   * it MARKED — in which case the per-block control inside this block is withheld and
   * the block holding that statement is not printed at all.
   *
   * A plan run's closing prose is the text its statement was read out of, so the same
   * SQL is in both places. Two consequences, and they are the same fact seen twice:
   *
   *  - #389's per-block "Apply to editor" says nothing about what it is applying —
   *    `renderProse` is handed text and knows nothing of the guard's verdict — so
   *    leaving it puts an unmarked control immediately above the marked one, against
   *    the SQL, which is the silent hand-off the marking exists to prevent;
   *  - and the BLOCK itself is the statement, printed a second time at full weight a
   *    few hundred pixels under the card that shows it (L2, measured 2026-08-21). The
   *    statement is carried rather than a flag so `renderProse` can suppress exactly
   *    that block and no other: any other fence in the plan is another statement, and
   *    the words around them are untouched.
   *
   * `Copy all` below is unaffected either way. It takes the string the model wrote, not
   * this rendering of it, so the whole prose — fence included — is still one click away.
   */
  readonly cardedStatement: string | undefined;
  readonly className: string;
}) {
  const apply = cardedStatement === undefined ? onApplySql : undefined;
  return (
    <div
      data-testid="agent-prose"
      className={cn("space-y-1 border-l border-hairline-strong pl-2 text-fg-tertiary", className)}
    >
      {renderProse(text, { onApplySql: apply, cardedStatement })}
      {/*
        And the plan as a whole, in the markdown the model wrote rather than in the
        rendering above: what a user pastes into a ticket is the text, and the text is
        what was recorded.
      */}
      <CopyButton text={text} testId="agent-prose-copy" label="Copy all" />
    </div>
  );
}

/**
 * What a PLAN run produced, as it is recorded in the CHRONOLOGY — a headline, a
 * timestamp and one line saying what the guard made of it.
 *
 * It used to be the whole card: the statement verbatim, the guard's paragraph, the
 * identifier findings, the caveat and the editor hand-off. All of that moved UP, into
 * `AnswerCard`, when the redesign put the run's outcome at the top of the rail — and
 * moved rather than being copied, which is the point of this file being shorter. The
 * reasoning that card carries is the reasoning that used to be here, and it is worth
 * restating why the hand-off may not be in both places:
 *
 * The owner's ruling is that plan mode MAY draft a write and must never hand one over
 * quietly. So the marking is a correctness property, not decoration: the mark is in the
 * applying control's accessible NAME (`applyStatementName`, in `rail-parts.tsx`), because
 * a colour and a border say nothing to a screen reader, and it states what the GUARD did
 * rather than what the SQL does — `readOnly` is `inspectAgentStatement(sql) === null`, and
 * four of that guard's six objections say only that it could not settle the text.
 *
 * **And there is exactly ONE such control.** The closing prose the statement was read out
 * of has its per-block "Apply to editor" withheld (`planStatementRecorded`) because
 * `renderProse` is handed text and cannot say what it is applying; this entry now reprints
 * no statement at all, so it offers nothing to apply either. An unmarked control against
 * the statement, one line above the marked one, is the control a user reaches for first — it is
 * the silent hand-off the marking exists to prevent, and the answer card being a SECOND
 * rendering of this entry is precisely the arrangement that could have reintroduced it.
 *
 * `data-read-only` stays, carrying the guard's own verdict as data rather than as a class
 * name, so the distinction can be asserted in a test instead of inferred from styling —
 * three values since #414, because `"unexamined"` is a verdict the guard did not reach and
 * reads as neither `"true"` nor an objection.
 */
function PlanStatementCard({ draft }: { readonly draft: AgentPlanStatementView }) {
  return (
    <section
      data-testid="agent-plan-statement"
      data-read-only={!draft.guardApplicable ? "unexamined" : draft.readOnly ? "true" : "false"}
      className={cn(
        "mt-1 ml-3.5 rounded border p-1.5",
        draft.readOnly ? "border-hairline-strong" : "border-amber-400/50 bg-amber-500/5",
      )}
    >
      {/*
        The one-line reading, from the module both surfaces read it out of: the answer
        card states the same thing and then the whole claim behind it, and two authors
        for a sentence about what examined a statement is how the two come to disagree.
      */}
      <p
        data-testid="agent-plan-statement-summary"
        className={cn("text-[0.625rem]", guardReading(draft) === "checked" ? "text-fg-muted" : "text-amber-300")}
      >
        {guardSummaryLine(draft)} The statement, what the name check found and what applying it would and would not
        establish are in the answer at the top of this rail.
      </p>
    </section>
  );
}

/**
 * One timeline entry's content, so the chronology and the folded scaffolding inside it
 * render the same entry the same way (item 7 of the redesign).
 *
 * A component rather than a second copy of the JSX: the chrome entries are collapsed
 * behind one summary line and are still rendered IN FULL when it is opened — the
 * objective quoted under the run's header included — and two renderings of an entry
 * would be two places for the boundary between the app's words and everyone else's to
 * move.
 */
function TimelineEntryBody({
  item,
  onApplyStatement,
  showArtifact,
  declinedHandovers,
  cardedAnswerId,
  cardedStatement,
  planCarded,
}: {
  readonly item: AgentTimelineItem;
  readonly onApplyStatement: ((sql: string) => void) | undefined;
  readonly showArtifact: ((correlationId: string, chartSpec: AgentChartSpec | undefined) => void) | undefined;
  readonly declinedHandovers: readonly { readonly id: string; readonly openedOn: string | null }[];
  /** The entry whose hand-off the answer card is already offering, or undefined. */
  readonly cardedAnswerId: string | undefined;
  /**
   * The STATEMENT the answer card is handing over, in either of the two states that
   * hand one over, or undefined.
   *
   * By text rather than by entry id, which is what makes this a de-duplication of one
   * statement rather than the removal of an affordance (L6, measured 2026-08-21). An
   * agent run drafts each statement it executes, and the answer's `sql` IS the
   * statement of the step whose artifact it presents — so a one-read run had the same
   * text offered by the card, by that `Statement drafted` entry and by the report
   * section's citation, three times, none of them named. A read the run took along the
   * way whose statement is NOT the answer's is another statement, and it keeps its own
   * control.
   */
  readonly cardedStatement: string | undefined;
  /**
   * Whether the answer card is RENDERING the drafted statement — which is what makes
   * withholding this entry's copy of the hand-off a de-duplication rather than a
   * removal. Off the card's own state reading, never off the ledger: an entry can
   * carry `planStatementRecorded` while the card is showing something else.
   */
  readonly planCarded: boolean;
}) {
  /*
    The guard's reading, said once (L3). Measured on the MongoDB plan run: the card's
    guard line, then THIS paragraph — four lines of it — then the amber summary box
    below, all inside ~400px. One fact, three renderings, two of them long.

    So the entry the card is rendering gives up the paragraph and keeps the one-line
    summary (`PlanStatementCard`), and the full text is where it already was: in the
    card's ⓘ, which carries both of these sentences verbatim under their own test ids.
    Every other entry's detail is untouched — it is the only place its own fact is said.
  */
  const detail = planCarded && item.planStatement !== undefined ? undefined : item.detail;

  return (
    <>
      <div className="flex items-center gap-2">
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", TONE_CLASSES[item.tone])} />
        <span className="text-xs text-fg-secondary">{item.headline}</span>
      </div>
      {detail !== undefined && <p className="mt-0.5 pl-3.5 text-xs text-fg-muted">{detail}</p>}
      {/*
        Prose the MODEL wrote, rendered with the structure it wrote it in
        (#373 review). Measured in plan mode against a live model: the closing
        statement arrived as markdown and reached the user as hash marks and
        asterisks, and plan mode's whole output is this one block.

        Inside its own bordered block, which is the half that has to survive
        being readable: `renderProse` builds React nodes and reaches no HTML
        parser, so nothing here can execute — but a heading a model wrote must
        still not read as a heading the application wrote, and the rule that
        the app's words and everyone else's never share a line is what the
        border keeps true.
      */}
      {/*
        The editor is offered to the statements INSIDE the prose (#389), EXCEPT on
        the entry a plan run's statement was read out of.

        That exception is the whole marking requirement, not a detail of it. The
        closing prose of a plan run HOLDS the fenced statement, so without it the
        same `DELETE` renders twice: once in the card below, amber, with the guard's
        verdict and an accessible name that carries it — and once here, immediately
        above it, as a plain grey "Apply to editor" with no mark and no name, which
        is the control a user reaches for first because it sits against the SQL.
        `renderProse` cannot label it: it is handed text and knows nothing of the
        ledger. So the marked hand-off is the only hand-off, and the block keeps its
        clipboard. Everywhere else — an agent run, a plan run that drafted nothing —
        #389's control is untouched, because there is no card there to defer to.

        A host with no editor passes nothing and is offered nothing, the rule every
        other affordance in this rail follows.

        A refusal is the same prose in a different frame. The run reached its other
        legitimate ending — it says the schema does not answer the question — and
        that is what the card states; the marker the ledger read it by was stripped
        on the way here, because it is a protocol token the model was told to emit
        and not a sentence it wrote for anyone to read.
      */}
      {item.prose !== undefined &&
        (item.planRefusal === true ? (
          <section
            data-testid="agent-plan-refusal"
            className="mt-1 ml-3.5 rounded border border-amber-400/40 bg-amber-500/5 p-1.5"
          >
            {/*
              Says only that the run could not draft, never WHY — the two reasons
              are different and this card cannot tell them apart. A grounded run
              refuses because the inventory it was given does not reach the
              question; an ungrounded one (a reading that was refused, that
              overran its time, or a provider that cannot describe its own
              schema — the engine alone stopped deciding it in #414) refuses
              because there was no inventory at all. The earlier wording named "the schema it read",
              which on the second path is a reading that never happened.
            */}
            <p className="text-[0.625rem] text-amber-300">
              This run drafted no statement. What it says is missing, and what it needs from you, are in its own words
              below.
            </p>
            <ProseBlock
              text={item.prose}
              onApplySql={onApplyStatement}
              cardedStatement={planCarded && item.planStatementRecorded === true ? cardedStatement : undefined}
              className="mt-1"
            />
          </section>
        ) : (
          <ProseBlock
            text={item.prose}
            onApplySql={onApplyStatement}
            cardedStatement={planCarded && item.planStatementRecorded === true ? cardedStatement : undefined}
            className="mt-1 ml-3.5"
          />
        ))}
      {/*
        The run's own deliverable, with what the server established about it. Its
        own card rather than a line beside the entry, because a statement a user
        may be about to run is the one thing on this surface that can do damage
        if it is presented as something it is not.
      */}
      {item.planStatement !== undefined && <PlanStatementCard draft={item.planStatement} />}
      {/*
        The one place this surface contradicts the ledger, and it does so beside
        the sentence it contradicts. The entry above is folded from what the RUN
        recorded — that it handed the statement over to be run — and this rail
        declined to perform it, so a reader who saw only the entry would believe
        an execution that never happened. Said here rather than in a banner:
        the fact is about this answer, and a notice elsewhere would be a
        sentence the reader has to match to a line themselves.
      */}
      {declinedHandovers
        .filter((declined) => declined.id === item.id)
        .map((declined) => (
          <p
            key={declined.id}
            data-testid="agent-handover-declined"
            className="mt-0.5 pl-3.5 text-xs text-amber-400/80"
          >
            It was not run: this run was opened on {declined.openedOn ?? "another connection"} and your editor has moved
            to a different one since. The answer would have arrived in a tab that is connected somewhere else, so
            nothing was executed. The statement is below — take it yourself if you want it on the connection you are on
            now.
          </p>
        ))}
      {/*
      Verbatim content from the model, the engine or the user, kept in its own
      block rather than folded into a sentence: it is untrusted input, and the
      user should be able to see where the app stops speaking.
    */}
      {item.quoted !== undefined && (
        <QuotedBlock text={item.quoted} testId="agent-quoted-copy" className="mt-1 ml-3.5" />
      )}
      {/*
        Withheld on the ONE entry the answer card is already offering these for (item 8
        of the redesign), and rendered here for every other entry exactly as before.

        The card renders this entry a second time — that is what it is — so leaving both
        would put two "Apply to editor" controls in the rail for one statement, with
        nothing on either saying they are the same act. A read the run took along the way
        keeps its own controls, because it is another statement and the card renders none
        of them — unless it IS the card's statement, which is what the `sql` below is
        about: the run records every statement it executes, so the answer's own text is
        on the ledger twice.
      */}
      {item.id !== cardedAnswerId && (
        <div className="ml-3.5">
          <HydrationControls
            /*
              And withheld for the STATEMENT the card is handing over, wherever it
              appears (L6). The entry above is the answer's own; this covers the
              `Statement drafted` entry that recorded the same text one step earlier,
              which is how the report path came to offer the same statement twice under
              two different names. Anything else the run drafted is another statement
              and keeps its control — a result to SHOW is untouched either way, since the
              card offers only the answer's.
            */
            sql={item.applySql === cardedStatement ? undefined : item.applySql}
            artifactId={item.artifactId}
            chartSpec={item.chartSpec}
            testIdPrefix="agent-"
            onApply={onApplyStatement}
            onShow={showArtifact}
          />
        </div>
      )}
    </>
  );
}

/**
 * One workflow the open run can be swapped for. Its own component because the per-item
 * handler belongs with the item rather than in the rail's render: an arrow that closes
 * over both a `.map()` parameter and the rail's whole start chain is what costs the
 * compiler its view of the rail's refs, and two effects below are then reported as
 * missing dependencies they cannot legally take.
 */
function ChangeWorkflowButton({
  candidate,
  onSelect,
}: {
  readonly candidate: AgentRunWorkflowType;
  readonly onSelect: (next: AgentRunWorkflowType) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`agent-change-workflow-${candidate}`}
      aria-label={`Stop this run and open a new ${WORKFLOW_LABELS[candidate]} run`}
      onClick={() => onSelect(candidate)}
      className="px-2 py-0.5 rounded text-xs font-normal text-fg-muted hover:bg-fill transition-colors"
    >
      {WORKFLOW_LABELS[candidate]}
    </button>
  );
}

export function AgentRail({
  connectionId,
  connectionName,
  connectionType = null,
  sheetOpen = false,
  onSheetOpenChange,
  onApplyStatement,
  onRunStatement,
  onShowArtifact,
  prefill = null,
}: AgentRailProps) {
  const [mode, setMode] = useState<AgentRunMode>("planning");
  /**
   * The workflow axis, which is now a choice the user need not make: Automatic until
   * they say otherwise, and the five are one disclosure away.
   */
  const [workflowChoice, setWorkflowChoice] = useState<AgentWorkflowChoice>("automatic");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [objective, setObjective] = useState("");
  /**
   * The classify request is in flight. Its own flag rather than `run.isBusy`: no run
   * exists yet, and the hook reports on runs.
   */
  const [classifying, setClassifying] = useState(false);
  /**
   * A start that is decided but not made, waiting on the one consent this surface asks
   * for. Null in every other state, so the consent step exists exactly while a start is
   * held.
   *
   * Consent is asked BEFORE the run opens rather than after, which is what keeps
   * `src/lib/agent/types.ts`'s invariant intact: every widening decision is made by the
   * request that opens the run, and no later request may widen it.
   */
  const [pendingStart, setPendingStart] = useState<AgentDecidedStart | null>(null);
  /** The consent step's own tick, reset every time that step is entered. */
  const [autoExecute, setAutoExecute] = useState(false);
  /**
   * What the OPEN run was opened with, which is a different question from what the tick
   * says now: the tick belongs to a consent step that no longer exists, and the safety
   * strip beside a running run has to read that run's own boundary. Set from the same
   * resolution the open request carried, so the strip cannot say "one statement in your
   * editor" about a run the server was never asked to widen.
   */
  const [openedWithHandover, setOpenedWithHandover] = useState(false);
  /**
   * The user asked to write in the objective box while a run is open.
   *
   * The box is a one-line summary during a run — the question is settled, and three rows
   * of textarea for text nobody can change is the space the answer needed — so this is
   * the way back to it. It is reset when a run opens, beside the clearing of the box
   * itself: an edit begun against one run is not a state to carry into the next.
   */
  const [editingObjective, setEditingObjective] = useState(false);
  /**
   * A "change" whose cancellation the server did not accept, so no replacement was
   * opened and the run the user asked to end is still going.
   *
   * State rather than a sentence derived from `run.error`: the hook's message says what
   * the DELETE answered, and what a user needs beside it is what this rail did about it
   * — which is nothing, deliberately, because opening the replacement anyway is how two
   * runs end up executing on one connection.
   */
  const [replaceFailed, setReplaceFailed] = useState(false);
  /** Whether the way out of an inferred workflow is currently unfolded. */
  const [changeOpen, setChangeOpen] = useState(false);
  /**
   * The user has asked for the NEXT question to start a conversation of its own.
   *
   * It takes effect on a start that has not happened yet, so it gets a visible state
   * line of its own: a control whose effect is delayed owes one, or the user cannot
   * tell the click landed. `agent-change-failed` records the same lesson one control
   * along. Cleared by the start it applied to.
   */
  const [startFresh, setStartFresh] = useState(false);
  /**
   * The last start dropped a conversation because the connection had moved.
   *
   * The rail's own sentence rather than the server's: it is a deliberate, correct
   * behaviour and the rail is the layer that knows it happened, while the server's
   * `declined` collapses five causes it may not tell apart.
   */
  const [connectionDropped, setConnectionDropped] = useState(false);
  /** An ask that arrived while the user was typing, waiting for them to take it. */
  const [offeredObjective, setOfferedObjective] = useState<string | null>(null);
  const run = useAgentRun();

  /*
    Which ceilings the meter states: the ones the server is enforcing on the run the
    meter is reporting, folded out of that run's own header. NOT the workflow the
    buttons above show — the picker stays live while a run is in flight, and a user
    who clicks another workflow mid-run must not be shown figures nothing is
    enforcing. It is also the same source the gauges beside this line are built from,
    so the two halves of the meter cannot disagree; before any run exists both read
    the default the fold takes for a ledger with no header.
  */
  /*
    Before any run exists there is no header to read, so the pre-start line states the
    ceilings of the workflow the user NAMED — and under Automatic it states nothing at
    all, because there is no such workflow yet. Any specific figure shown while the
    workflow is still the classifier's to decide would be a claim this rail cannot
    keep: a run it opens as `data-analysis` is bounded quite differently from the
    investigation these figures default to.
  */
  const preStartWorkflow = run.runId === null && workflowChoice !== "automatic" ? workflowChoice : null;
  const meterBudget = AGENT_WORKFLOW_BUDGETS[preStartWorkflow ?? run.timeline.workflowType];
  const showBudgetLimits = run.runId !== null || preStartWorkflow !== null;

  /*
    The sheet is a mobile presentation, and the breakpoint has to be read rather than
    expressed as a class: `SheetContent` can be told `md:hidden`, but the overlay
    Radix renders beside it cannot, and it also sets `pointer-events: none` on the
    body. A window widened past `md` with the sheet open would otherwise leave a
    full-screen scrim over an app that no longer shows the rail. So the presentation
    is chosen from the same `useIsMobile` the connection modal already uses, and the
    caller's flag is reconciled when the crossing takes the sheet away.
  */
  const isMobile = useIsMobile();
  const wasMobile = useRef(isMobile);
  useEffect(() => {
    // Only on a real crossing. `wasMobile` is seeded from the first render's answer,
    // so closing on "not mobile" alone would shut the sheet on every desktop render,
    // including the one that opened it.
    if (wasMobile.current && !isMobile && sheetOpen) onSheetOpenChange?.(false);
    wasMobile.current = isMobile;
  }, [isMobile, sheetOpen, onSheetOpenChange]);

  /** Which ask has been applied, and the text the last one put in the box. */
  const appliedPrefillId = useRef<number | null>(null);
  const prefilledObjective = useRef<string | null>(null);

  /*
    The prefill seam (#331 T1).

    An ask is an EVENT the shell delivers as a prop, not a value to derive state from,
    which is why it is applied in an effect and keyed on the request's ID: two clicks
    on the same shortcut are two asks, and a request compared by value would make the
    second one a prop that did not change.

    Whether the sheet must be opened is decided HERE, from the viewport itself
    (`isMobileViewport`) rather than from `useIsMobile`. This effect runs after commit
    and only on the client, so the platform's answer is exact at the moment the ask is
    served. The hook answers exactly too since it moved to `useSyncExternalStore`, but
    what it hands back is the value of the render this effect closed over, not the
    platform's answer at the instant the effect runs. Opening the sheet is a decision
    taken once, at that instant, so it asks the platform rather than the render.

    That replaced a ref recording an "owed" open, paid the next time the hook reported
    mobile. The T1 adversarial recheck showed it carried two defects (R1, R2): on a
    real desktop the hook's value never changed, so the debt was never discharged and
    the first narrowing of the window opened the sheet for an ask the user had already
    been served in the panel — the exact thing that code's comment claimed could not
    happen — and the debt was keyed to the REQUEST rather than to the open it owed.
    Reading the viewport directly leaves nothing to owe and nothing to pay later, so
    both defects are gone rather than guarded.

    Nothing here starts a run. That is the seam's rule rather than an omission — a
    shortcut is worth one click, and a click that also spent model tokens and read a
    database would be a different feature.
  */
  useEffect(() => {
    if (prefill === null || appliedPrefillId.current === prefill.id) return;
    appliedPrefillId.current = prefill.id;

    // Applied either way: the workflow is a visible control holding nothing the user
    // typed, and one click puts it back. A shortcut names the workflow it means, so it
    // is an explicit CHOICE — the run it starts is not classified — and the disclosure
    // is unfolded with it, because a choice made on the user's behalf behind a closed
    // panel is one they cannot see or undo.
    setWorkflowChoice(prefill.workflowType);
    setAdvancedOpen(true);

    /*
      An objective the user is typing is theirs. It is not overwritten — and it is not
      dropped either, or the shortcut would look broken: the ask waits on one line the
      user can accept. "Theirs" means text they typed, so a box that is empty, blank,
      or still holds exactly what the last ask put there is one nobody has touched.
    */
    if (objective.trim().length === 0 || objective === prefilledObjective.current) {
      setObjective(prefill.objective);
      prefilledObjective.current = prefill.objective;
      // An offer the PREVIOUS ask left is about a box that no longer says what it
      // said. Left standing it reads "Suggested: A" under an objective that already
      // says B — the state a user reaches by answering an offer with an emptied box
      // rather than by taking it.
      setOfferedObjective(null);
    } else {
      setOfferedObjective(prefill.objective);
    }

    /*
      Below `md` the panel this rail renders into is display:none, so filling it
      without opening the sheet would fill a surface nobody can see. The flag itself
      stays the shell's, so this is an ask rather than a set. Above `md` there is
      nothing to open: the rail is already the panel, the ask is already served, and
      the crossing is left entirely to the reconciliation effect above.
    */
    if (isMobileViewport()) onSheetOpenChange?.(true);
  }, [prefill, objective, onSheetOpenChange]);

  /**
   * A start that has been asked for and has not opened a run yet: its classification is
   * in flight, or the consent step is holding it.
   *
   * Both axes are frozen for exactly this window, and that is a correctness rule rather
   * than a nicety. `handleStart` is asynchronous — it awaits the classification, which
   * the server may spend seconds on — and everything it calls afterwards is the closure
   * of the render the click happened in. A mode switched underneath it would therefore
   * be discarded in silence: the open request would carry the mode that was pressed
   * while the rail displayed the other one, opening a tool-carrying agent run under a
   * rail showing Plan — the toolless mode, and a deliberate narrowing. The mirror case
   * is worse still: the consent step, which by construction exists only in agent mode,
   * would be raised over a rail in plan mode, which is the class of mismatch
   * `AGENT_WORKFLOW_PRESENTS_ANSWER` was written to end and which shipped once already.
   *
   * Frozen rather than re-read, because the alternative is a start whose meaning
   * changes after it was asked for. The window closes on its own, and Cancel leaves it
   * immediately.
   */
  const startHeld = classifying || pendingStart !== null;

  /*
    The consent step arrives after an asynchronous classification, which means it
    arrives while the user is looking somewhere else — and, for a user who is not
    looking at all, it arrived silently: a region inserted below a Start button that
    became disabled in the same commit, with no role, no announcement and no focus
    (#407 review, and this repo's own a11y history in #100).

    Two halves, and both are needed:

     - it is a `<section>` with an accessible NAME, so it is a region a screen reader
       announces and can navigate back to. The name is the sentence naming the workflow
       and the connection, and the terms are its description, so entering it reads out
       what is being consented to rather than "group";
     - focus MOVES into it. That is the announcement for a keyboard user, who otherwise
       has focus on a control that just went disabled and no way to know two buttons
       appeared. `tabIndex={-1}` makes the region focusable programmatically and leaves
       it out of the tab order, which is the pattern for a region you move focus TO
       rather than through.

    Leaving it puts focus somewhere real rather than on a node about to be removed —
    `leaveConsent` below decides where, and the two exits need different answers.
  */
  const consentRegion = useRef<HTMLElement | null>(null);
  const startButton = useRef<HTMLButtonElement | null>(null);
  const objectiveBox = useRef<HTMLTextAreaElement | null>(null);
  /** Where focus goes when the step closes, recorded by the exit that closed it. */
  const focusAfterConsent = useRef<"start" | "objective" | null>(null);
  /*
    Both directions in one effect, and it has to be an EFFECT rather than a line in each
    handler: the destination's own disabled state is derived from `pendingStart`, so at
    the moment a handler runs it still holds the value the handler is about to change.
    Focusing Start there focuses a button that is still disabled — which does nothing at
    all, and leaves focus on the region as it is unmounted.
  */
  useEffect(() => {
    if (pendingStart !== null) {
      consentRegion.current?.focus();
      return;
    }
    const destination = focusAfterConsent.current;
    if (destination === null) return;
    focusAfterConsent.current = null;
    (destination === "start" ? startButton.current : objectiveBox.current)?.focus();
  }, [pendingStart]);

  /**
   * Closes the consent step and says where focus lands, which is the half a
   * `setState(null)` alone leaves undone: the focused node is inside the region about to
   * be unmounted, so the browser drops focus to the body and a screen-reader user is
   * left nowhere.
   *
   * The destination differs by exit, and neither choice is arbitrary. **Cancel** returns
   * to Start, the control that raised this and the one that is live again the moment it
   * is pressed. **Open** cannot: Start is disabled from the instant the run is busy, and
   * focus on a control that disables under it is focus lost a beat later. So an opened
   * run lands focus in the objective box, which is enabled, is where the next question
   * is written, and is beside everything the run is about to say.
   */
  const leaveConsent = (to: "start" | "objective"): void => {
    focusAfterConsent.current = to;
    setPendingStart(null);
  };

  const canStart = connectionId !== null && objective.trim().length > 0 && !run.isBusy && !startHeld;

  /*
    Whether a hand-over is a thing this rail may promise at all — three conditions, and
    the consent step, the start request and the delivery below all read this one value.

    Agent mode and a workflow that is offered `present_answer` are the server's own
    rule: a run with no such tool has nothing to hand over, and the route refuses the
    setting outright.

    `onRunStatement` is the HOST's half, and it was missing (#373 review). It is an
    optional public prop, so an embedding host may have no way to run a statement at
    all — and the rail used to offer the checkbox anyway and fall back to
    `onApplyStatement`, which placed the statement unrun while the timeline entry told
    the user it had run on their connection. A control that promises what this host
    cannot perform is not offered, which is the rule the stop control and the hydration
    affordances already follow.
  */
  const canHandOver = (candidate: AgentRunWorkflowType): boolean =>
    mode === "agent" && AGENT_WORKFLOW_PRESENTS_ANSWER[candidate] && onRunStatement !== undefined;

  /**
   * The connection this run was opened on, kept for as long as the rail follows it.
   *
   * `connectionId` is the connection the HOST is on NOW: it is resolved from the
   * active connection on every render, so it moves the moment the user selects
   * another database. The run's own connection does not move — it is persisted on the
   * run record, and every row the run read came from it. The two are the same value
   * until a user switches mid-run, and telling them apart is the whole of the check
   * below.
   */
  const openedOn = useRef<{ readonly id: string; readonly name: string | null } | null>(null);
  // Read off the run rather than held here: the thread has one writer and it is the
  // route, so what the strip renders is what was recorded on the run.
  const threadSteps = run.thread?.steps ?? [];
  const threadDeclined = run.thread?.declined;

  /**
   * The objective the OPEN run was opened with.
   *
   * Kept because the box is emptied the moment the server opens a run (below), and
   * "change" has to re-ask the same question against another workflow. Reading the
   * textarea then would re-ask an empty one, or worse, whatever the user has begun
   * typing since.
   *
   * State rather than the ref it was until the redesign: the objective is RENDERED now —
   * the box becomes a one-line summary of it while the run is open — and a ref read during
   * render is a value React is free to have changed without a re-render, which is what the
   * compiler's own rule says. The handlers that read it are called from the render that
   * holds the current value, so nothing about "change" changes.
   */
  const [openedObjective, setOpenedObjective] = useState("");

  /*
    Opening the run, once every decision it carries has been made.

    Both axes are always sent. They are independent (#325): a planning run of a query
    optimization is an ordinary thing to ask for, and sending the workflow only in
    agent mode made the rail unable to express one. `workflowSource` goes with them
    because the surface owes the user a different sentence in each case, and the run
    record is the only place that survives a reload.

    The hand-over setting is resolved through `canHandOver` one last time rather than
    taken from the tick alone: the host's runner can move between the consent step and
    this call, and `true` on a run that cannot present an answer is refused outright by
    the route. The mode axis cannot move — it is frozen from the click that started this
    sequence until the run opens or the user abandons it (see the mode buttons below) —
    because this function is the closure of the render the click happened in, and a mode
    switched underneath it would open a run in one mode while the rail showed the other.

    A run being REPLACED is stopped here, at the moment its replacement is actually
    being opened, and not at the click that chose the new workflow. That click may still
    be abandoned at the consent step, and a cancellation fired there would end the open
    run for a replacement that never arrives — with the objective box already emptied,
    leaving the user nothing to re-ask with. `run.cancel()` is the same ask the Stop
    control makes, awaited so the DELETE is sent before `start` aborts the controller
    that carries it.

    **And the replacement is opened only if that stop was ACCEPTED.** The ask can be
    refused — the run may be gone, the server may answer 5xx, the request may never
    arrive — and awaiting it establishes only that it was made. Opening anyway left the
    original run executing beside its replacement, on the same connection, spending its
    own budget, with the rail following the new one and nothing on screen saying the old
    one was still going: the copy beside "change" promises a cancel-and-replace, and this
    is what keeps that promise rather than describing it. A stop that failed opens
    nothing and says so (`replaceFailed`), which leaves the user the run they had and the
    control that offers to try again.

    Every value it acts on comes off `decided`, including the connection: this function
    is the closure of the render its `hold` happened in on one path and is called from
    the LATEST render on the other, and the shell's connection can move under both.
  */
  const beginRun = async (decided: AgentDecidedStart & { readonly autoExecute: boolean }): Promise<void> => {
    if (decided.replacesOpenRun && !(await run.cancel())) {
      setReplaceFailed(true);
      return;
    }
    setReplaceFailed(false);
    /*
      Which run's CONVERSATION this one continues.

      An ordinary follow-up continues the run that just ended. A REPLACEMENT continues
      what the run it replaces continued — not that run, which is being thrown away:
      `run.thread.steps` last entry IS that predecessor, and it comes off the server's
      own record rather than off anything the browser inferred, because the thread has
      one writer.

      The id travels to the route, which re-derives the conversation from those runs'
      own ledgers rather than trusting anything here.
    */
    const continueTarget = decided.replacesOpenRun
      ? run.thread?.steps.at(-1)?.runId
      : run.runId !== null && !LIVE_STATUSES.has(run.timeline.status)
        ? run.runId
        : undefined;
    // Two reasons the rail withholds an id it has, and it OWNS both sentences: the
    // server's own refusal collapses five causes it must not tell apart, while these
    // two are deliberate and specific, so saying "could not be reached" of either
    // would blame a failure for a choice.
    const connectionHeld = openedOn.current?.id === decided.connection.id;
    const droppedForConnection = continueTarget !== undefined && !connectionHeld;
    const previousRunId = startFresh || !connectionHeld ? undefined : continueTarget;
    setConnectionDropped(droppedForConnection);
    setStartFresh(false);
    openedOn.current = { id: decided.connection.id, name: decided.connection.name };
    setOpenedObjective(decided.objective);
    /*
      What has already been delivered is about the run that is ending here, and the
      two effects below key that on the run id changing. They may not SEE it change:
      a server is free to name the new run what it named the last one, and a start is
      no longer made synchronously inside the click — the classification comes first,
      so `start`'s own `setRunId(null)` may be batched away with the id that follows
      it. Cleared here, where a new run is known to be beginning, rather than inferred
      from a render that may never happen. Both effects still reconcile their own
      marker, so this is a reset and not a second source of truth.
    */
    shownAnswerRunId.current = null;
    shownAnswers.current.clear();
    handedOverRunId.current = null;
    handedOver.current.clear();
    setChangeOpen(false);
    // The same resolution the request carries, kept for the strip beside the run: what
    // this run may do is what was SENT, not what a control says afterwards.
    const handover = canHandOver(decided.workflowType) && decided.autoExecute;
    setOpenedWithHandover(handover);
    void run.start({
      mode,
      workflowType: decided.workflowType,
      workflowSource: decided.source,
      // Sent on every start, `"unrecorded"` included: the run record is where the
      // sentence this rail owes is read back from, and a start that says nothing about
      // its reading is one a reloaded rail cannot describe.
      workflowReading: decided.reading,
      autoExecute: handover,
      objective: decided.objective,
      connectionId: decided.connection.id,
      // Sent only when this run genuinely continues the last one; the route refuses
      // anything else, and nothing later may change which run this one was told about.
      ...(previousRunId === undefined ? {} : { previousRunId }),
    });
  };

  /**
   * The server's reading of the objective, or the fallback it is designed to reach.
   *
   * Every failure lands on the same answer — a refused request, a body that is not
   * JSON, a workflow id this build does not know, and the route's own `unclassified`
   * outcome all resolve to an investigation marked unclassified. That is the
   * classifier's own contract (`workflow-classifier.ts`: never throws, never blocks a
   * run), held again here because the network between it and this component can fail
   * in ways it cannot: a start that a transient model failure made impossible would be
   * strictly worse than a run the user can see was not classified.
   *
   * Which is why this request carries a ceiling of its own. The server bounds the model
   * call so that no model failure can block a start; a browser `fetch` has no default
   * timeout at all, so without one here a response that is never delivered — a proxy
   * holding the connection, a suspended socket, a server restarted mid-request — would
   * leave Start disabled and this rail unable to open any run until the page is
   * reloaded. That is the very failure the server's bound exists to prevent,
   * reintroduced in front of the same button. An abort lands in the `catch` below, so
   * it reaches the fallback every other failure reaches.
   */
  const classifyObjective = async (text: string): Promise<AgentWorkflowClassification> => {
    try {
      const res = await fetch("/api/agent/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective: text }),
        signal: AbortSignal.timeout(CLASSIFY_REQUEST_TIMEOUT_MS),
      });
      const body = (await res.json()) as { workflowType?: unknown; outcome?: unknown };
      if (res.ok && body.outcome === "classified" && isWorkflowType(body.workflowType)) {
        return { workflowType: body.workflowType, outcome: "classified" };
      }
    } catch {
      // Falls through to the same answer every other failure reaches.
    }
    return { workflowType: DEFAULT_AGENT_WORKFLOW_TYPE, outcome: "unclassified" };
  };

  /*
    The one step between a decided workflow and an open run.

    It exists for exactly one workflow and one mode, and `canHandOver` is what says so:
    `data-analysis` is the only workflow offered `present_answer`, agent mode is the
    only mode with tools at all, and a host with no runner cannot perform the hand-over
    whatever the run decides. Everything else opens uninterrupted, because there is
    nothing to consent TO — a checkbox offered where the tool is not is the mismatch
    `AGENT_WORKFLOW_PRESENTS_ANSWER` was written to end, and it shipped once already.
  */
  const hold = (decided: AgentDecidedStart): void => {
    if (canHandOver(decided.workflowType)) {
      setAutoExecute(false);
      setPendingStart(decided);
      return;
    }
    void beginRun({ ...decided, autoExecute: false });
  };

  /*
    Start, as the small state machine the design asks for: idle -> classifying ->
    consent? -> starting.

    An explicit choice under Advanced SKIPS the classification entirely, and that is a
    requirement rather than an optimisation: it spends no latency and no model tokens
    on a decision that has already been made, and it means the user who knows exactly
    what they want never depends on the least reliable component in the path.
  */
  const handleStart = async (): Promise<void> => {
    if (connectionId === null || !canStart) return;
    const asked = objective.trim();
    // Taken HERE, at the click, and carried through both paths below: everything after
    // this line can happen after the shell has moved to another database.
    const connection: AgentStartConnection = { id: connectionId, name: connectionName, type: connectionType };

    if (workflowChoice !== "automatic") {
      hold({
        workflowType: workflowChoice,
        source: "chosen",
        // No classifier ran, so there is no outcome to record — which is a different
        // statement from one that ran and succeeded, and the record says which.
        reading: "unrecorded",
        objective: asked,
        connection,
        replacesOpenRun: false,
      });
      return;
    }

    setClassifying(true);
    const classification = await classifyObjective(asked);
    setClassifying(false);
    hold({
      workflowType: classification.workflowType,
      source: "inferred",
      reading: classification.outcome,
      objective: asked,
      connection,
      replacesOpenRun: false,
    });
  };

  /*
    The way out of a workflow the server chose (§5 of the design).

    An open run's workflow cannot be edited — there is deliberately no parameter through
    which a workflow could arrive twice — so this cancels the run and opens another one.
    Both consequences are stated in the copy beside the control rather than discovered:
    the cancellation is observed between turns, so it is not instant, and the run that
    opens is a new run with a new id while the cancelled one stays in the ledger.

    Stopping the open run is `beginRun`'s to do, not this function's, and the ordering
    is the point: this click may still raise the consent step, and a user who abandons
    it there must be left with the run they had. Cancelling here ended that run for a
    replacement that was then never opened — and since the objective box is emptied the
    moment a run opens, the question it was asking was gone too, leaving nothing to
    start again with.
  */
  const handleChangeWorkflow = (next: AgentRunWorkflowType): void => {
    if (connectionId === null) return;
    // A new attempt, so the last one's failure notice goes with it rather than standing
    // over a request that has not been answered yet.
    setReplaceFailed(false);
    setWorkflowChoice(next);
    setChangeOpen(false);
    hold({
      workflowType: next,
      source: "chosen",
      reading: "unrecorded",
      objective: openedObjective,
      // Snapshotted at this click for the reason `handleStart`'s is: this one can raise
      // the consent step too, and the shell can move while it stands.
      connection: { id: connectionId, name: connectionName, type: connectionType },
      replacesOpenRun: true,
    });
  };

  /*
    Emptying the box for the next question (#373 review).

    Measured: after a run completed the objective still held the previous question, so
    asking a second one meant selecting the old text and deleting it first.

    It is cleared when the SERVER HAS OPENED the run — the moment a run id exists —
    rather than on the click. A start can be refused (a model the capability gate
    turned down, a connection that no longer resolves, a request that never arrived),
    and a surface that ate the user's sentence on the way to a refusal would make them
    type it again to retry. `run.runId` is null until the server answered, so a start
    that did not happen costs nothing.

    Nothing is lost by one that did, either: the objective is on the run's own header
    and the timeline's first entry quotes it, so the question stays readable beside the
    run answering it.

    It is adjusted DURING render against the run id the box was last emptied for, which
    is React's own remedy for state that has to follow a changing value, rather than in
    an effect that would commit one frame still holding the previous question and then
    cascade a second render over it. The guard on the id is what makes it fire once per
    run — and what stops it looping, since the render that clears the box also records
    the run it cleared for.
  */
  /** The run the box has already been emptied for; the guard the adjustment needs. */
  const [followedRunId, setFollowedRunId] = useState<string | null>(null);
  if (run.runId !== followedRunId) {
    setFollowedRunId(run.runId);
    // Only an OPENED run empties it. The id going back to null is a run ending, and the
    // box has to be left alone through that: see the refusal case above.
    if (run.runId !== null) {
      setObjective("");
      // An edit begun against the run that is ending here is not a state the next run
      // inherits: the box is a summary again, of the question this new run was opened on.
      setEditingObjective(false);
    }
  }

  /**
   * A run this rail is still following. The setting above is frozen for exactly as
   * long as this holds — the same window the stop control is offered in, because both
   * are asking about a run the server still has open.
   */
  const runOpen = run.runId !== null && LIVE_STATUSES.has(run.timeline.status);

  /** Whether the objective is a box to type in or a line saying what was asked. */
  const objectiveEditable = !runOpen || editingObjective;

  /*
    The focus the objective box was holding when it stopped existing.

    `leaveConsent("objective")` lands focus in that box on purpose — Start disables the
    instant the run is busy, so focus there is focus lost a beat later — and one commit
    afterwards the run opens and the box becomes the summary. A browser drops focus to
    the body when the focused node is removed, which is the same "left nowhere" the
    consent step's own announcement exists to prevent, one step further along.

    So the control that took the box's place takes the focus the box lost, and only when
    it was actually lost: focus that is on a real control — Start, in a browser where the
    click that opened the run left it there — is not moved out from under the user.
  */
  const objectiveEdit = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (objectiveEditable) return;
    const active = document.activeElement;
    if (active === null || active === document.body) objectiveEdit.current?.focus();
  }, [objectiveEditable]);

  /*
    Carrying out what the RUN decided (§2.1, §2.3).

    The three-condition gate is the server's and its outcome is on the ledger, so
    nothing here weighs a statement again: the browser reads `handover` and does what
    it says. Once per entry, tracked by entry id — a fold runs on every appended line
    and re-delivering the same answer would run the user's database once per line
    after it.

    The ids are positional within one run (`entry-0`, `entry-1`, …), so they are
    reused by the NEXT run and the record is cleared when the run id changes. Without
    that, a second run's answer would be recognised as the first one's and silently
    dropped.
  */
  const handedOverRunId = useRef<string | null>(null);
  const handedOver = useRef<Set<string>>(new Set());
  /**
   * The entries whose hand-over this surface refused to perform, so the entry that
   * claims the execution can be contradicted where it is written.
   *
   * Ids rather than a single flag: the fact is about ONE entry, and a notice detached
   * from it would be a sentence a reader has to match to a line themselves.
   */
  const [declinedHandovers, setDeclinedHandovers] = useState<
    readonly { readonly id: string; readonly openedOn: string | null }[]
  >([]);
  useEffect(() => {
    if (handedOverRunId.current !== run.runId) {
      handedOverRunId.current = run.runId;
      handedOver.current.clear();
      setDeclinedHandovers([]);
    }
    for (const item of run.timeline.items) {
      if (item.handover === undefined || handedOver.current.has(item.id)) continue;
      handedOver.current.add(item.id);
      /*
        A hand-over is still declined when the editor has moved, and the REASON is
        narrower than it was (#373 review, second round).

        It used to be that the host resolved the execution from its own active
        connection, so a user who switched databases mid-run got the approved
        statement run — unbounded — against a database the run never read. That is no
        longer possible: the replay is served by
        `POST /api/agent/runs/[runId]/handover`, which resolves the run's OWN
        persisted connection server-side, so the statement can only ever reach the
        database that approved it.

        What remains is a question about what the user is shown. The result lands in
        the editor tab, and the tab belongs to whatever connection the user is on now;
        delivering another database's rows into it would present them as this
        connection's answer. So it is declined, and said, beside the entry that claims
        otherwise. The statement is not lost — the entry carries `applySql`, and
        taking it is the user's own action, on the connection they chose.
      */
      if (item.handover.kind === "auto-executed" && connectionId !== openedOn.current?.id) {
        setDeclinedHandovers((declined) => [...declined, { id: item.id, openedOn: openedOn.current?.name ?? null }]);
        continue;
      }
      // An `auto-executed` entry says the statement RAN, so it is delivered to the
      // runner or to nothing: applying it silently instead would leave that sentence
      // on the timeline about something that did not happen. This rail no longer
      // opens such a run without a runner (`canHandOver`), and the statement is never
      // lost either way — the entry carries `applySql`, so the control beside it
      // still offers it as the user's own action.
      //
      // The run id goes with it because the host does not execute the text: it names
      // the run, and the server reads the statement off that run's ledger. A timeline
      // item carrying a hand-over exists only on a run this rail is following, so the
      // narrowing below never falls through — it is the type system's question, not a
      // second condition.
      if (item.handover.kind !== "auto-executed") onApplyStatement?.(item.handover.sql);
      else if (run.runId !== null) onRunStatement?.(item.handover.sql, run.runId);
    }
  }, [run.runId, run.timeline.items, onApplyStatement, onRunStatement, connectionId]);

  /*
    Showing the answer the run composed (#373 review).

    A `data-analysis` run exists to answer with a result, and often that result is a
    chart. Driven live twice on 2026-08-15, both runs reached `answer-composed` with a
    valid chart spec and NEITHER chart was ever displayed: by the time a user reads the
    answer the run has ended, its rows are released with it, and the control that would
    have opened them is gone. The product composed the answer and showed the user a
    sentence saying it had.

    So the answer is delivered here, at the moment its entry arrives, while the rows
    the run read still exist. Once per entry and cleared on the run id, which is the
    hand-over's own pattern above and for the same two reasons: a fold runs on every
    appended line, and entry ids are positional within one run, so the next run reuses
    them.

    **This is not the rail applying something on the user's behalf.** The standing rule
    beside `HydrationControls` is that a statement the model drafted goes into the
    editor only by the user's decision — that is about EXECUTING untrusted SQL. Nothing
    is executed here: the rows are ones this run already read on its own bounded
    read-only path, and showing them is the run delivering what it was asked for.

    It is keyed to the ENTRY, deliberately not to `showArtifact` above, which is
    withheld once the run is no longer live. A stream chunk can carry `answer-composed`
    and `run-finished` together, and the fold then reports a finished run in the very
    render that first sees the answer — so a delivery gated on the status would never
    fire in exactly the case that was measured. Nothing about retention changes: the
    rows are not kept a moment longer, they are shown while they are there.

    A host with no `onShowArtifact` is left alone and nothing is recorded as delivered,
    so nothing claims a result was shown; a host that gains the callback later still
    gets the answer.
  */
  const shownAnswerRunId = useRef<string | null>(null);
  const shownAnswers = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (shownAnswerRunId.current !== run.runId) {
      shownAnswerRunId.current = run.runId;
      shownAnswers.current.clear();
    }
    if (onShowArtifact === undefined || run.runId === null) return;
    for (const item of run.timeline.items) {
      if (item.isAnswer !== true || item.artifactId === undefined || shownAnswers.current.has(item.id)) continue;
      shownAnswers.current.add(item.id);
      // The chart the RUN recorded rides along, and the key is absent rather than
      // undefined when there is none — the same record the manual ask carries.
      onShowArtifact({
        runId: run.runId,
        correlationId: item.artifactId,
        ...(item.chartSpec === undefined ? {} : { chartSpec: item.chartSpec }),
      });
    }
  }, [run.runId, run.timeline.items, onShowArtifact]);

  /*
    Stopping is the only control offered, and the two that are absent are absent
    because the service cannot honour them rather than because they are unfinished:

      - There is no PAUSE anywhere in `AgentRunService`. A run holds a database
        connection and a budget while it is running, and "hold all of that
        indefinitely" is not a capability this milestone built.
      - RESUME exists (`POST /api/agent/drive`) but is authenticated by a
        server-minted, single-purpose credential a browser never holds — it is the
        seam for a machine producer (`docs/BACKLOG.md` B9), not a user control.

    Neither is rendered even as a disabled button: a disabled control reads as a
    capability that happens to be unavailable right now, which would be a claim
    about this build that is not true.
  */
  const canStop =
    run.runId !== null && LIVE_STATUSES.has(run.timeline.status) && !run.timeline.stopRequested && !run.isStopping;

  /*
    A verdict about the model is a verdict about ONE mode (#331 T4).

    `admitAgentModel` returns `allowed` for planning on its first line: the mode is
    toolless by contract, so tool calling is not among the capabilities it needs and it
    is never probed. A refusal is therefore only ever true of the mode it was raised
    for, and showing it above another mode would be the rail stating something the
    server did not — most visibly right after the user takes the way out this state
    itself points at.

    Scoped here rather than cleared in the hook: the hook reports what the server said,
    and which of it applies to the surface's current selection is the surface's
    question. Switching back to agent mode is not a new fact and re-asking to learn it
    would spend a model round trip on an answer already given.
  */
  const modelRefusal = run.refusal !== null && run.refusal.mode === mode ? run.refusal : null;

  /*
    Whether plan mode is still worth offering with this model (#331 T4 review).

    The offer used to hang on nothing at all, and read as a guarantee: "plan mode still
    works with this model". It does not always. A planning turn consumes the same
    `streamText().fullStream` an agent turn does (`investigation.ts`), and an endpoint
    that answers a streamed request with one buffered body yields no incremental part at
    all — driven through the real run loop on 2026-08-13, such a planning run ends
    `succeeded` with empty text and writes no closing statement. Offering it would be
    the rail sending a user from one failure into a quieter one.

    `missing` cannot tell those apart: it names streaming in that case AND in the case
    where the endpoint refused the tool request before a stream could exist — the live
    `gemma3:270m` refusal, whose model then completed a planning run. `disproved` is the
    half that can, so the offer hangs on it: withdrawn only where the probe WATCHED the
    endpoint fail to stream, and left standing where streaming was merely never seen.

    It is still an invitation and not a promise, and the copy says so, because the probe
    always sends tools: no refusal it can reach establishes that a TOOLLESS request
    would be served.
  */
  const streamingDisproved = modelRefusal !== null && modelRefusal.disproved.includes("streaming");
  const planModeOffered = modelRefusal !== null && modelRefusal.mode !== "planning" && !streamingDisproved;

  /*
    An artifact is named by a correlation id, and the route that serves its rows is
    scoped to the run that recorded it — so the run id is bound here rather than
    threaded through every item.

    It is offered only while the run is LIVE, and that is the same rule the stop
    control follows rather than a caution: a run's stored rows live in this process
    and are released the moment the run ends (`releaseExecutionRun`), so on a finished
    run every one of these controls could only answer "no longer held". The note in
    the report section is what explains the absence; applying a drafted statement is
    unaffected, because the ledger keeps the statement for as long as the timeline.
  */
  const activeRunId = run.runId;
  const showArtifact =
    onShowArtifact === undefined || activeRunId === null || !LIVE_STATUSES.has(run.timeline.status)
      ? undefined
      : (correlationId: string, chartSpec: AgentChartSpec | undefined) =>
          // The key is absent rather than undefined when there is no chart: the
          // reference is read as a record of what the run said, and a present key
          // holding nothing is not the same statement as no key at all.
          onShowArtifact({ runId: activeRunId, correlationId, ...(chartSpec === undefined ? {} : { chartSpec }) });

  /*
    Keeping the newest entry in view (#373 review).

    Measured on a completed run: the container sat at `scrollTop: 0` with a
    `scrollHeight` of 760 against a `clientHeight` of 360, so the report — the thing
    the user was waiting for — was 400 pixels below the fold and had to be dragged to.
    A timeline nobody can see the end of is a timeline that reports nothing.

    Following is a STATE, not something that happens to every append: a user who
    scrolled up to read an earlier step must not be yanked back down by the next
    entry. They leave it by scrolling away and return to it by scrolling back, which
    is what makes it a rule rather than a fight over the scrollbar. It starts true,
    because a run that has produced nothing yet is already at its own end.

    `scrollHeight - clientHeight` rather than `scrollHeight`: a browser clamps the
    latter to the same value, and writing what is meant is what lets the position be
    asserted rather than inferred.

    An entry arriving is not the only thing that moves the bottom, and driving the
    merged branch is what proved it. A finished analysis run sat at `scrollTop: 245` of
    a 1090-pixel column — 637 pixels short — with every entry already delivered. The
    container had not grown; it had SHRUNK. Showing the run's answer opens the host's
    result panel, the rail's own viewport goes from 360 pixels to 208, and the bottom
    moves out from under a position that was correct when it was set. No entry arrives
    to say so, so an effect keyed on the entries alone has nothing to re-run on.

    Hence the observer: it is the resize, not the append, that this has to survive, and
    a `ResizeObserver` sees both — the container's own box and the content growing
    inside it. The entry effect stays because it is the cheaper path for the common
    case and it is what the eight tests below pin.
  */
  const timelineScroller = useRef<HTMLDivElement | null>(null);
  const followingTimeline = useRef(true);
  /**
   * Whether the run is still WRITING entries, for the observer's own closure.
   *
   * A ref rather than the value in scope because `pinToNewest` below is built once —
   * `useCallback` over empty dependencies — and the `ResizeObserver` holds that single
   * closure for the life of the panel: a status read out of it would be `queued`
   * forever. It is written in the effect that follows, never during render.
   */
  const timelineLive = useRef(true);
  /** The run whose answer has already been brought into view, so it happens once. */
  const revealedAnswerFor = useRef<string | null>(null);
  const readFollowing = () => {
    const scroller = timelineScroller.current;
    if (scroller === null) return; // Unreachable while the container is mounted; the event comes from it.
    followingTimeline.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= TIMELINE_BOTTOM_SLACK_PX;
  };
  /*
    One identity for the life of the panel, which is what lets both the effect below and
    the `ResizeObserver` under it name this as a dependency without re-subscribing. The
    dependencies are honestly empty: the body reads three refs and nothing reactive, so
    there is no value it could go stale on — that is what the refs above are FOR.
  */
  const pinToNewest = useCallback(() => {
    const scroller = timelineScroller.current;
    if (scroller === null || !followingTimeline.current || !timelineLive.current) return;
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
  }, []);

  /*
    Following the newest entry is right while there IS a newest entry to follow, and
    wrong the moment there is not (L1, measured in Chrome on 2026-08-21).

    Immediately after each run reached a terminal status, with nobody having scrolled,
    the container sat at its own maximum — 224 of 224 on the plan run, 248 of 248 on the
    agent run — and the answer card, which is the first child of this container, was that
    far above the fold. The newest entry at that point is `run-finished`; the thing the
    user has been waiting for is at the top. Every run therefore ended by landing the
    reader at the bottom of the transcript, which defeats the one thing this redesign is
    for.

    So the run's own status bounds the following, and the end of the run brings the
    answer into view instead — once per run, because it is an event and not a position to
    hold: a reader who then scrolls down into the transcript must not be pulled back up
    by the next resize. And it is still subject to the standing rule that a reader who
    scrolled away is left where they are; the reveal is for the reader who was watching
    the run, not for the one reading step four.

    The card stays INSIDE the scroller. Lifting it out would give the answer a fixed
    share of a 384-pixel panel — a long report would then starve the transcript, or need
    a scroller of its own inside the one it sits above — and it would sit over the
    reader's eyes while they read the chronology. Bounding the following costs nothing
    the other arrangement would have bought.
  */
  useEffect(() => {
    const live = run.runId === null || LIVE_STATUSES.has(run.timeline.status);
    timelineLive.current = live;
    if (live) {
      pinToNewest();
      return;
    }
    if (run.runId === null || revealedAnswerFor.current === run.runId) return;
    revealedAnswerFor.current = run.runId;
    // The reader who scrolled up to read an earlier step is not moved, exactly as they
    // are not while the run is going.
    if (!followingTimeline.current) return;
    const scroller = timelineScroller.current;
    if (scroller !== null) scroller.scrollTop = 0;
    // `run.timeline` rather than its `items` and `status` separately: the fold behind it
    // allocates a fresh object and a fresh `items` array on every recompute, so the whole
    // timeline moves in exactly the renders those two did — the same firing, named by the
    // value the body actually reads.
  }, [run.timeline, run.runId, pinToNewest]);

  useEffect(() => {
    const scroller = timelineScroller.current;
    // `ResizeObserver` is absent in some test environments and in no browser this app
    // supports, so its absence costs the observer and never the rail.
    if (scroller === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pinToNewest);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [pinToNewest]);

  /*
    What reaches the database, from `posture.ts` and from nowhere else — the whole reason
    that module exists is that the rail used to answer this question in six places and a
    user comparing two of them could not tell which one bounded the run.

    ONE module, asked TWO questions, because with a run open they stop having the same
    answer:

     - **what the open run does**, which the strip under the header says. Both of its axes
       come off the run. The mode is the run's own ledger (`AgentRunTimeline.mode`), not
       the toggle: the toggle is frozen only while a start is HELD, deliberately, since it
       decides the NEXT run, so reading it here let one click on Plan relabel a run that
       was executing reads as "Executes nothing it drafts". The hand-over is what the open
       REQUEST carried, and `openedWithHandover` is never cleared — it is a record, not a
       live reading — so it is gated on the run still being open, or the strip goes on
       promising one statement in the editor after the widened run has ended, while the
       next consent step defaults the tick to OFF.
     - **what pressing Start would do**, which the amber engine notice is entirely about.
       That one is the SELECTION's: the notice renders on the selected mode and offers the
       way out of that selection, so reading the open run's posture there would put plan
       mode's body inside a card whose whole subject is the engine agent mode cannot
       execute on. A muted line under Start used to ask the same question in words, and it
       said the strip's sentence over again 200px below it (L7), so it is gone.

    The two coincide whenever no run is open, which is most of the panel's life.
  */
  const engineLabel = connectionType === null ? "this connection" : getDBConfig(connectionType).label;
  /*
    Both axes of the open run's posture ask `runOpen` FIRST, and read the run before they
    read any control. That order is the rule, and it is why these two lines look alike.

    The asymmetry they replaced is what made a defect: the hand-over used to ask
    `pendingStart` first, so a consent step standing for the NEXT run outranked the run
    that was open — and the two coexist by design ("change" raises the step over a live
    run, and stops nothing until it is accepted; a stream that ended without a terminal
    entry clears `isBusy` with the status still `running`, which puts Start back within
    reach). The strip then relabelled an executing run from a checkbox belonging to a run
    nobody had opened: un-widened while the widened one was still handing statements over,
    and widened while the open one may hand nothing over. Keep the order aligned, in both
    lines, or that class of defect comes back on the next edit.
  */
  const handoverConsented = runOpen ? openedWithHandover : pendingStart !== null && autoExecute;
  const describedMode = runOpen ? run.timeline.mode : mode;
  const selectionPosture = agentPosture({
    mode,
    engine: connectionType,
    engineLabel,
    // The standing step's tick, and OFF otherwise: nothing has been consented to for a
    // run that is not being opened, and the next step's tick starts unticked.
    handover: pendingStart !== null && autoExecute,
  });

  /*
    An engine agent mode cannot execute a statement on, named before Start rather than
    after a run that ends `engine-unsupported`.

    It is PRESENTATION of the factory's own refusal and gates nothing: `canStart` does
    not read it, the button stays live, and the run this rail opens is refused by the
    server exactly as it was. A notice that also disabled Start would be this surface
    deciding a question the server decides — and it would be wrong for the operations
    workflow, which runs on every engine because it sends no statement at all.

    `null` is not one of these engines: nothing has been resolved, so which engine this
    is has not been established, and an amber card about an engine nobody named would be
    a claim this panel cannot support. The strip says "Cannot execute yet" for that
    state, which is what is true.
  */
  const engineUnsupported =
    mode === "agent" && connectionType !== null && !AGENT_EXECUTION_ENGINES.includes(connectionType);

  /*
    The run's scaffolding, folded away (item 7 of the redesign).

    Three entries of every run say only that it began: the header, the drive starting and
    the schema capture that grounded it. On a plan run that is three of five lines, and
    the two that matter — the statement and what the model said about it — start below
    the fold. They are collapsed into one dim summary that expands, and they are still
    rendered in full inside it: nothing is dropped, and the objective quoted under the
    header is still there to read.

    `item.chrome` comes off the FOLD and not off a headline: see `AgentTimelineItem`.
  */
  const chromeItems = run.timeline.items.filter((item) => item.chrome === true);
  const substantiveItems = run.timeline.items.filter((item) => item.chrome !== true);

  /*
    What the answer card is already offering, so the transcript withholds exactly that
    and nothing else (item 8).

    Read from `answerCardState` — the card's OWN reading, asked rather than reproduced.
    That is the correctness property here, not a tidiness one: this rail used to derive
    the suppression from the ledger (`report !== null`, and `planStatementRecorded` on
    the entry), which is a second, independent answer to "what is the card showing". The
    two disagreed on a run that ended `failed` holding a product — the card rendered a
    failure banner while this withheld the transcript's copies anyway, so the only
    "Apply to editor" a drafted statement had disappeared from every surface, and the
    entry went on saying the statement was "in the answer at the top of this rail".
    One reading, asked in one place, cannot disagree with itself.

     - `agent`: the card renders that answer's `applySql` through `HydrationControls` in
       its report state, so the same control on the same entry below would be a second
       "Apply to editor" for one statement — and a user who clicks the lower one has no
       way to know they were the same act. A live run whose answer has arrived but whose
       report has not is NOT that state, and the transcript's control is then the only
       one there is.
     - `plan`: the statement's own entry renders no statement and no control, and the
       prose it was read out of gives up its per-block control — but only while the card
       is showing the statement. Both halves of that conjunction are load-bearing: the
       entry can carry `planStatementRecorded` for a card that is showing something else.
  */
  const answerState = answerCardState(run.timeline);
  const answerItem = run.timeline.items.find((item) => item.isAnswer === true);
  const cardedAnswerId = answerState === "report" ? answerItem?.id : undefined;
  /*
    The statement the card is handing over, whichever of its two states is offering one
    — the plan draft it renders, or the answer entry's `applySql` in its report state.
    Undefined everywhere else, including a report whose run composed no answer: the card
    then offers no hand-off, so there is nothing below it to de-duplicate.

    It is the TEXT and not an entry id because the same statement is recorded more than
    once. An agent run drafts every statement it executes, and the answer's is the
    statement of the step whose artifact it presents, so a one-read run wrote that SQL
    to the ledger twice and the report cited it a third time (L6).
  */
  const cardedStatement =
    answerState === "plan"
      ? run.timeline.items.find((item) => item.planStatement !== undefined)?.planStatement?.sql
      : answerState === "report"
        ? answerItem?.applySql
        : undefined;

  /*
    The live figures the folded run details carries on its summary, so a collapsed meter
    still says what the run has spent. The gauges' own labels are lowercased into the
    line rather than restated, and every figure is the gauge's own.
  */
  const detailsFigures = [
    `${run.timeline.items.length} steps`,
    ...run.timeline.budget
      // The two the ledger MEASURES, in the order the meter shows them. Repair attempts
      // are a count of a count and say nothing at a glance, so they stay in the gauges.
      .filter((gauge) => gauge.id === "statements" || gauge.id === "database-time")
      .map((gauge) =>
        gauge.id === "statements"
          ? `${gauge.used}/${gauge.limit} stmt`
          : `${seconds(gauge.used)}/${seconds(gauge.limit)} s`,
      ),
  ].join(" · ");

  /** The sheet is the only presentation with something to close. */
  const inSheet = sheetOpen === true && isMobile;

  const content = (
    <div className="flex flex-col h-full min-h-0 bg-surface text-fg">
      <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-hairline shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Bot strokeWidth={1.5} className="w-3.5 h-3.5 text-blue-400" />
          <span className="text-xs font-medium text-fg-secondary">Agent</span>
          {connectionName !== null && <span className="text-xs text-fg-subtle truncate">on {connectionName}</span>}
        </div>
        {/*
          Two toggle buttons rather than a labelled `role="group"`: the jsx-a11y gate
          prefers a semantic element over that role, and each button carries its own
          full label, so the grouping adds nothing a screen reader needs.
        */}
        <div className="flex items-center gap-1">
          {(Object.keys(MODE_LABELS) as AgentRunMode[]).map((candidate) => (
            <button
              key={candidate}
              type="button"
              data-testid={`agent-mode-${candidate}`}
              aria-label={`${MODE_LABELS[candidate]} mode`}
              aria-pressed={mode === candidate}
              // Frozen while a start is held; see `startHeld` for why this is the axis
              // that must not move under an asynchronous start.
              disabled={startHeld}
              onClick={() => setMode(candidate)}
              className={cn(
                "px-2 py-0.5 rounded text-xs font-normal transition-colors disabled:opacity-40 disabled:hover:bg-transparent",
                mode === candidate ? "bg-blue-500/15 text-blue-300" : "text-fg-muted hover:bg-fill",
              )}
            >
              {MODE_LABELS[candidate]}
            </button>
          ))}
        </div>
        {/*
          The sheet's own close, in the header row with everything else. `SheetContent`
          floats one at `top-4 right-4` and this sheet is `p-0`, so that one came down on
          top of the toggle above - see the class that hides it where the sheet is built.
        */}
        {inSheet && (
          <button
            type="button"
            aria-label="Close agent"
            onClick={() => onSheetOpenChange?.(false)}
            className="p-1 rounded text-fg-tertiary hover:text-fg-bright hover:bg-fill transition-colors shrink-0"
          >
            <X strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/*
        The standing reading of what the open run executes — or of what pressing Start
        would, when there is none — under the header and above everything else, because it
        is true of the whole panel rather than of any one control in it. Its own component
        and its own module: this file states no bound the strip does not, and the strip
        states no bound `posture.ts` does not.
      */}
      <SafetyStrip
        mode={describedMode}
        engine={connectionType}
        engineLabel={engineLabel}
        handover={handoverConsented}
      />

      <div className="p-3 border-b border-hairline shrink-0">
        {/*
          The question, as a box while it is still a question and as a line once it is
          settled (item 4 of the redesign).

          A run's objective cannot be edited — it is on the run's own header, and every
          entry below was framed with it — so three rows of textarea holding text nobody
          can change is the space the run's answer needed. Edit is the way back: it puts
          the run's own question in the box, which is what a user refining it starts
          from, and Start then opens a NEW run with whatever they made of it.
        */}
        {objectiveEditable ? (
          <>
            <label htmlFor="agent-objective" className="text-xs text-fg-muted">
              What should the run investigate?
            </label>
            <textarea
              id="agent-objective"
              ref={objectiveBox}
              data-testid="agent-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              maxLength={AGENT_MAX_OBJECTIVE_LENGTH}
              rows={3}
              className="mt-1 w-full resize-none rounded bg-sunken border border-hairline-strong px-2 py-1.5 text-xs text-fg placeholder:text-fg-subtle focus:outline-none focus:border-blue-500/40"
              placeholder="Why is checkout slow?"
            />
          </>
        ) : (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {/*
                The user's own text, on a line of its own: the app's words are the
                workflow and the mode below it, and this rail's rule is that the two
                never share one VISIBLE line.

                The name in front of it is the exception that rule needs. The `<label>`
                that said what this text is belongs to the box, and the box is not on
                this branch — so a reader arriving at an open run reached an unattributed
                sentence of their own text, on the first content under the safety strip.
                It is `sr-only` rather than muted chrome because a sighted user has the
                box's absence, the Edit control and the frame line below to read it from;
                and it is a prefix inside this node rather than a named wrapper because
                `<p>` prohibits an accessible name of its own and the jsx-a11y gate
                prefers a semantic element over `role="group"` (see the mode toggle).
              */}
              <p data-testid="agent-objective-summary" className="text-xs text-fg-secondary break-words">
                <span data-testid="agent-objective-summary-label" className="sr-only">
                  The objective this run was opened with:{" "}
                </span>
                {openedObjective}
              </p>
              {/*
                Both halves off the RUN's own record. The mode used to come from the header
                toggle, which is live again the moment the run opens, so one click on Plan
                relabelled a run that was executing reads — and the two halves of one
                sentence came from two sources.
              */}
              <p data-testid="agent-objective-frame" className="mt-0.5 text-[0.625rem] text-fg-subtle">
                {WORKFLOW_LABELS[run.timeline.workflowType]} · {MODE_LABELS[describedMode]} mode
              </p>
            </div>
            <button
              type="button"
              ref={objectiveEdit}
              data-testid="agent-objective-edit"
              aria-label="Edit the objective and ask again"
              onClick={() => {
                // The run's question, not the emptied box: refining what was asked is
                // what this control is for, and retyping it is what it exists to avoid.
                setObjective(openedObjective);
                setEditingObjective(true);
              }}
              className="flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] text-fg-tertiary hover:bg-fill hover:text-fg transition-colors"
            >
              <PencilLine strokeWidth={1.5} className="w-3 h-3" aria-hidden="true" />
              Edit
            </button>
          </div>
        )}

        {/*
          ONE line, and an OFFER rather than a change (#331 T1). The objective in the
          box is the user's, so a shortcut may not overwrite it — but it may not quietly
          drop what it was asked to say either, or the shortcut reads as broken. So the
          ask waits here until the user takes it, and nothing is discarded without them
          saying so.
        */}
        {offeredObjective !== null && (
          <p data-testid="agent-prefill-offer" className="mt-2 text-[0.625rem] text-fg-muted">
            Suggested: <span className="text-fg-tertiary">{offeredObjective}</span>
            <button
              type="button"
              data-testid="agent-prefill-offer-apply"
              aria-label="Replace the objective with the suggested one"
              onClick={() => {
                setObjective(offeredObjective);
                prefilledObjective.current = offeredObjective;
                setOfferedObjective(null);
              }}
              className="ml-1 px-1 py-0.5 rounded text-[0.625rem] text-blue-300 hover:bg-fill transition-colors"
            >
              Replace
            </button>
          </p>
        )}

        {/*
          The second axis, folded away (§4 of the inference design).

          It is offered in BOTH modes and all five are still here: toollessness decides
          which TOOLS a run gets, not what the run is about, and the server frames the
          objective by workflow in either mode (`WORKFLOW_OBJECTIVES`). What changed is
          only who decides and when — the row used to sit ABOVE the objective, asking
          the user to classify a question they had not written yet.

          A plain button with `aria-expanded` and `aria-controls` rather than the
          `ui/collapsible` primitive: nothing in this app imports that file, the rail's
          own toggles are all bare buttons, and the disclosure is one boolean. The
          pattern is `VisualExplain`'s, which is this repo's existing answer for exactly
          this shape.
        */}
        <div className="mt-2">
          <button
            type="button"
            data-testid="agent-advanced-toggle"
            aria-expanded={advancedOpen}
            aria-controls="agent-advanced"
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex items-center gap-1 px-1 py-0.5 -ml-1 rounded text-[0.625rem] text-fg-muted hover:bg-fill hover:text-fg-secondary transition-colors"
          >
            {advancedOpen ? (
              <ChevronDown strokeWidth={1.5} className="w-3 h-3" aria-hidden="true" />
            ) : (
              <ChevronRight strokeWidth={1.5} className="w-3 h-3" aria-hidden="true" />
            )}
            Advanced
            <span data-testid="agent-workflow-choice" className="text-fg-tertiary">
              {workflowChoice === "automatic" ? "Automatic" : WORKFLOW_LABELS[workflowChoice]}
            </span>
          </button>
          {advancedOpen && (
            <div id="agent-advanced" className="mt-1">
              <div className="flex flex-wrap items-center gap-1">
                {/*
                  Automatic is first and is not a sixth workflow: it is the absence of a
                  choice, and the server reads the objective to resolve it. Choosing any
                  of the other five skips that call entirely.
                */}
                {(["automatic", ...(Object.keys(WORKFLOW_LABELS) as AgentRunWorkflowType[])] as const).map(
                  (candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      data-testid={`agent-workflow-${candidate}`}
                      aria-label={
                        candidate === "automatic" ? "Automatic workflow" : `${WORKFLOW_LABELS[candidate]} workflow`
                      }
                      aria-pressed={workflowChoice === candidate}
                      // Frozen with the mode axis, and for the same reason: a start
                      // already asked for must not change meaning while it is held.
                      disabled={startHeld}
                      onClick={() => setWorkflowChoice(candidate)}
                      className={cn(
                        "px-2 py-0.5 rounded text-xs font-normal transition-colors disabled:opacity-40 disabled:hover:bg-transparent",
                        workflowChoice === candidate ? "bg-blue-500/15 text-blue-300" : "text-fg-muted hover:bg-fill",
                      )}
                    >
                      {candidate === "automatic" ? "Automatic" : WORKFLOW_LABELS[candidate]}
                    </button>
                  ),
                )}
              </div>
              <p data-testid="agent-advanced-note" className="mt-1 text-[0.625rem] text-fg-subtle">
                Automatic reads your objective on the server and opens the run for the workflow it names. Naming one
                yourself skips that reading entirely.
              </p>
            </div>
          )}
        </div>

        {connectionId === null && (
          <p data-testid="agent-unresolvable-connection" className="mt-2 text-xs text-amber-400/80">
            {connectionName ?? "This connection"} cannot be rebuilt on the server: its settings live in this browser. A
            run re-resolves its connection there after a restart, so it can only investigate a connection the server
            holds too.
          </p>
        )}

        {/*
          Next to the status rather than only in the timeline: the timeline scrolls
          and this is the one line that tells a user whether to fix something before
          starting another run. The words come from the same map the timeline entry
          uses, so the two can never disagree.
        */}
        {run.timeline.failureReason !== null && (
          <p data-testid="agent-failure-reason" className="mt-2 text-[0.625rem] text-rose-300">
            {describeFailureReason(run.timeline.failureReason)}
          </p>
        )}

        {/*
          The classification, while it is happening. It is one bounded model call in
          front of a button the user just pressed, so the wait is said rather than left
          as a button that did nothing.
        */}
        {classifying && (
          <p data-testid="agent-classifying" className="mt-2 flex items-center gap-1 text-[0.625rem] text-fg-muted">
            <LoaderCircle strokeWidth={1.5} className="w-3 h-3 animate-spin" aria-hidden="true" />
            Reading your objective to choose a workflow.
          </p>
        )}

        {/*
          The consent step (§2.6, and §"Why the consent step is placed there"), in its own
          component since the redesign — same decision, same default, same open-time
          freezing, and the paragraph a user consents to now behind an ⓘ on the checkbox
          it describes rather than above it. `ConsentCard` carries the reasoning; what
          stays here is the half only this component knows.

          The region's ref is one of those halves. The card focuses itself when it is
          raised — that is the announcement — and the caller decides where focus goes when
          it LEAVES, because the two exits need different answers (`leaveConsent`).
        */}
        {pendingStart !== null && (
          <ConsentCard
            workflowType={pendingStart.workflowType}
            workflowLabel={WORKFLOW_LABELS[pendingStart.workflowType]}
            connectionName={pendingStart.connection.name}
            engine={pendingStart.connection.type}
            autoExecute={autoExecute}
            onAutoExecuteChange={setAutoExecute}
            onOpen={() => {
              leaveConsent("objective");
              void beginRun({ ...pendingStart, autoExecute });
            }}
            onCancel={() => leaveConsent("start")}
            regionRef={consentRegion}
          />
        )}

        {/*
          What the run was opened AS, and the way out of it (§5 of the design).

          Shown only for a workflow the SERVER read out of the objective, because only
          that one is a claim the user did not make. An `unclassified` reading is said as
          what it is rather than presented as a verdict: the run investigates because
          nothing could be established, which is a different sentence from "this is an
          investigation".

          The claim, the label AND the outcome are read off the RUN — its header carries
          the provenance (`workflowSource`), the workflow it was actually opened for, and
          how the reading that produced it went (`workflowReading`) — rather than off the
          request this rail sent. That is what makes the affordance a fact about the run
          instead of a memory of a click: a rail that reloads, or a second surface that
          joins the stream, folds the same three values and says the same thing.

          The outcome used to be the exception, held in this component alone and
          defaulting to `"classified"`, so a rail that had not made the reading itself
          said "read from your objective" about a run whose classification had FAILED.
          That is the one thing this affordance may not do, and it is why the field is on
          the record now (#407 review).
        */}
        {/*
          What conversation this run belongs to, and the way out of it.

          Rendered only when there is something to say — steps to list, a decline to
          report, or a connection change to explain. A first question has none of
          those, and a strip that said "this question started on its own" over every
          first question would be noise standing where a real notice has to be read.

          The three sentences come from three different knowers, and each says only
          what it knows: the rail owns the connection change (deliberate, and it is the
          layer that saw it), the server owns `declined` (five causes it may not tell
          apart), and the step list is the run's own header.
        */}
        {(threadSteps.length > 0 || threadDeclined !== undefined || connectionDropped) && (
          <div data-testid="agent-thread" className="mt-2 text-[0.625rem] text-fg-muted">
            {threadSteps.length > 0 && (
              <>
                <p>
                  {`Conversation: ${threadSteps.length} step${threadSteps.length === 1 ? "" : "s"} before this one`}
                  <button
                    type="button"
                    data-testid="agent-thread-new"
                    onClick={() => setStartFresh(true)}
                    className="ml-1 px-1 py-0.5 rounded text-[0.625rem] text-blue-300 hover:bg-fill transition-colors"
                  >
                    new conversation
                  </button>
                </p>
                <ol data-testid="agent-thread-steps" className="mt-1 space-y-0.5">
                  {threadSteps.map((step, index) => (
                    <li key={step.runId} className="flex gap-1">
                      <span className="text-fg-subtle">{index + 1}.</span>
                      <span className="break-words">{step.objective}</span>
                      <span className="ml-auto font-mono text-fg-subtle truncate">{step.runId}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {startFresh && (
              <p data-testid="agent-thread-fresh-pending" className="mt-1 text-blue-300/90">
                Your next question will start a new conversation.
                <button
                  type="button"
                  onClick={() => setStartFresh(false)}
                  className="ml-1 px-1 py-0.5 rounded text-[0.625rem] text-blue-300 hover:bg-fill transition-colors"
                >
                  keep it
                </button>
              </p>
            )}
            {(threadDeclined !== undefined || connectionDropped) && (
              <p data-testid="agent-thread-notice" className="mt-1 text-amber-400/80">
                {connectionDropped
                  ? "Connection changed, so this question started a new conversation."
                  : threadDeclined === "disabled"
                    ? "Conversation context is switched off on this server, so every question starts on its own."
                    : "The earlier step could not be reached, so this question started on its own."}
              </p>
            )}
          </div>
        )}
        {run.runId !== null && run.timeline.workflowSource === "inferred" && (
          <div data-testid="agent-opened-as" className="mt-2 text-[0.625rem] text-fg-muted">
            <p>
              {OPENED_AS_SENTENCES[run.timeline.workflowReading](WORKFLOW_LABELS[run.timeline.workflowType])}
              {runOpen && (
                <button
                  type="button"
                  data-testid="agent-opened-as-change"
                  aria-expanded={changeOpen}
                  aria-controls="agent-change-workflow"
                  onClick={() => setChangeOpen((open) => !open)}
                  className="ml-1 px-1 py-0.5 rounded text-[0.625rem] text-blue-300 hover:bg-fill transition-colors"
                >
                  change
                </button>
              )}
            </p>
            {runOpen && changeOpen && (
              <div id="agent-change-workflow" className="mt-1">
                {/*
                  Said before the click, not discovered after it. A run's workflow cannot
                  be edited — there is no parameter through which one could arrive twice —
                  so changing it is two acts, and both of their consequences are the
                  user's to weigh.
                */}
                <p data-testid="agent-change-workflow-terms" className="text-fg-muted">
                  Changing it stops this run and opens a new one. Stopping is observed between turns, so it is not
                  instant: the run ends at its next checkpoint. The new run gets a new id, and this one stays in the
                  ledger with everything it recorded.
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {(Object.keys(WORKFLOW_LABELS) as AgentRunWorkflowType[]).map((candidate) => (
                    <ChangeWorkflowButton key={candidate} candidate={candidate} onSelect={handleChangeWorkflow} />
                  ))}
                </div>
              </div>
            )}
            {/*
              A change whose stop the server did not accept, said where the control that
              asked for it is.

              It is the one outcome the copy above does not describe, and leaving it
              unsaid was the whole defect: the replacement is not opened, so a user
              reading "Changing it stops this run and opens a new one" against a rail
              that did neither would conclude the click missed. The run's own message is
              on the error line above; this says what the RAIL did about it, which is
              nothing, and why that is the safe answer.
            */}
            {replaceFailed && (
              <p role="alert" data-testid="agent-change-failed" className="mt-1 text-amber-400/80">
                This run was not stopped, so nothing new was opened: it is still going and still spending its budget.
                The line above is what the server answered. Ask again, or use Stop and start a new run once it has
                ended.
              </p>
            )}
          </div>
        )}

        {/*
          Agent mode on an engine that has no read-only statement path (item 5).

          The facts are the posture's, so this card invents nothing: the engines that DO
          have one are named from `AGENT_EXECUTION_ENGINES` rather than typed, the two
          ways forward are the two that are actually open — plan mode drafts here, and the
          operations workflow sends no statement at all — and the run would end
          `engine-unsupported` before its first statement.

          It does not gate Start, and `canStart` above is where that is visible: the
          refusal belongs to the provider factory, this is a notice about it, and one
          workflow runs here regardless. A disabled Start would take the operations
          workflow away over a claim that is not true of it.
        */}
        {engineUnsupported && (
          <div
            data-testid="agent-engine-unsupported-notice"
            className="mt-2 rounded border border-amber-400/40 bg-amber-500/5 p-2 space-y-1"
          >
            <p className="flex items-start gap-1 text-xs text-amber-300">
              <TriangleAlert strokeWidth={1.5} className="mt-px w-3 h-3 shrink-0" aria-hidden="true" />
              {selectionPosture.title}
            </p>
            <p data-testid="agent-engine-unsupported-reason" className="text-[0.625rem] text-amber-300/90">
              {selectionPosture.body}
            </p>
            <button
              type="button"
              data-testid="agent-engine-unsupported-plan"
              onClick={() => setMode("planning")}
              className="px-1.5 py-0.5 rounded text-[0.625rem] text-blue-300 hover:bg-fill transition-colors"
            >
              Switch to Plan
            </button>
          </div>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <span data-testid="agent-run-id" className="font-mono text-[0.625rem] text-fg-subtle truncate">
            {run.runId ?? ""}
          </span>
          {/* Folded from the ledger, so it says what the durable record says. */}
          {run.runId !== null && (
            <span data-testid="agent-run-status" className="text-xs text-fg-muted">
              {run.timeline.status}
            </span>
          )}
          <div className="flex items-center gap-1">
            {canStop && (
              <button
                type="button"
                data-testid="agent-stop"
                onClick={() => void run.cancel()}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors"
              >
                <Square strokeWidth={1.5} className="w-3 h-3" />
                Stop
              </button>
            )}
            <button
              type="button"
              ref={startButton}
              data-testid="agent-start"
              disabled={!canStart}
              onClick={() => void handleStart()}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 disabled:opacity-40 disabled:hover:bg-blue-500/15 transition-colors"
            >
              {run.isBusy || classifying ? (
                <LoaderCircle strokeWidth={1.5} className="w-3 h-3 animate-spin" />
              ) : (
                <Play strokeWidth={1.5} className="w-3 h-3" />
              )}
              Start
            </button>
          </div>
        </div>

        {/*
          There is no second posture line under Start (L7, measured 2026-08-21).

          It printed `${headline} — ${qualifier}.`, which is the strip's own sentence,
          about 200px below the strip: two identical sentences in one 384px panel, and the
          lower one was the easier to mistake for a claim about something else. The strip
          is permanent and always visible, so what the line said is not lost — and the
          panel's other reading of the SELECTION, the amber engine notice below, is the
          one that says something the strip does not, because it is about a mode the user
          has selected and the engine cannot execute.

          The alternative considered was to give this line the login hero's claim
          (`hero-proof.tsx`), which IS different information. It was not taken: that claim
          describes both modes at once, for a visitor who has selected neither, and here
          one is selected — and reusing it would mean exporting the hero's private
          `AGENT_MODES` out of a module that also pulls in the distribution and showcase
          catalogs, for a sentence about the mode the user did not pick.
        */}

        {/*
          The refused model (#331 T4). A start refused because the model was ESTABLISHED
          as unable to drive an agent run is not the generic red line: nothing here can
          be retried, and what has to change is not in this panel at all.

          #325 ratified that such a model "falls back explicitly to chat/NL2SQL". T2 and
          T3 removed both of those surfaces, so that decision is void — but the earlier
          reading of this state, that nothing toolless survived them, was FALSE, and the
          rail said so to users. The toolless surface that survived is this rail's own
          planning mode, one click away, in this panel. Driven live on 2026-08-13 — an
          `ollama` endpoint serving `gemma3:270m` refused the agent start below, and the
          same model then ran a planning run to `succeeded`.

          That `admitAgentModel` admits planning without probing is why the mode is
          REACHABLE with a refused model; it is not evidence that it WORKS with one. The
          gate skips the probe because planning needs no tools, which answers nothing
          about whether this endpoint would serve a toolless request — see
          `planModeOffered` above for the one observation that settles it the other way.

          So the state says what is true instead. An AGENT run is what this model cannot
          drive, and why; plan mode is offered where nothing the probe saw rules it out;
          a different model is what buys a run that reads the database. The offer only
          SELECTS the mode — the user decides whether to ask anything of it, the same
          rule T1's shortcut follows, and for the same reason: a click that spent model
          budget would be a different feature.

          Three registers, on purpose. The verdict is a heading; the shortfall is the
          structured `missing` rendered AS structure, one item per capability, so it can
          be scanned rather than read; the report is the server's prose, the only place
          the model's name and the endpoint's own words appear. The shortfall and the
          report do name the same capabilities — driven live on 2026-08-13, that reads as
          a summary above its detail, and the alternative is a browser that either parses
          the server's sentence apart or renders `missing` decoratively.

          The small print is `text-fg-tertiary` rather than `text-fg-muted`, which computes
          to 3.98:1 on this panel's `#0a0a0a` under the alert's own tint — short of WCAG
          AA at a size the large-text allowance does not cover (#100, #331 T4 review).
        */}
        {modelRefusal !== null && (
          <div
            role="alert"
            data-testid="agent-model-refusal"
            className="mt-2 p-2 rounded border border-red-500/30 bg-red-500/5 space-y-1"
          >
            <p className="text-xs text-red-300">This model cannot drive an agent run.</p>
            {modelRefusal.missing.length > 0 && (
              <div data-testid="agent-model-refusal-missing" className="flex flex-wrap items-center gap-1">
                <span className="text-[0.625rem] text-fg-tertiary">The probe could not establish:</span>
                {modelRefusal.missing.map((capability) => (
                  <span key={capability} className="px-1 py-0.5 rounded bg-red-500/10 text-[0.625rem] text-red-200/90">
                    {describeAgentCapability(capability)}
                  </span>
                ))}
              </div>
            )}
            <p data-testid="agent-model-refusal-report" className="text-[0.625rem] text-fg-tertiary">
              {modelRefusal.message}
            </p>
            <p data-testid="agent-model-refusal-action" className="text-[0.625rem] text-fg-tertiary">
              {refusalActionText(planModeOffered, streamingDisproved)}
            </p>
            {/*
              Offered only where it means something: not to a user already in plan mode,
              and not over an endpoint the probe watched fail to stream, which is the one
              observation that also rules the offered mode out.
            */}
            {planModeOffered && (
              <button
                type="button"
                data-testid="agent-model-refusal-use-planning"
                onClick={() => setMode("planning")}
                className="px-1.5 py-0.5 rounded text-[0.625rem] text-blue-300 hover:bg-fill transition-colors"
              >
                Switch to Plan mode
              </button>
            )}
          </div>
        )}

        {run.error !== null && (
          <p role="alert" data-testid="agent-error" className="mt-2 text-xs text-red-400">
            {run.error}
          </p>
        )}
      </div>

      {/*
        The meter, FOLDED (item 6 of the redesign).

        It reports what the server ENFORCES and reads every consumption off the run's own
        ledger. Three bounds can be measured that way; the rest are stated as the ceilings
        they are, because nothing durable records their consumption — the wall-clock
        deadline and the model-turn count live in the process driving the run, and this
        build enforces no token budget at all, so no token figure is shown rather than one
        that means nothing.

        What changed is where the reading SITS, and nothing about what it says. Four
        stacked paragraphs of caveat above the transcript pushed the run's own output below
        the fold on every viewport this rail ships in, so the block is a `<details>`: the
        summary keeps the live figures, and the three claims move behind an ⓘ each — each
        one on the figure it qualifies, each one still rendered in full, and each one still
        in the accessibility tree whether or not its popover is open (`InfoNote`). Their
        test ids travel with them, because they are the claims and not the layout.

        Open while the run is live, shut otherwise: a run in flight is the only time these
        figures are moving, and `open` is a prop React writes only when its value CHANGES,
        so a user who folds it away mid-run is not fought on the next ledger line.
      */}
      <details data-testid="agent-run-details" open={runOpen} className="border-b border-hairline shrink-0">
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.625rem] text-fg-muted hover:text-fg-secondary">
          Run details
          {/*
            The spend at a glance, so a folded meter still answers "how far in is it" —
            and only once a run exists, which is the gauges' own rule inside. Before one,
            these would read a run's worth of zeroes against the DEFAULT workflow's
            ceilings, and under Automatic that is a workflow nobody has chosen and the
            classifier may not pick: a bound stated before anything could enforce it.
          */}
          {run.runId !== null && (
            <span data-testid="agent-run-details-figures" className="font-mono text-fg-subtle">
              {detailsFigures}
            </span>
          )}
        </summary>
        {/*
          The meter's own wrapper keeps its id through the move behind the `<details>`:
          it is the handle the gauges are read through as a BLOCK, and the disclosure
          around it is a different node with a different id (`agent-run-details`).
        */}
        <div data-testid="agent-budget" className="px-3 pb-2 space-y-1.5">
          {/*
            The gauges measure a run, so they wait for one. Before any run exists they
            would read a full set of zeroes against the DEFAULT workflow's ceilings, which
            under Automatic is a workflow nobody has chosen and the classifier may not
            pick.
          */}
          {run.runId !== null &&
            run.timeline.budget.map((gauge) => (
              <div key={gauge.id} data-testid={`agent-budget-${gauge.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-fg-muted">{gauge.label}</span>
                  <span className="font-mono text-[0.625rem] text-fg-tertiary">{readGauge(gauge)}</span>
                </div>
                <div className="mt-1 h-0.5 rounded-full bg-fill">
                  <div
                    data-testid={`agent-budget-${gauge.id}-bar`}
                    className="h-full rounded-full bg-blue-400/60"
                    style={{ width: `${gaugeFraction(gauge)}%` }}
                  />
                </div>
              </div>
            ))}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[0.625rem] text-fg-subtle">
            {/*
              What the measured figures above are: a floor, per drive. The claim qualifies
              the gauges, so it sits with them.
            */}
            <span className="inline-flex items-center gap-0.5">
              What is counted
              <InfoNote title="What these figures count" testId="agent-budget-spend">
                <span data-testid="agent-budget-caveats" className="block">
                  Every ceiling is per drive, so a run resumed after a restart starts each of them again and these
                  totals can read past a single drive&apos;s ceiling. What is counted comes from the run&apos;s ledger,
                  which records less than the server charges: the schema capture&apos;s catalog reads are not itemized,
                  a statement that failed at the database records no duration, and a completed read reports the
                  engine&apos;s own elapsed time rather than the span the budget was charged. So a spend shown here is a
                  floor, never a ceiling. On SQLite a statement over its timeout is refused once it returns, not
                  interrupted while it runs.
                </span>
              </InfoNote>
            </span>
            {/*
              The ceilings nothing counts from, withheld while the workflow is the
              classifier's to decide: these are per workflow, and `data-analysis` and
              `investigation` are not close. A figure shown before the workflow is known
              would be a claim this rail cannot keep, and the user would read it as the
              bound their run will get. Where they ARE known the ⓘ carries them, and the
              reserve — which is the reason a run can end short of every one of them — sits
              beside the figures it is about.
            */}
            {showBudgetLimits ? (
              <span className="inline-flex items-center gap-0.5">
                Ceilings
                <InfoNote title="The ceilings nothing measures" testId="agent-budget-ceilings">
                  <span data-testid="agent-budget-limits" className="block">
                    Each statement gets {seconds(meterBudget.policy.budgets.statementTimeoutMs)} s, each drive{" "}
                    {(meterBudget.runDeadlineMs / 60_000).toFixed(1)} min and at most {meterBudget.maxModelTurns} model
                    turns.
                  </span>
                </InfoNote>
              </span>
            ) : (
              <p data-testid="agent-budget-unknown">
                Every ceiling here is per workflow, and Automatic decides the workflow from your objective when the run
                opens — so the figures are stated once the run has one, and by the run&apos;s own record.
              </p>
            )}
            <span className="inline-flex items-center gap-0.5">
              Report reserve
              <InfoNote title="What is kept back for the report" testId="agent-budget-report-reserve">
                <span data-testid="agent-budget-reserve" className="block">
                  The last {AGENT_REPORT_RESERVE_TURNS} model turns and the last {seconds(AGENT_REPORT_RESERVE_MS)} s
                  are kept back for the report: whichever it reaches first, the run is asked once to stop and report
                  what it has established. So a run that ends short of these figures was asked to stop rather than
                  having given up, and its claims still cite what it read. A plan run is never asked, having no report
                  to compose.
                </span>
              </InfoNote>
            </span>
          </div>
        </div>
      </details>

      <div
        ref={timelineScroller}
        onScroll={readFollowing}
        data-testid="agent-timeline-scroll"
        className="flex-1 min-h-0 overflow-auto"
      >
        {/*
          What came of the run, above the chronology of it (item 2 of the redesign).

          It is a SECOND rendering of entries the timeline below already holds, and it is
          first in this container rather than pinned outside it deliberately: the answer
          scrolls away like everything else, so a user reading the transcript is not
          reading it under a fixed block that has taken a third of the panel.

          No `capabilities`: this rail is given a connection id and a type, not a provider
          descriptor, and there is no fetch here to get one — every test in this suite
          counts the requests this component makes. The card's fallback is the honest one
          for that state: it tints from what the LEDGER says the guard could read, and
          answers "unknown" rather than SQL where nothing said.

          The run's grounding is not passed either, and deliberately: the card reads the
          capture off this same timeline. It used to be a second prop beside it, and a
          claim a caller can forget to pass is a claim that disappears — on MongoDB the
          answer showed the amber `not checked` chip alone while the fold two lines below
          said `Schema captured — 5 collections` (L4, measured 2026-08-21).

          `onStop` is deliberately not passed. The run's stop is one control and it is the
          one in the row above, three lines up: a second Stop inside the card would be two
          buttons for one ask, and the header's is the one this rail has always offered —
          including in the window between an accepted start and its first ledger line,
          where there is no card yet at all.
        */}
        <AnswerCard timeline={run.timeline} onApplyStatement={onApplyStatement} onShowArtifact={showArtifact} />
        <ol data-testid="agent-timeline" aria-live="polite" className="p-2 space-y-1">
          {run.timeline.items.length === 0 && (
            <li data-testid="agent-timeline-empty" className="p-2 text-xs text-fg-subtle">
              No activity yet. A run's steps appear here as they are recorded.
            </li>
          )}
          {/*
            The run's scaffolding, folded (item 7). One dim line where three entries were,
            expanding to those three entries rendered exactly as any other — so nothing is
            hidden, and the two lines a plan run is actually about start at the top.

            `agent-timeline-item` stays the id of a SUBSTANTIVE entry, which is what makes
            it worth asserting: a test that counts entries is counting what the run found.
          */}
          {chromeItems.length > 0 && (
            /*
              Silenced, and only this subtree: the nearest live ancestor governs, so
              `aria-live="off"` here leaves every substantive entry below announced.

              The summary interpolates a running count and the content of a closed
              `<details>` is not exposed at all, so inside the polite region a reader heard
              "Run setup · 1 entry", "· 2 entries", "· 3 entries" in place of the three
              lines those entries actually say. The collapse is deliberate; three
              announcements of a counter were not.
            */
            <li aria-live="off">
              <details data-testid="agent-timeline-chrome" className="rounded">
                <summary className="cursor-pointer p-2 text-[0.625rem] text-fg-subtle hover:text-fg-muted">
                  Run setup · {chromeItems.length} {chromeItems.length === 1 ? "entry" : "entries"}
                </summary>
                <ol className="space-y-1">
                  {chromeItems.map((item) => (
                    <li
                      key={item.id}
                      data-testid="agent-timeline-chrome-item"
                      className="rounded p-2 opacity-80 hover:bg-fill"
                    >
                      <TimelineEntryBody
                        item={item}
                        onApplyStatement={onApplyStatement}
                        showArtifact={showArtifact}
                        declinedHandovers={declinedHandovers}
                        cardedAnswerId={cardedAnswerId}
                        cardedStatement={cardedStatement}
                        planCarded={answerState === "plan"}
                      />
                    </li>
                  ))}
                </ol>
              </details>
            </li>
          )}
          {substantiveItems.map((item) => (
            <li key={item.id} data-testid="agent-timeline-item" className="rounded p-2 hover:bg-fill">
              <TimelineEntryBody
                item={item}
                onApplyStatement={onApplyStatement}
                showArtifact={showArtifact}
                declinedHandovers={declinedHandovers}
                cardedAnswerId={cardedAnswerId}
                cardedStatement={cardedStatement}
                planCarded={answerState === "plan"}
              />
            </li>
          ))}
        </ol>

        {/*
          Said where the results are listed, and keyed on this run having stored any
          plus the HOST's ability to show one — so it appears exactly when it explains
          something: while the run is live it states the bound in advance, and once the
          run has ended it says why the controls that were there are gone
          (`docs/BACKLOG.md` B15).

          It used to live inside the report section, which meant only a run that
          composed a report ever explained itself. The runs that most need the sentence
          compose nothing: a cancelled run observed on 2026-08-12 listed six stored
          results, offered no control on any of them, and said nothing about why. The
          bound belongs to the run's rows, not to its report.
        */}
        {onShowArtifact !== undefined && run.timeline.items.some((item) => item.artifactId !== undefined) && (
          <p data-testid="agent-report-retention" className="px-3 pb-2 text-[0.625rem] text-fg-subtle">
            A run&apos;s stored rows are released when the run ends, so a result can be shown only while its run is
            still going.
          </p>
        )}

        {/*
          The run's conclusion is the CARD, at the top of this container, and there is no
          second Report section down here any more (L6, measured 2026-08-21).

          It was not a duplicate by accident: the card renders the same claims, quoted the
          same way, with the same citations — so the rail printed the model's claim twice
          and offered "Apply to editor" three times for one statement, the card's, this
          section's citation and the `Statement drafted` entry that recorded it. Not one of
          the three carried an accessible name.

          Nothing this section said is gone. The claims are `agent-answer-claim`, quoted
          exactly as they were and still never narrated as the app speaking; each
          citation's label, the ledger's own detail for it and the statement it rests on
          are in the card's `agent-answer-evidence` fold, with the locator on the chip
          beside the claim; and a citation this timeline holds no entry for still says so
          in its own words rather than looking checked. Its `Show result` is the one thing
          not reproduced there, and it was already a second offer of the artifact the
          `Result stored` entry offers under the same live-run rule — while the note above
          is what explains the absence once a run has ended.
        */}
      </div>
    </div>
  );

  if (sheetOpen && isMobile) {
    return (
      <Sheet open onOpenChange={onSheetOpenChange}>
        <SheetContent
          side="bottom"
          data-testid="agent-rail-sheet"
          /*
            `[&>button]:hidden` takes down `SheetContent`'s own floating close - its only
            direct-child button - which is absolutely placed at `top-4 right-4` and, with
            `p-0` here, landed on the Plan/Agent toggle. The rail renders its own in the
            header instead. Done from the caller rather than by adding a prop to
            `ui/sheet.tsx`, which stays as shadcn ships it.
          */
          className="md:hidden h-[85vh] p-0 gap-0 bg-surface border-t border-hairline-strong rounded-t-3xl overflow-hidden [&>button]:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Agent</SheetTitle>
          </SheetHeader>
          {content}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div data-testid="agent-rail-panel" className="hidden md:flex flex-col h-full min-h-0">
      {content}
    </div>
  );
}
