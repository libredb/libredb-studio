'use client';

import React from 'react';
import {
  Database,
  Zap,
  Activity,
  Clock,
  Table2,
  Hash,
  Server,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import type { MonitoringData } from '@/lib/db/types';

interface OverviewTabProps {
  data: MonitoringData | null;
  loading: boolean;
}

export function OverviewTab({ data, loading }: OverviewTabProps) {
  if (loading && !data) {
    return <OverviewSkeleton />;
  }

  const overview = data?.overview;
  const performance = data?.performance;

  const connectionPercent = overview
    ? Math.round((overview.activeConnections / overview.maxConnections) * 100)
    : 0;

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Version & Status */}
      <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
        <Badge variant="outline" className="gap-1.5 sm:gap-2 py-1 sm:py-1.5 px-2 sm:px-3 text-xs">
          <Server className="h-3 w-3 sm:h-4 sm:w-4" />
          <span className="truncate max-w-[120px] sm:max-w-none">{overview?.version || 'Unknown'}</span>
        </Badge>
        <Badge variant="secondary" className="gap-1.5 sm:gap-2 py-1 sm:py-1.5 px-2 sm:px-3 text-xs">
          <Clock className="h-3 w-3 sm:h-4 sm:w-4" />
          {overview?.uptime || 'N/A'}
        </Badge>
        {data?.timestamp && (
          <span className="text-[10px] sm:text-xs text-muted-foreground">
            {new Date(data.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Main Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
        {/* Active Connections */}
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground">
              Connections
            </CardTitle>
            <Zap className="h-3 w-3 sm:h-4 sm:w-4 text-yellow-500" />
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold">
              {overview?.activeConnections ?? 0}
              <span className="text-xs sm:text-sm font-normal text-muted-foreground">
                /{overview?.maxConnections ?? 0}
              </span>
            </div>
            <Progress value={connectionPercent} className="h-1 mt-1 sm:mt-2" />
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              {connectionPercent}% used
            </p>
          </CardContent>
        </Card>

        {/* Database Size */}
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground">
              DB Size
            </CardTitle>
            <Database className="h-3 w-3 sm:h-4 sm:w-4 text-blue-500" />
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold">{overview?.databaseSize || 'N/A'}</div>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              Total storage
            </p>
          </CardContent>
        </Card>

        {/* Cache Hit Ratio */}
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground">
              Cache Hit
            </CardTitle>
            <Activity className="h-3 w-3 sm:h-4 sm:w-4 text-green-500" />
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold">
              {performance?.cacheHitRatio?.toFixed(1) ?? 0}%
            </div>
            <Progress
              value={performance?.cacheHitRatio ?? 0}
              className="h-1 mt-1 sm:mt-2"
            />
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1 truncate">
              {(performance?.cacheHitRatio ?? 0) >= 90
                ? 'Excellent'
                : (performance?.cacheHitRatio ?? 0) >= 80
                  ? 'Good'
                  : 'Needs tuning'}
            </p>
          </CardContent>
        </Card>

        {/* Tables & Indexes */}
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground">
              Tables
            </CardTitle>
            <Table2 className="h-3 w-3 sm:h-4 sm:w-4 text-purple-500" />
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold">
              {overview?.tableCount ?? 0}
            </div>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              {overview?.indexCount ?? 0} indexes
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4">
        {/* Performance Metrics */}
        <Card className="p-0">
          <CardHeader className="p-3 sm:p-4 pb-2">
            <CardTitle className="text-xs sm:text-sm font-medium flex items-center gap-2">
              <Activity className="h-3 w-3 sm:h-4 sm:w-4" />
              Performance
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0 space-y-2 sm:space-y-3">
            <div className="flex justify-between items-center gap-2">
              <span className="text-xs sm:text-sm text-muted-foreground">Buffer Pool</span>
              <div className="flex items-center gap-1 sm:gap-2">
                <Progress
                  value={performance?.bufferPoolUsage ?? 0}
                  className="w-16 sm:w-24 h-1.5 sm:h-2"
                />
                <span className="text-xs sm:text-sm font-medium w-8 sm:w-12 text-right">
                  {performance?.bufferPoolUsage?.toFixed(0) ?? 0}%
                </span>
              </div>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs sm:text-sm text-muted-foreground">Deadlocks</span>
              <Badge variant={performance?.deadlocks ? 'destructive' : 'secondary'} className="text-xs">
                {performance?.deadlocks ?? 0}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs sm:text-sm text-muted-foreground">Checkpoint</span>
              <span className="text-xs sm:text-sm font-mono truncate max-w-[100px] sm:max-w-none">
                {performance?.checkpointWriteTime || 'N/A'}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Quick Stats */}
        <Card className="p-0">
          <CardHeader className="p-3 sm:p-4 pb-2">
            <CardTitle className="text-xs sm:text-sm font-medium flex items-center gap-2">
              <Hash className="h-3 w-3 sm:h-4 sm:w-4" />
              Quick Stats
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0 space-y-2 sm:space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-xs sm:text-sm text-muted-foreground">Slow Queries</span>
              <Badge variant={data?.slowQueries?.length ? 'outline' : 'secondary'} className="text-xs">
                {data?.slowQueries?.length ?? 0}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs sm:text-sm text-muted-foreground">Active</span>
              <Badge variant="secondary" className="text-xs">
                {data?.activeSessions?.filter((s) => s.state === 'active').length ?? 0}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs sm:text-sm text-muted-foreground">Idle</span>
              <Badge variant="secondary" className="text-xs">
                {data?.activeSessions?.filter((s) => s.state === 'idle').length ?? 0}
              </Badge>
            </div>
          </CardContent>
        </Card>
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
