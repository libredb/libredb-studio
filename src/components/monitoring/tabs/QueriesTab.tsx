"use client";

import React, { useState } from "react";
import { Clock, AlertTriangle, Search, ArrowUpDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import type { MonitoringData, ProviderLabels } from "@/lib/db/types";

interface QueriesTabProps {
  data: MonitoringData | null;
  loading: boolean;
  /**
   * The connected provider's own labels. Absent while /api/db/provider-meta is in
   * flight and when it failed, which is why every read below falls back.
   */
  labels?: ProviderLabels;
}

type SortField = "totalTime" | "avgTime" | "calls" | "rows";
type SortDir = "asc" | "desc";

export function QueriesTab({ data, loading, labels }: QueriesTabProps) {
  const [sortField, setSortField] = useState<SortField>("totalTime");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  if (loading && !data) {
    return <QueriesSkeleton />;
  }

  const slowQueries = data?.slowQueries ?? [];

  const sortedQueries = [...slowQueries].sort((a, b) => {
    const aVal = a[sortField] ?? 0;
    const bVal = b[sortField] ?? 0;
    return sortDir === "desc" ? bVal - aVal : aVal - bVal;
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "desc" ? "asc" : "desc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const formatTime = (ms: number) => {
    if (ms >= 1000) {
      return `${(ms / 1000).toFixed(2)}s`;
    }
    return `${ms.toFixed(2)}ms`;
  };

  const formatNumber = (n: number) => {
    if (n >= 1000000) {
      return `${(n / 1000000).toFixed(1)}M`;
    }
    if (n >= 1000) {
      return `${(n / 1000).toFixed(1)}K`;
    }
    return n.toString();
  };

  // Calculate stats. Absence and zero are different inputs: `MonitoringData.slowQueries`
  // is required, so a provider that keeps no query log at all - Cassandra
  // (cassandra/index.ts:573-575), Druid (index.ts:486-488), SQLite (sqlite.ts:734-737) -
  // can only answer `[]`, and reducing that yielded "Queries 0 / Avg Time 0.00ms /
  // Slow 0", measured 2026-08-21 in Chrome against Apache Cassandra 5.0.9. An average
  // over an empty set is not 0.00ms and a call total of 0 is a claim about the database,
  // so with no statistics the three cards read N/A and the sentence below them says why.
  // Any non-empty list has been measured, zeros included, and keeps today's arithmetic.
  const statsKnown = slowQueries.length > 0;
  const totalQueries = slowQueries.reduce((sum, q) => sum + q.calls, 0);
  const avgTime = statsKnown ? slowQueries.reduce((sum, q) => sum + q.avgTime, 0) / slowQueries.length : 0;
  const slowCount = slowQueries.filter((q) => q.avgTime > 1000).length;

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Queries</CardTitle>
            <Search strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{statsKnown ? formatNumber(totalQueries) : "N/A"}</div>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Avg Time</CardTitle>
            <Clock strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{statsKnown ? formatTime(avgTime) : "N/A"}</div>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Slow</CardTitle>
            <AlertTriangle
              className={`h-3 w-3 sm:h-4 sm:w-4 ${slowCount > 0 ? "text-yellow-500" : "text-muted-foreground"}`}
            />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{statsKnown ? slowCount : "N/A"}</div>
          </CardContent>
        </Card>
      </div>

      {/* Queries Table */}
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4">
          <CardTitle className="text-xs sm:text-xs font-medium flex items-center gap-2">
            <Clock strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
            Slowest Queries
            {/* The badge and the sentence below were PostgreSQL's advice shown on every
                engine (#U12, the #427 defect in another panel) - measured
                2026-08-19 in Chrome telling an OpenSearch cluster to install a
                PostgreSQL extension. The engine's own answer comes off
                `ProviderLabels.slowQueriesEmptyState`, the way the Operations tab reads
                the analyze/vacuum triads. The badge names an EXTENSION rather than a
                category, so an engine with its own answer would need a second label to
                fill it; it is dropped there instead, and the sentence carries the
                answer. Absent label = today's wording, so `postgres` is unchanged. */}
            {slowQueries.length === 0 && !labels?.slowQueriesEmptyState && (
              <Badge variant="secondary" className="ml-2 text-xs sm:text-xs">
                pg_stat_statements required
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-4 sm:pt-0">
          {slowQueries.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Search strokeWidth={1.5} className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">No query statistics available.</p>
              <p className="text-xs mt-1">
                {labels?.slowQueriesEmptyState ?? "Enable pg_stat_statements extension to see query stats."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs w-[40%]">Query</TableHead>
                    <TableHead className="text-xs hidden sm:table-cell">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 -ml-3 h-7 text-xs"
                        onClick={() => handleSort("calls")}
                      >
                        Calls
                        <ArrowUpDown strokeWidth={1.5} className="h-3 w-3" />
                      </Button>
                    </TableHead>
                    <TableHead className="text-xs hidden md:table-cell">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 -ml-3 h-7 text-xs"
                        onClick={() => handleSort("totalTime")}
                      >
                        Total
                        <ArrowUpDown strokeWidth={1.5} className="h-3 w-3" />
                      </Button>
                    </TableHead>
                    <TableHead className="text-xs">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 -ml-3 h-7 text-xs"
                        onClick={() => handleSort("avgTime")}
                      >
                        Avg
                        <ArrowUpDown strokeWidth={1.5} className="h-3 w-3" />
                      </Button>
                    </TableHead>
                    <TableHead className="text-xs hidden lg:table-cell">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 -ml-3 h-7 text-xs"
                        onClick={() => handleSort("rows")}
                      >
                        Rows
                        <ArrowUpDown strokeWidth={1.5} className="h-3 w-3" />
                      </Button>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedQueries.map((query, index) => (
                    <TableRow key={query.queryId || index}>
                      <TableCell className="font-mono text-xs sm:text-xs py-2">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="max-w-[120px] sm:max-w-[200px] md:max-w-[300px] truncate cursor-help">
                                {query.query}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="max-w-lg">
                              <pre className="text-xs whitespace-pre-wrap">{query.query}</pre>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-xs py-2">{formatNumber(query.calls)}</TableCell>
                      <TableCell className="hidden md:table-cell py-2">
                        <Badge
                          variant={query.totalTime > 60000 ? "destructive" : "secondary"}
                          className="text-xs sm:text-xs"
                        >
                          {formatTime(query.totalTime)}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-2">
                        <Badge
                          variant={query.avgTime > 1000 ? "destructive" : query.avgTime > 100 ? "outline" : "secondary"}
                          className="text-xs sm:text-xs"
                        >
                          {formatTime(query.avgTime)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs py-2">{formatNumber(query.rows)}</TableCell>
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

function QueriesSkeleton() {
  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {[...Array(3)].map((_, i) => (
          <Card key={i} className="p-0">
            <CardHeader className="p-2 sm:p-4 pb-1 sm:pb-2">
              <Skeleton className="h-3 sm:h-4 w-12 sm:w-24" />
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
