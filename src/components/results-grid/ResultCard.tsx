"use client";

import React, { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Hash, ChevronRight, Lock } from "lucide-react";
import { type MaskingPattern, maskValueByPattern } from "@/lib/data-masking";
import { formatCellValue } from "./utils";

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
  const previewFields = fields.filter((f) => f !== primaryColumn && f !== idColumn).slice(0, 4);

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left bg-raised border border-hairline rounded-xl p-4 active:scale-[0.98] transition-all cursor-pointer hover:border-hairline-strong hover:bg-overlay"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
            <Hash strokeWidth={1.5} className="w-3.5 h-3.5 text-blue-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "text-xs font-medium truncate",
                maskingActive && sensitiveColumns?.has(primaryColumn) ? "text-fg-muted italic" : "text-fg",
              )}
            >
              {displayPrimary}
            </p>
            {idValue != null && <p className="text-xs text-fg-muted font-mono">#{String(idValue)}</p>}
          </div>
        </div>
        <ChevronRight strokeWidth={1.5} className="w-3.5 h-3.5 text-fg-subtle" />
      </div>

      <div className="space-y-2">
        {previewFields.map((field) => {
          const pattern = sensitiveColumns?.get(field);
          const isMasked = maskingActive && pattern && row[field] != null && row[field] !== undefined;
          const displayValue = isMasked ? maskValueByPattern(row[field], pattern) : formatCellValue(row[field]).display;
          const className = isMasked ? "text-fg-muted italic" : formatCellValue(row[field]).className;

          return (
            <div key={field} className="flex items-center justify-between text-xs">
              <span className="text-fg-muted truncate mr-2">
                {field}
                {isMasked && <Lock strokeWidth={1.5} className="w-2.5 h-2.5 inline ml-1 text-purple-400" />}
              </span>
              <span className={cn("truncate max-w-[60%] text-right font-mono", className)}>{displayValue}</span>
            </div>
          );
        })}
        {fields.length > previewFields.length + 2 && (
          <p className="text-xs text-fg-subtle text-center pt-1">
            +{fields.length - previewFields.length - 2} more fields
          </p>
        )}
      </div>
    </button>
  );
}
