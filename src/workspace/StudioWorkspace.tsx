"use client";

import type { CsvDelimiter } from "@/lib/export/csv";

import React, { useState, useEffect, useImperativeHandle, useRef, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { Sidebar } from "@/components/sidebar";
import { type TreeRowActionHandlers } from "@/components/object-tree";
import { ObjectSourceView, type ObjectSourcePatch } from "@/components/object-source";
import { objectAtPath } from "@/lib/db/detailed-object";
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
import type { DatabaseObject } from "@/lib/db/types";
import { findKind, kindHasSource, relationKindIds } from "@/lib/db/object-kinds";
import { objectPathLabel } from "@/lib/db/object-path";
import { useToast } from "@/hooks/use-toast";
import { useTabManager } from "@/hooks/use-tab-manager";
import { useConnectionAdapter } from "@/workspace/hooks/use-connection-adapter";
import { useQueryAdapter } from "@/workspace/hooks/use-query-adapter";
import { type StudioWorkspaceProps, DEFAULT_WORKSPACE_FEATURES } from "@/workspace/types";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { ChunkBoundary, ViewLoading } from "@/components/LazyView";
import { lazyRetry } from "@/lib/lazy";
import { editorLanguageForTabType } from "@/lib/editor/tab-language";
import { buildResultExport, type ResultExportFormat } from "@/lib/export/result-export";
import { writeToClipboard } from "@/components/copy-button";
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
  onObjectsFetch,
  onSaveQuery: onSaveQueryProp,
  // onLoadSavedQueries — reserved for future saved-queries panel integration
  features: featuresProp,
  className,
  ref,
}: StudioWorkspaceProps) {
  const queryEditorRef = useRef<QueryEditorRef>(null);
  const { toast } = useToast();

  // Merge feature flags with defaults
  const features = useMemo(() => ({ ...DEFAULT_WORKSPACE_FEATURES, ...featuresProp }), [featuresProp]);

  // 1. Connection Adapter (platform-managed connections)
  const conn = useConnectionAdapter({
    connections: externalConnections,
    onSchemaFetch,
    onObjectsFetch,
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
  // ADDRESSES, not labels, for the reason `src/components/Studio.tsx` gives at the same
  // three lines: a label is not unique within a connection (#789, Task 35).
  /**
   * How many catalog-changing statements THIS SHELL has run (#789 Phase 3, discussion #778).
   *
   * A counter this shell owns, and it counts exactly one thing: an object apply that this
   * workspace issued and that came back applied. It is deliberately NOT moved by anything the
   * host ran through `onQueryExecute`, because nothing reports back what those statements
   * changed, which is the same absence `refreshToken={0}` used to state by being a constant.
   *
   * See the mount below for what a reader is told as a result, and what they are not.
   */
  const [objectRefreshToken, setObjectRefreshToken] = useState(0);

  /**
   * The counter, moved by whoever moved the catalog: this shell, or the HOST saying so (D79).
   *
   * One writer for both, so the banner keeps a single meaning. `handleApplied` below calls it for
   * an apply this workspace issued and clears the tab that applied as well, because that one is
   * addressed; `catalogChanged` on the published handle calls it and clears nothing, because an
   * announcement is not.
   */
  const catalogChanged = useCallback(() => setObjectRefreshToken((previous) => previous + 1), []);

  /**
   * What a host can ASK this workspace to do (D79).
   *
   * The reasoning for a handle rather than a field on the `onQueryExecute` answer is on
   * `StudioWorkspaceHandle` in `src/workspace/types.ts`, where a host reads the contract. What
   * belongs here is why the shell needs one at all: every statement leaves through
   * `onQueryExecute`, that callback answers a result set and never says what the statement
   * changed, so a `CREATE OR REPLACE` a person runs in the query editor, or a migration the host
   * runs somewhere this package cannot see, was invisible to the counter below.
   *
   * `useImperativeHandle` with no ref is a no-op, so a host that passes none is unchanged.
   */
  useImperativeHandle(ref, () => ({ catalogChanged }), [catalogChanged]);
  const [profilerPath, setProfilerPath] = useState<readonly string[] | null>(null);
  const [codeGenPath, setCodeGenPath] = useState<readonly string[] | null>(null);
  const [testDataPath, setTestDataPath] = useState<readonly string[] | null>(null);

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
  const buildResultFile = useCallback(
    (format: ResultExportFormat, csvDelimiter?: CsvDelimiter) => {
      if (!tabMgr.currentTab.result) return null;
      return buildResultExport(format, {
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
        csvDelimiter,
      });
    },
    [tabMgr.currentTab, conn.activeConnection?.type],
  );

  const exportResults = useCallback(
    (format: ResultExportFormat, _hydrated?: unknown, csvDelimiter?: CsvDelimiter) => {
      const file = buildResultFile(format, csvDelimiter);
      if (file === null) return;
      downloadText(file.content, file.mimeType, `query_result_export.${file.extension}`);
    },
    [buildResultFile],
  );

  /**
   * The same rows, in the same format, onto the clipboard (#701).
   *
   * Built from the same function as the file above, so the two cannot come to disagree
   * about what a format means. The byte-order mark is the one thing they do not share:
   * `downloadText` adds it for a spreadsheet reading bytes off disk, and a paste
   * carrying it would open with an invisible character wherever it landed.
   *
   * The outcome is reported only once the write has one (B43). `writeToClipboard` falls
   * back to the editing command where there is no secure context, and when both routes
   * are gone the user is told rather than left to find an empty clipboard mid-paste.
   */
  const copyResults = useCallback(
    (format: ResultExportFormat, _hydrated?: unknown, csvDelimiter?: CsvDelimiter) => {
      const file = buildResultFile(format, csvDelimiter);
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
    },
    [buildResultFile, toast],
  );

  /**
   * Whether the Source pane has an apply in flight: sent, and no answer back yet (D82).
   *
   * The pane publishes it and this shell only mirrors it, because the shell cannot see it: the
   * plan, the round trip and the dialog all live inside the pane. `src/components/Studio.tsx`
   * mirrors the same callback into the same shape, and the two are deliberately one spelling.
   *
   * Declared HERE, above the two handlers that read it, rather than beside the mirror below: both
   * tab-opening gestures are refused on it and a `const` cannot be read before it is bound.
   */
  const [applyInFlight, setApplyInFlight] = useState(false);
  /** Whether a tab-opening gesture was refused in the window that is still open (D82). */
  const [refusedWhileApplying, setRefusedWhileApplying] = useState(false);

  /**
   * The one rule every tab-opening gesture in this shell is refused by, in one place (D82).
   *
   * Five handlers below ask it and there is no sixth spelling of the answer, which is the point:
   * the defect this guard exists for was one funnel guarded and its neighbour on the same tree
   * left open, and five copies of `if (applyInFlight) { setRefusedWhileApplying(true); return; }`
   * is that defect waiting to be written again. `true` means the caller must return without doing
   * anything; the caller does the returning, because a guard that swallowed the gesture itself
   * would have to know what each one returns.
   */
  const refuseWhileApplying = useCallback((): boolean => {
    if (!applyInFlight) return false;
    setRefusedWhileApplying(true);
    return true;
  }, [applyInFlight]);

  // === Table click handler ===
  /**
   * Open and run the statement for one object, addressed by its PATH (#789).
   *
   * REFUSED while an object apply is in flight, on the same rule and through the same surface as
   * the new-tab shortcut below (D82). `handleTableClick` ends with `setActiveTabId(newId)` and this
   * shell renders the Source pane only for an ACTIVE Source tab, so an unguarded activation
   * unmounts the pane and takes the dialog with it after the host's statement has been sent, which
   * is the loss D82 records.
   *
   * THE GUARD IS HERE BECAUSE THE REACHABILITY ARGUMENT IS A COVERING OVERLAY AND NOT AN ABSENCE.
   * Measured: no reader can take this gesture in that window today, because this shell renders no
   * command palette (the standalone shell's second door, enumerated below) and the Radix modal
   * covers and aria-hides the object tree. But a cover is a fact about one render of one host's
   * page, not about this handler: the host owns `className` and every wrapper above this box, and
   * an unmeasured "nothing else can reach this" is the class D82 was filed over. The standalone
   * shell guards its equivalent door in `src/components/Studio.tsx`, and one funnel refusing on two
   * different rules in two shells is the drift the guard prevents.
   */
  const onTableClick = useCallback(
    (path: readonly string[]) => {
      if (refuseWhileApplying()) return;
      tabMgr.handleTableClick(path, queryExec.executeQuery);
    },
    [refuseWhileApplying, tabMgr, queryExec.executeQuery],
  );

  /**
   * A row activated in the object tree (#789), gated on the kind's declared ROLE for the
   * reason `src/components/Studio.tsx` gives: the click generates a query and executes
   * it, and a routine is not a thing to select from.
   *
   * The host declares the capabilities per connection here, so `metadata` is null
   * whenever it declared none, and a tree is not rendered at all in that case.
   */
  const onObjectClick = useCallback(
    (object: DatabaseObject) => {
      const capabilities = conn.metadata?.capabilities;
      if (capabilities === undefined) return;
      if (relationKindIds(capabilities).includes(object.kind)) {
        onTableClick(object.path);
        return;
      }
      /*
       * A NON-RELATION row whose kind declares source opens its Source tab (#789 Phase 2).
       *
       * The same two-branch shape `src/components/Studio.tsx` writes, with ONE conjunct this
       * shell adds: the host must have declared a source read. Without one the viewer would
       * fall through to its default, which is this application's own route, and this package
       * ships none - which is B76 exactly, an action that cannot succeed on any connection.
       * So a host that implements nothing keeps the Phase 1 behaviour, where activating a
       * routine row does nothing at all.
       *
       * The gate is the DECLARATION and never the kind id, exactly as the branch above is.
       */
      if (conn.sourceReader !== undefined && kindHasSource(capabilities, object.kind)) {
        // REFUSED on the same rule as the relation branch above, and this is the branch that
        // carries the sharper loss: `openSourceTab` FOCUSES a Source tab already open for another
        // object, so the pane does not merely unmount, it re-addresses under a dialog whose
        // statement has already gone out.
        if (refuseWhileApplying()) return;
        tabMgr.openSourceTab(object);
      }
    },
    [conn.metadata, conn.sourceReader, onTableClick, refuseWhileApplying, tabMgr],
  );

  /**
   * The active tab's source address, whether or not this shell can still READ one (#789).
   *
   * THIS OVERTURNS THE FIRST ANSWER, which conjoined `conn.sourceReader !== undefined` and read
   * the tab as an ORDINARY one when the host stopped declaring `readObjectSource`. Half of that
   * reasoning was right and is kept: the viewer's own default reader posts to
   * `/api/db/objects/source`, this package ships no routes, so the pane must never fall through
   * to it. What it got wrong is what a person then SAW. A Source tab's text is never persisted,
   * only its address, so the tab came back named `Source: app.order_total(integer)` holding an
   * EMPTY, EDITABLE editor with a live Run button, which is the empty-editor hazard this whole
   * phase exists to prevent: an empty editor reads as "there is no source", and a user who types
   * over it deletes the object.
   *
   * So the address stands on its own and the pane stays a pane. Every consumer below is still
   * consistent, because they all read THIS value: no Run button, no toolbar and no statement
   * loader on a Source tab, whatever the host currently declares. What the host's absence
   * changes is the one thing it really means, which is that there is nothing to read with, and
   * `sourceFailure` below says so in the viewer's own grammar.
   */
  const sourceTab = tabMgr.currentTab.source;

  /**
   * What the pane shows when the host has stopped reading definitions (#789).
   *
   * The tab's OWN failure first, because it is the engine's or the host's sentence about a read
   * that really happened, and ours would overwrite a fact with a circumstance.
   *
   * Ours only when there is NOTHING TO SHOW, which is also what makes this load-bearing rather
   * than cosmetic: with no document, no failure and no reader, the viewer would issue its read
   * through `httpSourceReader` and ask a route that does not exist in this package. A failure
   * makes `needsRead` false, so no read is issued at all and the pane refuses instead.
   *
   * A definition ALREADY IN HAND is left on screen. It was read from the engine a moment ago and
   * a host handing a new reader object on a render is not a reason to throw a real definition
   * away; what it must not become is an editor with a Run button, and it does not.
   *
   * THE PATH THIS COVERS THAT NOTHING USED TO REACH, and it is now the second load-bearing
   * reason for the conjunction rather than a note about a later change: a tab holding a document
   * whose state is CLEARED while the host declares no reader would send the viewer's default
   * `httpSourceReader` at `/api/db/objects/source`, which this package does not ship. The only
   * control that clears one is the viewer's stale banner, and until this phase this shell passed
   * a hardcoded `refreshToken={0}`, so nothing was ever marked stale and the banner was never
   * drawn. It counts its OWN applies now, so the banner is reachable and so is its control. What
   * makes the clear safe is that this failure is non-undefined in the SAME render: `needsRead` in
   * `ObjectSourceView` is `document === undefined && failure === undefined`, so no read is issued
   * at all and the pane refuses instead. `tests/components/studio/embedded-source.test.tsx`
   * drives clear-then-withdraw and asserts that not one request left this shell.
   */
  const sourceFailure =
    sourceTab?.failure ??
    (conn.sourceReader === undefined && sourceTab?.document === undefined
      ? "This host no longer reads object definitions, so this definition cannot be read here."
      : undefined);

  /**
   * What every statement entry point OUTSIDE the editor pane is handed while a Source tab is
   * active (#789 Phase 2).
   *
   * The pane below branches around the toolbar AND the editor together, so a Source tab draws
   * no Run button. That covers the editor and nothing else, and this shell has exactly one
   * other entry point in the class, which is an entry point that reads or WRITES the active
   * tab's statement: `BottomPanel`'s `onLoadQuery`, which is rendered outside that branch and
   * is wired inside the panel to both `QueryHistory`'s and `SavedQueries`' `onSelectQuery`.
   * Without this, opening History over a Source tab and clicking a past query wrote a statement
   * onto a tab whose pane shows a read-only definition, and `use-tab-manager` persists it.
   *
   * `DataImportModal` and `TestDataGenerator` are deliberately NOT gated, on the same reasoning
   * the standalone shell states: they call `executeQuery(sql)` with THEIR OWN statement aimed at
   * an object the reader picked, an override never writes the tab's `query`, and the result
   * lands in the panel below the definition.
   */
  const runsTheActiveTab = sourceTab === undefined;

  const { setTabs, activeTabId } = tabMgr;
  /**
   * What the source viewer writes back onto the tab it is mounted in (#789 Phase 2).
   *
   * MERGED BY SPREAD, so an explicitly-undefined key in the patch is a CLEAR rather than a
   * no-op, which is how the stale banner's re-read control puts the tab back into the state the
   * viewer reads from. STABLE across renders, because the viewer's read effect lists it among
   * its dependencies. Addressed by tab ID and not by `currentTab`, because an answer can land
   * after the reader has switched tabs and the patch belongs to the tab that asked for it.
   *
   * MEASURED, because a mutation asked the question: the tab this addresses is always the tab
   * that ASKED, even for an answer that lands after a switch, since the viewer holds the
   * `onChange` it was handed when it issued the read and that closure captured the then-active
   * id. So the `tab.source !== undefined` half is a shape guard the shell cannot currently make
   * false, and deleting it fails no test. It is kept rather than trimmed because it is what
   * makes the spread safe if a later patch ever reaches a tab that is not a Source tab, and
   * because `src/components/Studio.tsx` writes this identically: one writer shape across both
   * shells is worth more than one conjunct removed from one of them (#789).
   */
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
   * IT MOVES ITS OWN COUNTER AND CLEARS THE TAB, in one handler, which is what
   * `src/components/Studio.tsx` does for the same gesture. React commits both writes together, so
   * the pane re-renders once with `refreshToken = n+1` AND `document === undefined`, its read
   * effect issues a fresh read recording `tokenAtRead = n+1`, and the landed read writes
   * `readAtToken = n+1`. The tab that applied is therefore NOT marked stale, while every other open
   * Source tab is: the tab that applied knows what happened, the others know only that something
   * did.
   *
   * THIS OVERTURNS THE FIRST ANSWER, WHICH CLEARED NOTHING, and the reason it gave is written out
   * here because the reason is what was wrong rather than the taste. It said an automatic clear
   * "would leave a tab with no document, no failure and no reader, which is the one state that
   * would send the viewer's default reader at a route this package does not ship", and then said
   * `sourceFailure` above closes that door in the same render. It does, and a reason discharged
   * three lines below itself decides nothing. What the old behaviour actually produced is what
   * decided it: the reader was left looking at the definition the object NO LONGER HOLDS, under an
   * invitation to press "Read again", because a moved counter re-reads nothing on its own.
   * `needsRead` in `ObjectSourceView` is `document === undefined && failure === undefined`, so the
   * counter alone only makes `stale` true and draws the banner over stale bytes.
   *
   * THE WITHDRAWAL PATH IS DRIVEN AND NOT ARGUED. `tests/components/studio/embedded-source.test.tsx`
   * applies successfully and has the host withdraw `readObjectSource` in the same act the answer
   * lands: `sourceFailure` answers its sentence, `needsRead` is false, the pane refuses in the
   * viewer's own grammar, and not one request leaves this shell. That is the hazard the old reason
   * named, measured rather than reasoned about.
   *
   * NO TOAST, which is the one place the two shells still differ, and it is a measurement rather
   * than an omission. `src/components/Studio.tsx` announces the re-read with
   * `toast({ title: "Applied. Reading the definition again." })`, and `useToast` is a wrapper over
   * `sonner`, whose toasts render only into a mounted `<Toaster />`. That component is mounted in
   * `src/app/layout.tsx`, which belongs to the standalone application; `src/exports/` re-exports no
   * Toaster and this shell mounts none, so the same call in this file is a line no adopter can see
   * and no test can assert. MEASURED: added here, it killed zero tests in
   * `tests/components/studio/embedded-source.test.tsx` while deleting the clear killed three and
   * deleting the counter killed one. What announces the re-read here is the pane's own
   * `object-source-loading` region, which is an `output` element carrying an implicit
   * `role="status"`, so a screen reader is told the same thing by the surface that knows it.
   *
   * The DRAFT is not dropped here either. The pane drops it itself, keyed on the part its plan
   * was built for, which is a key this shell does not hold and must not guess.
   */
  const handleApplied = useCallback(() => {
    catalogChanged();
    onSourceChange({ document: undefined, failure: undefined, readAtToken: undefined });
  }, [catalogChanged, onSourceChange]);

  /**
   * The mirror, which also RETIRES the sentence the refusal left on screen (D82).
   *
   * The pane calls this with `false` both when the answer lands and when it unmounts, so the
   * refusal cannot outlive the window that raised it, and a reader who pressed the shortcut while
   * waiting is not left reading advice about a dialog that is gone.
   */
  const onApplyInFlightChange = useCallback((inFlight: boolean) => {
    setApplyInFlight(inFlight);
    if (!inFlight) setRefusedWhileApplying(false);
  }, []);

  const { addTab } = tabMgr;

  /**
   * The new-tab shortcut, REFUSED while an object apply is in flight, and answered out loud (D82).
   *
   * MEASURED on THIS shell and not carried over from the standalone one. `StudioTabBar` registers
   * the shortcut on `document` on purpose, so it works while Monaco owns focus (#745), and a
   * keydown from a control inside the apply dialog reaches that listener even though Radix has
   * aria-hidden and covered the strip. `addTab` ends with `setActiveTabId(newId)` and this shell
   * renders the Source pane only for an ACTIVE Source tab, so the new Query tab unmounted the pane
   * and took the dialog with it after the host's statement had been sent: the held `conflict` then
   * rendered nothing at all, and the one outcome that still reached the reader was `applied`,
   * through `onApplied`, which is the outcome they did not need to be told about.
   *
   * WHAT ELSE IS REACHABLE IN THIS WINDOW, ENUMERATED BY MEASUREMENT, because an unmeasured
   * "nothing else can reach this" is the mistake D82 was filed over. The dialog refuses every exit
   * it owns while `applying`: no close button, no Escape, no press outside. Everything else is
   * enumerated in two passes, KEYDOWN and CLICK, because the first pass alone answered a narrower
   * question than the paragraph claimed and a click moves the active tab here too.
   *
   * THE CLICK PASS first, since it is the larger one. Every mover of the active tab is a
   * `setActiveTabId` in `src/hooks/use-tab-manager.ts`, and `grep -n "setActiveTabId(" ` there
   * answers eleven calls: the four that restore a workspace at mount, which no gesture reaches,
   * `reopenClosedTab`, which is reached only from the Undo toast and this shell mounts no
   * `<Toaster />` for the reason `handleApplied` records, and SIX gestures. Those six are `addTab`,
   * `handleTableClick`, `handleGenerateSelect`, `openSourceTab` (twice, mint and focus), `closeTab`
   * and the setter `StudioTabBar` is handed directly. Four are refused here, all through
   * `refuseWhileApplying` above: this handler, `onTableClick`, and the row menu's
   * `onGenerateSelect` and `onViewSource`, the last of which the tree activation in
   * `onObjectClick` shares. Each is driven under the overlay in
   * `tests/components/studio/embedded-source.test.tsx`, by a DOM click on a row the Radix modal
   * has aria-hidden and covered, which is the one path that still reaches them.
   *
   * THE TAB STRIP'S OWN TWO ARE DELIBERATELY NOT REFUSED, and this is a decision with a cost
   * rather than a door nobody looked at. `onSetActiveTabId` and `onCloseTab` on `StudioTabBar`
   * below both move the active tab and both unmount this pane with the host's statement already
   * sent. They are left open because they are the reader's only way out of an apply that never
   * answers: the dialog refuses every exit it owns while `applying`, so a host whose `apply`
   * never settles would otherwise leave a shell in which no gesture works at all. The four
   * refusals above are gestures that open or focus ANOTHER tab, which is a loss the reader did not
   * ask for; the strip is the one place they say "leave this". The cost if that is the wrong call:
   * a reader who presses a tab under an overlay that stopped covering it loses the dialog and the
   * outcome of a statement already sent, exactly as D82 describes. `src/components/Studio.tsx`
   * leaves the same two open, so the two shells do not disagree.
   *
   * THE KEYDOWN PASS. What the dialog cannot refuse is a global listener, and
   * `grep -rE 'addEventListener\(\s*"keydown' src` answers FOUR, of which exactly one can move
   * the active tab here:
   *
   * - `src/components/studio/StudioTabBar.tsx:115`, on `document`: the new-tab shortcut, which is
   *   the one this handler guards. It opens a tab and `addTab` activates it.
   * - `src/components/DataProfiler.tsx:210`, on `document`, and MOUNTED BY THIS SHELL below. It is
   *   bound only while the profiler is open, it answers Escape alone, and all it does is call the
   *   profiler's `onClose`. It moves no tab, and it cannot unmount this pane.
   * - `src/components/CommandPalette.tsx:103`, on `document`, whose table rows call
   *   `handleTableClick` and DO move the active tab. That is the standalone shell's second gesture
   *   in D82, and this shell renders no palette. It is still the reason `onTableClick` above now
   *   carries the same guard: what keeps that door shut here is a covering overlay and a component
   *   this shell happens not to render, and neither is an absence.
   * - `src/components/ui/sidebar.tsx:94`, on `window`, toggling a sidebar. It is an unused shadcn
   *   primitive with no importer anywhere in `src` (P5), so it is not mounted here or anywhere.
   *
   * REFUSED IS NOT SWALLOWED, and on this shell that costs a surface rather than a toast. A
   * keystroke that does nothing and says nothing reads as a broken shortcut. `useToast` wraps
   * `sonner`, whose toasts render only into a mounted `<Toaster />`; this package re-exports none
   * and this shell mounts none, for the reason `handleApplied` above records, so the standalone
   * shell's toast would be a line no adopter can see. The refusal is therefore rendered by this
   * shell itself, as a live region, below.
   *
   * WHY REFUSE THE KEYSTROKE RATHER THAN KEEP THE PANE MOUNTED, chosen and not defaulted into, and
   * it is the same choice `src/components/Studio.tsx` made for the same seam: this shell renders
   * one pane, `onSourceChange` addresses `activeTabId`, and a second mounted pane would need its
   * own per-tab patch channel and a second live read, while the dialog it kept alive would be
   * drawn over a Query tab the reader had just asked for.
   *
   * The `+` button takes the same handler. It is covered by the modal and cannot be pressed in
   * this window, so the guard is unreachable through it, but one gesture and its keyboard twin
   * refusing on different rules is the drift this handler exists to prevent.
   */
  const handleAddTab = useCallback(() => {
    if (refuseWhileApplying()) return;
    addTab();
  }, [addTab, refuseWhileApplying]);

  /**
   * The row menu's actions in THIS shell, which is four of the six (U22, #789).
   *
   * The three modals below are mounted here and had nothing able to set their table once
   * the tree replaced the flat explorer, and `handleGenerateSelect` had no caller left in
   * this file at all. Each one follows the SAME feature flag as the modal it opens, so a
   * host that turned a feature off is not offered a menu item that opens nothing - and the
   * profiler follows `codeGenerator` because that is the flag its own mount is gated on.
   *
   * Per-table maintenance and creating a table are deliberately absent: this shell mounts
   * neither destination, and passed `onOpenMaintenance={noop}` and
   * `onCreateTableClick={undefined}` to the flat explorer before any of this. An absent
   * handler is an item the tree does not draw.
   *
   * Built inline, the same way `src/components/Studio.tsx` builds its own, so the two shells
   * do not disagree about one prop. A `useMemo` stood here and held nothing: `useTabManager`
   * returns a fresh object literal on every render, so `tabMgr` in the dependency list made
   * the memo recompute every time and the identity it was supposed to preserve changed
   * anyway. Memoising this for real means memoising what it closes over first, in both
   * shells, which is a change to those hooks rather than to this line.
   */
  const objectActions: TreeRowActionHandlers = {
    /*
     * REFUSED while an apply is in flight, like every other gesture that moves the active tab
     * (D82). `handleGenerateSelect` mints a `Query: <object>` tab and activates it, and this row
     * menu hangs off the SAME tree rows the activation above does, so it is reachable by exactly
     * the path that one is. The three modal openers below move no tab and are not guarded: they
     * set a path this shell renders a modal from, and the Source pane stays mounted behind it.
     */
    onGenerateSelect: (object) => {
      if (refuseWhileApplying()) return;
      tabMgr.handleGenerateSelect(object.path);
    },
    onProfileObject: features.codeGenerator ? (object) => setProfilerPath(object.path) : undefined,
    onGenerateCode: features.codeGenerator ? (object) => setCodeGenPath(object.path) : undefined,
    onGenerateTestData: features.testDataGenerator ? (object) => setTestDataPath(object.path) : undefined,
    /*
     * Passed ONLY where the host declared a source read (#789 Phase 2). An absent handler is an
     * item the tree does not draw, which is the rule the two handlers above this file already
     * withholds follow, and here it is what keeps a host that implements nothing from being
     * offered an action no route in this package can serve.
     */
    onViewSource:
      conn.sourceReader === undefined
        ? undefined
        : (object) => {
            if (refuseWhileApplying()) return;
            tabMgr.openSourceTab(object);
          },
  };

  // === No-op callbacks for disabled features ===
  /** What the panel group may hold: below the breakpoint, only the body panel. */
  const isMobile = useIsMobile();

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
        {/*
          Out of the group below the breakpoint rather than hidden inside it:
          react-resizable-panels 4 applies a `Panel`'s `className` to a NESTED div,
          so `hidden md:block` hid the sidebar's CONTENTS while the panel itself kept
          its 22% of the row — an empty column beside a squeezed body on a host's
          phone viewport. `src/components/Studio.tsx` carries the same guard.
        */}
        {!isMobile && (
          <>
            <ResizablePanel id="workspace-sidebar" defaultSize="22" minSize="15" maxSize="35">
              <Sidebar
                connections={conn.connections}
                activeConnection={conn.activeConnection}
                onSelectConnection={conn.setActiveConnection}
                onDeleteConnection={noop}
                onEditConnection={noop}
                onAddConnection={noop}
                onObjectClick={onObjectClick}
                objectActions={objectActions}
                onShowDiagram={features.schemaDiagram ? () => setShowDiagram(true) : undefined}
                metadata={conn.metadata}
                objectScanDeferred={conn.objectScanDeferred}
                onLoadObjects={conn.loadObjects}
                objectSource={conn.objectSource}
              />
            </ResizablePanel>
            <ResizableHandle className="w-1 bg-transparent hover:bg-brand-tint/30 transition-colors" />
          </>
        )}
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
              onAddTab={handleAddTab}
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
                        <SchemaDiagram
                          schema={conn.schema}
                          capabilities={conn.metadata?.capabilities}
                          onClose={() => setShowDiagram(false)}
                        />
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
                        {/*
                          One branch around the toolbar AND the editor together, so a Source tab
                          shows no Run button rather than a disabled one: there is nothing on a
                          definition to run, and a control that is present and refuses is a worse
                          answer than a control that is not there (#789 Phase 2).

                          THE CONNECTION IS NO LONGER PART OF THIS BRANCH, and that conjunct was
                          the third door onto the same hazard (#789 fix round 1). It read
                          `|| conn.activeConnection === null`, on a docblock arguing the state
                          was admitted by the type and not reached by the product. It is
                          reached: `use-connection-adapter.ts` auto-selects whenever the host's
                          list is non-empty, so a null active connection is exactly "the host
                          handed an empty connections array", which a host does when a person
                          deletes the last connection in its own UI while a Source tab is open.
                          The tab then came back labelled `Source: <name>` over an EMPTY,
                          EDITABLE buffer with a live Run button. The viewer now takes a
                          nullable connection and refuses in its own grammar, so the pane stays
                          a pane and no read is issued for a connection that is gone.
                        */}
                        {sourceTab === undefined ? (
                          <>
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
                              // no sandbox and no inline editing, so `transactionActive`
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
                                documentId={tabMgr.currentTab.id}
                                onContentChange={(val) => tabMgr.updateTabById(tabMgr.currentTab.id, { query: val })}
                                language={editorLanguageForTabType(tabMgr.currentTab.type)}
                                databaseType={conn.activeConnection?.type}
                                schemaContext={conn.schemaContext}
                                capabilities={conn.metadata?.capabilities}
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
                                The kind's own word from the DECLARATION, falling back to the id:
                                the viewer never derives a label from an id, and in this shell the
                                declaration is the host's, per connection. Both arms are
                                reachable - a host that declared no capabilities renders no tree
                                at all but can still restore a Source tab, and a declaration that
                                does not carry this tab's kind makes `findKind` answer undefined.
                              */
                              kindLabel={
                                (conn.metadata === null
                                  ? undefined
                                  : findKind(conn.metadata.capabilities, sourceTab.kind)?.label) ?? sourceTab.kind
                              }
                              displayName={objectPathLabel(sourceTab.path)}
                              document={sourceTab.document}
                              failure={sourceFailure}
                              activePartId={sourceTab.activePartId}
                              /*
                                A COUNTER THIS SHELL OWNS, and it counts TWO things: an object
                                apply this workspace issued that came back applied (#789 Phase 3),
                                and every `catalogChanged()` the host announces on the published
                                handle (D79). It was the constant zero until this phase, and that
                                was a DECISION and not a stub: the standalone shell increments a
                                catalog-change counter for everything it runs, and this shell runs
                                nothing, because every statement goes out through the host's
                                `onQueryExecute` and nothing reports back what it changed.

                                An apply broke the first half of that premise, because an apply
                                THIS shell issues IS a DDL this shell knows about, and D79 broke
                                the rest of it: the host can now say so itself. So the sentence
                                this block used to carry, that a stale banner means "this
                                workspace changed something" and its absence never means "nothing
                                changed", is REPLACED rather than kept, because it is no longer
                                what the counter counts.

                                WHAT IT COUNTS NOW, and it is still not "everything": an object
                                apply this workspace issued, plus every announcement the host
                                made. The host is the only party that can see a statement it ran
                                through `onQueryExecute` or outside this package altogether, so
                                the absence of a banner means "nothing this workspace ran changed
                                anything, and the host announced nothing" - which is the whole
                                truth for a host that calls the handle, and reads exactly as it
                                did before for a host that does not.
                              */
                              refreshToken={objectRefreshToken}
                              readAtToken={sourceTab.readAtToken}
                              reader={conn.sourceReader}
                              editingPartId={sourceTab.editingPartId}
                              dirty={sourceTab.dirty}
                              /*
                                WHO performs the apply, and `undefined` for a host that declared
                                no `objectEditor` (#789 Phase 3, discussion #778). Withholding it
                                is what keeps an existing adopter unchanged: with no `onApply` the
                                pane is exactly Phase 2, no bar and no sentence.

                                NOTHING HERE CONSULTS `conn.metadata.capabilities` for the edit
                                gate, and on this shell that matters more than on the standalone
                                one: this shell's declaration is the HOST's own, per connection,
                                and nothing type-checks a host. MEASURED with a stub host during
                                this phase's browser probe: the host declared `package`, the shell
                                drew a `Packages 1` folder for it, and the connected MariaDB had
                                no such thing. The affordance travels with the READ instead, on
                                the part, from whoever answered it.
                              */
                              onApply={conn.sourceApplier}
                              /*
                                The window D82 is about, published by the only party that can see
                                it (D82). The pane sends the statement and waits, and the shell
                                mirrors that into `applyInFlight` so `handleAddTab` above can
                                refuse the one document-level gesture that would unmount this pane
                                mid apply. Optional on the pane, so the standalone shell and this
                                one pass the same prop rather than each growing their own.
                              */
                              onApplyInFlightChange={onApplyInFlightChange}
                              onApplied={handleApplied}
                              onChange={onSourceChange}
                            />
                          </div>
                        )}
                      </div>
                    </ResizablePanel>
                    <ResizableHandle className="h-1 bg-fill hover:bg-brand-tint/20" />
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
          capabilities={conn.metadata?.capabilities}
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
          isOpen={profilerPath !== null}
          onClose={() => setProfilerPath(null)}
          tablePath={profilerPath ?? []}
          tableSchema={objectAtPath(conn.schema, profilerPath)}
          connection={conn.activeConnection}
          schemaContext={conn.schemaContext}
          databaseType={conn.activeConnection?.type}
        />
      )}

      {/* Code Generator */}
      {features.codeGenerator && (
        <CodeGenerator
          isOpen={codeGenPath !== null}
          onClose={() => setCodeGenPath(null)}
          tablePath={codeGenPath ?? []}
          tableSchema={objectAtPath(conn.schema, codeGenPath)}
          databaseType={conn.activeConnection?.type}
        />
      )}

      {/* Test Data Generator */}
      {features.testDataGenerator && (
        <TestDataGenerator
          isOpen={testDataPath !== null}
          onClose={() => setTestDataPath(null)}
          tablePath={testDataPath ?? []}
          tableSchema={objectAtPath(conn.schema, testDataPath)}
          databaseType={conn.activeConnection?.type}
          capabilities={conn.metadata?.capabilities}
          onExecuteQuery={(q) => queryExec.executeQuery(q)}
        />
      )}

      {/* Unlimited Query Warning */}
      <AlertDialog open={queryExec.unlimitedWarningOpen} onOpenChange={queryExec.setUnlimitedWarningOpen}>
        <AlertDialogContent className="bg-overlay border-hairline max-w-sm p-0 gap-0 overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-red-500/10 flex items-center justify-center shrink-0">
                <TriangleAlert strokeWidth={1.5} className="w-5 h-5 text-warning" />
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
              className="flex-1 h-9 bg-warning-solid border-0 text-white text-xs font-medium hover:bg-warning-solid-hover"
            >
              Load All
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/*
        The refusal, said where an adopter can actually read it AND where it can be announced (D82).

        `output` rather than a div with `role="status"`: it carries the live region natively, the
        same choice `LazyView` and the pane's own loading region make.

        PORTALED TO `document.body`, and that is what makes the live region real. Radix's modal
        calls `hideOthers`, which `aria-hidden`s everything outside the dialog, and this shell's own
        box is outside it. MEASURED with the refusal rendered inside the box, the apply dialog open:
        `ancestors-with-aria-hidden` answered `["DIV[aria-hidden=true]"]` and `queryAllByRole
        ("status")` answered the pane's `applying` region alone, so the sentence was on screen for a
        sighted reader and invisible to assistive technology. `hideOthers` marks the nodes that
        exist when the dialog opens and installs no observer (`node_modules/aria-hidden` carries no
        `MutationObserver`), so a body child created afterwards - which is exactly when this renders
        - is not marked: portaled, the same measurement answers `[]` and the region IS returned by
        `byRole("status")`. A portal is NOT this shell's house style for a float: `QuerySafetyDialog`
        and `DataProfiler`, both mounted below, are in-place `fixed inset-0 z-50` divs
        (`src/components/QuerySafetyDialog.tsx:216`, `src/components/DataProfiler.tsx:217`), and
        `DataProfiler.tsx:186-196` records staying inside the subtree as a deliberate choice. This
        one leaves the box because the live region needs it to, and for nothing else.

        FIXED, and that is a cost paid on purpose in an embeddable surface. This is the only
        viewport-fixed element the shell renders itself, so it paints in the HOST's chrome rather
        than in the workspace box, with no way for the host to place or style it.

        The alternative is not "put it in the box", but NOT because a sentence in the box cannot be
        seen. MEASURED in Chromium with the two layers reproduced - shell root static with
        `overflow-hidden` and no `transform`, an in-box child at `fixed z-[60]`, the dialog's
        body-level `fixed inset-0 z-50` overlay beside it - `elementFromPoint` at the child's centre
        answers the CHILD. The root builds no stacking context and does not clip a fixed descendant,
        so 7fe83dcc's in-box placement did paint over the overlay; what it cost was the live region,
        not the pixels. The same probe with a `transform` on that root answers the OVERLAY instead,
        because the box then becomes both the containing block and a stacking context. The host owns
        `className` and every wrapper above it, so that arm is theirs to reach and not ours to rule
        out, and being a body child removes it by construction: both layers are then in the root
        stacking context, and no `transform`, `filter` or `contain` on the host's side can become
        this element's containing block. The one placement that would cost the host nothing is
        inside the dialog, and that belongs to `ApplyPreviewDialog`, whose window this shell only
        observes.

        The cost the portal does pay is the FONT, and the colours are not part of it.
        `STUDIO_SCOPED_CSS` above scopes the font stack, `font-feature-settings` and
        `letter-spacing` to `[data-studio-workspace]` and re-asserts the family on every descendant,
        so a `document.body` child falls outside all of it: measured, the identical node renders in
        the workspace face at `letter-spacing: -0.011em` inside the box and in the HOST page's face
        at `letter-spacing: normal` on the body. The `--studio-*` colour tokens are declared on
        `:root` and `.dark` in `src/styles/theme.css`, which `build:lib` ships, so `bg-overlay`,
        `border-hairline` and `text-fg` read the same either side. That font hazard is the one
        `DataProfiler.tsx:186-196` weighs the other way; here two sentences of chrome in the host's
        own font is the smaller loss against a refusal no screen reader is told about.

        Rendered only while the refusal is live: the mirror above clears it the moment the apply
        answers or the pane goes away, so it cannot linger over a dialog that is gone.
      */}
      {refusedWhileApplying &&
        createPortal(
          <output
            data-testid="workspace-apply-refusal"
            className="fixed bottom-4 right-4 z-[60] max-w-sm rounded-lg border border-hairline bg-overlay px-4 py-3 shadow-lg"
          >
            <span className="block text-xs font-medium text-fg">Waiting for the apply to answer</span>
            <span className="mt-1 block text-xs leading-relaxed text-fg-muted">
              Opening a tab would close this dialog before the apply reports. Try again once you have read the answer.
            </span>
          </output>,
          document.body,
        )}

      {/* Mobile Navigation — hidden in embedded mode, platform provides its own */}
    </div>
  );
}
