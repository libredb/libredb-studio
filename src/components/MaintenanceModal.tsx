"use client";

import React, { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from '@/components/ui/button';
import { 
  RefreshCw, 
  Trash2, 
  Search, 
  Activity, 
  Skull, 
  Zap,
  HardDrive,
  Table as TableIcon,
  ShieldAlert,
  Clock
} from 'lucide-react';
import { toast } from 'sonner';
import { DatabaseConnection, TableSchema } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface HealthData {
  activeConnections?: number;
  databaseSize?: string;
  cacheHitRatio?: number | string;
  slowQueries?: Array<{
    query: string;
    calls: number;
    avgTime: string;
  }>;
  activeSessions?: Array<{
    pid: number | string;
    state: string;
    duration?: string;
  }>;
}

interface MaintenanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  connection: DatabaseConnection | null;
  tables: TableSchema[];
  initialTab?: 'global' | 'tables' | 'sessions';
  targetTable?: string;
}

export function MaintenanceModal({ 
  isOpen, 
  onClose, 
  connection, 
  tables,
  initialTab = 'global',
  targetTable
}: MaintenanceModalProps) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    if (!connection) return;
    setLoading(true);
    try {
      const res = await fetch('/api/db/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection }),
      });
      const data = await res.json();
      setHealthData(data);
    } catch (error) {
      console.error('Failed to fetch health:', error);
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    if (isOpen) {
      fetchHealth();
      if (targetTable) setActiveTab('tables');
      else setActiveTab(initialTab);
    }
  }, [isOpen, initialTab, targetTable, fetchHealth]);

  const runMaintenance = async (type: string, target?: string | number) => {
    const actionId = `${type}-${target || 'global'}`;
    setActionLoading(actionId);
    try {
      const res = await fetch('/api/db/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, target, connection }),
      });
      const result = await res.json();
      
      if (result.error) throw new Error(result.error);
      
      toast.success(`${type.toUpperCase()} completed in ${result.executionTime}ms`);
      if (type === 'kill') fetchHealth();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      toast.error('Operation failed: ' + errorMessage);
    } finally {
      setActionLoading(null);
    }
  };

  if (!connection) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl bg-zinc-950 border-white/10 text-zinc-100 p-0 overflow-hidden">
        <div className="bg-blue-500/5 p-6 border-b border-white/5">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                <ShieldAlert className="w-6 h-6 text-blue-400" />
              </div>
              <div>
                <DialogTitle className="text-xl">Database Maintenance</DialogTitle>
                <DialogDescription className="text-zinc-500 text-xs">
                  Connected to: <span className="text-blue-400 font-mono">{connection.database}</span> ({connection.host})
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        <Tabs value={activeTab} onValueChange={(v: string) => setActiveTab(v as 'global' | 'tables' | 'sessions')} className="p-0">
          <div className="px-6 border-b border-white/5 bg-zinc-900/30">
            <TabsList className="bg-transparent border-0 gap-6 h-12">
              <TabsTrigger 
                value="global" 
                className="data-[state=active]:bg-transparent data-[state=active]:text-blue-400 data-[state=active]:border-b-2 data-[state=active]:border-blue-400 rounded-none px-0 text-xs font-bold uppercase tracking-wider transition-all"
              >
                Global Tasks
              </TabsTrigger>
              <TabsTrigger 
                value="tables" 
                className="data-[state=active]:bg-transparent data-[state=active]:text-blue-400 data-[state=active]:border-b-2 data-[state=active]:border-blue-400 rounded-none px-0 text-xs font-bold uppercase tracking-wider transition-all"
              >
                Tables
              </TabsTrigger>
              <TabsTrigger 
                value="sessions" 
                className="data-[state=active]:bg-transparent data-[state=active]:text-blue-400 data-[state=active]:border-b-2 data-[state=active]:border-blue-400 rounded-none px-0 text-xs font-bold uppercase tracking-wider transition-all"
              >
                Active Sessions
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="p-6 max-h-[60vh] overflow-y-auto custom-scrollbar">
            <TabsContent value="global" className="mt-0 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] transition-colors group">
                  <div className="flex items-start justify-between mb-4">
                    <div className="w-8 h-8 rounded-lg bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center">
                      <Zap className="w-4 h-4 text-yellow-500" />
                    </div>
                    <Button 
                      size="sm" 
                      variant="outline" 
                      className="h-8 border-white/10 hover:bg-yellow-500/10 hover:text-yellow-500"
                      onClick={() => runMaintenance('analyze')}
                      disabled={!!actionLoading}
                    >
                      {actionLoading === 'analyze-global' ? <RefreshCw className="w-3 h-3 animate-spin mr-2" /> : null}
                      Run Analyze
                    </Button>
                  </div>
                  <h4 className="text-sm font-bold text-zinc-200 mb-1">Update Statistics</h4>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    Updates the planner&apos;s statistics for all tables in the database to improve query optimization.
                  </p>
                </div>

                <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] transition-colors group">
                  <div className="flex items-start justify-between mb-4">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                      <HardDrive className="w-4 h-4 text-blue-500" />
                    </div>
                    <Button 
                      size="sm" 
                      variant="outline" 
                      className="h-8 border-white/10 hover:bg-blue-500/10 hover:text-blue-500"
                      onClick={() => runMaintenance('vacuum')}
                      disabled={!!actionLoading}
                    >
                      {actionLoading === 'vacuum-global' ? <RefreshCw className="w-3 h-3 animate-spin mr-2" /> : null}
                      Run Vacuum
                    </Button>
                  </div>
                  <h4 className="text-sm font-bold text-zinc-200 mb-1">Reclaim Space</h4>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    Removes &quot;dead&quot; rows from tables and returns space to the operating system. Includes Analyze.
                  </p>
                </div>

                <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] transition-colors group">
                  <div className="flex items-start justify-between mb-4">
                    <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                      <RefreshCw className="w-4 h-4 text-purple-500" />
                    </div>
                    <Button 
                      size="sm" 
                      variant="outline" 
                      className="h-8 border-white/10 hover:bg-purple-500/10 hover:text-purple-500"
                      onClick={() => runMaintenance('reindex')}
                      disabled={!!actionLoading}
                    >
                      {actionLoading === 'reindex-global' ? <RefreshCw className="w-3 h-3 animate-spin mr-2" /> : null}
                      Run Reindex
                    </Button>
                  </div>
                  <h4 className="text-sm font-bold text-zinc-200 mb-1">Rebuild Indexes</h4>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    Reconstructs all indexes in the database. Useful for fixing bloat or corruption.
                  </p>
                </div>

                <div className="p-4 rounded-xl border border-red-500/10 bg-red-500/5 flex flex-col justify-center">
                  <div className="flex items-center gap-2 text-red-400 mb-2">
                    <ShieldAlert className="w-4 h-4" />
                    <span className="text-[11px] font-bold uppercase tracking-wider">Warning</span>
                  </div>
                  <p className="text-[11px] text-red-400/70 leading-relaxed italic">
                    These operations can be resource-intensive. Avoid running them during peak traffic hours if your database is large.
                  </p>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="tables" className="mt-0 space-y-2">
              <div className="flex items-center justify-between mb-4 bg-white/5 p-3 rounded-lg border border-white/5">
                <div className="flex items-center gap-2">
                  <TableIcon className="w-4 h-4 text-blue-400" />
                  <span className="text-xs font-bold text-zinc-300">Table Optimizer</span>
                </div>
                <span className="text-[10px] text-zinc-500">{tables.length} tables found</span>
              </div>
              
              <div className="space-y-1">
                {tables.map(table => (
                  <div 
                    key={table.name} 
                    className={cn(
                      "flex items-center justify-between p-2 rounded-md transition-colors",
                      targetTable === table.name ? "bg-blue-500/10 border border-blue-500/20" : "hover:bg-white/5 border border-transparent"
                    )}
                  >
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-zinc-200">{table.name}</span>
                      <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                        <span className="font-mono">{table.rowCount} rows</span>
                        <span>•</span>
                        <span className="font-mono">{table.size}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button 
                        size="icon" 
                        variant="ghost" 
                        className="w-8 h-8 text-zinc-500 hover:text-yellow-500"
                        title="Analyze Table"
                        onClick={() => runMaintenance('analyze', table.name)}
                        disabled={!!actionLoading}
                      >
                        {actionLoading === `analyze-${table.name}` ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                      </Button>
                      <Button 
                        size="icon" 
                        variant="ghost" 
                        className="w-8 h-8 text-zinc-500 hover:text-blue-500"
                        title="Vacuum Table"
                        onClick={() => runMaintenance('vacuum', table.name)}
                        disabled={!!actionLoading}
                      >
                        {actionLoading === `vacuum-${table.name}` ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="sessions" className="mt-0 space-y-4">
               <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-green-500" />
                  <span className="text-xs font-bold text-zinc-300">Active Database Sessions</span>
                </div>
                <Button 
                  size="sm" 
                  variant="ghost" 
                  className="h-8 text-[10px] text-zinc-500 hover:text-zinc-300"
                  onClick={fetchHealth}
                >
                  <RefreshCw className={cn("w-3 h-3 mr-2", loading && "animate-spin")} />
                  Refresh
                </Button>
              </div>

              <div className="border border-white/5 rounded-xl overflow-hidden bg-white/[0.02]">
                <table className="w-full text-left text-xs">
                  <thead className="bg-white/5 text-zinc-500 uppercase text-[10px] font-bold tracking-wider">
                    <tr>
                      <th className="px-4 py-3">PID</th>
                      <th className="px-4 py-3">State</th>
                      <th className="px-4 py-3">Duration</th>
                      <th className="px-4 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {healthData?.activeSessions?.map((session: { pid: number | string; state: string; duration?: string }) => (
                      <tr key={session.pid} className="group hover:bg-white/[0.03] transition-colors">
                        <td className="px-4 py-3 font-mono text-zinc-400">{session.pid}</td>
                        <td className="px-4 py-3">
                          <span className={cn(
                            "px-2 py-0.5 rounded-full text-[9px] font-bold uppercase",
                            session.state === 'active' ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20"
                          )}>
                            {session.state}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-zinc-500">
                          <div className="flex items-center gap-1.5">
                            <Clock className="w-3 h-3" />
                            <span>Active</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button 
                            size="icon" 
                            variant="ghost" 
                            className="w-8 h-8 text-zinc-600 hover:text-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                            onClick={() => runMaintenance('kill', session.pid)}
                            disabled={!!actionLoading}
                          >
                            <Skull className="w-3.5 h-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {!healthData?.activeSessions?.length && (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-zinc-600 italic">No active sessions found.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </TabsContent>
          </div>
        </Tabs>

        <div className="p-4 bg-zinc-900/50 border-t border-white/5 flex justify-end">
          <Button onClick={onClose} variant="secondary" className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-0">
            Close Panel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
