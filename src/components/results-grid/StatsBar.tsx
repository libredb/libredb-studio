"use client";

import React from "react";
import { QueryResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChevronDown, LayoutGrid, Table2, Loader2, EyeOff, Eye, Save, X, Filter, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CellChange } from "@/components/ResultsGrid";
import { describeWarning } from "@/components/results-grid/utils";

const MASKED_LABEL = "MASKED";
const LOADING_LABEL = "Loading...";
const LOAD_MORE_LABEL = "Load More (500 rows)";

export interface StatsBarProps {
  result: QueryResult;
  filteredRowCount: number;
  activeFilterCount: number;
  onClearFilters: () => void;
  viewMode: "card" | "table";
  onSetViewMode: (mode: "card" | "table") => void;
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
  // Load more props
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
}

export function StatsBar({
  result,
  filteredRowCount,
  activeFilterCount,
  onClearFilters,
  viewMode,
  onSetViewMode,
  hasSensitive,
  effectiveMaskingEnabled,
  userCanToggle,
  onToggleMasking,
  editingEnabled,
  pendingChanges,
  onApplyChanges,
  onDiscardChanges,
}: StatsBarProps) {
  const warnings = result.warnings ?? [];
  const warningDetail = warnings.map(describeWarning).join("\n");

  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-hairline bg-surface text-xs text-fg-muted font-mono">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/50" />
          {result.rows.length} rows
          {result.pagination?.hasMore && <span className="text-amber-400 ml-1">(more available)</span>}
        </span>
        <span className="hidden sm:inline">{result.fields.length} columns</span>
        {activeFilterCount > 0 && (
          <button
            className="flex items-center gap-1 text-blue-400 text-xs bg-blue-500/10 px-2 py-0.5 rounded hover:bg-blue-500/20 transition-colors"
            onClick={onClearFilters}
            title="Clear all filters"
          >
            <Filter strokeWidth={1.5} className="w-3 h-3" />
            {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""} &bull; {filteredRowCount} shown
            <X strokeWidth={1.5} className="w-3 h-3" />
          </button>
        )}
        {result.pagination?.wasLimited && (
          <span className="text-blue-400 text-xs bg-blue-500/10 px-2 py-0.5 rounded">AUTO-LIMITED</span>
        )}
        {warnings.length > 0 && (
          <span className="text-amber-400 text-xs bg-amber-500/10 px-2 py-0.5 rounded" title={warningDetail}>
            {warnings.length} WARNING{warnings.length > 1 ? "S" : ""}
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
                effectiveMaskingEnabled ? "text-purple-400 bg-purple-500/10" : "text-fg-muted",
              )}
              onClick={onToggleMasking}
              title={effectiveMaskingEnabled ? "Show sensitive data" : "Mask sensitive data"}
            >
              {effectiveMaskingEnabled ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              {effectiveMaskingEnabled ? "MASKED" : "MASK"}
            </Button>
          ) : effectiveMaskingEnabled ? (
            <span className="h-6 px-2 text-xs font-medium text-purple-400 bg-purple-500/10 rounded flex items-center gap-1">
              <Lock strokeWidth={1.5} className="w-3 h-3" />
              {MASKED_LABEL}
            </span>
          ) : null)}

        {editingEnabled && pendingChanges && pendingChanges.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="text-xs text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
              {pendingChanges.length} change{pendingChanges.length > 1 ? "s" : ""}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-emerald-400 hover:bg-emerald-500/10"
              onClick={onApplyChanges}
            >
              <Save strokeWidth={1.5} className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-red-400 hover:bg-red-500/10"
              onClick={onDiscardChanges}
            >
              <X strokeWidth={1.5} className="w-3 h-3" />
            </Button>
          </div>
        )}

        <span className="hidden sm:flex px-2 py-0.5 rounded bg-fill border border-hairline">
          EXEC TIME: {result.executionTime || "0ms"}
        </span>

        <div className="flex md:hidden items-center bg-fill rounded-lg p-0.5">
          <button
            onClick={() => onSetViewMode("card")}
            className={cn(
              "p-1.5 rounded transition-all",
              viewMode === "card" ? "bg-blue-600 text-white" : "text-fg-muted",
            )}
          >
            <LayoutGrid strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onSetViewMode("table")}
            className={cn(
              "p-1.5 rounded transition-all",
              viewMode === "table" ? "bg-blue-600 text-white" : "text-fg-muted",
            )}
          >
            <Table2 strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export interface LoadMoreFooterProps {
  hasMore: boolean;
  onLoadMore: () => void;
  isLoadingMore?: boolean;
}

export function LoadMoreFooter({ hasMore, onLoadMore, isLoadingMore }: LoadMoreFooterProps) {
  if (!hasMore) return null;

  return (
    <div className="flex items-center justify-center py-3 border-t border-hairline bg-surface">
      <Button
        variant="outline"
        size="sm"
        onClick={onLoadMore}
        disabled={isLoadingMore}
        className="h-8 px-4 text-xs border-hairline-strong hover:bg-fill"
      >
        {isLoadingMore && (
          <>
            <Loader2 strokeWidth={1.5} className="w-3 h-3 mr-2 animate-spin" />
            {LOADING_LABEL}
          </>
        )}
        {!isLoadingMore && (
          <>
            <ChevronDown strokeWidth={1.5} className="w-3 h-3 mr-2" />
            {LOAD_MORE_LABEL}
          </>
        )}
      </Button>
    </div>
  );
}
