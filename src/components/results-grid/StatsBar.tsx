"use client";

import React, { useState } from "react";
import { useDismissOnOutsideClick } from "@/hooks/use-dismiss-on-outside-click";
import { QueryResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  LayoutGrid,
  Table2,
  LoaderCircle,
  EyeOff,
  Eye,
  Save,
  X,
  Funnel,
  Lock,
  WrapText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CellChange } from "@/components/ResultsGrid";
import { describeWarning } from "@/components/results-grid/utils";

const MASKED_LABEL = "masked";
const LOADING_LABEL = "Loading...";
/**
 * The control's label, which names the size of the page the click will fetch.
 *
 * It was the literal "Load More (500 rows)" on a button below the grid. A table preview
 * asks for 50, so that label promised ten times what the click delivered from the moment
 * the preview cap stopped being written into the statement (#816). Lower case and no
 * parentheses because it is now a phrase in the stats strip, read as a continuation of
 * the row count beside it: "50 rows - load 50 more".
 */
const loadMoreLabel = (pageSize: number) => `load ${pageSize} more`;

/**
 * Criterion 7, beside the AUTO-LIMITED badge.
 *
 * A statement of fact and not a warning: an unordered query paginates, and this is what
 * paging it means. It is not styled as an error and it blocks nothing, because Studio
 * will not inject an `ORDER BY` to prevent the condition and the user may well not care
 * about it. `ResultsGrid` decides when it is shown and will not show it where no next
 * page can be asked for.
 *
 * A badge rather than a sentence, with the sentence itself on the `title` and in an
 * `sr-only` span the way the warning badge below carries its detail. A sentence of this
 * length wraps the strip onto a second line on a narrow results panel, and a strip whose
 * height changes with the query is the thing the footer was deleted to stop.
 *
 * ONE GLYPH, and it used to be the words "ORDER NOT GUARANTEED". MEASURED in the running
 * app: those words took 154px of a 960px strip, next to 99px for the limit badge and 95px
 * for a duration, so a third of the strip went to three facts of one word each while the
 * right-hand end clipped. The glyph holds 23px and loses nothing, because everything the
 * words said is in the `title` and the `sr-only` span already and always was: a reader who
 * hovers or listens gets the sentence, and the words only ever told a sighted reader that
 * SOMETHING about ordering applied here.
 */
const ORDER_BADGE = "!";
const ORDER_NOTICE = "Without an ORDER BY the engine may return rows that repeat or are skipped between pages.";

/**
 * What a filtered count counted, said only where it is not the whole story (#870).
 *
 * The filter runs over `result.rows` (`ResultsGrid.tsx`), the rows loaded so far. While
 * another page can still be fetched that is a strict subset of the object, so "1 shown"
 * is read as a count over the table and nothing on screen contradicts it.
 *
 * Gated on `pageOffer`, the decision this strip already receives, rather than on
 * `result.pagination?.hasMore`: the offer is the same condition the load-more control
 * renders from, so the qualification cannot appear beside a control that is absent, and
 * a result with no next page keeps its unqualified count.
 *
 * It rides the existing button's `title` after the action rather than adding a badge of
 * its own, and the visible text carries the scope itself so a sighted reader is not left
 * depending on a tooltip.
 *
 * "10 of 50" and not "10 of 50 loaded", MEASURED in the running app rather than chosen:
 * with the agent rail open, the longer wording wrapped this strip from 55px to 71px while
 * every shorter candidate held 55px, and a strip whose height changes with the query is
 * what the footer was deleted to stop. The count it is "of" is the loaded row count, which
 * the strip already names as "50 rows" at its left edge, and the sentence below says which
 * rows those are.
 */
/**
 * The limit badge, lower case since #870.
 *
 * It said "AUTO-LIMITED" in the strip's shouting idiom, which cost 99px to say one word.
 * The word that carries the fact is "limited"; what applied the limit is in the sentence
 * on the `title`, where the other badges beside it already keep theirs.
 *
 * The sentence is true of every bound that sets `pagination.wasLimited`, and since #1085
 * (section 5.4) that is not only the limiter's: `POST /api/db/query` also keeps a bound a
 * provider applied to its own result. It used to say "Rows beyond the bound were not
 * fetched.", which is the limiter's bound alone. The Prometheus provider applies its bounds
 * once the answer has arrived: its matrix cell budget leaves out whole series, which are
 * columns of the wide grid, and on an engine that ignores `limit` its series cap leaves out
 * series the server sent. So the sentence names neither rows nor fetching. It points at no
 * warning either, because the limiter writes none, and it stays true of a limiter bound the
 * result fit inside, where nothing lies beyond the bound.
 */
