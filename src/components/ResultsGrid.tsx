"use client";

import React, { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { QueryResult } from "@/lib/types";
import {
  type ColumnDef,
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
import { ArrowUpDown, ArrowUp, ArrowDown, Eye, Funnel, Lock } from "lucide-react";
import {
  type MaskingConfig,
  detectSensitiveColumnsFromConfig,
  maskValueByPattern,
  shouldMask,
  canToggleMasking,
  canReveal,
  loadMaskingConfig,
} from "@/lib/data-masking";
import { ResultCard } from "@/components/results-grid/ResultCard";
import { RowDetailSheet } from "@/components/results-grid/RowDetailSheet";
import { StatsBar, LoadMoreFooter } from "@/components/results-grid/StatsBar";
import { describeWarning, formatCellValue } from "@/components/results-grid/utils";

export interface CellChange {
  rowIndex: number;
  columnId: string;
  originalValue: unknown;
  newValue: string;
}

const CLEAR_FILTER_LABEL = "Clear filter";
const EMPTY_RESULT_HINT = "The operation was successful, but the result set is currently empty.";
const ENGINE_WARNINGS_LABEL = "The engine reported:";

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
  maskingEnabled?: boolean;
  onToggleMasking?: () => void;
  userRole?: string;
  maskingConfig?: MaskingConfig;
  // Inline editing props
  editingEnabled?: boolean;
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
  maskingEnabled,
  onToggleMasking,
  userRole,
  maskingConfig,
  editingEnabled,
  pendingChanges,
  onCellChange,
  onDiscardChanges,
  onApplyChanges,
}: ResultsGridProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [editingCell, setEditingCell] = useState<{ rowIndex: number; columnId: string } | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [viewMode, setViewMode] = useState<"card" | "table">("card");
  const [selectedRow, setSelectedRow] = useState<{ row: Record<string, unknown>; index: number } | null>(null);
  const [columnFilters, setColumnFilters] = useState<Map<string, string>>(new Map());
  const [activeFilterCol, setActiveFilterCol] = useState<string | null>(null);
  const [revealedCells, setRevealedCells] = useState<Set<string>>(new Set());

  // Resolve config
  const resolvedConfig = useMemo(() => maskingConfig ?? loadMaskingConfig(), [maskingConfig]);

  // Effective masking state (RBAC-aware)
  const effectiveMaskingEnabled = useMemo(() => {
    return shouldMask(userRole, resolvedConfig) && (maskingEnabled ?? resolvedConfig.enabled);
  }, [userRole, resolvedConfig, maskingEnabled]);

  const userCanToggle = useMemo(() => canToggleMasking(userRole, resolvedConfig), [userRole, resolvedConfig]);
  const userCanReveal = useMemo(() => canReveal(userRole, resolvedConfig), [userRole, resolvedConfig]);

  // Config-based sensitive column detection
  const sensitiveColumns = useMemo(
    () => detectSensitiveColumnsFromConfig(result.fields, resolvedConfig),
    [result.fields, resolvedConfig],
  );

  const hasSensitive = sensitiveColumns.size > 0;

  // Clear revealed cells when result changes
  useEffect(() => {
    setRevealedCells(new Set());
  }, [result]);

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

  // Filter rows based on column filters
  const filteredRows = useMemo(() => {
    if (columnFilters.size === 0) return result.rows;
    return result.rows.filter((row) => {
      for (const [col, filterVal] of columnFilters) {
        if (!filterVal) continue;
        const cellVal = String(row[col] ?? "").toLowerCase();
        if (!cellVal.includes(filterVal.toLowerCase())) return false;
      }
      return true;
    });
  }, [result.rows, columnFilters]);

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

  const handleClearFilters = useCallback(() => {
    setColumnFilters(new Map());
    setActiveFilterCol(null);
  }, []);

  const columns = useMemo<ColumnDef<typeof tableFeatureSet, Record<string, unknown>>[]>(() => {
    return result.fields.map((field) => ({
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
      header: ({ column }) => {
        const hasFilter = columnFilters.has(field) && !!columnFilters.get(field);
        const isSensitive = effectiveMaskingEnabled && sensitiveColumns.has(field);
        // The type the wire format declared for THIS result - the only source for a
        // computed column, which has no catalog entry the schema tree could answer with.
        const declaredType = declaredTypeOf(result.columnTypes, field);
        return (
          <div className="flex items-center gap-1 select-none group/header w-full">
            <button
              type="button"
              aria-label={`${field}${declaredType ? `, ${declaredType}` : ""}${
                column.getIsSorted() ? `, sorted ${column.getIsSorted() === "asc" ? "ascending" : "descending"}` : ""
              }`}
              className="flex items-center gap-1 cursor-pointer flex-1 min-w-0 text-left"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            >
              <span className="truncate">{field}</span>
              {declaredType && (
                <span className="text-[0.625rem] normal-case truncate" title={declaredType}>
                  {declaredType}
                </span>
              )}
              {isSensitive && (
                <span title="Masked column">
                  <Lock strokeWidth={1.5} className="w-3 h-3 text-purple-400 shrink-0" />
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
                  ? "text-blue-400"
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
                  className="w-full bg-canvas border border-hairline-strong rounded px-2 py-1 text-xs text-fg outline-none focus:border-blue-500/30"
                />
                {hasFilter && (
                  <button
                    className="mt-1 text-xs text-red-400 hover:text-red-300"
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
        const pendingChange = getCellChange(row.index, column.id);

        if (isEditing) {
          return (
            <div role="presentation" className="flex items-center gap-1 w-full" onClick={(e) => e.stopPropagation()}>
              <input
                autoFocus
                className="w-full bg-overlay border border-blue-500 rounded px-1 py-0.5 text-fg outline-none"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (editValue !== String(val ?? "") && onCellChange && editingEnabled) {
                      onCellChange({
                        rowIndex: row.index,
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
                      rowIndex: row.index,
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
        const cellKey = `${row.index}:${column.id}`;
        const isRevealed = revealedCells.has(cellKey);

        if (effectiveMaskingEnabled && sensitivePattern && val !== null && val !== undefined && !isRevealed) {
          const masked = maskValueByPattern(val, sensitivePattern);
          return (
            <div className="truncate w-full h-full flex items-center gap-1 group/cell">
              <span className="text-fg-muted italic">{masked}</span>
              {userCanReveal && (
                <button
                  className="opacity-0 group-hover/cell:opacity-100 transition-opacity p-0.5 rounded hover:bg-purple-500/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    revealCell(cellKey);
                  }}
                  title="Reveal value (10s)"
                >
                  <Eye className="w-3 h-3 text-purple-400" />
                </button>
              )}
            </div>
          );
        }

        // Show revealed cell with lock indicator
        if (effectiveMaskingEnabled && sensitivePattern && isRevealed) {
          const { display, className } = formatCellValue(val);
          return (
            <div className="truncate w-full h-full flex items-center gap-1">
              <span className={className}>{display}</span>
              <Lock strokeWidth={1.5} className="w-2.5 h-2.5 text-purple-400/50 shrink-0" />
            </div>
          );
        }

        // Show pending change value
        const displayVal = pendingChange !== undefined ? pendingChange.newValue : val;
        const { display, className } = formatCellValue(displayVal);

        // No editor is opened unless editing is on: the commit paths above already
        // required it, so without this a cell offered an input whose edit was
        // silently discarded — including where the provider declares no inline row
        // editing at all (issue #269).
        if (!editingEnabled) {
          return (
            <div className={cn("truncate w-full h-full", pendingChange && "bg-amber-500/10 rounded px-0.5")}>
              <span className={cn(className, pendingChange && "text-amber-400")}>{display}</span>
            </div>
          );
        }

        return (
          <div
            className={cn("truncate w-full h-full cursor-text", pendingChange && "bg-amber-500/10 rounded px-0.5")}
            onDoubleClick={() => {
              setEditingCell({ rowIndex: row.index, columnId: column.id });
              setEditValue(pendingChange ? pendingChange.newValue : String(val ?? ""));
            }}
          >
            <span className={cn(className, pendingChange && "text-amber-400")}>{display}</span>
          </div>
        );
      },
      size: 150,
      minSize: 80,
      maxSize: 500,
    }));
  }, [
    result.fields,
    result.columnTypes,
    editingCell,
    editValue,
    effectiveMaskingEnabled,
    sensitiveColumns,
    editingEnabled,
    onCellChange,
    getCellChange,
    columnFilters,
    activeFilterCol,
    revealedCells,
    userCanReveal,
    revealCell,
  ]);

  const table = useTable({
    features: tableFeatureSet,
    data: filteredRows,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
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

  if (!result || result.rows.length === 0) {
    // A warning here is the whole story: an engine can answer 200 with every
    // segment unavailable, and the stats bar that normally carries the badge is
    // not rendered in this state - so the notices are shown outright.
    const emptyWarnings = result?.warnings ?? [];
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center text-fg-subtle animate-in fade-in zoom-in-95 duration-500">
        <div className="w-16 h-16 rounded-2xl bg-panel flex items-center justify-center mb-6 border border-hairline shadow-2xl">
          <span className="text-2xl text-fg-muted">&#x2205;</span>
        </div>
        <p className="text-xs font-medium text-fg-tertiary">Query returned no data</p>
        {emptyWarnings.length > 0 && (
          <div className="mt-3 max-w-[280px] text-xs text-amber-400 leading-relaxed">
            <p className="font-medium">{ENGINE_WARNINGS_LABEL}</p>
            <ul className="mt-1 space-y-1">
              {emptyWarnings.map((warning, idx) => (
                <li key={idx}>{describeWarning(warning)}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-fg-subtle mt-2 max-w-[280px] leading-relaxed">{EMPTY_RESULT_HINT}</p>
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
        onSetViewMode={setViewMode}
        hasSensitive={hasSensitive}
        effectiveMaskingEnabled={effectiveMaskingEnabled}
        userCanToggle={userCanToggle}
        onToggleMasking={onToggleMasking}
        editingEnabled={editingEnabled}
        pendingChanges={pendingChanges}
        onApplyChanges={onApplyChanges}
        onDiscardChanges={onDiscardChanges}
      />

      <div ref={cardContainerRef} className={cn("flex-1 overflow-auto p-4 md:hidden", viewMode !== "card" && "hidden")}>
        <div style={{ height: `${cardVirtualizer.getTotalSize()}px`, position: "relative" }}>
          {cardVirtualizer.getVirtualItems().map((virtualRow) => (
            <div
              key={virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
                padding: "4px 0",
              }}
            >
              <ResultCard
                row={result.rows[virtualRow.index]}
                fields={result.fields}
                primaryColumn={primaryColumn}
                idColumn={idColumn}
                index={virtualRow.index}
                onSelect={() => setSelectedRow({ row: result.rows[virtualRow.index], index: virtualRow.index })}
                maskingActive={effectiveMaskingEnabled}
                sensitiveColumns={sensitiveColumns}
              />
            </div>
          ))}
        </div>
      </div>

      <div
        ref={mobileTableContainerRef}
        className={cn("flex-1 overflow-auto md:hidden", viewMode !== "table" && "hidden")}
      >
        <div className="min-w-max">
          <div className="sticky top-0 z-20 bg-raised flex">
            {result.fields.map((field, idx) => {
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
                  {isSensitive && <Lock strokeWidth={1.5} className="w-2.5 h-2.5 text-purple-400" />}
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
                <button
                  type="button"
                  key={virtualRow.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="flex hover:bg-blue-500/[0.03] transition-colors border-b border-hairline cursor-pointer text-left"
                  onClick={() => setSelectedRow({ row, index: virtualRow.index })}
                >
                  {result.fields.map((field, idx) => {
                    const pattern = sensitiveColumns.get(field);
                    const isMasked =
                      effectiveMaskingEnabled && pattern && row[field] != null && row[field] !== undefined;
                    const displayValue = isMasked
                      ? maskValueByPattern(row[field], pattern)
                      : formatCellValue(row[field]).display;
                    const className = isMasked ? "text-fg-muted italic" : formatCellValue(row[field]).className;

                    return (
                      <div
                        key={field}
                        className={cn(
                          "h-full px-4 py-3 border-r border-hairline text-xs font-mono whitespace-nowrap overflow-hidden flex items-center",
                          idx === 0 && "sticky left-0 z-10 bg-sunken shadow-[2px_0_8px_rgba(0,0,0,0.3)]",
                          "min-w-[120px]",
                        )}
                      >
                        <span className={className}>{displayValue}</span>
                      </div>
                    );
                  })}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div ref={tableContainerRef} className="hidden md:block flex-1 overflow-auto editor-scrollbar">
        <div className="min-w-max">
          <div className="sticky top-0 z-20 bg-raised flex">
            {table.getHeaderGroups().map((headerGroup) =>
              headerGroup.headers.map((header) => (
                <div
                  key={header.id}
                  style={{ width: header.getSize(), minWidth: header.getSize() }}
                  className="h-10 px-4 flex items-center border-r border-b border-hairline text-xs uppercase font-mono text-fg-muted bg-raised relative group shrink-0"
                >
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}

                  <div
                    aria-hidden="true"
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    className={cn(
                      "absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-500/50 transition-colors",
                      header.column.getIsResizing() ? "bg-blue-500 w-1" : "bg-transparent",
                    )}
                  />
                </div>
              )),
            )}
          </div>

          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              return (
                <div
                  key={row.id}
                  data-index={virtualRow.index}
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    position: "absolute",
                    top: 0,
                    left: 0,
                  }}
                  className="flex group hover:bg-blue-500/[0.03] transition-colors border-b border-hairline"
                >
                  {row.getVisibleCells().map((cell) => (
                    <div
                      key={cell.id}
                      style={{ width: cell.column.getSize(), minWidth: cell.column.getSize() }}
                      className="h-full px-4 py-2 border-r border-hairline text-xs font-mono whitespace-nowrap overflow-hidden group-hover:border-hairline-strong flex items-center shrink-0"
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {result.pagination?.hasMore && onLoadMore && (
        <LoadMoreFooter hasMore={true} onLoadMore={onLoadMore} isLoadingMore={isLoadingMore} />
      )}

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
        />
      )}
    </div>
  );
}
