"use client";

import React, { type RefObject } from "react";
import type { DatabaseConnection } from "@/lib/types";
import type { QueryEditorRef } from "@/components/QueryEditor";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  AlignLeft,
  Bot,
  ChevronDown,
  Copy,
  Database,
  Edit3,
  Gauge,
  LogOut,
  MoreVertical,
  Pencil,
  Play,
  PlayCircle,
  Plus,
  Save,
  Settings,
  Square,
  Trash2,
  Upload,
  User,
  Zap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { GitHubRepoLink } from "@/components/github-repo-link";

interface StudioMobileHeaderProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  connectionPulse: "healthy" | "degraded" | "error" | null;
  user: { role?: string } | null;
  isAdmin: boolean;
  activeMobileTab: "database" | "schema" | "editor";
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
  /** Omitted where the provider declares no inline row editing (issue #269). */
  onToggleEditing?: () => void;
  onImport: () => void;
  onExplain?: () => void;
  /**
   * Asks the agent about what the editor is holding (#331 T3). It replaced a button
   * that toggled the in-editor AI chat through `queryEditorRef`; the chat is gone,
   * and WHAT to ask about is the shell's decision rather than this header's.
   *
   * Omitted while the agent runtime is off — the same rule `onToggleEditing` above
   * follows, and the control is then not rendered at all.
   */
  onAskAgent?: () => void;
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
  onAskAgent,
}: StudioMobileHeaderProps) {
  const router = useRouter();

  return (
    <header className="md:hidden border-b border-hairline bg-surface/95 backdrop-blur-xl sticky top-0 z-30">
      {/* Row 1: DB Selector + Connection Info + User */}
      <div className="h-12 flex items-center justify-between px-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2 gap-1 bg-overlay border-hairline-strong hover:bg-fill text-fg-secondary max-w-[160px]"
              >
                <Database strokeWidth={1.5} className="w-3 h-3 text-blue-400 shrink-0" />
                <span className="truncate text-xs font-medium">
                  {activeConnection ? activeConnection.name : "Select DB"}
                </span>
                <ChevronDown strokeWidth={1.5} className="w-3 h-3 text-fg-muted shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 bg-raised border-hairline-strong">
              {connections.length === 0 ? (
                <DropdownMenuItem onClick={onAddConnection} className="text-fg-tertiary cursor-pointer">
                  <Plus strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Add Connection
                </DropdownMenuItem>
              ) : (
                <>
                  {connections.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      onClick={() => onSelectConnection(c)}
                      className={cn("cursor-pointer", activeConnection?.id === c.id && "bg-blue-600/20 text-blue-400")}
                    >
                      <Database strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" />
                      <span className="truncate">{c.name}</span>
                      {activeConnection?.id === c.id && (
                        <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500" />
                      )}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem
                    onClick={onAddConnection}
                    className="text-fg-muted cursor-pointer border-t border-hairline mt-1"
                  >
                    <Plus strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Add New
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {activeConnection && (
            <span className="text-xs text-emerald-500 font-medium px-1.5 py-0.5 rounded bg-emerald-500/10">Online</span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-fg-muted hover:text-purple-400"
            onClick={() => router.push("/monitoring")}
          >
            <Gauge strokeWidth={1.5} className="w-3.5 h-3.5" />
          </Button>
          {/* Sized as the icon buttons beside it (h-8 w-8), not as the desktop's inline icon. */}
          <GitHubRepoLink className="h-8 w-8 shrink-0 text-fg-tertiary hover:text-fg-bright" />
          {connectionPulse && (
            <div
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-fill"
              title={`Connection: ${connectionPulse}`}
            >
              <div
                className={cn(
                  "w-1.5 h-1.5 rounded-full",
                  connectionPulse === "healthy" && "bg-emerald-500 animate-pulse",
                  connectionPulse === "degraded" && "bg-amber-500",
                  connectionPulse === "error" && "bg-red-500",
                )}
              />
            </div>
          )}
          {user && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                  <User strokeWidth={1.5} className="w-3.5 h-3.5 text-fg-tertiary" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-raised border-hairline-strong">
                {isAdmin && (
                  <DropdownMenuItem onClick={() => router.push("/admin")} className="cursor-pointer">
                    <Settings strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Admin Dashboard
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => router.push("/monitoring")} className="cursor-pointer">
                  <Gauge strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Monitoring
                </DropdownMenuItem>
                <div className="border-t border-hairline my-1" />
                <DropdownMenuItem onClick={onLogout} className="text-red-400 cursor-pointer">
                  <LogOut strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Logout
                </DropdownMenuItem>
                <div className="border-t border-hairline mt-1 pt-1 px-2 pb-1">
                  <span className="text-xs text-fg-muted font-mono">v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Row 2: Actions + RUN (only show when on editor tab) */}
      {activeMobileTab === "editor" && (
        <div className="h-10 flex items-center justify-between px-3 border-t border-hairline bg-sunken">
          <div className="flex items-center gap-1 min-w-0">
            {/*
              Says what it DOES, not what it opens (review of #331 T3). Labelling it
              "Agent" put a second control with that name and that icon on the editor
              tab, beside `MobileNav`'s — which opens the rail and asks nothing — and
              the two were told apart by nothing a user can see. This one carries the
              editor's statement in with it, so it names the statement.

              `shrink` overrides the Button base's `shrink-0` so the longer label
              gives way to RUN instead of pushing it off a narrow screen; the label
              then truncates, which needs `min-w-0` on both the row and the span.
            */}
            {onAskAgent && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 gap-1 text-xs font-medium text-fg-muted hover:text-blue-400 shrink min-w-0"
                onClick={onAskAgent}
              >
                <Bot strokeWidth={1.5} className="w-3 h-3" />
                <span className="truncate min-w-0">Ask about this query</span>
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs text-fg-muted">
                  <MoreVertical strokeWidth={1.5} className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="bg-raised border-hairline-strong w-48">
                <DropdownMenuItem onClick={() => queryEditorRef.current?.format()} className="cursor-pointer text-xs">
                  <AlignLeft strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Format SQL
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    const query = queryEditorRef.current?.getValue() || currentQuery;
                    navigator.clipboard.writeText(query);
                  }}
                  className="cursor-pointer text-xs"
                >
                  <Copy strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Copy Query
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onClearQuery} className="cursor-pointer text-xs text-red-400">
                  <Trash2 strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Clear
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onSaveQuery} className="cursor-pointer text-xs">
                  <Save strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Save Query
                </DropdownMenuItem>

                {onExplain && (
                  <>
                    <DropdownMenuSeparator className="bg-fill" />
                    <DropdownMenuItem onClick={onExplain} className="cursor-pointer text-xs text-amber-400">
                      <Zap strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Explain Plan
                    </DropdownMenuItem>
                  </>
                )}

                <DropdownMenuSeparator className="bg-fill" />
                <div className="px-2 py-1">
                  <span className="text-[0.625rem] font-medium text-fg-subtle">Advanced</span>
                </div>

                {!transactionActive ? (
                  <DropdownMenuItem
                    onClick={onBeginTransaction}
                    className="cursor-pointer text-xs"
                    disabled={!activeConnection}
                  >
                    <PlayCircle strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> BEGIN Transaction
                  </DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem onClick={onCommitTransaction} className="cursor-pointer text-xs text-emerald-400">
                      <PlayCircle strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> COMMIT
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onRollbackTransaction} className="cursor-pointer text-xs text-red-400">
                      <PlayCircle strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> ROLLBACK
                    </DropdownMenuItem>
                  </>
                )}

                <DropdownMenuItem onClick={onTogglePlayground} className="cursor-pointer text-xs">
                  <Pencil strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" />
                  {playgroundMode ? "Disable Sandbox" : "Enable Sandbox"}
                </DropdownMenuItem>

                {onToggleEditing && (
                  <DropdownMenuItem onClick={onToggleEditing} className="cursor-pointer text-xs">
                    <Edit3 strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" />
                    {editingEnabled ? "Disable Editing" : "Enable Editing"}
                  </DropdownMenuItem>
                )}

                <DropdownMenuItem onClick={onImport} className="cursor-pointer text-xs" disabled={!activeConnection}>
                  <Upload strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Import Data
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Status badges */}
            {transactionActive && (
              <span className="text-[0.625rem] font-medium text-amber-400 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                TXN
              </span>
            )}
            {playgroundMode && (
              <span className="text-[0.625rem] font-medium text-purple-400 px-1.5 py-0.5 rounded bg-purple-500/10 border border-purple-500/20">
                SANDBOX
              </span>
            )}
          </div>

          {isExecuting ? (
            <Button
              size="sm"
              className="bg-red-600 hover:bg-red-500 text-white font-medium text-xs h-7 px-4 gap-1.5"
              onClick={onCancelQuery}
            >
              <Square strokeWidth={1.5} className="w-3 h-3 fill-current" />
              CANCEL
            </Button>
          ) : (
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs h-7 px-4 gap-1.5"
              onClick={onExecuteQuery}
              disabled={!activeConnection}
            >
              <Play strokeWidth={1.5} className="w-3 h-3 fill-current" />
              RUN
            </Button>
          )}
        </div>
      )}
    </header>
  );
}
