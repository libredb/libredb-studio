"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Sidebar } from "@/components/sidebar";
// MobileNav and mobile tab panels excluded in embedded mode — platform provides its own navigation
import { QueryEditor, QueryEditorRef } from "@/components/QueryEditor";
import { DataImportModal } from "@/components/DataImportModal";
import { QuerySafetyDialog } from "@/components/QuerySafetyDialog";
import { DataProfiler } from "@/components/DataProfiler";
import { CodeGenerator } from "@/components/CodeGenerator";
import { TestDataGenerator } from "@/components/TestDataGenerator";
import { SaveQueryModal } from "@/components/SaveQueryModal";
import { StudioTabBar, QueryToolbar, BottomPanel } from "@/components/studio/index";
import type { MaskingConfig } from "@/lib/data-masking";
import { useToast } from "@/hooks/use-toast";
import { useTabManager } from "@/hooks/use-tab-manager";
import { useConnectionAdapter } from "@/workspace/hooks/use-connection-adapter";
import { useQueryAdapter } from "@/workspace/hooks/use-query-adapter";
import { type StudioWorkspaceProps, DEFAULT_WORKSPACE_FEATURES } from "@/workspace/types";
import { cn } from "@/lib/utils";
import { ChunkBoundary, ViewLoading } from "@/components/LazyView";
import { lazyRetry } from "@/lib/lazy";
import { editorLanguageForTabType } from "@/lib/editor/tab-language";
import { buildResultExport, type ResultExportFormat } from "@/lib/export/result-export";
import { downloadText } from "@/lib/export/download";

// The ERD is the largest thing this shell can mount (`@xyflow/react` + the elk layout
// engine + the snapdom capture), and it is mounted only while `showDiagram` is true.
// Split for the same reason the bottom panel's heavy views are, and through the same
// `React.lazy` seam — this shell imports nothing from `next` by construction.
const SchemaDiagram = React.lazy(
  lazyRetry(() => import("@/components/SchemaDiagram").then((m) => ({ default: m.SchemaDiagram }))),
);

/**
 * Scoped CSS for the shadcn token set studio's primitives read.
 *
 * A host app may express these in a different format (OKLCH rather than hex), so
 * studio restates them for its own subtree, scoped by `data-studio-workspace` to
 * get the specificity without touching the host.
 *
 * BOTH palettes, keyed off the same `dark` class everything else here follows.
 * Light is the base and dark overrides it, so a host that has not opted into dark
 * gets a light studio — matching what `useEffectiveTheme()` reports and what the
 * `--studio-*` tokens resolve to. Pinning this block to dark, as it used to be,
 * produced the one thing worse than either theme: dark chrome around a light
 * editor, light charts and a light diagram.
 */
const STUDIO_SCOPED_CSS = `
[data-studio-workspace] {
  /* Light theme — monochrome (white/black/gray) */
  --background: #ffffff;
  --foreground: #09090b;
  --card: #ffffff;
  --card-foreground: #09090b;
  --popover: #ffffff;
  --popover-foreground: #09090b;
  --primary: #18181b;
  --primary-foreground: #fafafa;
  --secondary: #f4f4f5;
  --secondary-foreground: #18181b;
  --muted: #f4f4f5;
  --muted-foreground: #52525b;
  --accent: #f4f4f5;
  --accent-foreground: #18181b;
  --destructive: #dc2626;
  --destructive-foreground: #fafafa;
  --border: #e4e4e7;
  --input: #e4e4e7;
  --ring: #71717a;
  --radius: 0.5rem;
  --chart-1: #18181b;
  --chart-2: #3f3f46;
  --chart-3: #52525b;
  --chart-4: #71717a;
  --chart-5: #a1a1aa;

  /* Font — Geist (inherited from host or fallback to system) */
  font-family: var(--font-geist-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-feature-settings: "rlig" 1, "calt" 1;
  letter-spacing: -0.011em;
}
/* Dark — the values this block carried before it learned a second palette.
   Higher specificity than the base rule, so the class alone decides. */
.dark [data-studio-workspace],
[data-studio-workspace].dark {
  --background: #09090b;
  --foreground: #fafafa;
  --card: #09090b;
  --card-foreground: #fafafa;
  --popover: #09090b;
  --popover-foreground: #fafafa;
  --primary: #fafafa;
  --primary-foreground: #09090b;
  --secondary: #27272a;
  --secondary-foreground: #fafafa;
  --muted: #27272a;
  --muted-foreground: #a1a1aa;
  --accent: #27272a;
  --accent-foreground: #fafafa;
  --destructive: #dc2626;
  --destructive-foreground: #fafafa;
  --border: #27272a;
  --input: #27272a;
  --ring: #d4d4d8;
  --chart-1: #e4e4e7;
  --chart-2: #a1a1aa;
  --chart-3: #71717a;
  --chart-4: #52525b;
  --chart-5: #3f3f46;
}
[data-studio-workspace] *,
[data-studio-workspace] *::before,
[data-studio-workspace] *::after {
  font-family: inherit;
}
[data-studio-workspace] code,
[data-studio-workspace] pre,
[data-studio-workspace] kbd,
[data-studio-workspace] .font-mono {
  font-family: var(--font-geist-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace);
}
`;

