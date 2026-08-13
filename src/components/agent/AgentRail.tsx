"use client";

import React, { useEffect, useRef, useState } from "react";
import { Bot, Loader2, PencilLine, Play, Square, TableProperties } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { isMobileViewport, useIsMobile } from "@/hooks/use-mobile";
import { describeAgentCapability } from "@/lib/agent/capability-labels";
import {
  AGENT_EXECUTION_POLICY,
  AGENT_MAX_MODEL_TURNS,
  AGENT_MAX_OBJECTIVE_LENGTH,
  AGENT_RUN_DEADLINE_MS,
} from "@/lib/agent/execution-policy";
import type { AgentRunMode, AgentRunStatus, AgentRunWorkflowType } from "@/lib/agent/types";
import { cn } from "@/lib/utils";
import { type AgentBudgetGauge, type AgentTimelineTone, describeFailureReason } from "./timeline";
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
   * Asks the host to show a result the run stored. The rail hands over identifiers
   * and nothing else: the rows are fetched and rendered by the surface that already
   * renders rows, so this component instantiates no grid of its own.
   */
  readonly onShowArtifact?: (reference: { readonly runId: string; readonly correlationId: string }) => void;
}

const TONE_CLASSES: Readonly<Record<AgentTimelineTone, string>> = {
  neutral: "bg-zinc-600",
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
};

/** A run that is over cannot be asked for anything, so nothing is offered for it. */
const LIVE_STATUSES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>(["queued", "running"]);

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
    return "Plan mode needs no tools, so it may still work with this model: it reasons about your question and drafts an approach without reading the database. Try it, or configure a different model — one that passes the probe — for a run that reads the database.";
  }
  if (streamingDisproved) {
    return "This endpoint answered without streaming, and plan mode reads the same stream, so it would produce nothing here either. A different model, or an endpoint that streams, is what gets an answer.";
  }
  return "A different model, one that passes the probe, is what gets a run that reads the database.";
}

/**
 * What one entry lets a user do with what the run produced (#329 T11).
 *
 * Rendered only where the ledger recorded something to act on AND the host can act
 * on it — the same rule the stop control follows in T10b, so nothing here is a
 * disabled button standing in for a capability this build does not have. Both are
 * explicit user actions: the rail never applies a statement or opens a result on its
 * own, because a statement the model drafted is untrusted content and putting it into
 * the editor is the user's decision.
 */
