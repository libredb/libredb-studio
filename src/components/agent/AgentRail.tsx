"use client";

import React, { useEffect, useRef, useState } from "react";
import { Bot, Loader2, Play } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import type { AgentRunMode } from "@/lib/agent/types";
import { cn } from "@/lib/utils";
import type { AgentTimelineTone } from "./timeline";
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
 *  - **A connection this browser invented cannot be investigated.** A run persists a
 *    connection id and no credential, so a process resuming it re-resolves the
 *    connection server-side; one that exists only in localStorage could never be
 *    rebuilt. The rail says so instead of posting a request that can only be
 *    refused.
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
}

/** Mirrors `MAX_OBJECTIVE_LENGTH` in the start route, which refuses anything longer. */
const MAX_OBJECTIVE_LENGTH = 4000;

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

export function AgentRail({ connectionId, connectionName, sheetOpen = false, onSheetOpenChange }: AgentRailProps) {
  const [mode, setMode] = useState<AgentRunMode>("planning");
  const [objective, setObjective] = useState("");
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

  const canStart = connectionId !== null && objective.trim().length > 0 && !run.isBusy;

  const handleStart = () => {
    if (connectionId === null || !canStart) return;
    void run.start({ mode, objective: objective.trim(), connectionId });
  };

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

      <div className="p-3 border-b border-white/5 shrink-0">
        <label htmlFor="agent-objective" className="text-xs text-zinc-500">
          What should the run investigate?
        </label>
        <textarea
          id="agent-objective"
          data-testid="agent-objective"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          maxLength={MAX_OBJECTIVE_LENGTH}
          rows={3}
          className="mt-1 w-full resize-none rounded bg-black/40 border border-white/10 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/40"
          placeholder="Why is checkout slow?"
        />

        {connectionId === null && (
          <p data-testid="agent-unresolvable-connection" className="mt-2 text-xs text-amber-400/80">
            {connectionName ?? "This connection"} is defined in this browser only. A run has to re-resolve its
            connection on the server after a restart, so it can investigate managed connections only.
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

        {run.error !== null && (
          <p role="alert" data-testid="agent-error" className="mt-2 text-xs text-red-400">
            {run.error}
          </p>
        )}
      </div>

      <ol data-testid="agent-timeline" aria-live="polite" className="flex-1 min-h-0 overflow-auto p-2 space-y-1">
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
          </li>
        ))}
      </ol>
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
