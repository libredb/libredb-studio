'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { storage } from '@/lib/storage';
import { getDBIcon, getDBColor } from '@/lib/db-ui-config';
import {
  type DatabaseType,
  type DatabaseConnection,
  type QueryHistoryItem,
  ENVIRONMENT_COLORS,
  ENVIRONMENT_LABELS,
} from '@/lib/types';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  RadialBarChart,
  RadialBar,
} from 'recharts';
import { format, subDays, startOfDay } from 'date-fns';
import {
  Activity,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Zap,
  Clock,
  Database,
  Wrench,
  Shield,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Link2,
  HardDrive,
  Sparkles,
  Radio,
  Gauge,
} from 'lucide-react';
import { motion, AnimatePresence, type Variants } from 'framer-motion';
import Link from 'next/link';
import type { FleetHealthItem } from '@/app/api/admin/fleet-health/route';
import type { AuditEvent } from '@/lib/audit';

// ─── Animation Variants ─────────────────────────────────────────────────────

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: 'spring' as const, stiffness: 300, damping: 24 },
  },
};

const heroVariants = {
  hidden: { opacity: 0, y: -30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 200, damping: 20 },
  },
};

const feedItemVariants: Variants = {
  hidden: { opacity: 0, x: -10 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: { delay: i * 0.05, type: 'spring' as const, stiffness: 300, damping: 24 },
  }),
};

// ─── Constants ───────────────────────────────────────────────────────────────

const DARK_TOOLTIP_STYLE = {
  backgroundColor: '#18181b',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '8px',
  fontSize: 12,
  color: '#a1a1aa',
};

