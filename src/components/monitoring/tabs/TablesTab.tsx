"use client";

import React, { useState } from "react";
import { Table2, Search, AlertTriangle, Loader2, RefreshCw, Zap, type LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { MaintenanceType, MonitoringData, ProviderCapabilities } from "@/lib/db/types";

/**
 * The per-row maintenance controls this tab can render, each keyed to the
 * `MaintenanceType` vocabulary a provider declares in `maintenanceOperations`
 * rather than to a loose string — a typo would then be a type error instead of
 * a silently missing control.
 */
const MAINTENANCE_ACTIONS: { type: MaintenanceType; label: string; Icon: LucideIcon; className: string }[] = [
  { type: "analyze", label: "Analyze", Icon: Search, className: "h-6 w-6 sm:h-8 sm:w-8" },
  { type: "vacuum", label: "Vacuum", Icon: RefreshCw, className: "h-6 w-6 sm:h-8 sm:w-8" },
  { type: "reindex", label: "Reindex", Icon: Zap, className: "h-6 w-6 sm:h-8 sm:w-8 hidden sm:inline-flex" },
];

/**
 * Pure formatters, at module scope rather than re-created inside `TablesTab` on every
 * render. They also keep the component's own cognitive complexity to the decisions it
 * actually makes about absence, which is what this panel is about.
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

/**
 * `lastVacuum` is optional, and its absence means two different things. On PostgreSQL a
 * NULL `last_vacuum` really does mean the table has never been vacuumed, so "Never" is a
 * measurement; on an engine with no vacuum at all the same word claims a history for an
 * operation that does not exist. Only an engine that declares vacuum gets the word - the
 * rest get the dash this table already uses for a cell it cannot fill (`indexSize`).
 */
function formatVacuumDate(date: Date | undefined, vacuumSupported: boolean): string {
  if (!date) return vacuumSupported ? "Never" : "-";
  return new Date(date).toLocaleDateString();
}

/**
 * Three states, not two, which is why this is a function and not the nested ternary it
 * replaces: the vacuum figure can be a real reading, a denial from an engine with no
 * vacuum, or simply unknown because the engine published no table statistics at all. The
 * unknown case must not borrow the green of a healthy reading.
 */
function vacuumIconClass(stateKnown: boolean, needingVacuum: number): string {
  if (!stateKnown) return "text-muted-foreground";
  if (needingVacuum > 0) return "text-yellow-500";
  return "text-green-500";
}

/** The same three states, as the note under the figure. `null` is the unknown case. */
function VacuumNote({
  stateKnown,
  needingVacuum,
  unsupported,
}: Readonly<{
  stateKnown: boolean;
  needingVacuum: number;
  unsupported: boolean;
}>) {
  if (stateKnown) {
    return <p className="text-xs sm:text-xs text-muted-foreground mt-1">{needingVacuum > 0 ? "Need" : "OK"}</p>;
  }
  if (unsupported) {
    return <p className="text-xs sm:text-xs text-muted-foreground mt-1">Not supported</p>;
  }
  return null;
}

function bloatBadgeVariant(ratio: number): "destructive" | "outline" | "secondary" {
  if (ratio > 20) return "destructive";
  if (ratio > 10) return "outline";
  return "secondary";
}

interface TablesTabProps {
  data: MonitoringData | null;
  loading: boolean;
  onRunMaintenance: (type: string, target?: string) => Promise<boolean>;
  isAdmin?: boolean;
  /**
   * The connected provider's declared capabilities (issue #272). Undefined while
   * the provider metadata is still resolving, and if that request fails — no
   * maintenance control renders until a provider has declared what it supports,
   * matching how `Studio.tsx` gates Explain on `supportsExplain`. Failing open
   * here would put the dead buttons back on exactly the connections this gate
   * exists for whenever `/api/db/provider-meta` errors.
   */
  capabilities?: ProviderCapabilities;
}

export function TablesTab({ data, loading, onRunMaintenance, isAdmin = true, capabilities }: TablesTabProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  if (loading && !data) {
    return <TablesSkeleton />;
  }

  const tables = data?.tables ?? [];

  const filteredTables = tables.filter((t) => t.tableName.toLowerCase().includes(searchQuery.toLowerCase()));

  // Calculate totals
  const totalRows = tables.reduce((sum, t) => sum + t.rowCount, 0);
  const totalSize = tables.reduce((sum, t) => sum + t.totalSizeBytes, 0);
  const tablesNeedingVacuum = tables.filter((t) => (t.bloatRatio ?? 0) > 10).length;

  // ABSENCE and ZERO are different inputs — the rule #448 settled for StorageTab, which
  // this panel was still breaking one component over. A provider that publishes no table
  // statistics answers `[]` (Apache Cassandra's `getTableStats` returns an empty array as
  // a documented refusal; Apache Druid and Apache Trino do the same), and `BaseProvider`
  // assigns that array whenever `includeTables` is set, so `tables` alone cannot tell a
  // refusal from an empty database. The required `overview.tableCount` can: Cassandra
  // populates it from `system_schema`, and it read 6 in the very frame these cards read 0
  // (measured 2026-08-21 in Chrome against Apache Cassandra 5.0.9). Tables the engine
  // knows about but reports no statistics for means the figures are not knowable, so the
  // cards say so rather than publishing a confident zero the engine never measured. A
  // provider that reports a genuine 0 keeps today's arithmetic and today's rendering.
  const statsAbsent = tables.length === 0 && (data?.overview.tableCount ?? 0) > 0;

  // Whether the engine HAS vacuum is a capability question, not a data question, so it is
  // read from what the provider declares instead of inferred from the rows. Cassandra
  // declares `supportsMaintenance: false, maintenanceOperations: []` and every maintenance
  // action on it is a `nodetool` call this studio never issues — a green "OK" there is a
  // clean bill of health for an operation that does not exist. Undefined capabilities mean
  // the provider metadata has not resolved yet, which is not a denial: that path keeps the
  // existing rendering, exactly as the maintenance-control gate (#272) treats it.
  const vacuumUnsupported = capabilities?.supportsMaintenance === false;
  const vacuumSupported =
    capabilities?.supportsMaintenance === true && capabilities.maintenanceOperations.includes("vacuum");
  const vacuumStateKnown = !vacuumUnsupported && !statsAbsent;

  const handleMaintenance = async (type: MaintenanceType, tableName: string) => {
    setActionLoading(`${type}-${tableName}`);
    await onRunMaintenance(type, tableName);
    setActionLoading(null);
  };

  // Offer only the maintenance a provider declares it can perform: /api/db/maintenance
  // rejects everything else with 400, so an ungated button can only produce an error.
  const availableActions = capabilities?.supportsMaintenance
    ? MAINTENANCE_ACTIONS.filter((action) => capabilities.maintenanceOperations.includes(action.type))
    : [];

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Tables</CardTitle>
            <Table2 strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{statsAbsent ? "N/A" : tables.length}</div>
            {!statsAbsent && (
              <p className="text-xs sm:text-xs text-muted-foreground mt-1">{formatNumber(totalRows)} rows</p>
            )}
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Size</CardTitle>
            <Search strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{statsAbsent ? "N/A" : formatBytes(totalSize)}</div>
            {!statsAbsent && <p className="text-xs sm:text-xs text-muted-foreground mt-1">Total</p>}
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Vacuum</CardTitle>
            <AlertTriangle
              className={`h-3 w-3 sm:h-4 sm:w-4 ${vacuumIconClass(vacuumStateKnown, tablesNeedingVacuum)}`}
            />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{vacuumStateKnown ? tablesNeedingVacuum : "N/A"}</div>
            <VacuumNote
              stateKnown={vacuumStateKnown}
              needingVacuum={tablesNeedingVacuum}
              unsupported={vacuumUnsupported}
            />
          </CardContent>
        </Card>
      </div>

      {/* Tables List */}
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4">
            <CardTitle className="text-xs sm:text-xs font-medium flex items-center gap-2">
              <Table2 strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
              Table Statistics
            </CardTitle>
            <Input
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full sm:w-[200px] h-8 text-xs"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0 sm:p-4 sm:pt-0">
          {filteredTables.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Table2 strokeWidth={1.5} className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">{statsAbsent ? "No table statistics available." : "No tables found."}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Table</TableHead>
                    <TableHead className="text-right text-xs">Rows</TableHead>
                    <TableHead className="text-right text-xs">Size</TableHead>
                    <TableHead className="text-right text-xs hidden md:table-cell">Index</TableHead>
                    <TableHead className="text-right text-xs hidden sm:table-cell">Bloat</TableHead>
                    <TableHead className="text-xs hidden lg:table-cell">Vacuum</TableHead>
                    <TableHead className="text-right text-xs w-20">Act</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTables.map((table) => (
                    <TableRow key={`${table.schemaName}.${table.tableName}`}>
                      <TableCell className="py-2">
                        <div className="flex flex-col">
                          <span className="font-medium text-xs sm:text-xs truncate max-w-[100px] sm:max-w-[200px]">
                            {table.tableName}
                          </span>
                          <span className="text-xs sm:text-xs text-muted-foreground">{table.schemaName}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs py-2">
                        {formatNumber(table.rowCount)}
                        {table.deadRowCount ? (
                          <span className="text-xs text-muted-foreground block">
                            {formatNumber(table.deadRowCount)} dead
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2">{table.tableSize}</TableCell>
                      <TableCell className="text-right text-xs hidden md:table-cell py-2">
                        {table.indexSize || "-"}
                      </TableCell>
                      <TableCell className="text-right hidden sm:table-cell py-2">
                        {table.bloatRatio === undefined ? (
                          // No bloat figure published: a "0.0%" badge in the healthy
                          // variant would report a measurement the engine never made.
                          <span className="text-xs text-muted-foreground">-</span>
                        ) : (
                          <Badge variant={bloatBadgeVariant(table.bloatRatio)} className="text-xs sm:text-xs">
                            {table.bloatRatio.toFixed(1)}%
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground hidden lg:table-cell py-2">
                        {formatVacuumDate(table.lastVacuum, vacuumSupported)}
                      </TableCell>
                      <TableCell className="text-right py-2">
                        {isAdmin && availableActions.length > 0 ? (
                          <div className="flex justify-end gap-0.5">
                            {availableActions.map(({ type, label, Icon, className }) => (
                              <Button
                                key={type}
                                variant="ghost"
                                size="icon"
                                className={className}
                                onClick={() => handleMaintenance(type, table.tableName)}
                                disabled={!!actionLoading}
                                title={label}
                              >
                                {actionLoading === `${type}-${table.tableName}` ? (
                                  <Loader2 strokeWidth={1.5} className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Icon strokeWidth={1.5} className="h-3 w-3" />
                                )}
                              </Button>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TablesSkeleton() {
  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {[...Array(3)].map((_, i) => (
          <Card key={i} className="p-0">
            <CardHeader className="p-2 sm:p-4 pb-1 sm:pb-2">
              <Skeleton className="h-3 sm:h-4 w-12 sm:w-20" />
            </CardHeader>
            <CardContent className="p-2 sm:p-4 pt-0">
              <Skeleton className="h-5 sm:h-8 w-10 sm:w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4">
          <Skeleton className="h-4 sm:h-5 w-24 sm:w-32" />
        </CardHeader>
        <CardContent className="p-3 sm:p-4 pt-0">
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 sm:h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
