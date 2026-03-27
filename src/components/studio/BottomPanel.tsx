'use client';

import React from 'react';
import type { DatabaseConnection, QueryTab, TableSchema, QueryResult } from '@/lib/types';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';
import type { MaskingConfig } from '@/lib/data-masking';
import type { CellChange } from '@/components/ResultsGrid';
import { ResultsGrid } from '@/components/ResultsGrid';
import { NL2SQLPanel } from '@/components/NL2SQLPanel';
import { AIAutopilotPanel } from '@/components/AIAutopilotPanel';
import { PivotTable } from '@/components/PivotTable';
import { DatabaseDocs } from '@/components/DatabaseDocs';
import { VisualExplain, type ExplainPlanResult } from '@/components/VisualExplain';
import { QueryHistory } from '@/components/QueryHistory';
import { SavedQueries } from '@/components/SavedQueries';
import { DataCharts } from '@/components/DataCharts';
import { SchemaDiff } from '@/components/SchemaDiff';
import { cn } from '@/lib/utils';
import {
  BarChart3, Bookmark, Clock, Columns3, Download,
  FileText, GitCompare, LayoutDashboard, LayoutGrid,
  Sparkles, Terminal, Zap,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { storage } from '@/lib/storage';

export type BottomPanelMode = 'results' | 'explain' | 'history' | 'saved' | 'charts' | 'nl2sql' | 'autopilot' | 'pivot' | 'docs' | 'schemadiff' | 'dashboard';

// Lazy-loaded chart dashboard
function ChartDashboardLazy({ result }: { result: QueryResult | null }) {
  const [savedCharts, setSavedCharts] = React.useState<{ id: string; name: string; chartType: string; xAxis: string; yAxis: string[] }[]>([]);
  React.useEffect(() => {
    const charts = storage.getSavedCharts();
    if (charts.length > 0) setSavedCharts(charts);
  }, []);

  if (savedCharts.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[#080808] text-zinc-500 gap-2">
        <LayoutDashboard className="w-10 h-10 opacity-30" />
        <p className="text-xs">No saved charts yet</p>
        <p className="text-xs text-zinc-600">Save charts from the Charts tab to display them here</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-[#080808] p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {savedCharts.map(chart => (
          <div key={chart.id} className="bg-[#0d0d0d] border border-white/10 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-300">{chart.name}</span>
              <span className="text-xs text-zinc-600">{chart.chartType}</span>
            </div>
            <div className="text-xs text-zinc-500">
              {chart.xAxis && <span>X: {chart.xAxis}</span>}
              {chart.yAxis?.length > 0 && <span className="ml-2">Y: {chart.yAxis.join(', ')}</span>}
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
  isNL2SQLOpen: boolean;
  onSetIsNL2SQLOpen: (open: boolean) => void;
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
  onExecuteQuery: (query: string) => void;
  onLoadQuery: (query: string) => void;
  onLoadMore: (() => void) | undefined;
  isLoadingMore: boolean | undefined;
  onExportResults: (format: 'csv' | 'json' | 'sql-insert' | 'sql-ddl') => void;
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
  isNL2SQLOpen,
  onSetIsNL2SQLOpen,
  maskingEnabled,
  onToggleMasking,
  userRole,
  maskingConfig,
  editingEnabled,
  pendingChanges,
  onCellChange,
  onApplyChanges,
  onDiscardChanges,
  onExecuteQuery,
  onLoadQuery,
  onLoadMore,
  isLoadingMore,
  onExportResults,
}: BottomPanelProps) {
  const tabs: { key: BottomPanelMode; label: string; icon: React.ReactNode; activeClass: string }[] = [
    { key: 'results', label: 'Results', icon: <LayoutGrid className="w-3 h-3" />, activeClass: 'text-blue-400 border-blue-500 bg-white/5' },
    { key: 'explain', label: 'Explain', icon: <Zap className="w-3 h-3" />, activeClass: 'text-amber-400 border-amber-500 bg-white/5' },
    { key: 'history', label: 'History', icon: <Clock className="w-3 h-3" />, activeClass: 'text-emerald-400 border-emerald-500 bg-white/5' },
    { key: 'saved', label: 'Saved', icon: <Bookmark className="w-3 h-3" />, activeClass: 'text-purple-400 border-purple-500 bg-white/5' },
    { key: 'charts', label: 'Charts', icon: <BarChart3 className="w-3 h-3" />, activeClass: 'text-cyan-400 border-cyan-500 bg-white/5' },
    { key: 'nl2sql', label: 'NL2SQL', icon: <Sparkles className="w-3 h-3" />, activeClass: 'text-violet-400 border-violet-500 bg-white/5' },
    { key: 'autopilot', label: 'Autopilot', icon: <Zap className="w-3 h-3" />, activeClass: 'text-cyan-400 border-cyan-500 bg-white/5' },
    { key: 'pivot', label: 'Pivot', icon: <Columns3 className="w-3 h-3" />, activeClass: 'text-orange-400 border-orange-500 bg-white/5' },
    { key: 'docs', label: 'Docs', icon: <FileText className="w-3 h-3" />, activeClass: 'text-teal-400 border-teal-500 bg-white/5' },
    { key: 'schemadiff', label: 'Diff', icon: <GitCompare className="w-3 h-3" />, activeClass: 'text-rose-400 border-rose-500 bg-white/5' },
    { key: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-3 h-3" />, activeClass: 'text-indigo-400 border-indigo-500 bg-white/5' },
  ];

  return (
    <div className="h-full flex flex-col bg-[#080808]">
      <div className="h-9 bg-[#0a0a0a] border-b border-white/5 flex items-center justify-between px-2">
        <div className="flex items-center h-full gap-1">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => {
                onSetMode(tab.key);
                if (tab.key === 'nl2sql') onSetIsNL2SQLOpen(true);
              }}
              className={cn(
                "h-full px-3 text-xs font-medium transition-all border-b-2 flex items-center gap-2",
                mode === tab.key
                  ? tab.activeClass
                  : "text-zinc-500 border-transparent hover:text-zinc-300"
              )}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {currentTab.result && mode === 'results' && (
          <div className="flex items-center gap-1">
            <span className="text-xs font-mono text-zinc-500 mr-2">
              {currentTab.result.rowCount} rows • {currentTab.result.executionTime}ms
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 text-xs font-medium text-zinc-500 hover:text-white gap-2">
                  <Download className="w-3 h-3" /> Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-[#0d0d0d] border-white/10 text-zinc-300">
                <DropdownMenuItem onClick={() => onExportResults('csv')} className="text-xs cursor-pointer">
                  Export as CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExportResults('json')} className="text-xs cursor-pointer">
                  Export as JSON
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExportResults('sql-insert')} className="text-xs cursor-pointer">
                  Export as SQL INSERT
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExportResults('sql-ddl')} className="text-xs cursor-pointer">
                  Export as DDL (CREATE TABLE)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden relative">
        {mode === 'nl2sql' ? (
          <NL2SQLPanel
            isOpen={isNL2SQLOpen}
            onClose={() => { onSetIsNL2SQLOpen(false); onSetMode('results'); }}
            onExecuteQuery={onExecuteQuery}
            onLoadQuery={(q) => { onLoadQuery(q); onSetMode('results'); }}
            schemaContext={schemaContext}
            databaseType={activeConnection?.type}
            queryLanguage={metadata?.capabilities.queryLanguage}
          />
        ) : mode === 'autopilot' ? (
          <AIAutopilotPanel
            connection={activeConnection}
            schemaContext={schemaContext}
            onExecuteQuery={onExecuteQuery}
          />
        ) : mode === 'pivot' ? (
          <PivotTable
            result={currentTab.result}
            onLoadQuery={(q) => { onLoadQuery(q); onSetMode('results'); }}
          />
        ) : mode === 'docs' ? (
          <DatabaseDocs
            schema={schema}
            schemaContext={schemaContext}
            databaseType={activeConnection?.type}
          />
        ) : mode === 'history' ? (
          <QueryHistory
            refreshTrigger={historyKey}
            activeConnectionId={activeConnection?.id}
            onSelectQuery={(q) => { onLoadQuery(q); onSetMode('results'); }}
          />
        ) : mode === 'saved' ? (
          <SavedQueries
            refreshTrigger={savedKey}
            connectionType={activeConnection?.type}
            onSelectQuery={(q) => { onLoadQuery(q); onSetMode('results'); }}
          />
        ) : mode === 'charts' ? (
          <DataCharts result={currentTab.result} />
        ) : mode === 'schemadiff' ? (
          <SchemaDiff schema={schema} connection={activeConnection} />
        ) : mode === 'dashboard' ? (
          <ChartDashboardLazy result={currentTab.result} />
        ) : currentTab.result ? (
          mode === 'explain' ? (
            <VisualExplain
              plan={currentTab.explainPlan as ExplainPlanResult[] | null | undefined}
              query={currentTab.query}
              schemaContext={schemaContext}
              databaseType={activeConnection?.type}
              onLoadQuery={(q) => { onLoadQuery(q); onSetMode('results'); }}
            />
          ) : (
            <ResultsGrid
              result={currentTab.result}
              onLoadMore={onLoadMore}
              isLoadingMore={isLoadingMore}
              maskingEnabled={maskingEnabled}
              onToggleMasking={onToggleMasking}
              userRole={userRole}
              maskingConfig={maskingConfig}
              editingEnabled={editingEnabled}
              pendingChanges={pendingChanges}
              onCellChange={onCellChange}
              onApplyChanges={onApplyChanges}
              onDiscardChanges={onDiscardChanges}
            />
          )
        ) : (
          <div className="h-full flex flex-col items-center justify-center opacity-20 bg-[#0a0a0a]">
            <Terminal className="w-12 h-12 mb-4" />
            <p className="text-xs font-medium">Execute a query or check history</p>
            <p className="text-xs mt-2">Ready to query</p>
          </div>
        )}
      </div>
    </div>
  );
}
