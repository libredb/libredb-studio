"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import { generateTableQuery, generateSelectQuery, objectSegment } from "@/lib/query-generators";
import { pathKey } from "@/lib/db/object-path";
import { resolveTabType } from "@/lib/editor/tab-language";
import { logger } from "@/lib/logger";
import { newLocalId } from "@/lib/ids";

const DEFAULT_TAB: QueryTab = {
  id: "default",
  name: "Query 1",
  query: "",
  result: null,
  isExecuting: false,
  type: "sql",
};

const WORKSPACE_STORAGE_PREFIX = "libredb_workspace_tabs_v1";

interface PersistedTabState {
  id: string;
  name: string;
  query: string;
  type: QueryTab["type"];
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

  const closeTab = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setTabs((prev) => {
        if (prev.length === 1) return prev;
        const newTabs = prev.filter((t) => t.id !== id);
        if (activeTabId === id && newTabs.length > 0) {
          setActiveTabId(newTabs[newTabs.length - 1].id);
        }
        return newTabs;
      });
    },
    [activeTabId],
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
  };
}
