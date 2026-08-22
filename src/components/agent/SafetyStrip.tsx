"use client";

import React, { useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import { type AgentPostureTone, agentPosture } from "@/lib/agent/posture";
import type { AgentRunMode } from "@/lib/agent/types";
import type { DatabaseType } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The standing safety strip: one always-visible row under the rail header saying what the
 * SELECTED MODE does to the database.
 *
 * It renders `src/lib/agent/posture.ts` and decides nothing. That split is the point — the
 * posture module owns every claim and every derived figure, this component owns the palette
 * and the popover — so a restyle here cannot change what the rail asserts, and a change to
 * `AGENT_EXECUTION_ENGINES` or to a policy row reaches this surface without a class being
 * touched. Nothing below writes a sentence of its own; grep this file for a full stop
 * outside a comment and you will not find one.
 *
 * Three properties are load-bearing, and each is one edit away from being lost:
 *
 *  - **The qualifier sits BESIDE the pill, never behind the ⓘ.** A bare "Executes nothing
 *    it drafts" overclaims: on the dialects `CATALOG_PLANS` serves, plan mode's grounding
 *    capture IS a catalog read, and `engine-support.ts` says in its own header that copy
 *    compressing these facts overclaims. Both halves are on one line, and the row
 *    flex-WRAPS rather than truncating, because a qualifier cut off mid-clause is the same
 *    overclaim with an ellipsis on the end.
 *  - **The full claim reaches assistive technology whether or not the popover is open.**
 *    The claim node is rendered always — `sr-only` while shut, a card while open — and it
 *    is the strip's `aria-describedby` target either way. One node and not two, so the
 *    text a screen-reader user gets and the text a sighted user opens cannot become two
 *    versions of the same claim.
 *  - **The ⓘ is a real `<button>`, tied to no preference.** It is the only route to the
 *    body, so it is not decoration and it is not optional: the platform gives it Enter,
 *    Space, focus and a tab stop, which a `<span>` with an `onClick` gives none of.
 *    Escape shuts it and returns focus, because a popover a keyboard user can open and not
 *    close is one that traps their reading position.
 *
 * The connection name is NOT here. It is in the rail header, where it already is, and one
 * name in two places is one name that can disagree with itself.
 */

export interface SafetyStripProps {
  /** The mode the rail currently shows, which is the axis this strip reads. */
  readonly mode: AgentRunMode;
  /** The engine the run's connection speaks, or null when none is resolved. */
  readonly engine: DatabaseType | null;
  /** `getDBConfig(engine).label` — the product's own name for that engine. */
  readonly engineLabel: string;
  /** Whether the editor hand-over is consented for the run this strip describes. */
  readonly handover: boolean;
}

/**
 * A palette per level, and the levels are `posture.tone`'s — chosen here so the posture
 * module never names a colour and this file never names a claim.
 *
 * The three ladder rungs take the three ladder hues, in the order the ladder widens:
 * emerald executes nothing, blue executes reads on the run's own path, amber executes reads
 * AND puts one statement in the user's editor. `blocked` is not a rung — nothing executes
 * and there is nothing to widen — so it takes `fg-muted` rather than a fourth hue: it is a
 * dead end rather than a hazard, the pre-start card is where that state is alerted, and
 * `fg-muted` is the one value `theme.css` documents as reading correctly on both grounds,
 * which is what the level with no hue of its own should have.
 *
 * Palette classes and tokens only. No literal colour appears in this file, and a test
 * scans every rendered `class` attribute to keep it that way.
 */
const TONE_PILL: Readonly<Record<AgentPostureTone, string>> = Object.freeze({
  safe: "text-emerald-400/90 bg-emerald-500/10",
  reads: "text-blue-300 bg-blue-500/10",
  widened: "text-amber-400 bg-amber-500/10",
  blocked: "text-fg-muted bg-fill",
} satisfies Record<AgentPostureTone, string>);

export function SafetyStrip({ mode, engine, engineLabel, handover }: SafetyStripProps) {
  const posture = agentPosture({ mode, engine, engineLabel, handover });
  const [open, setOpen] = useState(false);
  /*
    The description's id, and the ⓘ's `aria-controls` target. From `useId` rather than a
    constant because the rail renders in two presentations at once below `md` — the panel
    and the sheet host the same content — and two nodes sharing one id leave
    `aria-describedby` resolving to whichever the document happens to hold first.
  */
  const claimId = useId();
  const infoButton = useRef<HTMLButtonElement | null>(null);

  /*
    Escape, on the ⓘ itself.

    On the button and not on the row around it, for two reasons that agree. The card holds
    no focusable content — it is two paragraphs — so the button is the only place focus can
    be while the card is open, which makes this the whole keyboard path rather than half of
    it. And a `keydown` handler on the row would put an interaction on a static element,
    which the jsx-a11y gate refuses without a role: the fix there is a role invented to
    satisfy a lint rule, or a landmark for a one-line strip, and neither is worth having
    when the interactive element is already the right host.

    Focus is returned deliberately even though it never left: `setOpen(false)` restyles the
    node the browser is pointing at, and a control that survives its own popover should
    still be the thing focused after it.
  */
  const handleInfoKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "Escape" || !open) return;
    setOpen(false);
    infoButton.current?.focus();
  };

  return (
    <div
      data-testid="agent-safety-strip"
      /*
        The level as data, so a test asserts the claim rather than inferring it from a
        class name — the rule `PlanStatementCard`'s `data-read-only` already follows.
      */
      data-tone={posture.tone}
      aria-describedby={claimId}
      className="relative flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 border-b border-hairline bg-fill-subtle shrink-0"
    >
      <span
        data-testid="agent-safety-headline"
        className={cn("shrink-0 rounded px-1.5 py-px text-[0.625rem] font-medium", TONE_PILL[posture.tone])}
      >
        {posture.headline}
      </span>
      {/*
        `min-w-0` and no truncation: the row wraps this onto a second line rather than
        clipping it, which is the whole reason the qualifier is out here.
      */}
      <span data-testid="agent-safety-qualifier" className="min-w-0 text-[0.625rem] text-fg-muted">
        {posture.qualifier}
      </span>
      <button
        ref={infoButton}
        type="button"
        data-testid="agent-safety-info"
        /*
          The pill's own words, after the axis they are an answer to. A user who cannot see
          the pill gets the level from the button's name alone, which is what makes this an
          affordance rather than an unlabelled glyph.
        */
        aria-label={`What this mode executes: ${posture.headline}`}
        aria-expanded={open}
        aria-controls={claimId}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={handleInfoKeyDown}
        className="ml-auto shrink-0 self-center rounded p-0.5 text-fg-subtle transition-colors hover:bg-fill hover:text-fg-secondary"
      >
        <Info strokeWidth={1.5} className="w-3 h-3" aria-hidden="true" />
      </button>
      {/*
        One node, always rendered. Shut it is `sr-only` — out of the layout, in the
        accessibility tree, and still the `aria-describedby` target — so the claim is never
        reachable only by clicking. Open it is the popover. Deliberately NOT `hidden` and
        never `aria-hidden`: either one would make the ⓘ the sole route to the body, which
        is the failure this arrangement exists to prevent.
      */}
      <div
        id={claimId}
        data-testid="agent-safety-claim"
        data-open={open ? "true" : "false"}
        className={cn(
          open
            ? "absolute left-3 right-3 top-full z-20 mt-1 rounded border border-hairline-strong bg-overlay p-2 shadow-lg"
            : "sr-only",
        )}
      >
        <p className="text-[0.6875rem] font-medium text-fg-secondary">{posture.title}</p>
        <p className="mt-1 text-[0.625rem] leading-relaxed text-fg-tertiary">{posture.body}</p>
      </div>
    </div>
  );
}
