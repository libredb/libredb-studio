"use client";

import { DiffEditor } from "@monaco-editor/react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import type * as Monaco from "monaco-editor";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import {
  describeConsequence,
  EDIT_PLAN_EXECUTABLE_LIMIT,
  describePinnedPathRefusal,
  pinnedSessionValue,
  planExecutableLength,
  providerRanges,
} from "@/lib/db/object-edit";
import type {
  ObjectEditConsequenceClass,
  ObjectEditCurrentText,
  ObjectEditOutcome,
  ObjectEditPlan,
  ObjectEditPosition,
  ObjectEditPreimage,
  ObjectEditStep,
} from "@/lib/db/types";
import { defineStudioThemes, STUDIO_THEME_DARK, STUDIO_THEME_LIGHT } from "@/lib/editor/monaco-theme";

/**
 * The six states this dialog can be in, and there is no seventh (#789 Phase 3, discussion #778).
 *
 * A state and not a bag of booleans, because the six differ in what the reader may DO: only
 * `preview` can apply, only `applying` blocks every way out, and `conflict` and `expired` offer a
 * rebuild and nothing else. A `busy` flag beside an `error` string cannot say which of the six a
 * reader is looking at.
 *
 * `preview`, `applying` and `failed` carry the PRE-IMAGE as well as the plan, because the diff's
 * left side is the definition the BUILD read and never the text the tab has been showing. A left
 * side taken from the tab hides a change somebody else made while the tab sat open, which is the
 * whole shape of the failure this phase exists to prevent.
 */
/**
 * The outcomes the `failed` state may carry, and the one it may NOT (#789 Phase 3, decision H3).
 *
 * `conflict: "object-changed"` is the CONFLICT SCREEN and it is excluded here by the compiler
 * rather than by a comment. The two conflict arms read the same on their first discriminant and
 * differ entirely in what the reader is owed: `object-changed` carries `current`, the server's
 * text at refusal time, and H3 asks for that text as a DIFF with a rebuild; `engine-refused-
 * concurrent` carries a sentence and nothing to diff, because the apply was up to date and a
 * "this changed" screen would show two identical texts.
 *
 * MEASURED, before this exclusion existed: a `failed` state carrying `object-changed` rendered
 * "Another session was changing this object at the same moment ...", threw `outcome.current` away
 * and left `Close` as the only control in the footer. The mount that maps an outcome to a state is
 * Task 14's, so this is refused where a mount cannot get it wrong: a mount that branches on
 * `outcome.outcome === "conflict"` alone no longer compiles.
 */
export type ApplyPreviewFailure = Exclude<ObjectEditOutcome, { readonly conflict: "object-changed" }>;

export type ApplyPreviewState =
  | { readonly kind: "building" }
  | { readonly kind: "preview"; readonly plan: ObjectEditPlan; readonly preimage: ObjectEditPreimage }
  | { readonly kind: "applying"; readonly plan: ObjectEditPlan; readonly preimage: ObjectEditPreimage }
  | {
      readonly kind: "failed";
      readonly plan: ObjectEditPlan;
      readonly preimage: ObjectEditPreimage;
      readonly outcome: ApplyPreviewFailure;
    }
  | {
      readonly kind: "conflict";
      readonly plan: ObjectEditPlan;
      readonly current: ObjectEditCurrentText;
      readonly userText: string;
    }
  | { readonly kind: "expired" };

export interface ApplyPreviewDialogProps {
  readonly open: boolean;
  readonly state: ApplyPreviewState;
  /** The object's display label and the part's, for the description. Never derived from an id here. */
  readonly objectLabel: string;
  readonly partLabel: string;
  readonly address: string;
  readonly partId: string;
  readonly onApply: (acknowledged: readonly ObjectEditConsequenceClass[]) => void;
  readonly onRebuild: () => void;
  readonly onGoToError: (at: ObjectEditPosition) => void;
  readonly onClose: () => void;
}

/** `1234` becomes `1,234`, on the object tree's precedent at `flatten.ts:309`. */
function counted(value: number): string {
  return value.toLocaleString("en-US");
}

/** The step whose bytes the diff's right side shows: the payload on the command arm. */
function previewedStep(plan: ObjectEditPlan): ObjectEditStep {
  return plan.unit.medium === "command" ? plan.unit.payload : plan.unit.steps[0];
}

