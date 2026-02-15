"use client";

import React, { useMemo } from 'react';
import { cn } from '@/lib/utils';
import {
  Hash,
  ChevronRight,
  Lock,
} from 'lucide-react';
import {
  type MaskingPattern,
  maskValueByPattern,
} from '@/lib/data-masking';
import { formatCellValue } from './utils';

export interface ResultCardProps {
  row: Record<string, unknown>;
  fields: string[];
  primaryColumn: string;
  idColumn: string | null;
  index: number;
  onSelect: () => void;
  maskingActive?: boolean;
  sensitiveColumns?: Map<string, MaskingPattern>;
}

export function ResultCard({
  row,
  fields,
  primaryColumn,
  idColumn,
  index,
  onSelect,
  maskingActive,
  sensitiveColumns,
}: ResultCardProps) {
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
