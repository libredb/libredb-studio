"use client";

import React, { useEffect, useId, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
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
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMonitoringData } from "@/hooks/use-monitoring-data";
import { storage } from "@/lib/storage";
import { useAllConnections } from "@/hooks/use-all-connections";
import { useProviderMetadata } from "@/hooks/use-provider-metadata";
import { useAuth } from "@/hooks/use-auth";
import { useCatalogs } from "@/hooks/use-catalogs";
import { declaresCatalogSessions } from "@/lib/db/object-kinds";
import { CatalogSelect } from "@/components/catalog-select";

import { OverviewTab } from "./tabs/OverviewTab";
import { PerformanceTab } from "./tabs/PerformanceTab";
import { QueriesTab } from "./tabs/QueriesTab";
import { SessionsTab } from "./tabs/SessionsTab";
import { TablesTab } from "./tabs/TablesTab";
import { StorageTab } from "./tabs/StorageTab";
import { PoolTab } from "./tabs/PoolTab";
import { withConnectedMaintenance } from "@/lib/db/types";
import { typeIdRefusal } from "@/lib/db/type-id";
import { engineFacetsFor } from "@/lib/db/engine-facets";
import type { MonitoringPanel } from "@/lib/db/engine-facets/types";
import { ConnectionTypeLabel } from "@/components/connection-type-label";
import {
  savedConnectionNotice,
  shownConnection,
  unavailableConnectionNotice,
  type UnavailableNotice,
} from "@/lib/connection-availability";
import { useToast } from "@/hooks/use-toast";

interface MonitoringDashboardProps {
  isEmbedded?: boolean;
}

/**
 * The dashboard's tabs in display order, each with the monitoring panel it draws. Pool has no panel: it reads the
 * connection pool, not `getMonitoringData`, so it is drawn for every engine that offers at least one panel; an engine
 * that offers none gets the "No Monitoring Panels" body and no tab at all. A tab whose panel the connection's engine
 * does not offer is not drawn. The index panel has no tab.
 */
const TABS: readonly { value: string; panel: MonitoringPanel | null; title: string; Icon: typeof Activity }[] = [
  { value: "overview", panel: "overview", title: "Overview", Icon: LayoutDashboard },
  { value: "performance", panel: "performance", title: "Performance", Icon: Activity },
  { value: "queries", panel: "slowQueries", title: "Queries", Icon: Clock },
  { value: "sessions", panel: "activeSessions", title: "Sessions", Icon: Users },
  { value: "tables", panel: "tables", title: "Tables", Icon: Table2 },
  { value: "storage", panel: "storage", title: "Storage", Icon: HardDrive },
  { value: "pool", panel: null, title: "Pool", Icon: Database },
];

