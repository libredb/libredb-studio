"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Server, Activity, Clock, Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import type { DatabaseConnection } from "@/lib/types";
import { buildConnectionPayload } from "@/hooks/use-connection-payload";

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
      const res = await fetch("/api/db/pool-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The seed id, not the object: a managed connection arrives here with its
        // password and connection string stripped, so the object cannot be resolved
        // to a database once the provider cache is cold.
        body: JSON.stringify(buildConnectionPayload(connection)),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch pool stats");
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
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
        <Button variant="outline" size="sm" onClick={fetchStats}>
          Try Again
        </Button>
      </div>
    );
  }

  // Absence and zero are different inputs. `/api/db/pool-stats` answers a literal
  // `{total: 0, idle: 0, active: 0, waiting: 0, message: "Pool statistics not available
  // for this provider"}` for every provider without `getPoolStats` - only postgres,
  // oracle and mssql have one, so Cassandra, MySQL, SQLite, ClickHouse, Druid, Trino,
  // Mongo, Redis and Couchbase all land there - and `stats === null` is the state of the
  // very first paint, before any request has been made. In both cases nothing was
  // inspected, so `message` (present in exactly the unmeasured case) is what separates
  // them from a real reading: postgres before its pool opens returns an all-zero body
  // with no message, and that IS a measurement - 0 connections, truthfully - which keeps
  // the arithmetic and the labels below unchanged.
  const measured = stats !== null && stats.message === undefined ? stats : null;
  const usagePercent =
    measured !== null && measured.total > 0 ? Math.round((measured.active / measured.total) * 100) : 0;

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server strokeWidth={1.5} className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          <h2 className="text-xs sm:text-base font-medium">Connection Pool</h2>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={fetchStats} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {measured === null && (
        <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-3">
          {stats?.message ?? "No connection pool information available."}
        </div>
      )}

      {/* Pool Stats Cards */}
      <PoolStatsGrid measured={measured} usagePercent={usagePercent} />
    </div>
  );
}

/**
 * The four figures, once `PoolTab` has decided whether anything was measured.
 * `measured === null` is the unmeasured case for every card at once, so each renders
 * "N/A" and drops its sub-label rather than showing a zero nobody read.
 */
function PoolStatsGrid({ measured, usagePercent }: Readonly<{ measured: PoolStats | null; usagePercent: number }>) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
      <Card className="p-0">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
          <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Total</CardTitle>
          <Server strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-blue-500" />
        </CardHeader>
        <CardContent className="p-3 sm:p-4 pt-0">
          <div className="text-lg sm:text-2xl font-medium">{measured !== null ? measured.total : "N/A"}</div>
          {measured !== null && <p className="text-xs sm:text-xs text-muted-foreground mt-1">Max pool size</p>}
        </CardContent>
      </Card>

      <Card className="p-0">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
          <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Active</CardTitle>
          <Activity strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-green-500" />
        </CardHeader>
        <CardContent className="p-3 sm:p-4 pt-0">
          <div className="text-lg sm:text-2xl font-medium">{measured !== null ? measured.active : "N/A"}</div>
          {measured !== null && (
            <>
              <Progress value={usagePercent} className="h-1 mt-1 sm:mt-2" />
              <p className="text-xs sm:text-xs text-muted-foreground mt-1">{usagePercent}% utilized</p>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="p-0">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
          <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Idle</CardTitle>
          <Clock strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-yellow-500" />
        </CardHeader>
        <CardContent className="p-3 sm:p-4 pt-0">
          <div className="text-lg sm:text-2xl font-medium">{measured !== null ? measured.idle : "N/A"}</div>
          {measured !== null && <p className="text-xs sm:text-xs text-muted-foreground mt-1">Available</p>}
        </CardContent>
      </Card>

      <Card className="p-0">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3 sm:p-4 pb-1 sm:pb-2">
          <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Waiting</CardTitle>
          {measured !== null && (
            <Badge variant={measured.waiting ? "destructive" : "secondary"} className="text-xs">
              {measured.waiting}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="p-3 sm:p-4 pt-0">
          <div className="text-lg sm:text-2xl font-medium">{measured !== null ? measured.waiting : "N/A"}</div>
          {measured !== null && (
            <p className="text-xs sm:text-xs text-muted-foreground mt-1">
              {measured.waiting ? "Queued requests" : "No queue"}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
