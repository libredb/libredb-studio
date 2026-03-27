'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Server, Activity, Clock, Loader2, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import type { DatabaseConnection } from '@/lib/types';

interface PoolStats {
  total: number;
  idle: number;
  active: number;
  waiting: number;
  message?: string;
}

interface PoolTabProps {
  connection: DatabaseConnection | null;
}

export function PoolTab({ connection }: PoolTabProps) {
  const [stats, setStats] = useState<PoolStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    if (!connection) return;
    setLoading(true);
    try {
      const res = await fetch('/api/db/pool-stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch pool stats');
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  if (!connection) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Select a connection to view pool statistics
      </div>
    );
  }

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
        <Loader2 strokeWidth={1.5} className="h-4 w-4 animate-spin" />
        Loading pool statistics...
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-destructive">
        <p className="text-xs">{error}</p>
        <Button variant="outline" size="sm" onClick={fetchStats}>Try Again</Button>
      </div>
    );
  }

  const usagePercent = stats && stats.total > 0
    ? Math.round((stats.active / stats.total) * 100)
    : 0;

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server strokeWidth={1.5} className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          <h2 className="text-xs sm:text-base font-medium">Connection Pool</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={fetchStats}
          disabled={loading}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {stats?.message && (
        <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-3">
          {stats.message}
        </div>
      )}

      {/* Pool Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">
              Total
            </CardTitle>
            <Server strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-blue-500" />
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{stats?.total ?? 0}</div>
            <p className="text-xs sm:text-xs text-muted-foreground mt-1">
              Max pool size
            </p>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">
              Active
            </CardTitle>
            <Activity strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-green-500" />
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{stats?.active ?? 0}</div>
            <Progress value={usagePercent} className="h-1 mt-1 sm:mt-2" />
            <p className="text-xs sm:text-xs text-muted-foreground mt-1">
              {usagePercent}% utilized
            </p>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">
              Idle
            </CardTitle>
            <Clock strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-yellow-500" />
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{stats?.idle ?? 0}</div>
            <p className="text-xs sm:text-xs text-muted-foreground mt-1">
              Available
            </p>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">
              Waiting
            </CardTitle>
            <Badge variant={stats?.waiting ? 'destructive' : 'secondary'} className="text-xs">
              {stats?.waiting ?? 0}
            </Badge>
          </CardHeader>
          <CardContent className="p-3 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium">{stats?.waiting ?? 0}</div>
            <p className="text-xs sm:text-xs text-muted-foreground mt-1">
              {stats?.waiting ? 'Queued requests' : 'No queue'}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
