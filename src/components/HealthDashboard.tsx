'use client';

import React, { useEffect, useState } from 'react';
import { DatabaseConnection } from '@/lib/types';
import { 
  Activity, 
  Database, 
  Zap, 
  Clock, 
  RefreshCw, 
  AlertCircle 
} from 'lucide-react';

interface HealthData {
  activeConnections: number;
  databaseSize: string;
  cacheHitRatio: number | string;
  slowQueries: Array<{
    query: string;
    calls: number;
    avgTime: string;
  }>;
  activeSessions: Array<{
    pid: number | string;
    user?: string;
    database?: string;
    state: string;
    query: string;
    duration?: string;
    wait_event_type?: string | null;
    xact_start?: string;
  }>;
}

/**
 * Convert cache hit ratio to percentage string
 * Handles both string (e.g., "98.5%") and number (0-1 range) formats
 */
function formatCacheHitRatio(ratio: number | string | undefined): string {
  if (!ratio) return '0%';
  
  if (typeof ratio === 'string') {
    // If it's already a formatted string (e.g., "98.5%"), use it directly
    return ratio.includes('%') ? ratio : `${ratio}%`;
  }
  
  // If it's a number (0-1 range), convert to percentage
  return (ratio * 100).toFixed(2) + '%';
}

/**
 * Convert cache hit ratio to percentage number (0-100) for progress bar
 * Handles both string (e.g., "98.5%") and number (0-1 range) formats
 */
function getCacheHitRatioPercent(ratio: number | string | undefined): number {
  if (!ratio) return 0;
  
  if (typeof ratio === 'string') {
    // Parse string like "98.5%" to number
    const numValue = parseFloat(ratio.replace('%', '')) || 0;
    return Math.min(100, Math.max(0, numValue));
  }
  
  // If it's a number (0-1 range), convert to percentage
  return Math.min(100, Math.max(0, ratio * 100));
}

export function HealthDashboard({ connection }: { connection: DatabaseConnection | null }) {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = async () => {
    if (!connection) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/db/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection }),
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      setData(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000); // Auto refresh every 30s
    return () => clearInterval(interval);
  }, [connection]);

  if (!connection) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Connect to a database to see health metrics.
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <RefreshCw className="w-8 h-8 animate-spin text-primary" />
        <p>Analyzing database health...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-destructive">
        <AlertCircle className="w-12 h-12" />
        <p>Error: {error}</p>
        <button 
          onClick={fetchHealth}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm"
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 overflow-auto h-full space-y-6 bg-background">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Activity className="w-6 h-6 text-primary" />
          Database Health Dashboard
        </h2>
        <button 
          onClick={fetchHealth}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Top Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl border bg-card text-card-foreground shadow-sm">
          <div className="flex items-center gap-3 mb-2">
            <Zap className="w-5 h-5 text-yellow-500" />
            <span className="text-sm font-medium text-muted-foreground">Active Connections</span>
          </div>
          <div className="text-3xl font-bold">{data?.activeConnections}</div>
        </div>

        <div className="p-4 rounded-xl border bg-card text-card-foreground shadow-sm">
          <div className="flex items-center gap-3 mb-2">
            <Database className="w-5 h-5 text-blue-500" />
            <span className="text-sm font-medium text-muted-foreground">Database Size</span>
          </div>
          <div className="text-3xl font-bold">{data?.databaseSize}</div>
        </div>

        <div className="p-4 rounded-xl border bg-card text-card-foreground shadow-sm">
          <div className="flex items-center gap-3 mb-2">
            <Activity className="w-5 h-5 text-green-500" />
            <span className="text-sm font-medium text-muted-foreground">Cache Hit Ratio</span>
          </div>
          <div className="text-3xl font-bold">
            {formatCacheHitRatio(data?.cacheHitRatio)}
          </div>
          <div className="w-full bg-secondary h-2 rounded-full mt-2 overflow-hidden">
            <div 
              className="bg-green-500 h-full transition-all duration-1000" 
              style={{ 
                width: `${getCacheHitRatioPercent(data?.cacheHitRatio)}%` 
              }}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Slow Queries */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Clock className="w-5 h-5 text-orange-500" />
            Slowest Queries
          </h3>
          <div className="border rounded-lg overflow-hidden bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-3 font-medium">Query Snippet</th>
                  <th className="p-3 font-medium text-right">Avg (ms)</th>
                  <th className="p-3 font-medium text-right">Calls</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data?.slowQueries.map((q, i) => (
                  <tr key={i} className="hover:bg-muted/30 transition-colors">
                    <td className="p-3 font-mono text-xs truncate max-w-[200px]" title={q.query}>
                      {q.query}
                    </td>
                    <td className="p-3 text-right">{q.avgTime || 'N/A'}</td>
                    <td className="p-3 text-right">{q.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Active Sessions */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            Active Sessions
          </h3>
          <div className="border rounded-lg overflow-hidden bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-3 font-medium">PID</th>
                  <th className="p-3 font-medium">State</th>
                  <th className="p-3 font-medium">Wait Event</th>
                  <th className="p-3 font-medium text-right">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data?.activeSessions.map((s, i) => (
                  <tr key={i} className="hover:bg-muted/30 transition-colors">
                    <td className="p-3 font-mono text-xs">{s.pid}</td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-bold ${
                        s.state === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-muted text-muted-foreground'
                      }`}>
                        {s.state}
                      </span>
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">{s.wait_event_type || 'None'}</td>
                    <td className="p-3 text-right text-xs">
                      {s.xact_start ? new Date(s.xact_start).toLocaleTimeString() : (s.duration || 'N/A')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
