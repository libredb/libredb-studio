'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { storage } from '@/lib/storage';
import { getDBConfig, getDBIcon, getDBColor } from '@/lib/db-ui-config';
import {
  type DatabaseType,
  type DatabaseConnection,
  type QueryHistoryItem,
  ENVIRONMENT_COLORS,
  ENVIRONMENT_LABELS,
} from '@/lib/types';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format, subDays, startOfDay } from 'date-fns';
import {
  Link2,
  Activity,
  Bookmark,
  Server,
  RefreshCw,
} from 'lucide-react';
import type { FleetHealthItem } from '@/app/api/admin/fleet-health/route';

interface OverviewTabProps {
  user: { username: string; role: string } | null;
}

const APP_VERSION = '0.6.16';

export function OverviewTab({ user }: OverviewTabProps) {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);
  const [savedQueryCount, setSavedQueryCount] = useState(0);
  const [snapshotCount, setSnapshotCount] = useState(0);
  const [chartCount, setChartCount] = useState(0);
  const [fleetHealth, setFleetHealth] = useState<FleetHealthItem[]>([]);
  const [fleetLoading, setFleetLoading] = useState(false);

  useEffect(() => {
    const conns = storage.getConnections();
    setConnections(conns);
    setHistory(storage.getHistory());
    setSavedQueryCount(storage.getSavedQueries().length);
    setSnapshotCount(storage.getSchemaSnapshots().length);
    setChartCount(storage.getSavedCharts().length);
  }, []);

  const fetchFleetHealth = useCallback(async () => {
    if (connections.length === 0) return;
    const nonDemo = connections.filter((c) => !c.isDemo);
    if (nonDemo.length === 0) return;

    setFleetLoading(true);
    try {
      const res = await fetch('/api/admin/fleet-health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections: nonDemo }),
      });
      const data = await res.json();
      if (data.results) setFleetHealth(data.results);
    } catch {
      // silently fail
    } finally {
      setFleetLoading(false);
    }
  }, [connections]);

  useEffect(() => {
    if (connections.length > 0) fetchFleetHealth();
  }, [connections, fetchFleetHealth]);

  // Auto-refresh fleet health every 60 seconds
  useEffect(() => {
    if (connections.length === 0) return;
    const interval = setInterval(fetchFleetHealth, 60000);
    return () => clearInterval(interval);
  }, [connections, fetchFleetHealth]);

  const connectionsByType = useMemo(() => {
    const map: Partial<Record<DatabaseType, number>> = {};
    for (const conn of connections) {
      map[conn.type] = (map[conn.type] || 0) + 1;
    }
    return map;
  }, [connections]);

  const queryStats = useMemo(() => {
    const total = history.length;
    const successful = history.filter((h) => h.status === 'success').length;
    const successRate = total > 0 ? Math.round((successful / total) * 100) : 0;
    const avgTime =
      total > 0
        ? Math.round(
            history.reduce((sum, h) => sum + h.executionTime, 0) / total
          )
        : 0;

    const now = new Date();
    const byDay: { day: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = startOfDay(subDays(now, i));
      const dayEnd = startOfDay(subDays(now, i - 1));
      const count = history.filter((h) => {
        const t = new Date(h.executedAt).getTime();
        return t >= dayStart.getTime() && t < dayEnd.getTime();
      }).length;
      byDay.push({ day: format(dayStart, 'EEE'), count });
    }

    const freq: Record<string, { name: string; count: number }> = {};
    for (const h of history) {
      const key = h.connectionId;
      if (!freq[key]) {
        freq[key] = { name: h.connectionName || key.slice(0, 8), count: 0 };
      }
      freq[key].count++;
    }
    const topConnections = Object.values(freq)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return { total, successful, successRate, avgTime, byDay, topConnections };
  }, [history]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy':
        return {
          dot: 'bg-emerald-500',
          border: 'border-emerald-500/20',
          glow: 'hover:shadow-[0_0_20px_rgba(16,185,129,0.1)]',
          bg: 'bg-emerald-500/5',
        };
      case 'degraded':
        return {
          dot: 'bg-amber-500',
          border: 'border-amber-500/20',
          glow: 'hover:shadow-[0_0_20px_rgba(245,158,11,0.1)]',
          bg: 'bg-amber-500/5',
        };
      default:
        return {
          dot: 'bg-red-500',
          border: 'border-red-500/20',
          glow: 'hover:shadow-[0_0_20px_rgba(239,68,68,0.1)]',
          bg: 'bg-red-500/5',
        };
    }
  };

  return (
    <div className="space-y-6">
      {/* Fleet Health Section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-400" />
            <h2 className="text-sm font-bold text-zinc-300">Fleet Health</h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[10px] text-zinc-500 hover:text-zinc-300"
            onClick={fetchFleetHealth}
            disabled={fleetLoading}
          >
            <RefreshCw
              className={`w-3 h-3 mr-1.5 ${fleetLoading ? 'animate-spin' : ''}`}
            />
            Refresh
          </Button>
        </div>

        {connections.filter((c) => !c.isDemo).length === 0 ? (
          <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-8 text-center">
            <Server className="h-8 w-8 text-zinc-600 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">
              No database connections configured yet.
            </p>
          </div>
        ) : fleetLoading && fleetHealth.length === 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-white/5 bg-zinc-900/50 p-4"
              >
                <Skeleton className="h-4 w-24 mb-3 bg-zinc-800" />
                <Skeleton className="h-3 w-32 mb-2 bg-zinc-800" />
                <Skeleton className="h-3 w-20 bg-zinc-800" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {fleetHealth.map((item) => {
              const colors = getStatusColor(item.status);
              const Icon = getDBIcon(item.type as DatabaseType);
              return (
                <a
                  key={item.connectionId}
                  href={`/monitoring`}
                  className={`group rounded-xl border ${colors.border} ${colors.bg} bg-zinc-900/50 p-4 transition-all duration-200 hover:bg-white/[0.04] ${colors.glow} cursor-pointer block`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-2 h-2 rounded-full ${colors.dot} ${item.status === 'healthy' ? 'animate-pulse' : ''}`}
                      />
                      <span className="text-sm font-medium text-zinc-200 truncate max-w-[150px]">
                        {item.connectionName}
                      </span>
                    </div>
                    <div className="p-1 rounded bg-white/[0.04]">
                      <Icon
                        className={`w-3.5 h-3.5 ${getDBColor(item.type as DatabaseType)}`}
                      />
                    </div>
                  </div>
                  <div className="space-y-1 text-[11px] text-zinc-500">
                    {item.activeConnections !== undefined && (
                      <div className="flex justify-between">
                        <span>Connections</span>
                        <span className="font-mono text-zinc-400">
                          {item.activeConnections}
                        </span>
                      </div>
                    )}
                    {item.databaseSize && (
                      <div className="flex justify-between">
                        <span>Size</span>
                        <span className="font-mono text-zinc-400">
                          {item.databaseSize}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span>Latency</span>
                      <span className="font-mono text-zinc-400">
                        {item.status === 'error'
                          ? 'timeout'
                          : `${item.latencyMs}ms`}
                      </span>
                    </div>
                    {item.error && (
                      <div className="text-red-400 text-[10px] truncate mt-1">
                        {item.error}
                      </div>
                    )}
                    {item.environment && (
                      <div className="mt-1">
                        <Badge
                          variant="outline"
                          className="text-[9px] h-4"
                          style={{
                            borderColor:
                              ENVIRONMENT_COLORS[
                                item.environment as keyof typeof ENVIRONMENT_COLORS
                              ],
                            color:
                              ENVIRONMENT_COLORS[
                                item.environment as keyof typeof ENVIRONMENT_COLORS
                              ],
                          }}
                        >
                          {ENVIRONMENT_LABELS[
                            item.environment as keyof typeof ENVIRONMENT_LABELS
                          ] || item.environment}
                        </Badge>
                      </div>
                    )}
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>

      <Separator className="bg-white/5" />

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* App Info */}
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">
              App Info
            </span>
            <Server className="h-4 w-4 text-zinc-600" />
          </div>
          <div className="flex items-center gap-2 mb-2">
            <Badge
              variant="outline"
              className="font-mono text-xs border-white/10 text-zinc-400"
            >
              v{APP_VERSION}
            </Badge>
          </div>
          {user && (
            <div className="space-y-1 text-sm">
              <div className="text-zinc-500">{user.username}</div>
              <Badge
                variant={user.role === 'admin' ? 'default' : 'secondary'}
                className="text-[10px] uppercase"
              >
                {user.role}
              </Badge>
            </div>
          )}
        </div>

        {/* Connections */}
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">
              Connections
            </span>
            <Link2 className="h-4 w-4 text-zinc-600" />
          </div>
          <div className="text-3xl font-bold text-zinc-100 tabular-nums">
            {connections.length}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {Object.entries(connectionsByType).map(([type, count]) => {
              const config = getDBConfig(type as DatabaseType);
              return (
                <Badge
                  key={type}
                  variant="outline"
                  className="text-[10px] gap-1 border-white/10"
                >
                  <span className={getDBColor(type as DatabaseType)}>
                    {config.label}
                  </span>
                  : {count}
                </Badge>
              );
            })}
          </div>
        </div>

        {/* Query Activity */}
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">
              Query Activity
            </span>
            <Activity className="h-4 w-4 text-zinc-600" />
          </div>
          <div className="text-3xl font-bold text-zinc-100 tabular-nums">
            {queryStats.total}
          </div>
          <div className="space-y-1 mt-2">
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>Success rate</span>
              <span className="text-zinc-400">{queryStats.successRate}%</span>
            </div>
            <Progress value={queryStats.successRate} className="h-1.5" />
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            Avg. {queryStats.avgTime}ms
          </div>
        </div>

        {/* Saved Items */}
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">
              Saved Items
            </span>
            <Bookmark className="h-4 w-4 text-zinc-600" />
          </div>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Queries</span>
              <span className="font-medium text-zinc-300">{savedQueryCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Snapshots</span>
              <span className="font-medium text-zinc-300">{snapshotCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Charts</span>
              <span className="font-medium text-zinc-300">{chartCount}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Connection Inventory + Query Activity Chart */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Connection Inventory */}
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5">
          <h3 className="text-sm font-bold text-zinc-300 mb-4">
            Connection Inventory
          </h3>
          {connections.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-zinc-600">
              No connections configured yet.
            </div>
          ) : (
            <div className="max-h-[300px] overflow-y-auto editor-scrollbar">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-900 text-left text-xs text-zinc-500">
                  <tr>
                    <th className="pb-2 font-medium">Name</th>
                    <th className="pb-2 font-medium">Type</th>
                    <th className="pb-2 font-medium">Env</th>
                    <th className="pb-2 font-medium text-right">Host</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {connections.map((conn) => {
                    const Icon = getDBIcon(conn.type);
                    const config = getDBConfig(conn.type);
                    const envLabel = conn.environment
                      ? ENVIRONMENT_LABELS[conn.environment]
                      : '';
                    const envColor = conn.environment
                      ? ENVIRONMENT_COLORS[conn.environment]
                      : undefined;
                    const healthItem = fleetHealth.find(
                      (h) => h.connectionId === conn.id
                    );
                    return (
                      <tr key={conn.id} className="h-9 hover:bg-white/[0.03] transition-colors">
                        <td className="flex items-center gap-2 py-1.5">
                          {healthItem && (
                            <div
                              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                healthItem.status === 'healthy'
                                  ? 'bg-emerald-500'
                                  : healthItem.status === 'degraded'
                                    ? 'bg-amber-500'
                                    : 'bg-red-500'
                              }`}
                            />
                          )}
                          <Icon
                            className={`h-4 w-4 shrink-0 ${getDBColor(conn.type)}`}
                          />
                          <span className="truncate max-w-[120px] text-zinc-300">
                            {conn.name}
                          </span>
                        </td>
                        <td>
                          <Badge
                            variant="outline"
                            className="text-[10px] border-white/10"
                          >
                            {config.label}
                          </Badge>
                        </td>
                        <td>
                          {envLabel && (
                            <Badge
                              variant="outline"
                              className="text-[10px]"
                              style={{
                                borderColor: envColor,
                                color: envColor,
                              }}
                            >
                              {envLabel}
                            </Badge>
                          )}
                        </td>
                        <td className="text-right text-xs text-zinc-500 truncate max-w-[100px]">
                          {conn.host || conn.database || '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Query Activity Chart */}
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5">
          <h3 className="text-sm font-bold text-zinc-300 mb-4">
            Query Activity (7 days)
          </h3>
          {queryStats.total === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-zinc-600">
              No query history yet.
            </div>
          ) : (
            <>
              <div className="h-[180px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={queryStats.byDay}>
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 11, fill: '#71717a' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: '#71717a' }}
                      axisLine={false}
                      tickLine={false}
                      width={30}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#18181b',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        fontSize: 12,
                        color: '#a1a1aa',
                      }}
                    />
                    <Bar
                      dataKey="count"
                      name="Queries"
                      fill="#3b82f6"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {queryStats.topConnections.length > 0 && (
                <>
                  <Separator className="my-3 bg-white/5" />
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-zinc-500">
                      Most Used Connections
                    </div>
                    {queryStats.topConnections.map((tc) => {
                      const pct =
                        queryStats.total > 0
                          ? Math.round((tc.count / queryStats.total) * 100)
                          : 0;
                      return (
                        <div key={tc.name} className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="truncate max-w-[140px] text-zinc-400">
                              {tc.name}
                            </span>
                            <span className="text-zinc-500">
                              {tc.count} ({pct}%)
                            </span>
                          </div>
                          <Progress value={pct} className="h-1" />
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
