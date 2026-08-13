"use client";

import React, { useMemo } from "react";
import type { DatabaseConnection, QueryTab, TableSchema, QueryResult } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import type { MaskingConfig } from "@/lib/data-masking";
import type { AgentArtifactHydration } from "@/components/agent/hydration";
import type { CellChange } from "@/components/ResultsGrid";
import { ResultsGrid } from "@/components/ResultsGrid";
import { PivotTable } from "@/components/PivotTable";
import { DatabaseDocs } from "@/components/DatabaseDocs";
import { VisualExplain } from "@/components/VisualExplain";
import { QueryHistory } from "@/components/QueryHistory";
import { SavedQueries } from "@/components/SavedQueries";
import { DataCharts } from "@/components/DataCharts";
import { SchemaDiff } from "@/components/SchemaDiff";
import { resolveExplainPlan } from "@/lib/explain";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  Bookmark,
  Clock,
  Columns3,
  Download,
  FileText,
  GitCompare,
  LayoutDashboard,
  LayoutGrid,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { storage } from "@/lib/storage";

export type BottomPanelMode =
  | "results"
  | "explain"
  | "history"
  | "saved"
  | "charts"
  | "pivot"
  | "docs"
  | "schemadiff"
  | "dashboard";

// Lazy-loaded chart dashboard
function ChartDashboardLazy({ result }: { result: QueryResult | null }) {
  const [savedCharts, setSavedCharts] = React.useState<
    { id: string; name: string; chartType: string; xAxis: string; yAxis: string[] }[]
  >([]);
  React.useEffect(() => {
    const charts = storage.getSavedCharts();
    if (charts.length > 0) setSavedCharts(charts);
  }, []);

  if (savedCharts.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[#080808] text-zinc-500 gap-2">
        <LayoutDashboard strokeWidth={1.5} className="w-10 h-10 opacity-30" />
        <p className="text-xs">No saved charts yet</p>
        <p className="text-xs text-zinc-600">Save charts from the Charts tab to display them here</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-[#080808] p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {savedCharts.map((chart) => (
          <div key={chart.id} className="bg-[#0d0d0d] border border-white/10 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-300">{chart.name}</span>
              <span className="text-xs text-zinc-600">{chart.chartType}</span>
            </div>
            <div className="text-xs text-zinc-500">
              {chart.xAxis && <span>X: {chart.xAxis}</span>}
              {chart.yAxis?.length > 0 && <span className="ml-2">Y: {chart.yAxis.join(", ")}</span>}
            </div>
            {result ? (
              <div className="mt-2 h-[160px]">
                <DataCharts result={result} />
              </div>
            ) : (
              <div className="mt-2 h-[100px] flex items-center justify-center text-zinc-600 text-xs">
                Execute a query to see chart
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface BottomPanelProps {
  mode: BottomPanelMode;
  onSetMode: (mode: BottomPanelMode) => void;
  currentTab: QueryTab;
  schema: TableSchema[];
  schemaContext: string;
  activeConnection: DatabaseConnection | null;
  metadata: ProviderMetadata | null;
  historyKey: number;
  savedKey: number;
  // Masking
  maskingEnabled: boolean;
  onToggleMasking: (() => void) | undefined;
  userRole: string | undefined;
  maskingConfig: MaskingConfig;
  // Editing
  editingEnabled: boolean;
  pendingChanges: CellChange[];
  onCellChange: (change: CellChange) => void;
  onApplyChanges: () => void;
  onDiscardChanges: () => void;
  // Actions
  onLoadQuery: (query: string) => void;
  onLoadMore: (() => void) | undefined;
  isLoadingMore: boolean | undefined;
  onExportResults: (format: "csv" | "json" | "sql-insert" | "sql-ddl") => void;
  /**
   * A result an agent run stored, shown in the surface that already renders that
   * kind of result (#329 T11). Optional so every other caller — the embedded shell
   * included — is unchanged, and null whenever nothing is hydrated.
   */
  agentArtifact?: AgentArtifactHydration | null;
  onDismissAgentArtifact?: () => void;
}

export function BottomPanel({
  mode,
  onSetMode,
  currentTab,
  schema,
  schemaContext,
  activeConnection,
  metadata,
  historyKey,
  savedKey,
  maskingEnabled,
  onToggleMasking,
  userRole,
  maskingConfig,
  editingEnabled,
  pendingChanges,
  onCellChange,
  onApplyChanges,
  onDiscardChanges,
  onLoadQuery,
  onLoadMore,
  isLoadingMore,
  onExportResults,
  agentArtifact = null,
  onDismissAgentArtifact,
}: BottomPanelProps) {
  const explainInput = useMemo(() => resolveExplainPlan(currentTab.explainPlan), [currentTab.explainPlan]);

  /*
    An agent artifact is shown in ONE surface — the one its operation produced — and
    the tab's own state is never overwritten to do it. So the grid and the explain
    view each ask whether this artifact is theirs, every other view keeps showing the
    tab's own result (chart hydration is deferred; see `docs/BACKLOG.md`), and
    dismissing the artifact restores the tab with nothing to undo.

    While one is shown the view is read-only: inline editing writes rows back through
    the tab's connection and pagination continues the tab's own query, so neither
    means anything for a stored result. Export is absent for the same reason — it
    exports the tab's result, which is not what the user is looking at.
  */
  const hydratedResult = agentArtifact?.surface === "results" ? agentArtifact.result : null;
  const hydratedPlan = useMemo(
    () => (agentArtifact?.surface === "explain" ? resolveExplainPlan(agentArtifact.explainPlan) : null),
    [agentArtifact],
  );
  const hydratedHere =
    agentArtifact !== null &&
    ((mode === "results" && hydratedResult !== null) || (mode === "explain" && hydratedPlan !== null));
  const displayedResult = hydratedResult ?? currentTab.result;

  const tabs: { key: BottomPanelMode; label: string; icon: React.ReactNode; activeClass: string }[] = [
    {
      key: "results",
      label: "Results",
      icon: <LayoutGrid strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-blue-400 border-blue-500 bg-white/5",
    },
    {
      key: "explain",
      label: "Explain",
      icon: <Zap strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-amber-400 border-amber-500 bg-white/5",
    },
    {
      key: "history",
      label: "History",
      icon: <Clock strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-emerald-400 border-emerald-500 bg-white/5",
    },
    {
      key: "saved",
      label: "Saved",
      icon: <Bookmark strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-purple-400 border-purple-500 bg-white/5",
    },
    {
      key: "charts",
      label: "Charts",
      icon: <BarChart3 strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-cyan-400 border-cyan-500 bg-white/5",
    },
    {
      key: "pivot",
      label: "Pivot",
      icon: <Columns3 strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-orange-400 border-orange-500 bg-white/5",
    },
    {
      key: "docs",
      label: "Docs",
      icon: <FileText strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-teal-400 border-teal-500 bg-white/5",
    },
    {
      key: "schemadiff",
      label: "Diff",
      icon: <GitCompare strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-rose-400 border-rose-500 bg-white/5",
    },
    {
      key: "dashboard",
      label: "Dashboard",
      icon: <LayoutDashboard strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-indigo-400 border-indigo-500 bg-white/5",
    },
  ];

  const visibleTabs = metadata?.capabilities.explainFormat ? tabs : tabs.filter((tab) => tab.key !== "explain");

  return (
    <div className="h-full flex flex-col bg-[#080808]">
      <div className="h-9 bg-[#0a0a0a] border-b border-white/5 flex items-center justify-between px-2">
        <div className="flex items-center h-full gap-1">
          {visibleTabs.map((tab) => (
            <button
              key={tab.key}
              data-testid={tab.key === "explain" ? "bottom-panel-tab-explain" : undefined}
              onClick={() => onSetMode(tab.key)}
              className={cn(
                "h-full px-3 text-xs font-medium transition-all border-b-2 flex items-center gap-2",
                mode === tab.key ? tab.activeClass : "text-zinc-500 border-transparent hover:text-zinc-300",
              )}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {displayedResult && mode === "results" && (
          <div className="flex items-center gap-1">
            <span className="text-xs font-mono text-zinc-500 mr-2">
              {displayedResult.rowCount} rows • {displayedResult.executionTime}ms
            </span>
            {!hydratedHere && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs font-medium text-zinc-500 hover:text-white gap-2"
                  >
                    <Download strokeWidth={1.5} className="w-3 h-3" /> Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-[#0d0d0d] border-white/10 text-zinc-300">
                  <DropdownMenuItem onClick={() => onExportResults("csv")} className="text-xs cursor-pointer">
                    Export as CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onExportResults("json")} className="text-xs cursor-pointer">
                    Export as JSON
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onExportResults("sql-insert")} className="text-xs cursor-pointer">
                    Export as SQL INSERT
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onExportResults("sql-ddl")} className="text-xs cursor-pointer">
                    Export as DDL (CREATE TABLE)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>

      {/*
        Provenance, stated where the rows are read rather than only in the rail: these
        rows were produced by a run, not by the statement in the editor above them.
      */}
      {hydratedHere && agentArtifact !== null && (
        <div
          data-testid="agent-provenance"
          className="flex items-center justify-between gap-2 px-3 py-1 border-b border-blue-500/20 bg-blue-500/5"
        >
          <span className="text-xs text-blue-300/90">
            Stored by agent run <span className="font-mono text-[0.625rem]">{agentArtifact.runId}</span> via{" "}
            <span className="font-mono text-[0.625rem]">{agentArtifact.operationId}</span>{" "}
            {/* The audit correlation id: what joins these rows to the audit line for
                the statement that produced them. */}
            <span className="font-mono text-[0.625rem] text-zinc-500">{agentArtifact.correlationId}</span> — read-only
          </span>
          <button
            type="button"
            data-testid="agent-provenance-dismiss"
            onClick={onDismissAgentArtifact}
            className="p-1 rounded text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
            aria-label="Dismiss the agent result"
          >
            <X strokeWidth={1.5} className="w-3 h-3" />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-hidden relative">
        {mode === "pivot" ? (
          <PivotTable
            result={currentTab.result}
            onLoadQuery={(q) => {
              onLoadQuery(q);
              onSetMode("results");
            }}
            databaseType={activeConnection?.type}
          />
        ) : mode === "docs" ? (
          <DatabaseDocs schema={schema} schemaContext={schemaContext} databaseType={activeConnection?.type} />
        ) : mode === "history" ? (
          <QueryHistory
            refreshTrigger={historyKey}
            activeConnectionId={activeConnection?.id}
            onSelectQuery={(q) => {
              onLoadQuery(q);
              onSetMode("results");
            }}
          />
        ) : mode === "saved" ? (
          <SavedQueries
            refreshTrigger={savedKey}
            connectionType={activeConnection?.type}
            onSelectQuery={(q) => {
              onLoadQuery(q);
              onSetMode("results");
            }}
          />
        ) : mode === "charts" ? (
          <DataCharts result={currentTab.result} />
        ) : mode === "schemadiff" ? (
          <SchemaDiff schema={schema} connection={activeConnection} />
        ) : mode === "dashboard" ? (
          <ChartDashboardLazy result={currentTab.result} />
        ) : mode === "explain" ? (
          <VisualExplain
            plan={hydratedPlan ?? explainInput}
            /*
              A run's plan travels without the editor's statement. The AI analysis in
              this view posts the query and the plan together, so pairing a hydrated
              plan with whatever happens to be in the editor would ask for an
              explanation of a statement that never produced it; with no query the view
              says so itself instead.
            */
            query={hydratedPlan === null ? currentTab.query : undefined}
            schemaContext={schemaContext}
            databaseType={activeConnection?.type}
            onLoadQuery={(q) => {
              onLoadQuery(q);
              onSetMode("results");
            }}
          />
        ) : displayedResult ? (
          <ResultsGrid
            result={displayedResult}
            onLoadMore={hydratedHere ? undefined : onLoadMore}
            isLoadingMore={isLoadingMore}
            maskingEnabled={maskingEnabled}
            onToggleMasking={onToggleMasking}
            userRole={userRole}
            maskingConfig={maskingConfig}
            editingEnabled={hydratedHere ? false : editingEnabled}
            pendingChanges={pendingChanges}
            onCellChange={onCellChange}
            onApplyChanges={onApplyChanges}
            onDiscardChanges={onDiscardChanges}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center opacity-20 bg-[#0a0a0a]">
            <Terminal strokeWidth={1.5} className="w-12 h-12 mb-4" />
            <p className="text-xs font-medium">Execute a query or check history</p>
            <p className="text-xs mt-2">Ready to query</p>
          </div>
        )}
      </div>
    </div>
  );
}
