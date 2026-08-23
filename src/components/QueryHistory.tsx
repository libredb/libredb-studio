"use client";

import React, { useState, useEffect, useMemo } from "react";
import { storage } from "@/lib/storage";
import { QueryHistoryItem } from "@/lib/types";
import { csvRow } from "@/lib/export/csv";
import { downloadText } from "@/lib/export/download";
import {
  CircleCheck,
  CircleAlert,
  RotateCcw,
  Trash2,
  Search,
  Download,
  ArrowUpDown,
  Hash,
  Database,
  RotateCcwClock as HistoryIcon,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
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

type SortField = "executedAt" | "executionTime" | "rowCount";
type SortOrder = "asc" | "desc";

export function QueryHistory({ onSelectQuery, activeConnectionId, refreshTrigger }: QueryHistoryProps) {
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "success" | "error">("all");
  const [isGlobal, setIsGlobal] = useState(false);
  const [sortField, setSortField] = useState<SortField>("executedAt");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  // Refresh history when refreshTrigger changes (replaces key-based re-mount)
  useEffect(() => {
    setHistory(storage.getHistory());
  }, [refreshTrigger]);

  const filteredHistory = useMemo(() => {
    return history
      .filter((item) => {
        const matchesSearch =
          item.query.toLowerCase().includes(search.toLowerCase()) ||
          item.connectionName?.toLowerCase().includes(search.toLowerCase()) ||
          item.tabName?.toLowerCase().includes(search.toLowerCase());
        const matchesStatus = filterStatus === "all" || item.status === filterStatus;
        const matchesConnection = isGlobal || !activeConnectionId || item.connectionId === activeConnectionId;
        return matchesSearch && matchesStatus && matchesConnection;
      })
      .sort((a, b) => {
        let valA: number = 0;
        let valB: number = 0;

        if (sortField === "executedAt") {
          valA = a.executedAt ? new Date(a.executedAt).getTime() : 0;
          valB = b.executedAt ? new Date(b.executedAt).getTime() : 0;
        } else {
          valA = (a[sortField] as number) || 0;
          valB = (b[sortField] as number) || 0;
        }

        if (sortOrder === "asc") return valA > valB ? 1 : -1;
        return valA < valB ? 1 : -1;
      });
  }, [history, search, filterStatus, isGlobal, activeConnectionId, sortField, sortOrder]);

  const handleClearHistory = () => {
    if (confirm("Are you sure you want to clear all history?")) {
      storage.clearHistory();
      setHistory([]);
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const exportHistory = (format: "csv" | "json") => {
    let content = "";
    let mimeType = "";
    const fileName = `query_history_${new Date().getTime()}.${format}`;

    if (format === "csv") {
      const headers = ["Executed At", "Status", "Connection", "Tab", "Execution Time (ms)", "Rows", "Query", "Error"];
      // Every field goes through the shared writer. The query and the error message
      // used to be the only two that were escaped, so a connection or tab name
      // holding a comma shifted every column after it for that row.
      const rows = filteredHistory.map((item) =>
        csvRow([
          item.executedAt,
          item.status,
          item.connectionName || item.connectionId,
          item.tabName || "",
          item.executionTime,
          item.rowCount || 0,
          item.query,
          item.errorMessage || "",
        ]),
      );
      content = [csvRow(headers), ...rows].join("\n");
      mimeType = "text/csv";
    } else {
      content = JSON.stringify(filteredHistory, null, 2);
      mimeType = "application/json";
    }

    downloadText(content, mimeType, fileName);
  };

  return (
    <div className="h-full flex flex-col bg-sunken">
      <div className="p-4 border-b border-hairline bg-surface/50 backdrop-blur-sm sticky top-0 z-10 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <HistoryIcon strokeWidth={1.5} className="w-3.5 h-3.5 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-xs font-medium text-fg flex items-center gap-2">Query History</h3>
              <p className="text-xs text-fg-muted font-medium">Showing {filteredHistory.length} executions</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs font-medium text-fg-tertiary hover:text-fg-bright gap-2"
                >
                  <Download strokeWidth={1.5} className="w-3 h-3" /> Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-raised border-hairline-strong text-fg-secondary">
                <DropdownMenuItem onClick={() => exportHistory("csv")} className="text-xs cursor-pointer">
                  <span>Export as CSV</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportHistory("json")} className="text-xs cursor-pointer">
                  <span>Export as JSON</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearHistory}
              className="h-8 text-xs font-medium text-red-400/70 hover:text-red-400 hover:bg-red-400/10"
            >
              <Trash2 strokeWidth={1.5} className="w-3 h-3 mr-2" /> Clear
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search strokeWidth={1.5} className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-fg-muted" />
            <Input
              placeholder="Search by query, connection or tab..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9 bg-fill border-hairline-strong text-xs focus:ring-emerald-500/20 rounded-lg"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg-bright"
              >
                <X strokeWidth={1.5} className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 bg-fill rounded-lg p-1 border border-hairline-strong">
            <button
              onClick={() => setIsGlobal(false)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                !isGlobal
                  ? "bg-emerald-600 text-white shadow-lg shadow-emerald-600/20"
                  : "text-fg-muted hover:text-fg-secondary",
              )}
            >
              <span>Active Conn</span>
            </button>
            <button
              onClick={() => setIsGlobal(true)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                isGlobal
                  ? "bg-emerald-600 text-white shadow-lg shadow-emerald-600/20"
                  : "text-fg-muted hover:text-fg-secondary",
              )}
            >
              <span>All Connections</span>
            </button>
          </div>

          <div className="flex bg-fill rounded-lg p-1 border border-hairline-strong">
            {(["all", "success", "error"] as const).map((status) => (
              <button
                key={status}
                onClick={() => setFilterStatus(status)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                  filterStatus === status ? "bg-fill-strong text-fg" : "text-fg-muted hover:text-fg-secondary",
                )}
              >
                {status}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar">
        {filteredHistory.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center opacity-20 p-8 text-center">
            <HistoryIcon strokeWidth={1.5} className="w-16 h-16 mb-4 text-fg-subtle" />
            <p className="text-xs font-medium">No history items found</p>
            <p className="text-xs text-fg-muted mt-1">Run some queries to see them here</p>
          </div>
        )}
        {filteredHistory.length > 0 && (
          <div className="min-w-[800px]">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-fill-subtle border-b border-hairline text-xs font-medium text-fg-muted">
                  <th className="px-4 py-3 w-10 text-center">Status</th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-fg-secondary transition-colors group"
                    onClick={() => handleSort("executedAt")}
                  >
                    <div className="flex items-center gap-2">
                      <span>Executed At</span>
                      <ArrowUpDown
                        className={cn(
                          "w-3 h-3 transition-opacity",
                          sortField === "executedAt"
                            ? "opacity-100 text-emerald-500"
                            : "opacity-0 group-hover:opacity-100",
                        )}
                      />
                    </div>
                  </th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">SQL Query</th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-fg-secondary transition-colors group"
                    onClick={() => handleSort("executionTime")}
                  >
                    <div className="flex items-center gap-2">
                      <span>Duration</span>
                      <ArrowUpDown
                        className={cn(
                          "w-3 h-3 transition-opacity",
                          sortField === "executionTime"
                            ? "opacity-100 text-emerald-500"
                            : "opacity-0 group-hover:opacity-100",
                        )}
                      />
                    </div>
                  </th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:text-fg-secondary transition-colors group"
                    onClick={() => handleSort("rowCount")}
                  >
                    <div className="flex items-center gap-2">
                      <span>Rows</span>
                      <ArrowUpDown
                        className={cn(
                          "w-3 h-3 transition-opacity",
                          sortField === "rowCount"
                            ? "opacity-100 text-emerald-500"
                            : "opacity-0 group-hover:opacity-100",
                        )}
                      />
                    </div>
                  </th>
                  <th className="px-4 py-3 w-20">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {filteredHistory.map((item) => (
                  <tr key={item.id} className="hover:bg-fill transition-colors group text-xs border-b border-hairline">
                    <td className="px-4 py-4 text-center">
                      <div className="flex justify-center">
                        {item.status === "success" && (
                          <div className="w-5 h-5 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                            <CircleCheck strokeWidth={1.5} className="w-3 h-3 text-emerald-500" />
                          </div>
                        )}
                        {item.status !== "success" && (
                          <div className="w-5 h-5 rounded-full bg-red-500/10 flex items-center justify-center border border-red-500/20">
                            <CircleAlert strokeWidth={1.5} className="w-3 h-3 text-red-500" />
                          </div>
                        )}
                      </div>
                    </td>
                    {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- cell text is dynamic; oxlint cannot see expressions through the wrapper div */}
                    <td className="px-4 py-4 whitespace-nowrap">
                      <div className="flex flex-col">
                        <span className="text-fg font-medium">
                          {item.executedAt ? format(new Date(item.executedAt), "MMM d, HH:mm:ss") : "-"}
                        </span>
                        <span className="text-xs text-fg-muted font-mono mt-0.5">
                          {item.executedAt ? format(new Date(item.executedAt), "yyyy") : ""}
                        </span>
                      </div>
                    </td>
                    {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- cell text is dynamic; oxlint cannot see expressions through the wrapper div */}
                    <td className="px-4 py-4 whitespace-nowrap">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5 text-fg-secondary">
                          <Database strokeWidth={1.5} className="w-3 h-3 text-blue-400" />
                          <span className="font-medium">{item.connectionName || "Unknown"}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-fg-muted text-xs">
                          <Hash strokeWidth={1.5} className="w-2.5 h-2.5" />
                          <span>{item.tabName || "Default Tab"}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4 max-w-md">
                      <div className="bg-canvas border border-hairline rounded-md p-2 relative group-hover:border-hairline-strong transition-colors">
                        <pre className="text-xs font-mono text-fg-tertiary line-clamp-2 break-all whitespace-pre-wrap leading-relaxed">
                          {item.query}
                        </pre>
                        {item.errorMessage && (
                          <div className="mt-2 pt-2 border-t border-red-500/10 text-xs text-red-400/80 font-mono italic">
                            {item.errorMessage}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <span
                        className={cn(
                          "px-2 py-0.5 rounded text-xs font-mono font-medium",
                          item.executionTime > 500 ? "text-amber-400 bg-amber-400/10" : "text-fg-tertiary bg-fill",
                        )}
                      >
                        {item.executionTime}ms
                      </span>
                    </td>
                    <td className="px-4 py-4 whitespace-nowrap">
                      <span className="text-fg-tertiary font-mono text-xs">
                        {item.rowCount != null ? item.rowCount.toLocaleString() : "-"}
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
                        <RotateCcw className="w-3 h-3" />
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
