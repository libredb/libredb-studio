"use client";

import React, { useMemo, useState, useRef } from 'react';
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
  LayoutGrid,
  Table2,
  Hash,
  FileJson,
  Check,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface ResultsGridProps {
  result: QueryResult;
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
}: {
  row: Record<string, unknown>;
  fields: string[];
  primaryColumn: string;
  idColumn: string | null;
  index: number;
  onSelect: () => void;
}) {
  const primaryValue: unknown = row[primaryColumn];
  const idValue: unknown = idColumn ? row[idColumn] : null;

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
            <p className="text-sm font-semibold text-zinc-100 truncate">
              {primaryValue != null ? String(primaryValue) : `Row ${index + 1}`}
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
          const { display, className } = formatCellValue(row[field]);
          return (
            <div key={field} className="flex items-center justify-between text-xs">
              <span className="text-zinc-500 truncate mr-2">{field}</span>
              <span className={cn("truncate max-w-[60%] text-right font-mono", className)}>
                {display}
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
}: {
  row: Record<string, unknown>;
  fields: string[];
  isOpen: boolean;
  onClose: () => void;
  rowIndex: number;
}) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copyValue = (field: string, value: unknown) => {
    const textValue = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    navigator.clipboard.writeText(textValue);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const copyAllAsJson = () => {
    navigator.clipboard.writeText(JSON.stringify(row, null, 2));
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
              const { display, className } = formatCellValue(row[field]);
              const isLongValue = display.length > 50;

              return (
                <div
                  key={field}
                  className="group p-3 rounded-lg hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1 font-mono">
                        {field}
                      </p>
                      <p className={cn(
                        "font-mono text-sm break-all",
                        className,
                        isLongValue && "text-xs"
                      )}>
                        {display}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
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
              );
            })}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

export function ResultsGrid({ result }: ResultsGridProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [editingCell, setEditingCell] = useState<{ rowIndex: number, columnId: string } | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  const [selectedRow, setSelectedRow] = useState<{ row: Record<string, unknown>; index: number } | null>(null);

  const primaryColumn = useMemo(
    () => detectPrimaryColumn(result.fields, result.rows),
    [result.fields, result.rows]
  );

  const idColumn = useMemo(
    () => detectIdColumn(result.fields),
    [result.fields]
  );

  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    return result.fields.map(field => ({
      accessorKey: field,
      header: ({ column }) => {
        return (
          <div
            className="flex items-center gap-2 cursor-pointer select-none group/header"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            <span className="truncate">{field}</span>
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
        );
      },
      cell: ({ row, column, getValue }) => {
        const val = getValue();
        const isEditing = editingCell?.rowIndex === row.index && editingCell?.columnId === column.id;

        if (isEditing) {
          return (
            <div className="flex items-center gap-1 w-full" onClick={(e) => e.stopPropagation()}>
              <input
                autoFocus
                className="w-full bg-zinc-800 border border-blue-500 rounded px-1 py-0.5 text-zinc-100 outline-none"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setEditingCell(null);
                  if (e.key === 'Escape') setEditingCell(null);
                }}
                onBlur={() => setEditingCell(null)}
              />
            </div>
          );
        }

        const { display, className } = formatCellValue(val);

        return (
          <div
            className="truncate w-full h-full cursor-text"
            onDoubleClick={() => {
              setEditingCell({ rowIndex: row.index, columnId: column.id });
              setEditValue(String(val ?? ""));
            }}
          >
            <span className={className}>{display}</span>
          </div>
        );
      },
      size: 150,
      minSize: 80,
      maxSize: 500,
    }));
  }, [result.fields, editingCell, editValue]);

  const table = useReactTable({
    data: result.rows,
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

  if (!result || result.rows.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center text-zinc-600 animate-in fade-in zoom-in-95 duration-500">
        <div className="w-16 h-16 rounded-2xl bg-zinc-900/50 flex items-center justify-center mb-6 border border-white/5 shadow-2xl">
          <span className="text-2xl text-zinc-500">∅</span>
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
          </span>
          <span className="hidden sm:inline">{result.fields.length} columns</span>
        </div>

        <div className="flex items-center gap-2">
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
              />
            </div>
          ))}
        </div>
      </div>

      {/* Mobile Table View (when toggled) - Horizontal scroll with sticky first column */}
      <div
        className={cn(
          "flex-1 overflow-auto md:hidden",
          viewMode !== 'table' && "hidden"
        )}
      >
        <div className="min-w-max">
          <table className="border-separate border-spacing-0">
            <thead className="sticky top-0 z-20 bg-[#0d0d0d]">
              <tr>
                {result.fields.map((field, idx) => (
                  <th
                    key={field}
                    className={cn(
                      "h-10 px-4 text-left border-r border-b border-white/5 text-[10px] uppercase font-mono tracking-wider text-zinc-500 bg-[#0d0d0d] whitespace-nowrap",
                      idx === 0 && "sticky left-0 z-30 bg-[#0d0d0d] shadow-[2px_0_8px_rgba(0,0,0,0.3)]",
                      "min-w-[120px]"
                    )}
                  >
                    {field}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  className="hover:bg-blue-500/[0.03] transition-colors border-b border-white/5 cursor-pointer"
                  onClick={() => setSelectedRow({ row, index: rowIdx })}
                >
                  {result.fields.map((field, idx) => {
                    const { display, className } = formatCellValue(row[field]);
                    return (
                      <td
                        key={field}
                        className={cn(
                          "px-4 py-3 border-r border-white/5 text-[12px] font-mono whitespace-nowrap",
                          idx === 0 && "sticky left-0 z-10 bg-[#080808] shadow-[2px_0_8px_rgba(0,0,0,0.3)]",
                          "min-w-[120px]"
                        )}
                      >
                        <span className={className}>{display}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
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

      {/* Row Detail Sheet */}
      {selectedRow && (
        <RowDetailSheet
          row={selectedRow.row}
          fields={result.fields}
          isOpen={!!selectedRow}
          onClose={() => setSelectedRow(null)}
          rowIndex={selectedRow.index}
        />
      )}
    </div>
  );
}
