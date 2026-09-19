"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { DatabaseObject } from "@/lib/db/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import { generateTableQuery, generateSelectQuery, generateCountQuery, objectSegment } from "@/lib/query-generators";
import { objectPathLabel, pathKey } from "@/lib/db/object-path";
import { resolveTabType } from "@/lib/editor/tab-language";
import { logger } from "@/lib/logger";
import { newLocalId } from "@/lib/ids";

/** A tab `closeTab` removed, where it sat, and the workspace it sat in, so its Undo can put it back (#747). */
interface ClosedTab {
  tab: QueryTab;
  index: number;
  /** The tab to its right when it closed, or null when it was last: the anchor that survives other closes. */
  nextTabId: string | null;
  workspaceKey: string;
}

const DEFAULT_TAB: QueryTab = {
  id: "default",
  name: "Query 1",
  query: "",
  result: null,
  isExecuting: false,
  type: "sql",
};

/** The tab a Source read is mounted in: an ADDRESS, an empty query and no result (#789). */
function sourceTab(id: string, object: DatabaseObject): QueryTab {
  return {
    id,
    // The QUALIFIED path and not the object's label: two containers may hold a routine of the
    // same name, and the tab strip is the only place a reader can tell two open Source tabs
    // apart.
    name: `Source: ${objectPathLabel(object.path)}`,
    query: "",
    result: null,
    isExecuting: false,
    type: "sql",
    source: { path: object.path, kind: object.kind },
  };
}

const WORKSPACE_STORAGE_PREFIX = "libredb_workspace_tabs_v1";

interface PersistedTabState {
  id: string;
  name: string;
  query: string;
  type: QueryTab["type"];
  /**
   * A Source tab's ADDRESS, and never one character of its definition (#789 Phase 2).
   *
   * `SourceTabState` also carries the document, the failure sentence, the active part and the
   * read token; none of the four is written here, and the reason is arithmetic rather than
   * taste. This record is one `JSON.stringify` of the WHOLE workspace, written by the
   * `setItem` below with no `try`/`catch` around it, against an origin quota of about 5 MiB
   * that ten other collections in this application already share. A definition the user did
   * not type is unbounded from the shell's point of view - the route bounds one part at a
   * million characters - so persisting it is a `QuotaExceededError` waiting for a large enough
   * object, and the symptom would not be a broken Source tab: an uncaught throw in that timer
   * stops tab persistence for EVERYTHING.
   *
   * So a restored Source tab carries the address alone and RE-READS, which costs one request
   * per restored tab and is the same read the tab issued when it was opened. The viewer
   * already treats "no document and no failure" as its cue to read, so nothing else is needed
   * to make it happen.
   */
  source?: { path: readonly string[]; kind: string };
}

/**
 * Is what came back out of `JSON.parse` an ADDRESS, rather than something shaped like one?
 *
 * This is the first persisted field anything DEREFERENCES, and that is the whole reason it
 * needs a check the other four do not (#789 Phase 2, round 1 finding 2). `id`, `name`,
 * `query` and `type` are strings that get rendered; a truncated or hand-edited one is a wrong
 * label. `source` is branched on by the editor pane and its `path` is read by the viewer's
 * `pathKey(path)` on the first line of its body, so a record carrying `source: {}` renders a
 * pane that throws "undefined is not an object (evaluating 'path.join')". MEASURED before this
 * function existed: that throw happens during a mount rather than inside the LOAD effect's
 * `try`, nothing here catches it, there is no error boundary around the pane, and the whole
 * shell white-screens with the reader unable to reach the tab strip to close the tab.
 *
 * `source: null` was survivable only by accident: it threw on `tab.source.path` INSIDE the
 * effect's `try`, so the fallback ran and every other tab in the workspace was lost with it.
 * Both shapes are now dropped key by key, so a bad address costs its own tab's source arm and
 * nothing else. An unreadable stored value is not a state to recover into: the entry says the
 * tab is a Source tab and cannot say for which object, and the honest answer is the ordinary
 * empty tab the record's other four fields already describe.
 *
 * The elements of `path` are deliberately NOT walked. A non-string segment reaches the route,
 * which validates the whole request shape server-side and answers its own sentence, and the
 * viewer renders that sentence: one refusal in the pane beats a second vocabulary here.
 */
