"use client";

import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { QueryResult } from '@/lib/types';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
  SortingState,
  ColumnDef,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Copy,
  ChevronRight,
  ChevronDown,
  LayoutGrid,
  Table2,
  Hash,
  FileJson,
  Check,
  Loader2,
  EyeOff,
  Eye,
  Save,
  X,
  Filter,
  Lock,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  type MaskingConfig,
  type MaskingPattern,
  detectSensitiveColumnsFromConfig,
  maskValueByPattern,
  shouldMask,
  canToggleMasking,
  canReveal,
  loadMaskingConfig,
} from '@/lib/data-masking';

export interface CellChange {
  rowIndex: number;
  columnId: string;
  originalValue: unknown;
  newValue: string;
}

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
function detectPrimaryColumn(fields: string[], rows: Record<string, unknown>[]): string {
  const preferredNames = ['name', 'title', 'label', 'username', 'email', 'description'];

  for (const name of preferredNames) {
    if (fields.some(f => f.toLowerCase().includes(name))) {
      return fields.find(f => f.toLowerCase().includes(name))!;
    }
  }

  // Find first string column that's not an ID
  if (rows.length > 0) {
    for (const field of fields) {
      const value = rows[0][field];
      if (typeof value === 'string' && !field.toLowerCase().includes('id')) {
        return field;
      }
    }
  }

  return fields[0];
}

// Get ID column if exists
function detectIdColumn(fields: string[]): string | null {
  return fields.find(f => f.toLowerCase() === 'id' || f.toLowerCase().endsWith('_id')) || null;
}

// Format cell value for display
function formatCellValue(value: unknown): { display: string; className: string } {
  if (value === null || value === undefined) {
    return { display: 'NULL', className: 'text-zinc-600 italic' };
  }
  if (typeof value === 'object') {
    return { display: JSON.stringify(value), className: 'text-blue-400/80 italic font-light' };
  }
  if (typeof value === 'number') {
    return { display: String(value), className: 'text-amber-500/90 font-medium' };
  }
  if (typeof value === 'boolean') {
    return { display: String(value), className: value ? 'text-emerald-500/90' : 'text-rose-500/90' };
  }
  const strVal = String(value).toLowerCase();
  if (strVal === 'true' || strVal === 'active' || strVal === 'enabled') {
    return { display: String(value), className: 'text-emerald-500/90' };
  }
  if (strVal === 'false' || strVal === 'inactive' || strVal === 'disabled') {
    return { display: String(value), className: 'text-rose-500/90' };
  }
  return { display: String(value), className: 'text-zinc-300' };
}

