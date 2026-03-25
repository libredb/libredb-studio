"use client";

import React, { useState, useEffect, useRef } from 'react';
import { Sidebar, ConnectionsList } from '@/components/sidebar';
import { MobileNav } from '@/components/MobileNav';
import { SchemaExplorer } from '@/components/schema-explorer';
import { ConnectionModal } from '@/components/ConnectionModal';
import { CommandPalette } from '@/components/CommandPalette';
import { QueryEditor, QueryEditorRef } from '@/components/QueryEditor';
import { DataImportModal } from '@/components/DataImportModal';
import { QuerySafetyDialog } from '@/components/QuerySafetyDialog';
import { DataProfiler } from '@/components/DataProfiler';
import { CodeGenerator } from '@/components/CodeGenerator';
import { TestDataGenerator } from '@/components/TestDataGenerator';
import { CreateTableModal } from '@/components/CreateTableModal';
import { SchemaDiagram } from '@/components/SchemaDiagram';
import { SaveQueryModal } from '@/components/SaveQueryModal';
import {
  StudioMobileHeader,
  StudioDesktopHeader,
  StudioTabBar,
  QueryToolbar,
  BottomPanel,
} from '@/components/studio/index';
import { DatabaseConnection, SavedQuery } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { useProviderMetadata } from '@/hooks/use-provider-metadata';
import { useAuth } from '@/hooks/use-auth';
import { useConnectionManager } from '@/hooks/use-connection-manager';
import { useTabManager } from '@/hooks/use-tab-manager';
import { useTransactionControl } from '@/hooks/use-transaction-control';
import { useQueryExecution } from '@/hooks/use-query-execution';
import { useInlineEditing } from '@/hooks/use-inline-editing';
import { useStorageSync } from '@/hooks/use-storage-sync';
import { storage } from '@/lib/storage';
import {
  type MaskingConfig,
  loadMaskingConfig,
  saveMaskingConfig,
  shouldMask,
  canToggleMasking,
  detectSensitiveColumnsFromConfig,
  applyMaskingToRows,
} from '@/lib/data-masking';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { AlertTriangle, Database, Plus } from 'lucide-react';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function Studio() {
  const queryEditorRef = useRef<QueryEditorRef>(null);
  const router = useRouter();
  const { toast } = useToast();

  // 1. Auth
  const { user, isAdmin, handleLogout } = useAuth();

  // 1.5. Storage sync (write-through cache for server mode)
  const { isReady: storageReady } = useStorageSync();

  // 2. Connection Manager + Provider Metadata
  const conn = useConnectionManager(storageReady);
  const { metadata } = useProviderMetadata(conn.activeConnection);

  // 3. Tab Manager
  const tabMgr = useTabManager({
    activeConnection: conn.activeConnection,
    metadata,
    schema: conn.schema,
  });

  // 4. Transaction Control
  const txn = useTransactionControl({
    activeConnection: conn.activeConnection,
  });

  // 5. Query Execution
  const queryExec = useQueryExecution({
    activeConnection: conn.activeConnection,
    metadata,
    tabs: tabMgr.tabs,
    activeTabId: tabMgr.activeTabId,
    currentTab: tabMgr.currentTab,
    setTabs: tabMgr.setTabs,
    transactionActive: txn.transactionActive,
    playgroundMode: txn.playgroundMode,
    fetchSchema: conn.fetchSchema,
    queryEditorRef,
  });

  // 6. Inline Editing
  const editing = useInlineEditing({
    activeConnection: conn.activeConnection,
    currentTab: tabMgr.currentTab,
    executeQuery: queryExec.executeQuery,
  });

  // === Cross-hook orchestration: connection-change effect ===
  useEffect(() => {
    if (conn.activeConnection) {
      txn.resetTransactionState();
      editing.setEditingEnabled(false);
      editing.handleDiscardChanges();
      conn.fetchSchema(conn.activeConnection);
      const tabType = metadata?.capabilities.queryLanguage === 'json' ? 'mongodb' :
                      conn.activeConnection.type === 'redis' ? 'redis' : 'sql';
      tabMgr.setTabs(prev => prev.map((t) => {
        return {
          ...t,
          type: tabType,
        };
      }));
    } else {
      conn.setSchema([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.activeConnection, metadata]);

  // === Modal state ===
  const [isConnectionModalOpen, setIsConnectionModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<DatabaseConnection | null>(null);
  const [isCreateTableModalOpen, setIsCreateTableModalOpen] = useState(false);
  const [showDiagram, setShowDiagram] = useState(false);
  const [isSaveQueryModalOpen, setIsSaveQueryModalOpen] = useState(false);
  const [savedKey, setSavedKey] = useState(0);
  const [activeMobileTab, setActiveMobileTab] = useState<'database' | 'schema' | 'editor'>('editor');
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isNL2SQLOpen, setIsNL2SQLOpen] = useState(false);
  const [profilerTable, setProfilerTable] = useState<string | null>(null);
  const [codeGenTable, setCodeGenTable] = useState<string | null>(null);
  const [testDataTable, setTestDataTable] = useState<string | null>(null);

  // Data Masking
  const [maskingConfig, setMaskingConfig] = useState<MaskingConfig>(() => loadMaskingConfig());
  const effectiveMasking = shouldMask(user?.role, maskingConfig);
  const userCanToggle = canToggleMasking(user?.role, maskingConfig);

  const openMaintenance = () => {
    if (isAdmin) {
      router.push('/admin?tab=operations');
    } else {
      router.push('/monitoring');
    }
  };

  const handleSaveQuery = (name: string, description: string, tags: string[]) => {
    if (!conn.activeConnection) return;
    const newSavedQuery: SavedQuery = {
      id: Math.random().toString(36).substring(7),
      name,
      query: tabMgr.currentTab.query,
      description,
      connectionType: conn.activeConnection.type,
      tags,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    storage.saveQuery(newSavedQuery);
    setSavedKey(prev => prev + 1);
    toast({ title: "Query Saved", description: `"${name}" has been added to your saved queries.` });
  };

  const exportResults = (format: 'csv' | 'json' | 'sql-insert' | 'sql-ddl') => {
    if (!tabMgr.currentTab.result) return;
    const rawData = tabMgr.currentTab.result.rows;
    const sensitiveColumns = detectSensitiveColumnsFromConfig(tabMgr.currentTab.result.fields, maskingConfig);
    const data = effectiveMasking
      ? applyMaskingToRows(rawData, tabMgr.currentTab.result.fields, sensitiveColumns)
      : rawData;
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
      const tableName = tabMgr.currentTab.name.replace(/^Query[:  ]*/, '') || 'table_name';
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
      const tableName = tabMgr.currentTab.name.replace(/^Query[:  ]*/, '') || 'table_name';
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
  };

  const onTableClick = (tableName: string) => {
    tabMgr.handleTableClick(tableName, queryExec.executeQuery);
  };

  const handleDeleteConnection = (id: string) => {
    // Clean up server-side provider cache and close connections/tunnels
    fetch('/api/db/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: id }),
    }).catch(() => { /* best-effort cleanup */ });

    storage.deleteConnection(id);
    // Preserve managed (seed) connections that aren't in localStorage
    const userConns = storage.getConnections();
    const managedConns = conn.connections.filter((c) => c.managed && !userConns.some((uc) => uc.id === c.id));
    const updated = [...managedConns, ...userConns];
    conn.setConnections(updated);
    if (conn.activeConnection?.id === id) conn.setActiveConnection(updated[0] || null);
  };

  return (
    <div className="flex h-screen w-full bg-[#050505] text-zinc-100 overflow-hidden font-sans select-none">
      <ResizablePanelGroup id="studio-main" direction="horizontal" className="h-full">
        <ResizablePanel defaultSize={22} minSize={15} maxSize={35} className="hidden md:block">
          <Sidebar
            connections={conn.connections}
            activeConnection={conn.activeConnection}
            schema={conn.schema}
            isLoadingSchema={conn.isLoadingSchema}
            onSelectConnection={conn.setActiveConnection}
            onDeleteConnection={handleDeleteConnection}
            onEditConnection={(c) => {
              setEditingConnection(c);
              setIsConnectionModalOpen(true);
            }}
            onAddConnection={() => setIsConnectionModalOpen(true)}
            onTableClick={onTableClick}
            onGenerateSelect={tabMgr.handleGenerateSelect}
            onCreateTableClick={() => setIsCreateTableModalOpen(true)}
            onShowDiagram={() => setShowDiagram(true)}
            isAdmin={isAdmin}
            onOpenMaintenance={openMaintenance}
            databaseType={conn.activeConnection?.type}
            metadata={metadata}
            onProfileTable={(name) => setProfilerTable(name)}
            onGenerateCode={(name) => setCodeGenTable(name)}
            onGenerateTestData={(name) => setTestDataTable(name)}
          />
        </ResizablePanel>
        <ResizableHandle className="hidden md:flex w-1 bg-transparent hover:bg-blue-500/30 transition-colors" />
        <ResizablePanel defaultSize={78}>
          <div className="flex-1 flex flex-col min-w-0 h-full bg-[#0a0a0a] pb-16 md:pb-0">
            <StudioMobileHeader
              connections={conn.connections}
              activeConnection={conn.activeConnection}
              connectionPulse={conn.connectionPulse}
              user={user}
              isAdmin={isAdmin}
              activeMobileTab={activeMobileTab}
              isExecuting={tabMgr.currentTab.isExecuting}
              currentQuery={tabMgr.currentTab.query}
              queryEditorRef={queryEditorRef}
              transactionActive={txn.transactionActive}
              playgroundMode={txn.playgroundMode}
              editingEnabled={editing.editingEnabled}
              onSelectConnection={conn.setActiveConnection}
              onAddConnection={() => setIsConnectionModalOpen(true)}
              onLogout={handleLogout}
              onSaveQuery={() => setIsSaveQueryModalOpen(true)}
              onClearQuery={() => tabMgr.updateCurrentTab({ query: '' })}
              onExecuteQuery={() => queryExec.executeQuery()}
              onCancelQuery={queryExec.cancelQuery}
              onBeginTransaction={() => txn.handleTransaction('begin')}
              onCommitTransaction={() => txn.handleTransaction('commit')}
              onRollbackTransaction={() => txn.handleTransaction('rollback')}
              onTogglePlayground={() => txn.setPlaygroundMode(!txn.playgroundMode)}
              onToggleEditing={() => {
                editing.setEditingEnabled(!editing.editingEnabled);
                if (editing.editingEnabled) editing.handleDiscardChanges();
              }}
              onImport={() => setIsImportModalOpen(true)}
              onExplain={metadata?.capabilities.supportsExplain ? () => queryExec.executeQuery(undefined, undefined, true) : undefined}
            />

            <StudioDesktopHeader
              activeConnection={conn.activeConnection}
              connectionPulse={conn.connectionPulse}
              user={user}
              isAdmin={isAdmin}
              onLogout={handleLogout}
            />

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
              <AnimatePresence>
                {showDiagram && (
                  <SchemaDiagram schema={conn.schema} onClose={() => setShowDiagram(false)} />
                )}
              </AnimatePresence>

              {/* Mobile: Database Tab */}
              {activeMobileTab === 'database' && (
                <div className="md:hidden h-full bg-[#080808] overflow-auto p-4">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-widest">Connections</h2>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs border-white/10 hover:bg-white/5"
                      onClick={() => setIsConnectionModalOpen(true)}
                    >
                      <Plus className="w-3 h-3 mr-1" /> Add
                    </Button>
                  </div>
                  <ConnectionsList
                    connections={conn.connections}
                    activeConnection={conn.activeConnection}
                    onSelectConnection={(c) => {
                      conn.setActiveConnection(c);
                      setActiveMobileTab('editor');
                    }}
                    onDeleteConnection={handleDeleteConnection}
                    onAddConnection={() => setIsConnectionModalOpen(true)}
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
                      onTableClick={(tableName) => {
                        onTableClick(tableName);
                        setActiveMobileTab('editor');
                      }}
                      onGenerateSelect={(tableName) => {
                        tabMgr.handleGenerateSelect(tableName);
                        setActiveMobileTab('editor');
                      }}
                      onCreateTableClick={() => setIsCreateTableModalOpen(true)}
                      isAdmin={isAdmin}
                      onOpenMaintenance={openMaintenance}
                      databaseType={conn.activeConnection?.type}
                      metadata={metadata}
                      onProfileTable={(name) => setProfilerTable(name)}
                      onGenerateCode={(name) => setCodeGenTable(name)}
                      onGenerateTestData={(name) => setTestDataTable(name)}
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
                "h-full",
                activeMobileTab !== 'editor' && "hidden md:block"
              )}>
                <div className="h-full">
                  <ResizablePanelGroup id="studio-editor" direction="vertical">
                    <ResizablePanel defaultSize={40} minSize={20}>
                      <div className="h-full flex flex-col">
                        <QueryToolbar
                          activeConnection={conn.activeConnection}
                          metadata={metadata}
                          isExecuting={tabMgr.currentTab.isExecuting}
                          playgroundMode={txn.playgroundMode}
                          transactionActive={txn.transactionActive}
                          editingEnabled={editing.editingEnabled}
                          onSaveQuery={() => setIsSaveQueryModalOpen(true)}
                          onExecuteQuery={() => queryExec.executeQuery()}
                          onCancelQuery={queryExec.cancelQuery}
                          onBeginTransaction={() => txn.handleTransaction('begin')}
                          onCommitTransaction={() => txn.handleTransaction('commit')}
                          onRollbackTransaction={() => txn.handleTransaction('rollback')}
                          onTogglePlayground={() => txn.setPlaygroundMode(!txn.playgroundMode)}
                          onToggleEditing={() => {
                            editing.setEditingEnabled(!editing.editingEnabled);
                            if (editing.editingEnabled) editing.handleDiscardChanges();
                          }}
                          onImport={() => setIsImportModalOpen(true)}
                        />

                        <div className="flex-1 relative">
                          <QueryEditor
                            ref={queryEditorRef}
                            value={tabMgr.currentTab.query}
                            onContentChange={(val) => tabMgr.updateTabById(tabMgr.currentTab.id, { query: val })}
                            onExplain={metadata?.capabilities.supportsExplain ? () => queryExec.executeQuery(undefined, undefined, true) : undefined}
                            language={tabMgr.currentTab.type === 'mongodb' ? 'json' : 'sql'}
                            tables={conn.tableNames}
                            databaseType={conn.activeConnection?.type}
                            schemaContext={conn.schemaContext}
                            capabilities={metadata?.capabilities}
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
                        metadata={metadata}
                        historyKey={queryExec.historyKey}
                        savedKey={savedKey}
                        isNL2SQLOpen={isNL2SQLOpen}
                        onSetIsNL2SQLOpen={setIsNL2SQLOpen}
                        maskingEnabled={effectiveMasking}
                        onToggleMasking={userCanToggle ? () => {
                          setMaskingConfig(prev => {
                            const updated = { ...prev, enabled: !prev.enabled };
                            saveMaskingConfig(updated);
                            return updated;
                          });
                        } : undefined}
                        userRole={user?.role}
                        maskingConfig={maskingConfig}
                        editingEnabled={editing.editingEnabled}
                        pendingChanges={editing.pendingChanges}
                        onCellChange={editing.handleCellChange}
                        onApplyChanges={editing.handleApplyChanges}
                        onDiscardChanges={editing.handleDiscardChanges}
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

      {/* Modals */}
      <ConnectionModal
        isOpen={isConnectionModalOpen}
        onClose={() => { setIsConnectionModalOpen(false); setEditingConnection(null); }}
        onConnect={(c) => {
          storage.saveConnection(c);
          const userConns = storage.getConnections();
          const managedConns = conn.connections.filter((mc) => mc.managed && !userConns.some((uc) => uc.id === mc.id));
          conn.setConnections([...managedConns, ...userConns]);
          conn.setActiveConnection(c);
          setIsConnectionModalOpen(false);
          setEditingConnection(null);
        }}
        editConnection={editingConnection}
      />
      <CreateTableModal
        isOpen={isCreateTableModalOpen}
        onClose={() => setIsCreateTableModalOpen(false)}
        onTableCreated={(sql) => queryExec.executeQuery(sql)}
        dbType={conn.activeConnection?.type}
      />
      <SaveQueryModal
        isOpen={isSaveQueryModalOpen}
        onClose={() => setIsSaveQueryModalOpen(false)}
        onSave={handleSaveQuery}
        defaultQuery={tabMgr.currentTab.query}
      />
      <DataImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImport={(sql) => queryExec.executeQuery(sql)}
        tables={conn.schema}
        databaseType={conn.activeConnection?.type}
      />
      <QuerySafetyDialog
        isOpen={!!queryExec.safetyCheckQuery}
        query={queryExec.safetyCheckQuery || ''}
        schemaContext={conn.schemaContext}
        databaseType={conn.activeConnection?.type}
        onClose={() => queryExec.setSafetyCheckQuery(null)}
        onProceed={() => {
          if (queryExec.safetyCheckQuery) queryExec.forceExecuteQuery(queryExec.safetyCheckQuery);
        }}
      />
      <DataProfiler
        isOpen={!!profilerTable}
        onClose={() => setProfilerTable(null)}
        tableName={profilerTable || ''}
        tableSchema={conn.schema.find(t => t.name === profilerTable) || null}
        connection={conn.activeConnection}
        schemaContext={conn.schemaContext}
        databaseType={conn.activeConnection?.type}
      />
      <CodeGenerator
        isOpen={!!codeGenTable}
        onClose={() => setCodeGenTable(null)}
        tableName={codeGenTable || ''}
        tableSchema={conn.schema.find(t => t.name === codeGenTable) || null}
        databaseType={conn.activeConnection?.type}
      />
      <TestDataGenerator
        isOpen={!!testDataTable}
        onClose={() => setTestDataTable(null)}
        tableName={testDataTable || ''}
        tableSchema={conn.schema.find(t => t.name === testDataTable) || null}
        databaseType={conn.activeConnection?.type}
        queryLanguage={metadata?.capabilities.queryLanguage}
        onExecuteQuery={(q) => queryExec.executeQuery(q)}
      />

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

      <CommandPalette
        connections={conn.connections}
        activeConnection={conn.activeConnection}
        schema={conn.schema}
        onSelectConnection={conn.setActiveConnection}
        onTableClick={onTableClick}
        onAddConnection={() => setIsConnectionModalOpen(true)}
        onExecuteQuery={() => queryExec.executeQuery()}
        onLoadSavedQuery={(q) => {
          tabMgr.updateCurrentTab({ query: q });
          queryExec.setBottomPanelMode('results');
        }}
        onLoadHistoryQuery={(q) => {
          tabMgr.updateCurrentTab({ query: q });
          queryExec.setBottomPanelMode('results');
        }}
        onNavigateHealth={() => router.push('/monitoring')}
        onNavigateMonitoring={() => router.push('/monitoring')}
        onShowDiagram={() => setShowDiagram(true)}
        onFormatQuery={() => queryEditorRef.current?.format()}
        onSaveQuery={() => setIsSaveQueryModalOpen(true)}
        onToggleAI={() => queryEditorRef.current?.toggleAi()}
        onLogout={handleLogout}
      />

      <MobileNav
        activeTab={activeMobileTab}
        onTabChange={setActiveMobileTab}
        hasResult={!!tabMgr.currentTab.result}
      />
    </div>
  );
}
