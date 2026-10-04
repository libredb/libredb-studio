"use client";

import React, { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { QueryResult, type DatabaseType } from "@/lib/types";
import {
  type ColumnDef,
  type SortFn,
  type SortingState,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createSortedRowModel,
  flexRender,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { ArrowUpDown, ArrowUp, ArrowDown, Eye, Funnel, Lock, Rows3 } from "lucide-react";
import { toast } from "sonner";
import {
  type MaskingConfig,
  detectSensitiveColumnsFromConfig,
  maskValueByPattern,
  maskingInForce,
  canToggleMasking,
  canReveal,
  loadMaskingConfig,
} from "@/lib/data-masking";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { writeToClipboard } from "@/components/copy-button";
import { ResultCard } from "@/components/results-grid/ResultCard";
import { RowDetailSheet } from "@/components/results-grid/RowDetailSheet";
import { StatsBar } from "@/components/results-grid/StatsBar";
import {
  describeWarning,
  foldFilterCase,
  formatCellCopy,
  formatCellValue,
  renderContextFor,
} from "@/components/results-grid/utils";
import {
  getHeaderFitColumnSize,
  RESULT_COLUMN_MAX_SIZE,
  RESULT_COLUMN_MIN_SIZE,
} from "@/components/results-grid/column-sizing";
import { isNumericColumn, numericCellComparator } from "@/components/results-grid/numeric-sort";
import { hasResultOrder } from "@/lib/sql/result-order";
import { pageOfferFor } from "@/components/results-grid/page-offer";
import { useDismissOnOutsideClick } from "@/hooks/use-dismiss-on-outside-click";
import type { ProviderCapabilities } from "@/lib/db/types";
import { binaryCellsAsHex, jsonText } from "@/lib/export/json";

export interface CellChange {
  rowIndex: number;
  columnId: string;
  originalValue: unknown;
  newValue: string;
}

const CLEAR_FILTER_LABEL = "Clear filter";
const EMPTY_RESULT_HINT = "The operation was successful, but the result set is currently empty.";
/**
 * What a write statement answers: no columns, no rows, and the count of rows it changed. The
 * grid used to draw its empty state for it, which read as "nothing happened" next to a count
 * the API had already returned (#1425). A zero count stays on the empty state: an engine that
 * reports none and a write that matched nothing cannot be told apart from here.
 */
function affectedRowsLabel(result: QueryResult | undefined): string | undefined {
  if (!result || result.fields.length > 0 || result.rows.length > 0 || !(result.rowCount > 0)) return undefined;
  const noun = result.rowCount === 1 ? "row" : "rows";
  return `${result.rowCount} ${noun} affected${result.rolledBack === true ? ", rolled back" : ""}`;
}
const ENGINE_WARNINGS_LABEL = "The engine reported:";
const ROW_DETAIL_COLUMN_ID = "__libredb_row_detail__";
const ROW_DETAIL_HEADER_TITLE = "Show a row field by field";

/**
 * A column id for the row detail control that no field of this result already carries.
 *
 * A column name is arbitrary SQL output and `SELECT 1 AS "__libredb_row_detail__"` is a
 * legal statement, so a fixed id would collide with it and the table would hold two
 * columns under one id - TanStack keys rows and cells by it.
 */
function rowDetailColumnId(fields: string[]): string {
  let id = ROW_DETAIL_COLUMN_ID;
  while (fields.includes(id)) id = `_${id}`;
  return id;
}

/**
 * TanStack Table 9 does not ship every feature to every table: each one is
 * opted into here, and only the opted-in features contribute code, state slices
 * and typed options. That is the point of the v8 -> v9 redesign, so this grid
 * declares exactly what it uses and nothing else:
 *
 * - `rowSortingFeature` + `sortedRowModel` - the sortable column headers
 * - `columnSizingFeature` + `columnResizingFeature` - the drag-to-resize handles
 *   (resizing builds on sizing, and the library validates that pairing)
 * - `columnVisibilityFeature` - `row.getVisibleCells()` in the row renderer
 *
 * Declared at module scope rather than inside the component because the object
 * is the table's static shape: rebuilding it per render would rebuild the
 * feature set on every keystroke.
 */
const tableFeatureSet = tableFeatures({
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

interface ResultsGridProps {
  result: QueryResult;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  /**
   * Whether the provider these rows came from can be asked for the page AFTER this one
   * (`ProviderCapabilities.supportsResultPagination`, #816).
   *
   * Gated on `=== true`, so an absent flag hides the control: five providers cannot page
   * at all — two throw and three answer a page request with page one — and a control that
   * can only re-fetch what is already on screen is worse than no control (#269's rule).
   */
  supportsResultPagination?: boolean;
  /**
   * The statement that produced these rows, for the ordering notice only.
   *
   * The tab's `resultQuery` and not the editor buffer: the buffer is rewritten on every
   * keystroke, and the condition being stated is about the rows on screen. Absent when
   * the surface cannot name the statement, and then nothing is claimed either way.
   */
  resultQuery?: string;
  /** The dialect `resultQuery` is read under; `#` and `[…]` mean different things (#292). */
  databaseType?: DatabaseType;
  maskingEnabled?: boolean;
  onToggleMasking?: () => void;
  userRole?: string;
  maskingConfig?: MaskingConfig;
  // Inline editing props
  editingEnabled?: boolean;
  /** The provider's columns the editor must not write (`ProviderCapabilities.inlineEditRefusedColumns`). */
  inlineEditRefusedColumns?: ProviderCapabilities["inlineEditRefusedColumns"];
  pendingChanges?: CellChange[];
  onCellChange?: (change: CellChange) => void;
  onDiscardChanges?: () => void;
  onApplyChanges?: () => void;
}

// Detect primary column (first text-like column that's not an ID)
/**
 * The type the source declared for `field`, or undefined when it declared none.
 *
 * Own-key check rather than a direct lookup: a column name is arbitrary SQL output
 * and `SELECT 1 AS constructor` is legal, so `columnTypes[field]` would otherwise
 * answer from `Object.prototype` - handing React a function as header content.
 */
function declaredTypeOf(columnTypes: Record<string, string> | undefined, field: string): string | undefined {
  return columnTypes !== undefined && Object.hasOwn(columnTypes, field) ? columnTypes[field] : undefined;
}

function detectPrimaryColumn(fields: string[], rows: Record<string, unknown>[]): string {
  const preferredNames = ["name", "title", "label", "username", "email", "description"];

  for (const name of preferredNames) {
    if (fields.some((f) => f.toLowerCase().includes(name))) {
      return fields.find((f) => f.toLowerCase().includes(name))!;
    }
  }

  // Find first string column that's not an ID
  if (rows.length > 0) {
    for (const field of fields) {
      const value = rows[0][field];
      if (typeof value === "string" && !field.toLowerCase().includes("id")) {
        return field;
      }
    }
  }

  return fields[0];
}

// Get ID column if exists
function detectIdColumn(fields: string[]): string | null {
  return fields.find((f) => f.toLowerCase() === "id" || f.toLowerCase().endsWith("_id")) || null;
}

export function ResultsGrid({
  result,
  onLoadMore,
  isLoadingMore,
  supportsResultPagination,
  resultQuery,
  databaseType,
  maskingEnabled,
  onToggleMasking,
  userRole,
  maskingConfig,
  editingEnabled,
  inlineEditRefusedColumns,
  pendingChanges,
  onCellChange,
  onDiscardChanges,
  onApplyChanges,
}: ResultsGridProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [editingCell, setEditingCell] = useState<{ rowIndex: number; columnId: string } | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [viewMode, setViewMode] = useState<"card" | "table">("card");
  const [wrapText, setWrapText] = useState(false);
  const [selectedRow, setSelectedRow] = useState<{ row: Record<string, unknown>; index: number } | null>(null);
  const [typedFilters, setColumnFilters] = useState<Map<string, string>>(new Map());
  const [activeFilterCol, setActiveFilterCol] = useState<string | null>(null);
  /**
   * Which fields are hidden, as TanStack's own visibility map (#870).
   *
   * `columnVisibilityFeature` has been in `tableFeatureSet` since the grid was written and
   * nothing ever wrote to it, so `row.getVisibleCells()` could only ever return them all.
   * The writer is the column count in the stats strip; this is the state it writes.
   *
   * Held as the feature's map rather than as a set of hidden names so the table is handed
   * the shape it already understands, and derived back to a set for the strip, which
   * should not have to know TanStack's convention that absent means visible.
   */
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});
  /*
    The filter panel closes on a press outside it. The ref lands on the header cell that is
    currently showing one, which holds the funnel that opened it as well as the panel, so
    pressing the funnel again still reaches its own toggle rather than being dismissed here
    and reopened by the click that follows.
  */
  const filterPanelRef = useDismissOnOutsideClick<HTMLDivElement>(activeFilterCol !== null, () =>
    setActiveFilterCol(null),
  );
  const [revealedCells, setRevealedCells] = useState<Set<string>>(new Set());
  const [contextCell, setContextCell] = useState<{ rowIndex: number; field: string } | null>(null);

  // Resolve config
  const resolvedConfig = useMemo(() => maskingConfig ?? loadMaskingConfig(), [maskingConfig]);

  // Effective masking state (RBAC-aware)
  const effectiveMaskingEnabled = useMemo(() => {
    return maskingInForce(userRole, resolvedConfig, maskingEnabled);
  }, [userRole, resolvedConfig, maskingEnabled]);

  const userCanToggle = useMemo(() => canToggleMasking(userRole, resolvedConfig), [userRole, resolvedConfig]);
  const userCanReveal = useMemo(() => canReveal(userRole, resolvedConfig), [userRole, resolvedConfig]);

  // Config-based sensitive column detection
  const sensitiveColumns = useMemo(
    () => detectSensitiveColumnsFromConfig(result.fields, resolvedConfig),
    [result.fields, resolvedConfig],
  );

  const hasSensitive = sensitiveColumns.size > 0;

  /**
   * A filter belongs to the run it was typed against (#1409).
   *
   * A column the rows lack reads as "", so a filter carried into a different query matched nothing
   * and hid every row while the strip still counted them. Two things end a filter, both decided
   * during render so no frame draws the stale one:
   *
   * - A different RUN clears them all. The run is the statement that produced the rows
   *   (`resultQuery`, unchanged by Load More, which only appends a page to the same run); with none
   *   given, as for a hydrated result, the column set stands in for it.
   * - Within one run a changed column set (Load More on a document engine re-derives it from the
   *   rows) only drops the filters whose column is gone, so the user's filter survives the page.
   *
   * The same statement re-run keeps its filter on purpose: it is the same question asked again.
   */
  const fieldsKey = JSON.stringify(result.fields);
  const runKey = resultQuery === undefined ? `fields:${fieldsKey}` : `query:${resultQuery}`;
  const [seenRun, setSeenRun] = useState(runKey);
  const [seenFields, setSeenFields] = useState(fieldsKey);
  if (seenRun !== runKey) {
    setSeenRun(runKey);
    setSeenFields(fieldsKey);
    setColumnFilters(new Map());
    setActiveFilterCol(null);
  } else if (seenFields !== fieldsKey) {
    setSeenFields(fieldsKey);
    const present = new Set(result.fields);
    setColumnFilters((prev) => new Map([...prev].filter(([col]) => present.has(col))));
    if (activeFilterCol !== null && !present.has(activeFilterCol)) setActiveFilterCol(null);
  }
  const columnFilters = typedFilters;

  // Clear revealed cells when result changes
  useEffect(() => {
    setRevealedCells(new Set());
  }, [result]);

  // The copy menu names a row and a column, and a new result, a new sort or a new filter
  // can retire either one while a menu still holds them.
  useEffect(() => {
    setContextCell(null);
  }, [result, sorting, columnFilters]);

  // Per-cell reveal with auto-hide
  const revealCell = useCallback((key: string) => {
    setRevealedCells((prev) => new Set(prev).add(key));
    setTimeout(() => {
      setRevealedCells((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, 10000);
  }, []);

  const primaryColumn = useMemo(() => detectPrimaryColumn(result.fields, result.rows), [result.fields, result.rows]);

  const idColumn = useMemo(() => detectIdColumn(result.fields), [result.fields]);

  const detailColumnId = useMemo(() => rowDetailColumnId(result.fields), [result.fields]);

  // Filter rows based on column filters
  const filteredRows = useMemo(() => {
    if (columnFilters.size === 0) return result.rows;
    // Folded once here, not once per row.
    const wanted = [...columnFilters]
      .filter(([, filterVal]) => filterVal)
      .map(([col, filterVal]) => [col, foldFilterCase(filterVal)] as const);
    return result.rows.filter((row) => {
      for (const [col, folded] of wanted) {
        if (!foldFilterCase(String(row[col] ?? "")).includes(folded)) return false;
      }
      return true;
    });
  }, [result.rows, columnFilters]);

  /**
   * Where each visible row sits in `result.rows`.
   *
   * The table below is built over `filteredRows`, so TanStack's `row.index` is a position
   * in the FILTERED array. A `CellChange` carries that number out of this component, and
   * `useInlineEditing` uses it to read the row's primary key out of `result.rows` — so with
   * a column filter on, an edit was keyed to whatever row happened to sit at the same
   * position in the unfiltered result. The engine accepted it and nothing said a word.
   *
   * Filtering keeps the row objects themselves, so their identity is the map back. With no
   * filter the table's data IS `result.rows`, so the two numbers are the same and the map
   * is not built at all — it is O(rows) on the thread that draws them, and this grid
   * advertises smooth scrolling through millions.
   */
  const sourceRowIndex = useMemo(() => {
    if (columnFilters.size === 0) return null;
    const map = new Map<Record<string, unknown>, number>();
    result.rows.forEach((row, index) => map.set(row, index));
    return map;
  }, [result.rows, columnFilters]);

  /**
   * That map, applied: the position in `result.rows` of a row the table is iterating.
   * `tableIndex` is TanStack's own number, correct whenever no filter is on.
   */
  const resolveSourceIndex = useCallback(
    (row: Record<string, unknown>, tableIndex: number): number =>
      sourceRowIndex === null ? tableIndex : (sourceRowIndex.get(row) ?? -1),
    [sourceRowIndex],
  );

  const activeFilterCount = useMemo(() => {
    let count = 0;
    for (const [, v] of columnFilters) {
      if (v) count++;
    }
    return count;
  }, [columnFilters]);

  // Check if a cell has a pending change
  const getCellChange = useCallback(
    (rowIndex: number, columnId: string): CellChange | undefined => {
      return pendingChanges?.find((c) => c.rowIndex === rowIndex && c.columnId === columnId);
    },
    [pendingChanges],
  );

  const getDisplayedCellValue = useCallback(
    (rowIndex: number, row: Record<string, unknown>, field: string): { value: unknown; isMasked: boolean } => {
      const value = row[field];
      const pattern = sensitiveColumns.get(field);
      const isRevealed = revealedCells.has(`${rowIndex}:${field}`);

      if (effectiveMaskingEnabled && pattern && value !== null && value !== undefined && !isRevealed) {
        return { value: maskValueByPattern(value, pattern), isMasked: true };
      }

      const pendingChange = getCellChange(rowIndex, field);
      return { value: isRevealed ? value : (pendingChange?.newValue ?? value), isMasked: false };
    },
    [effectiveMaskingEnabled, getCellChange, revealedCells, sensitiveColumns],
  );

  const getCopyCellValue = useCallback(
    (rowIndex: number, row: Record<string, unknown>, field: string): string => {
      return formatCellCopy(
        getDisplayedCellValue(rowIndex, row, field).value,
        renderContextFor(result.vectorColumns, field),
      );
    },
    [getDisplayedCellValue, result.vectorColumns],
  );

  const copyToClipboard = useCallback((text: string, label: string) => {
    void writeToClipboard(text).then((copied) => {
      if (copied) toast.success(`${label} copied to clipboard`);
      else toast.error(`Could not copy ${label} — select the text and copy it yourself`);
    });
  }, []);

  const copyCell = useCallback(
    (row: Record<string, unknown>, rowIndex: number, field: string) => {
      copyToClipboard(getCopyCellValue(rowIndex, row, field), "Cell");
    },
    [copyToClipboard, getCopyCellValue],
  );

  const copyRow = useCallback(
    (row: Record<string, unknown>, rowIndex: number) => {
      if (effectiveMaskingEnabled && sensitiveColumns.size > 0) {
        const maskedRow = { ...row };
        for (const field of result.fields) {
          const pattern = sensitiveColumns.get(field);
          if (
            pattern &&
            row[field] !== null &&
            row[field] !== undefined &&
            !revealedCells.has(`${rowIndex}:${field}`)
          ) {
            maskedRow[field] = maskValueByPattern(row[field], pattern);
          }
        }
        copyToClipboard(jsonText(binaryCellsAsHex(maskedRow), 2), "Row");
        return;
      }

      // A binary cell as the hex the cell shows, not the Buffer form it arrived in (#1381).
      copyToClipboard(jsonText(binaryCellsAsHex(row), 2), "Row");
    },
    [copyToClipboard, effectiveMaskingEnabled, result.fields, revealedCells, sensitiveColumns],
  );

  const renderCopyMenu = (row: Record<string, unknown>, rowIndex: number) => {
    const field = contextCell?.rowIndex === rowIndex ? contextCell.field : null;

    return (
      <ContextMenuContent>
        {field !== null && <ContextMenuItem onClick={() => copyCell(row, rowIndex, field)}>Copy Cell</ContextMenuItem>}
        <ContextMenuItem onClick={() => copyRow(row, rowIndex)}>Copy Row as JSON</ContextMenuItem>
      </ContextMenuContent>
    );
  };

  const handleSetViewMode = useCallback((mode: "card" | "table") => {
    setContextCell(null);
    setViewMode(mode);
  }, []);

  const handleClearFilters = useCallback(() => {
    setColumnFilters(new Map());
    setActiveFilterCol(null);
  }, []);

  // The reason a column cannot be edited inline, keyed by field, for the columns whose declared
  // type the provider refuses (K24 on Db2). Such a cell opens no editor and shows the reason.
  const editRefusals = useMemo(() => {
    const refusals = new Map<string, string>();
    if (inlineEditRefusedColumns === undefined) return refusals;
    const refused = new RegExp(inlineEditRefusedColumns.type);
    for (const field of result.fields) {
      const declared = declaredTypeOf(result.columnTypes, field);
      if (declared !== undefined && refused.test(declared)) refusals.set(field, inlineEditRefusedColumns.reason);
    }
    return refusals;
  }, [inlineEditRefusedColumns, result.fields, result.columnTypes]);

  // One comparator per numeric column, each with its own parse cache, built once per result
  // rather than on every render or edit keystroke.
  const numericSortFns = useMemo(() => {
    const sortFns = new Map<string, SortFn<typeof tableFeatureSet, Record<string, unknown>>>();
    for (const field of result.fields) {
      if (!isNumericColumn(declaredTypeOf(result.columnTypes, field), result.rows, field)) continue;
      const compare = numericCellComparator();
      sortFns.set(field, (rowA, rowB, columnId) =>
        compare(
          rowA.getValue(columnId),
          rowB.getValue(columnId),
          // The table inverts a descending comparison, so the NULL placement needs the direction.
          rowA.table.atoms.sorting?.get().some((sort) => sort.id === columnId && sort.desc) === true,
        ),
      );
    }
    return sortFns;
  }, [result.fields, result.columnTypes, result.rows]);

  const columns = useMemo<ColumnDef<typeof tableFeatureSet, Record<string, unknown>>[]>(() => {
    // `truncate` carries its own `white-space: nowrap`, so wrapping has to replace it here,
    // on the element holding the value, not only on the cell around it.
    const valueFlow = wrapText ? "whitespace-pre-wrap break-words" : "truncate h-full";

    /**
     * The field-by-field view of one row, reachable from the desktop grid (#800).
     *
     * It ships as a column rather than as an overlay on the row so it scrolls, sizes
     * and aligns with the header the way every other cell does, and so no breakpoint
     * decides whether it is there: the vertical view already existed and was reachable
     * only below `md`, which is the whole of the reported defect. Wide results are
     * exactly where it is wanted, so it is sticky at the left edge and stays reachable
     * after the grid has been scrolled across 200 columns.
     */
    const detailColumn: ColumnDef<typeof tableFeatureSet, Record<string, unknown>> = {
      id: detailColumnId,
      header: () => <Rows3 strokeWidth={1.5} aria-hidden="true" className="w-3.5 h-3.5" />,
      cell: ({ row }) => (
        <button
          type="button"
          data-row-detail=""
          // Named after the row, so a screen reader hears which row it opens rather
          // than one of N identically named buttons.
          aria-label={`Show row ${row.index + 1} field by field`}
          title={ROW_DETAIL_HEADER_TITLE}
          className="p-1 rounded text-fg-muted hover:text-brand hover:bg-brand-tint/10 transition-colors"
          onClick={() => setSelectedRow({ row: row.original, index: row.index })}
        >
          <Rows3 strokeWidth={1.5} className="w-3.5 h-3.5" />
        </button>
      ),
      size: 36,
      minSize: 36,
      maxSize: 36,
      enableResizing: false,
      enableSorting: false,
    };

    const fieldColumns = result.fields.map<ColumnDef<typeof tableFeatureSet, Record<string, unknown>>>((field) => ({
      // `id` + `accessorFn`, never `accessorKey`: TanStack reads a DOT in an
      // accessorKey as a path into the row, so `shipping.city` was fetched as
      // `row.shipping.city` while the row carries the flat key `"shipping.city"` -
      // and the cell rendered NULL over a value the API had returned. Measured in
      // the browser on 2026-08-19 against Elasticsearch 9.1.4, where every object
      // field in a mapping flattens to exactly that shape, so most of a search
      // cluster's columns were affected; the CSV export, which reads `row[column]`
      // (`src/lib/export/csv.ts`), wrote the right value the whole time.
      //
      // `Object.hasOwn` for the same reason that export path has it: a column may
      // legally be named `constructor`, and a bare lookup would answer with
      // something off the prototype chain.
      id: field,
      accessorFn: (row: Record<string, unknown>) => (Object.hasOwn(row, field) ? row[field] : undefined),
      // A numeric column sorts as numbers, not as the strings it travels as (#1384).
      // Every other column keeps the table's own comparison.
      ...(numericSortFns.has(field) ? { sortFn: numericSortFns.get(field) } : {}),
      header: ({ column }) => {
        const hasFilter = columnFilters.has(field) && !!columnFilters.get(field);
        const isSensitive = effectiveMaskingEnabled && sensitiveColumns.has(field);
        // The type the wire format declared for THIS result - the only source for a
        // computed column, which has no catalog entry the schema tree could answer with.
        const declaredType = declaredTypeOf(result.columnTypes, field);
        return (
          <div
            className="flex items-center gap-1 select-none group/header w-full"
            ref={activeFilterCol === field ? filterPanelRef : undefined}
          >
            <button
              type="button"
              aria-label={`${field}${declaredType ? `, ${declaredType}` : ""}${
                column.getIsSorted() ? `, sorted ${column.getIsSorted() === "asc" ? "ascending" : "descending"}` : ""
              }`}
              className="flex items-center gap-1 cursor-pointer flex-1 min-w-0 text-left"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            >
              <span className="truncate" title={field}>
                {field}
              </span>
              {declaredType && (
                <span className="text-[0.625rem] normal-case truncate" title={declaredType}>
                  {declaredType}
                </span>
              )}
              {isSensitive && (
                <span title="Masked column">
                  <Lock strokeWidth={1.5} className="w-3 h-3 text-hue-purple shrink-0" />
                </span>
              )}
              <div className="flex-shrink-0 opacity-0 group-hover/header:opacity-100 transition-opacity">
                {column.getIsSorted() === "asc" && <ArrowUp className="w-3 h-3" />}
                {column.getIsSorted() === "desc" && <ArrowDown strokeWidth={1.5} className="w-3 h-3" />}
                {!column.getIsSorted() && <ArrowUpDown strokeWidth={1.5} className="w-3 h-3" />}
              </div>
            </button>
            <button
              className={cn(
                "shrink-0 p-0.5 rounded transition-colors",
                hasFilter
                  ? "text-brand"
                  : "opacity-0 group-hover/header:opacity-100 text-fg-muted hover:text-fg-secondary",
              )}
              onClick={(e) => {
                e.stopPropagation();
                setActiveFilterCol(activeFilterCol === field ? null : field);
              }}
              title="Filter column"
            >
              <Funnel strokeWidth={1.5} className="w-3 h-3" />
            </button>
            {activeFilterCol === field && (
              <div
                role="presentation"
                className="absolute top-full left-0 mt-1 z-30 bg-overlay border border-hairline-strong rounded-lg shadow-xl p-2 w-48"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  autoFocus
                  placeholder={`Filter ${field}...`}
                  value={columnFilters.get(field) || ""}
                  onChange={(e) => {
                    const next = new Map(columnFilters);
                    if (e.target.value) next.set(field, e.target.value);
                    else next.delete(field);
                    setColumnFilters(next);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" || e.key === "Enter") setActiveFilterCol(null);
                  }}
                  className="w-full bg-canvas border border-hairline-strong rounded px-2 py-1 text-xs text-fg outline-none focus:border-brand-tint/30"
                />
                {hasFilter && (
                  <button
                    className="mt-1 text-xs text-danger hover:text-danger-bright"
                    onClick={() => {
                      const next = new Map(columnFilters);
                      next.delete(field);
                      setColumnFilters(next);
                      setActiveFilterCol(null);
                    }}
                  >
                    {CLEAR_FILTER_LABEL}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      },
      cell: ({ row, column, getValue }) => {
        const val = getValue();
        const isEditing = editingCell?.rowIndex === row.index && editingCell?.columnId === column.id;
        // A pending change is addressed by its position in `result.rows`, not by the one
        // the filtered table is iterating, so the lookup and the emission below both go
        // through the map rather than through `row.index`.
        // `row.index` only where it is provably the same number — no filter, so the table
        // iterates `result.rows` itself. Under a filter it is the position this map exists
        // to stop using, and falling back to it there would restore the wrong-row write in
        // the one path that reaches the database. Filtering keeps the row objects, so a
        // miss cannot happen — and if it ever did, -1 addresses no row and the apply
        // refuses rather than writing somewhere.
        const sourceIndex = resolveSourceIndex(row.original, row.index);
        const pendingChange = getCellChange(sourceIndex, column.id);

        if (isEditing) {
          return (
            <div role="presentation" className="flex items-center gap-1 w-full" onClick={(e) => e.stopPropagation()}>
              <input
                autoFocus
                className="w-full bg-overlay border border-brand-tint rounded px-1 py-0.5 text-fg outline-none"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (editValue !== String(val ?? "") && onCellChange && editingEnabled) {
                      onCellChange({
                        rowIndex: sourceIndex,
                        columnId: column.id,
                        originalValue: val,
                        newValue: editValue,
                      });
                    }
                    setEditingCell(null);
                  }
                  if (e.key === "Escape") setEditingCell(null);
                }}
                onBlur={() => {
                  if (editValue !== String(val ?? "") && onCellChange && editingEnabled) {
                    onCellChange({
                      rowIndex: sourceIndex,
                      columnId: column.id,
                      originalValue: val,
                      newValue: editValue,
                    });
                  }
                  setEditingCell(null);
                }}
              />
            </div>
          );
        }

        // Apply masking if enabled
        const sensitivePattern = sensitiveColumns.get(column.id);
        // Addressed through the map for the same reason a pending change is: a reveal
        // keyed by the filtered position was handed to whichever row later sat there, so
        // changing a filter inside the 10s window put another row's sensitive value on
        // screen unmasked.
        const cellKey = `${sourceIndex}:${column.id}`;
        const isRevealed = revealedCells.has(cellKey);
        const { value: displayValue, isMasked } = getDisplayedCellValue(sourceIndex, row.original, column.id);

        if (isMasked) {
          return (
            <div className={cn("w-full flex gap-1 group/cell", valueFlow, wrapText ? "items-start" : "items-center")}>
              <span className="text-fg-muted italic">{String(displayValue)}</span>
              {userCanReveal && (
                <button
                  className="opacity-0 group-hover/cell:opacity-100 transition-opacity p-0.5 rounded hover:bg-hue-purple-tint/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    revealCell(cellKey);
                  }}
                  title="Reveal value (10s)"
                >
                  <Eye className="w-3 h-3 text-hue-purple" />
                </button>
              )}
            </div>
          );
        }

        // Show revealed cell with lock indicator
        if (effectiveMaskingEnabled && sensitivePattern && isRevealed) {
          const { display, className } = formatCellValue(
            displayValue,
            renderContextFor(result.vectorColumns, column.id),
          );
          return (
            <div className={cn("w-full flex gap-1", valueFlow, wrapText ? "items-start" : "items-center")}>
              <span className={className}>{display}</span>
              <Lock strokeWidth={1.5} className="w-2.5 h-2.5 text-hue-purple/50 shrink-0" />
            </div>
          );
        }

        // Show pending change value
        const { display, className } = formatCellValue(displayValue, renderContextFor(result.vectorColumns, column.id));

        // No editor is opened unless editing is on: the commit paths above already
        // required it, so without this a cell offered an input whose edit was
        // silently discarded — including where the provider declares no inline row
        // editing at all (issue #269).
        const editRefusal = editRefusals.get(column.id);
        if (!editingEnabled || editRefusal !== undefined) {
          return (
            <div
              className={cn("w-full", valueFlow, pendingChange && "bg-warning-tint/10 rounded px-0.5")}
              title={editingEnabled ? editRefusal : undefined}
            >
              <span className={cn(className, pendingChange && "text-warning")}>{display}</span>
            </div>
          );
        }

        return (
          <div
            className={cn("w-full cursor-text", valueFlow, pendingChange && "bg-warning-tint/10 rounded px-0.5")}
            onDoubleClick={() => {
              setEditingCell({ rowIndex: row.index, columnId: column.id });
              setEditValue(pendingChange ? pendingChange.newValue : String(val ?? ""));
            }}
          >
            <span className={cn(className, pendingChange && "text-warning")}>{display}</span>
          </div>
        );
      },
      size: getHeaderFitColumnSize(
        field,
        declaredTypeOf(result.columnTypes, field),
        effectiveMaskingEnabled && sensitiveColumns.has(field),
      ),
      minSize: RESULT_COLUMN_MIN_SIZE,
      maxSize: RESULT_COLUMN_MAX_SIZE,
    }));

    return [detailColumn, ...fieldColumns];
  }, [
    detailColumnId,
    wrapText,
    result.fields,
    numericSortFns,
    result.columnTypes,
    result.vectorColumns,
    editingCell,
    editValue,
    effectiveMaskingEnabled,
    sensitiveColumns,
    editingEnabled,
    editRefusals,
    onCellChange,
    getCellChange,
    getDisplayedCellValue,
    resolveSourceIndex,
    columnFilters,
    activeFilterCol,
    revealedCells,
    userCanReveal,
    revealCell,
  ]);

  /**
   * The hidden fields, for the strip. `false` is hidden and anything else is visible,
   * which is TanStack's convention and the reason this is derived here rather than in
   * the strip: the strip asks "which are hidden", not "what does the table store".
   */
  const hiddenColumns = useMemo(
    () => new Set(Object.keys(columnVisibility).filter((field) => columnVisibility[field] === false)),
    [columnVisibility],
  );

  /**
   * The fields every view that does NOT go through the table instance renders (#870).
   *
   * Three readers: the mobile table's header and body loops, which map fields directly,
   * and the card view, which picks its preview fields from the list it is handed. All
   * three used `result.fields`, so column visibility reached the desktop grid alone and
   * one hidden column meant two different answers on one result depending on the
   * breakpoint or the view toggle. They read this instead, which also makes the
   * sticky-first-column rule at `idx === 0` follow the first column that is there.
   */
  const visibleFields = useMemo(
    () => result.fields.filter((field) => !hiddenColumns.has(field)),
    [result.fields, hiddenColumns],
  );

  const toggleColumn = useCallback((field: string) => {
    setColumnVisibility((current) => ({ ...current, [field]: current[field] === false }));
  }, []);

  const table = useTable({
    features: tableFeatureSet,
    data: filteredRows,
    columns,
    state: {
      sorting,
      columnVisibility,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    columnResizeMode: "onChange",
  });

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const cardContainerRef = useRef<HTMLDivElement>(null);
  const mobileTableContainerRef = useRef<HTMLDivElement>(null);

  const { rows } = table.getRowModel();

  // react(incompatible-library) reports a property of @tanstack/react-virtual, not of this
  // component: useVirtualizer returns functions React Compiler cannot memoize, so the compiler
  // skips memoizing this component. Nothing here can fix that short of dropping the virtualizer,
  // which is what keeps large result sets renderable. Scoped to this call so a NEW incompatible
  // library still fails the gate rather than joining a silent warning pile.
  // oxlint-disable-next-line react/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  const cardVirtualizer = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => cardContainerRef.current,
    estimateSize: () => 160,
    overscan: 5,
  });

  const mobileTableVirtualizer = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => mobileTableContainerRef.current,
    estimateSize: () => 48,
    overscan: 5,
  });

  /**
   * THE PAGE-TWO OFFER, or undefined where there is none (#816).
   *
   * One value rather than the same three-way conjunction written out at each use, and
   * that is the whole point: the control and the ordering notice below are two statements
   * about the SAME offer, and written separately they drift. The notice is the one that
   * goes wrong quietly — an auto-limited unordered result that fits in a single page
   * announces that order across pages is not guaranteed, beside no control, about a page
   * that does not exist.
   *
   * `pageOfferFor` and not an inline conjunction because the export dialog asks the same
   * question one layer up (`src/lib/export/scope.ts`), about the same rows.
   */
  const pageOffer = pageOfferFor(result.pagination, supportsResultPagination, onLoadMore);

  /**
   * Whether to state, once, that order across pages is not guaranteed.
   *
   * Studio will not inject, require or suggest an `ORDER BY` to paginate: on a table of
   * millions of rows a sort can be fatal, and paying for it is the user's call. Without
   * one the engine may return rows that repeat or are skipped between pages. That is
   * accepted, not blocked — but it must not pretend to be the ordered case.
   *
   * Unknown statement, no claim: with no `resultQuery` the surface cannot read the order,
   * and staying quiet is the guess that does not reassure.
   */
  const orderAcrossPagesUnspecified =
    pageOffer !== undefined && resultQuery !== undefined && !hasResultOrder(resultQuery, databaseType);

  if (!result || result.rows.length === 0) {
    // A warning here is the whole story: an engine can answer 200 with every
    // segment unavailable, and the stats bar that normally carries the badge is
    // not rendered in this state - so the notices are shown outright.
    const emptyWarnings = result?.warnings ?? [];
    const affected = affectedRowsLabel(result);
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center text-fg-subtle animate-in fade-in zoom-in-95 duration-500">
        <div className="w-16 h-16 rounded-2xl bg-panel flex items-center justify-center mb-6 border border-hairline shadow-2xl">
          <span className="text-2xl text-fg-muted">&#x2205;</span>
        </div>
        <p className="text-xs font-medium text-fg-tertiary">{affected ?? "Query returned no data"}</p>
        {emptyWarnings.length > 0 && (
          <div className="mt-3 max-w-[280px] text-xs text-warning leading-relaxed">
            <p className="font-medium">{ENGINE_WARNINGS_LABEL}</p>
            <ul className="mt-1 space-y-1">
              {emptyWarnings.map((warning, idx) => (
                <li key={idx}>{describeWarning(warning)}</li>
              ))}
            </ul>
          </div>
        )}
        {affected === undefined && (
          <p className="text-xs text-fg-subtle mt-2 max-w-[280px] leading-relaxed">{EMPTY_RESULT_HINT}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-sunken">
      <StatsBar
        result={result}
        filteredRowCount={filteredRows.length}
        activeFilterCount={activeFilterCount}
        onClearFilters={handleClearFilters}
        viewMode={viewMode}
        onSetViewMode={handleSetViewMode}
        wrapText={wrapText}
        onToggleWrapText={() => {
          // Both virtualizers cache every row they measured. Dropping the cache on each
          // toggle is what lets rows grown while wrapping shrink back once it is off.
          rowVirtualizer.measure();
          mobileTableVirtualizer.measure();
          setWrapText((value) => !value);
        }}
        hasSensitive={hasSensitive}
        effectiveMaskingEnabled={effectiveMaskingEnabled}
        userCanToggle={userCanToggle}
        onToggleMasking={onToggleMasking}
        editingEnabled={editingEnabled}
        pendingChanges={pendingChanges}
        onApplyChanges={onApplyChanges}
        onDiscardChanges={onDiscardChanges}
        orderAcrossPagesUnspecified={orderAcrossPagesUnspecified}
        pageOffer={pageOffer}
        isLoadingMore={isLoadingMore}
        hiddenColumns={hiddenColumns}
        onToggleColumn={toggleColumn}
      />

      <div ref={cardContainerRef} className={cn("flex-1 overflow-auto p-4 md:hidden", viewMode !== "card" && "hidden")}>
        <div style={{ height: `${cardVirtualizer.getTotalSize()}px`, position: "relative" }}>
          {cardVirtualizer.getVirtualItems().map((virtualRow) => (
            <ContextMenu key={virtualRow.index}>
              <ContextMenuTrigger asChild>
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    padding: "4px 0",
                  }}
                  onContextMenu={() => setContextCell(null)}
                >
                  <ResultCard
                    row={result.rows[virtualRow.index]}
                    fields={visibleFields}
                    primaryColumn={primaryColumn}
                    idColumn={idColumn}
                    index={virtualRow.index}
                    onSelect={() => setSelectedRow({ row: result.rows[virtualRow.index], index: virtualRow.index })}
                    maskingActive={effectiveMaskingEnabled}
                    sensitiveColumns={sensitiveColumns}
                    vectorColumns={result.vectorColumns}
                  />
                </div>
              </ContextMenuTrigger>
              {renderCopyMenu(result.rows[virtualRow.index], virtualRow.index)}
            </ContextMenu>
          ))}
        </div>
      </div>

      <div
        ref={mobileTableContainerRef}
        className={cn("flex-1 overflow-auto md:hidden", viewMode !== "table" && "hidden")}
      >
        <div className="min-w-max">
          <div className="sticky top-0 z-20 bg-raised flex">
            {visibleFields.map((field, idx) => {
              const isSensitive = effectiveMaskingEnabled && sensitiveColumns.has(field);
              const declaredType = declaredTypeOf(result.columnTypes, field);
              return (
                <div
                  key={field}
                  // The type stays a tooltip here: this table sizes header and body cells
                  // from their own content, so visible type text would push the header out
                  // of step with the rows below it. The desktop table shares one measured
                  // width and can afford the visible span.
                  title={declaredType}
                  className={cn(
                    "h-10 px-4 flex items-center gap-1 border-r border-b border-hairline text-xs uppercase font-mono text-fg-muted bg-raised whitespace-nowrap",
                    idx === 0 && "sticky left-0 z-30 bg-raised shadow-[2px_0_8px_rgba(0,0,0,0.3)]",
                    "min-w-[120px]",
                  )}
                >
                  {field}
                  {/* A title on a non-focusable element is unreachable by touch and
                      unreliable for assistive tech, so the type also ships as
                      screen-reader text - same treatment as the warnings badge. */}
                  {declaredType && <span className="sr-only">, {declaredType}</span>}
                  {isSensitive && <Lock strokeWidth={1.5} className="w-2.5 h-2.5 text-hue-purple" />}
                </div>
              );
            })}
          </div>

          <div
            style={{
              height: `${mobileTableVirtualizer.getTotalSize()}px`,
              position: "relative",
            }}
          >
            {mobileTableVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = result.rows[virtualRow.index];
              return (
                <ContextMenu key={virtualRow.index}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      data-index={virtualRow.index}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        ...(wrapText ? { minHeight: "48px" } : { height: `${virtualRow.size}px` }),
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      ref={wrapText ? mobileTableVirtualizer.measureElement : undefined}
                      className="flex hover:bg-brand-tint/[0.03] transition-colors border-b border-hairline cursor-pointer text-left"
                      onClick={() => setSelectedRow({ row, index: virtualRow.index })}
                      onContextMenu={(event) => {
                        if (event.target === event.currentTarget) setContextCell(null);
                      }}
                    >
                      {visibleFields.map((field, idx) => {
                        const { value: cellValue, isMasked } = getDisplayedCellValue(virtualRow.index, row, field);
                        const { display: displayValue, className: formattedClassName } = formatCellValue(
                          cellValue,
                          renderContextFor(result.vectorColumns, field),
                        );
                        const className = isMasked ? "text-fg-muted italic" : formattedClassName;

                        return (
                          <div
                            key={field}
                            className={cn(
                              "px-4 py-3 border-r border-hairline text-xs font-mono overflow-hidden flex min-w-[120px]",
                              wrapText
                                ? "whitespace-pre-wrap break-words items-start"
                                : "h-full whitespace-nowrap items-center",
                              idx === 0 && "sticky left-0 z-10 bg-sunken shadow-[2px_0_8px_rgba(0,0,0,0.3)]",
                            )}
                            onContextMenu={() => setContextCell({ rowIndex: virtualRow.index, field })}
                          >
                            <span className={className}>{displayValue}</span>
                          </div>
                        );
                      })}
                    </button>
                  </ContextMenuTrigger>
                  {renderCopyMenu(row, virtualRow.index)}
                </ContextMenu>
              );
            })}
          </div>
        </div>
      </div>

      <div
        ref={tableContainerRef}
        data-desktop-grid=""
        className="hidden md:block flex-1 overflow-auto editor-scrollbar"
      >
        <div className="min-w-max">
          <div className="sticky top-0 z-20 bg-raised flex">
            {table.getHeaderGroups().map((headerGroup) =>
              headerGroup.headers.map((header) => {
                const isRowDetail = header.column.id === detailColumnId;
                return (
                  <div
                    key={header.id}
                    {...(isRowDetail ? { "data-row-detail-header": "" } : {})}
                    style={{ width: header.getSize(), minWidth: header.getSize() }}
                    className={cn(
                      "h-10 flex items-center border-r border-b border-hairline text-xs uppercase font-mono text-fg-muted bg-raised relative group shrink-0",
                      isRowDetail ? "px-2 justify-center sticky left-0 z-10" : "px-4",
                    )}
                  >
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}

                    {/* A column pinned to one width has no handle to drag: rendering one
                        would offer a drag that `enableResizing: false` then refuses. */}
                    {header.column.getCanResize() && (
                      <div
                        aria-hidden="true"
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          header.column.resetSize();
                        }}
                        className={cn(
                          "absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-brand-tint/50 transition-colors",
                          header.column.getIsResizing() ? "bg-brand-tint w-1" : "bg-transparent",
                        )}
                      />
                    )}
                  </div>
                );
              }),
            )}
          </div>

          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              const sourceIndex = resolveSourceIndex(row.original, row.index);
              return (
                <ContextMenu key={row.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      data-index={virtualRow.index}
                      ref={wrapText ? rowVirtualizer.measureElement : undefined}
                      style={{
                        // A fixed height is all measureElement would ever read back, so a
                        // wrapping row sizes to its content and reports that instead.
                        ...(wrapText ? { minHeight: "36px" } : { height: `${virtualRow.size}px` }),
                        transform: `translateY(${virtualRow.start}px)`,
                        position: "absolute",
                        top: 0,
                        left: 0,
                      }}
                      className="flex group hover:bg-brand-tint/[0.03] transition-colors border-b border-hairline"
                      onContextMenu={(event) => {
                        if (event.target === event.currentTarget) setContextCell(null);
                      }}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const isRowDetail = cell.column.id === detailColumnId;
                        return (
                          <div
                            key={cell.id}
                            style={{ width: cell.column.getSize(), minWidth: cell.column.getSize() }}
                            className={cn(
                              "py-2 border-r border-hairline text-xs font-mono overflow-hidden group-hover:border-hairline-strong flex shrink-0",
                              wrapText
                                ? "whitespace-pre-wrap break-words items-start"
                                : "h-full whitespace-nowrap items-center",
                              // Sticky with the header above it, so the control is still
                              // there once a wide result has been scrolled sideways.
                              isRowDetail ? "px-1 justify-center sticky left-0 z-10 bg-sunken" : "px-4",
                            )}
                            // The detail control is not a value, so right-clicking it offers
                            // the row and nothing to copy out of that column.
                            onContextMenu={() =>
                              setContextCell(isRowDetail ? null : { rowIndex: sourceIndex, field: cell.column.id })
                            }
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </div>
                        );
                      })}
                    </div>
                  </ContextMenuTrigger>
                  {renderCopyMenu(row.original, sourceIndex)}
                </ContextMenu>
              );
            })}
          </div>
        </div>
      </div>

      {selectedRow && (
        <RowDetailSheet
          row={selectedRow.row}
          fields={result.fields}
          isOpen={!!selectedRow}
          onClose={() => setSelectedRow(null)}
          rowIndex={selectedRow.index}
          maskingActive={effectiveMaskingEnabled}
          sensitiveColumns={sensitiveColumns}
          allowReveal={userCanReveal}
          vectorColumns={result.vectorColumns}
        />
      )}
    </div>
  );
}
