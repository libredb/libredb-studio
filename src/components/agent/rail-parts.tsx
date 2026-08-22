"use client";

import { useId, useState, type ReactNode } from "react";
import { Info, PencilLine, TableProperties } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import type { AgentChartSpec, AgentRunStatus } from "@/lib/agent/types";
import { cn } from "@/lib/utils";
import type { AgentPlanStatementView } from "./timeline";

/**
 * The pieces the rail and the answer card BOTH render.
 *
 * Their own module for a mechanical reason rather than a tidiness one: `AgentRail`
 * imports `AnswerCard`, so anything the card needs cannot live in the rail without
 * making the two files import each other. They were defined in `AgentRail.tsx` until
 * the answer card was split out of it, and they moved here unchanged — the same
 * components, the same accessible-name machinery, the same comments, which are the
 * record of what each one may and may not claim.
 *
 * Nothing was rewritten on the way. A second copy in the card was the alternative, and
 * it is the worse one twice over: `applyStatementName` is a WCAG 2.5.3 name carrying
 * the guard's marks, and `QuotedBlock`'s quoting is a security property — either one
 * duplicated is a place where a surface can come to say something the run never
 * established while its twin still says the right thing.
 */

/** A run that is over cannot be asked for anything, so nothing is offered for it. */
export const LIVE_STATUSES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>(["queued", "running"]);

/**
 * An ⓘ whose text is in the accessibility tree whether or not it is open.
 *
 * A popover that renders its body only while open hides the claim from everyone who
 * cannot see the panel, and every body behind one of these IS a claim — the guard's
 * reading, the spend's floor, the ceilings nothing measures. So the node is always
 * there: visually hidden when closed, a panel when open, and named by the button
 * either way.
 *
 * The body carries `testId` and the button carries `${testId}-info`, which is what
 * lets a claim keep the test id it had as a paragraph after it moves behind an ⓘ. The
 * title is rendered INSIDE the body so a reader who opens it is told what they are
 * reading; a caller whose claim must keep its own exact text puts that text in a node
 * of its own among the children (`agent-budget-limits` and its two siblings do).
 */