const AUTO_LIMIT_BADGE = "limited";
const AUTO_LIMIT_NOTICE = "Studio bounded this result. Anything beyond the bound is not in it.";

/** What the duration beside it is, for anyone who hovers or listens. */
const EXEC_TIME_NOTICE = "Execution time";

const FILTER_SCOPE_NOTICE = "Filtering runs over the rows loaded so far. Rows not yet loaded are not searched.";

export interface StatsBarProps {
  result: QueryResult;
  filteredRowCount: number;
  activeFilterCount: number;
  onClearFilters: () => void;
  viewMode: "card" | "table";
  onSetViewMode: (mode: "card" | "table") => void;
  wrapText: boolean;
  onToggleWrapText: () => void;
  // Masking props
  hasSensitive: boolean;
  effectiveMaskingEnabled: boolean;
  userCanToggle: boolean;
  onToggleMasking?: () => void;
  // Editing props
  editingEnabled?: boolean;
  pendingChanges?: CellChange[];
  onApplyChanges?: () => void;
  onDiscardChanges?: () => void;
  /**
   * Whether this result is pageable AND its statement carries no `ORDER BY` (#816).
   *
   * A decision, not the inputs to one. It is made once in `ResultsGrid`, from the same
   * value that decides whether the load-more control renders, so the notice cannot appear
   * beside a control that is not there.
   */
  orderAcrossPagesUnspecified?: boolean;
  /**
   * The offer of a next page, or absent where there is none (#816).
   *
   * A decision for the same reason `orderAcrossPagesUnspecified` is: `ResultsGrid` makes
   * it once, from the provider's `supportsResultPagination`, the route's `hasMore` and
   * whether this surface will fetch at all. Passing the three inputs here instead would
   * be a second place for them to be combined, and the notice above is the proof that
   * two copies of one condition drift.
   *
   * `pageSize` is `result.pagination.limit`, the size of the page already on screen, so
   * the label names what the click delivers.
   *
   * This replaces `onLoadMore` and `isLoadingMore`, which this interface declared and
   * neither destructured nor rendered: `ResultsGrid` passed neither and the footer took
   * them directly. Dead props that look wired are how the next reader binds a control to
   * a callback nothing supplies.
   */
  pageOffer?: { onLoadMore: () => void; pageSize: number };
  /** Whether a page asked for through `pageOffer` is in flight; the control is disabled and says so. */
  isLoadingMore?: boolean;
  /**
   * The fields currently hidden from the grid, and the writer that flips one (#870).
   *
   * `columnVisibilityFeature` was registered in `ResultsGrid` with nothing calling
   * `toggleVisibility`, so the capability was live and unreachable. The entry point is
   * the column count already printed here, made clickable the way #816 made
   * "(more available)" the load-more control, so the grid gains no chrome for it.
   *
   * `onToggleColumn` is what gates the control, not `hiddenColumns`: an empty set is the
   * ordinary state of a grid whose columns can all be toggled, while a surface that owns
   * no table supplies no writer at all and must keep inert text. Gated on the callback
   * for the same reason `pageOffer` gates the load-more control.
   */
  hiddenColumns?: ReadonlySet<string>;
  onToggleColumn?: (field: string) => void;
}