export function MonitoringDashboard({ isEmbedded = false }: MonitoringDashboardProps) {
  const router = useRouter();
  // The stored active connection is read once, at mount: it seeds the default
  // selection and nothing re-reads it afterwards. `readString` answers null
  // without a window, so the server render and the hydration render agree.
  const [savedId] = useState(() => storage.getActiveConnectionId());
  // The ids are state: the user's pick here, and the connection the page opened on in
  // `shownId` below. The selected object is derived from them and the list, so it is
  // right on the render the connection list first arrives.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("overview");

  // Load connections (user + managed seed connections)
  const { connections: allConns } = useAllConnections();

  // The id of the connection the page opened on without a pick. It is held while that connection is listed, whatever
  // its type, as a pick is; only a connection that leaves the list is replaced (FND-1).
  const [shownId, setShownId] = useState<string | null>(null);

  // Derived, not stored: an explicit pick wins, otherwise `shownConnection`: the connection
  // the page opened on, otherwise `defaultConnection`, the saved active connection, otherwise
  // the first one, skipping any whose type names no provider (FND-1). Resolving against the
  // current list on every render also means a picked connection that disappears from it stops
  // being selected, instead of leaving a dead object behind. A connection that a later list
  // names no provider for stays selected, picked or not, and its refusal is drawn in place of
  // the tabs: the page does not switch by itself.
  const selectedConnection = useMemo(
    () =>
      chosenId !== null
        ? (allConns.find((c) => c.id === chosenId) ?? null)
        : shownConnection(allConns, shownId, savedId),
    [allConns, chosenId, shownId, savedId],
  );
  // Adjusting state during render, as SavedQueries does for its refresh trigger: the id recorded is the one drawn.
  if (chosenId === null && selectedConnection !== null && selectedConnection.id !== shownId) {
    setShownId(selectedConnection.id);
  }
  const selectedRefusal = selectedConnection === null ? null : typeIdRefusal(selectedConnection.type);
  // The panels the connection's engine offers, read from the same registry the server reads, so the tab bar is right
  // before the first payload. Read only once the type is known to be a type id: the refusal above answers any other.
  const offer =
    selectedConnection !== null && selectedRefusal === null
      ? engineFacetsFor(selectedConnection.type).monitoring
      : null;
  const offeredTabs = TABS.filter(({ panel }) => panel === null || offer?.[panel] === "offered");
  const notOfferedTitles = TABS.filter(({ panel }) => panel !== null && offer?.[panel] === "not-offered").map(
    ({ title }) => title,
  );
  // An engine that offers no panel has nothing for the monitoring read to fetch, so the hook below is handed no
  // connection and the page says so instead of drawing a lone Pool tab.
  const offersNoPanel = offer !== null && Object.values(offer).every((state) => state === "not-offered");
  // The open tab when the engine offers it, otherwise the first tab it does: a pick made on another connection does
  // not open a tab this one never draws.
  const shownTab = offeredTabs.some(({ value }) => value === activeTab) ? activeTab : offeredTabs[0].value;
  // The saved active connection, when the first list names no provider for its type, is not replaced in silence: the
  // notice is decided once, on the first list, and raised by the effect below (FND-1).
  const [savedNotice, setSavedNotice] = useState<UnavailableNotice | null | undefined>(undefined);
  if (savedNotice === undefined && allConns.length > 0) setSavedNotice(savedConnectionNotice(allConns, savedId));

  // Memoize options to prevent infinite re-renders
  const monitoringOptions = useMemo(
    () => ({
      includeTables: true,
      includeIndexes: true,
      includeStorage: true,
    }),
    [],
  );

  // Declared provider capabilities, so tabs can hide controls the provider cannot
  // perform (issue #272). Same hook Studio uses — no new API surface.
  const { metadata, error: metadataError } = useProviderMetadata(selectedConnection);

  // On a server-level connection the panels are one database's (#1530): the one the studio chose
  // last, or the one picked here. Nothing is read until there is one to name, nor while the
  // declaration that says whether there is one is still being read; a failed declaration reads as before.
  const {
    catalogs,
    catalog,
    setCatalog,
    error: catalogsError,
    retry: retryCatalogs,
  } = useCatalogs(selectedConnection, metadata?.capabilities);
  const waitingForCatalog =
    selectedConnection !== null &&
    (metadata === null
      ? metadataError === null
      : declaresCatalogSessions(metadata.capabilities) && catalog === undefined);

  const {
    data,
    loading,
    error,
    lastUpdated,
    autoRefresh,
    refreshInterval,
    history,
    setAutoRefresh,
    setRefreshInterval,
    refresh,
    killSession,
    runMaintenance,
    previewMaintenance,
  } = useMonitoringData(waitingForCatalog || offersNoPanel ? null : selectedConnection, monitoringOptions, catalog);

  // The connected provider's maintenance over the declared capabilities (#1387): see
  // `withConnectedMaintenance`. The Sessions tab's Terminate and the Tables tab's per-row
  // controls both read it.
  const capabilities = withConnectedMaintenance(metadata?.capabilities, data?.maintenance);

  // The route refuses maintenance and `kill` to anyone but an admin, so both tabs that offer
  // them are told the signed-in role (#1424). Unknown until /api/auth/me answers, which reads
  // as not an admin.
  const { isAdmin } = useAuth();

  // A provider whose compute resumes on any statement and is billed until it suspends: every
  // auto-refresh tick keeps it awake, so the toggle says so and names the sentence as its description.
  const billedComputeNoteId = useId();
  const resumesBilledCompute = metadata?.capabilities.resumesBilledCompute === true;

  const { toast } = useToast();

  // The id makes a second run of this effect, as React's development mode does, replace the notice instead of adding one.
  useEffect(() => {
    if (savedNotice) toast({ ...savedNotice, variant: "destructive", id: "saved-connection-unavailable" });
  }, [savedNotice, toast]);

  // A pick of a connection whose type names no provider is refused by name and changes
  // nothing, with the notice the editor raises for the same pick (FND-1).
  const handleConnectionChange = (connectionId: string) => {
    const picked = allConns.find((c) => c.id === connectionId);
    const refusal = picked === undefined ? null : typeIdRefusal(picked.type);
    if (picked !== undefined && refusal !== null) {
      toast({ ...unavailableConnectionNotice(picked, refusal.sentence), variant: "destructive" });
      return;
    }
    setChosenId(connectionId);
  };

  const formatLastUpdated = (date: Date | null) => {
    if (!date) return "Never";
    return date.toLocaleTimeString();
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header - Mobile Responsive */}
      <header className="border-b bg-card">
        {/* Top row: Back button, title, refresh controls */}
        <div className="flex items-center justify-between px-3 py-2 sm:px-4 sm:py-3">
          <div className="flex items-center gap-2 sm:gap-4">
            {!isEmbedded && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => router.push("/")}
                aria-label="Back"
                className="h-8 w-8 sm:h-9 sm:w-auto sm:px-3"
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline ml-2">Back</span>
              </Button>
            )}
            <div className="flex items-center gap-2">
              <Activity strokeWidth={1.5} className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
              <h1 className="text-xs sm:text-lg font-medium hidden xs:block">
                <span className="hidden sm:inline">Database </span>Monitoring
              </h1>
            </div>
          </div>

          {/* Refresh Controls */}
          <div className="flex items-center gap-1 sm:gap-2">
            <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground mr-2">
              <div className={`h-2 w-2 rounded-full ${autoRefresh ? "bg-hue-green-tint animate-pulse" : "bg-muted"}`} />
              <span className="hidden md:inline">{autoRefresh ? "Auto" : "Manual"}</span>
              <span className="hidden lg:inline text-xs">Last: {formatLastUpdated(lastUpdated)}</span>
            </div>

            {/* Interval selector */}
            <Select value={String(refreshInterval)} onValueChange={(v) => setRefreshInterval(Number(v))}>
              <SelectTrigger className="h-8 w-[80px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5000">5s</SelectItem>
                <SelectItem value="10000">10s</SelectItem>
                <SelectItem value="15000">15s</SelectItem>
                <SelectItem value="30000">30s</SelectItem>
                <SelectItem value="60000">60s</SelectItem>
              </SelectContent>
            </Select>

            {resumesBilledCompute && (
              <span id={billedComputeNoteId} className="max-w-[16rem] text-xs text-muted-foreground">
                Each refresh runs statements on this connection, which keeps its billed compute running.
              </span>
            )}

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setAutoRefresh(!autoRefresh)}
              title={autoRefresh ? "Pause auto-refresh" : "Start auto-refresh"}
              aria-describedby={resumesBilledCompute ? billedComputeNoteId : undefined}
            >
              {autoRefresh ? <Pause className="h-4 w-4" /> : <Play strokeWidth={1.5} className="h-4 w-4" />}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={refresh}
              disabled={loading}
              title="Refresh now"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {/* Bottom row: Connection selector (mobile-friendly), and the database on a server-level one */}
        <div className="flex flex-col gap-2 px-3 pb-2 sm:flex-row sm:items-center sm:px-4 sm:pb-3">
          <Select value={selectedConnection?.id || ""} onValueChange={handleConnectionChange}>
            <SelectTrigger className="w-full sm:w-[280px]">
              <SelectValue placeholder="Select connection">
                {selectedConnection ? (
                  <div className="flex items-center gap-2">
                    <Database strokeWidth={1.5} className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate">{selectedConnection.name}</span>
                    <ConnectionTypeLabel type={selectedConnection.type} className="hidden sm:inline" />
                  </div>
                ) : (
                  "Select connection"
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {allConns.map((conn) => (
                <SelectItem key={conn.id} value={conn.id}>
                  <div className="flex items-center gap-2">
                    <Database strokeWidth={1.5} className="h-4 w-4" />
                    <span>{conn.name}</span>
                    <ConnectionTypeLabel type={conn.type} />
                  </div>
                </SelectItem>
              ))}
              {allConns.length === 0 && (
                <div className="px-2 py-1 text-xs text-muted-foreground">No connections available</div>
              )}
            </SelectContent>
          </Select>
          <CatalogSelect
            catalogs={catalogs}
            value={catalog}
            onChange={setCatalog}
            className="h-9 w-full sm:w-[220px]"
          />
        </div>
      </header>

      {/* Main Content */}
      {!selectedConnection ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 text-muted-foreground">
          <Database strokeWidth={1.5} className="h-12 w-12" />
          <h2 className="text-lg font-medium">No Connection Selected</h2>
          <p className="text-xs">Select a database connection to view monitoring data.</p>
          <Button variant="outline" onClick={() => router.push("/")}>
            Manage Connections
          </Button>
        </div>
      ) : offer === null ? (
        // A selected connection has no offer exactly when its type is refused.
        <div className="flex flex-col items-center justify-center flex-1 gap-4 text-muted-foreground">
          <Database strokeWidth={1.5} className="h-12 w-12" />
          <h2 className="text-lg font-medium">Connection Unavailable</h2>
          <p className="text-xs">{selectedRefusal?.sentence}</p>
        </div>
      ) : offersNoPanel ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 text-muted-foreground">
          <Database strokeWidth={1.5} className="h-12 w-12" />
          <h2 className="text-lg font-medium">No Monitoring Panels</h2>
          <p className="text-xs">This engine offers no monitoring panel in LibreDB Studio.</p>
        </div>
      ) : (catalogsError ?? error) && !data ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 text-destructive">
          <Activity strokeWidth={1.5} className="h-12 w-12" />
          <h2 className="text-lg font-medium">Connection Error</h2>
          <p className="text-xs">{catalogsError ?? error}</p>
          <Button variant="outline" onClick={catalogsError === null ? refresh : retryCatalogs}>
            Try Again
          </Button>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <Tabs value={shownTab} onValueChange={setActiveTab} className="flex flex-col h-full">
            {/* Tab Bar - Icon only on mobile, Icon + Text on desktop */}
            <div className="border-b bg-muted/30">
              <TabsList className="h-12 w-full justify-between sm:justify-start rounded-none bg-transparent p-0">
                {offeredTabs.map(({ value, title, Icon }) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    className="flex-1 sm:flex-initial gap-2 px-2 sm:px-4 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent text-xs sm:text-xs"
                    title={title}
                  >
                    <Icon strokeWidth={1.5} className="h-4 w-4 sm:h-4 sm:w-4" />
                    <span className="hidden sm:inline">{title}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
              {notOfferedTitles.length > 0 && (
                <p className="px-3 py-1 text-xs text-muted-foreground sm:px-4" data-testid="monitoring-not-offered">
                  {`Not offered by this engine: ${notOfferedTitles.join(", ")}.`}
                </p>
              )}
              {/* A failed refresh keeps this selection's earlier payload, so the failure is named beside it. */}
              {error && (
                <p
                  className="px-3 py-1 text-xs text-destructive sm:px-4"
                  role="alert"
                  data-testid="monitoring-read-failed"
                >
                  {`The last read failed, so the panels show the one before it: ${error}`}
                </p>
              )}
            </div>

            <div className="flex-1 overflow-auto">
              <TabsContent value="overview" className="h-full m-0 p-0">
                <OverviewTab offer={offer} data={data} loading={loading} history={history} />
              </TabsContent>
              <TabsContent value="performance" className="h-full m-0 p-0">
                <PerformanceTab data={data} loading={loading} history={history} />
              </TabsContent>
              <TabsContent value="queries" className="h-full m-0 p-0">
                <QueriesTab data={data} loading={loading} labels={metadata?.labels} />
              </TabsContent>
              <TabsContent value="sessions" className="h-full m-0 p-0">
                <SessionsTab
                  data={data}
                  loading={loading}
                  onKillSession={killSession}
                  labels={metadata?.labels}
                  isAdmin={isAdmin}
                  capabilities={capabilities}
                />
              </TabsContent>
              <TabsContent value="tables" className="h-full m-0 p-0">
                <TablesTab
                  data={data}
                  loading={loading}
                  onRunMaintenance={runMaintenance}
                  onPreviewMaintenance={previewMaintenance}
                  capabilities={capabilities}
                  isAdmin={isAdmin}
                  labels={metadata?.labels}
                  // The provider refuses every maintenance operation on a read-only connection (#1418).
                  readOnly={selectedConnection?.readOnly === true}
                />
              </TabsContent>
              <TabsContent value="storage" className="h-full m-0 p-0">
                <StorageTab offer={offer} data={data} loading={loading} />
              </TabsContent>
              <TabsContent value="pool" className="h-full m-0 p-0">
                <PoolTab connection={selectedConnection} catalog={catalog} />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      )}
    </div>
  );
}