/**
 * The one line under the diff on the statement arm, and every clause in it is load-bearing.
 *
 * It says three things at once: WHICH parts of the right side this product wrote, that everything
 * else is byte for byte the reader's own text, and how much will be sent in total.
 * `planExecutableLength` is the total across every step, which is what the apply sends and what
 * the route bounds, while the diff shows the FIRST step. On a plan with more than one step those
 * two numbers differ, so a second sentence names that rather than letting a reader read the count
 * as a description of what is on screen. No day-one strategy sends more than one step, and this is
 * the arm that stops a silent half-preview when one does.
 */
function identitySentence(plan: ObjectEditPlan, sent: boolean): string {
  const opening =
    "The shaded regions are added by LibreDB to make this apply safe. Everything else is exactly what you ";
  const total = counted(planExecutableLength(plan.unit));
  if (plan.unit.medium === "statement" && plan.unit.steps.length > 1) {
    // The byte-identity clause is DROPPED here rather than qualified: with more than one step the
    // right side is one statement of several, so "the whole of the right side is what will be
    // sent" would be false for exactly the case this arm exists for, while the count beside it
    // would be counting bytes that are not on the screen.
    const tense = sent ? "were sent" : "will be sent";
    return `${opening}typed. The diff shows statement 1 of ${counted(plan.unit.steps.length)}, and ${total} characters ${tense} in total.`;
  }
  return `${opening}typed, and the whole of the right side is what ${sent ? "was" : "will be"} sent, ${total} characters.`;
}

/**
 * What the reader is told HAPPENED, which is the title, the disposition sentence and whether the
 * left column may still claim the server (#789 Phase 3, discussion #778).
 *
 * One function rather than three conditionals at three render sites, because the three answers are
 * one fact and they went wrong together. Before this existed every state opened with
 * `Apply this definition` and `Nothing runs until you press Apply.`, MEASURED by reading
 * `dialog.textContent` in each of the twelve states this component can reach, and eleven of the
 * twelve also labelled the pre-image column `On the server now`. On the state X24 made reachable,
 * an apply that SUCCEEDED and destroyed a sibling function, all three of those are false at once
 * and the region under them is the honest part of the screen.
 *
 * `preimageIsCurrent` is a claim about the SERVER and not about this dialog's history, so it stays
 * true wherever the addressed object was left alone: a refusal, a rolled-back interruption and
 * both `applied-elsewhere` arms all leave the pre-image as the current definition. It goes false
 * on the two arms that replaced it and on `interrupted: "unknown"`, where nobody knows, and a
 * header claiming the server there would be a guess printed as a fact.
 */
function applyFrame(state: ApplyPreviewState): {
  readonly title: string;
  readonly disposition: string;
  readonly preimageIsCurrent: boolean;
} {
  const unchanged = "Nothing was applied and the definition on the server is unchanged.";
  if (state.kind === "building" || state.kind === "preview") {
    return {
      title: "Apply this definition",
      disposition: "Nothing runs until you press Apply.",
      preimageIsCurrent: true,
    };
  }
  if (state.kind === "applying") {
    return { title: "Applying this definition", disposition: "This apply is running now.", preimageIsCurrent: true };
  }
  if (state.kind === "expired") {
    return { title: "This preview expired", disposition: unchanged, preimageIsCurrent: true };
  }
  if (state.kind === "conflict") {
    return {
      title: "This definition changed while you had it open",
      disposition: "Nothing was applied. The left side below is what the server holds now.",
      preimageIsCurrent: true,
    };
  }
  const outcome = state.outcome;
  if (outcome.outcome === "refused" || outcome.outcome === "conflict") {
    return { title: "The engine refused this change", disposition: unchanged, preimageIsCurrent: true };
  }
  if (outcome.outcome === "interrupted") {
    return {
      title: "This apply was stopped before it finished",
      disposition:
        outcome.committed === "rolled-back"
          ? unchanged
          : "Whether it reached the server is unknown. Read the definition again before you edit it.",
      preimageIsCurrent: outcome.committed === "rolled-back",
    };
  }
  if (outcome.outcome === "applied-with-collateral") {
    return {
      title: "Applied, and it destroyed something else",
      disposition: "The new definition is on the server. What else went is named below.",
      preimageIsCurrent: false,
    };
  }
  if (outcome.outcome === "applied-elsewhere") {
    return outcome.undone
      ? { title: "This apply changed nothing", disposition: unchanged, preimageIsCurrent: true }
      : {
          title: "This apply wrote a different object",
          disposition: "This object is unchanged, and what the engine did write is named below.",
          preimageIsCurrent: true,
        };
  }
  // `applied`, and only `applied`. Unreachable through the mount, which closes this dialog on a
  // clean success, and framed anyway for the same reason the region renders it: the prop type
  // cannot exclude it, and a success wearing "Nothing runs until you press Apply." is the exact
  // defect this function exists to remove.
  return { title: "This apply is done", disposition: "The new definition is on the server.", preimageIsCurrent: false };
}