const GAUGE_COLORS = {
  excellent: '#10b981',
  good: '#3b82f6',
  warning: '#f59e0b',
  critical: '#ef4444',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getGaugeColor(value: number, thresholds = { warning: 70, critical: 50 }) {
  if (value >= 90) return GAUGE_COLORS.excellent;
  if (value >= thresholds.warning) return GAUGE_COLORS.good;
  if (value >= thresholds.critical) return GAUGE_COLORS.warning;
  return GAUGE_COLORS.critical;
}

function getGaugeColorReverse(value: number, thresholds = { warning: 200, critical: 500 }) {
  if (value <= 50) return GAUGE_COLORS.excellent;
  if (value <= thresholds.warning) return GAUGE_COLORS.good;
  if (value <= thresholds.critical) return GAUGE_COLORS.warning;
  return GAUGE_COLORS.critical;
}

function formatRelativeTime(date: Date | string) {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = Math.max(0, now - then);
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatNumber(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ActivityFeedItem {
  id: string;
  type: 'audit' | 'query';
  text: string;
  status: 'success' | 'failure';
  time: string | Date;
  connectionName?: string;
}

// ─── useAnimatedCounter Hook ─────────────────────────────────────────────────

function useAnimatedCounter(target: number, duration = 1500) {
  const [value, setValue] = useState(0);
  const prevTarget = useRef(0);

  useEffect(() => {
    const start = prevTarget.current;
    prevTarget.current = target;
    if (target === 0) {
      setValue(0);
      return;
    }

    const startTime = performance.now();
    let raf: number;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(start + (target - start) * eased));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}

// ─── Main Component ──────────────────────────────────────────────────────────

interface OverviewTabProps {
  user: { username: string; role: string } | null;
}

export function OverviewTab({ user }: OverviewTabProps) {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);
  const [fleetHealth, setFleetHealth] = useState<FleetHealthItem[]>([]);
  const [fleetLoading, setFleetLoading] = useState(false);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);

  useEffect(() => {
    const conns = storage.getConnections();
    setConnections(conns);
    setHistory(storage.getHistory());
  }, []);

  // Fetch audit events for activity feed
  useEffect(() => {
    fetch('/api/admin/audit?limit=10')
      .then((r) => r.json())
      .then((d) => setAuditEvents(d.events || []))
      .catch(() => {});
  }, []);

  const fetchFleetHealth = useCallback(async () => {
    if (connections.length === 0) return;
    setFleetLoading(true);
    try {
      const res = await fetch('/api/admin/fleet-health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections }),
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

    const now = new Date();
    const byDay: { day: string; success: number; fail: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = startOfDay(subDays(now, i));
      const dayEnd = startOfDay(subDays(now, i - 1));
      const dayItems = history.filter((h) => {
        const t = new Date(h.executedAt).getTime();
        return t >= dayStart.getTime() && t < dayEnd.getTime();
      });
      byDay.push({
        day: format(dayStart, 'EEE'),
        success: dayItems.filter((h) => h.status === 'success').length,
        fail: dayItems.filter((h) => h.status !== 'success').length,
      });
    }

    return { total, successful, failed, successRate, avgTime, byDay };
  }, [history]);

  const healthScore = useMemo(() => {
    if (fleetHealth.length === 0) return 0;
    const healthy = fleetHealth.filter((h) => h.status === 'healthy').length;
    return Math.round((healthy / fleetHealth.length) * 100);
  }, [fleetHealth]);

  const todayQueries = useMemo(() => {
    const todayStart = startOfDay(new Date()).getTime();
    return history.filter((h) => new Date(h.executedAt).getTime() >= todayStart).length;
  }, [history]);

  const yesterdayQueries = useMemo(() => {
    const now = new Date();
    const yesterdayStart = startOfDay(subDays(now, 1)).getTime();
    const todayStart = startOfDay(now).getTime();
    return history.filter((h) => {
      const t = new Date(h.executedAt).getTime();
      return t >= yesterdayStart && t < todayStart;
    }).length;
  }, [history]);

  const avgLatency = useMemo(() => {
    const healthy = fleetHealth.filter((h) => h.status !== 'error');
    if (healthy.length === 0) return 0;
    return Math.round(
      healthy.reduce((sum, h) => sum + h.latencyMs, 0) / healthy.length
    );
  }, [fleetHealth]);

  const totalDBSize = useMemo(() => {
    let totalBytes = 0;
    for (const item of fleetHealth) {
      if (!item.databaseSize) continue;
      const s = item.databaseSize.toLowerCase();
      const num = parseFloat(s);
      if (isNaN(num)) continue;
      if (s.includes('gb')) totalBytes += num * 1024 * 1024 * 1024;
      else if (s.includes('mb')) totalBytes += num * 1024 * 1024;
      else if (s.includes('kb')) totalBytes += num * 1024;
      else totalBytes += num;
    }
    if (totalBytes === 0) return '0';
    if (totalBytes >= 1024 * 1024 * 1024) return `${(totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (totalBytes >= 1024 * 1024) return `${(totalBytes / (1024 * 1024)).toFixed(0)} MB`;
    return `${(totalBytes / 1024).toFixed(0)} KB`;
  }, [fleetHealth]);

  // Activity feed: merge audit events + recent history
  const activityFeed = useMemo(() => {
    const items: ActivityFeedItem[] = [];

    for (const e of auditEvents) {
      items.push({
        id: e.id,
        type: 'audit',
        text: `${e.action} ${e.target}`,
        status: e.result,
        time: e.timestamp,
        connectionName: e.connectionName,
      });
    }

    for (const h of history.slice(0, 10)) {
      items.push({
        id: `q-${h.executedAt}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'query',
        text: h.query.length > 60 ? h.query.slice(0, 60) + '...' : h.query,
        status: h.status === 'success' ? 'success' : 'failure',
        time: h.executedAt,
        connectionName: h.connectionName,
      });
    }

    items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return items.slice(0, 15);
  }, [auditEvents, history]);

  const hasConnections = connections.length > 0;

  if (!hasConnections) {
    return <EmptyState />;
  }

  return (
    <motion.div
      className="space-y-6"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* SECTION 1: Hero Status Banner */}
      <HeroStatusBanner
        healthScore={healthScore}
        fleetHealth={fleetHealth}
        connections={connections}
        queryStats={queryStats}
        todayQueries={todayQueries}
        yesterdayQueries={yesterdayQueries}
        totalDBSize={totalDBSize}
        user={user}
        fleetLoading={fleetLoading}
        onRefresh={fetchFleetHealth}
      />

      {/* SECTION 2: Fleet Health Grid */}
      <FleetHealthSection
        fleetHealth={fleetHealth}
        fleetLoading={fleetLoading}
        connections={connections}
      />

      {/* SECTION 3: Key Metrics */}
      <KeyMetricsSection
        queryStats={queryStats}
        healthScore={healthScore}
        avgLatency={avgLatency}
        todayQueries={todayQueries}
        yesterdayQueries={yesterdayQueries}
      />

      {/* SECTION 4: Analytics */}
      <AnalyticsSection
        queryStats={queryStats}
        activityFeed={activityFeed}
      />

      {/* SECTION 5: Quick Actions */}
      <QuickActionsSection />
    </motion.div>
  );
}

