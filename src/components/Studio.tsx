"use client";

import React, { useState, useEffect, useRef } from "react";
import { Sidebar, ConnectionsList } from "@/components/sidebar";
import { MobileNav } from "@/components/MobileNav";
import { SchemaExplorer } from "@/components/schema-explorer";
import { ConnectionModal } from "@/components/ConnectionModal";
import { CommandPalette } from "@/components/CommandPalette";
import { QueryEditor, QueryEditorRef } from "@/components/QueryEditor";
import { DataImportModal } from "@/components/DataImportModal";
import { QuerySafetyDialog } from "@/components/QuerySafetyDialog";
import { DataProfiler } from "@/components/DataProfiler";
import { CodeGenerator } from "@/components/CodeGenerator";
import { TestDataGenerator } from "@/components/TestDataGenerator";
import { CreateTableModal } from "@/components/CreateTableModal";
import { SaveQueryModal } from "@/components/SaveQueryModal";
import {
  StudioMobileHeader,
  StudioDesktopHeader,
  StudioTabBar,
  QueryToolbar,
  BottomPanel,
} from "@/components/studio/index";
import { AgentRail } from "@/components/agent/AgentRail";
import { DatabaseConnection, SavedQuery } from "@/lib/types";
import { ChunkBoundary, ViewLoading } from "@/components/LazyView";
import { lazyRetry } from "@/lib/lazy";
import { editorLanguageForTabType, resolveTabType } from "@/lib/editor/tab-language";
import {
  buildResultExport,
  FALLBACK_TABLE_NAME,
  resultExportFileName,
  type ResultExportFormat,
} from "@/lib/export/result-export";
import { downloadText } from "@/lib/export/download";
import { newLocalId } from "@/lib/ids";
import { resolveAgentRunConnectionId } from "@/hooks/use-connection-payload";
import { isMobileViewport, useIsMobile } from "@/hooks/use-mobile";
import { useAgentCapability } from "@/hooks/use-agent-capability";
import type { AgentArtifactHydration } from "@/components/agent/hydration";
import { useAgentArtifact } from "@/components/agent/use-agent-artifact";
import { useAgentPrefill } from "@/components/agent/use-agent-prefill";
import { useToast } from "@/hooks/use-toast";
import { useProviderMetadata } from "@/hooks/use-provider-metadata";
import { useAuth } from "@/hooks/use-auth";
import { useConnectionManager } from "@/hooks/use-connection-manager";
import { useTabManager } from "@/hooks/use-tab-manager";
import { useTransactionControl } from "@/hooks/use-transaction-control";
import { useQueryExecution } from "@/hooks/use-query-execution";
import { useInlineEditing } from "@/hooks/use-inline-editing";
import { useStorageSync } from "@/hooks/use-storage-sync";
import { storage } from "@/lib/storage";
import {
  type MaskingConfig,
  loadMaskingConfig,
  saveMaskingConfig,
  shouldMask,
  canToggleMasking,
  detectSensitiveColumnsFromConfig,
  applyMaskingToRows,
} from "@/lib/data-masking";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { TriangleAlert, Database, Plus } from "lucide-react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/*
  The ERD, split out of the first load.

  It is the largest thing in this tree — `@xyflow/react`, the elk layout engine and the
  snapdom capture used for its export — and it is mounted only while `showDiagram` is
  true, which for most sessions is never. `React.lazy`, not `next/dynamic`, to keep the
  same seam the bottom panel uses; the diagram is reached from the embeddable shell too.
