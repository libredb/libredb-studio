"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Sidebar, ConnectionsList } from '@/components/Sidebar';
import { MobileNav } from '@/components/MobileNav';
import { SchemaExplorer } from '@/components/SchemaExplorer';
import { ConnectionModal } from '@/components/ConnectionModal';
import { CommandPalette } from '@/components/CommandPalette';
import { QueryEditor, QueryEditorRef } from '@/components/QueryEditor';
import { ResultsGrid, type CellChange } from '@/components/ResultsGrid';
import { DataImportModal } from '@/components/DataImportModal';
import { NL2SQLPanel } from '@/components/NL2SQLPanel';
import { QuerySafetyDialog, isDangerousQuery } from '@/components/QuerySafetyDialog';
import { AIAutopilotPanel } from '@/components/AIAutopilotPanel';
import { DataProfiler } from '@/components/DataProfiler';
import { CodeGenerator } from '@/components/CodeGenerator';
import { TestDataGenerator } from '@/components/TestDataGenerator';
import { PivotTable } from '@/components/PivotTable';
import { DatabaseDocs } from '@/components/DatabaseDocs';
import { VisualExplain, type ExplainPlanResult } from '@/components/VisualExplain';
import { HealthDashboard } from '@/components/HealthDashboard';
import { CreateTableModal } from '@/components/CreateTableModal';
import { SchemaDiagram } from '@/components/SchemaDiagram';
import { QueryHistory } from '@/components/QueryHistory';
import { SavedQueries } from '@/components/SavedQueries';
import { DataCharts } from '@/components/DataCharts';
import { SchemaDiff } from '@/components/SchemaDiff';
import { SaveQueryModal } from '@/components/SaveQueryModal';
import { MaintenanceModal } from '@/components/MaintenanceModal';
import { DatabaseConnection, TableSchema, QueryTab, SavedQuery } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { useProviderMetadata } from '@/hooks/use-provider-metadata';
import { storage } from '@/lib/storage';
import { getDefaultQuery, getRandomShowcaseQuery } from '@/lib/showcase-queries';
import { generateTableQuery, generateSelectQuery, shouldRefreshSchema } from '@/lib/query-generators';
import { isMultiStatement } from '@/lib/sql/statement-splitter';
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
import {
  Activity,
  AlertTriangle,
  AlignLeft,
  BarChart3,
  Bookmark,
  ChevronDown,
  Clock,
  Copy,
  Database,
  Download,
  FileJson,
  FlaskConical,
  Gauge,
  Hash,
  LayoutGrid,
  LogOut,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Save,
  Settings,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Upload,
  User,
  X,
  Zap,
  Columns3,
  FileText,
  GitCompare,
  LayoutDashboard,
} from 'lucide-react';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { AnimatePresence } from 'framer-motion';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Lazy-loaded chart dashboard - will render saved charts in a grid
function ChartDashboardLazy({ result }: { result: import('@/lib/types').QueryResult | null }) {
  const [savedCharts, setSavedCharts] = React.useState<{ id: string; name: string; chartType: string; xAxis: string; yAxis: string[] }[]>([]);
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem('libredb_saved_charts');
      if (stored) setSavedCharts(JSON.parse(stored));
    } catch { /* ignore */ }
  }, []);

  if (savedCharts.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[#080808] text-zinc-500 gap-2">
        <LayoutDashboard className="w-10 h-10 opacity-30" />
        <p className="text-sm">No saved charts yet</p>
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
              <span className="text-xs font-bold text-zinc-300">{chart.name}</span>
              <span className="text-[10px] text-zinc-600 uppercase">{chart.chartType}</span>
            </div>
            <div className="text-[10px] text-zinc-500">
              {chart.xAxis && <span>X: {chart.xAxis}</span>}
              {chart.yAxis?.length > 0 && <span className="ml-2">Y: {chart.yAxis.join(', ')}</span>}
            </div>
            {result ? (
              <div className="mt-2 h-[160px]">
                <DataCharts result={result} />
              </div>
            ) : (
              <div className="mt-2 h-[100px] flex items-center justify-center text-zinc-600 text-[10px]">
                Execute a query to see chart
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Studio() {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [activeConnection, setActiveConnection] = useState<DatabaseConnection | null>(null);
  const [schema, setSchema] = useState<TableSchema[]>([]);
  const [user, setUser] = useState<{ role?: string } | null>(null);
  const [isMaintenanceModalOpen, setIsMaintenanceModalOpen] = useState(false);
  const [maintenanceInitialTab, setMaintenanceInitialTab] = useState<'global' | 'tables' | 'sessions'>('global');
  const [maintenanceTargetTable, setMaintenanceTargetTable] = useState<string | undefined>(undefined);
  
  const queryEditorRef = useRef<QueryEditorRef>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeQueryIdRef = useRef<string | null>(null);

  const { metadata } = useProviderMetadata(activeConnection);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
        }
      } catch (error) {
        console.error('Failed to fetch user:', error);
      }
    };
    fetchUser();
  }, []);

  const isAdmin = user?.role === 'admin';

  const openMaintenance = (tab: 'global' | 'tables' | 'sessions' = 'global', table?: string) => {
    setMaintenanceInitialTab(tab);
    setMaintenanceTargetTable(table);
    setIsMaintenanceModalOpen(true);
  };

  const [isConnectionModalOpen, setIsConnectionModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<DatabaseConnection | null>(null);
  const [isCreateTableModalOpen, setIsCreateTableModalOpen] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState('');
  const [showDiagram, setShowDiagram] = useState(false);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  
  const [tabs, setTabs] = useState<QueryTab[]>([
    {
      id: 'default',
      name: 'Query 1',
      query: '-- Start typing your SQL query here\n',
      result: null,
      isExecuting: false,
      type: 'sql'
    }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('default');
  const [activeView, setActiveView] = useState<'editor' | 'health'>('editor');
  const [bottomPanelMode, setBottomPanelMode] = useState<'results' | 'explain' | 'history' | 'saved' | 'charts' | 'nl2sql' | 'autopilot' | 'pivot' | 'docs' | 'schemadiff' | 'dashboard'>('results');
  const [activeMobileTab, setActiveMobileTab] = useState<'database' | 'schema' | 'editor'>('editor');

  const [isSaveQueryModalOpen, setIsSaveQueryModalOpen] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [savedKey, setSavedKey] = useState(0);

  // Transaction state
  const [transactionActive, setTransactionActive] = useState(false);

  // Playground (Sandbox) mode
  const [playgroundMode, setPlaygroundMode] = useState(false);

  // Data Masking (config-aware, persisted)
  const [maskingConfig, setMaskingConfig] = useState<MaskingConfig>(() => loadMaskingConfig());
  const effectiveMasking = shouldMask(user?.role, maskingConfig);
  const userCanToggle = canToggleMasking(user?.role, maskingConfig);

  // Inline Editing
  const [editingEnabled, setEditingEnabled] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<CellChange[]>([]);

  // Data Import
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  // NL2SQL Panel
  const [isNL2SQLOpen, setIsNL2SQLOpen] = useState(false);

  // Query Safety Analysis
  const [safetyCheckQuery, setSafetyCheckQuery] = useState<string | null>(null);

  // Data Profiler
  const [profilerTable, setProfilerTable] = useState<string | null>(null);

  // Code Generator
  const [codeGenTable, setCodeGenTable] = useState<string | null>(null);

  // Test Data Generator
  const [testDataTable, setTestDataTable] = useState<string | null>(null);

  // Unlimited query warning state (for Load All)
  const [unlimitedWarningOpen, setUnlimitedWarningOpen] = useState(false);
  const [pendingUnlimitedQuery, setPendingUnlimitedQuery] = useState<{
    query: string;
    tabId: string;
  } | null>(null);

  const { toast } = useToast();
  const router = useRouter();

  const currentTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  // Memoize props passed to QueryEditor to prevent unnecessary re-renders
  const tableNames = useMemo(() => schema.map(s => s.name), [schema]);
  const schemaContext = useMemo(() => JSON.stringify(schema), [schema]);

  // Track previous tab to sync editor content on tab switch
  const prevTabIdRef = useRef<string>(activeTabId);

  // Sync editor content when switching tabs
  useEffect(() => {
    if (prevTabIdRef.current !== activeTabId && queryEditorRef.current) {
      // Save current editor content to the previous tab before switching
      const currentEditorValue = queryEditorRef.current.getValue();
      const prevTabId = prevTabIdRef.current;

      setTabs(prev => prev.map(t =>
        t.id === prevTabId ? { ...t, query: currentEditorValue } : t
      ));

      // Update ref to current tab
      prevTabIdRef.current = activeTabId;
    }
  }, [activeTabId]);

  const updateCurrentTab = useCallback((updates: Partial<QueryTab>) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, ...updates } : t));
  }, [activeTabId]);

  const addTab = () => {
    const newId = Math.random().toString(36).substring(7);
    const isDemo = activeConnection?.isDemo || activeConnection?.type === 'demo';
    const queryLanguage = metadata?.capabilities.queryLanguage;
    const newTab: QueryTab = {
      id: newId,
      name: `Query ${tabs.length + 1}`,
      query: getDefaultQuery(isDemo, queryLanguage),
      result: null,
      isExecuting: false,
      type: queryLanguage === 'json' ? 'mongodb' : 'sql'
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newId);
  };

  const closeTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return;
    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);
    if (activeTabId === id) {
      setActiveTabId(newTabs[newTabs.length - 1].id);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      toast({ title: "Logged out", description: "You have been successfully logged out." });
      router.push('/login');
      router.refresh();
    } catch {
      toast({ title: "Error", description: "Failed to logout.", variant: "destructive" });
    }
  };

  const handleSaveQuery = (name: string, description: string, tags: string[]) => {
    if (!activeConnection) return;
    
    const newSavedQuery: SavedQuery = {
      id: Math.random().toString(36).substring(7),
      name,
      query: currentTab.query,
      description,
      connectionType: activeConnection.type,
      tags,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    storage.saveQuery(newSavedQuery);
    setSavedKey(prev => prev + 1);
    toast({ title: "Query Saved", description: `"${name}" has been added to your saved queries.` });
  };

  const exportResults = (format: 'csv' | 'json' | 'sql-insert' | 'sql-ddl') => {
    if (!currentTab.result) return;

    // Apply masking to exported data if masking is active
    const rawData = currentTab.result.rows;
    const sensitiveColumns = detectSensitiveColumnsFromConfig(currentTab.result.fields, maskingConfig);
    const data = effectiveMasking
      ? applyMaskingToRows(rawData, currentTab.result.fields, sensitiveColumns)
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
      const tableName = currentTab.name.replace(/^Query[:  ]*/, '') || 'table_name';
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
      const tableName = currentTab.name.replace(/^Query[:  ]*/, '') || 'table_name';
      const columns = Object.keys(data[0] || {});
      // Infer types from first row
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

  interface QueryExecutionOptions {
    limit?: number;
    offset?: number;
    unlimited?: boolean;
  }

  const fetchSchema = useCallback(async (conn: DatabaseConnection) => {
    setIsLoadingSchema(true);

    if (conn.isDemo) {
      console.log('[DemoDB] Fetching schema for demo connection:', conn.name);
    }

    try {
      const response = await fetch('/api/db/schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conn),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error || 'Failed to fetch schema';

        if (conn.isDemo) {
          console.error('[DemoDB] Schema fetch failed:', errorMessage);
          throw new Error(`Demo database unavailable: ${errorMessage}. You can add your own database connection.`);
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();

      if (conn.isDemo) {
        console.log('[DemoDB] Schema loaded successfully:', {
          tables: data.length,
          tableNames: data.slice(0, 5).map((t: TableSchema) => t.name),
        });
      }

      setSchema(data);
    } catch (error) {
      const title = conn.isDemo ? "Demo Database Error" : "Schema Error";
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast({ title, description: errorMessage, variant: "destructive" });
    } finally {
      setIsLoadingSchema(false);
    }
  }, [toast]);

  const executeQuery = useCallback(async (
    overrideQuery?: string,
    tabId?: string,
    isExplain: boolean = false,
    executionOptions?: QueryExecutionOptions
  ) => {
    const targetTabId = tabId || activeTabId;
    const tabToExec = tabs.find(t => t.id === targetTabId) || currentTab;

    // Modern Execution Logic: Prioritize selection from ref, then override, then tab state
    let queryToExecute = overrideQuery;
    if (!queryToExecute && targetTabId === activeTabId && queryEditorRef.current) {
      queryToExecute = queryEditorRef.current.getEffectiveQuery();
    }
    if (!queryToExecute) {
      queryToExecute = tabToExec.query;
    }

    if (!activeConnection) {
      toast({ title: "No Connection", description: "Select a connection first.", variant: "destructive" });
      return;
    }

    // Safety check for dangerous queries (skip for explain, load-more, and playground)
    if (!isExplain && !executionOptions?.offset && !playgroundMode && isDangerousQuery(queryToExecute)) {
      setSafetyCheckQuery(queryToExecute);
      return;
    }

    // Options extraction
    const {
      limit = 500,
      offset = 0,
      unlimited = false,
    } = executionOptions || {};

    // isLoadingMore flag
    const isLoadMore = offset > 0;

    setTabs(prev => prev.map(t => t.id === targetTabId ? {
      ...t,
      isExecuting: !isLoadMore,
      isLoadingMore: isLoadMore,
    } : t));
    setBottomPanelMode(isExplain ? 'explain' : 'results');

    if (activeConnection.isDemo && process.env.NODE_ENV === 'development') {
      console.log('[DemoDB] Executing query on demo connection:', {
        queryPreview: queryToExecute.substring(0, 100) + (queryToExecute.length > 100 ? '...' : ''),
      });
    }

    // Check EXPLAIN support via capabilities
    if (isExplain && metadata && !metadata.capabilities.supportsExplain) {
      toast({ title: "Not Supported", description: "EXPLAIN is not available for this database type.", variant: "destructive" });
      setTabs(prev => prev.map(t => t.id === targetTabId ? { ...t, isExecuting: false, isLoadingMore: false } : t));
      return;
    }

    // Build EXPLAIN query for PostgreSQL/MySQL
    const buildExplainQuery = (sql: string, dbType: string): string | null => {
      // Only for SELECT queries
      if (!/^\s*SELECT\b/i.test(sql.trim())) return null;

      if (dbType === 'postgres') {
        return `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`;
      } else if (dbType === 'mysql') {
        return `EXPLAIN FORMAT=JSON ${sql}`;
      }
      return null;
    };

    const startTime = Date.now();
    // Set up abort controller for query cancellation
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const queryId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeQueryIdRef.current = queryId;

    // Playground mode: begin a transaction before executing (will rollback after)
    const isPlaygroundRun = playgroundMode && !transactionActive && !isExplain && !isLoadMore;

    try {
      if (isPlaygroundRun) {
        await fetch('/api/db/transaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connection: activeConnection, action: 'begin' }),
        });
      }

      // If isExplain mode, run EXPLAIN query instead
      let queryToRun = queryToExecute;
      if (isExplain && activeConnection.type) {
        const explainSql = buildExplainQuery(queryToExecute, activeConnection.type);
        if (explainSql) {
          queryToRun = explainSql;
        }
      }

      // Detect multi-statement queries (not for EXPLAIN or load-more or transaction)
      const useMultiQuery = !isExplain && !isLoadMore && !transactionActive && !isPlaygroundRun && isMultiStatement(queryToExecute);

      // Use transaction endpoint if a transaction is active or in playground mode
      const useTransaction = (transactionActive || isPlaygroundRun) && !isExplain;

      // Start both queries in parallel (main query + background explain)
      const queryEndpoint = useTransaction
        ? '/api/db/transaction'
        : useMultiQuery ? '/api/db/multi-query' : '/api/db/query';
      const mainQueryPromise = fetch(queryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection: activeConnection,
          ...(useTransaction
            ? { action: 'query', sql: queryToExecute, options: { limit, offset, unlimited } }
            : {
                sql: isExplain ? queryToRun : queryToExecute,
                options: isExplain ? {} : { limit, offset, unlimited },
                ...(!useMultiQuery && { queryId }),
              }
          ),
        }),
        signal: abortController.signal,
      });

      // Run EXPLAIN in background for non-explain queries (SELECT only)
      let explainPromise: Promise<Response> | null = null;
      if (!isExplain && !isLoadMore && activeConnection.type) {
        const explainSql = buildExplainQuery(queryToExecute, activeConnection.type);
        if (explainSql) {
          explainPromise = fetch('/api/db/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              connection: activeConnection,
              sql: explainSql,
              options: {},
            }),
          });
        }
      }

      const response = await mainQueryPromise;

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      if (!response.ok) {
        const error = await response.json();
        const errorMessage = error.error || 'Query failed';

        if (activeConnection.isDemo) {
          console.error('[DemoDB] Query failed:', { errorMessage, executionTime });
        }

        storage.addToHistory({
          id: Math.random().toString(36).substring(7),
          connectionId: activeConnection.id,
          connectionName: activeConnection.name,
          tabName: tabToExec.name,
          query: queryToExecute,
          executionTime,
          status: 'error',
          executedAt: new Date(),
          errorMessage
        });

        // Provide more context for demo connection errors
        if (activeConnection.isDemo) {
          throw new Error(`Demo database error: ${errorMessage}. The demo database may be temporarily unavailable.`);
        }
        throw new Error(errorMessage);
      }

      const resultData = await response.json();

      if (activeConnection.isDemo && process.env.NODE_ENV === 'development') {
        console.log('[DemoDB] Query executed successfully:', {
          rowCount: resultData.rowCount,
          executionTime: resultData.executionTime || executionTime,
        });
      }

      // Only add to history for new queries (not load more)
      if (!isLoadMore) {
        storage.addToHistory({
          id: Math.random().toString(36).substring(7),
          connectionId: activeConnection.id,
          connectionName: activeConnection.name,
          tabName: tabToExec.name,
          query: queryToExecute,
          executionTime: resultData.executionTime || executionTime,
          status: resultData.hasError ? 'error' : 'success',
          executedAt: new Date(),
          rowCount: resultData.rowCount,
          errorMessage: resultData.hasError ? resultData.statements?.find((s: { status: string }) => s.status === 'error')?.error : undefined,
        });
        setHistoryKey(prev => prev + 1);
      }

      // Show multi-statement summary
      if (resultData.multiStatement) {
        const { executedCount, statementCount, hasError } = resultData;
        if (hasError) {
          const errorStmt = resultData.statements?.find((s: { status: string }) => s.status === 'error');
          toast({
            title: `Executed ${executedCount - 1}/${statementCount} statements`,
            description: `Error in statement ${errorStmt?.index + 1}: ${errorStmt?.error}`,
            variant: "destructive",
          });
        } else {
          toast({
            title: `${executedCount} statements executed`,
            description: `All ${statementCount} statements completed in ${resultData.executionTime}ms`,
          });
        }
      }

      // Process EXPLAIN results (from background or direct)
      let explainPlanData = null;
      if (isExplain) {
        // Direct EXPLAIN query - parse result
        explainPlanData = resultData.rows?.[0]?.['QUERY PLAN'] || resultData.rows;
      } else if (explainPromise) {
        // Background EXPLAIN - don't block, update async
        explainPromise.then(async (explainRes) => {
          if (explainRes.ok) {
            const explainData = await explainRes.json();
            const plan = explainData.rows?.[0]?.['QUERY PLAN'] || explainData.rows;
            setTabs(prev => prev.map(t =>
              t.id === targetTabId ? { ...t, explainPlan: plan } : t
            ));
          }
        }).catch(err => console.error('[EXPLAIN] Background fetch failed:', err));
      }

      // Update tab state: Load More (append) vs new query (replace)
      setTabs(prev => prev.map(t => {
        if (t.id !== targetTabId) return t;

        // Load More mode: append rows
        if (isLoadMore && t.result) {
          const existingRows = t.allRows || t.result.rows;
          const newAllRows = [...existingRows, ...resultData.rows];

          return {
            ...t,
            result: {
              ...resultData,
              rows: newAllRows,
              rowCount: newAllRows.length,
            },
            allRows: newAllRows,
            currentOffset: offset + resultData.rows.length,
            isExecuting: false,
            isLoadingMore: false,
          };
        }

        // New query mode: replace
        return {
          ...t,
          result: isExplain ? null : resultData, // Don't show EXPLAIN as results
          allRows: isExplain ? t.allRows : resultData.rows,
          currentOffset: isExplain ? t.currentOffset : resultData.rows.length,
          isExecuting: false,
          isLoadingMore: false,
          explainPlan: explainPlanData || t.explainPlan,
        };
      }));

      // Playground mode: auto-rollback after getting results
      if (isPlaygroundRun) {
        await fetch('/api/db/transaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connection: activeConnection, action: 'rollback' }),
        });
        toast({
          title: "Playground",
          description: "Changes auto-rolled back. No data was modified.",
        });
      }

      // Refresh schema after DDL/write operations (pattern from provider capabilities)
      // Skip schema refresh in playground mode since changes are rolled back
      if (!isExplain && !isPlaygroundRun && metadata) {
        if (shouldRefreshSchema(queryToExecute, metadata.capabilities.schemaRefreshPattern)) {
          fetchSchema(activeConnection);
        }
      }
    } catch (error) {
      // Playground mode: rollback on error too
      if (isPlaygroundRun) {
        try {
          await fetch('/api/db/transaction', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connection: activeConnection, action: 'rollback' }),
          });
        } catch { /* best effort */ }
      }
      setTabs(prev => prev.map(t => t.id === targetTabId ? {
        ...t,
        isExecuting: false,
        isLoadingMore: false,
      } : t));

      // Don't show error toast for user-initiated cancellation
      if (error instanceof DOMException && error.name === 'AbortError') {
        toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
        return;
      }

      const title = activeConnection?.isDemo ? "Demo Database Error" : "Query Error";
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('Query was cancelled')) {
        toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
        return;
      }
      toast({ title, description: errorMessage, variant: "destructive" });
    } finally {
      abortControllerRef.current = null;
      activeQueryIdRef.current = null;
    }
  }, [activeConnection, tabs, currentTab, activeTabId, toast, fetchSchema, metadata, transactionActive, playgroundMode]);

  // Cancel running query
  const cancelQuery = useCallback(async () => {
    // Abort the fetch request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Also cancel on the server side
    if (activeQueryIdRef.current && activeConnection) {
      try {
        await fetch('/api/db/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connection: activeConnection,
            queryId: activeQueryIdRef.current,
          }),
        });
      } catch {
        // Best effort - the abort already handles the client side
      }
    }
  }, [activeConnection]);

  // Transaction control
  const handleTransaction = useCallback(async (action: 'begin' | 'commit' | 'rollback') => {
    if (!activeConnection) return;

    try {
      const res = await fetch('/api/db/transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection: activeConnection, action }),
      });

      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Transaction Error", description: data.error, variant: "destructive" });
        return;
      }

      if (action === 'begin') {
        setTransactionActive(true);
        toast({ title: "Transaction Started", description: "BEGIN — all queries will run in this transaction until you COMMIT or ROLLBACK." });
      } else if (action === 'commit') {
        setTransactionActive(false);
        toast({ title: "Transaction Committed", description: "All changes have been saved." });
      } else if (action === 'rollback') {
        setTransactionActive(false);
        toast({ title: "Transaction Rolled Back", description: "All changes have been discarded." });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: "Transaction Error", description: msg, variant: "destructive" });
    }
  }, [activeConnection, toast]);

  // Inline Editing: handle cell change
  const handleCellChange = useCallback((change: CellChange) => {
    setPendingChanges(prev => {
      // Replace existing change for same cell, or add new
      const existing = prev.findIndex(c => c.rowIndex === change.rowIndex && c.columnId === change.columnId);
      if (existing >= 0) {
        // If reverting to original value, remove the change
        if (String(change.originalValue ?? '') === change.newValue) {
          return prev.filter((_, i) => i !== existing);
        }
        const updated = [...prev];
        updated[existing] = change;
        return updated;
      }
      // Don't add if no actual change
      if (String(change.originalValue ?? '') === change.newValue) return prev;
      return [...prev, change];
    });
  }, []);

  // Inline Editing: apply pending changes by generating UPDATE SQL
  const handleApplyChanges = useCallback(async () => {
    if (!activeConnection || !currentTab.result || pendingChanges.length === 0) return;

    // Detect primary key column
    const pkColumn = currentTab.result.fields.find(f =>
      f.toLowerCase() === 'id' || f.toLowerCase().endsWith('_id')
    );

    if (!pkColumn) {
      toast({
        title: "Cannot Apply Changes",
        description: "No primary key column detected (id or *_id). Edit the SQL manually.",
        variant: "destructive",
      });
      return;
    }

    // Group changes by row
    const changesByRow = new Map<number, CellChange[]>();
    for (const change of pendingChanges) {
      const existing = changesByRow.get(change.rowIndex) || [];
      existing.push(change);
      changesByRow.set(change.rowIndex, existing);
    }

    // Detect table name from current tab or query
    const tableName = currentTab.name.replace(/^Query[:  ]*/, '') ||
      currentTab.query.match(/FROM\s+(\S+)/i)?.[1] || 'table_name';

    // Generate UPDATE statements
    const statements: string[] = [];
    for (const [rowIndex, changes] of changesByRow) {
      const row = currentTab.result.rows[rowIndex];
      const pkValue = row[pkColumn];
      const setClauses = changes.map(c => {
        const val = c.newValue === '' || c.newValue.toUpperCase() === 'NULL'
          ? 'NULL'
          : `'${c.newValue.replace(/'/g, "''")}'`;
        return `${c.columnId} = ${val}`;
      });
      const pkVal = typeof pkValue === 'number' ? pkValue : `'${pkValue}'`;
      statements.push(`UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE ${pkColumn} = ${pkVal};`);
    }

    const sql = statements.join('\n');
    // Execute the UPDATE(s)
    executeQuery(sql);
    setPendingChanges([]);
    setEditingEnabled(false);
    toast({
      title: "Changes Applied",
      description: `${statements.length} UPDATE statement(s) executed.`,
    });
  }, [activeConnection, currentTab, pendingChanges, executeQuery, toast]);

  // Inline Editing: discard changes
  const handleDiscardChanges = useCallback(() => {
    setPendingChanges([]);
  }, []);

  // Force execute (bypass safety check)
  const forceExecuteQuery = useCallback(async (query: string) => {
    setSafetyCheckQuery(null);
    // Temporarily disable safety check by calling internal flow
    // We re-implement the core execution path here
    if (!activeConnection) return;

    const targetTabId = activeTabId;
    setTabs(prev => prev.map(t => t.id === targetTabId ? { ...t, isExecuting: true } : t));
    setBottomPanelMode('results');

    const startTime = Date.now();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch('/api/db/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection: activeConnection,
          sql: query,
          options: { limit: 500, offset: 0 },
        }),
        signal: abortController.signal,
      });

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Query failed');
      }

      const resultData = await response.json();

      storage.addToHistory({
        id: Math.random().toString(36).substring(7),
        connectionId: activeConnection.id,
        connectionName: activeConnection.name,
        tabName: tabs.find(t => t.id === targetTabId)?.name || 'Query',
        query,
        executionTime: resultData.executionTime || executionTime,
        status: 'success',
        executedAt: new Date(),
        rowCount: resultData.rowCount,
      });
      setHistoryKey(prev => prev + 1);

      setTabs(prev => prev.map(t => t.id === targetTabId ? {
        ...t, result: resultData, allRows: resultData.rows, currentOffset: resultData.rows.length, isExecuting: false
      } : t));

      // Refresh schema after DDL
      if (metadata && shouldRefreshSchema(query, metadata.capabilities.schemaRefreshPattern)) {
        fetchSchema(activeConnection);
      }
    } catch (error) {
      setTabs(prev => prev.map(t => t.id === targetTabId ? { ...t, isExecuting: false } : t));
      if (error instanceof DOMException && error.name === 'AbortError') {
        toast({ title: "Query Cancelled" });
        return;
      }
      toast({ title: "Query Error", description: error instanceof Error ? error.message : 'Unknown error', variant: "destructive" });
    } finally {
      abortControllerRef.current = null;
    }
  }, [activeConnection, activeTabId, tabs, toast, fetchSchema, metadata]);

  // Load More handler
  const handleLoadMore = () => {
    if (!currentTab.result?.pagination?.hasMore) return;

    const currentOffset = currentTab.currentOffset || currentTab.result.rows.length;
    executeQuery(currentTab.query, currentTab.id, false, {
      limit: 500,
      offset: currentOffset,
    });
  };

  // Unlimited query handler
  const handleUnlimitedQuery = () => {
    if (!pendingUnlimitedQuery) return;

    executeQuery(
      pendingUnlimitedQuery.query,
      pendingUnlimitedQuery.tabId,
      false,
      { unlimited: true }
    );

    setUnlimitedWarningOpen(false);
    setPendingUnlimitedQuery(null);
  };

  useEffect(() => {
    const handleExecuteQuery = (e: Event) => {
      const customEvent = e as CustomEvent<{ query: string }>;
      if (customEvent.detail?.query) {
        executeQuery(customEvent.detail.query);
      }
    };
    window.addEventListener('execute-query', handleExecuteQuery);
    return () => window.removeEventListener('execute-query', handleExecuteQuery);
  }, [executeQuery]);

  useEffect(() => {
    const initializeConnections = async () => {
      const LOG_PREFIX = '[DemoDB]';
      const loadedConnections = storage.getConnections();

      // Fetch demo connection from server
      try {
        console.log(`${LOG_PREFIX} Checking for demo connection...`);
        const res = await fetch('/api/demo-connection');

        if (res.ok) {
          const data = await res.json();

          if (data.enabled && data.connection) {
            const demoConn = {
              ...data.connection,
              createdAt: new Date(data.connection.createdAt),
            };

            // Check if demo connection already exists (by id or isDemo flag)
            const existingDemo = loadedConnections.find(
              c => c.id === demoConn.id || (c.isDemo && c.type === 'postgres')
            );

            if (existingDemo) {
              // Update existing demo connection (credentials may have changed)
              console.log(`${LOG_PREFIX} Updating existing demo connection:`, {
                id: existingDemo.id,
                name: demoConn.name,
              });
              const updatedDemo = { ...demoConn, id: existingDemo.id };
              storage.saveConnection(updatedDemo);
              const updatedConnections = storage.getConnections();
              setConnections(updatedConnections);

              // If demo was active, update reference
              if (loadedConnections.length > 0) {
                setActiveConnection(updatedConnections[0]);
              }
            } else {
              // Add new demo connection
              console.log(`${LOG_PREFIX} Adding new demo connection:`, {
                id: demoConn.id,
                name: demoConn.name,
                database: demoConn.database,
              });
              storage.saveConnection(demoConn);
              const updatedConnections = storage.getConnections();
              setConnections(updatedConnections);

              // Set demo as active if no other connections
              if (loadedConnections.length === 0) {
                console.log(`${LOG_PREFIX} Auto-selecting demo as active connection (no other connections)`);
                setActiveConnection(demoConn);
              } else {
                setActiveConnection(updatedConnections[0]);
              }
            }
            return;
          } else {
            console.log(`${LOG_PREFIX} Demo connection not enabled or not configured`);
          }
        } else {
          console.warn(`${LOG_PREFIX} API returned non-ok status:`, res.status);
        }
      } catch (error) {
        console.error(`${LOG_PREFIX} Failed to fetch demo connection:`, error);
      }

      setConnections(loadedConnections);
      if (loadedConnections.length > 0) setActiveConnection(loadedConnections[0]);
    };

    initializeConnections();
  }, []);

  useEffect(() => {
    if (activeConnection) {
      setTransactionActive(false); // Reset transaction state on connection change
      setPlaygroundMode(false);
      setEditingEnabled(false);
      setPendingChanges([]);
      fetchSchema(activeConnection);
      const isDemo = activeConnection.isDemo || activeConnection.type === 'demo';
      const tabType = metadata?.capabilities.queryLanguage === 'json' ? 'mongodb' :
                      activeConnection.type === 'redis' ? 'redis' : 'sql';
      setTabs(prev => prev.map((t, index) => {
        // For demo connection: update first tab with showcase query if it has default content
        const hasDefaultQuery = t.query === '-- Start typing your SQL query here\n' ||
                                t.query.startsWith('-- Start typing');
        const shouldUpdateWithShowcase = isDemo && index === 0 && hasDefaultQuery;

        return {
          ...t,
          type: tabType,
          ...(shouldUpdateWithShowcase ? { query: getRandomShowcaseQuery() } : {})
        };
      }));
    } else {
      setSchema([]);
    }
  }, [activeConnection, fetchSchema, metadata]);

  const handleTableClick = (tableName: string) => {
    const capabilities = metadata?.capabilities;
    const newQuery = capabilities
      ? generateTableQuery(tableName, capabilities)
      : `SELECT * FROM ${tableName} LIMIT 50;`;

    const newId = Math.random().toString(36).substring(7);
    const newTab: QueryTab = {
      id: newId,
      name: tableName,
      query: newQuery,
      result: null,
      isExecuting: false,
      type: capabilities?.queryLanguage === 'json' ? 'mongodb' : 'sql'
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newId);
    setTimeout(() => executeQuery(newQuery, newId), 100);
  };

  const handleGenerateSelect = (tableName: string) => {
    const capabilities = metadata?.capabilities;
    const table = schema.find(t => t.name === tableName);
    const columns = table?.columns || [];

    const newQuery = capabilities
      ? generateSelectQuery(tableName, columns, capabilities)
      : `SELECT\n${columns.map(c => `  ${c.name}`).join(',\n') || '  *'}\nFROM ${tableName}\nWHERE 1=1\nLIMIT 100;`;

    const tabType: 'sql' | 'mongodb' | 'redis' = capabilities?.queryLanguage === 'json' ? 'mongodb' : 'sql';

    const newId = Math.random().toString(36).substring(7);
    setTabs(prev => [...prev, {
      id: newId,
      name: `Query: ${tableName}`,
      query: newQuery,
      result: null,
      isExecuting: false,
      type: tabType
    }]);
    setActiveTabId(newId);
    setActiveView('editor');
  };

  return (
    <div className="flex h-screen w-full bg-[#050505] text-zinc-100 overflow-hidden font-sans select-none">
      <ResizablePanelGroup direction="horizontal" className="h-full">
        <ResizablePanel defaultSize={22} minSize={15} maxSize={35} className="hidden md:block">
          <Sidebar
            connections={connections}
            activeConnection={activeConnection}
            schema={schema}
            isLoadingSchema={isLoadingSchema}
            onSelectConnection={setActiveConnection}
            onDeleteConnection={(id) => {
              storage.deleteConnection(id);
              const updated = storage.getConnections();
              setConnections(updated);
              if (activeConnection?.id === id) setActiveConnection(updated[0] || null);
            }}
            onEditConnection={(conn) => {
              setEditingConnection(conn);
              setIsConnectionModalOpen(true);
            }}
            onAddConnection={() => setIsConnectionModalOpen(true)}
            onTableClick={handleTableClick}
            onGenerateSelect={handleGenerateSelect}
            onCreateTableClick={() => setIsCreateTableModalOpen(true)}
            onShowDiagram={() => setShowDiagram(true)}
            isAdmin={isAdmin}
            onOpenMaintenance={openMaintenance}
            databaseType={activeConnection?.type}
            metadata={metadata}
            onProfileTable={(name) => setProfilerTable(name)}
            onGenerateCode={(name) => setCodeGenTable(name)}
            onGenerateTestData={(name) => setTestDataTable(name)}
          />
        </ResizablePanel>
        <ResizableHandle className="hidden md:flex w-1 bg-transparent hover:bg-blue-500/30 transition-colors" />
        <ResizablePanel defaultSize={78}>
          <div className="flex-1 flex flex-col min-w-0 h-full bg-[#0a0a0a] pb-16 md:pb-0">
        {/* Mobile Header - Two Row Compact Design */}
        <header className="md:hidden border-b border-white/5 bg-[#0a0a0a]/95 backdrop-blur-xl sticky top-0 z-30">
          {/* Row 1: DB Selector + Connection Info + User */}
          <div className="h-12 flex items-center justify-between px-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {/* DB Selector Dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 gap-1 bg-[#111] border-white/10 hover:bg-white/5 text-zinc-300 max-w-[160px]"
                  >
                    <Database className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                    <span className="truncate text-xs font-medium">
                      {activeConnection ? activeConnection.name : 'Select DB'}
                    </span>
                    <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64 bg-[#0d0d0d] border-white/10">
                  {connections.length === 0 ? (
                    <DropdownMenuItem
                      onClick={() => setIsConnectionModalOpen(true)}
                      className="text-zinc-400 cursor-pointer"
                    >
                      <Plus className="w-4 h-4 mr-2" /> Add Connection
                    </DropdownMenuItem>
                  ) : (
                    <>
                      {connections.map((conn) => (
                        <DropdownMenuItem
                          key={conn.id}
                          onClick={() => setActiveConnection(conn)}
                          className={cn(
                            "cursor-pointer",
                            activeConnection?.id === conn.id && "bg-blue-600/20 text-blue-400"
                          )}
                        >
                          <Database className="w-4 h-4 mr-2" />
                          <span className="truncate">{conn.name}</span>
                          {activeConnection?.id === conn.id && (
                            <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500" />
                          )}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuItem
                        onClick={() => setIsConnectionModalOpen(true)}
                        className="text-zinc-500 cursor-pointer border-t border-white/5 mt-1"
                      >
                        <Plus className="w-4 h-4 mr-2" /> Add New
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {activeConnection && (
                <span className="text-[10px] text-emerald-500 font-medium px-1.5 py-0.5 rounded bg-emerald-500/10">
                  Online
                </span>
              )}
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-zinc-500 hover:text-purple-400"
                onClick={() => router.push('/monitoring')}
              >
                <Gauge className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-8 w-8 p-0",
                  activeView === 'health' && "bg-emerald-600/20 text-emerald-400"
                )}
                onClick={() => setActiveView(activeView === 'health' ? 'editor' : 'health')}
              >
                <Activity className="w-4 h-4" />
              </Button>
              {user && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                      <User className="w-4 h-4 text-zinc-400" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-[#0d0d0d] border-white/10">
                    <DropdownMenuItem onClick={handleLogout} className="text-red-400 cursor-pointer">
                      <LogOut className="w-4 h-4 mr-2" /> Logout
                    </DropdownMenuItem>
                    <div className="border-t border-white/5 mt-1 pt-1 px-2 pb-1">
                      <span className="text-[10px] text-zinc-500 font-mono">v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {/* Row 2: Actions + RUN (only show when on editor tab) */}
          {activeMobileTab === 'editor' && activeView === 'editor' && (
            <div className="h-10 flex items-center justify-between px-3 border-t border-white/5 bg-[#080808]">
              <div className="flex items-center gap-1">
                {/* AI Assistant Button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 gap-1 text-[10px] font-bold text-zinc-500 hover:text-blue-400"
                  onClick={() => {
                    // Trigger AI in QueryEditor
                    const event = new CustomEvent('toggle-ai-assistant');
                    window.dispatchEvent(event);
                  }}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  AI
                </Button>

                {/* Quick Actions Dropdown */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 px-2 gap-1 text-[10px] text-zinc-500">
                      <MoreVertical className="w-3.5 h-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="bg-[#0d0d0d] border-white/10">
                    <DropdownMenuItem
                      onClick={() => queryEditorRef.current?.format()}
                      className="cursor-pointer text-xs"
                    >
                      <AlignLeft className="w-4 h-4 mr-2" /> Format SQL
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        const query = queryEditorRef.current?.getValue() || currentTab.query;
                        navigator.clipboard.writeText(query);
                      }}
                      className="cursor-pointer text-xs"
                    >
                      <Copy className="w-4 h-4 mr-2" /> Copy Query
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => updateCurrentTab({ query: '' })}
                      className="cursor-pointer text-xs text-red-400"
                    >
                      <Trash2 className="w-4 h-4 mr-2" /> Clear
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setIsSaveQueryModalOpen(true)}
                      className="cursor-pointer text-xs border-t border-white/5 mt-1"
                    >
                      <Save className="w-4 h-4 mr-2" /> Save Query
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {currentTab.isExecuting ? (
                <Button
                  size="sm"
                  className="bg-red-600 hover:bg-red-500 text-white font-bold text-[11px] h-7 px-4 gap-1.5"
                  onClick={cancelQuery}
                >
                  <Square className="w-3 h-3 fill-current" />
                  CANCEL
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-500 text-white font-bold text-[11px] h-7 px-4 gap-1.5"
                  onClick={() => executeQuery()}
                  disabled={!activeConnection}
                >
                  <Play className="w-3 h-3 fill-current" />
                  RUN
                </Button>
              )}
            </div>
          )}
        </header>

        {/* Desktop Header */}
        <header className="hidden md:flex h-14 border-b border-white/5 items-center justify-between px-4 bg-[#0a0a0a]/80 backdrop-blur-xl sticky top-0 z-30">
          <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <Database className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight text-zinc-200 truncate max-w-[120px]">
                {activeConnection ? activeConnection.name : 'Quick Access'}
              </h1>
              {activeConnection && (
                <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest leading-none mt-0.5">
                  {activeConnection.type}
                  {activeConnection.environment && activeConnection.environment !== 'other' && (
                    <span
                      className="ml-1 font-bold"
                      style={{ color: activeConnection.color || '#22c55e' }}
                    >
                      • {activeConnection.environment}
                    </span>
                  )}
                  {!activeConnection.environment && (
                    <span> • <span className="text-emerald-500/80">Online</span></span>
                  )}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center bg-white/5 rounded-lg p-1 mr-2">
              <Button
                variant="ghost"
                size="sm"
                className={cn("h-7 px-3 text-[10px] font-bold uppercase tracking-widest gap-2", activeView === 'editor' ? "bg-blue-600 text-white" : "text-zinc-500")}
                onClick={() => setActiveView('editor')}
              >
                <Terminal className="w-3 h-3" /> Editor
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn("h-7 px-3 text-[10px] font-bold uppercase tracking-widest gap-2", activeView === 'health' ? "bg-emerald-600 text-white" : "text-zinc-500")}
                onClick={() => setActiveView('health')}
              >
                <Activity className="w-3 h-3" /> Health
              </Button>
            </div>

            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-3 text-[10px] font-bold uppercase tracking-widest gap-2 text-zinc-500 hover:text-purple-400 hover:bg-purple-500/10"
              onClick={() => router.push('/monitoring')}
            >
              <Gauge className="w-3 h-3" /> Monitoring
            </Button>

            {user && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 gap-2 hover:bg-white/5 px-2">
                    <User className="w-3.5 h-3.5 text-blue-400" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 bg-[#0d0d0d] border-white/10 text-zinc-300">
                  <DropdownMenuItem onClick={handleLogout} className="text-red-400 cursor-pointer">
                    <LogOut className="w-4 h-4 mr-2" /> Logout
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Settings className="w-4 h-4 text-zinc-400 cursor-pointer hover:text-white transition-colors mx-2" />
            <span className="text-[10px] text-zinc-500 font-mono">
              v{process.env.NEXT_PUBLIC_APP_VERSION}
            </span>
          </div>
        </header>

        <div className="hidden md:flex h-10 bg-[#0d0d0d] border-b border-white/5 items-center px-2 gap-1 overflow-x-auto no-scrollbar">
          {tabs.map(tab => (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              onDoubleClick={() => {
                setEditingTabId(tab.id);
                setEditingTabName(tab.name);
              }}
              className={cn(
                "h-8 flex items-center px-3 gap-2 rounded-t-md transition-all cursor-pointer min-w-[120px] max-w-[200px] group relative border-t-2",
                activeTabId === tab.id ? "bg-[#141414] text-zinc-100 border-blue-500" : "text-zinc-500 hover:bg-white/5 border-transparent"
              )}
            >
              {tab.type === 'sql' ? <Hash className="w-3 h-3" /> : <FileJson className="w-3 h-3" />}
              {editingTabId === tab.id ? (
                <input
                  autoFocus
                  value={editingTabName}
                  onChange={(e) => setEditingTabName(e.target.value)}
                  onBlur={() => {
                    if (editingTabName.trim()) {
                      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, name: editingTabName.trim() } : t));
                    }
                    setEditingTabId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (editingTabName.trim()) {
                        setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, name: editingTabName.trim() } : t));
                      }
                      setEditingTabId(null);
                    } else if (e.key === 'Escape') {
                      setEditingTabId(null);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs font-medium bg-transparent border-b border-blue-500 outline-none w-full text-zinc-100"
                />
              ) : (
                <span className="text-xs truncate font-medium">{tab.name}</span>
              )}
              {tabs.length > 1 && <X className="w-3 h-3 ml-auto opacity-0 group-hover:opacity-100 hover:text-white shrink-0" onClick={(e) => closeTab(tab.id, e)} />}
            </div>
          ))}
          <Plus className="w-4 h-4 text-zinc-500 cursor-pointer hover:text-white mx-2" onClick={addTab} />
        </div>

        <main className="flex-1 overflow-hidden relative">
          <AnimatePresence>
            {showDiagram && (
              <SchemaDiagram schema={schema} onClose={() => setShowDiagram(false)} />
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
                connections={connections}
                activeConnection={activeConnection}
                onSelectConnection={(conn) => {
                  setActiveConnection(conn);
                  setActiveMobileTab('editor');
                }}
                onDeleteConnection={(id) => {
                  storage.deleteConnection(id);
                  const updated = storage.getConnections();
                  setConnections(updated);
                  if (activeConnection?.id === id) setActiveConnection(updated[0] || null);
                }}
                onAddConnection={() => setIsConnectionModalOpen(true)}
              />
            </div>
          )}

          {/* Mobile: Schema Tab */}
          {activeMobileTab === 'schema' && (
            <div className="md:hidden h-full bg-[#080808] overflow-auto p-4">
              {activeConnection ? (
                <SchemaExplorer
                  schema={schema}
                  isLoadingSchema={isLoadingSchema}
                  onTableClick={(tableName) => {
                    handleTableClick(tableName);
                    setActiveMobileTab('editor');
                  }}
                  onGenerateSelect={(tableName) => {
                    handleGenerateSelect(tableName);
                    setActiveMobileTab('editor');
                  }}
                  onCreateTableClick={() => setIsCreateTableModalOpen(true)}
                  isAdmin={isAdmin}
                  onOpenMaintenance={openMaintenance}
                  databaseType={activeConnection?.type}
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
          {activeView === 'health' ? (
            <HealthDashboard connection={activeConnection} />
          ) : (
            <div className="h-full">
              <ResizablePanelGroup direction="vertical">
                <ResizablePanel defaultSize={40} minSize={20}>
                  <div className="h-full flex flex-col">
                      {/* Playground Mode Banner */}
                      {playgroundMode && (
                        <div className="hidden md:flex items-center justify-center gap-2 px-4 py-1 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-400">
                          <FlaskConical className="w-3 h-3" />
                          <span className="text-[10px] font-bold uppercase tracking-widest">
                            Sandbox Mode — All changes will be auto-rolled back
                          </span>
                        </div>
                      )}

                      {/* Desktop Query Toolbar - Hidden on mobile (actions in mobile header) */}
                      <div className="hidden md:flex items-center justify-between px-4 py-1.5 bg-[#0a0a0a] border-b border-white/5">
                        <div className="flex items-center gap-4">
                          <div className="flex items-center gap-2 px-2 py-0.5 rounded bg-blue-500/5 border border-blue-500/10">
                            <Terminal className="w-3 h-3 text-blue-400" />
                            <span className="text-[10px] font-bold text-blue-400 uppercase tracking-widest">Query</span>
                          </div>
                          <div className="h-4 w-px bg-white/5" />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-[10px] font-bold uppercase tracking-widest text-zinc-500 hover:text-white gap-2"
                            onClick={() => setIsSaveQueryModalOpen(true)}
                          >
                            <Save className="w-3 h-3" /> Save
                          </Button>
                        </div>
                        {currentTab.isExecuting ? (
                          <Button
                            size="sm"
                            className="bg-red-600 hover:bg-red-500 text-white font-bold text-[11px] h-7 px-4 gap-2"
                            onClick={cancelQuery}
                          >
                            <Square className="w-3 h-3 fill-current" />
                            CANCEL
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            className="bg-blue-600 hover:bg-blue-500 text-white font-bold text-[11px] h-7 px-4 gap-2"
                            onClick={() => executeQuery()}
                            disabled={!activeConnection}
                          >
                            <Play className="w-3 h-3 fill-current" />
                            RUN
                          </Button>
                        )}

                        {/* Transaction Controls + Playground + Import + Edit */}
                        {activeConnection && metadata?.capabilities.queryLanguage === 'sql' && (
                          <div className="flex items-center gap-1 ml-2 pl-2 border-l border-white/10">
                            {transactionActive ? (
                              <>
                                <span className="text-[9px] font-bold text-amber-400 uppercase tracking-wider px-1.5 py-0.5 bg-amber-500/10 rounded border border-amber-500/20 mr-1">
                                  TXN
                                </span>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-[10px] font-bold text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 gap-1"
                                  onClick={() => handleTransaction('commit')}
                                >
                                  COMMIT
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-[10px] font-bold text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-1"
                                  onClick={() => handleTransaction('rollback')}
                                >
                                  ROLLBACK
                                </Button>
                              </>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-[10px] font-bold uppercase tracking-widest text-zinc-500 hover:text-white gap-1"
                                onClick={() => handleTransaction('begin')}
                                disabled={playgroundMode}
                              >
                                BEGIN
                              </Button>
                            )}

                            {/* Playground (Sandbox) Toggle */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className={cn(
                                "h-7 text-[10px] font-bold uppercase tracking-widest gap-1",
                                playgroundMode
                                  ? "text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                                  : "text-zinc-500 hover:text-white"
                              )}
                              onClick={() => setPlaygroundMode(!playgroundMode)}
                              disabled={transactionActive}
                              title="Playground mode: queries are auto-rolled back"
                            >
                              <FlaskConical className="w-3 h-3" />
                              {playgroundMode ? 'SANDBOX' : 'SANDBOX'}
                            </Button>

                            {/* Inline Edit Toggle */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className={cn(
                                "h-7 text-[10px] font-bold uppercase tracking-widest gap-1",
                                editingEnabled
                                  ? "text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
                                  : "text-zinc-500 hover:text-white"
                              )}
                              onClick={() => {
                                setEditingEnabled(!editingEnabled);
                                if (editingEnabled) setPendingChanges([]);
                              }}
                              title="Enable inline data editing"
                            >
                              <Pencil className="w-3 h-3" />
                              EDIT
                            </Button>

                            {/* Data Import */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-[10px] font-bold uppercase tracking-widest text-zinc-500 hover:text-white gap-1"
                              onClick={() => setIsImportModalOpen(true)}
                              title="Import data from CSV/JSON"
                            >
                              <Upload className="w-3 h-3" />
                              IMPORT
                            </Button>
                          </div>
                        )}
                      </div>

                    <div className="flex-1 relative">
                      <QueryEditor
                        ref={queryEditorRef}
                        value={currentTab.query}
                        onChange={(val) => updateCurrentTab({ query: val })}
                        onExplain={metadata?.capabilities.supportsExplain ? () => executeQuery(undefined, undefined, true) : undefined}
                        language={currentTab.type === 'mongodb' ? 'json' : 'sql'}
                        tables={tableNames}
                        databaseType={activeConnection?.type}
                        schemaContext={schemaContext}
                        capabilities={metadata?.capabilities}
                      />
                    </div>
                  </div>
                </ResizablePanel>
                  <ResizableHandle className="h-1 bg-white/5 hover:bg-blue-500/20" />
                  <ResizablePanel defaultSize={60} minSize={20}>
                    <div className="h-full flex flex-col bg-[#080808]">
                      <div className="h-9 bg-[#0a0a0a] border-b border-white/5 flex items-center justify-between px-2">
                          <div className="flex items-center h-full gap-1">
                            <button 
                              onClick={() => setBottomPanelMode('results')} 
                              className={cn(
                                "h-full px-3 text-[10px] font-bold uppercase transition-all border-b-2 flex items-center gap-2", 
                                bottomPanelMode === 'results' ? "text-blue-400 border-blue-500 bg-white/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                              )}
                            >
                              <LayoutGrid className="w-3 h-3" /> Results
                            </button>
                            <button 
                              onClick={() => setBottomPanelMode('explain')} 
                              className={cn(
                                "h-full px-3 text-[10px] font-bold uppercase transition-all border-b-2 flex items-center gap-2", 
                                bottomPanelMode === 'explain' ? "text-amber-400 border-amber-500 bg-white/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                              )}
                            >
                              <Zap className="w-3 h-3" /> Explain
                            </button>
                            <button 
                              onClick={() => setBottomPanelMode('history')} 
                              className={cn(
                                "h-full px-3 text-[10px] font-bold uppercase transition-all border-b-2 flex items-center gap-2", 
                                bottomPanelMode === 'history' ? "text-emerald-400 border-emerald-500 bg-white/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                              )}
                            >
                              <Clock className="w-3 h-3" /> History
                            </button>
                            <button
                              onClick={() => setBottomPanelMode('saved')}
                              className={cn(
                                "h-full px-3 text-[10px] font-bold uppercase transition-all border-b-2 flex items-center gap-2",
                                bottomPanelMode === 'saved' ? "text-purple-400 border-purple-500 bg-white/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                              )}
                            >
                              <Bookmark className="w-3 h-3" /> Saved
                            </button>
                            <button
                              onClick={() => setBottomPanelMode('charts')}
                              className={cn(
                                "h-full px-3 text-[10px] font-bold uppercase transition-all border-b-2 flex items-center gap-2",
                                bottomPanelMode === 'charts' ? "text-cyan-400 border-cyan-500 bg-white/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                              )}
                            >
                              <BarChart3 className="w-3 h-3" /> Charts
                            </button>
                            <button
                              onClick={() => { setBottomPanelMode('nl2sql'); setIsNL2SQLOpen(true); }}
                              className={cn(
                                "h-full px-3 text-[10px] font-bold uppercase transition-all border-b-2 flex items-center gap-2",
                                bottomPanelMode === 'nl2sql' ? "text-violet-400 border-violet-500 bg-white/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                              )}
                            >
                              <Sparkles className="w-3 h-3" /> NL2SQL
                            </button>
                            <button
                              onClick={() => setBottomPanelMode('autopilot')}
                              className={cn(
                                "h-full px-3 text-[10px] font-bold uppercase transition-all border-b-2 flex items-center gap-2",
                                bottomPanelMode === 'autopilot' ? "text-cyan-400 border-cyan-500 bg-white/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                              )}
                            >
                              <Zap className="w-3 h-3" /> Autopilot
                            </button>
                            <button
                              onClick={() => setBottomPanelMode('pivot')}
                              className={cn(
                                "h-full px-3 text-[10px] font-bold uppercase transition-all border-b-2 flex items-center gap-2",
                                bottomPanelMode === 'pivot' ? "text-orange-400 border-orange-500 bg-white/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                              )}
                            >
                              <Columns3 className="w-3 h-3" /> Pivot
                            </button>
                            <button
                              onClick={() => setBottomPanelMode('docs')}
                              className={cn(
                                "h-full px-3 text-[10px] font-bold uppercase transition-all border-b-2 flex items-center gap-2",
                                bottomPanelMode === 'docs' ? "text-teal-400 border-teal-500 bg-white/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                              )}
                            >
                              <FileText className="w-3 h-3" /> Docs
                            </button>
                            <button
                              onClick={() => setBottomPanelMode('schemadiff')}
                              className={cn(
                                "h-full px-3 text-[10px] font-bold uppercase transition-all border-b-2 flex items-center gap-2",
                                bottomPanelMode === 'schemadiff' ? "text-rose-400 border-rose-500 bg-white/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                              )}
                            >
                              <GitCompare className="w-3 h-3" /> Diff
                            </button>
                            <button
                              onClick={() => setBottomPanelMode('dashboard')}
                              className={cn(
                                "h-full px-3 text-[10px] font-bold uppercase transition-all border-b-2 flex items-center gap-2",
                                bottomPanelMode === 'dashboard' ? "text-indigo-400 border-indigo-500 bg-white/5" : "text-zinc-500 border-transparent hover:text-zinc-300"
                              )}
                            >
                              <LayoutDashboard className="w-3 h-3" /> Dashboard
                            </button>
                          </div>

                          {currentTab.result && bottomPanelMode === 'results' && (
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] font-mono text-zinc-500 mr-2">
                                {currentTab.result.rowCount} rows • {currentTab.result.executionTime}ms
                              </span>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="sm" className="h-7 text-[10px] font-bold uppercase text-zinc-500 hover:text-white gap-2">
                                    <Download className="w-3 h-3" /> Export
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="bg-[#0d0d0d] border-white/10 text-zinc-300">
                                  <DropdownMenuItem onClick={() => exportResults('csv')} className="text-xs cursor-pointer">
                                    Export as CSV
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => exportResults('json')} className="text-xs cursor-pointer">
                                    Export as JSON
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => exportResults('sql-insert')} className="text-xs cursor-pointer">
                                    Export as SQL INSERT
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => exportResults('sql-ddl')} className="text-xs cursor-pointer">
                                    Export as DDL (CREATE TABLE)
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          )}
                        </div>

                        <div className="flex-1 overflow-hidden relative">
                          {bottomPanelMode === 'nl2sql' ? (
                            <NL2SQLPanel
                              isOpen={isNL2SQLOpen}
                              onClose={() => { setIsNL2SQLOpen(false); setBottomPanelMode('results'); }}
                              onExecuteQuery={(q) => executeQuery(q)}
                              onLoadQuery={(q) => { updateCurrentTab({ query: q }); setBottomPanelMode('results'); }}
                              schemaContext={schemaContext}
                              databaseType={activeConnection?.type}
                              queryLanguage={metadata?.capabilities.queryLanguage}
                            />
                          ) : bottomPanelMode === 'autopilot' ? (
                            <AIAutopilotPanel
                              connection={activeConnection}
                              schemaContext={schemaContext}
                              onExecuteQuery={(q) => executeQuery(q)}
                            />
                          ) : bottomPanelMode === 'pivot' ? (
                            <PivotTable
                              result={currentTab.result}
                              onLoadQuery={(q) => { updateCurrentTab({ query: q }); setBottomPanelMode('results'); }}
                            />
                          ) : bottomPanelMode === 'docs' ? (
                            <DatabaseDocs
                              schema={schema}
                              schemaContext={schemaContext}
                              databaseType={activeConnection?.type}
                            />
                          ) : bottomPanelMode === 'history' ? (
                            <QueryHistory
                              refreshTrigger={historyKey}
                              activeConnectionId={activeConnection?.id}
                              onSelectQuery={(q) => {
                                updateCurrentTab({ query: q });
                                setBottomPanelMode('results');
                              }}
                            />
                          ) : bottomPanelMode === 'saved' ? (
                            <SavedQueries
                              refreshTrigger={savedKey}
                              connectionType={activeConnection?.type}
                              onSelectQuery={(q) => {
                                updateCurrentTab({ query: q });
                                setBottomPanelMode('results');
                              }}
                            />
                          ) : bottomPanelMode === 'charts' ? (
                            <DataCharts result={currentTab.result} />
                          ) : bottomPanelMode === 'schemadiff' ? (
                            <SchemaDiff schema={schema} connection={activeConnection} />
                          ) : bottomPanelMode === 'dashboard' ? (
                            <ChartDashboardLazy result={currentTab.result} />
                          ) : currentTab.result ? (
                            bottomPanelMode === 'explain' ? (
                              <VisualExplain
                                plan={currentTab.explainPlan as ExplainPlanResult[] | null | undefined}
                                query={currentTab.query}
                                schemaContext={schemaContext}
                                databaseType={activeConnection?.type}
                                onLoadQuery={(q) => {
                                  updateCurrentTab({ query: q });
                                  setBottomPanelMode('results');
                                }}
                              />
                            ) : (
                              <ResultsGrid
                                result={currentTab.result}
                                onLoadMore={
                                  currentTab.result.pagination?.hasMore
                                    ? handleLoadMore
                                    : undefined
                                }
                                isLoadingMore={currentTab.isLoadingMore}
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
                                editingEnabled={editingEnabled}
                                pendingChanges={pendingChanges}
                                onCellChange={handleCellChange}
                                onApplyChanges={handleApplyChanges}
                                onDiscardChanges={handleDiscardChanges}
                              />
                            )
                          ) : (
                          <div className="h-full flex flex-col items-center justify-center opacity-20 bg-[#0a0a0a]">
                            <Terminal className="w-12 h-12 mb-4" />
                            <p className="text-sm font-medium">Execute a query or check history</p>
                            <p className="text-[10px] uppercase tracking-widest mt-2">Ready to query</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
              </div>
            )}
          </div>
          </main>
        </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <ConnectionModal
        isOpen={isConnectionModalOpen}
        onClose={() => {
          setIsConnectionModalOpen(false);
          setEditingConnection(null);
        }}
        onConnect={(conn) => {
          storage.saveConnection(conn);
          setConnections(storage.getConnections());
          setActiveConnection(conn);
          setIsConnectionModalOpen(false);
          setEditingConnection(null);
        }}
        editConnection={editingConnection}
      />
      <CreateTableModal
        isOpen={isCreateTableModalOpen}
        onClose={() => setIsCreateTableModalOpen(false)}
        onTableCreated={(sql) => executeQuery(sql)}
        dbType={activeConnection?.type}
      />
      <SaveQueryModal 
        isOpen={isSaveQueryModalOpen}
        onClose={() => setIsSaveQueryModalOpen(false)}
        onSave={handleSaveQuery}
        defaultQuery={currentTab.query}
      />
      <MaintenanceModal
        isOpen={isMaintenanceModalOpen}
        onClose={() => setIsMaintenanceModalOpen(false)}
        connection={activeConnection}
        tables={schema}
        initialTab={maintenanceInitialTab}
        targetTable={maintenanceTargetTable}
        metadata={metadata}
      />
      <DataImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImport={(sql) => executeQuery(sql)}
        tables={schema}
        databaseType={activeConnection?.type}
      />
      <QuerySafetyDialog
        isOpen={!!safetyCheckQuery}
        query={safetyCheckQuery || ''}
        schemaContext={schemaContext}
        databaseType={activeConnection?.type}
        onClose={() => setSafetyCheckQuery(null)}
        onProceed={() => {
          if (safetyCheckQuery) forceExecuteQuery(safetyCheckQuery);
        }}
      />
      <DataProfiler
        isOpen={!!profilerTable}
        onClose={() => setProfilerTable(null)}
        tableName={profilerTable || ''}
        tableSchema={schema.find(t => t.name === profilerTable) || null}
        connection={activeConnection}
        schemaContext={schemaContext}
        databaseType={activeConnection?.type}
      />
      <CodeGenerator
        isOpen={!!codeGenTable}
        onClose={() => setCodeGenTable(null)}
        tableName={codeGenTable || ''}
        tableSchema={schema.find(t => t.name === codeGenTable) || null}
        databaseType={activeConnection?.type}
      />
      <TestDataGenerator
        isOpen={!!testDataTable}
        onClose={() => setTestDataTable(null)}
        tableName={testDataTable || ''}
        tableSchema={schema.find(t => t.name === testDataTable) || null}
        databaseType={activeConnection?.type}
        queryLanguage={metadata?.capabilities.queryLanguage}
        onExecuteQuery={(q) => executeQuery(q)}
      />

      {/* Unlimited Query Warning Modal (for Load All button) */}
      <AlertDialog open={unlimitedWarningOpen} onOpenChange={setUnlimitedWarningOpen}>
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
              onClick={handleUnlimitedQuery}
              className="flex-1 h-9 bg-amber-600 border-0 text-white text-[13px] font-medium hover:bg-amber-500"
            >
              Load All
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <CommandPalette
        connections={connections}
        activeConnection={activeConnection}
        schema={schema}
        onSelectConnection={setActiveConnection}
        onTableClick={handleTableClick}
        onAddConnection={() => setIsConnectionModalOpen(true)}
        onExecuteQuery={() => executeQuery()}
        onLoadSavedQuery={(q) => {
          updateCurrentTab({ query: q });
          setBottomPanelMode('results');
        }}
        onLoadHistoryQuery={(q) => {
          updateCurrentTab({ query: q });
          setBottomPanelMode('results');
        }}
        onNavigateHealth={() => setActiveView('health')}
        onNavigateMonitoring={() => router.push('/monitoring')}
        onShowDiagram={() => setShowDiagram(true)}
        onFormatQuery={() => queryEditorRef.current?.format()}
        onSaveQuery={() => setIsSaveQueryModalOpen(true)}
        onToggleAI={() => window.dispatchEvent(new CustomEvent('toggle-ai-assistant'))}
        onLogout={handleLogout}
      />

      <MobileNav
        activeTab={activeMobileTab}
        onTabChange={setActiveMobileTab}
        hasResult={!!currentTab.result}
      />
    </div>
  );
}