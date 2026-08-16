"use client";

import { useEffect, useState } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A small control that puts a block of text on the clipboard, and says whether it
 * managed to (#389).
 *
 * It exists as a component rather than as a `navigator.clipboard.writeText` call at
 * each site because of one fact about that API: **it is secure-context only.** Over
 * plain HTTP on any host but loopback `navigator.clipboard` is undefined, and this
 * product ships that way on several distribution channels — the same trap
 * `crypto.randomUUID` set in `use-query-execution.ts`, where the fix was to stop
 * reaching for the secure-context API at all. Here the API is the point, so the
 * legacy command is the fallback instead.
 *
 * Two properties follow from that, and both are what make this honest rather than
 * decorative:
 *
 *  - **The outcome is awaited.** The common pattern is to call `writeText` and flip to
 *    "Copied!" in the same statement, which reports a success nobody observed: a
 *    browser that refuses the write, a permissions policy that blocks it, and a page
 *    that is not focused all reject the promise while the label says it worked.
 *  - **A failure is said.** If both paths fail there is nothing more this control can
 *    do, so it tells the user to select the text themselves rather than leaving them
 *    to discover an empty clipboard when they paste.
 */

/** How long the outcome stays on the button before it offers itself again. */
const OUTCOME_RESET_MS = 1_500;

type CopyOutcome = "idle" | "copied" | "failed";

/**
 * The pre-`navigator.clipboard` route: a text area holding the text, selected, copied
 * by the editing command, and removed.
 *
 * Deprecated and still the only thing that works in an insecure context. It is
 * synchronous and must be called from the click handler's own task — a browser
 * permits the command only while it is servicing a user gesture — which is why the
 * caller awaits nothing before reaching it.
 */
function copyByEditingCommand(text: string): boolean {
  const holder = document.createElement("textarea");
  holder.value = text;
  // Out of the layout and out of the tab order: the element exists for one command
  // and must not move the page or take focus from what the user was doing.
  holder.setAttribute("readonly", "");
  holder.style.position = "fixed";
  holder.style.top = "-9999px";
  document.body.appendChild(holder);
  holder.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // A browser that removed the command entirely. Nothing was copied, and the
    // element below is still removed either way.
    copied = false;
  }

  holder.remove();
  return copied;
}

/** The async clipboard where there is one, the editing command where there is not. */
async function writeToClipboard(text: string): Promise<boolean> {
  // Typed as always present by the DOM lib, and absent in every insecure context, so
  // the narrowing is the honest reading rather than defensive noise.
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Refused rather than missing — a permissions policy, an unfocused document.
      // The editing command is not subject to the same refusals, so it is still worth
      // trying rather than reporting a failure here.
    }
  }
  return copyByEditingCommand(text);
}

export interface CopyButtonProps {
  /** Exactly what lands on the clipboard: no trimming, no re-formatting. */
  readonly text: string;
  readonly testId: string;
  /** The resting label. "Copy" unless a site has more than one thing to copy. */
  readonly label?: string;
  readonly className?: string;
}

const OUTCOME_LABELS: Readonly<Record<Exclude<CopyOutcome, "idle">, string>> = Object.freeze({
  copied: "Copied",
  failed: "Copy failed",
});

/**
 * The accessible name per outcome. `idle` has none of its own: the resting name is the
 * caller's `label`, which is also the visible text, so there is nothing to add.
 *
 * Each entry CONTAINS its visible label above, which is what WCAG 2.5.3 asks for — a
 * name that dropped the visible words would leave voice-control users naming a button
 * the page does not answer to.
 */
const ACCESSIBLE_NAMES: Readonly<Record<CopyOutcome, string | undefined>> = Object.freeze({
  idle: undefined,
  copied: "Copied",
  failed: "Copy failed — select the text and copy it yourself",
});

export function CopyButton({ text, testId, label = "Copy", className }: CopyButtonProps) {
  const [outcome, setOutcome] = useState<CopyOutcome>("idle");

  // The outcome is a report on one click, not a state the button stays in: left
  // standing it would say "Copied" over a button that has not been pressed since.
  useEffect(() => {
    if (outcome === "idle") return;
    const timer = setTimeout(() => setOutcome("idle"), OUTCOME_RESET_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  const Icon = outcome === "copied" ? Check : outcome === "failed" ? TriangleAlert : Copy;

  return (
    <button
      type="button"
      data-testid={testId}
      /*
        The accessible name FOLLOWS the outcome, and the first version of this did not
        (#389 review): it stayed the resting label while the visible text changed, so a
        screen-reader user was told "Copy" over a button reading "Copied" and never
        learned the copy had happened. It also broke WCAG 2.5.3 — the accessible name
        must contain the visible label, and "Copied" is not inside "Copy".

        The failure's name says what is left to do, because a control that cannot perform
        its own action owes the user the one that still works. It still contains the
        visible label, so 2.5.3 holds there too.
      */
      aria-label={ACCESSIBLE_NAMES[outcome] ?? label}
      onClick={() => {
        void writeToClipboard(text).then((copied) => setOutcome(copied ? "copied" : "failed"));
      }}
      className={cn(
        "flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] transition-colors",
        outcome === "failed" ? "text-amber-400/80 hover:bg-fill" : "text-fg-tertiary hover:bg-fill hover:text-fg",
        className,
      )}
    >
      <Icon strokeWidth={1.5} className="w-3 h-3" />
      {outcome === "idle" ? label : OUTCOME_LABELS[outcome]}
    </button>
  );
}
