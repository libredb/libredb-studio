"use client";

import React, { useEffect, useState, type RefObject } from "react";
import { Info, Play } from "lucide-react";
import { AGENT_HANDOVER_BUDGET } from "@/lib/agent/execution-policy";
import { autoExecuteTerms } from "@/lib/agent/posture";
import type { AgentRunWorkflowType } from "@/lib/agent/types";
import type { DatabaseType } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The consent step (§2.6 of `docs/AGENT_ANALYST_DESIGN.md`, and §"Why the consent step is
 * placed there"), lifted out of `AgentRail.tsx` unchanged in what it decides.
 *
 * It replaced the pre-start checkbox entirely. That checkbox rendered wherever the workflow
 * happened to be `data-analysis`, which is a state the user could leave without the tick
 * leaving with them — and, before #373, a state four workflows could reach at all. Consent
 * asked HERE cannot drift from the run it is about: the workflow is already decided, and the
 * very next thing that happens is the request that opens the run with it.
 *
 * It is still consent given at OPEN time, which is what `src/lib/agent/types.ts` requires of
 * every widening decision: no run exists yet.
 *
 * **The copy is the control.** "Auto-mode" transfers no responsibility because it names no
 * bound, so this names all three — the bound the run keeps for its own read, the bound the
 * editor keeps, and the bound being given up — and says what the run does INSTEAD when its
 * gate declines, because a user who finds the statement sitting unrun has to be able to read
 * that as the feature working. Every figure comes from the constants the enforcement reads.
 *
 * What the redesign changed is the ORDER those facts are read in, and nothing else. The old
 * card opened with a ninety-word paragraph, so the two things a user needs first — the tick
 * is off, and the run is read-only either way — arrived last if they arrived at all. Here the
 * heading states the default, the label carries the decision, and the paragraph moves into a
 * popover on that label. It moves WITHOUT leaving the accessibility tree: it is still the
 * checkbox's `aria-describedby` target, always rendered, hidden from sight alone. A
 * description that exists only while a popover is open is a description a screen-reader user
 * is never given, which would trade one audience's clarity for another's.
 */
export interface ConsentCardProps {
  /** The workflow this start is already decided for; the terms' figures are its own. */
  readonly workflowType: AgentRunWorkflowType;
  /** How the product names that workflow — the rail's own label map, passed in. */
  readonly workflowLabel: string;
  /**
   * The connection the start was asked ON, from the snapshot rather than from the shell.
   *
   * The terms promise the statement will run "on the connection the run was opened on", and
   * that connection is the one this start was asked on rather than whatever the shell is
   * showing when Start run is finally pressed — so the sentence says which.
   */
  readonly connectionName: string | null;
  /**
   * That connection's engine, also from the snapshot. Only SQLite changes what a long read
   * costs, and the sentence that says so has to stay with the run it is true of.
   */
  readonly engine: DatabaseType | null;
  /** The hand-over decision. OFF is the default, and the caller owns the state. */
  readonly autoExecute: boolean;
  readonly onAutoExecuteChange: (next: boolean) => void;
  /** Open the run with the decision as it stands. */
  readonly onOpen: () => void;
  /** Abandon the start. The objective stays in the box. */
  readonly onCancel: () => void;
  /**
   * The region node, handed back to the caller.
   *
   * Focus MOVES into this region on mount — that is the announcement for a keyboard user,
   * who otherwise has focus on a control that just went disabled and no way to know two
   * buttons appeared (#407 review, and this repo's own a11y history in #100). The EXIT half
   * is the caller's: leaving the step has to put focus somewhere real rather than on a node
   * about to be removed, and the two exits need different answers, which only the caller
   * knows (see `leaveConsent` in `AgentRail.tsx`). So the caller holds the ref.
   */
  readonly regionRef: RefObject<HTMLElement | null>;
}

/**
 * What the editor hand-over costs, in chips, and every figure read from the budget the
 * server enforces rather than typed here. #425's lesson is that a typed figure outlives the
 * value it described; these are the same numbers `AGENT_HANDOVER_BUDGET` hands the replay.
 *
 * "no time limit" is the word for the ceiling, not for an absent field: the plumbing cannot
 * express an absent timeout, so `AGENT_HANDOVER_BUDGET` carries PostgreSQL's own 32-bit
 * maximum — a little over 24 days — and `execution-policy.ts` states in its own header that
 * "no" is the part of the promise that does not hold literally. The terms popover carries
 * that full claim; the chip is its label, and sits beside it.
 */
const handoverChips = (): readonly { readonly text: string; readonly tone: "neutral" | "warn" }[] => [
  { text: "same read-only session", tone: "neutral" },
  { text: `${AGENT_HANDOVER_BUDGET.maxResultRows} rows`, tone: "neutral" },
  { text: "no time limit", tone: "warn" },
];

/**
 * The one sentence that is true of SQLite and of nothing else, in the words the budget meter
 * already uses for the same fact: SQLite does not preempt a statement over its timeout, so
 * the editor's missing time limit is a different promise there than it is on PostgreSQL.
 */
const SQLITE_COST =
  "On SQLite a read is not interrupted when it runs long: it blocks other writers and this application until it finishes.";

export function ConsentCard({
  workflowType,
  workflowLabel,
  connectionName,
  engine,
  autoExecute,
  onAutoExecuteChange,
  onOpen,
  onCancel,
  regionRef,
}: ConsentCardProps): React.JSX.Element {
  const [termsOpen, setTermsOpen] = useState(false);
  const isSqlite = engine === "sqlite";

  /*
    Raised, therefore announced. Mount is the moment the step appears, and focusing the
    region here rather than in the caller keeps the announcement with the thing being
    announced: a card rendered anywhere behaves the same way.
  */
  useEffect(() => {
    regionRef.current?.focus();
  }, [regionRef]);

  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-labelledby="agent-consent-workflow"
      aria-describedby="agent-consent-terms"
      data-testid="agent-consent"
      className="mt-2 rounded border border-blue-400/30 bg-blue-500/5 p-2 space-y-1 focus:outline-none focus:ring-1 focus:ring-blue-400/50"
    >
      {/*
        The default, first. The pill says what the run is with the box untouched, which is
        the fact the old card's paragraph buried: read-only is not what the tick buys, it is
        what the run is either way.
      */}
      <div
        data-testid="agent-consent-heading"
        className="flex items-center gap-1.5 text-[0.625rem] uppercase tracking-wide text-fg-tertiary"
      >
        Start this run
        <span
          data-testid="agent-consent-pill"
          className="rounded px-1 py-px text-[0.625rem] normal-case tracking-normal bg-emerald-500/10 text-emerald-400/90"
        >
          read-only
        </span>
      </div>
      {/*
        The region's own name, and it names the CONNECTION as well as the workflow — see
        `connectionName` above for why the sentence has to say which one.
      */}
      <p id="agent-consent-workflow" data-testid="agent-consent-workflow" className="text-xs text-fg-secondary">
        This run will open as {workflowLabel} on {connectionName ?? "the connection you started it on"}, which answers
        with a result.
      </p>
      <p data-testid="agent-consent-editor-note" className="text-[0.625rem] text-fg-muted">
        Nothing runs in your editor unless you ask for it below.
      </p>
      <div className="mt-1.5 pt-1.5 border-t border-hairline space-y-1">
        <div className="flex items-start gap-1">
          {/*
            The info button is a SIBLING of the label, never a child of it: a button inside a
            `<label>` toggles the checkbox when it is clicked, so reading the terms would
            silently give the consent the terms describe.
          */}
          <label htmlFor="agent-auto-execute" className="flex items-start gap-2 cursor-pointer">
            <input
              id="agent-auto-execute"
              data-testid="agent-auto-execute"
              type="checkbox"
              checked={autoExecute}
              aria-describedby="agent-consent-terms"
              onChange={(e) => onAutoExecuteChange(e.target.checked)}
              className="mt-0.5 rounded border-edge bg-panel"
            />
            <span data-testid="agent-auto-execute-label" className="text-xs text-fg-secondary">
              Also run the final answer in my editor
            </span>
          </label>
          <button
            type="button"
            data-testid="agent-consent-terms-info"
            aria-label="What the editor run adds"
            aria-expanded={termsOpen}
            aria-controls="agent-consent-terms"
            onClick={() => setTermsOpen((open) => !open)}
            className="mt-0.5 shrink-0 rounded p-0.5 text-fg-muted hover:bg-fill hover:text-fg-secondary transition-colors"
          >
            <Info strokeWidth={1.5} className="w-3 h-3" aria-hidden="true" />
          </button>
        </div>
        {/*
          One node in two presentations, and it is one node on purpose: this is the
          checkbox's `aria-describedby` target, so it is always rendered and the popover only
          unhides it. `sr-only` and not `hidden`/`aria-hidden` — a hidden node is not a
          description any assistive technology will read.
        */}
        <p
          id="agent-consent-terms"
          data-testid="agent-auto-execute-terms"
          className={cn(
            termsOpen
              ? "ml-5 rounded border border-hairline bg-raised p-2 text-[0.625rem] leading-relaxed text-fg-muted"
              : "sr-only",
          )}
        >
          {autoExecuteTerms(workflowType)}
        </p>
        {/*
          The bounds of what was ticked, and only once it is ticked: with the box off there
          is no widening to bound, and chips describing one would read as terms already
          accepted.
        */}
        {autoExecute && (
          <div data-testid="agent-consent-bounds" className="ml-5 flex flex-wrap items-center gap-1">
            {[
              ...handoverChips(),
              /*
                The SQLite chip is the label of the sentence below it, not a second opinion:
                the two are adjacent, so nothing can show the compressed form alone.
              */
              ...(isSqlite ? ([{ text: "SQLite: not interruptible", tone: "warn" }] as const) : []),
            ].map((chip) => (
              <span
                key={chip.text}
                className={cn(
                  "rounded px-1 py-px text-[0.625rem] bg-fill",
                  chip.tone === "warn" ? "text-amber-400/90" : "text-fg-tertiary",
                )}
              >
                {chip.text}
              </span>
            ))}
          </div>
        )}
        {/*
          Read off the SNAPSHOT, like everything else in this panel: a user who switches to
          PostgreSQL while the step stands still opens the run on SQLite, and a warning that
          left with the switch would have been withdrawn from the one run it is true of.

          Ungated by the tick, because it is true of the run either way — the tick only
          decides whether a second, unbounded read joins the run's own.
        */}
        {isSqlite && (
          <p data-testid="agent-auto-execute-sqlite" className="ml-5 text-[0.625rem] text-amber-400/70">
            {SQLITE_COST}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 pt-0.5">
        <button
          type="button"
          data-testid="agent-consent-open"
          onClick={onOpen}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 transition-colors"
        >
          <Play strokeWidth={1.5} className="w-3 h-3" aria-hidden="true" />
          Start run
        </button>
        {/* Cancel opens nothing: the objective stays in the box, and Start is live again —
            and takes focus back, since the control that is live again is the one that
            raised this. The caller performs that return; see `regionRef` above. */}
        <button
          type="button"
          data-testid="agent-consent-cancel"
          onClick={onCancel}
          className="px-2 py-1 rounded text-xs text-fg-tertiary hover:bg-fill transition-colors"
        >
          Cancel
        </button>
      </div>
      {/*
        Where the decision is made, which is what makes this consent rather than a
        preference. Under the buttons: it is a note on what pressing one of them settles,
        not a term to read before deciding.
      */}
      <p data-testid="agent-consent-frozen" className="text-[0.625rem] text-fg-subtle">
        This is decided by the request that opens the run and stays what it was: a later request cannot widen a run the
        server already holds.
      </p>
    </section>
  );
}
