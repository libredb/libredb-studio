'use client';

import React, { type RefObject } from 'react';
import type { DatabaseConnection } from '@/lib/types';
import type { QueryEditorRef } from '@/components/QueryEditor';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  AlignLeft, ChevronDown, Copy, Database, Edit3, Gauge,
  LogOut, MoreVertical, Pencil, Play, PlayCircle, Plus,
  Save, Settings, Sparkles, Square, Trash2, Upload, User, Zap,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

interface StudioMobileHeaderProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  connectionPulse: 'healthy' | 'degraded' | 'error' | null;
  user: { role?: string } | null;
  isAdmin: boolean;
  activeMobileTab: 'database' | 'schema' | 'editor';
  isExecuting: boolean;
  currentQuery: string;
  queryEditorRef: RefObject<QueryEditorRef | null>;
  transactionActive: boolean;
  playgroundMode: boolean;
  editingEnabled: boolean;
  onSelectConnection: (conn: DatabaseConnection) => void;
  onAddConnection: () => void;
  onLogout: () => void;
  onSaveQuery: () => void;
  onClearQuery: () => void;
  onExecuteQuery: () => void;
  onCancelQuery: () => void;
  onBeginTransaction: () => void;
  onCommitTransaction: () => void;
  onRollbackTransaction: () => void;
  onTogglePlayground: () => void;
  onToggleEditing: () => void;
  onImport: () => void;
  onExplain?: () => void;
}

