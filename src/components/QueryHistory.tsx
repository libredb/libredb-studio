"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { storage } from '@/lib/storage';
import { QueryHistoryItem } from '@/lib/types';
import { 
  CheckCircle2, AlertCircle, 
  RotateCcw, Trash2, Search, Download,
  ArrowUpDown, Hash,
  Database, History as HistoryIcon, X
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface QueryHistoryProps {
  onSelectQuery: (query: string) => void;
  activeConnectionId?: string;
  refreshTrigger?: number;
}

type SortField = 'executedAt' | 'executionTime' | 'rowCount';
type SortOrder = 'asc' | 'desc';

export function QueryHistory({ onSelectQuery, activeConnectionId, refreshTrigger }: QueryHistoryProps) {
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'success' | 'error'>('all');
  const [isGlobal, setIsGlobal] = useState(false);
  const [sortField, setSortField] = useState<SortField>('executedAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // Refresh history when refreshTrigger changes (replaces key-based re-mount)
  useEffect(() => {
    setHistory(storage.getHistory());
  }, [refreshTrigger]);

  const filteredHistory = useMemo(() => {
    return history.filter(item => {
      const matchesSearch = item.query.toLowerCase().includes(search.toLowerCase()) || 
                           item.connectionName?.toLowerCase().includes(search.toLowerCase()) ||
                           item.tabName?.toLowerCase().includes(search.toLowerCase());
      const matchesStatus = filterStatus === 'all' || item.status === filterStatus;
      const matchesConnection = isGlobal || !activeConnectionId || item.connectionId === activeConnectionId;
      return matchesSearch && matchesStatus && matchesConnection;
    }).sort((a, b) => {
      let valA: number = 0;
      let valB: number = 0;
      
      if (sortField === 'executedAt') {
        valA = a.executedAt ? new Date(a.executedAt).getTime() : 0;
        valB = b.executedAt ? new Date(b.executedAt).getTime() : 0;
      } else {
        valA = (a[sortField] as number) || 0;
        valB = (b[sortField] as number) || 0;
      }

      if (sortOrder === 'asc') return valA > valB ? 1 : -1;
      return valA < valB ? 1 : -1;
    });
  }, [history, search, filterStatus, isGlobal, activeConnectionId, sortField, sortOrder]);

  const handleClearHistory = () => {
    if (confirm('Are you sure you want to clear all history?')) {
      storage.clearHistory();
      setHistory([]);
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  const exportHistory = (format: 'csv' | 'json') => {
    let content = '';
    let mimeType = '';
    const fileName = `query_history_${new Date().getTime()}.${format}`;

    if (format === 'csv') {
      const headers = ['Executed At', 'Status', 'Connection', 'Tab', 'Execution Time (ms)', 'Rows', 'Query', 'Error'];
      const rows = filteredHistory.map(item => [
        item.executedAt,
        item.status,
        item.connectionName || item.connectionId,
        item.tabName || '',
        item.executionTime,
        item.rowCount || 0,
        `"${item.query.replace(/"/g, '""')}"`,
        `"${(item.errorMessage || '').replace(/"/g, '""')}"`
      ].join(','));
      content = [headers.join(','), ...rows].join('\n');
      mimeType = 'text/csv';
    } else {
      content = JSON.stringify(filteredHistory, null, 2);
      mimeType = 'application/json';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col bg-[#080808]">
      <div className="p-4 border-b border-white/5 bg-[#0a0a0a]/50 backdrop-blur-sm sticky top-0 z-10 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <HistoryIcon className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-100 uppercase tracking-widest flex items-center gap-2">
                Query History
              </h3>
              <p className="text-[10px] text-zinc-500 font-medium">
                Showing {filteredHistory.length} executions
              </p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 text-[10px] font-bold uppercase tracking-widest text-zinc-400 hover:text-white gap-2">
                  <Download className="w-3.5 h-3.5" /> Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-[#0d0d0d] border-white/10 text-zinc-300">
                <DropdownMenuItem onClick={() => exportHistory('csv')} className="text-xs cursor-pointer">
                  Export as CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportHistory('json')} className="text-xs cursor-pointer">
                  Export as JSON
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button 
              variant="ghost" 
              size="sm" 
              onClick={handleClearHistory} 
              className="h-8 text-[10px] font-bold uppercase tracking-widest text-red-400/70 hover:text-red-400 hover:bg-red-400/10"
            >
              <Trash2 className="w-3.5 h-3.5 mr-2" /> Clear
            </Button>
          </div>
        </div>
        
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
            <Input 
              placeholder="Search by query, connection or tab..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9 bg-white/5 border-white/10 text-xs focus:ring-emerald-500/20 rounded-lg"
            />
            {search && (
              <button 
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          
          <div className="flex items-center gap-2 bg-white/5 rounded-lg p-1 border border-white/10">
            <button
              onClick={() => setIsGlobal(false)}
              className={cn(
                "px-3 py-1.5 text-[10px] font-bold uppercase rounded-md transition-all",
                !isGlobal ? "bg-emerald-600 text-white shadow-lg shadow-emerald-600/20" : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              Active Conn
            </button>
            <button
              onClick={() => setIsGlobal(true)}
              className={cn(
                "px-3 py-1.5 text-[10px] font-bold uppercase rounded-md transition-all",
                isGlobal ? "bg-emerald-600 text-white shadow-lg shadow-emerald-600/20" : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              All Connections
            </button>
          </div>

          <div className="flex bg-white/5 rounded-lg p-1 border border-white/10">
            {(['all', 'success', 'error'] as const).map((status) => (
              <button
                key={status}
                onClick={() => setFilterStatus(status)}
                className={cn(
                  "px-3 py-1.5 text-[10px] font-bold uppercase rounded-md transition-all",
                  filterStatus === status ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                {status}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar">
        {filteredHistory.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center opacity-20 p-8 text-center">
            <HistoryIcon className="w-16 h-16 mb-4 text-zinc-600" />
            <p className="text-sm font-medium">No history items found</p>
            <p className="text-xs text-zinc-500 mt-1 uppercase tracking-widest">Run some queries to see them here</p>
          </div>
        ) : (
          <div className="min-w-[800px]">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-white/[0.02] border-b border-white/5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  <th className="px-4 py-3 w-10 text-center">Status</th>
                  <th className="px-4 py-3 cursor-pointer hover:text-zinc-300 transition-colors group" onClick={() => handleSort('executedAt')}>
                    <div className="flex items-center gap-2">
                      Executed At
                      <ArrowUpDown className={cn("w-3 h-3 transition-opacity", sortField === 'executedAt' ? "opacity-100 text-emerald-500" : "opacity-0 group-hover:opacity-100")} />
                    </div>
                  </th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">SQL Query</th>
                  <th className="px-4 py-3 cursor-pointer hover:text-zinc-300 transition-colors group" onClick={() => handleSort('executionTime')}>
                    <div className="flex items-center gap-2">
                      Duration
                      <ArrowUpDown className={cn("w-3 h-3 transition-opacity", sortField === 'executionTime' ? "opacity-100 text-emerald-500" : "opacity-0 group-hover:opacity-100")} />
                    </div>
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:text-zinc-300 transition-colors group" onClick={() => handleSort('rowCount')}>
                    <div className="flex items-center gap-2">
                      Rows
                      <ArrowUpDown className={cn("w-3 h-3 transition-opacity", sortField === 'rowCount' ? "opacity-100 text-emerald-500" : "opacity-0 group-hover:opacity-100")} />
                    </div>
                  </th>
                  <th className="px-4 py-3 w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredHistory.map((item) => (
                  <tr 
                    key={item.id}
                    className="hover:bg-white/[0.03] transition-colors group text-xs border-b border-white/5"
                  >
                    <td className="px-4 py-4 text-center">
                      <div className="flex justify-center">
                        {item.status === 'success' ? (
                          <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                          </div>
                        ) : (
                          <div className="w-5 h-5 rounded-full bg-red-500/10 flex items-center justify-center border border-red-500/20">
                            <AlertCircle className="w-3 h-3 text-red-500" />
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <div className="flex flex-col">
                        <span className="text-zinc-200 font-medium">
                          {item.executedAt ? format(new Date(item.executedAt), 'MMM d, HH:mm:ss') : '-'}
                        </span>
                        <span className="text-[10px] text-zinc-500 font-mono mt-0.5">
                          {item.executedAt ? format(new Date(item.executedAt), 'yyyy') : ''}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5 text-zinc-300">
                          <Database className="w-3 h-3 text-blue-400" />
                          <span className="font-semibold">{item.connectionName || 'Unknown'}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-zinc-500 text-[10px]">
                          <Hash className="w-2.5 h-2.5" />
                          <span>{item.tabName || 'Default Tab'}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4 max-w-md">
                      <div className="bg-[#050505] border border-white/5 rounded-md p-2 relative group-hover:border-white/10 transition-colors">
                        <pre className="text-[11px] font-mono text-zinc-400 line-clamp-2 break-all whitespace-pre-wrap leading-relaxed">
                          {item.query}
                        </pre>
                        {item.errorMessage && (
                          <div className="mt-2 pt-2 border-t border-red-500/10 text-[10px] text-red-400/80 font-mono italic">
                            {item.errorMessage}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <span className={cn(
                        "px-2 py-0.5 rounded text-[10px] font-mono font-bold",
                        item.executionTime > 500 ? "text-amber-400 bg-amber-400/10" : "text-zinc-400 bg-white/5"
                      )}>
                        {item.executionTime}ms
                      </span>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <span className="text-zinc-400 font-mono text-xs">
                        {item.rowCount != null ? item.rowCount.toLocaleString() : '-'}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-8 w-8 p-0 hover:bg-emerald-500/10 hover:text-emerald-400"
                        onClick={() => onSelectQuery(item.query)}
                        title="Restore Query"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