function HydrationControls({
  sql,
  artifactId,
  testIdPrefix,
  onApply,
  onShow,
}: {
  readonly sql: string | undefined;
  readonly artifactId: string | undefined;
  readonly testIdPrefix: string;
  readonly onApply: ((sql: string) => void) | undefined;
  readonly onShow: ((correlationId: string) => void) | undefined;
}) {
  const canApply = sql !== undefined && onApply !== undefined;
  const canShow = artifactId !== undefined && onShow !== undefined;
  if (!canApply && !canShow) return null;

  return (
    <div className="mt-1 flex items-center gap-1">
      {sql !== undefined && onApply !== undefined && (
        <button
          type="button"
          data-testid={`${testIdPrefix}apply-statement`}
          onClick={() => onApply(sql)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
        >
          <PencilLine strokeWidth={1.5} className="w-3 h-3" />
          Apply to editor
        </button>
      )}
      {artifactId !== undefined && onShow !== undefined && (
        <button
          type="button"
          data-testid={`${testIdPrefix}show-result`}
          onClick={() => onShow(artifactId)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
        >
          <TableProperties strokeWidth={1.5} className="w-3 h-3" />
          Show result
        </button>
      )}
    </div>
  );
}

export function AgentRail({
  connectionId,
  connectionName,
  sheetOpen = false,
  onSheetOpenChange,
  onApplyStatement,
  onShowArtifact,
  prefill = null,
}: AgentRailProps) {
  const [mode, setMode] = useState<AgentRunMode>("planning");
  const [workflowType, setWorkflowType] = useState<AgentRunWorkflowType>("investigation");
  const [objective, setObjective] = useState("");
  /** An ask that arrived while the user was typing, waiting for them to take it. */
  const [offeredObjective, setOfferedObjective] = useState<string | null>(null);
  const run = useAgentRun();

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
    // Only on a real crossing: `useIsMobile` reports false on its first render and
    // resolves in an effect, so closing on "not mobile" alone would shut the sheet
    // in the same commit that opened it.
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
    served — while the hook seeds false and resolves in its own effect, which on a
    narrow viewport is not a stale answer but a wrong one.

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
    // typed, and one click puts it back.
    setWorkflowType(prefill.workflowType);

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

  const canStart = connectionId !== null && objective.trim().length > 0 && !run.isBusy;

  const handleStart = () => {
    if (connectionId === null || !canStart) return;
    // Both axes, always. They are independent (#325): a planning run of a query
    // optimization is an ordinary thing to ask for, and sending the workflow only in
    // agent mode made the rail unable to express one.
    void run.start({ mode, workflowType, objective: objective.trim(), connectionId });
  };

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
      : (correlationId: string) => onShowArtifact({ runId: activeRunId, correlationId });

  const content = (
    <div className="flex flex-col h-full min-h-0 bg-[#0a0a0a] text-zinc-100">
      <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Bot strokeWidth={1.5} className="w-3.5 h-3.5 text-blue-400" />
          <span className="text-xs font-medium text-zinc-300">Agent</span>
          {connectionName !== null && <span className="text-xs text-zinc-600 truncate">on {connectionName}</span>}
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
              onClick={() => setMode(candidate)}
              className={cn(
                "px-2 py-0.5 rounded text-xs font-normal transition-colors",
                mode === candidate ? "bg-blue-500/15 text-blue-300" : "text-zinc-500 hover:bg-white/5",
              )}
            >
              {MODE_LABELS[candidate]}
            </button>
          ))}
        </div>
      </div>

      {/*
        The second axis, in both modes. It was agent-only until review pointed out
        that this made the rail unable to open a planning run of a query
        optimization — a perfectly ordinary request, and one the epic's independent
        axes exist to allow. Toollessness decides which TOOLS a run gets, not what
        the run is about, and the server states the objective's framing in either
        mode (`WORKFLOW_OBJECTIVES`).
      */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-white/5 shrink-0">
        {(Object.keys(WORKFLOW_LABELS) as AgentRunWorkflowType[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            data-testid={`agent-workflow-${candidate}`}
            aria-label={`${WORKFLOW_LABELS[candidate]} workflow`}
            aria-pressed={workflowType === candidate}
            onClick={() => setWorkflowType(candidate)}
            className={cn(
              "px-2 py-0.5 rounded text-xs font-normal transition-colors",
              workflowType === candidate ? "bg-blue-500/15 text-blue-300" : "text-zinc-500 hover:bg-white/5",
            )}
          >
            {WORKFLOW_LABELS[candidate]}
          </button>
        ))}
      </div>

      <div className="p-3 border-b border-white/5 shrink-0">
        <label htmlFor="agent-objective" className="text-xs text-zinc-500">
          What should the run investigate?
        </label>
        <textarea
          id="agent-objective"
          data-testid="agent-objective"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          maxLength={AGENT_MAX_OBJECTIVE_LENGTH}
          rows={3}
          className="mt-1 w-full resize-none rounded bg-black/40 border border-white/10 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/40"
          placeholder="Why is checkout slow?"
        />

        {/*
          ONE line, and an OFFER rather than a change (#331 T1). The objective in the
          box is the user's, so a shortcut may not overwrite it — but it may not quietly
          drop what it was asked to say either, or the shortcut reads as broken. So the
          ask waits here until the user takes it, and nothing is discarded without them
          saying so.
        */}
        {offeredObjective !== null && (
          <p data-testid="agent-prefill-offer" className="mt-2 text-[0.625rem] text-zinc-500">
            Suggested: <span className="text-zinc-400">{offeredObjective}</span>
            <button
              type="button"
              data-testid="agent-prefill-offer-apply"
              aria-label="Replace the objective with the suggested one"
              onClick={() => {
                setObjective(offeredObjective);
                prefilledObjective.current = offeredObjective;
                setOfferedObjective(null);
              }}
              className="ml-1 px-1 py-0.5 rounded text-[0.625rem] text-blue-300 hover:bg-white/5 transition-colors"
            >
              Replace
            </button>
          </p>
        )}

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

        <div className="mt-2 flex items-center justify-between gap-2">
          <span data-testid="agent-run-id" className="font-mono text-[0.625rem] text-zinc-600 truncate">
            {run.runId ?? ""}
          </span>
          {/* Folded from the ledger, so it says what the durable record says. */}
          {run.runId !== null && (
            <span data-testid="agent-run-status" className="text-xs text-zinc-500">
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
              data-testid="agent-start"
              disabled={!canStart}
              onClick={handleStart}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 disabled:opacity-40 disabled:hover:bg-blue-500/15 transition-colors"
            >
              {run.isBusy ? (
                <Loader2 strokeWidth={1.5} className="w-3 h-3 animate-spin" />
              ) : (
                <Play strokeWidth={1.5} className="w-3 h-3" />
              )}
              Start
            </button>
          </div>
        </div>

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

          The small print is `text-zinc-400` rather than `text-zinc-500`, which computes
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
                <span className="text-[0.625rem] text-zinc-400">The probe could not establish:</span>
                {modelRefusal.missing.map((capability) => (
                  <span key={capability} className="px-1 py-0.5 rounded bg-red-500/10 text-[0.625rem] text-red-200/90">
                    {describeAgentCapability(capability)}
                  </span>
                ))}
              </div>
            )}
            <p data-testid="agent-model-refusal-report" className="text-[0.625rem] text-zinc-400">
              {modelRefusal.message}
            </p>
            <p data-testid="agent-model-refusal-action" className="text-[0.625rem] text-zinc-400">
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
                className="px-1.5 py-0.5 rounded text-[0.625rem] text-blue-300 hover:bg-white/5 transition-colors"
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
        The meter reports what the server ENFORCES, and reads every consumption off
        the run's own ledger. Three bounds can be measured that way; the rest are
        stated as the ceilings they are, because nothing durable records their
        consumption — the wall-clock deadline and the model-turn count live in the
        process driving the run, and this build enforces no token budget at all, so
        no token figure is shown rather than one that means nothing.

        Every measured figure is a FLOOR on the spend, not the spend: the ledger is
        narrower than the tracker in three known ways (`docs/BACKLOG.md` B12, B13),
        and the caveat below names all three rather than leaving a user to read the
        gauges as exact.
      */}
      <div data-testid="agent-budget" className="px-3 py-2 border-b border-white/5 shrink-0 space-y-1.5">
        {run.timeline.budget.map((gauge) => (
          <div key={gauge.id} data-testid={`agent-budget-${gauge.id}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-zinc-500">{gauge.label}</span>
              <span className="font-mono text-[0.625rem] text-zinc-400">{readGauge(gauge)}</span>
            </div>
            <div className="mt-1 h-0.5 rounded-full bg-white/5">
              <div
                data-testid={`agent-budget-${gauge.id}-bar`}
                className="h-full rounded-full bg-blue-400/60"
                style={{ width: `${gaugeFraction(gauge)}%` }}
              />
            </div>
          </div>
        ))}
        <p data-testid="agent-budget-limits" className="pt-0.5 text-[0.625rem] text-zinc-600">
          Each statement gets {seconds(AGENT_EXECUTION_POLICY.budgets.statementTimeoutMs)} s, each drive{" "}
          {(AGENT_RUN_DEADLINE_MS / 60_000).toFixed(1)} min and at most {AGENT_MAX_MODEL_TURNS} model turns.
        </p>
        <p data-testid="agent-budget-caveats" className="text-[0.625rem] text-zinc-600">
          Every ceiling is per drive, so a run resumed after a restart starts each of them again and these totals can
          read past a single drive's ceiling. What is counted comes from the run's ledger, which records less than the
          server charges: the schema capture's catalog reads are not itemized, a statement that failed at the database
          records no duration, and a completed read reports the engine's own elapsed time rather than the span the
          budget was charged. So a spend shown here is a floor, never a ceiling. On SQLite a statement over its timeout
          is refused once it returns, not interrupted while it runs.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <ol data-testid="agent-timeline" aria-live="polite" className="p-2 space-y-1">
          {run.timeline.items.length === 0 && (
            <li data-testid="agent-timeline-empty" className="p-2 text-xs text-zinc-600">
              No activity yet. A run's steps appear here as they are recorded.
            </li>
          )}
          {run.timeline.items.map((item) => (
            <li key={item.id} data-testid="agent-timeline-item" className="rounded p-2 hover:bg-white/5">
              <div className="flex items-center gap-2">
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", TONE_CLASSES[item.tone])} />
                <span className="text-xs text-zinc-300">{item.headline}</span>
              </div>
              {item.detail !== undefined && <p className="mt-0.5 pl-3.5 text-xs text-zinc-500">{item.detail}</p>}
              {/*
              Verbatim content from the model, the engine or the user, kept in its own
              block rather than folded into a sentence: it is untrusted input, and the
              user should be able to see where the app stops speaking.
            */}
              {item.quoted !== undefined && (
                <pre className="mt-1 ml-3.5 overflow-x-auto rounded bg-black/40 p-1.5 font-mono text-[0.625rem] text-zinc-400 whitespace-pre-wrap">
                  {item.quoted}
                </pre>
              )}
              <div className="ml-3.5">
                <HydrationControls
                  sql={item.applySql}
                  artifactId={item.artifactId}
                  testIdPrefix="agent-"
                  onApply={onApplyStatement}
                  onShow={showArtifact}
                />
              </div>
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
          <p data-testid="agent-report-retention" className="px-3 pb-2 text-[0.625rem] text-zinc-600">
            A run&apos;s stored rows are released when the run ends, so a result can be shown only while its run is
            still going.
          </p>
        )}

        {/*
          The run's conclusion, and the one place a user can check it: every claim
          is the model's own prose — quoted, never narrated as the app speaking —
          and every citation names something this run's ledger holds. The server
          already refused a claim it could not verify (`composeReportTool`), so a
          citation that does not resolve here is a gap in what this rail has read,
          and says so rather than looking checked.
        */}
        {run.timeline.report !== null && (
          <section data-testid="agent-report" className="border-t border-white/5 p-2 space-y-2">
            <h2 className="px-1 text-xs font-medium text-zinc-300">Report</h2>
            {run.timeline.report.claims.map((claim) => (
              <div key={claim.id} data-testid="agent-report-claim" className="rounded p-2 hover:bg-white/5">
                <pre className="overflow-x-auto rounded bg-black/40 p-1.5 font-mono text-[0.625rem] text-zinc-300 whitespace-pre-wrap">
                  {claim.quoted}
                </pre>
                <ul className="mt-1 space-y-1">
                  {claim.citations.map((citation) => (
                    <li key={citation.id} data-testid="agent-report-citation" className="pl-1.5 text-xs">
                      <span className={citation.resolved ? "text-zinc-400" : "text-amber-400/80"}>
                        {citation.label}
                      </span>
                      <span className="ml-1 text-zinc-600">{citation.detail}</span>
                      {citation.locator !== undefined && (
                        <span className="ml-1 font-mono text-[0.625rem] text-zinc-500">{citation.locator}</span>
                      )}
                      {citation.quoted !== undefined && (
                        <pre className="mt-0.5 overflow-x-auto rounded bg-black/40 p-1.5 font-mono text-[0.625rem] text-zinc-400 whitespace-pre-wrap">
                          {citation.quoted}
                        </pre>
                      )}
                      <HydrationControls
                        sql={citation.quoted}
                        artifactId={citation.artifactId}
                        testIdPrefix="agent-citation-"
                        onApply={onApplyStatement}
                        onShow={showArtifact}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );

  if (sheetOpen && isMobile) {
    return (
      <Sheet open onOpenChange={onSheetOpenChange}>
        <SheetContent
          side="bottom"
          data-testid="agent-rail-sheet"
          className="md:hidden h-[85vh] p-0 gap-0 bg-[#0a0a0a] border-t border-white/10 rounded-t-3xl overflow-hidden"
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