export function InfoNote({
  title,
  testId,
  children,
}: {
  readonly title: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  return (
    <span className="relative inline-flex items-start">
      <button
        type="button"
        data-testid={`${testId}-info`}
        aria-label={title}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
        className="rounded p-0.5 text-fg-subtle hover:bg-fill hover:text-fg-muted transition-colors"
      >
        <Info strokeWidth={1.5} className="w-3 h-3" aria-hidden="true" />
      </button>
      <span
        id={bodyId}
        data-testid={testId}
        className={cn(
          open
            ? "absolute top-5 left-0 z-10 w-64 space-y-1 rounded border border-hairline-strong bg-overlay p-2 text-[0.625rem] text-fg-tertiary shadow-lg"
            : "sr-only",
        )}
      >
        <span className="block font-medium text-fg-secondary">{title}</span>
        {children}
      </span>
    </span>
  );
}

/** What the guard did to this draft. Three answers, and `"objected"` is not `"unexamined"`. */
export type GuardReading = "checked" | "objected" | "unexamined";

export const guardReading = (draft: AgentPlanStatementView): GuardReading =>
  !draft.guardApplicable ? "unexamined" : draft.readOnly ? "checked" : "objected";

/**
 * The one-line reading, for the states where the full claim can be folded away.
 *
 * Here rather than in either surface because BOTH render it now: the answer card
 * states it under the statement, and the transcript entry the card de-duplicated
 * states it as the summary of what it no longer reprints. Two copies of a sentence
 * about what examined a statement is exactly the drift this module exists to prevent.
 *
 * `checked` and `checkedNoInventory` are the SAME guard verdict said about two
 * different runs, and the clause that separates them is a claim rather than a phrase.
 * The guard is `inspectAgentStatement`, which reads the text and nothing else, so it
 * says the same thing whether or not a schema was ever captured — and on a run whose
 * grounding capture was refused or failed, `validatePlanStatement` records
 * `identifiers.kind === "no-inventory"` while `readOnly` stays true. The single line
 * then asserted a check "against the captured inventory" that no inventory existed
 * for, directly above the popover sentence saying so: an overclaim contradicted by its
 * own qualifier, and a NEW one — the card this replaced made no positive claim here at
 * all. So the inventory clause appears only where an inventory was actually read.
 */
const GUARD_LINES: Readonly<Record<"checked" | "checkedNoInventory" | "unexamined", string>> = Object.freeze({
  checked: "Checked as a bounded read against the captured inventory. Nothing was executed.",
  checkedNoInventory: "Checked as a bounded read. Nothing was executed.",
  unexamined: "Not examined: the statement guard reads SQL, and this engine's statements are not SQL.",
});

/**
 * The guard's objection, as the one sentence that reports it.
 *
 * The answer card continues it with what the objection does and does not establish;
 * the transcript's summary stops here. Same first sentence, one author, so the reason
 * code and the wording around it cannot come to differ between the two.
 */
export const guardObjectionLine = (violation: string | undefined): string =>
  `The statement guard did not read this as a bounded read (${violation ?? "no reason recorded"}).`;

/**
 * All three readings in one line, which is what a de-duplicated entry keeps — and what
 * the answer card states above the claim behind it, so neither surface can say more
 * about the inventory than the run read of one.
 */
export const guardSummaryLine = (draft: AgentPlanStatementView): string => {
  const reading = guardReading(draft);
  if (reading === "objected") return guardObjectionLine(draft.guardViolation);
  if (reading === "unexamined") return GUARD_LINES.unexamined;
  // `"checked"` is the guard's verdict about the STATEMENT; whether the names in it were
  // looked for in anything is the identifier reading's answer, and only that one can
  // support the inventory clause.
  return draft.identifiers.kind === "checked" ? GUARD_LINES.checked : GUARD_LINES.checkedNoInventory;
};

/**
 * Verbatim content, and the one thing every reader wants to do with it (#389).
 *
 * The block itself is unchanged and deliberately so: quoting is a security property
 * here, not a style — a drafted statement, an engine's own message and the user's
 * objective are shown exactly as they arrived, so a reader can see where the
 * application stopped speaking. What was missing was any way to get the text OUT.
 * Selecting it by hand is what a user was left with, inside a narrow panel that
 * scrolls in both directions, and a statement wrapped across lines does not survive
 * the drag.
 *
 * Used at every verbatim block in this rail rather than at a chosen few, because
 * "which of these did the product decide I would want" is not a question a user
 * should have to answer.
 */
export function QuotedBlock({
  text,
  testId,
  className,
  /** A report's claim is the thing the report is FOR, and reads a shade brighter. */
  tone = "quiet",
}: {
  readonly text: string;
  readonly testId: string;
  readonly className?: string;
  readonly tone?: "quiet" | "loud";
}) {
  return (
    <div className={className}>
      {/*
        WRAPS, and does not scroll sideways (item 9 of the redesign). `whitespace-pre-wrap`
        already broke at the newlines a statement carries; what was left was an
        `overflow-x-auto` under it, so a single long line — a `SELECT` with a dozen
        columns, a Mongo pipeline written flat — put a second horizontal scrollbar inside
        a panel that already scrolls vertically, and the text ran off the edge of the one
        thing a user came here to read. `break-words` breaks the long token instead, which
        for a statement is the right trade: a wrapped identifier is still readable and
        still copies verbatim, because the copy takes the STRING and not the layout.
      */}
      <pre
        className={cn(
          "rounded bg-sunken p-1.5 font-mono text-[0.625rem] whitespace-pre-wrap break-words",
          tone === "loud" ? "text-fg-secondary" : "text-fg-tertiary",
        )}
      >
        {text}
      </pre>
      <div className="mt-0.5 flex items-center gap-1">
        <CopyButton text={text} testId={testId} />
      </div>
    </div>
  );
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
export function HydrationControls({
  sql,
  artifactId,
  chartSpec,
  testIdPrefix,
  applyName,
  onApply,
  onShow,
}: {
  readonly sql: string | undefined;
  readonly artifactId: string | undefined;
  /** Set only on an answer the run composed as a chart; undefined everywhere else. */
  readonly chartSpec: AgentChartSpec | undefined;
  readonly testIdPrefix: string;
  /**
   * The accessible name for the hand-off, from `applyStatementName` and from nowhere
   * else — passed by the surface that is offering the run's ANSWER, and absent on the
   * entries of the chronology, which offer a statement the run took along the way and
   * are named by their visible label as they always were.
   *
   * It is here because of L6: on the report path the rail offered three of these at
   * once and none of them was named, on the one surface the marking rules exist for.
   * Keeping one author for the name is what makes "every hand-off the card offers is
   * named by `applyStatementName`" a property a test can assert instead of a spelling
   * each site repeats.
   */
  readonly applyName?: string;
  readonly onApply: ((sql: string) => void) | undefined;
  readonly onShow: ((correlationId: string, chartSpec: AgentChartSpec | undefined) => void) | undefined;
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
          aria-label={applyName}
          onClick={() => onApply(sql)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] text-fg-tertiary hover:bg-fill hover:text-fg transition-colors"
        >
          <PencilLine strokeWidth={1.5} className="w-3 h-3" />
          Apply to editor
        </button>
      )}
      {artifactId !== undefined && onShow !== undefined && (
        <button
          type="button"
          data-testid={`${testIdPrefix}show-result`}
          onClick={() => onShow(artifactId, chartSpec)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] text-fg-tertiary hover:bg-fill hover:text-fg transition-colors"
        >
          <TableProperties strokeWidth={1.5} className="w-3 h-3" />
          Show result
        </button>
      )}
    </div>
  );
}

