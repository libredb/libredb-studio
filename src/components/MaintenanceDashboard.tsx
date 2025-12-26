'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Database,
  RefreshCw,
  Trash2,
  Search,
  Activity,
  Skull,
  AlertTriangle,
  Zap,
  HardDrive,
  Table as TableIcon
} from 'lucide-react';
import { toast } from 'sonner';
import { DatabaseConnection, TableSchema } from '@/lib/types';

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
import { storage } from '@/lib/storage';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function MaintenanceDashboard() {
  const [tables, setTables] = useState<TableSchema[]>([]);
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [selectedConnection, setSelectedConnection] = useState<DatabaseConnection | null>(null);

  useEffect(() => {
    const savedConnections = storage.getConnections();
    setConnections(savedConnections);
    if (savedConnections.length > 0) {
      setSelectedConnection(savedConnections[0]);
    }
  }, []);

  const fetchData = useCallback(async () => {
    if (!selectedConnection) return;
    setLoading(true);
    try {
      // Fetch schema for table list
      const schemaRes = await fetch('/api/db/schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedConnection),
      });
      const schemaData = await schemaRes.json();
      if (schemaData.error) throw new Error(schemaData.error);
      setTables(schemaData);

      // Fetch health data for connections
      const healthRes = await fetch('/api/db/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection: selectedConnection }),
      });
      const healthResult = await healthRes.json();
      setHealthData(healthResult);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      toast.error('Failed to load maintenance data: ' + errorMessage);
    } finally {
      setLoading(false);
    }
  }, [selectedConnection]);

  useEffect(() => {
    if (selectedConnection) {
      fetchData();
    }
  }, [selectedConnection, fetchData]);

  const runMaintenance = async (type: string, target?: string | number) => {
    if (!selectedConnection) {
      toast.error('Please select a database connection first');
      return;
    }
    const actionId = `${type}-${target || 'global'}`;
    setActionLoading(actionId);
    try {
      const res = await fetch('/api/db/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, target, connection: selectedConnection }),
      });
      const result = await res.json();

      if (result.error) throw new Error(result.error);

      toast.success(`${type.toUpperCase()} completed in ${result.executionTime}ms`);
      if (type === 'kill') fetchData(); // Refresh connections
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      toast.error('Operation failed: ' + errorMessage);
    } finally {
      setActionLoading(null);
    }
  };

  if (connections.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <Database className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-semibold mb-2">No Database Connections</h3>
        <p className="text-muted-foreground">
          Please add a database connection from the main dashboard first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Database Maintenance</h2>
          <p className="text-muted-foreground">Perform DBA-level operations and optimize performance.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={selectedConnection?.id}
            onValueChange={(id) => {
              const conn = connections.find(c => c.id === id);
              if (conn) setSelectedConnection(conn);
            }}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Select connection" />
            </SelectTrigger>
            <SelectContent>
              {connections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id}>
                  {conn.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading || !selectedConnection}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh Stats
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card className="bg-yellow-500/10 border-yellow-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Zap className="h-4 w-4 text-yellow-600" />
              Analyze
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button 
              className="w-full" 
              variant="outline" 
              onClick={() => runMaintenance('analyze')}
              disabled={!!actionLoading}
            >
              Update All Stats
            </Button>
          </CardContent>
        </Card>
        <Card className="bg-blue-500/10 border-blue-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-blue-600" />
              Vacuum
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button 
              className="w-full" 
              variant="outline" 
              onClick={() => runMaintenance('vacuum')}
              disabled={!!actionLoading}
            >
              Reclaim Space
            </Button>
          </CardContent>
        </Card>
        <Card className="bg-purple-500/10 border-purple-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-purple-600" />
              Reindex
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button 
              className="w-full" 
              variant="outline" 
              onClick={() => runMaintenance('reindex')}
              disabled={!!actionLoading}
            >
              Rebuild All Indexes
            </Button>
          </CardContent>
        </Card>
        <Card className="bg-red-500/10 border-red-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-600" />
              Critical
            </CardTitle>
          </CardHeader>
          <CardContent>
             <div className="text-xs text-muted-foreground text-center italic">
               Be careful with global operations on large databases.
             </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Table Specific Maintenance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TableIcon className="h-5 w-5" />
              Table Maintenance
            </CardTitle>
            <CardDescription>Optimize individual tables.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-[400px] overflow-auto border rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-muted sticky top-0">
                  <tr className="text-left">
                    <th className="p-2">Table</th>
                    <th className="p-2">Size</th>
                    <th className="p-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tables.map((table) => (
                    <tr key={table.name} className="hover:bg-muted/50">
                      <td className="p-2 font-medium">{table.name}</td>
                      <td className="p-2 text-muted-foreground">{table.size}</td>
                      <td className="p-2 text-right space-x-1">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          title="Analyze"
                          onClick={() => runMaintenance('analyze', table.name)}
                          disabled={!!actionLoading}
                        >
                          <Search className="h-3 w-3" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          title="Vacuum"
                          onClick={() => runMaintenance('vacuum', table.name)}
                          disabled={!!actionLoading}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Active Connections */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Active Connections
            </CardTitle>
            <CardDescription>Monitor and manage database sessions.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-[400px] overflow-auto border rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-muted sticky top-0">
                  <tr className="text-left">
                    <th className="p-2">PID</th>
                    <th className="p-2">State</th>
                    <th className="p-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {healthData?.activeSessions?.map((session: { pid: number | string; state: string }) => (
                    <tr key={session.pid} className="hover:bg-muted/50">
                      <td className="p-2 font-mono text-xs">{session.pid}</td>
                      <td className="p-2">
                        <span className={`px-1.5 py-0.5 rounded-full text-[10px] uppercase font-bold ${
                          session.state === 'active' ? 'bg-green-100 text-green-700' : 'bg-muted text-muted-foreground'
                        }`}>
                          {session.state}
                        </span>
                      </td>
                      <td className="p-2 text-right">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="text-red-500 hover:text-red-700"
                          title="Kill Session"
                          onClick={() => runMaintenance('kill', session.pid)}
                          disabled={!!actionLoading}
                        >
                          <Skull className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {(!healthData?.activeSessions || healthData.activeSessions.length === 0) && (
                    <tr>
                      <td colSpan={3} className="p-4 text-center text-muted-foreground">No active sessions found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
