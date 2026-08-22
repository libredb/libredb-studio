"use client";

import React from "react";
import { Activity, Gauge, Zap, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import type { MonitoringData } from "@/lib/db/types";
import type { TimeSeriesPoint } from "@/lib/time-series-buffer";
import { evaluateThreshold, getThresholdColor, DEFAULT_THRESHOLDS } from "@/lib/monitoring-thresholds";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import { MetricChart } from "./MetricChart";

/**
 * The spelling every card in this panel uses for a figure the engine never reported.
 * Same word as {@link CACHE_HIT_RATIO_UNAVAILABLE} and as the providers that already
 * say "N/A" for a ratio they cannot read; named for the panel because the buffer pool
 * and deadlock counters are not cache hit ratios.
 */
const METRIC_UNAVAILABLE = "N/A";

/**
 * One trend series, built from history. Missing samples are DROPPED, not zeroed: an
 * engine that cannot measure a cache hit ratio (Druid) reports none, and mapping that to
 * 0 would plot a measured 0% trend - exactly the fabricated metric the current-value
 * cards withhold. Dropping leaves an empty series, which `MetricTrendCard` renders as
 * "Not measured" rather than as a line along the floor.
 */
function metricSeries(
  history: TimeSeriesPoint<MonitoringData>[],
  read: (performance: MonitoringData["performance"] | undefined) => number | undefined,
): { timestamp: number; value: number }[] {
  return history.flatMap((h) => {
    const value = read(h.data.performance);
    return value === undefined ? [] : [{ timestamp: h.timestamp, value }];
  });
}

/**
 * Three states, not two, which is why this is a function and not the nested ternary it
 * replaces: no deadlock counter at all (Trino takes no locks, Cassandra and Druid omit
 * the field), a real count above zero, or a measured zero. The absence must not borrow
 * the green of an engine that looked and found none.
 */
function deadlockIconClass(deadlocks: number | undefined): string {
  if (deadlocks === undefined) return "text-muted-foreground";
  if (deadlocks > 0) return "text-red-500";
  return "text-green-500";
}

/**
 * One trend card. The three below differ only in their copy, colour and unit, and an
 * empty series is the dropped-sample case from `flatMap` above: the engine published no
 * reading, so the card says so instead of drawing a line along the floor. `heading` is
 * passed rather than derived from `title` because the deadlock card is labelled
 * "Deadlock Trend" while its chart is titled "Deadlocks".
 */
function MetricTrendCard({
  heading,
  title,
  data,
  color,
  unit,
}: Readonly<{
  heading: string;
  title: string;
  data: { timestamp: number; value: number }[];
  color: string;
  unit?: string;
}>) {
  return (
    <Card className="p-0">
      <CardHeader className="p-2 sm:p-3 pb-0">
        <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">{heading}</CardTitle>
      </CardHeader>
      <CardContent className="p-2 sm:p-3 pt-0">
        {data.length === 0 ? (
          <p className="text-xs sm:text-xs text-muted-foreground">Not measured</p>
        ) : (
          <MetricChart data={data} color={color} title={title} unit={unit} />
        )}
      </CardContent>
    </Card>
  );
}

interface PerformanceTabProps {
  data: MonitoringData | null;
  loading: boolean;
  history?: TimeSeriesPoint<MonitoringData>[];
}

export function PerformanceTab({ data, loading, history = [] }: PerformanceTabProps) {
  if (loading && !data) {
    return <PerformanceSkeleton />;
  }

  const performance = data?.performance;

  const getHealthStatus = (ratio: number) => {
    if (ratio >= 95) return { label: "Excellent", color: "text-green-500", bg: "bg-green-500" };
    if (ratio >= 90) return { label: "Good", color: "text-blue-500", bg: "bg-blue-500" };
    if (ratio >= 80) return { label: "Fair", color: "text-yellow-500", bg: "bg-yellow-500" };
    return { label: "Poor", color: "text-red-500", bg: "bg-red-500" };
  };

  // Optional on purpose: an engine that cannot measure its cache (Druid) reports
  // nothing, and a rating - or a red icon - for a number that does not exist would
  // be an invented verdict. No ratio, no status.
  const cacheHitRatio = performance?.cacheHitRatio;
  const cacheStatus =
    cacheHitRatio === undefined ? undefined : { ratio: cacheHitRatio, ...getHealthStatus(cacheHitRatio) };

  // Optional for the same reason: Trino "holds no buffer pool" and "takes no locks, so
  // there are no deadlocks to count" (providers/sql/trino/introspect.ts), Cassandra and
  // Druid omit both fields, and sqlite.ts sets bufferPoolUsage undefined outright. A
  // "0 %" bar rated "Poor", or a zero deadlock count badged "Healthy", is a verdict on a
  // measurement nobody made - and the deadlock one is a clean bill of health for an
  // operation the engine does not perform. A measured 0 (mongodb, mysql, sqlite) is a
  // real fact and keeps its rendering.
  const bufferPoolUsage = performance?.bufferPoolUsage;
  const bufferStatus =
    bufferPoolUsage === undefined ? undefined : { usage: bufferPoolUsage, ...getHealthStatus(bufferPoolUsage) };
  const deadlocks = performance?.deadlocks;

  // Threshold evaluations. An absent metric scores "healthy" so the card border stays
  // neutral: colouring it would rate the absence, which is what the stand-in 100 below
  // does for the cache ratio.
  const cacheThreshold = evaluateThreshold(
    cacheHitRatio ?? 100,
    DEFAULT_THRESHOLDS.find((t) => t.metric === "cacheHitRatio")!,
  );
  const bufferThreshold =
    bufferPoolUsage === undefined
      ? "healthy"
      : evaluateThreshold(bufferPoolUsage, DEFAULT_THRESHOLDS.find((t) => t.metric === "bufferPoolUsage")!);
  const deadlockThreshold =
    deadlocks === undefined
      ? "healthy"
      : evaluateThreshold(deadlocks, DEFAULT_THRESHOLDS.find((t) => t.metric === "deadlocks")!);

  // Build trend data from history. See `metricSeries` for why a missing sample is
  // dropped rather than read as a zero.
  const cacheHistory = metricSeries(history, (p) => p?.cacheHitRatio);
  const bufferHistory = metricSeries(history, (p) => p?.bufferPoolUsage);
  const deadlockHistory = metricSeries(history, (p) => p?.deadlocks);

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Key Metrics */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {/* Cache Hit Ratio */}
        <Card className={`p-0 border-2 transition-colors ${getThresholdColor(cacheThreshold)}`}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Cache Hit</CardTitle>
            <Activity
              strokeWidth={1.5}
              className={`h-3 w-3 sm:h-4 sm:w-4 ${cacheStatus?.color ?? "text-muted-foreground"}`}
            />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            {cacheStatus === undefined ? (
              <>
                <div className="flex items-end gap-1">
                  <span className="text-lg sm:text-3xl font-medium text-muted-foreground">
                    {CACHE_HIT_RATIO_UNAVAILABLE}
                  </span>
                </div>
                <p className="text-xs sm:text-xs text-muted-foreground mt-1 sm:mt-3">Not measured</p>
              </>
            ) : (
              <>
                <div className="flex items-end gap-1">
                  <span className="text-lg sm:text-3xl font-medium">{cacheStatus.ratio.toFixed(1)}</span>
                  <span className="text-xs sm:text-xl text-muted-foreground">%</span>
                </div>
                <Progress value={cacheStatus.ratio} className="h-1 sm:h-2 mt-1 sm:mt-3" />
                <div className="flex items-center justify-between mt-1 sm:mt-2">
                  <Badge variant="outline" className={`${cacheStatus.color} text-xs sm:text-xs`}>
                    {cacheStatus.label}
                  </Badge>
                  <span className="text-xs sm:text-xs text-muted-foreground hidden sm:inline">95%+</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Buffer Pool Usage */}
        <Card className={`p-0 border-2 transition-colors ${getThresholdColor(bufferThreshold)}`}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Buffer</CardTitle>
            <Gauge className={`h-3 w-3 sm:h-4 sm:w-4 ${bufferStatus?.color ?? "text-muted-foreground"}`} />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            {bufferStatus === undefined ? (
              <>
                <div className="flex items-end gap-1">
                  <span className="text-lg sm:text-3xl font-medium text-muted-foreground">{METRIC_UNAVAILABLE}</span>
                </div>
                <p className="text-xs sm:text-xs text-muted-foreground mt-1 sm:mt-3">Not measured</p>
              </>
            ) : (
              <>
                <div className="flex items-end gap-1">
                  <span className="text-lg sm:text-3xl font-medium">{bufferStatus.usage.toFixed(0)}</span>
                  <span className="text-xs sm:text-xl text-muted-foreground">%</span>
                </div>
                <Progress value={bufferStatus.usage} className="h-1 sm:h-2 mt-1 sm:mt-3" />
                <div className="flex items-center justify-between mt-1 sm:mt-2">
                  <Badge variant="outline" className={`${bufferStatus.color} text-xs sm:text-xs`}>
                    {bufferStatus.label}
                  </Badge>
                  <span className="text-xs sm:text-xs text-muted-foreground hidden sm:inline">Cache</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Deadlocks */}
        <Card className={`p-0 border-2 transition-colors ${getThresholdColor(deadlockThreshold)}`}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Deadlocks</CardTitle>
            <AlertTriangle className={`h-3 w-3 sm:h-4 sm:w-4 ${deadlockIconClass(deadlocks)}`} />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            {deadlocks === undefined ? (
              <>
                <div className="flex items-end gap-1">
                  <span className="text-lg sm:text-3xl font-medium text-muted-foreground">{METRIC_UNAVAILABLE}</span>
                </div>
                <p className="text-xs sm:text-xs text-muted-foreground mt-1 sm:mt-3">Not measured</p>
              </>
            ) : (
              <>
                <div className="flex items-end gap-1">
                  <span className="text-lg sm:text-3xl font-medium">{deadlocks}</span>
                </div>
                <p className="text-xs sm:text-xs text-muted-foreground mt-1 sm:mt-3 hidden sm:block">
                  {deadlocks ? "Review queries" : "None detected"}
                </p>
                <Badge variant={deadlocks ? "destructive" : "secondary"} className="mt-1 sm:mt-2 text-xs sm:text-xs">
                  {deadlocks ? "Attention" : "Healthy"}
                </Badge>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Trend Charts */}
      {history.length >= 2 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4">
          <MetricTrendCard heading="Cache Hit Trend" title="Cache Hit" data={cacheHistory} color="#22c55e" unit="%" />
          <MetricTrendCard
            heading="Buffer Pool Trend"
            title="Buffer Pool"
            data={bufferHistory}
            color="#3b82f6"
            unit="%"
          />
          <MetricTrendCard heading="Deadlock Trend" title="Deadlocks" data={deadlockHistory} color="#ef4444" />
        </div>
      )}

      {/* Additional Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4">
        {/* Checkpoint Stats */}
        <Card className="p-0">
          <CardHeader className="p-3 sm:p-4 pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium flex items-center gap-2">
              <Zap strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
              Checkpoint Stats
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0 space-y-2 sm:space-y-4">
            <div className="p-2 sm:p-4 bg-muted/30 rounded-lg">
              <p className="text-xs sm:text-xs text-muted-foreground">Write & Sync</p>
              <p className="text-xs sm:text-lg font-mono mt-1 truncate">{performance?.checkpointWriteTime || "N/A"}</p>
            </div>
            <p className="text-xs sm:text-xs text-muted-foreground hidden sm:block">
              Checkpoint write time affects database performance during heavy writes.
            </p>
          </CardContent>
        </Card>

        {/* Performance Tips */}
        <Card className="p-0">
          <CardHeader className="p-3 sm:p-4 pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium flex items-center gap-2">
              <Activity strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
              Tips
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0 space-y-2 sm:space-y-3">
            {/* Guarded on the ratio existing, not on a stand-in value: there is
                nothing to advise about a cache nobody measured. */}
            {cacheHitRatio !== undefined && cacheHitRatio < 90 && (
              <div className="flex items-start gap-2 p-2 bg-yellow-500/10 rounded-md">
                <AlertTriangle
                  strokeWidth={1.5}
                  className="h-3 w-3 sm:h-4 sm:w-4 text-yellow-500 mt-0.5 flex-shrink-0"
                />
                <div>
                  <p className="text-xs sm:text-xs font-medium">Low Cache Hit</p>
                  <p className="text-xs sm:text-xs text-muted-foreground hidden sm:block">Increase shared_buffers</p>
                </div>
              </div>
            )}
            {(performance?.deadlocks ?? 0) > 0 && (
              <div className="flex items-start gap-2 p-2 bg-red-500/10 rounded-md">
                <AlertTriangle strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-red-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs sm:text-xs font-medium">Deadlocks</p>
                  <p className="text-xs sm:text-xs text-muted-foreground hidden sm:block">Review lock ordering</p>
                </div>
              </div>
            )}
            {cacheHitRatio !== undefined && cacheHitRatio >= 90 && !performance?.deadlocks && (
              <div className="flex items-center gap-2 p-2 bg-green-500/10 rounded-md">
                <Activity strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-green-500 flex-shrink-0" />
                <p className="text-xs sm:text-xs">Performing well!</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PerformanceSkeleton() {
  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {[...Array(3)].map((_, i) => (
          <Card key={i} className="p-0">
            <CardHeader className="p-2 sm:p-4 pb-1 sm:pb-2">
              <Skeleton className="h-3 sm:h-4 w-12 sm:w-24" />
            </CardHeader>
            <CardContent className="p-2 sm:p-4 pt-0">
              <Skeleton className="h-5 sm:h-10 w-10 sm:w-24" />
              <Skeleton className="h-1 sm:h-2 w-full mt-1 sm:mt-3" />
              <Skeleton className="h-4 sm:h-6 w-12 sm:w-20 mt-1 sm:mt-2" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