function isStoredSourceAddress(value: unknown): value is { path: readonly string[]; kind: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { path?: unknown; kind?: unknown };
  return Array.isArray(candidate.path) && typeof candidate.kind === "string";
}

interface PersistedWorkspaceState {
  activeTabId: string;
  tabs: PersistedTabState[];
}

interface UseTabManagerParams {
  activeConnection: DatabaseConnection | null;
  metadata: ProviderMetadata | null;
  schema: readonly DetailedObject[];
  persistWorkspace?: boolean;
}

export function useTabManager({ activeConnection, metadata, schema, persistWorkspace }: UseTabManagerParams) {
  const [tabs, setTabs] = useState<QueryTab[]>([DEFAULT_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>("default");
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState("");
  const [isWorkspaceHydrated, setIsWorkspaceHydrated] = useState(false);

  const workspaceKey = useMemo(
    () => `${WORKSPACE_STORAGE_PREFIX}:${activeConnection?.id ?? "default"}`,
    [activeConnection?.id],
  );
  const shouldPersistWorkspace = persistWorkspace ?? process.env.NODE_ENV !== "test";

  const currentTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  // LOAD EFFECT — restore tabs from localStorage on connection switch
  useEffect(() => {
    // Deliberate: this flag has no derivable value during render (it exists purely to gate
    // the SAVE EFFECT below from writing back a load in progress), so there is no "don't use
    // an effect" alternative here — it is intentionally the reset half of a two-effect
    // load/ready handshake, not state that could be computed instead of set.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsWorkspaceHydrated(false);
    if (!shouldPersistWorkspace) return;

    const storage = typeof globalThis !== "undefined" && "localStorage" in globalThis ? globalThis.localStorage : null;
    if (!storage) return;

    try {
      const raw = storage.getItem(workspaceKey);
      if (!raw) {
        setTabs([DEFAULT_TAB]);
        setActiveTabId(DEFAULT_TAB.id);
        return;
      }

      const parsed = JSON.parse(raw) as PersistedWorkspaceState;
      if (!parsed || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
        setTabs([DEFAULT_TAB]);
        setActiveTabId(DEFAULT_TAB.id);
        return;
      }

      const restoredTabs: QueryTab[] = parsed.tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        query: tab.query,
        type: tab.type,
        result: null,
        isExecuting: false,
        // The address only, and an absent OR malformed key stays absent: every record written
        // before this field existed is a tab that is not a Source tab, and there is no
        // migration because "no source" is exactly what those records mean. The three
        // read-state fields are deliberately not restored, so the viewer issues the read
        // (#789). See `isStoredSourceAddress` for why this one field is checked and the other
        // four are not.
        ...(isStoredSourceAddress(tab.source) ? { source: { path: tab.source.path, kind: tab.source.kind } } : {}),
      }));

      const hasActiveTab = restoredTabs.some((tab) => tab.id === parsed.activeTabId);
      setTabs(restoredTabs);
      setActiveTabId(hasActiveTab ? parsed.activeTabId : restoredTabs[0].id);
    } catch (error) {
      logger.warn("Failed to restore workspace tabs; falling back to a single empty tab", {
        route: "use-tab-manager",
        error: error instanceof Error ? error.message : String(error),
      });
      setTabs([DEFAULT_TAB]);
      setActiveTabId(DEFAULT_TAB.id);
    }
    // NOTE: hydration flag stays false — set by ready effect below.
  }, [workspaceKey, shouldPersistWorkspace]);

  // READY EFFECT — flips the flag on the first render after the LOAD EFFECT reset it
  useEffect(() => {
    if (!shouldPersistWorkspace || isWorkspaceHydrated) return;
    // Deliberate: this is the flip half of the same handshake as the LOAD EFFECT's reset
    // above — it must run in an effect because it depends on that reset having already
    // committed. The flag is the only trigger it needs: the LOAD EFFECT is the sole writer
    // of `tabs`/`activeTabId` on a connection switch and it resets the flag in the same
    // pass, so every render in which this effect has work to do is already a render in
    // which `isWorkspaceHydrated` changed. Listing the tabs here only re-ran the guard.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsWorkspaceHydrated(true);
  }, [shouldPersistWorkspace, isWorkspaceHydrated]);

  // SAVE EFFECT — debounced write to localStorage (500ms)
  useEffect(() => {
    if (!shouldPersistWorkspace) return;
    const storage = typeof globalThis !== "undefined" && "localStorage" in globalThis ? globalThis.localStorage : null;
    if (!isWorkspaceHydrated || !storage) return;

    const timer = setTimeout(() => {
      const serialized: PersistedWorkspaceState = {
        activeTabId,
        tabs: tabs.map((tab) => ({
          id: tab.id,
          name: tab.name,
          query: tab.query,
          type: tab.type,
          // Two fields of `SourceTabState` and never the other four: see `PersistedTabState`.
          ...(tab.source === undefined ? {} : { source: { path: tab.source.path, kind: tab.source.kind } }),
        })),
      };
      storage.setItem(workspaceKey, JSON.stringify(serialized));
    }, 500);

    return () => clearTimeout(timer);
  }, [tabs, activeTabId, workspaceKey, shouldPersistWorkspace, isWorkspaceHydrated]);

  const updateTabById = useCallback((tabId: string, updates: Partial<QueryTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...updates } : t)));
  }, []);

  const updateCurrentTab = useCallback(
    (updates: Partial<QueryTab>) => {
      updateTabById(activeTabId, updates);
    },
    [activeTabId, updateTabById],
  );

  const addTab = useCallback(() => {
    const newId = newLocalId();
    setTabs((prev) => [
      ...prev,
      {
        id: newId,
        name: `Query ${prev.length + 1}`,
        query: "",
        result: null,
        isExecuting: false,
        type: resolveTabType(metadata?.capabilities),
      },
    ]);
    setActiveTabId(newId);
  }, [metadata]);

  /*
   * The Undo toasts still on screen, and the workspace the hook is showing (#747).
   *
   * Each toast closes over the tab it names rather than sharing one "last closed" slot: sonner
   * keeps several toasts up at once, so a shared slot let the Undo under `Closed "Query 1"`
   * restore Query 2. A closed tab belongs to the workspace it was closed in, so a connection
   * switch dismisses the outstanding toasts, and a click that lands during the dismissal is
   * checked against the workspace key: restoring it into another connection duplicated the
   * `default` id there and the SAVE EFFECT persisted the duplicate.
   */
  const undoToastIdsRef = useRef<Array<string | number>>([]);
  const workspaceKeyRef = useRef(workspaceKey);
  useEffect(() => {
    workspaceKeyRef.current = workspaceKey;
    for (const id of undoToastIdsRef.current) toast.dismiss(id);
    undoToastIdsRef.current = [];
  }, [workspaceKey]);

  const reopenClosedTab = useCallback((closed: ClosedTab) => {
    if (closed.workspaceKey !== workspaceKeyRef.current) return;
    setTabs((prev) => {
      // A tab id is unique in a workspace. It is already present when this Undo was clicked
      // before, or when a Source tab, whose id is derived from its address, was opened again.
      if (prev.some((t) => t.id === closed.tab.id)) return prev;
      // Back before its right-hand neighbour when that tab is still open. The index alone is
      // stale as soon as another tab to its left closes too, which is the ordinary way to tidy up.
      const anchor = closed.nextTabId === null ? -1 : prev.findIndex((t) => t.id === closed.nextTabId);
      const next = [...prev];
      next.splice(anchor === -1 ? Math.min(closed.index, next.length) : anchor, 0, closed.tab);
      return next;
    });
    setActiveTabId(closed.tab.id);
  }, []);

  const closeTab = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (tabs.length === 1) return;
      const index = tabs.findIndex((t) => t.id === id);
      if (index === -1) return;
      const closed: ClosedTab = { tab: tabs[index], index, nextTabId: tabs[index + 1]?.id ?? null, workspaceKey };

      // The last-tab guard is evaluated again inside the updater, against the state actually
      // being written: two closes batched into one commit both pass the check above.
      setTabs((prev) => (prev.length === 1 ? prev : prev.filter((t) => t.id !== id)));
      if (activeTabId === id) {
        const remaining = tabs.filter((t) => t.id !== id);
        setActiveTabId(remaining[remaining.length - 1].id);
      }

      const toastId = toast(`Closed "${closed.tab.name}"`, {
        action: { label: "Undo", onClick: () => reopenClosedTab(closed) },
      });
      undoToastIdsRef.current.push(toastId);
    },
    [tabs, activeTabId, workspaceKey, reopenClosedTab],
  );

  /**
   * Open a tab holding the statement for one object and RUN it. Takes the object's PATH
   * and nothing else (#789).
   *
   * The path is the address and the name is only a label (standing ruling 2), so the
   * lookup that finds this object's columns joins on the path, segment by segment, the
   * same key `describeObjects` joins on. It used to compare `t.name === tableName`, which
   * both missed an object outside the session default container and could match the wrong
   * one where two containers hold the same name.
   *
   * The tab is still named after the object's own segment, which is what it was named
   * before: a tab reading `customers` over a statement that says `app.customers` is the
   * label doing its job.
   *
   * Takes executeQuery as a callback param to avoid a circular dependency.
   */
  const handleTableClick = useCallback(
    (path: readonly string[], executeQueryFn: (query: string, tabId: string) => void) => {
      const capabilities = metadata?.capabilities;
      const tableName = objectSegment(path);
      // Look the object up exactly as handleGenerateSelect does: the Redis generator is
      // type-aware, and the sampled key type lives on the schema node's `type` column (#427).
      const key = pathKey(path);
      const table = schema.find((t) => pathKey(t.path) === key);
      const columns = table?.columns || [];
      const newQuery = capabilities
        ? generateTableQuery(path, capabilities, columns)
        : `SELECT * FROM ${path.join(".")} LIMIT 50;`;

      const newId = newLocalId();
      const newTab: QueryTab = {
        id: newId,
        name: tableName,
        query: newQuery,
        result: null,
        isExecuting: false,
        type: resolveTabType(capabilities),
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newId);
      setTimeout(() => executeQueryFn(newQuery, newId), 100);
    },
    [metadata, schema],
  );

  /** The same address and the same join as `handleTableClick`, without the run (#789). */
  const handleGenerateSelect = useCallback(
    (path: readonly string[]) => {
      const capabilities = metadata?.capabilities;
      const tableName = objectSegment(path);
      const key = pathKey(path);
      const table = schema.find((t) => pathKey(t.path) === key);
      const columns = table?.columns || [];

      const newQuery = capabilities
        ? generateSelectQuery(path, columns, capabilities)
        : `SELECT\n${columns.map((c) => `  ${c.name}`).join(",\n") || "  *"}\nFROM ${path.join(".")}\nWHERE 1=1\nLIMIT 100;`;

      const tabType = resolveTabType(capabilities);

      const newId = newLocalId();
      setTabs((prev) => [
        ...prev,
        {
          id: newId,
          name: `Query: ${tableName}`,
          query: newQuery,
          result: null,
          isExecuting: false,
          type: tabType,
        },
      ]);
      setActiveTabId(newId);
    },
    [metadata, schema],
  );

  const handleGenerateCount = useCallback(
    (path: readonly string[]) => {
      const capabilities = metadata?.capabilities;
      if (capabilities === undefined) return;
      const query = generateCountQuery(path, capabilities);
      if (query === null) return;
      const id = newLocalId();
      setTabs((prev) => [
        ...prev,
        {
          id,
          name: `Count: ${objectSegment(path)}`,
          query,
          result: null,
          isExecuting: false,
          type: resolveTabType(capabilities),
        },
      ]);
      setActiveTabId(id);
    },
    [metadata],
  );

  /**
   * Open one object's DEFINITION in a read-only Source tab, or focus the one already open
   * against that object (#789 Phase 2).
   *
   * The tab carries the ADDRESS and nothing else. It holds no document, no failure and no
   * read token, and that absence is the instruction: the viewer reads when it is handed
   * neither, so a freshly opened tab and a tab restored from storage take the same path.
   *
   * The match is `pathKey(path)` plus the KIND, and both halves are load-bearing.
   * `pathKey` rather than a join or a `JSON.stringify` per standing ruling 5g: its separator
   * is a control character no engine admits inside an identifier, so `["a.b"]` and
   * `["a", "b"]` cannot collide, while JSON escaping rewrites exotic names. And the kind,
   * because one name addresses more than one object of different kinds in one container on
   * MySQL, MariaDB and DuckDB, measured in this epic, so matching on the path alone would
   * focus the procedure's tab for a reader who asked for the table's definition.
   *
   * `type` is the neutral `"sql"`. Nothing reads it on a Source tab: the tab bar's icon and
   * the editor pane both branch on `source` being present, and the definition's own Monaco
   * language travels on the PART the provider built rather than on the tab.
   */
  const openSourceTab = useCallback(
    (object: DatabaseObject) => {
      const key = pathKey(object.path);
      const matchesAddress = (tab: QueryTab): boolean =>
        tab.source !== undefined && tab.source.kind === object.kind && pathKey(tab.source.path) === key;
      /*
       * A Source tab already open for this address is FOCUSED rather than minted again, and
       * the read from `tabs` here is the committed list, which is what carries the id of a
       * tab restored from `localStorage` with an id this function did not choose.
       */
      const open = tabs.find(matchesAddress);
      if (open !== undefined) {
        setActiveTabId(open.id);
        return;
      }
      /*
       * The id is DERIVED FROM THE ADDRESS rather than minted, and that is what makes two
       * opens inside one React batch safe (#789 Phase 2, round 1 finding 3).
       *
       * The defect: the dedup above reads the `tabs` of the render that built this callback,
       * so two calls in ONE batch both miss and, with a minted id, both append. The tab strip
       * then held two tabs with identical names, the first orphaned and read by nothing. Two
       * separate DOM events flush between them, which is why no gesture in this shell reaches
       * it; a host callback calling the embedded adapter twice does.
       *
       * MEASURED, and it is why the dedup was not simply moved inside the updater, which is
       * the obvious fix: `setActiveTabId` runs when the event runs, while the updater runs at
       * the next render, so an id resolved inside the updater is not yet known at the moment
       * the active tab is set. With that shape the strip held one tab and `activeTabId` named
       * the second call's unused id, so `currentTab` fell back to `tabs[0]` and the reader
       * pressing View Source twice landed on the query tab.
       *
       * Deriving the id closes both halves at once: both calls in the batch compute the same
       * id, so the second finds the first's append inside the updater and neither the strip
       * nor the active id can disagree. Uniqueness is not weakened: the address of a Source
       * tab is unique by construction, because this is the only function that mints one and
       * it refuses to mint a second for an address already open.
       *
       * ENCODED, and that is not decoration. Every other tab id in this shell is random
       * alphanumeric, and `StudioTabBar` moves focus with
       * `querySelector('[role="tab"][data-tab-id="<id>"]')`, so putting an object NAME inside
       * an id puts it inside a CSS selector. MEASURED: an Oracle-shaped routine segment,
       * `"char"(integer)`, made that selector invalid and the arrow key threw a DOMException
       * that took the whole strip down. `encodeURIComponent` leaves only characters an
       * attribute selector accepts, and it is applied to each part separately so the two
       * cannot run together: an encoded kind cannot contain the separator.
       */
      const newId = `source:${encodeURIComponent(object.kind)}:${encodeURIComponent(key)}`;
      setTabs((prev) => (prev.some(matchesAddress) ? prev : [...prev, sourceTab(newId, object)]));
      setActiveTabId(newId);
    },
    [tabs],
  );

  return {
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    currentTab,
    editingTabId,
    setEditingTabId,
    editingTabName,
    setEditingTabName,
    addTab,
    closeTab,
    updateCurrentTab,
    updateTabById,
    handleTableClick,
    handleGenerateSelect,
    handleGenerateCount,
    openSourceTab,
  };
}