export function StudioMobileHeader({
  connections,
  activeConnection,
  connectionPulse,
  user,
  isAdmin,
  activeMobileTab,
  isExecuting,
  currentQuery,
  queryEditorRef,
  transactionActive,
  playgroundMode,
  editingEnabled,
  onSelectConnection,
  onAddConnection,
  onLogout,
  onSaveQuery,
  onClearQuery,
  onExecuteQuery,
  onCancelQuery,
  onBeginTransaction,
  onCommitTransaction,
  onRollbackTransaction,
  onTogglePlayground,
  onToggleEditing,
  onImport,
  onExplain,
}: StudioMobileHeaderProps) {
  const router = useRouter();

  return (
    <header className="md:hidden border-b border-white/5 bg-[#0a0a0a]/95 backdrop-blur-xl sticky top-0 z-30">
      {/* Row 1: DB Selector + Connection Info + User */}
      <div className="h-12 flex items-center justify-between px-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2 gap-1 bg-[#111] border-white/10 hover:bg-white/5 text-zinc-300 max-w-[160px]"
              >
                <Database className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span className="truncate text-xs font-medium">
                  {activeConnection ? activeConnection.name : 'Select DB'}
                </span>
                <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 bg-[#0d0d0d] border-white/10">
              {connections.length === 0 ? (
                <DropdownMenuItem onClick={onAddConnection} className="text-zinc-400 cursor-pointer">
                  <Plus className="w-4 h-4 mr-2" /> Add Connection
                </DropdownMenuItem>
              ) : (
                <>
                  {connections.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      onClick={() => onSelectConnection(c)}
                      className={cn(
                        "cursor-pointer",
                        activeConnection?.id === c.id && "bg-blue-600/20 text-blue-400"
                      )}
                    >
                      <Database className="w-4 h-4 mr-2" />
                      <span className="truncate">{c.name}</span>
                      {activeConnection?.id === c.id && (
                        <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500" />
                      )}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem
                    onClick={onAddConnection}
                    className="text-zinc-500 cursor-pointer border-t border-white/5 mt-1"
                  >
                    <Plus className="w-4 h-4 mr-2" /> Add New
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {activeConnection && (
            <span className="text-xs text-emerald-500 font-medium px-1.5 py-0.5 rounded bg-emerald-500/10">
              Online
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-zinc-500 hover:text-purple-400"
            onClick={() => router.push('/monitoring')}
          >
            <Gauge className="w-4 h-4" />
          </Button>
          {connectionPulse && (
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5" title={`Connection: ${connectionPulse}`}>
              <div className={cn(
                "w-1.5 h-1.5 rounded-full",
                connectionPulse === 'healthy' && "bg-emerald-500 animate-pulse",
                connectionPulse === 'degraded' && "bg-amber-500",
                connectionPulse === 'error' && "bg-red-500",
              )} />
            </div>
          )}
          {user && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                  <User className="w-4 h-4 text-zinc-400" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-[#0d0d0d] border-white/10">
                {isAdmin && (
                  <DropdownMenuItem onClick={() => router.push('/admin')} className="cursor-pointer">
                    <Settings className="w-4 h-4 mr-2" /> Admin Dashboard
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => router.push('/monitoring')} className="cursor-pointer">
                  <Gauge className="w-4 h-4 mr-2" /> Monitoring
                </DropdownMenuItem>
                <div className="border-t border-white/5 my-1" />
                <DropdownMenuItem onClick={onLogout} className="text-red-400 cursor-pointer">
                  <LogOut className="w-4 h-4 mr-2" /> Logout
                </DropdownMenuItem>
                <div className="border-t border-white/5 mt-1 pt-1 px-2 pb-1">
                  <span className="text-xs text-zinc-500 font-mono">v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Row 2: Actions + RUN (only show when on editor tab) */}
      {activeMobileTab === 'editor' && (
        <div className="h-10 flex items-center justify-between px-3 border-t border-white/5 bg-[#080808]">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 gap-1 text-xs font-bold text-zinc-500 hover:text-blue-400"
              onClick={() => queryEditorRef.current?.toggleAi()}
            >
              <Sparkles className="w-3.5 h-3.5" />
              AI
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs text-zinc-500">
                  <MoreVertical className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="bg-[#0d0d0d] border-white/10 w-48">
                <DropdownMenuItem
                  onClick={() => queryEditorRef.current?.format()}
                  className="cursor-pointer text-xs"
                >
                  <AlignLeft className="w-4 h-4 mr-2" /> Format SQL
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    const query = queryEditorRef.current?.getValue() || currentQuery;
                    navigator.clipboard.writeText(query);
                  }}
                  className="cursor-pointer text-xs"
                >
                  <Copy className="w-4 h-4 mr-2" /> Copy Query
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={onClearQuery}
                  className="cursor-pointer text-xs text-red-400"
                >
                  <Trash2 className="w-4 h-4 mr-2" /> Clear
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={onSaveQuery}
                  className="cursor-pointer text-xs"
                >
                  <Save className="w-4 h-4 mr-2" /> Save Query
                </DropdownMenuItem>

                {onExplain && (
                  <>
                    <DropdownMenuSeparator className="bg-white/5" />
                    <DropdownMenuItem
                      onClick={onExplain}
                      className="cursor-pointer text-xs text-amber-400"
                    >
                      <Zap className="w-4 h-4 mr-2" /> Explain Plan
                    </DropdownMenuItem>
                  </>
                )}

                <DropdownMenuSeparator className="bg-white/5" />
                <div className="px-2 py-1">
                  <span className="text-label font-bold text-zinc-600 uppercase tracking-widest">Advanced</span>
                </div>

                {!transactionActive ? (
                  <DropdownMenuItem
                    onClick={onBeginTransaction}
                    className="cursor-pointer text-xs"
                    disabled={!activeConnection}
                  >
                    <PlayCircle className="w-4 h-4 mr-2" /> BEGIN Transaction
                  </DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem
                      onClick={onCommitTransaction}
                      className="cursor-pointer text-xs text-emerald-400"
                    >
                      <PlayCircle className="w-4 h-4 mr-2" /> COMMIT
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={onRollbackTransaction}
                      className="cursor-pointer text-xs text-red-400"
                    >
                      <PlayCircle className="w-4 h-4 mr-2" /> ROLLBACK
                    </DropdownMenuItem>
                  </>
                )}

                <DropdownMenuItem
                  onClick={onTogglePlayground}
                  className="cursor-pointer text-xs"
                >
                  <Pencil className="w-4 h-4 mr-2" />
                  {playgroundMode ? 'Disable Sandbox' : 'Enable Sandbox'}
                </DropdownMenuItem>

                <DropdownMenuItem
                  onClick={onToggleEditing}
                  className="cursor-pointer text-xs"
                >
                  <Edit3 className="w-4 h-4 mr-2" />
                  {editingEnabled ? 'Disable Editing' : 'Enable Editing'}
                </DropdownMenuItem>

                <DropdownMenuItem
                  onClick={onImport}
                  className="cursor-pointer text-xs"
                  disabled={!activeConnection}
                >
                  <Upload className="w-4 h-4 mr-2" /> Import Data
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Status badges */}
            {transactionActive && (
              <span className="text-label font-black text-amber-400 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                TXN
              </span>
            )}
            {playgroundMode && (
              <span className="text-label font-black text-purple-400 px-1.5 py-0.5 rounded bg-purple-500/10 border border-purple-500/20">
                SANDBOX
              </span>
            )}
          </div>

          {isExecuting ? (
            <Button
              size="sm"
              className="bg-red-600 hover:bg-red-500 text-white font-bold text-body h-7 px-4 gap-1.5"
              onClick={onCancelQuery}
            >
              <Square className="w-3 h-3 fill-current" />
              CANCEL
            </Button>
          ) : (
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-500 text-white font-bold text-body h-7 px-4 gap-1.5"
              onClick={onExecuteQuery}
              disabled={!activeConnection}
            >
              <Play className="w-3 h-3 fill-current" />
              RUN
            </Button>
          )}
        </div>
      )}
    </header>
  );
}