export function StatsBar({
  result,
  filteredRowCount,
  activeFilterCount,
  onClearFilters,
  viewMode,
  onSetViewMode,
  wrapText,
  onToggleWrapText,
  hasSensitive,
  effectiveMaskingEnabled,
  userCanToggle,
  onToggleMasking,
  editingEnabled,
  pendingChanges,
  onApplyChanges,
  onDiscardChanges,
  orderAcrossPagesUnspecified,
  pageOffer,
  isLoadingMore,
  hiddenColumns,
  onToggleColumn,
}: StatsBarProps) {
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  /*
    The ref goes on the span that holds the trigger AND the menu, so pressing the trigger
    is not "outside" and keeps reaching its own toggle.
  */
  const columnMenuRef = useDismissOnOutsideClick<HTMLSpanElement>(columnMenuOpen, () => setColumnMenuOpen(false));
  const warnings = result.warnings ?? [];
  const hiddenCount = hiddenColumns?.size ?? 0;
  const columnLabel =
    hiddenCount > 0
      ? `${result.fields.length - hiddenCount} of ${result.fields.length} columns`
      : `${result.fields.length} columns`;
  const warningDetail = warnings.map(describeWarning).join("\n");

  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-hairline bg-surface text-xs text-fg-muted font-mono">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-success-tint/50" />
          {result.rows.length} rows
          {/*
            THE LOAD MORE CONTROL (#816). It stands where the "(more available)" text
            stood: the same fact, now the thing you click, so the grid gains no chrome
            and keeps its height whether or not another page exists.

            Gated on `pageOffer` alone and not on `result.pagination?.hasMore`, which is
            what the text read before. `hasMore` is one of the three conditions the offer
            already carries, and re-reading it here would let the strip announce a page
            on a surface that cannot fetch it.
          */}
          {pageOffer && (
            <>
              <span aria-hidden="true">&bull;</span>
              <button
                type="button"
                onClick={pageOffer.onLoadMore}
                disabled={isLoadingMore}
                className="flex items-center gap-1 text-brand bg-brand-tint/10 px-2 py-0.5 rounded hover:bg-brand-tint/20 disabled:opacity-60 disabled:hover:bg-brand-tint/10 transition-colors"
              >
                {isLoadingMore ? (
                  <>
                    <LoaderCircle strokeWidth={1.5} className="w-3 h-3 animate-spin" />
                    {LOADING_LABEL}
                  </>
                ) : (
                  <>
                    <ChevronDown strokeWidth={1.5} className="w-3 h-3" />
                    {loadMoreLabel(pageOffer.pageSize)}
                  </>
                )}
              </button>
            </>
          )}
        </span>
        {/*
          THE COLUMN VISIBILITY ENTRY POINT (#870). The count that was here stays the
          only thing on screen; it becomes the control rather than gaining one beside it.
          Inert where no writer was supplied, because a hydrated result owns no table.
        */}
        {onToggleColumn === undefined ? (
          <span className="hidden sm:inline">{columnLabel}</span>
        ) : (
          <span className="hidden sm:inline relative" ref={columnMenuRef}>
            <button
              type="button"
              className="hover:text-fg-secondary transition-colors"
              onClick={() => setColumnMenuOpen((open) => !open)}
              /*
                Escape closes it, which is what the column filter popover in `ResultsGrid`
                binds too. Bound on the TRIGGER and not on the wrapping span: the trigger
                keeps focus while the menu is open so the key lands here anyway, and a
                span carrying a handler is a `jsx-a11y(no-static-element-interactions)`
                error, which is a hard lint gate in this repository.
              */
              onKeyDown={(event) => {
                if (event.key === "Escape") setColumnMenuOpen(false);
              }}
              title="Show or hide columns"
              aria-expanded={columnMenuOpen}
            >
              {columnLabel}
            </button>
            {columnMenuOpen && (
              <div
                data-testid="column-visibility-menu"
                /*
                  DOWNWARD, into the results panel, and not `bottom-full` above the strip.
                  This strip is the TOP edge of the results panel and the Monaco editor
                  sits directly above it, so a menu opened upward renders inside the
                  editor's stacking context: visible, and with every click swallowed by
                  `.view-lines`. Measured in the running app, not reachable from jsdom,
                  where nothing is mounted above this component. Same direction and the
                  same `z-30` as the column filter popover in `ResultsGrid`.
                */
                className="absolute top-full left-0 mt-1 z-30 bg-overlay border border-hairline-strong rounded-lg shadow-xl p-1 w-48 max-h-64 overflow-auto"
              >
                {result.fields.map((field) => {
                  const isHidden = hiddenColumns?.has(field) === true;
                  return (
                    <button
                      key={field}
                      type="button"
                      data-column={field}
                      aria-pressed={!isHidden}
                      className="flex items-center gap-2 w-full px-2 py-1 rounded text-left hover:bg-fill transition-colors"
                      onClick={() => onToggleColumn(field)}
                    >
                      {isHidden ? (
                        <EyeOff strokeWidth={1.5} className="w-3 h-3 shrink-0 text-fg-muted" />
                      ) : (
                        <Eye strokeWidth={1.5} className="w-3 h-3 shrink-0 text-brand" />
                      )}
                      <span className={cn("truncate", isHidden && "text-fg-muted")}>{field}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </span>
        )}
        {activeFilterCount > 0 && (
          <button
            className="flex items-center gap-1 text-brand text-xs bg-brand-tint/10 px-2 py-0.5 rounded hover:bg-brand-tint/20 transition-colors"
            onClick={onClearFilters}
            title={pageOffer ? `Clear all filters. ${FILTER_SCOPE_NOTICE}` : "Clear all filters"}
          >
            <Funnel strokeWidth={1.5} className="w-3 h-3" />
            {/*
              THE COUNT, AND NOT "2 filters" BESIDE IT. Which columns carry a filter is
              already on screen: the funnel in each filtered header renders in `text-brand`
              while an unfiltered one is invisible until hover (`ResultsGrid`), so the
              number here only restated what the headers show, in the one strip whose
              width is scarce. The icon on this chip says a filter is active; the text says
              the one thing nothing else does, which is how many rows came through it.

              The filter count survives for a screen reader, which cannot see either funnel.
            */}
            <span data-testid="filter-summary">
              {pageOffer ? `${filteredRowCount} of ${result.rows.length}` : `${filteredRowCount} shown`}
            </span>
            <span className="sr-only">
              , {activeFilterCount} column filter{activeFilterCount > 1 ? "s" : ""} active
            </span>
            <X strokeWidth={1.5} className="w-3 h-3" />
          </button>
        )}
        {result.pagination?.wasLimited && (
          <span className="text-brand text-xs bg-brand-tint/10 px-2 py-0.5 rounded" title={AUTO_LIMIT_NOTICE}>
            {AUTO_LIMIT_BADGE}
            <span className="sr-only">: {AUTO_LIMIT_NOTICE}</span>
          </span>
        )}
        {orderAcrossPagesUnspecified && (
          <span className="text-fg-muted text-xs bg-fill px-2 py-0.5 rounded" title={ORDER_NOTICE}>
            {ORDER_BADGE}
            <span className="sr-only">: {ORDER_NOTICE}</span>
          </span>
        )}
        {warnings.length > 0 && (
          <span className="text-warning text-xs bg-warning-tint/10 px-2 py-0.5 rounded" title={warningDetail}>
            {warnings.length} warning{warnings.length > 1 ? "s" : ""}
            <span className="sr-only">: {warningDetail}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {hasSensitive &&
          (userCanToggle && onToggleMasking ? (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-6 px-2 text-xs font-medium gap-1",
                effectiveMaskingEnabled ? "text-hue-purple bg-hue-purple-tint/10" : "text-fg-muted",
              )}
              onClick={onToggleMasking}
              title={effectiveMaskingEnabled ? "Show sensitive data" : "Mask sensitive data"}
            >
              {effectiveMaskingEnabled ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              {effectiveMaskingEnabled ? "MASKED" : "MASK"}
            </Button>
          ) : effectiveMaskingEnabled ? (
            <span className="h-6 px-2 text-xs font-medium text-hue-purple bg-hue-purple-tint/10 rounded flex items-center gap-1">
              <Lock strokeWidth={1.5} className="w-3 h-3" />
              {MASKED_LABEL}
            </span>
          ) : null)}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-6 px-2 text-xs font-medium gap-1",
            wrapText ? "text-brand bg-brand-tint/10" : "text-fg-muted",
          )}
          onClick={onToggleWrapText}
          title={wrapText ? "Disable text wrapping" : "Enable text wrapping"}
        >
          <WrapText className="w-3 h-3" />
          {wrapText ? "WRAP ON" : "WRAP"}
        </Button>

        {editingEnabled && pendingChanges && pendingChanges.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="text-xs text-warning bg-warning-tint/10 px-1.5 py-0.5 rounded">
              {pendingChanges.length} change{pendingChanges.length > 1 ? "s" : ""}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-success hover:bg-success-tint/10"
              aria-label="Apply changes"
              onClick={onApplyChanges}
            >
              <Save strokeWidth={1.5} className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-danger hover:bg-danger-tint/10"
              aria-label="Discard changes"
              onClick={onDiscardChanges}
            >
              <X strokeWidth={1.5} className="w-3 h-3" />
            </Button>
          </div>
        )}

        {/*
          THE DURATION, WITHOUT ITS LABEL. "EXEC TIME: " took 95px of a 960px strip to say
          what a duration beside a row count already reads as. It also lost its unit: the
          value is a number and `ms` sat only in the zero fallback, so a two millisecond
          query rendered "EXEC TIME: 2". The full words stay on the `title`.
        */}
        <span className="hidden sm:flex px-2 py-0.5 rounded bg-fill border border-hairline" title={EXEC_TIME_NOTICE}>
          {result.executionTime ?? 0}ms<span className="sr-only"> {EXEC_TIME_NOTICE}</span>
        </span>

        <div className="flex md:hidden items-center bg-fill rounded-lg p-0.5">
          <button
            onClick={() => onSetViewMode("card")}
            aria-label="Card view"
            title="Card view"
            className={cn(
              "p-1.5 rounded transition-all",
              viewMode === "card" ? "bg-brand-solid text-white" : "text-fg-muted",
            )}
          >
            <LayoutGrid strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onSetViewMode("table")}
            aria-label="Table view"
            title="Table view"
            className={cn(
              "p-1.5 rounded transition-all",
              viewMode === "table" ? "bg-brand-solid text-white" : "text-fg-muted",
            )}
          >
            <Table2 strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
