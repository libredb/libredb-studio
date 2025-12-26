'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  LayoutDashboard,
  Clock,
  Users,
  Table2,
  HardDrive,
  RefreshCw,
  ArrowLeft,
  Play,
  Pause,
  Database,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMonitoringData } from '@/hooks/use-monitoring-data';
import { storage } from '@/lib/storage';
import type { DatabaseConnection } from '@/lib/types';

import { OverviewTab } from './tabs/OverviewTab';
import { PerformanceTab } from './tabs/PerformanceTab';
import { QueriesTab } from './tabs/QueriesTab';
import { SessionsTab } from './tabs/SessionsTab';
import { TablesTab } from './tabs/TablesTab';
import { StorageTab } from './tabs/StorageTab';

export function MonitoringDashboard() {
  const router = useRouter();
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [selectedConnection, setSelectedConnection] = useState<DatabaseConnection | null>(null);
  const [activeTab, setActiveTab] = useState('overview');

  // Memoize options to prevent infinite re-renders
  const monitoringOptions = useMemo(() => ({
    includeTables: true,
    includeIndexes: true,
    includeStorage: true,
  }), []);

  const {
    data,
    loading,
    error,
    lastUpdated,
    autoRefresh,
    setAutoRefresh,
    refresh,
    killSession,
    runMaintenance,
  } = useMonitoringData(selectedConnection, monitoringOptions);

  // Load connections on mount
  useEffect(() => {
    const loadedConnections = storage.getConnections();
    setConnections(loadedConnections);

    // Auto-select first connection if available
    if (loadedConnections.length > 0 && !selectedConnection) {
      setSelectedConnection(loadedConnections[0]);
    }
  }, [selectedConnection]);

  const handleConnectionChange = (connectionId: string) => {
    const connection = connections.find((c) => c.id === connectionId);
    setSelectedConnection(connection || null);
  };

  const formatLastUpdated = (date: Date | null) => {
    if (!date) return 'Never';
    return date.toLocaleTimeString();
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header - Mobile Responsive */}
      <header className="border-b bg-card">
        {/* Top row: Back button, title, refresh controls */}
        <div className="flex items-center justify-between px-3 py-2 sm:px-4 sm:py-3">
          <div className="flex items-center gap-2 sm:gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push('/')}
              className="h-8 w-8 sm:h-9 sm:w-auto sm:px-3"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline ml-2">Back</span>
            </Button>
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
              <h1 className="text-sm sm:text-lg font-semibold hidden xs:block">
                <span className="hidden sm:inline">Database </span>Monitoring
              </h1>
            </div>
          </div>

          {/* Refresh Controls */}
          <div className="flex items-center gap-1 sm:gap-2">
            <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground mr-2">
              <div
                className={`h-2 w-2 rounded-full ${autoRefresh ? 'bg-green-500 animate-pulse' : 'bg-muted'}`}
              />
              <span className="hidden md:inline">
                {autoRefresh ? 'Auto' : 'Manual'}
              </span>
              <span className="hidden lg:inline text-xs">
                Last: {formatLastUpdated(lastUpdated)}
              </span>
            </div>

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setAutoRefresh(!autoRefresh)}
              title={autoRefresh ? 'Pause auto-refresh' : 'Start auto-refresh'}
            >
              {autoRefresh ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={refresh}
              disabled={loading}
              title="Refresh now"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {/* Bottom row: Connection selector (mobile-friendly) */}
        <div className="px-3 pb-2 sm:px-4 sm:pb-3">
          <Select
            value={selectedConnection?.id || ''}
            onValueChange={handleConnectionChange}
          >
            <SelectTrigger className="w-full sm:w-[280px]">
              <SelectValue placeholder="Select connection">
                {selectedConnection ? (
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate">{selectedConnection.name}</span>
                    <span className="text-xs text-muted-foreground hidden sm:inline">
                      ({selectedConnection.type})
                    </span>
                  </div>
                ) : (
                  'Select connection'
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {connections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id}>
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4" />
                    <span>{conn.name}</span>
                    <span className="text-xs text-muted-foreground">({conn.type})</span>
                  </div>
                </SelectItem>
              ))}
              {connections.length === 0 && (
                <div className="px-2 py-1 text-sm text-muted-foreground">
                  No connections available
                </div>
              )}
            </SelectContent>
          </Select>
        </div>
      </header>

      {/* Main Content */}
      {!selectedConnection ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 text-muted-foreground">
          <Database className="h-12 w-12" />
          <h2 className="text-lg font-medium">No Connection Selected</h2>
          <p className="text-sm">Select a database connection to view monitoring data.</p>
          <Button variant="outline" onClick={() => router.push('/')}>
            Manage Connections
          </Button>
        </div>
      ) : error && !data ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 text-destructive">
          <Activity className="h-12 w-12" />
          <h2 className="text-lg font-medium">Connection Error</h2>
          <p className="text-sm">{error}</p>
          <Button variant="outline" onClick={refresh}>
            Try Again
          </Button>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex flex-col h-full"
          >
            {/* Tab Bar - Icon only on mobile, Icon + Text on desktop */}
            <div className="border-b bg-muted/30">
              <TabsList className="h-12 w-full justify-between sm:justify-start rounded-none bg-transparent p-0">
                <TabsTrigger
                  value="overview"
                  className="flex-1 sm:flex-initial gap-2 px-2 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs sm:text-sm"
                  title="Overview"
                >
                  <LayoutDashboard className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Overview</span>
                </TabsTrigger>
                <TabsTrigger
                  value="performance"
                  className="flex-1 sm:flex-initial gap-2 px-2 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs sm:text-sm"
                  title="Performance"
                >
                  <Activity className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Performance</span>
                </TabsTrigger>
                <TabsTrigger
                  value="queries"
                  className="flex-1 sm:flex-initial gap-2 px-2 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs sm:text-sm"
                  title="Queries"
                >
                  <Clock className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Queries</span>
                </TabsTrigger>
                <TabsTrigger
                  value="sessions"
                  className="flex-1 sm:flex-initial gap-2 px-2 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs sm:text-sm"
                  title="Sessions"
                >
                  <Users className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Sessions</span>
                </TabsTrigger>
                <TabsTrigger
                  value="tables"
                  className="flex-1 sm:flex-initial gap-2 px-2 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs sm:text-sm"
                  title="Tables"
                >
                  <Table2 className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Tables</span>
                </TabsTrigger>
                <TabsTrigger
                  value="storage"
                  className="flex-1 sm:flex-initial gap-2 px-2 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs sm:text-sm"
                  title="Storage"
                >
                  <HardDrive className="h-4 w-4 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Storage</span>
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="flex-1 overflow-auto">
              <TabsContent value="overview" className="h-full m-0 p-0">
                <OverviewTab data={data} loading={loading} />
              </TabsContent>
              <TabsContent value="performance" className="h-full m-0 p-0">
                <PerformanceTab data={data} loading={loading} />
              </TabsContent>
              <TabsContent value="queries" className="h-full m-0 p-0">
                <QueriesTab data={data} loading={loading} />
              </TabsContent>
              <TabsContent value="sessions" className="h-full m-0 p-0">
                <SessionsTab
                  data={data}
                  loading={loading}
                  onKillSession={killSession}
                />
              </TabsContent>
              <TabsContent value="tables" className="h-full m-0 p-0">
                <TablesTab
                  data={data}
                  loading={loading}
                  onRunMaintenance={runMaintenance}
                />
              </TabsContent>
              <TabsContent value="storage" className="h-full m-0 p-0">
                <StorageTab data={data} loading={loading} />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      )}
    </div>
  );
}
