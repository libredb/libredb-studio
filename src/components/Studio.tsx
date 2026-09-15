"use client";

import type { CsvDelimiter } from "@/lib/export/csv";

import { appFetch } from "@/lib/config/base-path";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Sidebar, ConnectionsList } from "@/components/sidebar";
import { type TreeRowActionHandlers } from "@/components/object-tree";
import { objectAtPath } from "@/lib/db/detailed-object";
import { objectPathLabel, objectPathQuery } from "@/lib/db/object-path";
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
import type { DatabaseObject } from "@/lib/db/types";
import { findKind, kindHasSource, relationKindIds } from "@/lib/db/object-kinds";
import { httpSourceApplier, ObjectSourceView, type ObjectSourcePatch } from "@/components/object-source";
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
import { writeToClipboard } from "@/components/copy-button";
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
import { TriangleAlert, Database, Plus, Trash2 } from "lucide-react";
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
  const { metadata, error: metadataError, retry: retryMetadata } = useProviderMetadata(conn.activeConnection);

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

  /**
   * How many catalog-changing statements this session has run (#789).
   *
   * The object tree holds its own lazy cache and nothing outside it can reach it, so a DDL
   * statement has to TELL it. A counter rather than a boolean or a timestamp: it is monotonic,
   * it needs no clearing, and the tree acts on a value it has not seen before.
   */
  const [objectRefreshToken, setObjectRefreshToken] = useState(0);
  const objectsChanged = useCallback(() => setObjectRefreshToken((previous) => previous + 1), []);

  /**
   * What the source viewer writes back onto the tab it is mounted in (#789 Phase 2).
   *
   * MERGED BY SPREAD, and an explicitly-undefined key in the patch is therefore a CLEAR
   * rather than a no-op: that is how the stale banner's re-read control works, sending
   * `{ document: undefined, failure: undefined, readAtToken: undefined }` to put the tab back
   * into the state the viewer reads from.
   *
   * STABLE across renders, which is a requirement rather than an optimisation: the viewer's
   * read effect lists `onChange` among its dependencies, so a fresh identity every render
   * re-runs it, and while its own address guard would still refuse to re-issue, a shell that
   * re-rendered on every answer and re-ran the effect on every render is one guard away from
   * hammering the route. The dependencies are `setTabs`, which `useState` guarantees is
   * stable, and the active tab id, which changes only when the reader changes tabs.
   *
   * Addressed by ID and not by `currentTab`, because an answer can land after the reader has
   * switched tabs: the patch belongs to the tab that asked for it, so the read a reader
   * started before switching away is there when they switch back.
   */
  /** Present exactly when the active tab is a Source tab, and it is what the pane branches on. */
  const sourceTab = tabMgr.currentTab.source;

  /**
   * What every statement entry point OUTSIDE the editor pane is handed while a Source tab is
   * active (#789 Phase 2, round 1 finding 1, completed in round 2).
   *
   * The pane below branches around the toolbar AND the editor together, so a Source tab draws
   * no Run button. That covers the desktop editor and NOTHING else, and the population is
   * larger than it looks, because "outside the editor pane" includes two surfaces that are
   * rendered outside the branch rather than merely mounted elsewhere. Every one of these
   * addresses `currentTab` and every one was live over a Source tab. The list is exhaustive as
   * of round 2, taken by reading each `updateCurrentTab` and each execute call in this file
   * rather than from the five the first round happened to name:
   *
   * - the command palette's "Run Query", and its saved-query and history loaders;
   * - the mobile header's RUN and its EXPLAIN, which is the same execution by another name;
   * - the BOTTOM PANEL's `onLoadQuery`. `BottomPanel` is rendered below the editor pane and
   *   outside its branch, and `BottomPanel.tsx` wires that one prop to both `QueryHistory`'s
   *   and `SavedQueries`' `onSelectQuery`. That makes it the plainest desktop gesture in the
   *   class: open a Source tab, open History in the bottom panel, click a past query.
   * - the AGENT RAIL's `onApplyStatement` and its `onRunStatement`. The second is the only
   *   entry point here that both WRITES and EXECUTES, so over a Source tab it ran a statement
   *   while the pane showed a read-only definition and nothing on screen said what ran.
   *
   * MEASURED before this existed: `updateCurrentTab({ query })` leaves a Source tab a Source
   * tab, so a statement loaded from the palette landed on a tab whose pane shows a read-only
   * definition and displays no query at all, and Run then executed it. With nothing loaded the
   * same Run executed the empty string, because `use-query-execution` has no empty-query guard
   * and `queryEditorRef.current` is null while `QueryEditor` is unmounted. The write is not
   * transient either: `use-tab-manager`'s SAVE effect persists `query` per tab, so the
   * statement outlived the session on a tab that never showed it.
   *
   * What this predicate deliberately does NOT gate, so the next reader does not reopen it. The
   * class is an entry point that addresses the ACTIVE TAB'S STATEMENT: it reads the tab's query
   * to run it, or writes a statement into the tab. Three groups fall outside that and each stays
   * live over a Source tab on purpose:
   *
   * - `CreateTableModal`, `DataImportModal` and `TestDataGenerator` call `executeQuery(sql)` with
   *   THEIR OWN statement, aimed at an object the reader picked in the tree, and the tab is only
   *   where the answer lands. `executeQuery` with an override never writes `query`, so nothing is
   *   put on the tab, and `BottomPanel` draws the result below the definition. Gating these would
   *   take away a working action because an unrelated tab happens to be open.
   * - `QuerySafetyDialog`'s Proceed and the unlimited-rows dialog's Load All continue an execution
   *   that is already under way, so they are reachable only through something already allowed.
   * - the mobile header's `onClearQuery` writes the EMPTY string, which is the value a Source tab
   *   already holds: `openSourceTab` appends with `query: ""` and, with the entry points above
   *   closed, nothing can put a statement there. A gate here would be a line no mutation could
   *   kill, and on a workspace persisted by an older build it would preserve the stale statement
   *   this predicate exists to keep out.
   *
   * A no-op rather than an absent control, because every component that draws these takes them
   * as REQUIRED props and none of those files is this task's to change. That is the smaller
   * half of the answer: the item should not be drawn at all, on the same argument the pane
   * already makes, and hiding it is filed for the shells that own those files (#789). What is
   * closed here is the half that matters, which is that nothing runs and nothing is written
   * onto a tab that cannot show it.
   */
  const runsTheActiveTab = sourceTab === undefined;

  const { setTabs, activeTabId } = tabMgr;
  const onSourceChange = useCallback(
    (patch: ObjectSourcePatch) => {
      setTabs((previous) =>
        previous.map((tab) =>
          tab.id === activeTabId && tab.source !== undefined ? { ...tab, source: { ...tab.source, ...patch } } : tab,
        ),
      );
    },
    [setTabs, activeTabId],
  );

  /**
   * What this shell does after an apply that CHANGED the addressed object (#789 Phase 3).
   *
   * MEASURED, and it is the reason this handler exists at all: the Source pane NEVER re-reads
   * after a change made elsewhere in the same app. A new body was applied to
   * `p3probe.order_total` through `POST /api/db/query` while its Source tab was open, and the tab
   * kept showing the pre-apply text with no stale banner. `objectRefreshToken` above is a counter
   * this shell increments for what IT ran, and a raw query is not one of them, so an apply that
   * did not move it would leave the reader looking at the definition they just replaced.
   *
   * TWO WRITES IN ONE HANDLER, and the batching is the point rather than an optimisation. React
   * commits both together, so the pane re-renders exactly once, with `refreshToken = n+1` AND
   * `document === undefined`. Its read effect then issues a fresh read recording `tokenAtRead =
   * n+1`, and the landed read writes `readAtToken = n+1`, which EQUALS the counter. So the tab
   * that applied is NOT marked stale, while every other open Source tab is: the tab that applied
   * knows exactly what happened, and the others know only that something did. Split into two
   * commits, with the clear first, the read goes out at token n and comes back stale on the one
   * tab whose reader is certain about what changed.
   *
   * The CLEAR is `onSourceChange`'s explicit-undefined form, which is a clear and not a no-op,
   * and it addresses the ACTIVE tab. It reaches the right tab, and the reason written here first
   * was NOT the reason, which is worth the space because the wrong reason survives a refactor the
   * right one would not.
   *
   * The wrong reason: "the pane that performed the apply is mounted in the active tab, because it
   * is the only Source pane this shell renders". MEASURED FALSE at the moment that matters. With
   * the apply in flight and a direct DOM click moving the strip to another tab, the apply landed,
   * the toast fired, and the tab that was active THEN was not cleared.
   *
   * The real reason is a STALE CLOSURE, and it is load-bearing rather than incidental:
   * `onSourceChange` here is bound to the `activeTabId` of the render at CONFIRM time, and the
   * pane captures it through `onApplied`, so the clear addresses the tab that was active when the
   * reader pressed Confirm. That is the tab that applied, which is what this is for.
   *
   * Reachability of the disagreement, MEASURED AGAIN AND THE OTHER WAY (D82). An earlier reading
   * here said the strip cannot be moved while the dialog is open, because Radix's modal aria-hides
   * it, and that `setActiveTabId` has no caller outside the strip and the sidebar tree. Both halves
   * were wrong. Aria-hidden is not removed: the strip stays in the tree, and `StudioTabBar`
   * registers the new-tab shortcut on `document` on purpose, so it works while Monaco owns focus
   * (#745), and a keydown from a control INSIDE the dialog reaches that listener. `addTab` ends
   * with `setActiveTabId(newId)`, so `setActiveTabId` does have a caller the modal does not cover,
   * and `handleTableClick` is a SECOND one, reachable in the same window through the palette's own
   * document listener. Both are named where they are refused, in `refuseWhileApplying` below.
   *
   * What follows from that is worse than a mis-addressed clear and is answered in `handleAddTab`
   * below: the new Query tab unmounts the Source pane, and the dialog with it, mid apply. The
   * stale closure above is still the reason the clear reaches the right tab; it is now the reason
   * on a path where the two readings CAN disagree, rather than one where nothing could tell.
   *
   * The DRAFT is not dropped here. The pane drops it itself, keyed on the part its PLAN was built
   * for, which is a key this shell does not hold and must not guess.
   */
  const handleApplied = useCallback(() => {
    objectsChanged();
    onSourceChange({ document: undefined, failure: undefined, readAtToken: undefined });
    toast({ title: "Applied. Reading the definition again." });
  }, [objectsChanged, onSourceChange, toast]);

  /**
   * Whether the Source pane has an apply in flight: sent, and no answer back yet (D82).
   *
   * The pane publishes it and this shell only mirrors it, because the shell cannot see it: the
   * plan, the round trip and the dialog all live inside the pane.
   */
  const [applyInFlight, setApplyInFlight] = useState(false);

  const { addTab } = tabMgr;

  /**
   * The one refusal both tab-opening gestures share while an apply is in flight (D82).
   *
   * WHAT IS ACTUALLY REACHABLE IN THIS WINDOW, ENUMERATED BY MEASUREMENT and not by argument,
   * because an unmeasured "nothing else can reach this" is the mistake D82 was filed over. The
   * dialog refuses every exit IT owns: while `applying` it withholds its close button and prevents
   * Escape, a press outside and every other interaction outside. What it cannot refuse is a
   * listener registered on `document`, and there are TWO of those. `StudioTabBar` registers the
   * new-tab shortcut (#745) and `CommandPalette` registers Cmd/Ctrl+K, both outside the modal, so
   * both fire from a control inside it.
   *
   * The palette door was measured item by item, with the real palette rendered over a held apply:
   * Cmd/Ctrl+K opens it, focus moves into its input, and of the ten entries it offered exactly one
   * moved the active tab. Run Query, Format Query, Save Current Query, New Connection, the ERD and
   * the connection row all left the dialog standing and the conflict still rendered. A TABLE row
   * calls this shell's `onTableClick` -> `handleTableClick`, which ends with `setActiveTabId(newId)`
   * exactly as `addTab` does, and that unmounted the pane and lost the answer. Health Dashboard,
   * Monitoring and Logout were not measurable here: they call `router.push` and `handleLogout`, and
   * the router is a double in the harness. They leave the page rather than reshuffle it, which is
   * an act with its own confirmation and is not this guard's to intercept.
   *
   * So the guard is bound to the two handlers that OPEN AND ACTIVATE A TAB, and the message is one
   * string for both: a gesture and its keyboard twin refusing on different words is the drift this
   * helper exists to prevent.
   *
   * REFUSED IS NOT SWALLOWED, which is the cost of this shape and is paid rather than accepted.
   * A keystroke that does nothing and says nothing reads as a broken shortcut, so the refusal
   * toasts, and it says what the reader is waiting for and what to do. Deferring the tab until the
   * answer lands was considered and rejected: a tab that opens by itself some seconds later is a
   * gesture the reader no longer connects to anything they did.
   *
   * "Once you have READ the answer" and not "once it is on screen", which the first wording said.
   * The refusal ends the moment `applying` ends, which is the moment the conflict, the refusal or
   * the failure renders, so a reader who takes the earlier wording literally opens the tab, unmounts
   * the pane and throws the answer away. Nothing was applied in that case and the copy in the
   * conflict says so, but advice that discards what the reader was waiting for is not advice.
   */
  const refuseWhileApplying = useCallback(() => {
    toast({
      title: "Waiting for the apply to answer",
      description:
        "Opening a tab would close this dialog before the apply reports. Try again once you have read the answer.",
    });
  }, [toast]);

  /**
   * The new-tab shortcut, REFUSED while an object apply is in flight, and answered out loud (D82).
   *
   * MEASURED: the shortcut is registered on `document`, the aria-hidden strip is still in the tree,
   * and `addTab` ends with `setActiveTabId`. This shell renders the Source pane only while the
   * ACTIVE tab is a Source tab, so the new Query tab unmounted the pane and took the apply dialog
   * with it after the statement had been sent. A `conflict` landing into that left the reader with
   * nothing at all: no dialog, no banner, no throw. Only `applied` survives, through `onApplied`,
   * so the one outcome the reader could still see was the one they did not need to be told about.
   *
   * WHY REFUSE THE KEYSTROKE RATHER THAN KEEP THE PANE MOUNTED, chosen and not defaulted into.
   * Keeping the pane mounted for the tab that owns it costs the reader nothing and is the larger
   * change: the shell renders one pane, `onSourceChange` addresses `activeTabId`, and a second
   * mounted pane would need its own per-tab patch channel and a second live read, while the dialog
   * it kept alive would be drawn over a Query tab the reader had just asked for. That is a wider
   * seam than the defect. Refusing is the smaller change and it matches what the dialog ALREADY
   * does with every exit it owns, and `refuseWhileApplying` above enumerates what it does not.
   *
   * The `+` button takes the same handler. It is covered by the modal and cannot be pressed in this
   * window, so the guard is unreachable through it, but one gesture and its keyboard twin refusing
   * on different rules is the drift this handler exists to prevent.
   */
  const handleAddTab = useCallback(() => {
    if (applyInFlight) {
      refuseWhileApplying();
      return;
    }
    addTab();
  }, [addTab, applyInFlight, refuseWhileApplying]);

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
    onObjectsChanged: objectsChanged,
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
  // declares it holds a transaction session (#464). The server's gate is
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
  const handleDuplicateConnection = (source: DatabaseConnection) => {
    setEditingConnection({
      ...structuredClone(source),
      id: newLocalId(),
      name: `${source.name} (copy)`,
      createdAt: new Date(),
      // A new local connection must not be merged back into its source seed on reload.
      seedId: undefined,
      managed: false,
    });
    setIsConnectionModalOpen(true);
  };
  const [pendingDeleteConnectionId, setPendingDeleteConnectionId] = useState<string | null>(null);
  const [isCreateTableModalOpen, setIsCreateTableModalOpen] = useState(false);
  const [showDiagram, setShowDiagram] = useState(false);
  const [isSaveQueryModalOpen, setIsSaveQueryModalOpen] = useState(false);
  const [savedKey, setSavedKey] = useState(0);
  const [activeMobileTab, setActiveMobileTab] = useState<"database" | "schema" | "editor">("editor");
  /** What the panel group may hold: below the breakpoint, only the body panel. */
  const isMobile = useIsMobile();
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  // The three modal targets are ADDRESSES, not labels (#789, Task 35). A label is not
  // unique - two containers hold one `customers` on the SQL Server this was measured on -
  // so a target spelled as a name opened whichever object the flat list held first.
  const [profilerPath, setProfilerPath] = useState<readonly string[] | null>(null);
  const [codeGenPath, setCodeGenPath] = useState<readonly string[] | null>(null);
  const [testDataPath, setTestDataPath] = useState<readonly string[] | null>(null);

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

  /*
    The Explorer's per-row items call this with the row's ADDRESS; without carrying it the
    tab opened with nothing selected (#459). The address rides the query string - the admin
    section is routed, so a param is what a section page can read - as one `path` parameter
    per SEGMENT (`objectPathQuery`), which is the shape that survives the round trip: the URL
    grammar escapes each segment, so a dot, a space or a `/` inside a name reaches the
    destination as itself, and the depth is the parameter count rather than a separator the
    reader has to guess at. `?table=<label>` did none of that and named a label two objects
    can share (#789, Task 35).

    The non-admin /monitoring route has no such reader, so it keeps the bare path.
  */
  const openMaintenance = (_tab?: "global" | "tables" | "sessions", path?: readonly string[]) => {
    if (isAdmin) {
      router.push(path === undefined ? "/admin/operations" : `/admin/operations?${objectPathQuery(path)}`);
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
  const buildResultFile = (
    format: ResultExportFormat,
    hydrated: AgentArtifactHydration | null,
    csvDelimiter?: CsvDelimiter,
  ) => {
    const source = hydrated?.result ?? tabMgr.currentTab.result;
    if (!source) return null;
    // The columns the engine declared for THIS result. The writers read every row by
    // these names rather than by whatever keys row 0 happens to carry, so a row with
    // a different key order — or a document store's row missing a field entirely —
    // lands in the right column instead of shifting the rest.
    const fields = source.fields;
    const sensitiveColumns = detectSensitiveColumnsFromConfig(fields, maskingConfig);
    const rows = effectiveMasking ? applyMaskingToRows(source.rows, fields, sensitiveColumns) : source.rows;

    return buildResultExport(format, {
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
      csvDelimiter,
    });
  };

  const exportResults = (
    format: ResultExportFormat,
    hydrated: AgentArtifactHydration | null = null,
    csvDelimiter?: CsvDelimiter,
  ) => {
    const file = buildResultFile(format, hydrated, csvDelimiter);
    if (file === null) return;
    downloadText(file.content, file.mimeType, resultExportFileName(file.extension, hydrated?.runId));
  };

  /**
   * The same rows, in the same format, onto the clipboard (#701).
   *
   * Two things this shares with the export above, and both are the reason it is built
   * from the same function rather than beside it: the masking, so the clipboard is not
   * a way around a masked column, and the rows, so a hydrated run's result is copied
   * as what is on screen rather than as the tab's own.
   *
   * What it does NOT share is the byte-order mark. That is added by `downloadText` for
   * a spreadsheet reading bytes off disk; a paste carrying it would open with an
   * invisible character wherever it landed.
   *
   * The outcome is reported only once the write has one (B43). `writeToClipboard`
   * falls back to the editing command where there is no secure context — several
   * distribution channels serve plain HTTP — and when both routes are gone the user is
   * told, because the alternative is discovering an empty clipboard mid-paste.
   */
  const copyResults = (
    format: ResultExportFormat,
    hydrated: AgentArtifactHydration | null = null,
    csvDelimiter?: CsvDelimiter,
  ) => {
    const file = buildResultFile(format, hydrated, csvDelimiter);
    if (file === null) return;
    void writeToClipboard(file.content).then((copied) => {
      if (copied) toast({ title: `Copied ${file.extension.toUpperCase()} to clipboard` });
      else
        toast({
          title: "Could not copy to clipboard",
          description: "Select the text and copy it yourself, or export the result as a file.",
          variant: "destructive",
        });
    });
  };

  /**
   * Open and run the statement for one object, addressed by its PATH (#789).
   *
   * REFUSED while an object apply is in flight, on the same rule and with the same words as the
   * new-tab shortcut (D82). This is the second door into that window and the only palette entry
   * that was measured to reach it: `handleTableClick` ends with `setActiveTabId(newId)`, the shell
   * renders the Source pane only for an active Source tab, and the palette's Cmd/Ctrl+K listener is
   * on `document`, so a reader inside the apply dialog can press it, search, and take the pane and
   * the dialog down with the statement already sent. The reasoning is in `refuseWhileApplying`.
   *
   * The object tree and the mobile explorer funnel through here too. Both are covered and
   * aria-hidden by the modal, so the guard is unreachable through them, and they are the `+`
   * button's case: one funnel, one rule, no drift.
   */
  const onTableClick = (path: readonly string[]) => {
    if (applyInFlight) {
      refuseWhileApplying();
      return;
    }
    tabMgr.handleTableClick(path, queryExec.executeQuery);
  };

  /**
   * A row activated in the object tree (#789).
   *
   * Gated on the kind's declared ROLE, never on its id: `handleTableClick` generates a
   * query and EXECUTES it, so handing it a routine or a trigger would run
   * `SELECT * FROM order_total(integer) LIMIT 50` against the database. The old flat
   * explorer could not reach that state because it only ever listed relations; the tree
   * lists every declared kind, so the gate is what keeps a click on a function from
   * being a failed statement in the reader's history.
   *
   * The PATH and not the name. `name` is the label and `path` is the address (standing
   * ruling 2), and the generator now takes segments, so an object outside the session
   * default container generates a QUALIFIED statement instead of a bare identifier the
   * server cannot resolve.
   */
  const onObjectClick = (object: DatabaseObject) => {
    if (metadata === null) return;
    if (relationKindIds(metadata.capabilities).includes(object.kind)) {
      onTableClick(object.path);
      return;
    }
    /*
     * A NON-RELATION row whose kind declares source opens its Source tab (#789 Phase 2).
     *
     * One gesture, one behaviour per row, never two on one row. A relation that ALSO has
     * source, a PostgreSQL view or a SQLite table, took the branch above and keeps its data
     * preview; its definition is one menu item away. The alternative, activating both, would
     * open two tabs from one press, and the alternative to THIS arm is the state Phase 1 left
     * every routine, trigger and package in: a row that does nothing at all on click, on
     * Enter and on Space.
     *
     * The gate is the DECLARATION and never the kind id, exactly as the branch above is.
     */
    if (kindHasSource(metadata.capabilities, object.kind)) tabMgr.openSourceTab(object);
  };

  /**
   * The row menu's actions, all six of them (U22, #789).
   *
   * This shell is the one that has every destination: the modals below, the create-table
   * modal, and the admin Operations page the maintenance items deep-link to. WHICH of them
   * a given row is offered is not decided here - `rowActions` reads the provider's
   * declaration for that row's kind - so this object is only the list of what the shell can
   * do at all.
   *
   * Every one of them carries `object.path`. An object is TARGETED by its address and
   * RESOLVED by its address (#789, Task 35): the narrowing to `object.name` that used to
   * stand here handed a label on, and the modals resolved it with a find-by-name that
   * answers the first object carrying that label, so Profile on one `customers` opened the
   * other one's columns with no error.
   *
   * Maintenance is withheld from a non-admin because the page it opens is the admin one; the
   * other five are the same for every role, exactly as the flat explorer had them.
   */
  const objectActions: TreeRowActionHandlers = {
    onGenerateSelect: (object) => tabMgr.handleGenerateSelect(object.path),
    onProfileObject: (object) => setProfilerPath(object.path),
    onGenerateCode: (object) => setCodeGenPath(object.path),
    onGenerateTestData: (object) => setTestDataPath(object.path),
    onOpenMaintenance: isAdmin ? (object) => openMaintenance("tables", object.path) : undefined,
    onCreateObject: () => setIsCreateTableModalOpen(true),
    onViewSource: (object) => tabMgr.openSourceTab(object),
  };

  const requestDeleteConnection = (id: string) => {
    setPendingDeleteConnectionId(id);
  };

  const handleDeleteConnection = (id: string) => {
    // Clean up server-side provider cache and close connections/tunnels
    appFetch("/api/db/disconnect", {
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

  const confirmDeleteConnection = () => {
    if (!pendingDeleteConnectionId) return;
    handleDeleteConnection(pendingDeleteConnectionId);
    setPendingDeleteConnectionId(null);
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
      onApplyStatement={(sql) => {
        if (!runsTheActiveTab) return;
        tabMgr.updateCurrentTab({ query: sql });
      }}
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
        if (!runsTheActiveTab) return;
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
                onSelectConnection={conn.setActiveConnection}
                onDeleteConnection={requestDeleteConnection}
                onEditConnection={(c) => {
                  setEditingConnection(c);
                  setIsConnectionModalOpen(true);
                }}
                onDuplicateConnection={handleDuplicateConnection}
                onAddConnection={() => setIsConnectionModalOpen(true)}
                onObjectClick={onObjectClick}
                objectActions={objectActions}
                onShowDiagram={() => setShowDiagram(true)}
                metadata={metadata}
                metadataError={metadataError}
                onRetryMetadata={retryMetadata}
                objectScanDeferred={conn.objectScanDeferred}
                onLoadObjects={conn.loadObjects}
                objectRefreshToken={objectRefreshToken}
              />
            </ResizablePanel>
            <ResizableHandle className="w-1 bg-transparent hover:bg-brand-tint/30 transition-colors" />
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
              onExecuteQuery={() => {
                if (!runsTheActiveTab) return;
                queryExec.executeQuery();
              }}
              onCancelQuery={() => queryExec.cancelQuery()}
              {...transactionHandlers}
              onToggleEditing={onToggleEditing}
              onImport={() => setIsImportModalOpen(true)}
              onExplain={
                metadata?.capabilities.supportsExplain
                  ? () => {
                      if (!runsTheActiveTab) return;
                      queryExec.executeQuery(undefined, undefined, true);
                    }
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
              onAddTab={handleAddTab}
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
                      <SchemaDiagram
                        schema={conn.schema}
                        capabilities={metadata?.capabilities}
                        onClose={() => setShowDiagram(false)}
                      />
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
                    onDeleteConnection={requestDeleteConnection}
                    onDuplicateConnection={handleDuplicateConnection}
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
                      onTableClick={(path) => {
                        onTableClick(path);
                        setActiveMobileTab("editor");
                      }}
                      onGenerateSelect={(path) => {
                        tabMgr.handleGenerateSelect(path);
                        setActiveMobileTab("editor");
                      }}
                      onCreateTableClick={() => setIsCreateTableModalOpen(true)}
                      isAdmin={isAdmin}
                      onOpenMaintenance={openMaintenance}
                      databaseType={conn.activeConnection?.type}
                      metadata={metadata}
                      onProfileTable={(path) => setProfilerPath(path)}
                      onGenerateCode={(path) => setCodeGenPath(path)}
                      onGenerateTestData={(path) => setTestDataPath(path)}
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
                        {/*
                          One branch around the toolbar AND the editor together, so a Source
                          tab shows no Run button rather than a disabled one: there is nothing
                          on a definition to run, and a control that is present and refuses is
                          a worse answer than a control that is not there (#789 Phase 2).

                          THE CONNECTION IS NO LONGER PART OF THIS BRANCH, and that conjunct
                          was the third door onto the same hazard (#789 fix round 1). It read
                          `|| conn.activeConnection === null` on a docblock arguing the state
                          was admitted by the type and not reached by the product. It is
                          reached: a Source tab outlives the connection that opened it, so a
                          person who deletes the active connection with one open got a tab
                          labelled `Source: <name>` over an EMPTY, EDITABLE buffer with a live
                          Run button, which is the composition this whole surface exists to
                          prevent. The viewer takes a nullable connection and refuses in its
                          own grammar, so the pane stays a pane and asks the route nothing.
                        */}
                        {sourceTab === undefined ? (
                          <>
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
                                documentId={tabMgr.currentTab.id}
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
                          </>
                        ) : (
                          <div className="flex-1 relative min-h-0">
                            <ObjectSourceView
                              connection={conn.activeConnection}
                              path={sourceTab.path}
                              kind={sourceTab.kind}
                              /*
                                The kind's own word from the DECLARATION, falling back to the
                                id: the viewer never derives a label from an id, and this shell
                                is where the declaration is held.

                                Both arms of the fallback are reachable and each has its own
                                test. `metadata` is null until the provider answers, and a
                                restored Source tab mounts this pane before then; and a
                                declaration that does not carry the tab's kind, which a
                                workspace restored against an edited connection produces,
                                makes `findKind` answer undefined. A blank caption over a
                                definition is the one thing this line refuses to draw. The
                                dead `metadata === undefined` half that stood here in round 1
                                is gone: `useProviderMetadata` answers `ProviderMetadata |
                                null`, so that arm narrowed nothing (#789 round 1 finding 4).
                              */
                              kindLabel={
                                (metadata === null
                                  ? undefined
                                  : findKind(metadata.capabilities, sourceTab.kind)?.label) ?? sourceTab.kind
                              }
                              displayName={objectPathLabel(sourceTab.path)}
                              document={sourceTab.document}
                              failure={sourceTab.failure}
                              activePartId={sourceTab.activePartId}
                              refreshToken={objectRefreshToken}
                              readAtToken={sourceTab.readAtToken}
                              editingPartId={sourceTab.editingPartId}
                              dirty={sourceTab.dirty}
                              /*
                                WHO performs the apply, passed EXPLICITLY rather than defaulted
                                inside the pane (#789 Phase 3). That is the difference that lets
                                the embedded shell withhold it, and withholding it is what keeps
                                an existing adopter unchanged: with no `onApply` the pane is
                                exactly Phase 2, no bar and no sentence.

                                NOTHING HERE CONSULTS `metadata.capabilities` for the edit gate,
                                and that is D57 closed by construction. The kind lookup above
                                resolves a LABEL and nothing else. MEASURED end to end on a live
                                MariaDB 12.3.2: `provider-meta` answered the MySQL six for a
                                server whose connected provider serves `package` in full, so this
                                shell's copy of a declaration is a statement about some server
                                and not necessarily the connected one. The affordance travels
                                with the read instead, on the part, from the provider that
                                answered it.
                              */
                              onApply={httpSourceApplier}
                              onApplied={handleApplied}
                              onApplyInFlightChange={setApplyInFlight}
                              onChange={onSourceChange}
                            />
                          </div>
                        )}
                      </div>
                    </ResizablePanel>
                    <ResizableHandle className="h-1 bg-fill hover:bg-brand-tint/20" />
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
                        onLoadQuery={(q) => {
                          if (!runsTheActiveTab) return;
                          tabMgr.updateCurrentTab({ query: q });
                        }}
                        onLoadMore={
                          tabMgr.currentTab.result?.pagination?.hasMore ? queryExec.handleLoadMore : undefined
                        }
                        isLoadingMore={tabMgr.currentTab.isLoadingMore}
                        onExportResults={exportResults}
                        onCopyResults={copyResults}
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
            <ResizableHandle className="w-1 bg-transparent hover:bg-brand-tint/30 transition-colors" />
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
        capabilities={metadata?.capabilities}
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
        isOpen={profilerPath !== null}
        onClose={() => setProfilerPath(null)}
        tablePath={profilerPath ?? []}
        tableSchema={objectAtPath(conn.schema, profilerPath)}
        connection={conn.activeConnection}
        schemaContext={conn.schemaContext}
        databaseType={conn.activeConnection?.type}
      />
      <CodeGenerator
        isOpen={codeGenPath !== null}
        onClose={() => setCodeGenPath(null)}
        tablePath={codeGenPath ?? []}
        tableSchema={objectAtPath(conn.schema, codeGenPath)}
        databaseType={conn.activeConnection?.type}
      />
      <TestDataGenerator
        isOpen={testDataPath !== null}
        onClose={() => setTestDataPath(null)}
        tablePath={testDataPath ?? []}
        tableSchema={objectAtPath(conn.schema, testDataPath)}
        databaseType={conn.activeConnection?.type}
        capabilities={metadata?.capabilities}
        onExecuteQuery={(q) => queryExec.executeQuery(q)}
      />

      {/* Unlimited Query Warning */}
      <AlertDialog open={queryExec.unlimitedWarningOpen} onOpenChange={queryExec.setUnlimitedWarningOpen}>
        <AlertDialogContent className="bg-overlay border-hairline max-w-sm p-0 gap-0 overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-red-500/10 flex items-center justify-center shrink-0">
                <TriangleAlert strokeWidth={1.5} className="w-5 h-5 text-warning" />
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
              className="flex-1 h-9 bg-warning-solid border-0 text-white text-xs font-medium hover:bg-warning-solid-hover"
            >
              Load All
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Connection Confirmation */}
      <AlertDialog
        open={!!pendingDeleteConnectionId}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteConnectionId(null);
        }}
      >
        <AlertDialogContent className="bg-overlay border-hairline max-w-sm p-0 gap-0 overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500/20 to-red-500/10 flex items-center justify-center shrink-0">
                <Trash2 strokeWidth={1.5} className="w-5 h-5 text-danger" />
              </div>
              <div className="flex-1 min-w-0">
                <AlertDialogTitle className="text-[0.8125rem] font-medium text-fg mb-1">
                  Delete connection?
                </AlertDialogTitle>
                <AlertDialogDescription className="text-xs text-fg-muted leading-relaxed">
                  <span className="text-fg-tertiary">
                    {conn.connections.find((c) => c.id === pendingDeleteConnectionId)?.name || "This connection"}
                  </span>{" "}
                  will be removed. This cannot be undone.
                </AlertDialogDescription>
              </div>
            </div>
          </div>
          <div className="px-6 pb-6 flex gap-2">
            <AlertDialogCancel className="flex-1 h-9 bg-fill border-0 text-fg-tertiary text-xs font-medium hover:bg-fill-strong hover:text-fg">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteConnection}
              className="flex-1 h-9 bg-danger-solid border-0 text-white text-xs font-medium hover:bg-danger-solid-hover"
            >
              Delete
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <CommandPalette
        connections={conn.connections}
        activeConnection={conn.activeConnection}
        schema={conn.schema}
        capabilities={metadata?.capabilities}
        onSelectConnection={conn.setActiveConnection}
        onTableClick={onTableClick}
        onAddConnection={() => setIsConnectionModalOpen(true)}
        onExecuteQuery={() => {
          if (!runsTheActiveTab) return;
          queryExec.executeQuery();
        }}
        onLoadSavedQuery={(q) => {
          if (!runsTheActiveTab) return;
          tabMgr.updateCurrentTab({ query: q });
          queryExec.setBottomPanelMode("results");
        }}
        onLoadHistoryQuery={(q) => {
          if (!runsTheActiveTab) return;
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