// Mobile Card Component
function ResultCard({
  row,
  fields,
  primaryColumn,
  idColumn,
  index,
  onSelect,
  maskingActive,
  sensitiveColumns,
}: {
  row: Record<string, unknown>;
  fields: string[];
  primaryColumn: string;
  idColumn: string | null;
  index: number;
  onSelect: () => void;
  maskingActive?: boolean;
  sensitiveColumns?: Map<string, MaskingPattern>;
}) {
  const primaryValue: unknown = row[primaryColumn];
  const idValue: unknown = idColumn ? row[idColumn] : null;

  // Mask primary value if sensitive
  const displayPrimary = useMemo(() => {
    if (maskingActive && sensitiveColumns?.has(primaryColumn) && primaryValue != null) {
      return maskValueByPattern(primaryValue, sensitiveColumns.get(primaryColumn)!);
    }
    return primaryValue != null ? String(primaryValue) : `Row ${index + 1}`;
  }, [maskingActive, sensitiveColumns, primaryColumn, primaryValue, index]);

  // Show first 4 fields (excluding primary and id)
  const previewFields = fields
    .filter(f => f !== primaryColumn && f !== idColumn)
    .slice(0, 4);

  return (
    <div
      onClick={onSelect}
      className="bg-[#0d0d0d] border border-white/5 rounded-xl p-4 active:scale-[0.98] transition-all cursor-pointer hover:border-white/10 hover:bg-[#111]"
    >
      {/* Header: Primary value + ID */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
            <Hash className="w-4 h-4 text-blue-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className={cn(
              "text-sm font-semibold truncate",
              maskingActive && sensitiveColumns?.has(primaryColumn) ? "text-zinc-500 italic" : "text-zinc-100"
            )}>
              {displayPrimary}
            </p>
            {idValue != null && (
              <p className="text-[10px] text-zinc-500 font-mono">#{String(idValue)}</p>
            )}
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-zinc-600" />
      </div>

      {/* Preview Fields */}
      <div className="space-y-2">
        {previewFields.map(field => {
          const pattern = sensitiveColumns?.get(field);
          const isMasked = maskingActive && pattern && row[field] != null && row[field] !== undefined;
          const displayValue = isMasked
            ? maskValueByPattern(row[field], pattern)
            : formatCellValue(row[field]).display;
          const className = isMasked
            ? 'text-zinc-500 italic'
            : formatCellValue(row[field]).className;

          return (
            <div key={field} className="flex items-center justify-between text-xs">
              <span className="text-zinc-500 truncate mr-2">
                {field}
                {isMasked && <Lock className="w-2.5 h-2.5 inline ml-1 text-purple-400" />}
              </span>
              <span className={cn("truncate max-w-[60%] text-right font-mono", className)}>
                {displayValue}
              </span>
            </div>
          );
        })}
        {fields.length > previewFields.length + 2 && (
          <p className="text-[10px] text-zinc-600 text-center pt-1">
            +{fields.length - previewFields.length - 2} more fields
          </p>
        )}
      </div>
    </div>
  );
}

