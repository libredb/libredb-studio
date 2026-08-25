"use client";

import React, { useState, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  RefreshCw,
  Zap,
  HardDrive,
  Search,
  Clock,
  Users,
  Skull,
  Database,
  ShieldAlert,
  LoaderCircle,
  CircleCheck,
  CircleX,
  Table2,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMonitoringData } from "@/hooks/use-monitoring-data";
import { storage } from "@/lib/storage";
import { useAllConnections } from "@/hooks/use-all-connections";
import type { ActiveSessionDetails, MaintenanceType } from "@/lib/db/types";
import { useProviderMetadata } from "@/hooks/use-provider-metadata";

interface OperationLogEntry {
  id: string;
  timestamp: Date;
  type: string;
  target: string;
  result: "success" | "failure";
  duration: number;
  error?: string;
}

export function OperationsTab() {
  // Only the operator's CHOICE is state; the list and the selected object are both
  // calculated during render from it. `useAllConnections` is read here, above the
  // hooks that take `selectedConnection` as an argument, because the derivation has
  // to happen before they run.
  const { connections } = useAllConnections();
  const [selectedId, setSelectedId] = useState<string | null>(() => storage.getActiveConnectionId());
  // The explicit length check rather than `?? connections[0] ?? null`:
  // noUncheckedIndexedAccess is off, so `connections[0]` types as non-optional and a
  // bare `??` chain would claim this can never be null while being undefined on an
  // empty list.
  const selectedConnection =
    connections.find((c) => c.id === selectedId) ?? (connections.length > 0 ? connections[0] : null);
  const [operationLog, setOperationLog] = useState<OperationLogEntry[]>([]);
  const [confirmKill, setConfirmKill] = useState<ActiveSessionDetails | null>(null);
  const [killingPid, setKillingPid] = useState<number | string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // The row an Explorer deep link named (`onOpenMaintenance("tables", name)` →
  // /admin/operations?table=...). It seeds the filter and marks the row, so the
  // named row is the one the operator lands on (#U5).
  const deepLinkedTable = useSearchParams().get("table");

  // Offer only the maintenance the connected provider declares it can perform:
  // /api/db/maintenance rejects everything else with 400, so an ungated control can
  // only produce an error (#282, the twin of the #272 gate on the monitoring Tables
  // tab). Unknown capabilities hide the controls rather than showing them —
  // `metadata` is also null when /api/db/provider-meta fails, and failing open
  // would put the dead buttons back on exactly the connections this gate is for.
  const { metadata } = useProviderMetadata(selectedConnection);

  // Redis and the embedded engine declare `tablesAreDerivedGroupings`: their rows
  // are key-prefix/namespace groupings, not addressable tables, so a Tables panel
  // there could only ever read "Tables (0)". Both the request and the panel hang
  // off that one capability — the same one TableItem reads — rather than a new
  // flag. An unknown capability counts as addressable: every provider but those
  // two has real tables, and metadata is also null while provider-meta is in
  // flight.
  const rowsAreAddressable = metadata?.capabilities.tablesAreDerivedGroupings !== true;

  // `includeTables` is NOT gated on the flag above, and that is measured rather than an oversight.
  // useMonitoringData fetches once per CONNECTION (its effect depends on [connection, fetchData],
  // and fetchData reads its options through a ref), autoRefresh is off here, so the one request
  // this tab makes is issued while `metadata` is still null and no later option change can reach
  // it. Gating it would need either a shared-hook rewrite or making every engine's health and
  // session panels wait on provider-meta first. The PANEL below is gated instead: that is where
  // the empty "Tables (0)" a key-value provider used to render actually came from, and rendering
  // is reactive so it settles as soon as the capability arrives.
  const monitoringOptions = useMemo(() => ({ includeTables: true, includeIndexes: false, includeStorage: false }), []);

  const { data, loading, error, refresh, killSession, runMaintenance } = useMonitoringData(
    selectedConnection,
    monitoringOptions,
  );
  const canRun = (type: MaintenanceType) =>
    metadata?.capabilities.supportsMaintenance === true && metadata.capabilities.maintenanceOperations.includes(type);
  const anyMaintenance = canRun("analyze") || canRun("vacuum") || canRun("reindex");
  // The six analyze/vacuum global ProviderLabels fields were declared, set by
  // seven providers, and read by no component, so every engine rendered
  // Postgres's query-planner copy (#427).
  //
  // Which card each provider's wording actually reaches follows from the gates
  // below, not from the labels: the analyze card renders for every provider that
  // declares `analyze`, so Redis now says "Server Info" and MongoDB "Validate
  // Collections"; the GLOBAL vacuum card is gated on the literal `vacuum`, which
  // among the providers that ship vacuum wording only MongoDB declares.
  //
  // The `??` fallbacks stay: `metadata` may carry capabilities without labels.
  const labels = metadata?.labels;

  const handleConnectionChange = (id: string) => {
    const conn = connections.find((c) => c.id === id);
    if (conn) setSelectedId(conn.id);
  };

  const addLogEntry = useCallback(
    (type: string, target: string, result: "success" | "failure", duration: number, error?: string) => {
      setOperationLog((prev) =>
        [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date(),
            type,
            target,
            result,
            duration,
            error,
          },
          ...prev,
        ].slice(0, 50),
      );
    },
    [],
  );

  const handleRunMaintenance = async (type: string, target?: string) => {
    const actionId = `${type}-${target || "global"}`;
    setActionLoading(actionId);
    const start = Date.now();
    try {
      const success = await runMaintenance(type, target);
      const duration = Date.now() - start;
      addLogEntry(type.toUpperCase(), target || "all", success ? "success" : "failure", duration);
    } catch {
      const duration = Date.now() - start;
      addLogEntry(type.toUpperCase(), target || "all", "failure", duration);
    } finally {
      setActionLoading(null);
    }
  };

  const handleKillClick = (session: ActiveSessionDetails) => {
    setConfirmKill(session);
  };

  const handleConfirmKill = async () => {
    if (!confirmKill) return;
    setKillingPid(confirmKill.pid);
    setConfirmKill(null);
    const start = Date.now();
    const success = await killSession(confirmKill.pid);
    const duration = Date.now() - start;
    addLogEntry("KILL", `PID:${confirmKill.pid}`, success ? "success" : "failure", duration);
    setKillingPid(null);
  };

  const sessions = data?.activeSessions ?? [];
  const tables = data?.tables ?? [];

  // A panel whose read failed is absent from the payload with its own message under
  // `errors`, and that is a different fact from an empty answer: rendering it as data
  // would claim a measurement the engine refused to make. The whole-dashboard error state
  // is not right either - the other panels answered - so this panel alone carries the
  // engine's own sentence. See MonitoringData in src/lib/db/types.ts.
  const sessionsUnavailable = data?.activeSessions === undefined ? data?.errors?.activeSessions : undefined;
  const tablesUnavailable = data?.tables === undefined ? data?.errors?.tables : undefined;
  const [tableSearch, setTableSearch] = useState(deepLinkedTable ?? "");
  const filteredTables = tables.filter((t) => t.tableName.toLowerCase().includes(tableSearch.toLowerCase()));

  const activeCount = sessions.filter((s) => s.state === "active").length;
  const idleCount = sessions.filter((s) => s.state === "idle").length;
  const idleInTxCount = sessions.filter((s) => s.state?.includes("idle in transaction")).length;
  const waitingCount = sessions.filter((s) => s.waitEventType).length;

  const getStateBadge = (state: string) => {
    switch (state) {
      case "active":
        return (
          <Badge className="bg-green-500/10 text-green-400 border border-green-500/20 text-[0.625rem]">Active</Badge>
        );
      case "idle":
        return (
          <Badge variant="secondary" className="text-[0.625rem]">
            Idle
          </Badge>
        );
      case "idle in transaction":
        return (
          <Badge className="bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 text-[0.625rem]">
            Idle TX
          </Badge>
        );
      case "idle in transaction (aborted)":
        return <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 text-[0.625rem]">Abort</Badge>;
      default:
        return (
          <Badge variant="outline" className="text-[0.625rem]">
            {state}
          </Badge>
        );
    }
  };

  if (connections.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <Database className="h-12 w-12 text-fg-faint mb-4" />
        <h3 className="text-lg font-semibold text-fg-secondary mb-2">No Database Connections</h3>
        <p className="text-fg-muted text-sm">Please add a database connection from the editor first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Connection Selector */}
      <div className="flex items-center justify-between">
        <Select value={selectedConnection?.id || ""} onValueChange={handleConnectionChange}>
          <SelectTrigger className="w-full sm:w-[280px] bg-panel border-hairline-strong text-fg-secondary">
            <SelectValue placeholder="Select connection">
              {selectedConnection ? (
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate">{selectedConnection.name}</span>
                  <span className="text-xs text-fg-muted hidden sm:inline">({selectedConnection.type})</span>
                </div>
              ) : (
                "Select connection"
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {connections.map((conn) => (
              <SelectItem key={conn.id} value={conn.id}>
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4" />
                  <span>{conn.name}</span>
                  <span className="text-xs text-muted-foreground">({conn.type})</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-fg-muted hover:text-fg-secondary"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && !data && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-red-400 text-sm">{error}</div>
      )}

      {/* Global Operations — hidden entirely where the provider declares none */}
      {anyMaintenance && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert className="h-4 w-4 text-blue-400" />
            <h3 className="text-sm font-bold text-fg-secondary">Global Operations</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Analyze */}
            {canRun("analyze") && (
              <div className="p-4 rounded-xl border border-hairline bg-fill-subtle hover:bg-fill transition-colors">
                <div className="flex items-start justify-between mb-3">
                  <div className="w-8 h-8 rounded-lg bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center">
                    <Zap className="w-4 h-4 text-yellow-500" />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-hairline-strong hover:bg-yellow-500/10 hover:text-yellow-500"
                    onClick={() => handleRunMaintenance("analyze")}
                    disabled={!!actionLoading || !selectedConnection}
                  >
                    {actionLoading === "analyze-global" ? <RefreshCw className="w-3 h-3 animate-spin mr-1" /> : null}
                    {labels?.analyzeGlobalLabel ?? "Run Analyze"}
                  </Button>
                </div>
                <h4 className="text-sm font-bold text-fg mb-1">{labels?.analyzeGlobalTitle ?? "Update Statistics"}</h4>
                <p className="text-xs text-fg-muted leading-relaxed">
                  {labels?.analyzeGlobalDesc ?? "Updates query planner statistics for all tables."}
                </p>
              </div>
            )}

            {/* Vacuum */}
            {canRun("vacuum") && (
              <div className="p-4 rounded-xl border border-hairline bg-fill-subtle hover:bg-fill transition-colors">
                <div className="flex items-start justify-between mb-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                    <HardDrive className="w-4 h-4 text-blue-500" />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-hairline-strong hover:bg-blue-500/10 hover:text-blue-500"
                    onClick={() => handleRunMaintenance("vacuum")}
                    disabled={!!actionLoading || !selectedConnection}
                  >
                    {actionLoading === "vacuum-global" ? <RefreshCw className="w-3 h-3 animate-spin mr-1" /> : null}
                    {labels?.vacuumGlobalLabel ?? "Run Vacuum"}
                  </Button>
                </div>
                <h4 className="text-sm font-bold text-fg mb-1">{labels?.vacuumGlobalTitle ?? "Reclaim Space"}</h4>
                <p className="text-xs text-fg-muted leading-relaxed">
                  {labels?.vacuumGlobalDesc ?? "Removes dead rows and returns space to the OS."}
                </p>
              </div>
            )}

            {/* Reindex — the triad is OPTIONAL on ProviderLabels (only the three
                providers that declare the `reindex` operation set it), so the
                hardcoded strings below stay as the fallback (#U6). */}
            {canRun("reindex") && (
              <div className="p-4 rounded-xl border border-hairline bg-fill-subtle hover:bg-fill transition-colors">
                <div className="flex items-start justify-between mb-3">
                  <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                    <RefreshCw className="w-4 h-4 text-purple-500" />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-hairline-strong hover:bg-purple-500/10 hover:text-purple-500"
                    onClick={() => handleRunMaintenance("reindex")}
                    disabled={!!actionLoading || !selectedConnection}
                  >
                    {actionLoading === "reindex-global" ? <RefreshCw className="w-3 h-3 animate-spin mr-1" /> : null}
                    {labels?.reindexGlobalLabel ?? "Run Reindex"}
                  </Button>
                </div>
                <h4 className="text-sm font-bold text-fg mb-1">{labels?.reindexGlobalTitle ?? "Rebuild Indexes"}</h4>
                <p className="text-xs text-fg-muted leading-relaxed">
                  {labels?.reindexGlobalDesc ?? "Reconstructs all indexes in the database."}
                </p>
              </div>
            )}

            {/* Warning Card */}
            <div className="p-4 rounded-xl border border-red-500/10 bg-red-500/5 flex flex-col justify-center">
              <div className="flex items-center gap-2 text-red-400 mb-2">
                <ShieldAlert className="w-4 h-4" />
                <span className="text-xs font-bold uppercase tracking-wider">Warning</span>
              </div>
              <p className="text-xs text-red-400/70 leading-relaxed italic">
                These operations can be resource-intensive. Avoid running them during peak traffic hours.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Tables + Sessions Split */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Table Operations — absent where the provider's rows are derived groupings */}
        {rowsAreAddressable && (
          <div className="rounded-xl border border-hairline bg-panel">
            <div className="p-4 border-b border-hairline flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Table2 className="w-4 h-4 text-blue-400" />
                <span className="text-xs font-bold text-fg-secondary">
                  {tablesUnavailable ? "Tables" : `Tables (${tables.length})`}
                </span>
              </div>
              <Input
                placeholder="Filter..."
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
                className="w-[140px] h-7 text-xs bg-raised border-hairline-strong"
              />
            </div>
            <div className="max-h-[350px] overflow-y-auto">
              {loading && tables.length === 0 ? (
                <div className="p-4 space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full bg-overlay" />
                  ))}
                </div>
              ) : filteredTables.length === 0 ? (
                <div className="p-8 text-center text-fg-subtle text-sm" data-testid="operations-tables-empty">
                  {tablesUnavailable ?? "No tables found."}
                </div>
              ) : (
                <div className="divide-y divide-hairline">
                  {filteredTables.map((table) => (
                    <div
                      key={`${table.schemaName}.${table.tableName}`}
                      data-selected={table.tableName === deepLinkedTable ? "true" : undefined}
                      className={`group flex items-center justify-between px-4 py-2 hover:bg-fill transition-colors ${
                        table.tableName === deepLinkedTable ? "bg-fill" : ""
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-fg-secondary truncate max-w-[160px]">
                          {table.tableName}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-fg-muted">
                          <span className="font-mono">{table.rowCount.toLocaleString()} rows</span>
                          <span>-</span>
                          <span className="font-mono">{table.tableSize}</span>
                          {(table.bloatRatio ?? 0) > 10 && (
                            <Badge
                              variant="outline"
                              className="text-[0.625rem] text-yellow-400 border-yellow-500/20 h-4"
                            >
                              {(table.bloatRatio ?? 0).toFixed(0)}% bloat
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {canRun("analyze") && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="w-7 h-7 text-fg-muted hover:text-yellow-500"
                            title="Analyze"
                            onClick={() => handleRunMaintenance("analyze", table.tableName)}
                            disabled={!!actionLoading}
                          >
                            {actionLoading === `analyze-${table.tableName}` ? (
                              <LoaderCircle className="w-3 h-3 animate-spin" />
                            ) : (
                              <Search className="w-3 h-3" />
                            )}
                          </Button>
                        )}
                        {canRun("vacuum") && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="w-7 h-7 text-fg-muted hover:text-blue-500"
                            title="Vacuum"
                            onClick={() => handleRunMaintenance("vacuum", table.tableName)}
                            disabled={!!actionLoading}
                          >
                            {actionLoading === `vacuum-${table.tableName}` ? (
                              <LoaderCircle className="w-3 h-3 animate-spin" />
                            ) : (
                              <HardDrive className="w-3 h-3" />
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Session Manager */}
        <div className="rounded-xl border border-hairline bg-panel">
          <div className="p-4 border-b border-hairline">
            <div className="flex items-center gap-2 mb-3">
              <Users className="w-4 h-4 text-green-400" />
              <span className="text-xs font-bold text-fg-secondary">
                {sessionsUnavailable ? "Sessions" : `Sessions (${sessions.length})`}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-lg bg-fill p-2 text-center">
                <div className="text-lg font-bold text-fg tabular-nums">{activeCount}</div>
                <div className="text-[0.625rem] text-fg-muted uppercase font-bold">Active</div>
              </div>
              <div className="rounded-lg bg-fill p-2 text-center">
                <div className="text-lg font-bold text-fg tabular-nums">{idleCount}</div>
                <div className="text-[0.625rem] text-fg-muted uppercase font-bold">Idle</div>
              </div>
              <div className="rounded-lg bg-fill p-2 text-center">
                <div className={`text-lg font-bold tabular-nums ${idleInTxCount > 0 ? "text-yellow-400" : "text-fg"}`}>
                  {idleInTxCount}
                </div>
                <div className="text-[0.625rem] text-fg-muted uppercase font-bold">In TX</div>
              </div>
              <div className="rounded-lg bg-fill p-2 text-center">
                <div className={`text-lg font-bold tabular-nums ${waitingCount > 0 ? "text-orange-400" : "text-fg"}`}>
                  {waitingCount}
                </div>
                <div className="text-[0.625rem] text-fg-muted uppercase font-bold">Wait</div>
              </div>
            </div>
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {loading && sessions.length === 0 ? (
              <div className="p-4 space-y-2">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full bg-overlay" />
                ))}
              </div>
            ) : sessions.length === 0 ? (
              <div className="p-8 text-center text-fg-subtle text-sm" data-testid="operations-sessions-empty">
                {sessionsUnavailable ?? "No active sessions found."}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-hairline hover:bg-transparent">
                    <TableHead className="text-xs text-fg-muted font-bold uppercase w-[60px]">PID</TableHead>
                    <TableHead className="text-xs text-fg-muted font-bold uppercase">User</TableHead>
                    <TableHead className="text-xs text-fg-muted font-bold uppercase">State</TableHead>
                    <TableHead className="text-xs text-fg-muted font-bold uppercase hidden md:table-cell">
                      Query
                    </TableHead>
                    <TableHead className="text-xs text-fg-muted font-bold uppercase">Time</TableHead>
                    <TableHead className="text-right text-xs text-fg-muted font-bold uppercase w-10">Act</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((session) => (
                    <TableRow key={session.pid} className="group border-hairline hover:bg-fill">
                      <TableCell className="font-mono text-xs text-fg-tertiary py-2">{session.pid}</TableCell>
                      <TableCell className="py-2">
                        <span className="text-xs text-fg-secondary truncate max-w-[80px] block">{session.user}</span>
                      </TableCell>
                      <TableCell className="py-2">{getStateBadge(session.state)}</TableCell>
                      <TableCell className="font-mono text-xs text-fg-muted hidden md:table-cell py-2">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="max-w-[120px] truncate cursor-help">{session.query || "-"}</div>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="max-w-lg">
                              <pre className="text-xs whitespace-pre-wrap">{session.query || "No query"}</pre>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="py-2">
                        <Badge
                          variant={
                            session.durationMs > 60000
                              ? "destructive"
                              : session.durationMs > 10000
                                ? "outline"
                                : "secondary"
                          }
                          className="text-[0.625rem]"
                        >
                          {session.duration}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right py-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-fg-subtle hover:text-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                          onClick={() => handleKillClick(session)}
                          disabled={killingPid === session.pid}
                        >
                          {killingPid === session.pid ? (
                            <LoaderCircle className="h-3 w-3 animate-spin" />
                          ) : (
                            <Skull className="h-3 w-3" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </div>

      {/* Operation Log */}
      {operationLog.length > 0 && (
        <div className="rounded-xl border border-hairline bg-panel">
          <div className="p-4 border-b border-hairline flex items-center gap-2">
            <Clock className="w-4 h-4 text-fg-muted" />
            <span className="text-xs font-bold text-fg-secondary">Operation Log (this session)</span>
          </div>
          <div className="max-h-[200px] overflow-y-auto divide-y divide-hairline">
            {operationLog.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 px-4 py-2 text-xs hover:bg-fill transition-colors">
                <span className="text-fg-subtle font-mono text-xs w-[50px] shrink-0">
                  {entry.timestamp.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <Badge
                  variant="outline"
                  className="text-[0.625rem] font-bold w-[70px] justify-center shrink-0 border-hairline-strong"
                >
                  {entry.type}
                </Badge>
                <span className="text-fg-tertiary font-mono truncate">{entry.target}</span>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  {entry.result === "success" ? (
                    <CircleCheck className="w-3 h-3 text-emerald-500" />
                  ) : (
                    <CircleX className="w-3 h-3 text-red-500" />
                  )}
                  <span className="text-fg-subtle font-mono text-xs">{entry.duration}ms</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Kill Session Confirmation Dialog */}
      <AlertDialog open={!!confirmKill} onOpenChange={() => setConfirmKill(null)}>
        <AlertDialogContent className="bg-surface border-hairline-strong">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-fg">Terminate Session?</AlertDialogTitle>
            <AlertDialogDescription className="text-fg-tertiary">
              Are you sure you want to terminate session{" "}
              <span className="font-mono font-bold text-fg">{confirmKill?.pid}</span>
              ?
              <br />
              <br />
              User: <span className="font-medium text-fg-secondary">{confirmKill?.user}</span>
              <br />
              State: <span className="font-medium text-fg-secondary">{confirmKill?.state}</span>
              <br />
              <br />
              This action will forcefully end the connection and may cause data loss if the session has uncommitted
              transactions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-hairline-strong text-fg-tertiary">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmKill} className="bg-red-600 text-white hover:bg-red-500">
              Terminate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
