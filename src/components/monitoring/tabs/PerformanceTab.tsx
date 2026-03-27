'use client';

import React from 'react';
import { Activity, Gauge, Zap, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import type { MonitoringData } from '@/lib/db/types';
import type { TimeSeriesPoint } from '@/lib/time-series-buffer';
import { evaluateThreshold, getThresholdColor, DEFAULT_THRESHOLDS } from '@/lib/monitoring-thresholds';
import { MetricChart } from './MetricChart';

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
    if (ratio >= 95) return { label: 'Excellent', color: 'text-green-500', bg: 'bg-green-500' };
    if (ratio >= 90) return { label: 'Good', color: 'text-blue-500', bg: 'bg-blue-500' };
    if (ratio >= 80) return { label: 'Fair', color: 'text-yellow-500', bg: 'bg-yellow-500' };
    return { label: 'Poor', color: 'text-red-500', bg: 'bg-red-500' };
  };

  const cacheStatus = getHealthStatus(performance?.cacheHitRatio ?? 0);
  const bufferStatus = getHealthStatus(performance?.bufferPoolUsage ?? 0);

  // Threshold evaluations
  const cacheThreshold = evaluateThreshold(performance?.cacheHitRatio ?? 100, DEFAULT_THRESHOLDS.find(t => t.metric === 'cacheHitRatio')!);
  const bufferThreshold = evaluateThreshold(performance?.bufferPoolUsage ?? 0, DEFAULT_THRESHOLDS.find(t => t.metric === 'bufferPoolUsage')!);
  const deadlockThreshold = evaluateThreshold(performance?.deadlocks ?? 0, DEFAULT_THRESHOLDS.find(t => t.metric === 'deadlocks')!);

  // Build trend data from history
  const cacheHistory = history.map(h => ({ timestamp: h.timestamp, value: h.data.performance?.cacheHitRatio ?? 0 }));
  const bufferHistory = history.map(h => ({ timestamp: h.timestamp, value: h.data.performance?.bufferPoolUsage ?? 0 }));
  const deadlockHistory = history.map(h => ({ timestamp: h.timestamp, value: h.data.performance?.deadlocks ?? 0 }));

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Key Metrics */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {/* Cache Hit Ratio */}
        <Card className={`p-0 border-2 transition-colors ${getThresholdColor(cacheThreshold)}`}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">
              Cache Hit
            </CardTitle>
            <Activity className={`h-3 w-3 sm:h-4 sm:w-4 ${cacheStatus.color}`} />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="flex items-end gap-1">
              <span className="text-lg sm:text-3xl font-medium">
                {performance?.cacheHitRatio?.toFixed(1) ?? 0}
              </span>
              <span className="text-xs sm:text-xl text-muted-foreground">%</span>
            </div>
            <Progress
              value={performance?.cacheHitRatio ?? 0}
              className="h-1 sm:h-2 mt-1 sm:mt-3"
            />
            <div className="flex items-center justify-between mt-1 sm:mt-2">
              <Badge variant="outline" className={`${cacheStatus.color} text-xs sm:text-xs`}>
                {cacheStatus.label}
              </Badge>
              <span className="text-xs sm:text-xs text-muted-foreground hidden sm:inline">95%+</span>
            </div>
          </CardContent>
        </Card>

        {/* Buffer Pool Usage */}
        <Card className={`p-0 border-2 transition-colors ${getThresholdColor(bufferThreshold)}`}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">
              Buffer
            </CardTitle>
            <Gauge className={`h-3 w-3 sm:h-4 sm:w-4 ${bufferStatus.color}`} />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="flex items-end gap-1">
              <span className="text-lg sm:text-3xl font-medium">
                {performance?.bufferPoolUsage?.toFixed(0) ?? 0}
              </span>
              <span className="text-xs sm:text-xl text-muted-foreground">%</span>
            </div>
            <Progress
              value={performance?.bufferPoolUsage ?? 0}
              className="h-1 sm:h-2 mt-1 sm:mt-3"
            />
            <div className="flex items-center justify-between mt-1 sm:mt-2">
              <Badge variant="outline" className={`${bufferStatus.color} text-xs sm:text-xs`}>
                {bufferStatus.label}
              </Badge>
              <span className="text-xs sm:text-xs text-muted-foreground hidden sm:inline">Cache</span>
            </div>
          </CardContent>
        </Card>

        {/* Deadlocks */}
        <Card className={`p-0 border-2 transition-colors ${getThresholdColor(deadlockThreshold)}`}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">
              Deadlocks
            </CardTitle>
            <AlertTriangle
              className={`h-3 w-3 sm:h-4 sm:w-4 ${performance?.deadlocks ? 'text-red-500' : 'text-green-500'}`}
            />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="flex items-end gap-1">
              <span className="text-lg sm:text-3xl font-medium">
                {performance?.deadlocks ?? 0}
              </span>
            </div>
            <p className="text-xs sm:text-xs text-muted-foreground mt-1 sm:mt-3 hidden sm:block">
              {performance?.deadlocks
                ? 'Review queries'
                : 'None detected'}
            </p>
            <Badge
              variant={performance?.deadlocks ? 'destructive' : 'secondary'}
              className="mt-1 sm:mt-2 text-xs sm:text-xs"
            >
              {performance?.deadlocks ? 'Attention' : 'Healthy'}
            </Badge>
          </CardContent>
        </Card>
      </div>

      {/* Trend Charts */}
      {history.length >= 2 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4">
          <Card className="p-0">
            <CardHeader className="p-2 sm:p-3 pb-0">
              <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Cache Hit Trend</CardTitle>
            </CardHeader>
            <CardContent className="p-2 sm:p-3 pt-0">
              <MetricChart data={cacheHistory} color="#22c55e" title="Cache Hit" unit="%" />
            </CardContent>
          </Card>
          <Card className="p-0">
            <CardHeader className="p-2 sm:p-3 pb-0">
              <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Buffer Pool Trend</CardTitle>
            </CardHeader>
            <CardContent className="p-2 sm:p-3 pt-0">
              <MetricChart data={bufferHistory} color="#3b82f6" title="Buffer Pool" unit="%" />
            </CardContent>
          </Card>
          <Card className="p-0">
            <CardHeader className="p-2 sm:p-3 pb-0">
              <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Deadlock Trend</CardTitle>
            </CardHeader>
            <CardContent className="p-2 sm:p-3 pt-0">
              <MetricChart data={deadlockHistory} color="#ef4444" title="Deadlocks" />
            </CardContent>
          </Card>
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
              <p className="text-xs sm:text-lg font-mono mt-1 truncate">
                {performance?.checkpointWriteTime || 'N/A'}
              </p>
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
            {(performance?.cacheHitRatio ?? 100) < 90 && (
              <div className="flex items-start gap-2 p-2 bg-yellow-500/10 rounded-md">
                <AlertTriangle strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-yellow-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs sm:text-xs font-medium">Low Cache Hit</p>
                  <p className="text-xs sm:text-xs text-muted-foreground hidden sm:block">
                    Increase shared_buffers
                  </p>
                </div>
              </div>
            )}
            {(performance?.deadlocks ?? 0) > 0 && (
              <div className="flex items-start gap-2 p-2 bg-red-500/10 rounded-md">
                <AlertTriangle strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-red-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs sm:text-xs font-medium">Deadlocks</p>
                  <p className="text-xs sm:text-xs text-muted-foreground hidden sm:block">
                    Review lock ordering
                  </p>
                </div>
              </div>
            )}
            {(performance?.cacheHitRatio ?? 0) >= 90 && !(performance?.deadlocks) && (
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
