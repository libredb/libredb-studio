'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Sidebar, ConnectionsList } from '@/components/sidebar';
import { MobileNav } from '@/components/MobileNav';
import { SchemaExplorer } from '@/components/schema-explorer';
import { QueryEditor, QueryEditorRef } from '@/components/QueryEditor';
import { DataImportModal } from '@/components/DataImportModal';
import { QuerySafetyDialog } from '@/components/QuerySafetyDialog';
import { DataProfiler } from '@/components/DataProfiler';
import { CodeGenerator } from '@/components/CodeGenerator';
import { TestDataGenerator } from '@/components/TestDataGenerator';
import { SchemaDiagram } from '@/components/SchemaDiagram';
import { SaveQueryModal } from '@/components/SaveQueryModal';
import {
  StudioTabBar,
  QueryToolbar,
  BottomPanel,
} from '@/components/studio/index';
import type { DatabaseConnection } from '@/lib/types';
import type { MaskingConfig } from '@/lib/data-masking';
import { useToast } from '@/hooks/use-toast';
import { useTabManager } from '@/hooks/use-tab-manager';
import { useConnectionAdapter } from '@/workspace/hooks/use-connection-adapter';
import { useQueryAdapter } from '@/workspace/hooks/use-query-adapter';
import {
  type StudioWorkspaceProps,
  DEFAULT_WORKSPACE_FEATURES,
} from '@/workspace/types';
import { cn } from '@/lib/utils';
import { AlertTriangle, Database } from 'lucide-react';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { AnimatePresence } from 'framer-motion';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

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
  const features = useMemo(
    () => ({ ...DEFAULT_WORKSPACE_FEATURES, ...featuresProp }),
    [featuresProp],
  );

  // 1. Connection Adapter (platform-managed connections)
  const conn = useConnectionAdapter({
    connections: externalConnections,
    onSchemaFetch,
  });

  // 2. Tab Manager (pure UI state, reused as-is)
  const tabMgr = useTabManager({
    activeConnection: conn.activeConnection,
    metadata: null,
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

  // === Connection change effect ===
  useEffect(() => {
    if (conn.activeConnection) {
      conn.fetchSchema(conn.activeConnection);
    } else {
      conn.setSchema([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.activeConnection]);

  // === Modal / overlay state ===
  const [showDiagram, setShowDiagram] = useState(false);
  const [isSaveQueryModalOpen, setIsSaveQueryModalOpen] = useState(false);
  const [savedKey, setSavedKey] = useState(0);
  const [activeMobileTab, setActiveMobileTab] = useState<'database' | 'schema' | 'editor'>('editor');
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isNL2SQLOpen, setIsNL2SQLOpen] = useState(false);
  const [profilerTable, setProfilerTable] = useState<string | null>(null);
  const [codeGenTable, setCodeGenTable] = useState<string | null>(null);
  const [testDataTable, setTestDataTable] = useState<string | null>(null);

  // === Save query handler ===
  const handleSaveQuery = useCallback(async (name: string, description: string, tags: string[]) => {
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
        setSavedKey(prev => prev + 1);
        toast({ title: 'Query Saved', description: `"${name}" has been added to your saved queries.` });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to save query';
        toast({ title: 'Save Failed', description: msg, variant: 'destructive' });
      }
    }
  }, [conn.activeConnection, tabMgr.currentTab.query, onSaveQueryProp, toast]);

  // === Export results (simplified, no masking) ===
  const exportResults = useCallback((format: 'csv' | 'json' | 'sql-insert' | 'sql-ddl') => {
    if (!tabMgr.currentTab.result) return;
    const data = tabMgr.currentTab.result.rows;
    let content = '';
    let mimeType = 'text/plain';
    let ext: string = format;

    if (format === 'csv') {
      const headers = Object.keys(data[0] || {}).join(',');
      const rows = data.map(row => Object.values(row).map(val => `"${val}"`).join(',')).join('\n');
      content = `${headers}\n${rows}`;
      mimeType = 'text/csv';
      ext = 'csv';
    } else if (format === 'json') {
      content = JSON.stringify(data, null, 2);
      mimeType = 'application/json';
      ext = 'json';
    } else if (format === 'sql-insert') {
      const tableName = tabMgr.currentTab.name.replace(/^Query[: ]*/, '') || 'table_name';
      const columns = Object.keys(data[0] || {});
      const lines = data.map(row => {
        const values = columns.map(col => {
          const val = row[col];
          if (val === null || val === undefined) return 'NULL';
          if (typeof val === 'number' || typeof val === 'boolean') return String(val);
          return `'${String(val).replace(/'/g, "''")}'`;
        });
        return `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});`;
      });
      content = lines.join('\n');
      mimeType = 'text/sql';
      ext = 'sql';
    } else if (format === 'sql-ddl') {
      const tableName = tabMgr.currentTab.name.replace(/^Query[: ]*/, '') || 'table_name';
      const columns = Object.keys(data[0] || {});
      const colDefs = columns.map(col => {
        const sampleVal = data[0]?.[col];
        let sqlType = 'TEXT';
        if (typeof sampleVal === 'number') {
          sqlType = Number.isInteger(sampleVal) ? 'INTEGER' : 'NUMERIC';
        } else if (typeof sampleVal === 'boolean') {
          sqlType = 'BOOLEAN';
        } else if (sampleVal instanceof Date) {
          sqlType = 'TIMESTAMP';
        }
        return `  ${col} ${sqlType}`;
      });
      content = `CREATE TABLE ${tableName} (\n${colDefs.join(',\n')}\n);`;
      mimeType = 'text/sql';
      ext = 'sql';
    }

    const fileName = `query_result_export.${ext}`;
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }, [tabMgr.currentTab]);

  // === Table click handler ===
  const onTableClick = useCallback((tableName: string) => {
    tabMgr.handleTableClick(tableName, queryExec.executeQuery);
  }, [tabMgr, queryExec.executeQuery]);

  // === No-op callbacks for disabled features ===
  const noop = useCallback(() => {}, []);

  return (
    <div className={cn('flex h-full w-full bg-[#050505] text-zinc-100 overflow-hidden font-sans select-none', className)}>
      <ResizablePanelGroup id="workspace-main" direction="horizontal" className="h-full">
        <ResizablePanel defaultSize={22} minSize={15} maxSize={35} className="hidden md:block">
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
            metadata={null}
            onProfileTable={features.codeGenerator ? (name: string) => setProfilerTable(name) : undefined}
            onGenerateCode={features.codeGenerator ? (name: string) => setCodeGenTable(name) : undefined}
            onGenerateTestData={features.testDataGenerator ? (name: string) => setTestDataTable(name) : undefined}
          />
        </ResizablePanel>
        <ResizableHandle className="hidden md:flex w-1 bg-transparent hover:bg-blue-500/30 transition-colors" />
        <ResizablePanel defaultSize={78}>
          <div className="flex-1 flex flex-col min-w-0 h-full bg-[#0a0a0a] pb-16 md:pb-0">
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
                    <SchemaDiagram schema={conn.schema} onClose={() => setShowDiagram(false)} />
                  )}
                </AnimatePresence>
              )}

              {/* Mobile: Database Tab */}
              {activeMobileTab === 'database' && (
                <div className="md:hidden h-full bg-[#080808] overflow-auto p-4">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-widest">Connections</h2>
                  </div>
                  <ConnectionsList
                    connections={conn.connections}
                    activeConnection={conn.activeConnection}
                    onSelectConnection={(c: DatabaseConnection) => {
                      conn.setActiveConnection(c);
                      setActiveMobileTab('editor');
                    }}
                    onDeleteConnection={noop}
                    onAddConnection={noop}
                  />
                </div>
              )}

              {/* Mobile: Schema Tab */}
              {activeMobileTab === 'schema' && (
                <div className="md:hidden h-full bg-[#080808] overflow-auto p-4">
                  {conn.activeConnection ? (
                    <SchemaExplorer
                      schema={conn.schema}
                      isLoadingSchema={conn.isLoadingSchema}
                      onTableClick={(tableName: string) => {
                        onTableClick(tableName);
                        setActiveMobileTab('editor');
                      }}
                      onGenerateSelect={(tableName: string) => {
                        tabMgr.handleGenerateSelect(tableName);
                        setActiveMobileTab('editor');
                      }}
                      onCreateTableClick={undefined}
                      isAdmin={false}
                      onOpenMaintenance={noop}
                      databaseType={conn.activeConnection?.type}
                      metadata={null}
                      onProfileTable={features.codeGenerator ? (name: string) => setProfilerTable(name) : undefined}
                      onGenerateCode={features.codeGenerator ? (name: string) => setCodeGenTable(name) : undefined}
                      onGenerateTestData={features.testDataGenerator ? (name: string) => setTestDataTable(name) : undefined}
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-zinc-500">
                      <Database className="w-12 h-12 mb-4 opacity-30" />
                      <p className="text-sm">Select a connection first</p>
                    </div>
                  )}
                </div>
              )}

              {/* Desktop & Mobile Editor Tab */}
              <div className={cn(
                'h-full',
                activeMobileTab !== 'editor' && 'hidden md:block',
              )}>
                <div className="h-full">
                  <ResizablePanelGroup id="workspace-editor" direction="vertical">
                    <ResizablePanel defaultSize={40} minSize={20}>
                      <div className="h-full flex flex-col">
                        <QueryToolbar
                          activeConnection={conn.activeConnection}
                          metadata={null}
                          isExecuting={tabMgr.currentTab.isExecuting}
                          playgroundMode={false}
                          transactionActive={false}
                          editingEnabled={false}
                          onSaveQuery={onSaveQueryProp ? () => setIsSaveQueryModalOpen(true) : noop}
                          onExecuteQuery={() => queryExec.executeQuery()}
                          onCancelQuery={queryExec.cancelQuery}
                          onBeginTransaction={noop}
                          onCommitTransaction={noop}
                          onRollbackTransaction={noop}
                          onTogglePlayground={noop}
                          onToggleEditing={noop}
                          onImport={features.dataImport ? () => setIsImportModalOpen(true) : noop}
                        />

                        <div className="flex-1 relative">
                          <QueryEditor
                            ref={queryEditorRef}
                            value={tabMgr.currentTab.query}
                            onContentChange={(val) => tabMgr.updateTabById(tabMgr.currentTab.id, { query: val })}
                            language={tabMgr.currentTab.type === 'mongodb' ? 'json' : 'sql'}
                            tables={conn.tableNames}
                            databaseType={conn.activeConnection?.type}
                            schemaContext={conn.schemaContext}
                            capabilities={undefined}
                          />
                        </div>
                      </div>
                    </ResizablePanel>
                    <ResizableHandle className="h-1 bg-white/5 hover:bg-blue-500/20" />
                    <ResizablePanel defaultSize={60} minSize={20}>
                      <BottomPanel
                        mode={queryExec.bottomPanelMode}
                        onSetMode={queryExec.setBottomPanelMode}
                        currentTab={tabMgr.currentTab}
                        schema={conn.schema}
                        schemaContext={conn.schemaContext}
                        activeConnection={conn.activeConnection}
                        metadata={null}
                        historyKey={queryExec.historyKey}
                        savedKey={savedKey}
                        isNL2SQLOpen={features.ai ? isNL2SQLOpen : false}
                        onSetIsNL2SQLOpen={features.ai ? setIsNL2SQLOpen : noop}
                        maskingEnabled={false}
                        onToggleMasking={undefined}
                        userRole={currentUser?.role}
                        maskingConfig={NOOP_MASKING_CONFIG}
                        editingEnabled={false}
                        pendingChanges={[]}
                        onCellChange={noop as never}
                        onApplyChanges={noop}
                        onDiscardChanges={noop}
                        onExecuteQuery={(q) => queryExec.executeQuery(q)}
                        onLoadQuery={(q) => tabMgr.updateCurrentTab({ query: q })}
                        onLoadMore={
                          tabMgr.currentTab.result?.pagination?.hasMore
                            ? queryExec.handleLoadMore
                            : undefined
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
        query={queryExec.safetyCheckQuery || ''}
        schemaContext={conn.schemaContext}
        databaseType={conn.activeConnection?.type}
        onClose={() => queryExec.setSafetyCheckQuery(null)}
        onProceed={() => {
          if (queryExec.safetyCheckQuery) queryExec.forceExecuteQuery(queryExec.safetyCheckQuery);
        }}
        onAnalyzeSafety={async () => ({
          riskLevel: 'high' as const,
          summary: 'Potentially dangerous query detected',
          warnings: [{
            type: 'destructive',
            severity: 'high',
            message: 'This query may modify or delete data',
            detail: 'Review carefully before proceeding.',
          }],
          affectedRows: 'unknown',
          cascadeEffects: 'unknown',
          recommendation: 'Review this query carefully before proceeding.',
        })}
      />

      {/* Data Profiler */}
      {features.codeGenerator && (
        <DataProfiler
          isOpen={!!profilerTable}
          onClose={() => setProfilerTable(null)}
          tableName={profilerTable || ''}
          tableSchema={conn.schema.find(t => t.name === profilerTable) || null}
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
          tableName={codeGenTable || ''}
          tableSchema={conn.schema.find(t => t.name === codeGenTable) || null}
          databaseType={conn.activeConnection?.type}
        />
      )}

      {/* Test Data Generator */}
      {features.testDataGenerator && (
        <TestDataGenerator
          isOpen={!!testDataTable}
          onClose={() => setTestDataTable(null)}
          tableName={testDataTable || ''}
          tableSchema={conn.schema.find(t => t.name === testDataTable) || null}
          databaseType={conn.activeConnection?.type}
          queryLanguage={undefined}
          onExecuteQuery={(q) => queryExec.executeQuery(q)}
        />
      )}

      {/* Unlimited Query Warning */}
      <AlertDialog open={queryExec.unlimitedWarningOpen} onOpenChange={queryExec.setUnlimitedWarningOpen}>
        <AlertDialogContent className="bg-[#111] border-white/5 max-w-sm p-0 gap-0 overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-red-500/10 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <AlertDialogTitle className="text-[15px] font-semibold text-zinc-100 mb-1">
                  Load all results?
                </AlertDialogTitle>
                <AlertDialogDescription className="text-[13px] text-zinc-500 leading-relaxed">
                  This may slow down your browser. Max <span className="text-zinc-400">100K</span> rows will be loaded.
                </AlertDialogDescription>
              </div>
            </div>
          </div>
          <div className="px-6 pb-6 flex gap-2">
            <AlertDialogCancel className="flex-1 h-9 bg-white/5 border-0 text-zinc-400 text-[13px] font-medium hover:bg-white/10 hover:text-zinc-200">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={queryExec.handleUnlimitedQuery}
              className="flex-1 h-9 bg-amber-600 border-0 text-white text-[13px] font-medium hover:bg-amber-500"
            >
              Load All
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mobile Navigation */}
      <MobileNav
        activeTab={activeMobileTab}
        onTabChange={setActiveMobileTab}
        hasResult={!!tabMgr.currentTab.result}
      />
    </div>
  );
}