*/
const SchemaDiagram = React.lazy(
  lazyRetry(() => import("@/components/SchemaDiagram").then((m) => ({ default: m.SchemaDiagram }))),
);

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

  // Inline row editing is offered only where the provider declares the row-update
  // statement it needs (issue #269). Unknown hides it, like Explain below: metadata
  // is also null when /api/db/provider-meta fails, and offering a control that can
  // only error is the defect this gate exists to fix.
  const canEditRows = metadata?.capabilities.supportsInlineRowEdit === true;
  const editingEnabled = canEditRows && editing.editingEnabled;
  const onToggleEditing = canEditRows
    ? () => {
        editing.setEditingEnabled(!editing.editingEnabled);
        if (editing.editingEnabled) editing.handleDiscardChanges();
      }
    : undefined;

  // The transaction trio and the sandbox toggle are offered only where the provider
  // declares it holds a transaction session (#U13). The server's gate is
  // `isTransactionProvider(provider)` — a runtime shape check no client can read — so
  // both shells used to supply all four unconditionally and POST /api/db/transaction
  // answered 400 "Transaction control is not supported for this database type"
  // (measured 2026-08-19 on OpenSearch, for both begin and rollback). Unknown hides
  // them, like the row-edit gate above: metadata is also null when
  // /api/db/provider-meta fails.
  //
  // Supplied as one bundle because SANDBOX auto-rolls-back through the same route,
  // and because QueryToolbar's contract is that the three arrive together or not at
  // all.
  const canRunTransactions = metadata?.capabilities.supportsTransactions === true;
  const transactionHandlers = canRunTransactions
    ? {
        onBeginTransaction: () => txn.handleTransaction("begin"),
        onCommitTransaction: () => txn.handleTransaction("commit"),
        onRollbackTransaction: () => txn.handleTransaction("rollback"),
        onTogglePlayground: () => txn.setPlaygroundMode(!txn.playgroundMode),
      }
    : {};

  // === Cross-hook orchestration: connection-change effect ===
  useEffect(() => {
    if (conn.activeConnection) {
      txn.resetTransactionState();
      editing.setEditingEnabled(false);
      editing.handleDiscardChanges();
      conn.fetchSchema(conn.activeConnection);
      const tabType = resolveTabType(metadata?.capabilities);
      tabMgr.setTabs((prev) =>
        prev.map((t) => {
          return {
            ...t,
            type: tabType,
          };
        }),
      );
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
  const [activeMobileTab, setActiveMobileTab] = useState<"database" | "schema" | "editor">("editor");
  /** What the panel group may hold: below the breakpoint, only the body panel. */
  const isMobile = useIsMobile();
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [profilerTable, setProfilerTable] = useState<string | null>(null);
  const [codeGenTable, setCodeGenTable] = useState<string | null>(null);
  const [testDataTable, setTestDataTable] = useState<string | null>(null);

  // === Agent rail (#329 T10a) ===
  // Server-side flag, discovered at runtime the way the storage mode is: the pages
  // are statically prerendered, so a build-time read would answer for the build
  // rather than for the operator's container. Off (and absent) until it answers.
  const agentEnabled = useAgentCapability();
  const [isAgentSheetOpen, setIsAgentSheetOpen] = useState(false);

  /*
    The prefill seam (#331 T1). The shell owns the ask because a shortcut can be
    anywhere in the shell — the command palette, the mobile header, a bottom-panel tab —
    while the rail is ONE instance behind both of its presentations; the rail applies it
    as a prop, the direction `isAgentSheetOpen` already runs in. T2 and T3 hand
    `agentPrefill.requestPrefill` to those entry points; a prefill fills the rail and
    starts nothing when they do.
  */
  const agentPrefill = useAgentPrefill();

  // Artifact hydration (#329 T11). The rail cites what a run stored; showing it puts
  // the rows into the bottom panel that already renders rows, and applying a drafted
  // statement puts it into the editor that already holds statements. There is no
  // second grid, no second chart component and no second editor. Which surface opens
  // is the hydration's answer, and it comes from what the run recorded — the operation
  // for a read or a plan, the composed answer for a chart — never from the shape of
  // the rows.
  //
  // HYDRATION happens on a user action — a click on a citation. The HAND-OVER below
  // does not, and this comment used to claim otherwise. The rail's handover effect
  // calls `onApplyStatement` (for `handover: "applied"`) and `onRunStatement` (for
  // `"auto-executed"`) from a `useEffect` over ledger entries, so an auto-execute run
  // writes `currentTab.query` with no click at that moment. The consent was given
  // once, when the run was opened with the checkbox ticked, and it is the whole of
  // what makes this acceptable — so anything added here that would lose unsaved
  // editor content must guard it rather than trusting a click to have happened.
  const agentArtifact = useAgentArtifact({
    explainFormat: metadata?.capabilities.explainFormat,
    onShown: (surface) => queryExec.setBottomPanelMode(surface),
    onError: (message) => toast({ title: "The agent result could not be shown", description: message }),
  });

  /*
    A hydrated artifact is a view of what a RUN produced, so the user's own work takes
    the panel back: a new result on this tab, a new plan on it, or a different tab
    altogether ends the view.

    Keyed on the identity of what a run PRODUCES rather than on the calls that produce
    it, because the paths that execute a statement — the toolbar, the command palette,
    an import, a generated statement — are many and wrapping them one at a time would
    miss one. Both outputs are watched because they are written separately: an explain
    run stores a plan and deliberately leaves `result` untouched
    (`use-query-execution.ts`), so a tab whose result is still null would otherwise
    keep showing the run's plan after the user asked for their own.
  */
  const agentArtifactDismiss = agentArtifact.dismiss;
  useEffect(() => {
    agentArtifactDismiss();
  }, [tabMgr.activeTabId, tabMgr.currentTab.result, tabMgr.currentTab.explainPlan, agentArtifactDismiss]);

  // A run persists a connection ID and no credential, so the process that resumes it
  // re-resolves the connection server-side. Only a connection the server can rebuild
  // to the SAME database has an id that survives that, which is why anything else
  // reaches the rail as null: the rail says why instead of posting a request the route
  // could only refuse — or, worse, accept while meaning a different database.
  const agentConnectionId =
    conn.activeConnection === null ? null : resolveAgentRunConnectionId(conn.activeConnection, conn.servedSeeds);

  /*
    What the two standalone AI entry points do now (#331 T3). The in-editor chat is
    gone; the command palette's item and the mobile header's button open the RAIL on
    the statement the editor is holding. Both go through this one handler, because a
    decision made at each caller is a decision made twice.

    The workflow is INVESTIGATION, not query-optimization, and that is deliberate.
    The control being replaced was a general assistant, not an optimizer, so choosing
    the optimizer would commit the user to a goal they never asked for: that
    workflow's verifier requires the run to PROPOSE a change and back it with a plan
    it read — a comparison, or an index citing the plan it diagnosed
    (`src/lib/agent/goal-verifier.ts`) — and a run that perfectly explained what the
    statement does proposes nothing, so it would still be recorded as "did not
    answer". The workflow control is one click away in the rail, and investigation is
    the general one.

    The objective is the statement and nothing composed around it. Writing prose like
    "why is this slow?" on the user's behalf would put words in a box that is theirs
    and stays editable. It is read from the tab this shell already owns rather than
    from the editor handle: `QueryEditor`'s `onContentChange` writes every keystroke
    into that tab through `updateTabById` (see the mount below), and `use-tab-manager`
    derives `currentTab` from the tabs it writes to — so the tab is current, and
    `getEditorValue` was the AI hook's private callback rather than a second source of
    truth. The seam bounds the length; nothing here has to.

    An empty editor mints no ask. An objective saying nothing would still be recorded
    as APPLIED by the rail, so it would clear a standing offer and overwrite nothing
    to no purpose. The entry point still opens the rail — which below `md` means
    opening the sheet here, since the seam only opens it when it has an ask to apply,
    and above `md` means nothing at all: the rail is already the panel, and arming the
    sheet flag there would pop a sheet open the first time the window narrows.
  */
  /*
    The statement is passed as the user wrote it, minus the whitespace around it. That
    trim is not a liberty taken with their text: the rail sends `objective.trim()` when
    Start is pressed, so anything this kept would be dropped a moment later anyway, and
    keeping it would only spend the seam's length budget on blanks. What is deliberately
    NOT done is composing anything around the statement — no "Why is this query slow?"
    written on the user's behalf. Raised in review on #351, where "verbatim" read as a
    promise this makes about bytes rather than about authorship.
  */
  const askAgentAboutStatement = () => {
    const statement = tabMgr.currentTab.query.trim();
    if (statement.length === 0) {
      if (isMobileViewport()) setIsAgentSheetOpen(true);
      return;
    }
    agentPrefill.requestPrefill("investigation", statement);
  };

  // Data Masking
  const [maskingConfig, setMaskingConfig] = useState<MaskingConfig>(() => loadMaskingConfig());
  const effectiveMasking = shouldMask(user?.role, maskingConfig);
  const userCanToggle = canToggleMasking(user?.role, maskingConfig);

  // The Explorer's per-row items call this with the row's name; without carrying it
  // the tab opened with nothing selected (#U5). The name rides the query string —
  // the admin section is routed, so a param is what a section page can read. The
  // non-admin /monitoring route has no such reader, so it keeps the bare path.
  const openMaintenance = (_tab?: "global" | "tables" | "sessions", table?: string) => {
    if (isAdmin) {
      router.push(table ? `/admin/operations?table=${encodeURIComponent(table)}` : "/admin/operations");
    } else {
      router.push("/monitoring");
    }
  };

  const handleSaveQuery = (name: string, description: string, tags: string[]) => {
    if (!conn.activeConnection) return;
    const newSavedQuery: SavedQuery = {
      id: newLocalId(),
      name,
      query: tabMgr.currentTab.query,
      description,
      connectionType: conn.activeConnection.type,
      tags,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    storage.saveQuery(newSavedQuery);
    setSavedKey((prev) => prev + 1);
    toast({ title: "Query Saved", description: `"${name}" has been added to your saved queries.` });
  };

  /**
   * Write what is on screen to a file.
   *
   * `hydrated` is the agent artifact the bottom panel is showing, or null when the
   * tab's own rows are what the user is looking at. It is passed in rather than read
   * back off the tab because the two disagree exactly when it matters (B34): a run's
   * result is hydrated into the grid without touching the tab, so an export that read
   * `currentTab.result` wrote rows nobody was looking at. That is why the menu used to
   * be hidden over a hydrated view instead of retargeted.
   */
  const exportResults = (format: ResultExportFormat, hydrated: AgentArtifactHydration | null = null) => {
    const source = hydrated?.result ?? tabMgr.currentTab.result;
    if (!source) return;
    // The columns the engine declared for THIS result. The writers read every row by
    // these names rather than by whatever keys row 0 happens to carry, so a row with
    // a different key order — or a document store's row missing a field entirely —
    // lands in the right column instead of shifting the rest.
    const fields = source.fields;
    const sensitiveColumns = detectSensitiveColumnsFromConfig(fields, maskingConfig);
    const rows = effectiveMasking ? applyMaskingToRows(source.rows, fields, sensitiveColumns) : source.rows;

    const file = buildResultExport(format, {
      rows,
      fields,
      // A run's rows did not come from this tab, so the SQL forms take the neutral
      // fallback name: naming the tab's table would attribute them to a table that
      // never produced them.
      tabName: hydrated === null ? tabMgr.currentTab.name : FALLBACK_TABLE_NAME,
      dialect: conn.activeConnection?.type,
      // The types the engine declared for THIS result, which is what the DDL form
      // writes when they are there — the only source for a computed column.
      columnTypes: source.columnTypes,
    });
    downloadText(file.content, file.mimeType, resultExportFileName(file.extension, hydrated?.runId));
  };

  const onTableClick = (tableName: string) => {
    tabMgr.handleTableClick(tableName, queryExec.executeQuery);
  };

  const handleDeleteConnection = (id: string) => {
    // Clean up server-side provider cache and close connections/tunnels
    fetch("/api/db/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: id }),
    }).catch(() => {
      /* best-effort cleanup */
    });

    storage.deleteConnection(id);
    // Preserve managed (seed) connections that aren't in localStorage
    const userConns = storage.getConnections();
    const managedConns = conn.connections.filter((c) => c.managed && !userConns.some((uc) => uc.id === c.id));
    const updated = [...managedConns, ...userConns];
    conn.setConnections(updated);
    if (conn.activeConnection?.id === id) conn.setActiveConnection(updated[0] || null);
  };

  /**
   * One rail, two mounts: a panel of the group above the breakpoint, a bare child of
   * the shell below it. Declared once so the two placements cannot drift apart.
   */
  const agentRail = (
    <AgentRail
      connectionId={agentConnectionId}
      connectionName={conn.activeConnection?.name ?? null}
      sheetOpen={isAgentSheetOpen}
      onSheetOpenChange={setIsAgentSheetOpen}
      prefill={agentPrefill.request}
      connectionType={conn.activeConnection?.type ?? null}
      onApplyStatement={(sql) => tabMgr.updateCurrentTab({ query: sql })}
      /*
          The handover a run's answer can record (§2.1): the statement goes
          into the editor AND is run there. Through the hook's own entry point
          rather than `executeQuery`, and the difference is the boundary
          (#373 review): `executeQuery` goes to the editor's read-WRITE route,
          where a `SELECT` calling a VOLATILE function that writes would
          succeed. `executeHandedOverStatement` asks the run's own hand-over
          route instead, which runs the ledger's statement under the engine's
          read-only session at the editor's default row limit and with no
          statement timeout.

          The statement is put in the editor first so the user reads what is
          running while it runs; the RUN is what is sent, because the text the
          server executes is the ledger's, not this component's copy of it.
        */
      onRunStatement={(sql, runId) => {
        tabMgr.updateCurrentTab({ query: sql });
        void queryExec.executeHandedOverStatement(runId, sql);
      }}
      onShowArtifact={agentArtifact.show}
    />
  );

  return (
    <div className="flex h-screen w-full bg-canvas text-fg overflow-hidden font-sans select-none">
      <ResizablePanelGroup id="studio-main" orientation="horizontal" className="h-full">
        {/* A stable `id` is what keeps the layout attached to the right panel once
            a sibling is conditional (the agent rail); it replaces v3's `order`,
            since v4 keys its layout by panel id. Sizes are strings on purpose:
            v4 reads a bare number as pixels and a unitless string as a percentage. */}
        {/*
          Not merely hidden: `react-resizable-panels` 4 puts a `Panel`'s `className`
          on a NESTED div ("Class is applied to nested HTMLDivElement to avoid styles
          that interfere with Flex layout"), so `hidden md:block` hid the sidebar's
          CONTENTS while the panel itself kept its 22% of the row. At 390px that left
          the studio body 211px wide with its own header overlapping. A panel the
          viewport cannot show has to be out of the group, not styled out of sight.
        */}
        {!isMobile && (
          <>
            <ResizablePanel id="studio-sidebar" defaultSize="22" minSize="15" maxSize="35">
              <Sidebar
                connections={conn.connections}
                activeConnection={conn.activeConnection}
                schema={conn.schema}
                isLoadingSchema={conn.isLoadingSchema}
                schemaError={conn.schemaError}
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
            <ResizableHandle className="w-1 bg-transparent hover:bg-blue-500/30 transition-colors" />
          </>
        )}
        <ResizablePanel id="studio-body" defaultSize={agentEnabled ? "54" : "78"}>
          <div className="flex-1 flex flex-col min-w-0 h-full bg-surface pb-16 md:pb-0">
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
              editingEnabled={editingEnabled}
              onSelectConnection={conn.setActiveConnection}
              onAddConnection={() => setIsConnectionModalOpen(true)}
              onLogout={handleLogout}
              onSaveQuery={() => setIsSaveQueryModalOpen(true)}
              onClearQuery={() => tabMgr.updateCurrentTab({ query: "" })}
              onExecuteQuery={() => queryExec.executeQuery()}
              onCancelQuery={() => queryExec.cancelQuery()}
              {...transactionHandlers}
              onToggleEditing={onToggleEditing}
              onImport={() => setIsImportModalOpen(true)}
              onExplain={
                metadata?.capabilities.supportsExplain
                  ? () => queryExec.executeQuery(undefined, undefined, true)
                  : undefined
              }
              // Absent while the runtime is off, so the header carries no control
              // that would open a rail that does not exist.
              onAskAgent={agentEnabled ? askAgentAboutStatement : undefined}
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
                  /*
                    A visible fallback, not `null`: this is the heaviest chunk in the
                    tree (`@xyflow/react` + elk + snapdom), so the wait is the one the
                    user is most likely to see — and a click that shows nothing at all
                    reads as a broken button, which is answered by clicking it again.
                  */
                  <ChunkBoundary label="The diagram">
                    <React.Suspense
                      fallback={<ViewLoading label="Loading the diagram" className="absolute inset-0 z-20" />}
                    >
                      <SchemaDiagram schema={conn.schema} onClose={() => setShowDiagram(false)} />
                    </React.Suspense>
                  </ChunkBoundary>
                )}
              </AnimatePresence>

              {/* Mobile: Database Tab */}
              {activeMobileTab === "database" && (
                <div className="md:hidden h-full bg-sunken overflow-auto p-4">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-xs font-medium text-fg-secondary">Connections</h2>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs border-hairline-strong hover:bg-fill"
                      onClick={() => setIsConnectionModalOpen(true)}
                    >
                      <Plus strokeWidth={1.5} className="w-3 h-3 mr-1" /> Add
                    </Button>
                  </div>
                  <ConnectionsList
                    connections={conn.connections}
                    activeConnection={conn.activeConnection}
                    onSelectConnection={(c) => {
                      conn.setActiveConnection(c);
                      setActiveMobileTab("editor");
                    }}
                    onDeleteConnection={handleDeleteConnection}
                    onAddConnection={() => setIsConnectionModalOpen(true)}
                  />
                </div>
              )}

              {/* Mobile: Schema Tab */}
              {activeMobileTab === "schema" && (
                <div className="md:hidden h-full bg-sunken overflow-auto p-4">
                  {conn.activeConnection ? (
                    <SchemaExplorer
                      schema={conn.schema}
                      isLoadingSchema={conn.isLoadingSchema}
                      schemaError={conn.schemaError}
                      onTableClick={(tableName) => {
                        onTableClick(tableName);
                        setActiveMobileTab("editor");
                      }}
                      onGenerateSelect={(tableName) => {
                        tabMgr.handleGenerateSelect(tableName);
                        setActiveMobileTab("editor");
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
                    <div className="flex flex-col items-center justify-center h-full text-fg-muted">
                      <Database strokeWidth={1.5} className="w-12 h-12 mb-4 opacity-30" />
                      <p className="text-xs">Select a connection first</p>
                    </div>
                  )}
                </div>
              )}

              {/* Desktop & Mobile Editor Tab */}
              <div className={cn("h-full", activeMobileTab !== "editor" && "hidden md:block")}>
                <div className="h-full">
                  <ResizablePanelGroup id="studio-editor" orientation="vertical">
                    <ResizablePanel id="studio-editor-top" defaultSize="40" minSize="20">
                      <div className="h-full flex flex-col">
                        <QueryToolbar
                          activeConnection={conn.activeConnection}
                          metadata={metadata}
                          isExecuting={tabMgr.currentTab.isExecuting}
                          playgroundMode={txn.playgroundMode}
                          transactionActive={txn.transactionActive}
                          editingEnabled={editingEnabled}
                          onSaveQuery={() => setIsSaveQueryModalOpen(true)}
                          onExecuteQuery={() => queryExec.executeQuery()}
                          onCancelQuery={() => queryExec.cancelQuery()}
                          {...transactionHandlers}
                          onToggleEditing={onToggleEditing}
                          onImport={() => setIsImportModalOpen(true)}
                        />

                        <div className="flex-1 relative min-h-0">
                          <QueryEditor
                            ref={queryEditorRef}
                            value={tabMgr.currentTab.query}
                            onContentChange={(val) => tabMgr.updateTabById(tabMgr.currentTab.id, { query: val })}
                            onExplain={
                              metadata?.capabilities.supportsExplain
                                ? () => queryExec.executeQuery(undefined, undefined, true)
                                : undefined
                            }
                            language={editorLanguageForTabType(tabMgr.currentTab.type)}
                            databaseType={conn.activeConnection?.type}
                            schemaContext={conn.schemaContext}
                            capabilities={metadata?.capabilities}
                          />
                        </div>
                      </div>
                    </ResizablePanel>
                    <ResizableHandle className="h-1 bg-fill hover:bg-blue-500/20" />
                    <ResizablePanel id="studio-editor-bottom" defaultSize="60" minSize="20">
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
                        maskingEnabled={effectiveMasking}
                        onToggleMasking={
                          userCanToggle
                            ? () => {
                                setMaskingConfig((prev) => {
                                  const updated = { ...prev, enabled: !prev.enabled };
                                  saveMaskingConfig(updated);
                                  return updated;
                                });
                              }
                            : undefined
                        }
                        userRole={user?.role}
                        maskingConfig={maskingConfig}
                        editingEnabled={editingEnabled}
                        pendingChanges={editing.pendingChanges}
                        onCellChange={editing.handleCellChange}
                        onApplyChanges={editing.handleApplyChanges}
                        onDiscardChanges={editing.handleDiscardChanges}
                        onLoadQuery={(q) => tabMgr.updateCurrentTab({ query: q })}
                        onLoadMore={
                          tabMgr.currentTab.result?.pagination?.hasMore ? queryExec.handleLoadMore : undefined
                        }
                        isLoadingMore={tabMgr.currentTab.isLoadingMore}
                        onExportResults={exportResults}
                        agentArtifact={agentArtifact.artifact}
                        onDismissAgentArtifact={agentArtifact.dismiss}
                      />
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>
              </div>
            </main>
          </div>
        </ResizablePanel>

        {/*
          The agent rail. Absent — not hidden, not disabled — while the server says
          the runtime is off, which is the default. One instance serves both
          presentations: this panel above `md`, and a sheet below it, where the panel
          is display:none and the mobile nav is what opens the rail.

          The imports above are static, so with the flag off the rail's modules and the
          two hydration modules beside them are still in the standalone bundle — as is
          `execution-policy.ts`,
          which the rail and the timeline import as VALUES for the budget meter's
          ceilings. What does NOT reach a browser is any agent RUNTIME module (the
          ledger, the run service, the tool layer, the model adapter — those are
          server-only and the rail imports nothing from them but types), and no agent
          request is made beyond the discovery probe. `docs/AGENT.md` states the same
          boundary for a reader who never opens this file.
          This repository lazy-imports libraries but no COMPONENT
          (neither `next/dynamic` nor `React.lazy` appears under `src/`), and the
          package boundary — the one that matters for what ships to platform — is
          pinned separately in T12.
        */}
        {agentEnabled && !isMobile && (
          <>
            <ResizableHandle className="w-1 bg-transparent hover:bg-blue-500/30 transition-colors" />
            <ResizablePanel id="studio-agent" defaultSize="24" minSize="18" maxSize="45">
              {agentRail}{" "}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>

      {/*
        Below the breakpoint the rail is not a panel — see the sidebar's note above —
        but it must still be MOUNTED: its mobile presentation is a sheet it renders
        itself, and `MobileNav`'s Agent control is what opens it. Dropping it with the
        panel would take the phone's only agent surface with it.
      */}
      {agentEnabled && isMobile && agentRail}

      {/* Modals */}
      <ConnectionModal
        isOpen={isConnectionModalOpen}
        onClose={() => {
          setIsConnectionModalOpen(false);
          setEditingConnection(null);
        }}
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
        query={queryExec.safetyCheckQuery || ""}
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
        tableName={profilerTable || ""}
        tableSchema={conn.schema.find((t) => t.name === profilerTable) || null}
        connection={conn.activeConnection}
        schemaContext={conn.schemaContext}
        databaseType={conn.activeConnection?.type}
      />
      <CodeGenerator
        isOpen={!!codeGenTable}
        onClose={() => setCodeGenTable(null)}
        tableName={codeGenTable || ""}
        tableSchema={conn.schema.find((t) => t.name === codeGenTable) || null}
        databaseType={conn.activeConnection?.type}
      />
      <TestDataGenerator
        isOpen={!!testDataTable}
        onClose={() => setTestDataTable(null)}
        tableName={testDataTable || ""}
        tableSchema={conn.schema.find((t) => t.name === testDataTable) || null}
        databaseType={conn.activeConnection?.type}
        queryLanguage={metadata?.capabilities.queryLanguage}
        onExecuteQuery={(q) => queryExec.executeQuery(q)}
      />

      {/* Unlimited Query Warning */}
      <AlertDialog open={queryExec.unlimitedWarningOpen} onOpenChange={queryExec.setUnlimitedWarningOpen}>
        <AlertDialogContent className="bg-overlay border-hairline max-w-sm p-0 gap-0 overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-red-500/10 flex items-center justify-center shrink-0">
                <TriangleAlert strokeWidth={1.5} className="w-5 h-5 text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <AlertDialogTitle className="text-[0.8125rem] font-medium text-fg mb-1">
                  Load all results?
                </AlertDialogTitle>
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
          queryExec.setBottomPanelMode("results");
        }}
        onLoadHistoryQuery={(q) => {
          tabMgr.updateCurrentTab({ query: q });
          queryExec.setBottomPanelMode("results");
        }}
        onNavigateHealth={() => router.push("/monitoring")}
        onNavigateMonitoring={() => router.push("/monitoring")}
        onShowDiagram={() => setShowDiagram(true)}
        onFormatQuery={() => queryEditorRef.current?.format()}
        onSaveQuery={() => setIsSaveQueryModalOpen(true)}
        onAskAgent={agentEnabled ? askAgentAboutStatement : undefined}
        onLogout={handleLogout}
      />

      <MobileNav
        activeTab={activeMobileTab}
        onTabChange={setActiveMobileTab}
        hasResult={!!tabMgr.currentTab.result}
        // Absent while the runtime is off, so the nav carries no control that
        // would open a rail that does not exist.
        onOpenAgent={agentEnabled ? () => setIsAgentSheetOpen(true) : undefined}
      />
    </div>
  );
}