// Row Detail Sheet Component
function RowDetailSheet({
  row,
  fields,
  isOpen,
  onClose,
  rowIndex,
  maskingActive,
  sensitiveColumns,
  allowReveal,
}: {
  row: Record<string, unknown>;
  fields: string[];
  isOpen: boolean;
  onClose: () => void;
  rowIndex: number;
  maskingActive?: boolean;
  sensitiveColumns?: Map<string, MaskingPattern>;
  allowReveal?: boolean;
}) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());

  // Auto-hide revealed fields after 10s
  const revealField = useCallback((field: string) => {
    setRevealedFields(prev => new Set(prev).add(field));
    setTimeout(() => {
      setRevealedFields(prev => {
        const next = new Set(prev);
        next.delete(field);
        return next;
      });
    }, 10000);
  }, []);

  const getDisplayValue = useCallback((field: string, value: unknown): { text: string; isMasked: boolean } => {
    const pattern = sensitiveColumns?.get(field);
    if (maskingActive && pattern && value != null && value !== undefined && !revealedFields.has(field)) {
      return { text: maskValueByPattern(value, pattern), isMasked: true };
    }
    return { text: typeof value === 'object' ? JSON.stringify(value) : String(value ?? 'NULL'), isMasked: false };
  }, [maskingActive, sensitiveColumns, revealedFields]);

  const copyValue = (field: string, value: unknown) => {
    const { text } = getDisplayValue(field, value);
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const copyAllAsJson = () => {
    // If masking is active, copy masked version
    if (maskingActive && sensitiveColumns && sensitiveColumns.size > 0) {
      const maskedRow: Record<string, unknown> = {};
      for (const field of fields) {
        const { text } = getDisplayValue(field, row[field]);
        maskedRow[field] = text;
      }
      navigator.clipboard.writeText(JSON.stringify(maskedRow, null, 2));
    } else {
      navigator.clipboard.writeText(JSON.stringify(row, null, 2));
    }
    setCopiedField('__all__');
    setTimeout(() => setCopiedField(null), 1500);
  };

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent side="bottom" className="h-[85vh] bg-[#0a0a0a] border-t border-white/10 rounded-t-3xl">
        <SheetHeader className="pb-4 border-b border-white/5">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-zinc-100 flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <FileJson className="w-4 h-4 text-blue-400" />
              </div>
              Row #{rowIndex + 1}
            </SheetTitle>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs border-white/10 hover:bg-white/5"
              onClick={copyAllAsJson}
            >
              {copiedField === '__all__' ? (
                <><Check className="w-3 h-3 mr-1 text-emerald-400" /> Copied</>
              ) : (
                <><Copy className="w-3 h-3 mr-1" /> Copy JSON</>
              )}
            </Button>
          </div>
        </SheetHeader>

        <ScrollArea className="h-[calc(85vh-100px)] mt-4">
          <div className="space-y-1 pr-4">
            {fields.map(field => {
              const { text, isMasked } = getDisplayValue(field, row[field]);
              const isLongValue = text.length > 50;

              return (
                <div
                  key={field}
                  className="group p-3 rounded-lg hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1 font-mono flex items-center gap-1">
                        {field}
                        {isMasked && <Lock className="w-2.5 h-2.5 text-purple-400" />}
                      </p>
                      <p className={cn(
                        "font-mono text-sm break-all",
                        isMasked ? "text-zinc-500 italic" : formatCellValue(row[field]).className,
                        isLongValue && "text-xs"
                      )}>
                        {text}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isMasked && allowReveal && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => revealField(field)}
                          title="Reveal value (10s)"
                        >
                          <Eye className="w-3.5 h-3.5 text-purple-400" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => copyValue(field, row[field])}
                      >
                        {copiedField === field ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5 text-zinc-500" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
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
  const [editingCell, setEditingCell] = useState<{ rowIndex: number, columnId: string } | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
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
    [result.fields, resolvedConfig]
  );

  const hasSensitive = sensitiveColumns.size > 0;

  // Clear revealed cells when result changes
  useEffect(() => {
    setRevealedCells(new Set());
  }, [result]);

  // Per-cell reveal with auto-hide
  const revealCell = useCallback((key: string) => {
    setRevealedCells(prev => new Set(prev).add(key));
    setTimeout(() => {
      setRevealedCells(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, 10000);
  }, []);

  const primaryColumn = useMemo(
    () => detectPrimaryColumn(result.fields, result.rows),
    [result.fields, result.rows]
  );

  const idColumn = useMemo(
    () => detectIdColumn(result.fields),
    [result.fields]
  );

  // Filter rows based on column filters
  const filteredRows = useMemo(() => {
    if (columnFilters.size === 0) return result.rows;
    return result.rows.filter(row => {
      for (const [col, filterVal] of columnFilters) {
        if (!filterVal) continue;
        const cellVal = String(row[col] ?? '').toLowerCase();
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
  const getCellChange = useCallback((rowIndex: number, columnId: string): CellChange | undefined => {
    return pendingChanges?.find(c => c.rowIndex === rowIndex && c.columnId === columnId);
  }, [pendingChanges]);

  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    return result.fields.map(field => ({
      accessorKey: field,
      header: ({ column }) => {
        const hasFilter = columnFilters.has(field) && !!columnFilters.get(field);
        const isSensitive = effectiveMaskingEnabled && sensitiveColumns.has(field);
        return (
          <div className="flex items-center gap-1 select-none group/header w-full">
            <div
              className="flex items-center gap-1 cursor-pointer flex-1 min-w-0"
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            >
              <span className="truncate">{field}</span>
              {isSensitive && (
                <span title="Masked column"><Lock className="w-3 h-3 text-purple-400 shrink-0" /></span>
              )}
              <div className="flex-shrink-0 opacity-0 group-hover/header:opacity-100 transition-opacity">
                {column.getIsSorted() === "asc" ? (
                  <ArrowUp className="w-3 h-3" />
                ) : column.getIsSorted() === "desc" ? (
                  <ArrowDown className="w-3 h-3" />
                ) : (
                  <ArrowUpDown className="w-3 h-3" />
                )}
              </div>
            </div>
            <button
              className={cn(
                "shrink-0 p-0.5 rounded transition-colors",
                hasFilter ? "text-blue-400" : "opacity-0 group-hover/header:opacity-100 text-zinc-500 hover:text-zinc-300"
              )}
              onClick={(e) => { e.stopPropagation(); setActiveFilterCol(activeFilterCol === field ? null : field); }}
              title="Filter column"
            >
              <Filter className="w-3 h-3" />
            </button>
            {activeFilterCol === field && (
              <div
                className="absolute top-full left-0 mt-1 z-30 bg-[#111] border border-white/10 rounded-lg shadow-xl p-2 w-48"
                onClick={e => e.stopPropagation()}
              >
                <input
                  autoFocus
                  placeholder={`Filter ${field}...`}
                  value={columnFilters.get(field) || ''}
                  onChange={e => {
                    const next = new Map(columnFilters);
                    if (e.target.value) next.set(field, e.target.value);
                    else next.delete(field);
                    setColumnFilters(next);
                  }}
                  onKeyDown={e => { if (e.key === 'Escape' || e.key === 'Enter') setActiveFilterCol(null); }}
                  className="w-full bg-[#050505] border border-white/10 rounded px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-blue-500/30"
                />
                {hasFilter && (
                  <button
                    className="mt-1 text-[10px] text-red-400 hover:text-red-300"
                    onClick={() => {
                      const next = new Map(columnFilters);
                      next.delete(field);
                      setColumnFilters(next);
                      setActiveFilterCol(null);
                    }}
                  >
                    Clear filter
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
            <div className="flex items-center gap-1 w-full" onClick={(e) => e.stopPropagation()}>
              <input
                autoFocus
                className="w-full bg-zinc-800 border border-blue-500 rounded px-1 py-0.5 text-zinc-100 outline-none"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (editValue !== String(val ?? '') && onCellChange && editingEnabled) {
                      onCellChange({
                        rowIndex: row.index,
                        columnId: column.id,
                        originalValue: val,
                        newValue: editValue,
                      });
                    }
                    setEditingCell(null);
                  }
                  if (e.key === 'Escape') setEditingCell(null);
                }}
                onBlur={() => {
                  if (editValue !== String(val ?? '') && onCellChange && editingEnabled) {
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
              <span className="text-zinc-500 italic">{masked}</span>
              {userCanReveal && (
                <button
                  className="opacity-0 group-hover/cell:opacity-100 transition-opacity p-0.5 rounded hover:bg-purple-500/10"
                  onClick={(e) => { e.stopPropagation(); revealCell(cellKey); }}
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
              <Lock className="w-2.5 h-2.5 text-purple-400/50 shrink-0" />
            </div>
          );
        }

        // Show pending change value
        const displayVal = pendingChange !== undefined ? pendingChange.newValue : val;
        const { display, className } = formatCellValue(displayVal);

        return (
          <div
            className={cn(
              "truncate w-full h-full cursor-text",
              pendingChange && "bg-amber-500/10 rounded px-0.5"
            )}
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
  }, [result.fields, editingCell, editValue, effectiveMaskingEnabled, sensitiveColumns, editingEnabled, onCellChange, getCellChange, columnFilters, activeFilterCol, revealedCells, userCanReveal, revealCell]);

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    columnResizeMode: 'onChange',
  });

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const cardContainerRef = useRef<HTMLDivElement>(null);
  const mobileTableContainerRef = useRef<HTMLDivElement>(null);

  const { rows } = table.getRowModel();

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
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center text-zinc-600 animate-in fade-in zoom-in-95 duration-500">
        <div className="w-16 h-16 rounded-2xl bg-zinc-900/50 flex items-center justify-center mb-6 border border-white/5 shadow-2xl">
          <span className="text-2xl text-zinc-500">&#x2205;</span>
        </div>
        <p className="text-sm font-semibold text-zinc-400">Query returned no data</p>
        <p className="text-xs text-zinc-600 mt-2 max-w-[280px] leading-relaxed">
          The operation was successful, but the result set is currently empty.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#080808]">
      {/* Stats Bar with View Toggle */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-[#0a0a0a] text-[11px] text-zinc-500 font-mono">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/50" />
            {result.rows.length} rows
            {result.pagination?.hasMore && (
              <span className="text-amber-400 ml-1">(more available)</span>
            )}
          </span>
          <span className="hidden sm:inline">{result.fields.length} columns</span>
          {activeFilterCount > 0 && (
            <button
              className="flex items-center gap-1 text-blue-400 text-[10px] bg-blue-500/10 px-2 py-0.5 rounded hover:bg-blue-500/20 transition-colors"
              onClick={() => { setColumnFilters(new Map()); setActiveFilterCol(null); }}
              title="Clear all filters"
            >
              <Filter className="w-3 h-3" />
              {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''} &bull; {filteredRows.length} shown
              <X className="w-3 h-3" />
            </button>
          )}
          {result.pagination?.wasLimited && (
            <span className="text-blue-400 text-[10px] bg-blue-500/10 px-2 py-0.5 rounded">
              AUTO-LIMITED
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Data Masking Toggle */}
          {hasSensitive && (
            userCanToggle && onToggleMasking ? (
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-6 px-2 text-[10px] font-bold gap-1",
                  effectiveMaskingEnabled ? "text-purple-400 bg-purple-500/10" : "text-zinc-500"
                )}
                onClick={onToggleMasking}
                title={effectiveMaskingEnabled ? 'Show sensitive data' : 'Mask sensitive data'}
              >
                {effectiveMaskingEnabled ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                {effectiveMaskingEnabled ? 'MASKED' : 'MASK'}
              </Button>
            ) : effectiveMaskingEnabled ? (
              <span className="h-6 px-2 text-[10px] font-bold text-purple-400 bg-purple-500/10 rounded flex items-center gap-1">
                <Lock className="w-3 h-3" />
                MASKED
              </span>
            ) : null
          )}

          {/* Pending Changes Indicator */}
          {editingEnabled && pendingChanges && pendingChanges.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                {pendingChanges.length} change{pendingChanges.length > 1 ? 's' : ''}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px] text-emerald-400 hover:bg-emerald-500/10"
                onClick={onApplyChanges}
              >
                <Save className="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px] text-red-400 hover:bg-red-500/10"
                onClick={onDiscardChanges}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          )}

          {/* Execution Time - Hidden on mobile */}
          <span className="hidden sm:flex px-2 py-0.5 rounded bg-white/5 border border-white/5">
            EXEC TIME: {result.executionTime || '0ms'}
          </span>

          {/* View Toggle - Mobile only */}
          <div className="flex md:hidden items-center bg-white/5 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('card')}
              className={cn(
                "p-1.5 rounded transition-all",
                viewMode === 'card' ? "bg-blue-600 text-white" : "text-zinc-500"
              )}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={cn(
                "p-1.5 rounded transition-all",
                viewMode === 'table' ? "bg-blue-600 text-white" : "text-zinc-500"
              )}
            >
              <Table2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Card View */}
      <div
        ref={cardContainerRef}
        className={cn(
          "flex-1 overflow-auto p-4 md:hidden",
          viewMode !== 'card' && "hidden"
        )}
      >
        <div
          style={{ height: `${cardVirtualizer.getTotalSize()}px`, position: 'relative' }}
        >
          {cardVirtualizer.getVirtualItems().map(virtualRow => (
            <div
              key={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
                padding: '4px 0',
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

      {/* Mobile Table View (when toggled) - Virtualized with horizontal scroll */}
      <div
        ref={mobileTableContainerRef}
        className={cn(
          "flex-1 overflow-auto md:hidden",
          viewMode !== 'table' && "hidden"
        )}
      >
        <div className="min-w-max">
          {/* Header - Sticky */}
          <div className="sticky top-0 z-20 bg-[#0d0d0d] flex">
            {result.fields.map((field, idx) => {
              const isSensitive = effectiveMaskingEnabled && sensitiveColumns.has(field);
              return (
                <div
                  key={field}
                  className={cn(
                    "h-10 px-4 flex items-center gap-1 border-r border-b border-white/5 text-[10px] uppercase font-mono tracking-wider text-zinc-500 bg-[#0d0d0d] whitespace-nowrap",
                    idx === 0 && "sticky left-0 z-30 bg-[#0d0d0d] shadow-[2px_0_8px_rgba(0,0,0,0.3)]",
                    "min-w-[120px]"
                  )}
                >
                  {field}
                  {isSensitive && <Lock className="w-2.5 h-2.5 text-purple-400" />}
                </div>
              );
            })}
          </div>

          {/* Virtualized Body */}
          <div
            style={{
              height: `${mobileTableVirtualizer.getTotalSize()}px`,
              position: 'relative',
            }}
          >
            {mobileTableVirtualizer.getVirtualItems().map(virtualRow => {
              const row = result.rows[virtualRow.index];
              return (
                <div
                  key={virtualRow.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="flex hover:bg-blue-500/[0.03] transition-colors border-b border-white/5 cursor-pointer"
                  onClick={() => setSelectedRow({ row, index: virtualRow.index })}
                >
                  {result.fields.map((field, idx) => {
                    const pattern = sensitiveColumns.get(field);
                    const isMasked = effectiveMaskingEnabled && pattern && row[field] != null && row[field] !== undefined;
                    const displayValue = isMasked
                      ? maskValueByPattern(row[field], pattern)
                      : formatCellValue(row[field]).display;
                    const className = isMasked
                      ? 'text-zinc-500 italic'
                      : formatCellValue(row[field]).className;

                    return (
                      <div
                        key={field}
                        className={cn(
                          "h-full px-4 py-3 border-r border-white/5 text-[12px] font-mono whitespace-nowrap overflow-hidden flex items-center",
                          idx === 0 && "sticky left-0 z-10 bg-[#080808] shadow-[2px_0_8px_rgba(0,0,0,0.3)]",
                          "min-w-[120px]"
                        )}
                      >
                        <span className={className}>{displayValue}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Desktop Table View (always visible on desktop) */}
      <div
        ref={tableContainerRef}
        className="hidden md:block flex-1 overflow-auto editor-scrollbar"
      >
        <div className="min-w-max">
          {/* Header */}
          <div className="sticky top-0 z-20 bg-[#0d0d0d] flex">
            {table.getHeaderGroups().map(headerGroup => (
              headerGroup.headers.map(header => (
                <div
                  key={header.id}
                  style={{ width: header.getSize(), minWidth: header.getSize() }}
                  className="h-10 px-4 flex items-center border-r border-b border-white/5 text-[10px] uppercase font-mono tracking-wider text-zinc-500 bg-[#0d0d0d] relative group shrink-0"
                >
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}

                  {/* Column Resizer */}
                  <div
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    className={cn(
                      "absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-500/50 transition-colors",
                      header.column.getIsResizing() ? "bg-blue-500 w-1" : "bg-transparent"
                    )}
                  />
                </div>
              ))
            ))}
          </div>

          {/* Body */}
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map(virtualRow => {
              const row = rows[virtualRow.index];
              return (
                <div
                  key={row.id}
                  data-index={virtualRow.index}
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    position: 'absolute',
                    top: 0,
                    left: 0,
                  }}
                  className="flex group hover:bg-blue-500/[0.03] transition-colors border-b border-white/5"
                >
                  {row.getVisibleCells().map(cell => (
                    <div
                      key={cell.id}
                      style={{ width: cell.column.getSize(), minWidth: cell.column.getSize() }}
                      className="h-full px-4 py-2 border-r border-white/5 text-[12px] font-mono whitespace-nowrap overflow-hidden group-hover:border-white/10 flex items-center shrink-0"
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

      {/* Load More Footer */}
      {result.pagination?.hasMore && onLoadMore && (
        <div className="flex items-center justify-center py-3 border-t border-white/5 bg-[#0a0a0a]">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="h-8 px-4 text-xs border-white/10 hover:bg-white/5"
          >
            {isLoadingMore ? (
              <>
                <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                Loading...
              </>
            ) : (
              <>
                <ChevronDown className="w-3 h-3 mr-2" />
                Load More (500 rows)
              </>
            )}
          </Button>
        </div>
      )}

      {/* Row Detail Sheet */}
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
