"use client";

import React, { useMemo } from "react";
import type { DatabaseConnection, QueryTab, TableSchema, QueryResult } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import type { MaskingConfig } from "@/lib/data-masking";
import type { AgentArtifactHydration } from "@/components/agent/hydration";
import type { CellChange } from "@/components/ResultsGrid";
import { ResultsGrid } from "@/components/ResultsGrid";
import { QueryHistory } from "@/components/QueryHistory";
import { SavedQueries } from "@/components/SavedQueries";
import { ChunkBoundary, ViewLoading } from "@/components/LazyView";
import { lazyRetry } from "@/lib/lazy";
import { describeExportScope } from "@/lib/export/scope";
import type { ResultExportFormat } from "@/lib/export/result-export";

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
  DropdownMenuSeparator,
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

/*
  The panel's heavy views, split out of the first load.

  Each one is already gated on `mode`, so only one of them can be on screen and most
  sessions never open the others — but a static import puts every one of them, and the
  libraries they pull in, into the bundle that has to arrive before the editor can be
  typed in. `DataCharts` alone brings recharts; `VisualExplain` and `SchemaDiff` bring
  their own trees.

  `React.lazy` rather than `next/dynamic`: this file is reached from BOTH shells, and
  the embeddable one (`src/workspace/StudioWorkspace.tsx`) deliberately imports nothing
  from `next` — a `next/dynamic` here would put the framework into the published
  package's module graph. Next's bundler splits on the dynamic `import()` either way.

  Not split: `ResultsGrid` is the default view and would only trade a chunk for a
  flash, and `QueryHistory`/`SavedQueries` are small and pull in nothing heavy.

  Each loader is wrapped in `lazyRetry`, and the whole switch sits in a
  `ChunkBoundary`: a view that is no longer in the first load is a request that can
  fail, and this product runs where those fail — behind proxies, air-gapped, and
  across an upgrade that renames every chunk under an open tab.
*/
const PivotTable = React.lazy(
  lazyRetry(() => import("@/components/PivotTable").then((m) => ({ default: m.PivotTable }))),
);
const DatabaseDocs = React.lazy(
  lazyRetry(() => import("@/components/DatabaseDocs").then((m) => ({ default: m.DatabaseDocs }))),
);
const VisualExplain = React.lazy(
  lazyRetry(() => import("@/components/VisualExplain").then((m) => ({ default: m.VisualExplain }))),
);
const DataCharts = React.lazy(
  lazyRetry(() => import("@/components/DataCharts").then((m) => ({ default: m.DataCharts }))),
);
const SchemaDiff = React.lazy(
  lazyRetry(() => import("@/components/SchemaDiff").then((m) => ({ default: m.SchemaDiff }))),
);

