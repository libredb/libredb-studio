"use client";

import React, { useEffect, useState, useMemo } from 'react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from '@/components/ui/command';
import {
  Table2,
  Play,
  Plus,
  Clock,
  Bookmark,
  Activity,
  Gauge,
  Layers,
  LogOut,
  Sparkles,
  AlignLeft,
  Save,
} from 'lucide-react';
import { DatabaseConnection, TableSchema, SavedQuery, QueryHistoryItem } from '@/lib/types';
import { storage } from '@/lib/storage';
import { getDBIcon } from '@/lib/db-ui-config';

interface CommandPaletteProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  schema: TableSchema[];
  onSelectConnection: (conn: DatabaseConnection) => void;
  onTableClick: (tableName: string) => void;
  onAddConnection: () => void;
  onExecuteQuery: () => void;
  onLoadSavedQuery: (query: string) => void;
  onLoadHistoryQuery: (query: string) => void;
  onNavigateHealth: () => void;
  onNavigateMonitoring: () => void;
  onShowDiagram: () => void;
  onFormatQuery: () => void;
  onSaveQuery: () => void;
  onToggleAI: () => void;
  onLogout: () => void;
}

export function CommandPalette({
  connections,
  activeConnection,
  schema,
  onSelectConnection,
  onTableClick,
  onAddConnection,
  onExecuteQuery,
  onLoadSavedQuery,
  onLoadHistoryQuery,
  onNavigateHealth,
  onNavigateMonitoring,
  onShowDiagram,
  onFormatQuery,
  onSaveQuery,
  onToggleAI,
  onLogout,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);

  // Register Cmd+K / Ctrl+K keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Load saved queries and history
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const savedQueries = useMemo(() => storage.getSavedQueries().slice(0, 10), [open]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const historyItems = useMemo(() => storage.getHistory().slice(0, 10), [open]);

  const runAction = (action: () => void) => {
    setOpen(false);
    // Small delay to let dialog close before action
    setTimeout(action, 100);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      className="sm:max-w-[560px] bg-[#0a0a0a] border-white/10"
      showCloseButton={false}
    >
      <CommandInput
        placeholder="Search tables, connections, queries, actions..."
        className="text-zinc-200"
      />
      <CommandList className="max-h-[400px]">
        <CommandEmpty className="text-zinc-500">No results found.</CommandEmpty>

        {/* Quick Actions */}
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => runAction(onExecuteQuery)}>
            <Play className="w-4 h-4 text-blue-400" />
            <span>Run Query</span>
            <CommandShortcut>Ctrl+Enter</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAction(onFormatQuery)}>
            <AlignLeft className="w-4 h-4 text-zinc-400" />
            <span>Format Query</span>
          </CommandItem>
          <CommandItem onSelect={() => runAction(onSaveQuery)}>
            <Save className="w-4 h-4 text-zinc-400" />
            <span>Save Current Query</span>
          </CommandItem>
          <CommandItem onSelect={() => runAction(onToggleAI)}>
            <Sparkles className="w-4 h-4 text-purple-400" />
            <span>AI Assistant</span>
          </CommandItem>
          <CommandItem onSelect={() => runAction(onAddConnection)}>
            <Plus className="w-4 h-4 text-emerald-400" />
            <span>New Connection</span>
          </CommandItem>
          <CommandItem onSelect={() => runAction(onNavigateHealth)}>
            <Activity className="w-4 h-4 text-emerald-400" />
            <span>Health Dashboard</span>
          </CommandItem>
          <CommandItem onSelect={() => runAction(onNavigateMonitoring)}>
            <Gauge className="w-4 h-4 text-purple-400" />
            <span>Monitoring</span>
          </CommandItem>
          {activeConnection && (
            <CommandItem onSelect={() => runAction(onShowDiagram)}>
              <Layers className="w-4 h-4 text-cyan-400" />
              <span>Schema Diagram (ERD)</span>
            </CommandItem>
          )}
          <CommandItem onSelect={() => runAction(onLogout)}>
            <LogOut className="w-4 h-4 text-red-400" />
            <span>Logout</span>
          </CommandItem>
        </CommandGroup>

        {/* Connections */}
        {connections.length > 0 && (
          <CommandGroup heading="Connections">
            {connections.map((conn) => {
              const Icon = getDBIcon(conn.type);
              return (
                <CommandItem
                  key={conn.id}
                  onSelect={() => runAction(() => onSelectConnection(conn))}
                >
                  <Icon className="w-4 h-4" />
                  <span>{conn.name}</span>
                  {activeConnection?.id === conn.id && (
                    <span className="ml-auto text-xs text-emerald-500 font-medium">Active</span>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {/* Tables */}
        {schema.length > 0 && (
          <CommandGroup heading="Tables">
            {schema.map((table) => (
              <CommandItem
                key={table.name}
                onSelect={() => runAction(() => onTableClick(table.name))}
              >
                <Table2 className="w-4 h-4 text-zinc-500" />
                <span>{table.name}</span>
                <span className="ml-auto text-xs text-zinc-600">
                  {table.columns.length} cols
                  {table.rowCount !== undefined && ` / ${table.rowCount} rows`}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Saved Queries */}
        {savedQueries.length > 0 && (
          <CommandGroup heading="Saved Queries">
            {savedQueries.map((sq: SavedQuery) => (
              <CommandItem
                key={sq.id}
                onSelect={() => runAction(() => onLoadSavedQuery(sq.query))}
              >
                <Bookmark className="w-4 h-4 text-purple-400" />
                <span>{sq.name}</span>
                <span className="ml-auto text-xs text-zinc-600 truncate max-w-[150px]">
                  {sq.query.substring(0, 40)}...
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Recent Queries */}
        {historyItems.length > 0 && (
          <CommandGroup heading="Recent Queries">
            {historyItems.map((item: QueryHistoryItem) => (
              <CommandItem
                key={item.id}
                onSelect={() => runAction(() => onLoadHistoryQuery(item.query))}
              >
                <Clock className="w-4 h-4 text-zinc-500" />
                <span className="truncate max-w-[350px] text-zinc-400">{item.query.substring(0, 60)}</span>
                <span className="ml-auto text-xs text-zinc-600">{item.executionTime}ms</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
