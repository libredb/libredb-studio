'use client';

import React from 'react';
import type { DatabaseConnection } from '@/lib/types';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';
import { cn } from '@/lib/utils';
import { FlaskConical, Pencil, Play, Save, Square, Terminal, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface QueryToolbarProps {
  activeConnection: DatabaseConnection | null;
  metadata: ProviderMetadata | null;
  isExecuting: boolean;
  playgroundMode: boolean;
  transactionActive: boolean;
  editingEnabled: boolean;
  onSaveQuery: () => void;
  onExecuteQuery: () => void;
  onCancelQuery: () => void;
  onBeginTransaction: () => void;
  onCommitTransaction: () => void;
  onRollbackTransaction: () => void;
  onTogglePlayground: () => void;
  onToggleEditing: () => void;
  onImport: () => void;
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
  return (
    <>
      {/* Playground Mode Banner */}
      {playgroundMode && (
        <div className="hidden md:flex items-center justify-center gap-2 px-4 py-1 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-400">
          <FlaskConical className="w-3 h-3" />
          <span className="text-xs font-mediumr">
            Sandbox Mode — All changes will be auto-rolled back
          </span>
        </div>
      )}

      {/* Desktop Query Toolbar */}
      <div className="hidden md:flex items-center justify-between px-4 py-1.5 bg-[#0a0a0a] border-b border-white/5">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-2 py-0.5 rounded bg-blue-500/5 border border-blue-500/10">
            <Terminal className="w-3 h-3 text-blue-400" />
            <span className="text-xs font-medium text-blue-400">Query</span>
          </div>
          <div className="h-4 w-px bg-white/5" />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs font-medium text-zinc-500 hover:text-white gap-2"
            onClick={onSaveQuery}
          >
            <Save className="w-3 h-3" /> Save
          </Button>
        </div>
        {isExecuting ? (
          <Button
            size="sm"
            className="bg-red-600 hover:bg-red-500 text-white font-medium text-xs h-7 px-4 gap-2"
            onClick={onCancelQuery}
          >
            <Square className="w-3 h-3 fill-current" />
            CANCEL
          </Button>
        ) : (
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs h-7 px-4 gap-2"
            onClick={onExecuteQuery}
            disabled={!activeConnection}
          >
            <Play className="w-3 h-3 fill-current" />
            RUN
          </Button>
        )}

        {/* Transaction Controls + Playground + Import + Edit */}
        {activeConnection && metadata?.capabilities.queryLanguage === 'sql' && (
          <div className="flex items-center gap-1 ml-2 pl-2 border-l border-white/10">
            {transactionActive ? (
              <>
                <span className="text-[0.625rem] font-medium text-amber-400 px-1.5 py-0.5 bg-amber-500/10 rounded border border-amber-500/20 mr-1">
                  TXN
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs font-medium text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 gap-1"
                  onClick={onCommitTransaction}
                >
                  COMMIT
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-1"
                  onClick={onRollbackTransaction}
                >
                  ROLLBACK
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs font-medium text-zinc-500 hover:text-white gap-1"
                onClick={onBeginTransaction}
                disabled={playgroundMode}
              >
                BEGIN
              </Button>
            )}

            <Button
              size="sm"
              variant="ghost"
              className={cn(
                "h-7 text-xs font-medium gap-1",
                playgroundMode
                  ? "text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                  : "text-zinc-500 hover:text-white"
              )}
              onClick={onTogglePlayground}
              disabled={transactionActive}
              title="Playground mode: queries are auto-rolled back"
            >
              <FlaskConical className="w-3 h-3" />
              SANDBOX
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className={cn(
                "h-7 text-xs font-medium gap-1",
                editingEnabled
                  ? "text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
                  : "text-zinc-500 hover:text-white"
              )}
              onClick={onToggleEditing}
              title="Enable inline data editing"
            >
              <Pencil className="w-3 h-3" />
              EDIT
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs font-medium text-zinc-500 hover:text-white gap-1"
              onClick={onImport}
              title="Import data from CSV/JSON"
            >
              <Upload className="w-3 h-3" />
              IMPORT
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