// ─── SECTION 1: Hero Status Banner ──────────────────────────────────────────

function HeroStatusBanner({
  healthScore,
  fleetHealth,
  connections,
  queryStats,
  todayQueries,
  yesterdayQueries,
  totalDBSize,
  user,
  fleetLoading,
  onRefresh,
}: {
  healthScore: number;
  fleetHealth: FleetHealthItem[];
  connections: DatabaseConnection[];
  queryStats: { total: number; successRate: number; avgTime: number };
  todayQueries: number;
  yesterdayQueries: number;
  totalDBSize: string;
  user: { username: string; role: string } | null;
  fleetLoading: boolean;
  onRefresh: () => void;
}) {
  const animatedScore = useAnimatedCounter(healthScore);
  const animatedConns = useAnimatedCounter(connections.length);
  const animatedQueries = useAnimatedCounter(queryStats.total);
  const animatedToday = useAnimatedCounter(todayQueries);

  const gaugeColor = getGaugeColor(healthScore);
  const gaugeData = [{ value: healthScore, fill: gaugeColor }];

  const healthyCount = fleetHealth.filter((h) => h.status === 'healthy').length;
  const degradedCount = fleetHealth.filter((h) => h.status === 'degraded').length;
  const errorCount = fleetHealth.filter((h) => h.status === 'error').length;

  const statusText =
    errorCount > 0
      ? 'Attention Required'
      : degradedCount > 0
        ? 'Degraded Performance'
        : 'All Systems Operational';

  const statusColor =
    errorCount > 0
      ? 'text-red-400'
      : degradedCount > 0
        ? 'text-amber-400'
        : 'text-emerald-400';

  const statusGlow =
    errorCount > 0
      ? 'shadow-[0_0_20px_rgba(239,68,68,0.15)]'
      : degradedCount > 0
        ? 'shadow-[0_0_20px_rgba(245,158,11,0.15)]'
        : 'shadow-[0_0_20px_rgba(16,185,129,0.1)]';

  const queryTrend = todayQueries - yesterdayQueries;

  return (
    <motion.div variants={heroVariants} className="relative">
      <div
        className={`relative overflow-hidden rounded-2xl border border-white/5 bg-gradient-to-br from-zinc-900/80 via-zinc-950 to-zinc-900/80 p-6 ${statusGlow}`}
      >
        {/* Decorative blur orbs */}
        <div className="absolute top-0 left-1/4 w-64 h-64 bg-blue-500/5 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 right-1/4 w-48 h-48 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />

        <div className="relative flex flex-col md:flex-row gap-6 items-center">
          {/* Left: Radial Health Gauge */}
          <div className="relative flex-shrink-0">
            <div className="w-[160px] h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <RadialBarChart
                  innerRadius="70%"
                  outerRadius="90%"
                  barSize={12}
                  data={gaugeData}
                  startAngle={90}
                  endAngle={-270}
                >
                  <RadialBar
                    dataKey="value"
                    cornerRadius={6}
                    background={{ fill: 'rgba(255,255,255,0.04)' }}
                  />
                </RadialBarChart>
              </ResponsiveContainer>
            </div>
            {/* Center overlay */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span
                className="text-3xl font-bold tabular-nums"
                style={{ color: gaugeColor }}
              >
                {animatedScore}%
              </span>
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
                Health
              </span>
            </div>
            {/* LIVE badge */}
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5">
              <motion.div
                className="w-2 h-2 rounded-full bg-emerald-500"
                animate={{ scale: [1, 1.05, 1], opacity: [0.7, 1, 0.7] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
              <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-widest">
                Live
              </span>
            </div>
          </div>

          {/* Right: Counter Cards + Status */}
          <div className="flex-1 min-w-0 space-y-4">
            {/* Status Line */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <span className={`text-sm font-bold ${statusColor}`}>
                  {statusText}
                </span>
                <div className="flex gap-1.5 text-[10px]">
                  {healthyCount > 0 && (
                    <Badge
                      variant="outline"
                      className="border-emerald-500/30 text-emerald-400 h-5 text-[9px]"
                    >
                      {healthyCount} healthy
                    </Badge>
                  )}
                  {degradedCount > 0 && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/30 text-amber-400 h-5 text-[9px]"
                    >
                      {degradedCount} degraded
                    </Badge>
                  )}
                  {errorCount > 0 && (
                    <Badge
                      variant="outline"
                      className="border-red-500/30 text-red-400 h-5 text-[9px]"
                    >
                      {errorCount} error
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {user && (
                  <Badge
                    variant="outline"
                    className="border-white/10 text-zinc-500 h-5 text-[9px]"
                  >
                    {user.username} ({user.role})
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[10px] text-zinc-500 hover:text-zinc-300"
                  onClick={onRefresh}
                  disabled={fleetLoading}
                >
                  <RefreshCw
                    className={`w-3 h-3 mr-1 ${fleetLoading ? 'animate-spin' : ''}`}
                  />
                  Refresh
                </Button>
              </div>
            </div>

            {/* Counter Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <CounterCard
                icon={Link2}
                label="Connections"
                value={animatedConns}
                suffix=""
                color="text-blue-400"
              />
              <CounterCard
                icon={Zap}
                label="Total Queries"
                value={animatedQueries}
                suffix=""
                color="text-purple-400"
                formatValue={formatNumber}
              />
              <CounterCard
                icon={HardDrive}
                label="DB Size"
                value={totalDBSize}
                suffix=""
                color="text-emerald-400"
                isString
              />
              <CounterCard
                icon={Activity}
                label="Today"
                value={animatedToday}
                suffix=""
                color="text-amber-400"
                trend={queryTrend}
              />
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function CounterCard({
  icon: Icon,
  label,
  value,
  suffix,
  color,
  trend,
  isString,
  formatValue,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  suffix: string;
  color: string;
  trend?: number;
  isString?: boolean;
  formatValue?: (n: number) => string;
}) {
  const displayValue = isString
    ? value
    : formatValue
      ? formatValue(value as number)
      : value;

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold text-zinc-100 tabular-nums">
          {displayValue}
        </span>
        {suffix && (
          <span className="text-xs text-zinc-500">{suffix}</span>
        )}
      </div>
      {trend !== undefined && trend !== 0 && (
        <div
          className={`flex items-center gap-0.5 mt-1 text-[10px] ${
            trend > 0 ? 'text-emerald-400' : 'text-red-400'
          }`}
        >
          {trend > 0 ? (
            <TrendingUp className="w-3 h-3" />
          ) : (
            <TrendingDown className="w-3 h-3" />
          )}
          <span>
            {trend > 0 ? '+' : ''}
            {trend} vs yesterday
          </span>
        </div>
      )}
    </div>
  );
}

// ─── SECTION 2: Fleet Health Grid ────────────────────────────────────────────

function FleetHealthSection({
  fleetHealth,
  fleetLoading,
  connections,
}: {
  fleetHealth: FleetHealthItem[];
  fleetLoading: boolean;
  connections: DatabaseConnection[];
}) {
  if (connections.length === 0) return null;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy':
        return {
          dot: 'bg-emerald-500',
          border: 'border-emerald-500/20 hover:border-emerald-500/40',
          glow: 'hover:shadow-[0_0_30px_rgba(16,185,129,0.08)]',
          gradient: 'from-emerald-500/60 via-emerald-400/40',
          latencyColor: '#10b981',
        };
      case 'degraded':
        return {
          dot: 'bg-amber-500',
          border: 'border-amber-500/20 hover:border-amber-500/40',
          glow: 'hover:shadow-[0_0_30px_rgba(245,158,11,0.08)]',
          gradient: 'from-amber-500/60 via-amber-400/40',
          latencyColor: '#f59e0b',
        };
      default:
        return {
          dot: 'bg-red-500',
          border: 'border-red-500/20 hover:border-red-500/40',
          glow: 'hover:shadow-[0_0_30px_rgba(239,68,68,0.08)]',
          gradient: 'from-red-500/60 via-red-400/40',
          latencyColor: '#ef4444',
        };
    }
  };

  return (
    <motion.div variants={itemVariants}>
      <div className="flex items-center gap-2 mb-3">
        <Radio className="h-4 w-4 text-blue-400" />
        <h2 className="text-sm font-bold text-zinc-300">Fleet Status</h2>
        <span className="text-[10px] text-zinc-600">
          {fleetHealth.length} endpoint{fleetHealth.length !== 1 ? 's' : ''}
        </span>
      </div>

      {fleetLoading && fleetHealth.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-white/5 bg-zinc-900/50 p-4"
            >
              <Skeleton className="h-4 w-24 mb-3 bg-zinc-800" />
              <Skeleton className="h-3 w-32 mb-2 bg-zinc-800" />
              <Skeleton className="h-2 w-full bg-zinc-800" />
            </div>
          ))}
        </div>
      ) : (
        <motion.div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          {fleetHealth.map((item) => {
            const colors = getStatusColor(item.status);
            const Icon = getDBIcon(item.type as DatabaseType);
            const maxLatency = 500;
            const latencyPct = Math.min((item.latencyMs / maxLatency) * 100, 100);

            return (
              <motion.a
                key={item.connectionId}
                href="/admin?tab=monitoring"
                variants={itemVariants}
                whileHover={{ scale: 1.02, y: -2 }}
                className={`group relative rounded-xl border-2 ${colors.border} bg-zinc-900/50 p-4 transition-all duration-200 hover:bg-white/[0.04] ${colors.glow} cursor-pointer block overflow-hidden`}
              >
                {/* Top gradient glow line */}
                <div
                  className={`absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent ${colors.gradient} to-transparent`}
                />

                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2 h-2 rounded-full ${colors.dot} ${item.status === 'healthy' ? 'animate-pulse' : ''}`}
                    />
                    <span className="text-sm font-medium text-zinc-200 truncate max-w-[150px]">
                      {item.connectionName}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.environment && (
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
                    )}
                    <div className="p-1 rounded bg-white/[0.04]">
                      <Icon
                        className={`w-3.5 h-3.5 ${getDBColor(item.type as DatabaseType)}`}
                      />
                    </div>
                  </div>
                </div>

                {/* Latency bar */}
                <div className="mb-2">
                  <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ backgroundColor: colors.latencyColor }}
                      initial={{ width: 0 }}
                      animate={{ width: `${latencyPct}%` }}
                      transition={{ duration: 1, delay: 0.3 }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 text-[11px] text-zinc-500">
                  <span className="font-mono text-zinc-400">
                    {item.status === 'error' ? 'timeout' : `${item.latencyMs}ms`}
                  </span>
                  {item.databaseSize && (
                    <>
                      <span className="text-zinc-700">&middot;</span>
                      <span className="font-mono text-zinc-400">
                        {item.databaseSize}
                      </span>
                    </>
                  )}
                  {item.activeConnections !== undefined && (
                    <>
                      <span className="text-zinc-700">&middot;</span>
                      <span className="font-mono text-zinc-400">
                        {item.activeConnections} conn
                      </span>
                    </>
                  )}
                </div>

                {item.error && (
                  <div className="text-red-400 text-[10px] truncate mt-1.5">
                    {item.error}
                  </div>
                )}
              </motion.a>
            );
          })}
        </motion.div>
      )}
    </motion.div>
  );
}

// ─── SECTION 3: Key Metrics Dashboard ────────────────────────────────────────

function KeyMetricsSection({
  queryStats,
  healthScore,
  avgLatency,
  todayQueries,
  yesterdayQueries,
}: {
  queryStats: { total: number; successRate: number; avgTime: number };
  healthScore: number;
  avgLatency: number;
  todayQueries: number;
  yesterdayQueries: number;
}) {
  return (
    <motion.div variants={itemVariants}>
      <div className="flex items-center gap-2 mb-3">
        <Gauge className="h-4 w-4 text-blue-400" />
        <h2 className="text-sm font-bold text-zinc-300">Key Metrics</h2>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricGauge
          label="Query Success"
          value={queryStats.successRate}
          unit="%"
          color={getGaugeColor(queryStats.successRate)}
        />
        <MetricGauge
          label="Fleet Health"
          value={healthScore}
          unit="%"
          color={getGaugeColor(healthScore)}
        />
        <MetricGauge
          label="Avg Response"
          value={Math.min(avgLatency, 500)}
          displayValue={`${avgLatency}`}
          unit="ms"
          maxValue={500}
          color={getGaugeColorReverse(avgLatency)}
        />
        <MetricBigNumber
          label="Total Queries"
          value={queryStats.total}
          trend={todayQueries - yesterdayQueries}
          icon={Zap}
        />
      </div>
    </motion.div>
  );
}

function MetricGauge({
  label,
  value,
  displayValue,
  unit,
  color,
  maxValue = 100,
}: {
  label: string;
  value: number;
  displayValue?: string;
  unit: string;
  color: string;
  maxValue?: number;
}) {
  const pct = Math.round((value / maxValue) * 100);
  const animatedValue = useAnimatedCounter(value);
  const gaugeData = [{ value: pct, fill: color }];

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 flex flex-col items-center">
      <div className="relative w-[100px] h-[100px]">
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            innerRadius="70%"
            outerRadius="90%"
            barSize={8}
            data={gaugeData}
            startAngle={90}
            endAngle={-270}
          >
            <RadialBar
              dataKey="value"
              cornerRadius={4}
              background={{ fill: 'rgba(255,255,255,0.03)' }}
            />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="text-xl font-bold tabular-nums"
            style={{ color }}
          >
            {displayValue ?? animatedValue}
          </span>
          <span className="text-[9px] text-zinc-500">{unit}</span>
        </div>
      </div>
      <span className="text-[10px] text-zinc-500 mt-1 uppercase tracking-wider">
        {label}
      </span>
    </div>
  );
}

function MetricBigNumber({
  label,
  value,
  trend,
  icon: Icon,
}: {
  label: string;
  value: number;
  trend: number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const animatedValue = useAnimatedCounter(value);

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 flex flex-col items-center justify-center">
      <div className="p-2 rounded-lg bg-purple-500/10 mb-2">
        <Icon className="w-5 h-5 text-purple-400" />
      </div>
      <span className="text-3xl font-bold text-zinc-100 tabular-nums">
        {formatNumber(animatedValue)}
      </span>
      <span className="text-[10px] text-zinc-500 mt-1 uppercase tracking-wider">
        {label}
      </span>
      {trend !== 0 && (
        <div
          className={`flex items-center gap-0.5 mt-1.5 text-[10px] ${
            trend > 0 ? 'text-emerald-400' : 'text-red-400'
          }`}
        >
          {trend > 0 ? (
            <TrendingUp className="w-3 h-3" />
          ) : (
            <TrendingDown className="w-3 h-3" />
          )}
          <span>
            {trend > 0 ? '+' : ''}
            {trend} today
          </span>
        </div>
      )}
    </div>
  );
}

// ─── SECTION 4: Analytics ────────────────────────────────────────────────────

function AnalyticsSection({
  queryStats,
  activityFeed,
}: {
  queryStats: { total: number; byDay: { day: string; success: number; fail: number }[] };
  activityFeed: ActivityFeedItem[];
}) {
  return (
    <motion.div variants={itemVariants}>
      <div className="grid gap-6 md:grid-cols-2">
        {/* Gradient AreaChart */}
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5">
          <h3 className="text-sm font-bold text-zinc-300 mb-4 flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-400" />
            Query Volume (7 days)
          </h3>
          {queryStats.total === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-zinc-600">
              No query history yet.
            </div>
          ) : (
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={queryStats.byDay}>
                  <defs>
                    <linearGradient id="gradSuccess" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradFail" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ef4444" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                    </linearGradient>
                  </defs>
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
                  <Tooltip contentStyle={DARK_TOOLTIP_STYLE} />
                  <Area
                    type="monotone"
                    dataKey="success"
                    name="Success"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="url(#gradSuccess)"
                    stackId="1"
                    animationDuration={1500}
                  />
                  <Area
                    type="monotone"
                    dataKey="fail"
                    name="Failed"
                    stroke="#ef4444"
                    strokeWidth={2}
                    fill="url(#gradFail)"
                    stackId="1"
                    animationDuration={1500}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Recent Activity Feed */}
        <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5">
          <h3 className="text-sm font-bold text-zinc-300 mb-4 flex items-center gap-2">
            <Clock className="h-4 w-4 text-blue-400" />
            Recent Activity
          </h3>
          {activityFeed.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-zinc-600">
              No recent activity.
            </div>
          ) : (
            <div className="max-h-[260px] overflow-y-auto editor-scrollbar space-y-1">
              <AnimatePresence>
                {activityFeed.map((item, i) => (
                  <motion.div
                    key={item.id}
                    custom={i}
                    variants={feedItemVariants}
                    initial="hidden"
                    animate="visible"
                    className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-white/[0.03] transition-colors"
                  >
                    {item.type === 'audit' ? (
                      <Wrench className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
                    ) : (
                      <Zap className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-zinc-400 truncate">
                        {item.text}
                      </div>
                      {item.connectionName && (
                        <div className="text-[10px] text-zinc-600 truncate">
                          {item.connectionName}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {item.status === 'success' ? (
                        <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                      ) : (
                        <XCircle className="w-3 h-3 text-red-500" />
                      )}
                      <span className="text-[10px] text-zinc-600 whitespace-nowrap">
                        {formatRelativeTime(item.time)}
                      </span>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ─── SECTION 5: Quick Actions ────────────────────────────────────────────────

function QuickActionsSection() {
  const actions = [
    {
      label: 'Maintenance',
      description: 'VACUUM, ANALYZE, and optimize your databases',
      icon: Wrench,
      href: '/admin?tab=operations',
      gradient: 'from-blue-500/20 to-cyan-500/20',
      iconColor: 'text-blue-400',
      borderColor: 'hover:border-blue-500/30',
    },
    {
      label: 'Security & Masking',
      description: 'Configure data masking rules and access control',
      icon: Shield,
      href: '/admin?tab=security',
      gradient: 'from-emerald-500/20 to-teal-500/20',
      iconColor: 'text-emerald-400',
      borderColor: 'hover:border-emerald-500/30',
    },
    {
      label: 'Real-time Monitoring',
      description: 'Live metrics, connection pools, and alert thresholds',
      icon: Activity,
      href: '/admin?tab=monitoring',
      gradient: 'from-purple-500/20 to-pink-500/20',
      iconColor: 'text-purple-400',
      borderColor: 'hover:border-purple-500/30',
    },
  ];

  return (
    <motion.div variants={itemVariants}>
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-4 w-4 text-blue-400" />
        <h2 className="text-sm font-bold text-zinc-300">Quick Actions</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {actions.map((action) => (
          <motion.a
            key={action.label}
            href={action.href}
            whileHover={{ scale: 1.02, y: -4 }}
            className={`group relative rounded-xl border border-white/5 ${action.borderColor} bg-zinc-900/50 p-5 transition-all duration-200 cursor-pointer block overflow-hidden hover:shadow-[0_0_30px_rgba(59,130,246,0.06)]`}
          >
            {/* Background gradient on hover */}
            <div
              className={`absolute inset-0 bg-gradient-to-br ${action.gradient} opacity-0 group-hover:opacity-100 transition-opacity duration-300`}
            />

            <div className="relative">
              <div className={`p-2 rounded-lg bg-white/[0.04] w-fit mb-3`}>
                <action.icon className={`w-5 h-5 ${action.iconColor}`} />
              </div>
              <h3 className="text-sm font-bold text-zinc-200 mb-1">
                {action.label}
              </h3>
              <p className="text-[11px] text-zinc-500 mb-3">
                {action.description}
              </p>
              <div className="flex items-center gap-1 text-[11px] text-zinc-600 group-hover:text-zinc-400 transition-colors">
                <span>Open</span>
                <ArrowRight className="w-3 h-3 group-hover:translate-x-1 transition-transform" />
              </div>
            </div>
          </motion.a>
        ))}
      </div>
    </motion.div>
  );
}

// ─── Empty State ─────────────────────────────────────────────────────────────

function EmptyState() {
  const features = [
    {
      icon: Database,
      label: '7 DB Types',
      description: 'PostgreSQL, MySQL, SQLite, MongoDB, Redis, Oracle, MSSQL',
    },
    {
      icon: Sparkles,
      label: 'AI Queries',
      description: 'Natural language to SQL with multi-model AI support',
    },
    {
      icon: Activity,
      label: 'Real-time Monitor',
      description: 'Live metrics, alerts, and connection pool monitoring',
    },
  ];

  return (
    <div className="relative min-h-[70vh] flex flex-col items-center justify-center px-4">
      {/* Animated breathing orbs */}
      <motion.div
        className="absolute top-1/4 left-1/3 w-72 h-72 bg-blue-500/5 rounded-full blur-3xl pointer-events-none"
        animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute bottom-1/4 right-1/3 w-56 h-56 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none"
        animate={{ scale: [1.2, 1, 1.2], opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
      />

      <motion.div
        className="relative z-10 flex flex-col items-center text-center"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Database icon with pulse glow */}
        <motion.div
          variants={itemVariants}
          className="relative mb-6"
        >
          <div className="absolute inset-0 w-20 h-20 bg-blue-500/20 rounded-full blur-xl" />
          <motion.div
            className="relative p-5 rounded-2xl border border-white/10 bg-zinc-900/80"
            animate={{ boxShadow: ['0 0 20px rgba(59,130,246,0.1)', '0 0 40px rgba(59,130,246,0.2)', '0 0 20px rgba(59,130,246,0.1)'] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Database className="w-10 h-10 text-blue-400" />
          </motion.div>
        </motion.div>

        <motion.h2
          variants={itemVariants}
          className="text-2xl font-bold text-zinc-100 mb-2"
        >
          Welcome to Command Center
        </motion.h2>
        <motion.p
          variants={itemVariants}
          className="text-sm text-zinc-500 max-w-md mb-8"
        >
          Connect your first database to unlock real-time fleet monitoring,
          analytics, and intelligent query assistance.
        </motion.p>

        {/* Feature cards */}
        <motion.div
          variants={containerVariants}
          className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8 w-full max-w-2xl"
        >
          {features.map((f) => (
            <motion.div
              key={f.label}
              variants={itemVariants}
              className="rounded-xl border border-white/5 bg-white/[0.02] p-4 text-center"
            >
              <div className="p-2 rounded-lg bg-blue-500/10 w-fit mx-auto mb-2">
                <f.icon className="w-5 h-5 text-blue-400" />
              </div>
              <div className="text-sm font-bold text-zinc-200 mb-1">
                {f.label}
              </div>
              <div className="text-[11px] text-zinc-500">{f.description}</div>
            </motion.div>
          ))}
        </motion.div>

        {/* CTA Button */}
        <motion.div variants={itemVariants}>
          <Button
            asChild
            className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2.5 shadow-[0_0_30px_rgba(59,130,246,0.3)] hover:shadow-[0_0_40px_rgba(59,130,246,0.4)] transition-all"
          >
            <Link href="/">Connect Your First Database</Link>
          </Button>
        </motion.div>
      </motion.div>
    </div>
  );
}
