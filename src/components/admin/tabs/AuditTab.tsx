'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Wrench,
  Search as SearchIcon,
  BarChart3,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Clock,
  Activity,
} from 'lucide-react';
import type { AuditEvent } from '@/lib/audit';
import { storage } from '@/lib/storage';
import type { QueryHistoryItem } from '@/lib/types';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format, subDays, startOfDay } from 'date-fns';

export function AuditTab() {
  return (
    <div className="space-y-6">
      <Tabs defaultValue="operations">
        <TabsList className="bg-transparent border-b border-white/5 rounded-none p-0 h-10 w-full justify-start">
          <TabsTrigger
            value="operations"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-zinc-500 text-xs px-4"
          >
            <Wrench className="h-3.5 w-3.5" />
            Operations
          </TabsTrigger>
          <TabsTrigger
            value="queries"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-zinc-500 text-xs px-4"
          >
            <SearchIcon className="h-3.5 w-3.5" />
            Queries
          </TabsTrigger>
          <TabsTrigger
            value="stats"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-zinc-500 text-xs px-4"
          >
            <BarChart3 className="h-3.5 w-3.5" />
            Stats
          </TabsTrigger>
        </TabsList>

        <TabsContent value="operations" className="mt-4">
          <OperationsAudit />
        </TabsContent>
        <TabsContent value="queries" className="mt-4">
          <QueryAudit />
        </TabsContent>
        <TabsContent value="stats" className="mt-4">
          <AuditStats />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OperationsAudit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (typeFilter !== 'all') params.set('type', typeFilter);
      const res = await fetch(`/api/admin/audit?${params}`);
      const data = await res.json();
      setEvents(data.events || []);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const filteredEvents = useMemo(() => {
    if (!searchQuery) return events;
    const q = searchQuery.toLowerCase();
    return events.filter(
      (e) =>
        e.action.toLowerCase().includes(q) ||
        e.target.toLowerCase().includes(q) ||
        (e.connectionName || '').toLowerCase().includes(q)
    );
  }, [events, searchQuery]);

  const successCount = events.filter((e) => e.result === 'success').length;
  const successRate = events.length > 0 ? Math.round((successCount / events.length) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[140px] h-8 text-xs bg-zinc-900/50 border-white/10">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="maintenance">Maintenance</SelectItem>
            <SelectItem value="kill_session">Kill Session</SelectItem>
            <SelectItem value="masking_config">Masking</SelectItem>
            <SelectItem value="threshold_config">Thresholds</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-[180px] h-8 text-xs bg-zinc-900/50 border-white/10"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-zinc-500 hover:text-zinc-300 ml-auto"
          onClick={fetchEvents}
          disabled={loading}
        >
          <RefreshCw className={`w-3 h-3 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Stats Summary */}
      <div className="flex items-center gap-4 text-xs text-zinc-500">
        <span>
          Total: <span className="font-bold text-zinc-300">{events.length}</span> ops
        </span>
        <span>
          Success:{' '}
          <span className="font-bold text-emerald-400">{successRate}%</span>
        </span>
      </div>

      {/* Events Table */}
      <div className="rounded-xl border border-white/5 bg-zinc-900/50 overflow-hidden">
        {loading && events.length === 0 ? (
          <div className="p-4 space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full bg-zinc-800" />
            ))}
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="p-8 text-center text-zinc-600 text-sm">
            <Wrench className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No audit events found.</p>
            <p className="text-[11px] mt-1 text-zinc-700">
              Operations will appear here when maintenance tasks are run.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-white/5 hover:bg-transparent">
                <TableHead className="text-[10px] text-zinc-500 font-bold uppercase w-[30px]" />
                <TableHead className="text-[10px] text-zinc-500 font-bold uppercase">Time</TableHead>
                <TableHead className="text-[10px] text-zinc-500 font-bold uppercase">Action</TableHead>
                <TableHead className="text-[10px] text-zinc-500 font-bold uppercase">Target</TableHead>
                <TableHead className="text-[10px] text-zinc-500 font-bold uppercase hidden md:table-cell">Connection</TableHead>
                <TableHead className="text-[10px] text-zinc-500 font-bold uppercase hidden lg:table-cell">User</TableHead>
                <TableHead className="text-right text-[10px] text-zinc-500 font-bold uppercase">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEvents.map((event) => (
                <TableRow key={event.id} className="border-white/5 hover:bg-white/[0.03]">
                  <TableCell className="py-2">
                    {event.result === 'success' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-red-500" />
                    )}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-[10px] text-zinc-500">
                    {new Date(event.timestamp).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </TableCell>
                  <TableCell className="py-2">
                    <Badge
                      variant="outline"
                      className="text-[9px] font-bold border-white/10"
                    >
                      {event.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2 font-mono text-xs text-zinc-400 truncate max-w-[120px]">
                    {event.target}
                  </TableCell>
                  <TableCell className="py-2 text-xs text-zinc-500 hidden md:table-cell truncate max-w-[100px]">
                    {event.connectionName || '-'}
                  </TableCell>
                  <TableCell className="py-2 text-xs text-zinc-500 hidden lg:table-cell">
                    {event.user}
                  </TableCell>
                  <TableCell className="py-2 text-right font-mono text-[10px] text-zinc-500">
                    {event.duration ? `${event.duration}ms` : '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function QueryAudit() {
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  useEffect(() => {
    setHistory(storage.getHistory());
  }, []);

  const filteredHistory = useMemo(() => {
    let items = history;
    if (statusFilter !== 'all') {
      items = items.filter((h) => h.status === statusFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (h) =>
          h.query.toLowerCase().includes(q) ||
          (h.connectionName || '').toLowerCase().includes(q)
      );
    }
    return items.slice(0, 200);
  }, [history, searchQuery, statusFilter]);

  const successCount = history.filter((h) => h.status === 'success').length;
  const successRate = history.length > 0 ? Math.round((successCount / history.length) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[120px] h-8 text-xs bg-zinc-900/50 border-white/10">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Search query..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-[200px] h-8 text-xs bg-zinc-900/50 border-white/10"
        />
        <div className="text-xs text-zinc-500 ml-auto">
          <span className="font-bold text-zinc-300">{history.length}</span> queries
          <span className="mx-2">&middot;</span>
          <span className="text-emerald-400 font-bold">{successRate}%</span> success
        </div>
      </div>

      {/* Query History Table */}
      <div className="rounded-xl border border-white/5 bg-zinc-900/50 overflow-hidden">
        {filteredHistory.length === 0 ? (
          <div className="p-8 text-center text-zinc-600 text-sm">
            <SearchIcon className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No query history found.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-white/5 hover:bg-transparent">
                <TableHead className="text-[10px] text-zinc-500 font-bold uppercase w-[30px]" />
                <TableHead className="text-[10px] text-zinc-500 font-bold uppercase">Time</TableHead>
                <TableHead className="text-[10px] text-zinc-500 font-bold uppercase">Query</TableHead>
                <TableHead className="text-[10px] text-zinc-500 font-bold uppercase hidden md:table-cell">Connection</TableHead>
                <TableHead className="text-right text-[10px] text-zinc-500 font-bold uppercase">Duration</TableHead>
                <TableHead className="text-right text-[10px] text-zinc-500 font-bold uppercase hidden sm:table-cell">Rows</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredHistory.map((item, idx) => (
                <TableRow key={idx} className="border-white/5 hover:bg-white/[0.03]">
                  <TableCell className="py-2">
                    {item.status === 'success' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-red-500" />
                    )}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-[10px] text-zinc-500 whitespace-nowrap">
                    {new Date(item.executedAt).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </TableCell>
                  <TableCell className="py-2">
                    <div className="font-mono text-[11px] text-zinc-400 truncate max-w-[250px] lg:max-w-[400px]">
                      {item.query}
                    </div>
                  </TableCell>
                  <TableCell className="py-2 text-xs text-zinc-500 hidden md:table-cell truncate max-w-[100px]">
                    {item.connectionName || '-'}
                  </TableCell>
                  <TableCell className="py-2 text-right font-mono text-[10px] text-zinc-500">
                    {item.executionTime}ms
                  </TableCell>
                  <TableCell className="py-2 text-right font-mono text-[10px] text-zinc-500 hidden sm:table-cell">
                    {item.rowCount ?? '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function AuditStats() {
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);

  useEffect(() => {
    setHistory(storage.getHistory());
  }, []);

  const stats = useMemo(() => {
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

    // Most active connections
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
      .slice(0, 5);

    return { total, successful, successRate, avgTime, byDay, topConnections };
  }, [history]);

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-4">
          <div className="text-xs text-zinc-500 mb-1">Total Queries</div>
          <div className="text-2xl font-bold text-zinc-100 tabular-nums">
            {stats.total}
          </div>
        </div>
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-4">
          <div className="text-xs text-zinc-500 mb-1">Success Rate</div>
          <div className="text-2xl font-bold text-emerald-400 tabular-nums">
            {stats.successRate}%
          </div>
          <Progress value={stats.successRate} className="h-1 mt-2" />
        </div>
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-4">
          <div className="text-xs text-zinc-500 mb-1">Avg Duration</div>
          <div className="text-2xl font-bold text-zinc-100 tabular-nums">
            {stats.avgTime}
            <span className="text-sm text-zinc-500 ml-1">ms</span>
          </div>
        </div>
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-4">
          <div className="text-xs text-zinc-500 mb-1">Failed</div>
          <div className="text-2xl font-bold text-red-400 tabular-nums">
            {stats.total - stats.successful}
          </div>
        </div>
      </div>

      {/* Query Activity Chart */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5">
          <h3 className="text-sm font-bold text-zinc-300 mb-4 flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-400" />
            Query Activity (7 days)
          </h3>
          {stats.total === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-zinc-600">
              No query history yet.
            </div>
          ) : (
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.byDay}>
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
          )}
        </div>

        {/* Most Active Connections */}
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5">
          <h3 className="text-sm font-bold text-zinc-300 mb-4 flex items-center gap-2">
            <Clock className="h-4 w-4 text-blue-400" />
            Most Active Connections
          </h3>
          {stats.topConnections.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-zinc-600">
              No data yet.
            </div>
          ) : (
            <div className="space-y-3">
              {stats.topConnections.map((tc) => {
                const pct =
                  stats.total > 0
                    ? Math.round((tc.count / stats.total) * 100)
                    : 0;
                return (
                  <div key={tc.name} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate max-w-[160px] text-zinc-400">
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
          )}
        </div>
      </div>
    </div>
  );
}
