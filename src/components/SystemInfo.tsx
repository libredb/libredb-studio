'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
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
  Lock,
  KeyRound,
  Server,
  Globe,
} from 'lucide-react';

interface SystemInfoProps {
  user: { username: string; role: string } | null;
}

const APP_VERSION = '0.6.16';

const ALL_DB_TYPES: DatabaseType[] = [
  'postgres',
  'mysql',
  'sqlite',
  'mongodb',
  'redis',
  'oracle',
  'mssql',
  'demo',
];

export function SystemInfo({ user }: SystemInfoProps) {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);
  const [savedQueryCount, setSavedQueryCount] = useState(0);
  const [snapshotCount, setSnapshotCount] = useState(0);
  const [chartCount, setChartCount] = useState(0);

  useEffect(() => {
    setConnections(storage.getConnections());
    setHistory(storage.getHistory());
    setSavedQueryCount(storage.getSavedQueries().length);
    setSnapshotCount(storage.getSchemaSnapshots().length);
    setChartCount(storage.getSavedCharts().length);
  }, []);

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
    const failed = total - successful;
    const successRate = total > 0 ? Math.round((successful / total) * 100) : 0;
    const avgTime =
      total > 0
        ? Math.round(
            history.reduce((sum, h) => sum + h.executionTime, 0) / total
          )
        : 0;

    // Last 7 days
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

    // Top connections by frequency
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

    return { total, successful, failed, successRate, avgTime, byDay, topConnections };
  }, [history]);

  return (
    <div className="space-y-6">
      {/* Section 1: Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* App Info */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">App Info</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono text-xs">
                v{APP_VERSION}
              </Badge>
            </div>
            {user && (
              <div className="space-y-1 text-sm">
                <div className="text-muted-foreground">
                  {user.username}
                </div>
                <Badge
                  variant={user.role === 'admin' ? 'default' : 'secondary'}
                  className="text-[10px] uppercase"
                >
                  {user.role}
                </Badge>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Connections */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Connections</CardTitle>
            <Link2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{connections.length}</div>
            <div className="mt-2 flex flex-wrap gap-1">
              {Object.entries(connectionsByType).map(([type, count]) => {
                const config = getDBConfig(type as DatabaseType);
                return (
                  <Badge
                    key={type}
                    variant="outline"
                    className="text-[10px] gap-1"
                  >
                    <span className={getDBColor(type as DatabaseType)}>
                      {config.label}
                    </span>
                    : {count}
                  </Badge>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Query Activity */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Query Activity</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-3xl font-bold">{queryStats.total}</div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Success rate</span>
                <span>{queryStats.successRate}%</span>
              </div>
              <Progress value={queryStats.successRate} className="h-1.5" />
            </div>
            <div className="text-xs text-muted-foreground">
              Avg. {queryStats.avgTime}ms
            </div>
          </CardContent>
        </Card>

        {/* Saved Items */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Saved Items</CardTitle>
            <Bookmark className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Queries</span>
              <span className="font-medium">{savedQueryCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Snapshots</span>
              <span className="font-medium">{snapshotCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Charts</span>
              <span className="font-medium">{chartCount}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Section 2: Two Column Grid */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Connection Inventory */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connection Inventory</CardTitle>
          </CardHeader>
          <CardContent>
            {connections.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                No connections configured yet.
              </div>
            ) : (
              <div className="max-h-[300px] overflow-y-auto editor-scrollbar">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="pb-2 font-medium">Name</th>
                      <th className="pb-2 font-medium">Type</th>
                      <th className="pb-2 font-medium">Env</th>
                      <th className="pb-2 font-medium text-right">Host</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {connections.map((conn) => {
                      const Icon = getDBIcon(conn.type);
                      const config = getDBConfig(conn.type);
                      const envLabel = conn.environment
                        ? ENVIRONMENT_LABELS[conn.environment]
                        : '';
                      const envColor = conn.environment
                        ? ENVIRONMENT_COLORS[conn.environment]
                        : undefined;
                      return (
                        <tr key={conn.id} className="h-9">
                          <td className="flex items-center gap-2 py-1.5">
                            <Icon
                              className={`h-4 w-4 shrink-0 ${getDBColor(conn.type)}`}
                            />
                            <span className="truncate max-w-[120px]">
                              {conn.name}
                            </span>
                          </td>
                          <td>
                            <Badge variant="outline" className="text-[10px]">
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
                          <td className="text-right text-xs text-muted-foreground truncate max-w-[100px]">
                            {conn.host || conn.database || '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Query Activity Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Query Activity (7 days)</CardTitle>
          </CardHeader>
          <CardContent>
            {queryStats.total === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                No query history yet.
              </div>
            ) : (
              <>
                <div className="h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={queryStats.byDay}>
                      <XAxis
                        dataKey="day"
                        tick={{ fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                        width={30}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--card))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '6px',
                          fontSize: 12,
                        }}
                      />
                      <Bar
                        dataKey="count"
                        name="Queries"
                        fill="hsl(var(--primary))"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {queryStats.topConnections.length > 0 && (
                  <>
                    <Separator className="my-3" />
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-muted-foreground">
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
                              <span className="truncate max-w-[140px]">
                                {tc.name}
                              </span>
                              <span className="text-muted-foreground">
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
          </CardContent>
        </Card>
      </div>

      {/* Section 3: Security & Supported Databases */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Security & Access */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Lock className="h-4 w-4" />
              Security & Access
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Authentication</span>
              <span>Environment Variable (RBAC)</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">API Security</span>
              <div className="flex items-center gap-1.5">
                <KeyRound className="h-3 w-3 text-muted-foreground" />
                <span>JWT / HTTP-only Cookie</span>
              </div>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Admin Access</span>
              <Badge variant="default" className="text-[10px]">
                ENABLED
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">User Access</span>
              <Badge variant="default" className="text-[10px]">
                ENABLED
              </Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">SSL/TLS</span>
              <Badge variant="secondary" className="text-[10px]">
                Supported
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">SSH Tunnel</span>
              <Badge variant="secondary" className="text-[10px]">
                Supported
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Supported Databases */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Supported Databases
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              {ALL_DB_TYPES.map((dbType) => {
                const Icon = getDBIcon(dbType);
                const config = getDBConfig(dbType);
                return (
                  <div
                    key={dbType}
                    className="flex items-center gap-2.5 rounded-md border p-2 text-sm"
                  >
                    <Icon
                      className={`h-5 w-5 shrink-0 ${getDBColor(dbType)}`}
                    />
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        {config.label}
                      </div>
                      {config.defaultPort && (
                        <div className="text-[10px] text-muted-foreground">
                          Port {config.defaultPort}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