// The saved-chart dashboard. Its data is read on mount, not its module — the module
// is split at the import above, along with the `DataCharts` this renders.
function ChartDashboard({ result }: { result: QueryResult | null }) {
  const [savedCharts, setSavedCharts] = React.useState<
    { id: string; name: string; chartType: string; xAxis: string; yAxis: string[] }[]
  >([]);
  React.useEffect(() => {
    const charts = storage.getSavedCharts();
    if (charts.length > 0) setSavedCharts(charts);
  }, []);

  if (savedCharts.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-sunken text-fg-muted gap-2">
        <LayoutDashboard strokeWidth={1.5} className="w-10 h-10 opacity-30" />
        <p className="text-xs">No saved charts yet</p>
        <p className="text-xs text-fg-subtle">Save charts from the Charts tab to display them here</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-sunken p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {savedCharts.map((chart) => (
          <div key={chart.id} className="bg-raised border border-hairline-strong rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-fg-secondary">{chart.name}</span>
              <span className="text-xs text-fg-subtle">{chart.chartType}</span>
            </div>
            <div className="text-xs text-fg-muted">
              {chart.xAxis && <span>X: {chart.xAxis}</span>}
              {chart.yAxis?.length > 0 && <span className="ml-2">Y: {chart.yAxis.join(", ")}</span>}
            </div>
            {result ? (
              <div className="mt-2 h-[160px]">
                <DataCharts result={result} />
              </div>
            ) : (
              <div className="mt-2 h-[100px] flex items-center justify-center text-fg-subtle text-xs">
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
  // The writer's own type, so a format added there cannot silently fail to reach this
  // menu — the drift between two spellings of one list is what this PR is about.
  onExportResults: (format: ResultExportFormat) => void;
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
    An agent artifact is shown in ONE surface — the one the RUN's own record names,
    which is its operation for a read or a plan and its composed answer for a chart —
    and the tab's own state is never overwritten to do it. So the grid, the explain
    view and the charts view each ask whether this artifact is theirs, every other
    view keeps showing the tab's own result, and dismissing the artifact restores the
    tab with nothing to undo.

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
  /*
    The run's own rows, drawn as the run said to draw them. `DataCharts` validates the
    specification against the result it was actually given and falls back to its own
    inference if it cannot be drawn, so a chart here is never a confident picture of
    columns these rows do not have.
  */
  const hydratedChart = agentArtifact?.surface === "charts" ? agentArtifact.result : null;
  /** Null unless the run's own rows are what the charts view is showing. */
  const hydratedChartSpec = hydratedChart === null ? null : (agentArtifact?.chartSpec ?? null);
  const hydratedHere =
    agentArtifact !== null &&
    ((mode === "results" && hydratedResult !== null) ||
      (mode === "explain" && hydratedPlan !== null) ||
      (mode === "charts" && hydratedChart !== null));
  const displayedResult = hydratedResult ?? currentTab.result;
  // How much of the result an export would write — the count the button carries and
  // the shortfall the menu states. Derived here so both read the same numbers.
  const exportScope = describeExportScope(displayedResult ?? { rows: [] });

  const tabs: { key: BottomPanelMode; label: string; icon: React.ReactNode; activeClass: string }[] = [
    {
      key: "results",
      label: "Results",
      icon: <LayoutGrid strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-blue-400 border-blue-500 bg-fill",
    },
    {
      key: "explain",
      label: "Explain",
      icon: <Zap strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-amber-400 border-amber-500 bg-fill",
    },
    {
      key: "history",
      label: "History",
      icon: <Clock strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-emerald-400 border-emerald-500 bg-fill",
    },
    {
      key: "saved",
      label: "Saved",
      icon: <Bookmark strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-purple-400 border-purple-500 bg-fill",
    },
    {
      key: "charts",
      label: "Charts",
      icon: <BarChart3 strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-cyan-400 border-cyan-500 bg-fill",
    },
    {
      key: "pivot",
      label: "Pivot",
      icon: <Columns3 strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-orange-400 border-orange-500 bg-fill",
    },
    {
      key: "docs",
      label: "Docs",
      icon: <FileText strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-teal-400 border-teal-500 bg-fill",
    },
    {
      key: "schemadiff",
      label: "Diff",
      icon: <GitCompare strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-rose-400 border-rose-500 bg-fill",
    },
    {
      key: "dashboard",
      label: "Dashboard",
      icon: <LayoutDashboard strokeWidth={1.5} className="w-3 h-3" />,
      activeClass: "text-indigo-400 border-indigo-500 bg-fill",
    },
  ];

  const visibleTabs = metadata?.capabilities.explainFormat ? tabs : tabs.filter((tab) => tab.key !== "explain");

  return (
    /*
      A container, not the viewport: everything in this header is sized against the
      PANEL's width, and the panel loses width to things the viewport knows nothing
      about — the agent rail opening, the sidebar staying open, a narrowed window.
    */
    <div className="h-full flex flex-col bg-sunken @container/panel">
      <div className="h-9 bg-surface border-b border-hairline flex items-center justify-between gap-2 px-2">
        {/*
          The tab strip is the part that yields. It scrolls (without a visible bar in
          a 36px-tall row) rather than pushing the export group out of the header:
          nine mode tabs plus a rail plus a sidebar is enough to clip the right-hand
          side entirely, and what got clipped was the only way to save a result.
        */}
        <div className="flex items-center h-full gap-1 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {visibleTabs.map((tab) => (
            <button
              key={tab.key}
              data-testid={tab.key === "explain" ? "bottom-panel-tab-explain" : undefined}
              onClick={() => onSetMode(tab.key)}
              className={cn(
                "h-full px-3 text-xs font-medium transition-all border-b-2 flex items-center gap-2",
                mode === tab.key ? tab.activeClass : "text-fg-muted border-transparent hover:text-fg-secondary",
              )}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {displayedResult && mode === "results" && (
          // Never shrinks: Export is the only way a result leaves the product, so it
          // is the last thing that may be given up for width.
          <div className="flex items-center gap-1 shrink-0">
            {/*
              Dropped first when the panel is narrow, because it is the only thing here
              that is said twice — the stats bar directly below carries the row count,
              and EXEC TIME carries the duration.
            */}
            <span className="hidden @4xl/panel:inline text-xs font-mono text-fg-muted mr-2">
              {displayedResult.rowCount} rows • {displayedResult.executionTime}ms
            </span>
            {!hydratedHere && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-2"
                  >
                    {/*
                      The count belongs ON the button because it is what the button
                      does: an export writes the rows the grid HOLDS, which is one
                      page, and a file of 500 rows off a table of two million looks
                      exactly like a complete answer once it has left the product.
                    */}
                    <Download strokeWidth={1.5} className="w-3 h-3" /> Export
                    <span data-testid="export-row-count" className="font-mono text-fg-subtle">
                      {exportScope.countLabel}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-raised border-hairline-strong text-fg-secondary">
                  <div data-testid="export-scope" className="px-2 py-1.5 text-xs text-fg-muted max-w-[15rem]">
                    {exportScope.summary}
                    {exportScope.shortfall !== null && (
                      <span className="block mt-1 text-amber-400/80">{exportScope.shortfall}</span>
                    )}
                  </div>
                  <DropdownMenuSeparator className="bg-hairline" />
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
            <span className="font-mono text-[0.625rem] text-fg-muted">{agentArtifact.correlationId}</span> — read-only
          </span>
          <button
            type="button"
            data-testid="agent-provenance-dismiss"
            onClick={onDismissAgentArtifact}
            className="p-1 rounded text-fg-tertiary hover:bg-fill hover:text-fg transition-colors"
            aria-label="Dismiss the agent result"
          >
            <X strokeWidth={1.5} className="w-3 h-3" />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-hidden relative">
        {/* One pair of boundaries for the whole switch: only one view is ever mounted,
            so the fallback is what the user sees while a split chunk is in flight and
            the error boundary is what they see when it never arrives. */}
        <ChunkBoundary label="This view">
          <React.Suspense fallback={<ViewLoading label="Loading the panel" />}>
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
              <DataCharts result={hydratedChart ?? currentTab.result} spec={hydratedChartSpec} />
            ) : mode === "schemadiff" ? (
              <SchemaDiff schema={schema} connection={activeConnection} />
            ) : mode === "dashboard" ? (
              <ChartDashboard result={currentTab.result} />
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
              <div className="h-full flex flex-col items-center justify-center opacity-20 bg-surface">
                <Terminal strokeWidth={1.5} className="w-12 h-12 mb-4" />
                <p className="text-xs font-medium">Execute a query or check history</p>
                <p className="text-xs mt-2">Ready to query</p>
              </div>
            )}
          </React.Suspense>
        </ChunkBoundary>
      </div>
    </div>
  );
}