function useStudioTheme() {
  useEffect(() => {
    const id = "studio-workspace-theme";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = STUDIO_SCOPED_CSS;
    document.head.appendChild(style);
    return () => {
      document.getElementById(id)?.remove();
    };
  }, []);
}
import { TriangleAlert } from "lucide-react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { AnimatePresence } from "framer-motion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// No-op masking config for embedded mode (masking disabled)
const NOOP_MASKING_CONFIG: MaskingConfig = {
  enabled: false,
  patterns: [],
  roleSettings: {
    admin: { canToggle: false, canReveal: false },
    user: { canToggle: false, canReveal: false },
  },
};

export function StudioWorkspace({
  connections: externalConnections,
  currentUser,
  onQueryExecute,
  onSchemaFetch,
  onSaveQuery: onSaveQueryProp,
  // onLoadSavedQueries — reserved for future saved-queries panel integration
  features: featuresProp,
  className,
}: StudioWorkspaceProps) {
  const queryEditorRef = useRef<QueryEditorRef>(null);
  const { toast } = useToast();

  // Merge feature flags with defaults
  const features = useMemo(() => ({ ...DEFAULT_WORKSPACE_FEATURES, ...featuresProp }), [featuresProp]);

  // 1. Connection Adapter (platform-managed connections)
  const conn = useConnectionAdapter({
    connections: externalConnections,
    onSchemaFetch,
  });

  // 2. Tab Manager (pure UI state, reused as-is)
  const tabMgr = useTabManager({
    activeConnection: conn.activeConnection,
    metadata: conn.metadata,
    schema: conn.schema,
  });

  // 3. Query Adapter (platform-delegated execution)
  const queryExec = useQueryAdapter({
    activeConnection: conn.activeConnection,
    onQueryExecute,
    tabs: tabMgr.tabs,
    activeTabId: tabMgr.activeTabId,
    currentTab: tabMgr.currentTab,
    setTabs: tabMgr.setTabs,
    fetchSchema: conn.fetchSchema,
    features,
  });

  // === Inject scoped dark theme CSS ===
  useStudioTheme();

  // === Connection change effect ===
  useEffect(() => {
    if (conn.activeConnection) {
      conn.fetchSchema(conn.activeConnection);
    } else {
      conn.setSchema([]);
    }
    // Keyed on the ID, not the object: `activeConnection` is derived from the
    // host's `connections` prop, so a host that passes a fresh array on every
    // render would otherwise re-fetch the schema on every render. The ID is the
    // trigger this effect always meant — the active connection actually changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.activeConnection?.id]);

  // === Modal / overlay state ===
  const [showDiagram, setShowDiagram] = useState(false);
  const [isSaveQueryModalOpen, setIsSaveQueryModalOpen] = useState(false);
  const [savedKey, setSavedKey] = useState(0);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [profilerTable, setProfilerTable] = useState<string | null>(null);
  const [codeGenTable, setCodeGenTable] = useState<string | null>(null);
  const [testDataTable, setTestDataTable] = useState<string | null>(null);

  // === Save query handler ===
  const handleSaveQuery = useCallback(
    async (name: string, description: string, tags: string[]) => {
      if (!conn.activeConnection) return;

      if (onSaveQueryProp) {
        try {
          await onSaveQueryProp({
            name,
            query: tabMgr.currentTab.query,
            description,
            connectionType: conn.activeConnection.type,
            tags,
          });
          setSavedKey((prev) => prev + 1);
          toast({ title: "Query Saved", description: `"${name}" has been added to your saved queries.` });
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Failed to save query";
          toast({ title: "Save Failed", description: msg, variant: "destructive" });
        }
      }
    },
    [conn.activeConnection, tabMgr.currentTab.query, onSaveQueryProp, toast],
  );

  // === Export results (shared writers; this shell applies no masking) ===
  const exportResults = useCallback(
    (format: ResultExportFormat) => {
      if (!tabMgr.currentTab.result) return;
      const file = buildResultExport(format, {
        rows: tabMgr.currentTab.result.rows,
        fields: tabMgr.currentTab.result.fields,
        tabName: tabMgr.currentTab.name,
        // Was missing from this callback's dependencies, so a SQL export written
        // after the host switched connections quoted its literals for whichever
        // engine happened to be active on the first render.
        dialect: conn.activeConnection?.type,
        // The host's own declared column types (`use-query-adapter` carries them),
        // which the DDL form prefers over a type guessed from a value.
        columnTypes: tabMgr.currentTab.result.columnTypes,
      });
      downloadText(file.content, file.mimeType, `query_result_export.${file.extension}`);
    },
    [tabMgr.currentTab, conn.activeConnection?.type],
  );

  // === Table click handler ===
  const onTableClick = useCallback(
    (tableName: string) => {
      tabMgr.handleTableClick(tableName, queryExec.executeQuery);
    },
    [tabMgr, queryExec.executeQuery],
  );

  // === No-op callbacks for disabled features ===
  const noop = useCallback(() => {}, []);

  return (
    <div
      data-studio-workspace=""
      // No `dark` class here. The host owns the theme — its <html> carries the
      // class, `useEffectiveTheme()` reads it, and the tokens resolve from it.
      // Pinning it here made the chrome dark while everything that consults the
      // host went light, in a light host only.
      className={cn("flex h-full w-full bg-canvas text-fg overflow-hidden font-sans select-none", className)}
    >
      <ResizablePanelGroup id="workspace-main" orientation="horizontal" className="h-full">
        {/* Sizes are strings on purpose: react-resizable-panels 4 reads a bare
            number as pixels and a unitless string as a percentage. */}
        <ResizablePanel id="workspace-sidebar" defaultSize="22" minSize="15" maxSize="35" className="hidden md:block">
          <Sidebar
            connections={conn.connections}
            activeConnection={conn.activeConnection}
            schema={conn.schema}
            isLoadingSchema={conn.isLoadingSchema}
            onSelectConnection={conn.setActiveConnection}
            onDeleteConnection={noop}
            onEditConnection={noop}
            onAddConnection={noop}
            onTableClick={onTableClick}
            onGenerateSelect={tabMgr.handleGenerateSelect}
            onCreateTableClick={undefined}
            onShowDiagram={features.schemaDiagram ? () => setShowDiagram(true) : undefined}
            isAdmin={false}
            onOpenMaintenance={noop}
            databaseType={conn.activeConnection?.type}
            metadata={conn.metadata}
            onProfileTable={features.codeGenerator ? (name: string) => setProfilerTable(name) : undefined}
            onGenerateCode={features.codeGenerator ? (name: string) => setCodeGenTable(name) : undefined}
            onGenerateTestData={features.testDataGenerator ? (name: string) => setTestDataTable(name) : undefined}
          />
        </ResizablePanel>
        <ResizableHandle className="hidden md:flex w-1 bg-transparent hover:bg-blue-500/30 transition-colors" />
        <ResizablePanel id="workspace-body" defaultSize="78">
          <div className="flex-1 flex flex-col min-w-0 h-full bg-surface">
            {/* No desktop/mobile headers — platform provides its own */}

            <StudioTabBar
              tabs={tabMgr.tabs}
              activeTabId={tabMgr.activeTabId}
              editingTabId={tabMgr.editingTabId}
              editingTabName={tabMgr.editingTabName}
              onSetActiveTabId={tabMgr.setActiveTabId}
              onSetEditingTabId={tabMgr.setEditingTabId}
              onSetEditingTabName={tabMgr.setEditingTabName}
              onSetTabs={tabMgr.setTabs}
              onCloseTab={tabMgr.closeTab}
              onAddTab={tabMgr.addTab}
            />

            <main className="flex-1 overflow-hidden relative">
              {/* Schema Diagram overlay */}
              {features.schemaDiagram && (
                <AnimatePresence>
                  {showDiagram && (
                    // A visible fallback and a boundary, for the reason spelled out at
                    // the same mount in `src/components/Studio.tsx`: this is the
                    // heaviest chunk, and it is fetched from whatever base the
                    // embedding host serves the package's assets from.
                    <ChunkBoundary label="The diagram">
                      <React.Suspense
                        fallback={<ViewLoading label="Loading the diagram" className="absolute inset-0 z-20" />}
                      >
                        <SchemaDiagram schema={conn.schema} onClose={() => setShowDiagram(false)} />
                      </React.Suspense>
                    </ChunkBoundary>
                  )}
                </AnimatePresence>
              )}

              {/* Editor area — no mobile database/schema tab panels in embedded mode (no MobileNav to switch to them) */}
              <div className="h-full">
                <div className="h-full">
                  <ResizablePanelGroup id="workspace-editor" orientation="vertical">
                    <ResizablePanel id="workspace-editor-top" defaultSize="40" minSize="20">
                      <div className="h-full flex flex-col">
                        <QueryToolbar
                          activeConnection={conn.activeConnection}
                          metadata={conn.metadata}
                          isExecuting={tabMgr.currentTab.isExecuting}
                          playgroundMode={false}
                          transactionActive={false}
                          editingEnabled={false}
                          // Withheld, not `noop`: a host that wired no save has
                          // nowhere to save to, and `noop` put a dead Save button
                          // on every embedded surface (U7).
                          onSaveQuery={onSaveQueryProp ? () => setIsSaveQueryModalOpen(true) : undefined}
                          onExecuteQuery={() => queryExec.executeQuery()}
                          onCancelQuery={queryExec.cancelQuery}
                          // Withheld, not `noop`: this shell runs no transaction,
                          // no sandbox and no inline editing — `transactionActive`
                          // and `editingEnabled` are hardcoded false above and
                          // nothing here can change them. While it passed
                          // `metadata={null}` the group never rendered and `noop`
                          // was invisible; passing the host's real metadata (#427)
                          // would have put three dead buttons on any host that
                          // declares `queryLanguage: "sql"`, with no disabled state
                          // and no tooltip. A withheld callback hides its control.
                          onBeginTransaction={undefined}
                          onCommitTransaction={undefined}
                          onRollbackTransaction={undefined}
                          onTogglePlayground={undefined}
                          onToggleEditing={undefined}
                          onImport={features.dataImport ? () => setIsImportModalOpen(true) : undefined}
                        />

                        <div className="flex-1 relative min-h-0">
                          <QueryEditor
                            ref={queryEditorRef}
                            value={tabMgr.currentTab.query}
                            onContentChange={(val) => tabMgr.updateTabById(tabMgr.currentTab.id, { query: val })}
                            language={editorLanguageForTabType(tabMgr.currentTab.type)}
                            databaseType={conn.activeConnection?.type}
                            schemaContext={conn.schemaContext}
                            capabilities={conn.metadata?.capabilities}
                          />
                        </div>
                      </div>
                    </ResizablePanel>
                    <ResizableHandle className="h-1 bg-fill hover:bg-blue-500/20" />
                    <ResizablePanel id="workspace-editor-bottom" defaultSize="60" minSize="20">
                      <BottomPanel
                        mode={queryExec.bottomPanelMode}
                        onSetMode={queryExec.setBottomPanelMode}
                        currentTab={tabMgr.currentTab}
                        schema={conn.schema}
                        schemaContext={conn.schemaContext}
                        activeConnection={conn.activeConnection}
                        metadata={conn.metadata}
                        historyKey={queryExec.historyKey}
                        savedKey={savedKey}
                        maskingEnabled={false}
                        onToggleMasking={undefined}
                        userRole={currentUser?.role}
                        maskingConfig={NOOP_MASKING_CONFIG}
                        editingEnabled={false}
                        pendingChanges={[]}
                        onCellChange={noop as never}
                        onApplyChanges={noop}
                        onDiscardChanges={noop}
                        onLoadQuery={(q) => tabMgr.updateCurrentTab({ query: q })}
                        onLoadMore={
                          tabMgr.currentTab.result?.pagination?.hasMore ? queryExec.handleLoadMore : undefined
                        }
                        isLoadingMore={tabMgr.currentTab.isLoadingMore}
                        onExportResults={exportResults}
                      />
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>
              </div>
            </main>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Modals — only render those that are feature-enabled */}

      {onSaveQueryProp && (
        <SaveQueryModal
          isOpen={isSaveQueryModalOpen}
          onClose={() => setIsSaveQueryModalOpen(false)}
          onSave={handleSaveQuery}
          defaultQuery={tabMgr.currentTab.query}
        />
      )}

      {features.dataImport && (
        <DataImportModal
          isOpen={isImportModalOpen}
          onClose={() => setIsImportModalOpen(false)}
          onImport={(sql) => queryExec.executeQuery(sql)}
          tables={conn.schema}
          databaseType={conn.activeConnection?.type}
        />
      )}

      {/* Safety dialog — stub AI analysis to prevent internal fetch */}
      <QuerySafetyDialog
        isOpen={!!queryExec.safetyCheckQuery}
        query={queryExec.safetyCheckQuery || ""}
        schemaContext={conn.schemaContext}
        databaseType={conn.activeConnection?.type}
        onClose={() => queryExec.setSafetyCheckQuery(null)}
        onProceed={() => {
          if (queryExec.safetyCheckQuery) queryExec.forceExecuteQuery(queryExec.safetyCheckQuery);
        }}
        onAnalyzeSafety={async () => ({
          riskLevel: "high" as const,
          summary: "Potentially dangerous query detected",
          warnings: [
            {
              type: "destructive",
              severity: "high",
              message: "This query may modify or delete data",
              detail: "Review carefully before proceeding.",
            },
          ],
          affectedRows: "unknown",
          cascadeEffects: "unknown",
          recommendation: "Review this query carefully before proceeding.",
        })}
      />

      {/* Data Profiler */}
      {features.codeGenerator && (
        <DataProfiler
          isOpen={!!profilerTable}
          onClose={() => setProfilerTable(null)}
          tableName={profilerTable || ""}
          tableSchema={conn.schema.find((t) => t.name === profilerTable) || null}
          connection={conn.activeConnection}
          schemaContext={conn.schemaContext}
          databaseType={conn.activeConnection?.type}
        />
      )}

      {/* Code Generator */}
      {features.codeGenerator && (
        <CodeGenerator
          isOpen={!!codeGenTable}
          onClose={() => setCodeGenTable(null)}
          tableName={codeGenTable || ""}
          tableSchema={conn.schema.find((t) => t.name === codeGenTable) || null}
          databaseType={conn.activeConnection?.type}
        />
      )}

      {/* Test Data Generator */}
      {features.testDataGenerator && (
        <TestDataGenerator
          isOpen={!!testDataTable}
          onClose={() => setTestDataTable(null)}
          tableName={testDataTable || ""}
          tableSchema={conn.schema.find((t) => t.name === testDataTable) || null}
          databaseType={conn.activeConnection?.type}
          queryLanguage={undefined}
          onExecuteQuery={(q) => queryExec.executeQuery(q)}
        />
      )}

      {/* Unlimited Query Warning */}
      <AlertDialog open={queryExec.unlimitedWarningOpen} onOpenChange={queryExec.setUnlimitedWarningOpen}>
        <AlertDialogContent className="bg-overlay border-hairline max-w-sm p-0 gap-0 overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-red-500/10 flex items-center justify-center shrink-0">
                <TriangleAlert strokeWidth={1.5} className="w-5 h-5 text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <AlertDialogTitle className="text-xs font-medium text-fg mb-1">Load all results?</AlertDialogTitle>
                <AlertDialogDescription className="text-xs text-fg-muted leading-relaxed">
                  This may slow down your browser. Max <span className="text-fg-tertiary">100K</span> rows will be
                  loaded.
                </AlertDialogDescription>
              </div>
            </div>
          </div>
          <div className="px-6 pb-6 flex gap-2">
            <AlertDialogCancel className="flex-1 h-9 bg-fill border-0 text-fg-tertiary text-xs font-medium hover:bg-fill-strong hover:text-fg">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={queryExec.handleUnlimitedQuery}
              className="flex-1 h-9 bg-amber-600 border-0 text-white text-xs font-medium hover:bg-amber-500"
            >
              Load All
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mobile Navigation — hidden in embedded mode, platform provides its own */}
    </div>
  );
}
