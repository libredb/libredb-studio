"use client";

import React from "react";
import { Database, Zap, Activity, Clock, Table2, Hash, Server } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { MonitoringData } from "@/lib/db/types";
import type { TimeSeriesPoint } from "@/lib/time-series-buffer";
import { evaluateThreshold, getThresholdColor, DEFAULT_THRESHOLDS } from "@/lib/monitoring-thresholds";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import { MetricChart } from "./MetricChart";
import { PanelUnavailable } from "../PanelUnavailable";

interface OverviewTabProps {
  data: MonitoringData | null;
  loading: boolean;
  history?: TimeSeriesPoint<MonitoringData>[];
}

export function OverviewTab({ data, loading, history = [] }: OverviewTabProps) {
  if (loading && !data) {
    return <OverviewSkeleton />;
  }

  const overview = data?.overview;
  const performance = data?.performance;

  // A panel whose read failed is absent from the payload with its own message under
  // `errors`, and that is a different fact from an empty answer: rendering it as data
  // would claim a measurement the engine refused to make. The whole-dashboard error state
  // is not right either - the other panels answered - so this panel alone carries the
  // engine's own sentence. See MonitoringData in src/lib/db/types.ts.
  if (overview === undefined && data?.errors?.overview) {
    return (
      <div className="p-3 sm:p-6">
        <PanelUnavailable message={data.errors.overview} />
      </div>
    );
  }

  // Optional on purpose: an engine that cannot measure its cache (Druid) reports
  // nothing, and that must not be displayed as a measured 0%.
  const cacheHitRatio = performance?.cacheHitRatio;

  // The same distinction, on the two rows of the Performance card. An engine that
  // holds no buffer pool publishes no usage - Trino omits it because "it holds no
  // pages", Cassandra and SQLite omit it too - and an engine that takes no locks
  // keeps no deadlock counter. Rendering those absences as "0%" with an empty bar
  // and as the badge 0 in the healthy `secondary` variant claimed measurements
  // nobody made, and the deadlock one read as a clean bill of health. A real 0 from
  // an engine that does measure keeps exactly its former rendering.
  const bufferPoolUsage = performance?.bufferPoolUsage;
  const deadlocks = performance?.deadlocks;

  // A limit of 0 means "no limit published", not "no capacity": mssql.ts says so in
  // as many words, and Druid genuinely has no connection pool and no SQL-readable
  // limit. Dividing by it produced NaN, which rendered as the literal "NaN% used"
  // and an NaN-width progress bar, so a usage share only exists when a limit does.
  const connectionLimit = overview?.maxConnections ?? 0;
  // `overview.activeConnections` is optional: a provider that cannot measure
  // it (ScyllaDB has no `system_views` keyspace; a Cassandra role can be denied the
  // grant) omits the key rather than send a fabricated 0, so a share of the limit
  // only exists when there is a count to divide.
  const activeConnections = overview?.activeConnections;
  const connectionPercent =
    activeConnections !== undefined && connectionLimit > 0
      ? Math.round((activeConnections / connectionLimit) * 100)
      : null;

  // Evaluate thresholds. No published limit cannot be near a limit, so it scores as
  // healthy rather than as the 0 that a missing reading would once have implied.
  const connThreshold = evaluateThreshold(
    connectionPercent ?? 0,
    DEFAULT_THRESHOLDS.find((t) => t.metric === "connectionPercent")!,
  );
  const cacheThreshold = evaluateThreshold(
    cacheHitRatio ?? 100,
    DEFAULT_THRESHOLDS.find((t) => t.metric === "cacheHitRatio")!,
  );

  // Build chart data from history. A sample with no published count is dropped
  // rather than plotted as zero - the same rule PerformanceTab.tsx's `metricSeries`
  // applies to the cache/buffer/deadlock trends, for the same reason: a missing
  // reading is not a floor of zero.
  const connectionHistory = history.flatMap((h) => {
    const value = h.data.overview?.activeConnections;
    return value === undefined ? [] : [{ timestamp: h.timestamp, value }];
  });

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Version & Status */}
      <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
        <Badge variant="outline" className="gap-1.5 sm:gap-2 py-1 sm:py-1.5 px-2 sm:px-3 text-xs">
          <Server strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
          <span className="truncate max-w-[120px] sm:max-w-none">{overview?.version || "Unknown"}</span>
        </Badge>
        <Badge variant="secondary" className="gap-1.5 sm:gap-2 py-1 sm:py-1.5 px-2 sm:px-3 text-xs">
          <Clock strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
          {overview?.uptime || "N/A"}
        </Badge>
        {data?.timestamp && (
          <span className="text-xs sm:text-xs text-muted-foreground">
            {new Date(data.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Main Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
        {/* Active Connections */}
        <Card className={`p-0 border-2 transition-colors ${getThresholdColor(connThreshold)}`}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Connections</CardTitle>
            <Zap strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-yellow-500" />
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <div
              className={`text-lg sm:text-2xl font-medium ${activeConnections === undefined ? "text-muted-foreground" : ""}`}
            >
              {activeConnections ?? "N/A"}
              {activeConnections !== undefined && connectionLimit > 0 && (
                <span className="text-xs sm:text-xs font-normal text-muted-foreground">/{connectionLimit}</span>
              )}
            </div>
            {activeConnections === undefined ? (
              <p className="text-xs sm:text-xs text-muted-foreground mt-1">not published</p>
            ) : connectionPercent === null ? (
              <p className="text-xs sm:text-xs text-muted-foreground mt-1">no limit published</p>
            ) : (
              <>
                <Progress value={connectionPercent} className="h-1 mt-1 sm:mt-2" />
                <p className="text-xs sm:text-xs text-muted-foreground mt-1">{connectionPercent}% used</p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Database Size */}
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">DB Size</CardTitle>
            <Database strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-blue-500" />
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{overview?.databaseSize || "N/A"}</div>
            <p className="text-xs sm:text-xs text-muted-foreground mt-1">Total storage</p>
          </CardContent>
        </Card>

        {/* Cache Hit Ratio */}
        <Card className={`p-0 border-2 transition-colors ${getThresholdColor(cacheThreshold)}`}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Cache Hit</CardTitle>
            <Activity strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-green-500" />
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            {cacheHitRatio === undefined ? (
              <>
                <div className="text-lg sm:text-2xl font-medium text-muted-foreground">
                  {CACHE_HIT_RATIO_UNAVAILABLE}
                </div>
                <p className="text-xs sm:text-xs text-muted-foreground mt-1 truncate">Not measured</p>
              </>
            ) : (
              <>
                <div className="text-lg sm:text-2xl font-medium">{cacheHitRatio.toFixed(1)}%</div>
                <Progress value={cacheHitRatio} className="h-1 mt-1 sm:mt-2" />
                <p className="text-xs sm:text-xs text-muted-foreground mt-1 truncate">
                  {cacheHitRatio >= 90 ? "Excellent" : cacheHitRatio >= 80 ? "Good" : "Needs tuning"}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Tables & Indexes */}
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Tables</CardTitle>
            <Table2 strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-purple-500" />
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{overview?.tableCount ?? 0}</div>
            <p className="text-xs sm:text-xs text-muted-foreground mt-1">{overview?.indexCount ?? 0} indexes</p>
          </CardContent>
        </Card>
      </div>

      {/* Connection Trend Chart */}
      {connectionHistory.length >= 2 && (
        <Card className="p-0">
          <CardHeader className="p-3 sm:p-4 pb-1">
            <CardTitle className="text-xs sm:text-xs font-medium flex items-center gap-2">
              <Activity strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
              Connection Trend
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <MetricChart data={connectionHistory} color="#eab308" title="Connections" />
          </CardContent>
        </Card>
      )}

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4">
        <PerformanceSummaryCard
          bufferPoolUsage={bufferPoolUsage}
          deadlocks={deadlocks}
          checkpointWriteTime={performance?.checkpointWriteTime}
        />
        <QuickStatsCard data={data} />
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      <div className="flex items-center gap-2 sm:gap-4">
        <Skeleton className="h-6 sm:h-8 w-32 sm:w-48" />
        <Skeleton className="h-6 sm:h-8 w-20 sm:w-32" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i} className="p-0">
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <Skeleton className="h-3 sm:h-4 w-16 sm:w-24" />
            </CardHeader>
            <CardContent className="p-3 sm:p-4 pt-0">
              <Skeleton className="h-5 sm:h-8 w-12 sm:w-20" />
              <Skeleton className="h-1 w-full mt-2" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

/**
 * Buffer pool, deadlocks and checkpoint, each rendered from whether the engine
 * published the figure at all. `undefined` is the absence; a real 0 keeps the
 * rendering a measured 0 always had.
 */
function PerformanceSummaryCard({
  bufferPoolUsage,
  deadlocks,
  checkpointWriteTime,
}: Readonly<{
  bufferPoolUsage: number | undefined;
  deadlocks: number | undefined;
  checkpointWriteTime: string | undefined;
}>) {
  return (
    <Card className="p-0">
      <CardHeader className="p-3 sm:p-4 pb-2">
        <CardTitle className="text-xs sm:text-xs font-medium flex items-center gap-2">
          <Activity strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
          Performance
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 sm:p-4 pt-0 space-y-2 sm:space-y-3">
        <div className="flex justify-between items-center gap-2">
          <span className="text-xs sm:text-xs text-muted-foreground">Buffer Pool</span>
          <div className="flex items-center gap-1 sm:gap-2">
            {bufferPoolUsage === undefined ? (
              <>
                <span className="text-xs sm:text-xs text-muted-foreground">Not measured</span>
                <span className="text-xs sm:text-xs font-medium w-8 sm:w-12 text-right text-muted-foreground">N/A</span>
              </>
            ) : (
              <>
                <Progress value={bufferPoolUsage} className="w-16 sm:w-24 h-1.5 sm:h-2" />
                <span className="text-xs sm:text-xs font-medium w-8 sm:w-12 text-right">
                  {bufferPoolUsage.toFixed(0)}%
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-xs sm:text-xs text-muted-foreground">Deadlocks</span>
          {deadlocks === undefined ? (
            <div className="flex items-center gap-1 sm:gap-2">
              <span className="text-xs sm:text-xs text-muted-foreground">Not measured</span>
              <Badge variant="outline" className="text-xs text-muted-foreground">
                N/A
              </Badge>
            </div>
          ) : (
            <Badge variant={deadlocks ? "destructive" : "secondary"} className="text-xs">
              {deadlocks}
            </Badge>
          )}
        </div>
        <div className="flex justify-between items-center">
          <span className="text-xs sm:text-xs text-muted-foreground">Checkpoint</span>
          <span className="text-xs sm:text-xs font-mono truncate max-w-[100px] sm:max-w-none">
            {checkpointWriteTime || "N/A"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Slow-query and session figures, read straight off the payload.
 *
 * A figure is rendered only when the panel it comes from actually answered. `?? 0` used to
 * stand in for both an empty list and a REFUSED read, which are opposite facts: measured
 * in the browser on 2026-08-24 against StarRocks 3.3, whose `getActiveSessions` is
 * "Unknown table 'information_schema.PROCESSLIST'", this card claimed "Active 0 / Idle 0"
 * for a question the engine had declined to answer. Same fabricated zero the connection
 * count lost, in a second place.
 *
 * The ceiling on a list that DID answer is the other half of the same rule, and the
 * paragraph above never covered it - the shape #515 removed from QueriesTab.tsx survived here
 * three more times. Both lists this card reads are capped in
 * src/lib/db/base-provider.ts: `slowQueryLimit = 10` and `sessionLimit = 50`, passed into
 * `getSlowQueries` and `getActiveSessions`, and MonitoringDashboard overrides neither (it
 * sets only the three `include*` flags). The providers that fill the session list apply the
 * ceiling in SQL or in memory - `$2` in postgres.ts, `LIMIT` in mysql.ts, `SELECT TOP` in
 * mssql.ts, `ROWNUM <=` in oracle.ts, `.slice(0, limit)` over `currentOp` in mongodb.ts -
 * so a server past either ceiling hands this card a truncated list and nothing in the
 * payload says how much was cut.
 *
 * This helper cannot fix that: it is handed rows and a counting function, and the length of
 * a saturated list is the cap whatever it is divided by. What the figures needed was labels
 * that claim only the rows the dashboard holds, which is what QuickStatsCard now writes, in
 * the vocabulary QueriesTab.tsx settled on: every figure here is a property of the listed
 * rows - the same rows the Queries and Sessions tabs put on screen, where a reader can
 * recount them. So "Slow Queries 10" no longer reads as 10 slow statements on a server with
 * 59 recorded digests, and the two badges that split one bounded list of sessions no longer
 * read as the server's active and idle totals. All three still render, and their figures are
 * unchanged - only the labels are, because the numbers were never the wrong part. A count
 * below the ceiling is still exactly a count, and reads the same; the
 * label no longer promises which case it is looking at, because the payload does not say.
 */
function quickStat(rows: readonly unknown[] | undefined, count: () => number): string {
  return rows === undefined ? "N/A" : String(count());
}

function QuickStatsCard({ data }: Readonly<{ data: MonitoringData | null }>) {
  const sessions = data?.activeSessions;

  return (
    <Card className="p-0">
      <CardHeader className="p-3 sm:p-4 pb-2">
        <CardTitle className="text-xs sm:text-xs font-medium flex items-center gap-2">
          <Hash strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
          Quick Stats
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 sm:p-4 pt-0 space-y-2 sm:space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-xs sm:text-xs text-muted-foreground">Listed slow queries</span>
          <Badge
            variant={data?.slowQueries?.length ? "outline" : "secondary"}
            className="text-xs"
            data-testid="quick-stat-slow-queries"
          >
            {quickStat(data?.slowQueries, () => (data?.slowQueries ?? []).length)}
          </Badge>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-xs sm:text-xs text-muted-foreground">Active of listed sessions</span>
          <Badge variant="secondary" className="text-xs" data-testid="quick-stat-active">
            {quickStat(sessions, () => (sessions ?? []).filter((s) => s.state === "active").length)}
          </Badge>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-xs sm:text-xs text-muted-foreground">Idle of listed sessions</span>
          <Badge variant="secondary" className="text-xs" data-testid="quick-stat-idle">
            {quickStat(sessions, () => (sessions ?? []).filter((s) => s.state === "idle").length)}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