/** The warning grammar the pane already uses for a truncated part (`ObjectSourceView.tsx:491-497`). */
function WarningRow({ testId, children }: { testId: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-border bg-warning/10 px-3 py-1.5 text-xs text-warning"
      data-testid={testId}
    >
      <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/**
 * The preview the reader approves, which is the bytes the apply sends (ruling 1a, #789 Phase 3).
 *
 * Mounted by `ObjectSourceView` and by nothing else. The shell is this repository's own Radix
 * modal, so `role="dialog"`, `aria-modal`, the focus trap, focus return and the `sr-only` close
 * label all come from `DialogContent` and none of them is hand-rolled here. `QuerySafetyDialog` is
 * the closest prior art by intent and the worst model to copy: MEASURED, it is a `fixed inset-0`
 * div with no dialog role, no `aria-modal`, no focus trap and no Escape handler.
 *
 * `SchemaDiff` is not reused and could not be: MEASURED, it is a structural snapshot diff over
 * `DetailedObject[]`, its vocabulary is `ColumnDiff`/`TableDiff`, it holds no text on either side
 * and it contains no Monaco.
 *
 * MEASURED in a real browser under this app's production CSP: `createDiffEditor` mounts and
 * computes its diff, and markers render on a `readOnly` editor. Two model rules come out of that
 * same probe and each has a test: the model paths are explicit and namespaced away from the pane's
 * own `libredb-source:` model, because a collision would hand the diff the pane's LIVE model; and
 * neither `keepCurrentOriginalModel` nor `keepCurrentModifiedModel` is set, because the wrapper
 * disposes both models on unmount only while those stay false, and the probe measured roughly 2 MB
 * of retained text per opened preview when it disposed the editor and the models stayed.
 */
export function ApplyPreviewDialog(props: ApplyPreviewDialogProps): React.JSX.Element {
  const { open, state, objectLabel, partLabel, address, partId, onApply, onRebuild, onGoToError, onClose } = props;
  const theme = useEffectiveTheme();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  /**
   * The acknowledgement is held WITH the plan it was given for, so a rebuild resets it.
   *
   * A bare boolean cleared by an effect would clear one render LATE, and for that render the
   * reader would be looking at a new plan's consequences over the previous plan's tick. A rebuilt
   * plan can carry different consequences, so an acknowledgement that survived would be a reader
   * agreeing to something they were never shown.
   */
  const [acknowledged, setAcknowledged] = useState<{ readonly planId: string; readonly checked: boolean }>({
    planId: "",
    checked: false,
  });

  const applying = state.kind === "applying";
  /**
   * The apply has RUN, which is what puts every sentence on this screen into the past tense.
   *
   * `failed` is the only state that can carry an outcome, so it is the only state where anything
   * was sent at all. `applying` is deliberately NOT here: the bytes are in flight and the reader is
   * being told what is happening, not what happened.
   */
  const sent = state.kind === "failed";
  const frame = applyFrame(state);
  const plan = state.kind === "building" || state.kind === "expired" ? undefined : state.plan;
  const preimage =
    state.kind === "preview" || state.kind === "applying" || state.kind === "failed" ? state.preimage : undefined;
  const step = plan === undefined || state.kind === "conflict" ? undefined : previewedStep(plan);

  /**
   * The shaded ranges come from the SEGMENTS and never from a search of the sent text.
   *
   * A search would shade a reader's own line that happened to match the provider's literal, and
   * that is not hypothetical: a Trino apply splices ` OR REPLACE` after the first token, and a
   * reader whose own comment mentions `OR REPLACE` above it would have the comment shaded and the
   * real splice left plain, which inverts the one thing this shading says.
   *
   * Empty on the conflict screen, where the right side is the reader's own edit and nothing on it
   * was written by this product.
   */
  const ranges = step === undefined ? [] : providerRanges(step);

  const editorRef = useRef<{
    readonly diff: Monaco.editor.IStandaloneDiffEditor;
    readonly monaco: typeof Monaco;
  } | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);

  const paintRanges = useCallback(() => {
    const mounted = editorRef.current;
    if (mounted === null) return;
    const modified = mounted.diff.getModifiedEditor();
    const model = modified.getModel();
    if (model === null) return;
    const decorations = ranges.map((range) => {
      const from = model.getPositionAt(range.start);
      const to = model.getPositionAt(range.end);
      return {
        range: new mounted.monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
        options: {
          className: "bg-fill",
          marginClassName: "bg-fill",
          hoverMessage: { value: "Added by LibreDB to make this apply safe." },
        },
      };
    });
    if (decorationsRef.current === null) {
      decorationsRef.current = modified.createDecorationsCollection(decorations);
      return;
    }
    decorationsRef.current.set(decorations);
  }, [ranges]);

  useEffect(() => {
    paintRanges();
  }, [paintRanges]);

  const consequences = state.kind === "conflict" ? [] : (plan?.consequences ?? []);
  const needsAcknowledgement = consequences.length > 0;
  const checked = plan !== undefined && acknowledged.planId === plan.planId && acknowledged.checked;
  const truncated = preimage?.truncated;

  /**
   * One line per PINNED setting, and an asserted one draws nothing.
   *
   * Ruling 2e's user-facing half: the apply pins `search_path`, and a pin the reader cannot see is
   * a session dependency they cannot reason about. `pinnedSessionValue` is what filters the mode,
   * and reading the value straight off the entry instead would claim a pin for
   * `check_function_bodies`, which this apply only READS and never sets. A line claiming a pin for
   * a setting the apply asserts would be worse than no line at all.
   */
  const pins: { readonly setting: string; readonly value: string }[] = [];
  if (plan !== undefined && state.kind !== "conflict") {
    for (const pin of plan.session) {
      const value = pinnedSessionValue(plan, pin.setting);
      if (value === undefined || pins.some((seen) => seen.setting === pin.setting)) continue;
      pins.push({ setting: pin.setting, value });
    }
  }

  const diffOriginal = state.kind === "conflict" ? state.current.text : (preimage?.text ?? "");
  const diffModified = state.kind === "conflict" ? state.userText : (step?.text ?? "");
  const diffLanguage = state.kind === "conflict" ? state.current.language : (step?.language ?? "sql");

  /**
   * The one bound this dialog owes on the text it is handed, and it is the EXISTING number.
   *
   * `EDIT_PLAN_EXECUTABLE_LIMIT` is what both apply routes enforce, so nothing above it can ever
   * be sent and a diff of it would be a preview of an impossible apply. The population is the
   * EMBEDDED seam and not the standalone one: the standalone path is bounded at the build route
   * and again at the apply route, while an embedded host's `objectEditor.build` passes through no
   * route at all, and `isObjectEditPlanShape` bounds NO string. A 50 MB `unit.steps[0].text` is a
   * well-formed plan by that predicate, and handing it to a Monaco model hangs the host's tab
   * before the reader ever sees a preview. The measured cost of getting this wrong is the tab, so
   * the answer is a sentence rather than a model.
   *
   * `planExecutableLength` is in the maximum as well as the two diff sides, because the command
   * arm's verb and arguments are also host-supplied and are also rendered.
   */
  const previewLength = Math.max(
    diffOriginal.length,
    diffModified.length,
    plan === undefined ? 0 : planExecutableLength(plan.unit),
  );
  const oversize = previewLength > EDIT_PLAN_EXECUTABLE_LIMIT;

  const applyDisabled = truncated !== undefined || oversize || (needsAcknowledgement && !checked);
  const errorPosition =
    state.kind === "failed" && state.outcome.outcome === "refused" && state.outcome.refusal.at.within === "user"
      ? state.outcome.refusal.at
      : undefined;
  const concurrent =
    state.kind === "failed" &&
    state.outcome.outcome === "conflict" &&
    state.outcome.conflict === "engine-refused-concurrent";

  const blockExit = (event: { preventDefault: () => void }) => {
    if (applying) event.preventDefault();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-testid="object-source-apply-dialog"
        showCloseButton={!applying}
        onEscapeKeyDown={blockExit}
        onPointerDownOutside={blockExit}
        onInteractOutside={blockExit}
        onOpenAutoFocus={(event) => {
          // A destructive confirmation opens with the SAFE control focused, and it keeps focus out
          // of the diff, which is a scrollable region a screen reader would otherwise land in.
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        className="flex max-h-[85vh] w-full flex-col gap-4 sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>{frame.title}</DialogTitle>
          <DialogDescription>{`\`${objectLabel}\`, ${partLabel}. ${frame.disposition}`}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {state.kind === "building" && (
            // `output` rather than a div with role="status": it carries the live region natively,
            // which is what this repository's jsx-a11y gate asks for (`LazyView.tsx:25`).
            <output
              className="flex items-center gap-2 py-6 text-sm text-fg-muted"
              data-testid="object-source-apply-building"
            >
              <LoaderCircle aria-hidden="true" strokeWidth={1.5} className="h-4 w-4 animate-spin" />
              <span>Building the statement ...</span>
            </output>
          )}

          {state.kind === "expired" && (
            <p className="py-6 text-sm text-fg-muted" data-testid="object-source-apply-expired">
              This preview is no longer valid. Nothing was applied.
            </p>
          )}

          {state.kind === "conflict" && (
            <WarningRow testId="object-source-apply-conflict">
              This definition changed after you opened it. Nothing was applied.
            </WarningRow>
          )}

          {state.kind === "failed" && <OutcomeRegion plan={state.plan} outcome={state.outcome} label={objectLabel} />}

          {truncated !== undefined && (
            <WarningRow testId="object-source-apply-preimage-truncated">
              {`The left side is not the whole definition: ${truncated.reason}. Apply is disabled, because this product does not write back a definition it could not read whole.`}
            </WarningRow>
          )}

          {consequences.map((consequence, index) => (
            <WarningRow
              // A plan may legitimately carry two consequences of one class over two different
              // catalog facts, so the class is not a key and the index is what the list has.
              key={`${consequence.loses}-${String(index)}`}
              testId="object-source-apply-consequence"
            >
              {describeConsequence(consequence)}
            </WarningRow>
          ))}

          {needsAcknowledgement && (state.kind === "preview" || applying) && (
            <label className="flex items-center gap-2 text-xs text-fg-secondary" htmlFor="object-source-apply-ack">
              <Checkbox
                id="object-source-apply-ack"
                data-testid="object-source-apply-ack"
                checked={checked}
                disabled={applying}
                onCheckedChange={(next) => {
                  setAcknowledged({ planId: plan?.planId ?? "", checked: next === true });
                }}
              />
              <span>I understand what this will replace.</span>
            </label>
          )}

          {plan !== undefined && state.kind !== "conflict" && plan.revision.check === "compared" && (
            <p className="text-xs text-fg-muted" data-testid="object-source-apply-revision-note">
              This apply re-reads the definition first and refuses if it differs from the left side.
            </p>
          )}
          {plan !== undefined && state.kind !== "conflict" && plan.revision.check === "unavailable" && (
            <WarningRow testId="object-source-apply-revision-note">
              {`${plan.revision.reason}. This apply cannot tell whether somebody else changed this definition first.`}
            </WarningRow>
          )}

          {pins.map((pin) => (
            <p key={pin.setting} className="text-xs text-fg-muted" data-testid="object-source-apply-session-pin">
              {`LibreDB runs this apply with ${pin.setting} set to ${pin.value}, for that one round trip only.`}
            </p>
          ))}

          {oversize && (
            <WarningRow testId="object-source-apply-oversize">
              {`One side of this diff is ${counted(previewLength)} characters, above the ${counted(EDIT_PLAN_EXECUTABLE_LIMIT)} an apply can send, so LibreDB is not drawing it. Rebuild the preview, or shorten the definition.`}
            </WarningRow>
          )}

          {!oversize && plan !== undefined && step !== undefined && plan.unit.medium === "command" && (
            <div className="dark rounded-lg border border-hairline bg-black p-3 font-mono">
              <p className="mb-2 text-[0.625rem] text-fg-faint">This apply sends a command, not a statement.</p>
              <pre
                className="whitespace-pre-wrap break-words text-xs text-brand/80"
                data-testid="object-source-apply-payload"
              >
                {`${plan.unit.name} ${plan.unit.arguments.join(" ")} <library code, ${counted(plan.unit.payload.text.length)} characters>`}
              </pre>
            </div>
          )}

          {!oversize && plan !== undefined && (
            <div className="flex min-h-0 flex-col" data-testid="object-source-apply-diff">
              <div className="grid grid-cols-2 border-b border-border text-[11px] text-fg-muted">
                <span className="px-2 py-1" data-testid="object-source-apply-diff-header">
                  {frame.preimageIsCurrent ? "On the server now" : "On the server before this apply"}
                </span>
                <span className="px-2 py-1" data-testid="object-source-apply-diff-header">
                  {state.kind === "conflict" ? "Your edit" : sent ? "What was sent" : "Will be sent"}
                </span>
              </div>
              <div className="h-72">
                <DiffEditor
                  original={diffOriginal}
                  modified={diffModified}
                  language={diffLanguage}
                  originalModelPath={`libredb-apply-original:${address}/${partId}`}
                  modifiedModelPath={`libredb-apply-modified:${address}/${partId}`}
                  theme={theme === "light" ? STUDIO_THEME_LIGHT : STUDIO_THEME_DARK}
                  beforeMount={defineStudioThemes}
                  onMount={(diff, monaco) => {
                    editorRef.current = { diff, monaco };
                    paintRanges();
                  }}
                  options={{
                    // WCAG 2.1.2: without this the diff is a keyboard trap, because Tab inserts a
                    // tab character instead of moving focus out of the control.
                    tabFocusMode: true,
                    readOnly: true,
                    originalEditable: false,
                    renderSideBySide: true,
                    automaticLayout: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                  }}
                />
              </div>
            </div>
          )}

          {!oversize && plan !== undefined && step !== undefined && plan.unit.medium === "statement" && (
            <p className="text-[11px] text-fg-muted" data-testid="object-source-apply-identity">
              {identitySentence(plan, sent)}
            </p>
          )}

          {applying && (
            <output
              className="flex items-center gap-2 text-xs text-fg-muted"
              data-testid="object-source-apply-applying"
            >
              <LoaderCircle aria-hidden="true" strokeWidth={1.5} className="h-3.5 w-3.5 animate-spin" />
              <span>Applying ...</span>
            </output>
          )}
        </div>

        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="ghost"
            disabled={applying}
            data-testid="object-source-apply-cancel"
            onClick={onClose}
          >
            {state.kind === "failed" ? "Close" : "Cancel"}
          </Button>

          {errorPosition !== undefined && (
            <Button
              data-testid="object-source-apply-goto-error"
              onClick={() => {
                onGoToError(errorPosition);
              }}
            >
              Go to the error
            </Button>
          )}

          {(state.kind === "conflict" || state.kind === "expired") && (
            <Button data-testid="object-source-apply-rebuild" onClick={onRebuild}>
              Rebuild preview
            </Button>
          )}

          {concurrent && (
            <Button data-testid="object-source-apply-confirm" onClick={onRebuild}>
              Try again
            </Button>
          )}

          {(state.kind === "building" || state.kind === "preview" || applying) && (
            <Button
              data-testid="object-source-apply-confirm"
              disabled={state.kind === "building" || applying || applyDisabled}
              onClick={() => {
                onApply([...new Set(consequences.map((consequence) => consequence.loses))]);
              }}
            >
              {applying ? "Applying ..." : "Apply"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What an apply DID, kept on screen with the diff still under it (#789 Phase 3).
 *
 * Every failure keeps this dialog open, which is what makes the outcome impossible to miss and
 * gives the reader one place to decide what to do next. The engine's own code is rendered AS DATA
 * beside its own sentence, because the shipped error mapper destroys both: MEASURED, `42501`
 * becomes HTTP 401 "Authentication failed" for a credential that is connected and correct, and
 * `42P13` becomes HTTP 500 with the SQLSTATE and the engine's hint gone.
 *
 * It is an OUTCOME region and not a failure region: three of the arms below report an apply that
 * SUCCEEDED, and one of those is the whole reason this region is kept on screen after a success.
 * `role="alert"` stays on all of them, because an apply that destroyed a sibling function deserves
 * the same attention as one that was refused; only the name was ever wrong.
 *
 * The `data-testid` still reads `object-source-apply-failure`, and that is a KNOWN STALE NAME
 * rather than an oversight. MEASURED: renaming it to `object-source-apply-outcome` fails 10 tests
 * across three suites that read it (`ObjectSourceView.test.tsx` 6, `embedded-source.test.tsx` 3,
 * `source-tab.test.tsx` 1) and one Playwright assertion that reads the code child, and none of
 * those four files belongs to the change that renamed this one. The rename is a mechanical
 * substitution of two strings and it travels with an edit to those four files, in one commit.
 */
function OutcomeRegion({
  plan,
  outcome,
  label,
}: {
  readonly plan: ObjectEditPlan;
  readonly outcome: ApplyPreviewFailure;
  readonly label: string;
}): React.JSX.Element {
  const lines: string[] = [];
  let code: string | undefined;

  if (outcome.outcome === "refused") {
    lines.push(outcome.refusal.sentence);
    code = outcome.refusal.code;
    if (outcome.refusal.hint !== undefined) lines.push(outcome.refusal.hint);
    const pinned = describePinnedPathRefusal(plan, outcome.refusal);
    if (pinned !== undefined) lines.push(pinned);
    if (outcome.refusal.refusal === "privilege") {
      lines.push(
        "This apply runs as the database credential on this connection and not as your LibreDB login, so " +
          "re-entering your password will not change this.",
      );
    }
    if (outcome.refusal.at.within === "outside") {
      // Turning a splice defect from invisible into reader-visible and test-visible: MEASURED in a
      // browser, an uncorrected coordinate handed to `setModelMarkers` is silently CLAMPED to the
      // end of the model, so a wrong marker looks exactly like a right one.
      lines.push("The engine reported a position inside the part LibreDB added, so no marker was placed.");
    }
  } else if (outcome.outcome === "conflict") {
    // The ONLY conflict this state can carry: `ApplyPreviewFailure` excludes `object-changed`, so
    // this arm is narrowed to `engine-refused-concurrent` by the type and not by a check whose
    // other branch nothing builds. MEASURED on PostgreSQL 18.4: a well-formed, UP-TO-DATE apply
    // refused purely on timing after blocking for 2.8 seconds, so a "this changed" screen would
    // show two identical texts.
    lines.push(
      "Another session was changing this object at the same moment, so the engine refused this change. Nothing was applied.",
    );
    lines.push(outcome.sentence);
    code = outcome.code;
  } else if (outcome.outcome === "applied-with-collateral") {
    // The arm whose outcome carries a NON-EMPTY `lost` tuple, which is a catalog fact read AFTER
    // the apply and never a restatement of the plan's warning. Folding it into the plain `applied`
    // sentence printed "Nothing here needs fixing." over a function the apply had just deleted,
    // which is the exact opposite of what the tuple was added to make sayable.
    lines.push(
      "The engine applied this change and it destroyed something else, read back from the catalog after the apply.",
    );
    for (const lost of outcome.lost) lines.push(`${lost.fact.source} answers: ${lost.fact.observed}.`);
  } else if (outcome.outcome === "applied-elsewhere") {
    lines.push(`This text does not name \`${label}\`, so that object was not changed.`);
    lines.push(
      outcome.undone
        ? "A different object was written and LibreDB took that back, so nothing was left behind."
        : outcome.wrote === undefined
          ? "A different object was created and LibreDB did not remove it."
          : `A different object was created and LibreDB did not remove it: \`${outcome.wrote}\`.`,
    );
  } else if (outcome.outcome === "interrupted") {
    // No retry on this arm at any status, and that is the point of the arm: MEASURED, a PostgreSQL
    // DDL timeout answers HTTP 499 and a Trino one answers 408 with `retryable: true`, and a client
    // that retries an apply whose disposition is unknown applies twice.
    lines.push(
      outcome.committed === "rolled-back"
        ? "The engine stopped this statement before it finished, and this apply rolled it back, so nothing was applied."
        : "The engine stopped this statement before it finished. Whether it was applied is unknown.",
    );
    lines.push(outcome.sentence);
  } else {
    // `applied`, and only `applied`. The mount closes this dialog on success, so nothing
    // in this product puts a success into the `failed` state. It is renderable rather than a throw
    // because the prop type cannot exclude it and a blank region would be the worse answer.
    lines.push("The engine reported this apply as done. Nothing here needs fixing.");
  }

  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-border bg-warning/10 px-3 py-2 text-xs text-warning"
      data-testid="object-source-apply-failure"
      role="alert"
    >
      {lines.map((line, index) => (
        <span key={`${String(index)}-${line}`} className="min-w-0 break-words">
          {line}
        </span>
      ))}
      {code !== undefined && (
        <span className="font-mono text-fg-muted" data-testid="object-source-apply-failure-code">
          {code}
        </span>
      )}
    </div>
  );
}
