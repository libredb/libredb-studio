"use client";

import React from "react";
import type { DatabaseConnection } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import { cn } from "@/lib/utils";
import { FlaskConical, Pencil, Play, Save, Square, Terminal, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

interface QueryToolbarProps {
  activeConnection: DatabaseConnection | null;
  metadata: ProviderMetadata | null;
  isExecuting: boolean;
  playgroundMode: boolean;
  transactionActive: boolean;
  editingEnabled: boolean;
  /** Omitted where the caller offers nowhere to save a query to. */
  onSaveQuery?: () => void;
  onExecuteQuery: () => void;
  onCancelQuery: () => void;
  /**
   * The transaction trio, supplied together or not at all. A caller that cannot
   * run transactions omits all three and BEGIN/COMMIT/ROLLBACK do not render —
   * the embedded shell passed `noop` for them and, once it started passing real
   * provider metadata, showed three buttons that did nothing (#427).
   */
  onBeginTransaction?: () => void;
  onCommitTransaction?: () => void;
  onRollbackTransaction?: () => void;
  /** Omitted where the caller cannot run sandboxed (auto-rolled-back) queries. */
  onTogglePlayground?: () => void;
  /** Omitted where the provider declares no inline row editing (issue #269). */
  onToggleEditing?: () => void;
  /** Omitted where the caller offers no data import. */
  onImport?: () => void;
}

export function QueryToolbar({
  activeConnection,
  metadata,
  isExecuting,
  playgroundMode,
  transactionActive,
  editingEnabled,
  onSaveQuery,
  onExecuteQuery,
  onCancelQuery,
  onBeginTransaction,
  onCommitTransaction,
  onRollbackTransaction,
  onTogglePlayground,
  onToggleEditing,
  onImport,
}: QueryToolbarProps) {
  // Bundled so the three cannot be half-supplied: a caller offering BEGIN without
  // COMMIT would strand the user inside a transaction it cannot close.
  const transaction =
    onBeginTransaction && onCommitTransaction && onRollbackTransaction
      ? { begin: onBeginTransaction, commit: onCommitTransaction, rollback: onRollbackTransaction }
      : null;
  // The group's border and separator are chrome for its members; with no member to
  // show, the whole group goes rather than leaving an empty rule (#427).
  const hasGroupControls = transaction !== null || !!onTogglePlayground || !!onToggleEditing || !!onImport;

  return (
    <>
      {/* Playground Mode Banner */}
      {playgroundMode && (
        <div className="hidden md:flex items-center justify-center gap-2 px-4 py-1 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-400">
          <FlaskConical strokeWidth={1.5} className="w-3 h-3" />
          <span className="text-xs font-mediumr">Sandbox Mode — All changes will be auto-rolled back</span>
        </div>
      )}

      {/* Desktop Query Toolbar */}
      <div className="hidden md:flex items-center justify-between px-4 py-1.5 bg-surface border-b border-hairline">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-2 py-0.5 rounded bg-blue-500/5 border border-blue-500/10">
            <Terminal strokeWidth={1.5} className="w-3 h-3 text-blue-400" />
            <span className="text-xs font-medium text-blue-400">Query</span>
          </div>
          {/* The separator is chrome for Save; with Save withheld it would be a rule
              standing alone, the same reason the control group drops its border (#427). */}
          {onSaveQuery && (
            <>
              <div className="h-4 w-px bg-fill" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-2"
                onClick={onSaveQuery}
              >
                <Save strokeWidth={1.5} className="w-3 h-3" /> Save
              </Button>
            </>
          )}
        </div>
        {isExecuting ? (
          <Button
            size="sm"
            className="bg-red-600 hover:bg-red-500 text-white font-medium text-xs h-7 px-4 gap-2"
            onClick={onCancelQuery}
          >
            <Square strokeWidth={1.5} className="w-3 h-3 fill-current" />
            CANCEL
          </Button>
        ) : (
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs h-7 px-4 gap-2"
            onClick={onExecuteQuery}
            disabled={!activeConnection}
          >
            <Play strokeWidth={1.5} className="w-3 h-3 fill-current" />
            RUN
          </Button>
        )}

        {/* Transaction Controls + Playground + Import + Edit */}
        {activeConnection && metadata?.capabilities.queryLanguage === "sql" && hasGroupControls && (
          <div className="flex items-center gap-1 ml-2 pl-2 border-l border-hairline-strong">
            {transaction !== null &&
              (transactionActive ? (
                <>
                  <span className="text-[0.625rem] font-medium text-amber-400 px-1.5 py-0.5 bg-amber-500/10 rounded border border-amber-500/20 mr-1">
                    TXN
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs font-medium text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 gap-1"
                    onClick={transaction.commit}
                  >
                    COMMIT
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-1"
                    onClick={transaction.rollback}
                  >
                    ROLLBACK
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-1"
                  onClick={transaction.begin}
                  disabled={playgroundMode}
                >
                  BEGIN
                </Button>
              ))}

            {onTogglePlayground && (
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  "h-7 text-xs font-medium gap-1",
                  playgroundMode
                    ? "text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                    : "text-fg-muted hover:text-fg-bright",
                )}
                onClick={onTogglePlayground}
                disabled={transactionActive}
                title="Playground mode: queries are auto-rolled back"
              >
                <FlaskConical strokeWidth={1.5} className="w-3 h-3" />
                SANDBOX
              </Button>
            )}

            {onToggleEditing && (
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  "h-7 text-xs font-medium gap-1",
                  editingEnabled
                    ? "text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
                    : "text-fg-muted hover:text-fg-bright",
                )}
                onClick={onToggleEditing}
                title="Enable inline data editing"
              >
                <Pencil strokeWidth={1.5} className="w-3 h-3" />
                EDIT
              </Button>
            )}

            {onImport && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-1"
                onClick={onImport}
                title="Import data from CSV/JSON"
              >
                <Upload strokeWidth={1.5} className="w-3 h-3" />
                IMPORT
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
