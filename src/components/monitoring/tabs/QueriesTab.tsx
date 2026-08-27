"use client";

import React, { useState } from "react";
import { Clock, TriangleAlert, Search, ArrowUpDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import type { MonitoringData, ProviderLabels } from "@/lib/db/types";
import { PanelUnavailable } from "../PanelUnavailable";

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

const formatTime = (ms: number) => {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${ms.toFixed(2)}ms`;
};

/** The figures the stat cards print, as the loaded view computes them below. */
interface QueryStats {
  /** False when the list is empty: nothing was measured, so no card may print a number. */
  statsKnown: boolean;
  avgTime: number;
  overOneSecond: number;
}

interface StatCard {
  title: string;
  icon: (stats: QueryStats) => React.ReactNode;
  value: (stats: QueryStats) => string;
}

/**
 * The stat cards, in order, and the only place their number is written down: the loaded
 * view and QueriesSkeleton both map over this list, so a card added or removed here moves
 * both grids at once. Two hand-written counts do not stay in step - when this panel dropped
 * its third card (#515) the skeleton kept `[...Array(3)]` and every gate stayed green, because
 * `Array(2)` and `Array(3)` are the same executable line to the coverage gate and the only
 * loading test asserted the absence of a string the skeleton never rendered in either shape.
 */
const STAT_CARDS: readonly StatCard[] = [
  {
    title: "Avg of listed queries",
    icon: () => <Clock strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground" />,
    value: ({ statsKnown, avgTime }) => (statsKnown ? formatTime(avgTime) : "N/A"),
  },
  {
    title: "Listed queries over 1s",
    icon: ({ overOneSecond }) => (
      <TriangleAlert
        className={`h-3 w-3 sm:h-4 sm:w-4 ${overOneSecond > 0 ? "text-yellow-500" : "text-muted-foreground"}`}
      />
    ),
    value: ({ statsKnown, overOneSecond }) => (statsKnown ? String(overOneSecond) : "N/A"),
  },
];

/** Read by both grids, so the loaded cards and their placeholders lay out identically. */
const STAT_GRID_CLASS = "grid grid-cols-2 gap-2 sm:gap-4";

export function QueriesTab({ data, loading, labels }: QueriesTabProps) {
  const [sortField, setSortField] = useState<SortField>("totalTime");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  if (loading && !data) {
    return <QueriesSkeleton />;
  }

  const slowQueries = data?.slowQueries ?? [];

  // A panel whose read failed is absent from the payload with its own message under
  // `errors`, and that is a different fact from an empty answer: rendering it as data
  // would claim a measurement the engine refused to make. The whole-dashboard error state
  // is not right either - the other panels answered - so this panel alone carries the
  // engine's own sentence. See MonitoringData in src/lib/db/types.ts.
  // The badge below promises a PostgreSQL extension for an empty list; a refused read is
  // not an empty list, so the failure sentence replaces the table and suppresses the badge.
  const slowQueriesUnavailable = data?.slowQueries === undefined ? data?.errors?.slowQueries : undefined;

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
  // is required, so a provider that keeps no query log at all - the `getSlowQueries()` of
  // Cassandra (cassandra/index.ts), Druid (druid/index.ts) and SQLite (sqlite.ts), named
  // rather than pinned by line because all three coordinates this comment used to carry
  // had drifted - can only answer `[]`, and reducing that yielded "Queries 0 / Avg Time
  // 0.00ms / Slow 0" (the card wording of the day), measured 2026-08-21 in Chrome against
  // Apache Cassandra 5.0.9. An average over an empty set is not 0.00ms and a call total of
  // 0 is a claim about the database, so with no statistics the cards read N/A and the
  // sentence below them says why. Any non-empty list has been measured, zeros included,
  // and keeps today's arithmetic.
  //
  // The same list is also a CAP, which is the other way a figure here can promise more
  // than it measured, and the paragraph above did not cover it (#515): `slowQueryLimit`
  // defaults to 10 in src/lib/db/base-provider.ts, MonitoringDashboard overrides nothing,
  // and every provider that fills the list applies that ceiling - `LIMIT` in postgres.ts
  // and mysql.ts, `SELECT TOP` in mssql.ts, `ROWNUM <=` in oracle.ts, `.limit()` in
  // mongodb.ts, and redis.ts asks `SLOWLOG GET 10` outright. So the length of a populated
  // list is the ceiling, not a count: measured 2026-08-27 on MySQL 26.7.0, the same server
  // as HEALTH_SLOW_QUERY_LIMIT in providers/sql/mysql.ts, the digest table held 59 rows
  // for one connected schema and the panel was handed ten of them.
  //
  // A card labelled "Queries" therefore used to publish `sum(calls)` over ten digests as
  // the database's query count, and on MongoDB and Redis - both of which project
  // `calls: 1` per row - that sum WAS the list length. No label rescues a total the data
  // cannot supply, so the card is gone rather than renamed; the total belongs to whatever
  // read can count the whole log, which this one cannot.
  //
  // The two figures left are properties of the rows on screen, and their labels say so, so
  // a reader can recompute both by looking at the table below. Neither survives an
  // unscoped label: the list is ordered by total time descending and then truncated, so
  // the mean of the ten heaviest averages is not the server's average query time, and the
  // over-a-second count is bounded by ten however many slow statements the server holds.
  const statsKnown = slowQueries.length > 0;
  const avgTime = statsKnown ? slowQueries.reduce((sum, q) => sum + q.avgTime, 0) / slowQueries.length : 0;
  const overOneSecond = slowQueries.filter((q) => q.avgTime > 1000).length;
  const stats: QueryStats = { statsKnown, avgTime, overOneSecond };

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Stats Cards */}
      <div className={STAT_GRID_CLASS}>
        {STAT_CARDS.map((card) => (
          <Card key={card.title} className="p-0">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
              <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">{card.title}</CardTitle>
              {card.icon(stats)}
            </CardHeader>
            <CardContent className="p-2 sm:p-4 pt-0">
              <div className="text-lg sm:text-2xl font-medium">{card.value(stats)}</div>
            </CardContent>
          </Card>
        ))}
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
            {slowQueries.length === 0 && !slowQueriesUnavailable && !labels?.slowQueriesEmptyState && (
              <Badge variant="secondary" className="ml-2 text-xs sm:text-xs">
                pg_stat_statements required
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-4 sm:pt-0">
          {slowQueriesUnavailable ? (
            <PanelUnavailable message={slowQueriesUnavailable} />
          ) : slowQueries.length === 0 ? (
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
      <div className={STAT_GRID_CLASS}>
        {STAT_CARDS.map((card) => (
          <Card key={card.title} className="p-0">
            <CardHeader className="p-2 sm:p-4 pb-1 sm:pb-2">
              <Skeleton className="h-3 sm:h-4 w-16 sm:w-32" />
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
