"use client";

import React, { useState, useMemo } from 'react';
import { TableSchema, ColumnSchema } from '@/lib/types';
import { 
  Search, 
  Table as TableIcon, 
  Hash, 
  Key, 
  Copy, 
  Play, 
  ChevronRight, 
  Loader2, 
  AlertCircle,
  Database,
  Filter,
  MoreVertical,
  Type,
  Plus,
  Settings,
  Trash2,
  Zap
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator
} from "@/components/ui/dropdown-menu";
import { toast } from 'sonner';

interface SchemaExplorerProps {
  schema: TableSchema[];
  isLoadingSchema: boolean;
  onTableClick?: (tableName: string) => void;
  onGenerateSelect?: (tableName: string) => void;
  onCreateTableClick?: () => void;
  isAdmin?: boolean;
  onOpenMaintenance?: (tab?: 'global' | 'tables' | 'sessions', table?: string) => void;
}

export function SchemaExplorer({ 
  schema, 
  isLoadingSchema, 
  onTableClick,
  onGenerateSelect,
  onCreateTableClick,
  isAdmin = false,
  onOpenMaintenance
}: SchemaExplorerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());

  const toggleTable = (tableName: string) => {
    const next = new Set(expandedTables);
    if (next.has(tableName)) {
      next.delete(tableName);
    } else {
      next.add(tableName);
    }
    setExpandedTables(next);
  };

  const filteredSchema = useMemo(() => {
    if (!searchQuery) return schema;
    const query = searchQuery.toLowerCase();
    
    return schema.filter(table => {
      const tableNameMatch = table.name.toLowerCase().includes(query);
      const columnMatch = table.columns.some(col => col.name.toLowerCase().includes(query));
      return tableNameMatch || columnMatch;
    });
  }, [schema, searchQuery]);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  if (isLoadingSchema) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <div className="relative mb-4">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500/20" />
          <Database className="w-4 h-4 absolute inset-0 m-auto text-blue-500 animate-pulse" />
        </div>
        <span className="text-[10px] uppercase tracking-[0.2em] font-bold animate-pulse">Scanning Schema...</span>
      </div>
    );
  }

  if (schema.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4 border border-border">
          <AlertCircle className="w-6 h-6 text-muted-foreground" />
        </div>
        <h3 className="text-foreground text-sm font-medium mb-1">No structures found</h3>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          We couldn't find any tables or views in this connection.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 mb-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="w-3.5 h-3.5 text-blue-500/50" />
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
              Explorer
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {isAdmin && (
              <Button
                variant="ghost"
                size="icon"
                className="w-6 h-6 hover:bg-accent text-muted-foreground hover:text-amber-400 transition-colors"
                onClick={() => onOpenMaintenance?.('global')}
                title="Database Maintenance"
              >
                <Settings className="w-3.5 h-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 hover:bg-accent text-muted-foreground hover:text-blue-400 transition-colors"
              onClick={onCreateTableClick}
              title="Create Table"
            >
              <Plus className="w-3.5 h-3.5" />
            </Button>
            <span className="text-[9px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded-full font-mono border border-blue-500/10">
              {schema.length}
            </span>
          </div>
        </div>

        <div className="relative group">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground group-focus-within:text-blue-500 transition-colors" />
          <Input
            placeholder="Search tables or columns..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 pr-8 text-[12px] bg-muted/50 border-border focus-visible:ring-1 focus-visible:ring-blue-500/50 placeholder:text-muted-foreground/50"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <Hash className="w-3 h-3 rotate-45" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 space-y-1 custom-scrollbar">
        <AnimatePresence mode="popLayout">
          {filteredSchema.map((table) => (
            <div key={table.name} className="group flex flex-col">
              <div
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-all",
                  expandedTables.has(table.name) ? "bg-accent/50" : "hover:bg-accent/30"
                )}
              >
                <motion.div
                  animate={{ rotate: expandedTables.has(table.name) ? 90 : 0 }}
                  transition={{ duration: 0.2 }}
                  className="shrink-0"
                  onClick={() => toggleTable(table.name)}
                >
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                </motion.div>

                <TableIcon
                  className={cn(
                    "w-3.5 h-3.5 shrink-0 transition-colors",
                    expandedTables.has(table.name) ? "text-blue-400" : "text-muted-foreground group-hover:text-foreground"
                  )}
                  onClick={() => toggleTable(table.name)}
                />

                <span
                  className={cn(
                    "truncate min-w-0 flex-1 text-[13px] font-medium transition-colors",
                    expandedTables.has(table.name) ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
                  )}
                  onClick={() => toggleTable(table.name)}
                >
                  {table.name}
                </span>

                {table.rowCount !== undefined && (
                  <span
                    className="shrink-0 text-[9px] font-mono text-muted-foreground/70 whitespace-nowrap"
                    onClick={() => toggleTable(table.name)}
                  >
                    {table.rowCount >= 1000 ? `${(table.rowCount / 1000).toFixed(1)}k` : table.rowCount}
                  </span>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <div
                      className="shrink-0 p-1 rounded hover:bg-white/20 cursor-pointer"
                      onClick={e => e.stopPropagation()}
                    >
                      <MoreVertical className="w-4 h-4 text-white" />
                    </div>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onClick={() => onTableClick?.(table.name)}>
                      <Play className="w-3.5 h-3.5 mr-2 text-green-500" />
                      Select Top 100
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onGenerateSelect?.(table.name)}>
                      <Filter className="w-3.5 h-3.5 mr-2 text-blue-500" />
                      Generate Query
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => copyToClipboard(table.name, 'Table name')}>
                      <Copy className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                      Copy Name
                    </DropdownMenuItem>
                    {isAdmin && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => onOpenMaintenance?.('tables', table.name)}>
                          <Search className="w-3.5 h-3.5 mr-2 text-amber-500" />
                          Analyze Table
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onOpenMaintenance?.('tables', table.name)}>
                          <Trash2 className="w-3.5 h-3.5 mr-2 text-blue-400" />
                          Vacuum Table
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <AnimatePresence>
                {expandedTables.has(table.name) && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="pl-6 pr-2 py-1 space-y-0.5 border-l border-border/30 ml-3.5 mt-0.5 mb-1">
                      {table.columns.map((column) => (
                        <div
                          key={column.name}
                          className="flex items-center gap-2 py-1 px-2 rounded-sm group/col hover:bg-accent/20 cursor-default"
                        >
                          {column.isPrimary ? (
                            <Key className="w-2.5 h-2.5 text-yellow-500/70" />
                          ) : (
                            <div className="w-2.5 h-2.5 flex items-center justify-center">
                              <div className="w-1 h-1 rounded-full bg-muted-foreground/50" />
                            </div>
                          )}

                          <span className="text-[12px] text-muted-foreground flex-1 truncate group-hover/col:text-foreground">
                            {column.name}
                          </span>

                          <span className="text-[10px] font-mono text-muted-foreground/60 uppercase group-hover/col:text-muted-foreground">
                            {column.type.split('(')[0]}
                          </span>
                        </div>
                      ))}
                      {table.indexes.length > 0 && (
                        <div className="pt-2 pb-1">
                          <div className="flex items-center gap-1.5 px-2 mb-1">
                            <Hash className="w-2.5 h-2.5 text-purple-500/40" />
                            <span className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground">Indexes</span>
                          </div>
                          {table.indexes.map(idx => (
                            <div key={idx.name} className="flex items-center gap-2 py-0.5 px-2">
                              <div className="w-2.5 h-2.5" />
                              <span className="text-[10px] text-muted-foreground italic truncate" title={Array.isArray(idx.columns) ? idx.columns.join(', ') : ''}>
                                {idx.name}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