/**
 * The name a screen reader, a voice user and a tooltip all get for the one control
 * that puts a plan run's statement into the editor (item 7 of the plan-mode design).
 *
 * The visible label comes FIRST and unaltered, which is WCAG 2.5.3: a voice user says
 * what they can see, so "Apply to editor" has to be inside whatever this returns.
 * Everything after it is the part a colour cannot carry.
 *
 * Both warnings are stated in the terms the server established and no stronger, and the
 * first of them was once stated a good deal stronger. It read "This statement is not a
 * read: applying it puts SQL in your editor that can change or delete data", which is a
 * claim about the statement's EFFECT that `readOnly` cannot support: it is
 * `inspectAgentStatement(sql) === null`, and four of that guard's six objections say
 * only that it could not read the text — an unclosed span, a run two dialects disagree
 * about, a second statement, no statement at all — while its own header records that it
 * over-refuses legitimate reads on purpose. A jsonb read using `#>>` would have been
 * announced to a screen-reader user as SQL that can delete their data. So the name says
 * what the guard did, and the reason travels with it.
 *
 * The identifier finding is about names the captured inventory does not hold, which is
 * a reason the statement may not run rather than proof that it will not.
 *
 * `null` is the AGENT path, where there is no draft view to read: the run wrote that
 * statement, executed it on the read-only session the engine enforced and answered from
 * the rows, so the ledger holds no guard reading about it and this returns the visible
 * label alone. A mark there would have to be invented, which is the one thing the
 * paragraphs above refuse — and the name is still built HERE, because "every hand-off
 * the answer card offers is named by this function" is the property that keeps a control
 * from shipping unnamed the way all three of them had (L6).
 */
export function applyStatementName(draft: AgentPlanStatementView | null): string {
  if (draft === null) return "Apply to editor.";
  const marks: string[] = [];
  // The guard's reach comes FIRST, and it replaces the objection rather than joining
  // it (#414). On an engine whose statements are not SQL the guard read nothing, so
  // `readOnly` is `false` for a reason that is not about this draft — and the sentence
  // below it, spoken to a screen-reader user who cannot see the card, would otherwise
  // assert that nothing establishes this correct MongoDB aggregation only reads, as
  // though something had looked and been unconvinced.
  if (!draft.guardApplicable)
    marks.push(
      "The statement guard reads SQL and this engine's statements are not SQL, so nothing examined this draft.",
    );
  else if (!draft.readOnly)
    marks.push(
      `The statement guard did not read this as a bounded read (${draft.guardViolation ?? "no reason recorded"}), so nothing here establishes that running it would only read.`,
    );
  if (draft.identifiers.kind === "not-applicable")
    marks.push("The name check reads SQL too, so the names it uses were not looked for in anything.");
  else if (draft.identifiers.kind === "no-inventory") marks.push("Nothing checked the names it uses.");
  else if (draft.identifiers.unknownTables.length > 0) {
    // Named in the engine's own word (#414). This sentence is spoken to a user who
    // cannot see the card, so it is the last place a Druid run should be told about
    // "table(s)" while every visible surface beside it says datasources.
    marks.push(
      `It names ${draft.identifiers.unknownTables.length} ${draft.noun.singular}(s) the inventory this run read does not hold, so it may not run as written.`,
    );
  }
  return ["Apply to editor.", ...marks].join(" ");
}
