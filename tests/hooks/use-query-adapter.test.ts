import "../setup-dom";
import "../helpers/mock-sonner";

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";

import { useQueryAdapter } from "@/workspace/hooks/use-query-adapter";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { WorkspaceQueryResult, WorkspaceFeatures } from "@/workspace/types";
import { mockToastSuccess, mockToastError } from "../helpers/mock-sonner";

// ── Test Data ───────────────────────────────────────────────────────────────

const makeConnection = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection => ({
  id: "conn-1",
  name: "Test DB",
  type: "postgres",
  createdAt: new Date(),
  managed: true,
  ...overrides,
});

const makeTab = (overrides: Partial<QueryTab> = {}): QueryTab => ({
  id: "tab-1",
  name: "Query 1",
  query: "SELECT * FROM users",
  result: null,
  isExecuting: false,
  type: "sql",
  ...overrides,
});

const makeQueryResult = (overrides: Partial<WorkspaceQueryResult> = {}): WorkspaceQueryResult => ({
  rows: [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ],
  fields: ["id", "name"],
  rowCount: 2,
  executionTime: 42,
  pagination: {
    limit: 500,
    offset: 0,
    hasMore: false,
    totalReturned: 2,
    wasLimited: false,
  },
  ...overrides,
});

// ── Helper for mutable tabs array ────────────────────────────────────────────

function createMutableTabs(initial: QueryTab[]) {
  const tabs = [...initial];
  const setTabs = (fn: (prev: QueryTab[]) => QueryTab[]) => {
    const updated = fn(tabs);
    tabs.splice(0, tabs.length, ...updated);
  };
  return { tabs, setTabs: setTabs as unknown as React.Dispatch<React.SetStateAction<QueryTab[]>> };
}

// ── Default hook params factory ──────────────────────────────────────────────

function makeHookParams(overrides: Record<string, unknown> = {}) {
  const defaultTab = makeTab();
  const { tabs, setTabs } = createMutableTabs([defaultTab]);
  const onQueryExecute = mock(() => Promise.resolve(makeQueryResult()));
  const fetchSchema = mock(() => Promise.resolve());

  return {
    activeConnection: makeConnection(),
    onQueryExecute,
    tabs,
    activeTabId: "tab-1",
    currentTab: defaultTab,
    setTabs,
    fetchSchema,
    features: {} as Partial<WorkspaceFeatures>,
    ...overrides,
  };
}

// =============================================================================
// useQueryAdapter Tests
// =============================================================================
describe("useQueryAdapter", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  // ── executeQuery calls onQueryExecute with correct connectionId and sql ────

  test("executeQuery calls onQueryExecute with correct connectionId and sql", async () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1");
    });

    expect(params.onQueryExecute).toHaveBeenCalledTimes(1);
    expect(params.onQueryExecute).toHaveBeenCalledWith("conn-1", "SELECT 1");
  });

  // ── executeQuery uses tab query when no override provided ──────────────────

  test("executeQuery uses tab query when no override provided", async () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      await result.current.executeQuery();
    });

    expect(params.onQueryExecute).toHaveBeenCalledTimes(1);
    expect(params.onQueryExecute).toHaveBeenCalledWith("conn-1", "SELECT * FROM users");
  });

  // ── Returns error state when onQueryExecute throws ─────────────────────────

  test("returns error state when onQueryExecute throws (tab not stuck in executing)", async () => {
    const defaultTab = makeTab();
    const { tabs, setTabs } = createMutableTabs([defaultTab]);
    const onQueryExecute = mock(() => Promise.reject(new Error("Connection refused")));

    const params = makeHookParams({
      onQueryExecute,
      tabs,
      setTabs,
      currentTab: defaultTab,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1");
    });

    // Tab should NOT be stuck in isExecuting
    expect(tabs[0].isExecuting).toBe(false);

    // Error toast should have been called
    expect(mockToastError).toHaveBeenCalled();
  });

  // ── cancelQuery sets executing to false ────────────────────────────────────

  test("cancelQuery sets executing to false", () => {
    const defaultTab = makeTab({ isExecuting: true });
    const { tabs, setTabs } = createMutableTabs([defaultTab]);

    const params = makeHookParams({
      tabs,
      setTabs,
      currentTab: defaultTab,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    act(() => {
      result.current.cancelQuery();
    });

    expect(tabs[0].isExecuting).toBe(false);

    // Should show cancellation toast
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  // ── bottomPanelMode defaults to 'results' ──────────────────────────────────

  test("bottomPanelMode defaults to results", () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    expect(result.current.bottomPanelMode).toBe("results");
  });

  // ── historyKey increments after successful query ───────────────────────────

  test("historyKey increments after successful query", async () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    expect(result.current.historyKey).toBe(0);

    await act(async () => {
      await result.current.executeQuery("SELECT 1");
    });

    expect(result.current.historyKey).toBe(1);

    await act(async () => {
      await result.current.executeQuery("SELECT 2");
    });

    expect(result.current.historyKey).toBe(2);
  });

  // ── executeQuery toasts error when no connection ───────────────────────────

  test("executeQuery toasts error when no connection", async () => {
    const params = makeHookParams({
      activeConnection: null,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1");
    });

    // onQueryExecute should NOT be called
    expect(params.onQueryExecute).not.toHaveBeenCalled();

    // Should toast error
    expect(mockToastError).toHaveBeenCalled();
  });

  // ── executeQuery toasts error when query is empty ──────────────────────────

  test("executeQuery toasts error when query is empty", async () => {
    const defaultTab = makeTab({ query: "" });
    const params = makeHookParams({
      currentTab: defaultTab,
      tabs: [defaultTab],
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      await result.current.executeQuery();
    });

    expect(params.onQueryExecute).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalled();
  });

  // ── executeQuery updates tab with result data ──────────────────────────────

  test("executeQuery updates tab with result data", async () => {
    const defaultTab = makeTab();
    const { tabs, setTabs } = createMutableTabs([defaultTab]);
    const queryResult = makeQueryResult();
    const onQueryExecute = mock(() => Promise.resolve(queryResult));

    const params = makeHookParams({
      onQueryExecute,
      tabs,
      setTabs,
      currentTab: defaultTab,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    expect(tabs[0].result).not.toBeNull();
    expect(tabs[0].result!.rows).toEqual(queryResult.rows);
    expect(tabs[0].result!.fields).toEqual(queryResult.fields);
    expect(tabs[0].result!.rowCount).toBe(queryResult.rowCount);
    expect(tabs[0].isExecuting).toBe(false);
  });

  // ── setBottomPanelMode updates correctly ───────────────────────────────────

  test("setBottomPanelMode updates correctly", () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    act(() => {
      result.current.setBottomPanelMode("history");
    });

    expect(result.current.bottomPanelMode).toBe("history");
  });

  // ── safetyCheckQuery and setter work ───────────────────────────────────────

  test("safetyCheckQuery defaults to null and can be set", () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    expect(result.current.safetyCheckQuery).toBeNull();

    act(() => {
      result.current.setSafetyCheckQuery("DROP TABLE users");
    });

    expect(result.current.safetyCheckQuery).toBe("DROP TABLE users");
  });

  // ── forceExecuteQuery calls onQueryExecute bypassing safety ────────────────

  test("forceExecuteQuery calls onQueryExecute for dangerous queries", async () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    // forceExecuteQuery should bypass safety check
    await act(async () => {
      result.current.forceExecuteQuery("DROP TABLE users");
      // Allow promise chain to resolve
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(params.onQueryExecute).toHaveBeenCalledWith("conn-1", "DROP TABLE users");
  });

  // ── executeQuery triggers safety check for dangerous queries ───────────────

  test("executeQuery sets safetyCheckQuery for dangerous queries instead of executing", async () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      await result.current.executeQuery("DROP TABLE users");
    });

    expect(result.current.safetyCheckQuery).toBe("DROP TABLE users");
    expect(params.onQueryExecute).not.toHaveBeenCalled();
  });

  /**
   * The same gate with a note above the statement (#294).
   *
   * This file uses the REAL `isDangerousQuery`, and this is the packaged product's
   * execution path - a host application embedding studio runs every query through
   * this adapter - so the annotated statement has to reach the dialog here, not
   * only in the predicate's own unit tests.
   */
  test("executeQuery sets safetyCheckQuery for a destructive statement behind a comment", async () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    const annotated = "-- cleanup\nDROP TABLE users";
    await act(async () => {
      await result.current.executeQuery(annotated);
    });

    expect(result.current.safetyCheckQuery).toBe(annotated);
    expect(params.onQueryExecute).not.toHaveBeenCalled();
  });

  // ── executeQuery leaves other tabs untouched ────────────────────────────────

  test("executeQuery updates only the target tab when multiple tabs exist", async () => {
    const targetTab = makeTab();
    const otherTab = makeTab({ id: "tab-2", name: "Query 2", query: "SELECT 2" });
    const { tabs, setTabs } = createMutableTabs([targetTab, otherTab]);

    const params = makeHookParams({
      tabs,
      setTabs,
      currentTab: targetTab,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1");
    });

    expect(tabs[0].result).not.toBeNull();
    expect(tabs[1].result).toBeNull();
    expect(tabs[1].isExecuting).toBe(false);
  });

  // ── executeQuery error leaves other tabs untouched ──────────────────────────

  test("executeQuery error resets only the target tab when multiple tabs exist", async () => {
    const targetTab = makeTab();
    const otherTab = makeTab({ id: "tab-2", name: "Query 2", query: "SELECT 2" });
    const { tabs, setTabs } = createMutableTabs([targetTab, otherTab]);
    const onQueryExecute = mock(() => Promise.reject(new Error("boom")));

    const params = makeHookParams({
      onQueryExecute,
      tabs,
      setTabs,
      currentTab: targetTab,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1");
    });

    expect(tabs[0].isExecuting).toBe(false);
    expect(tabs[1].result).toBeNull();
    expect(mockToastError).toHaveBeenCalled();
  });

  // ── forceExecuteQuery guards ────────────────────────────────────────────────

  test("forceExecuteQuery toasts error when no connection", () => {
    const params = makeHookParams({ activeConnection: null });

    const { result } = renderHook(() => useQueryAdapter(params));

    act(() => {
      result.current.forceExecuteQuery("DROP TABLE users");
    });

    expect(params.onQueryExecute).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalled();
  });

  test("forceExecuteQuery toasts error when query is empty", () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    act(() => {
      result.current.forceExecuteQuery("   ");
    });

    expect(params.onQueryExecute).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalled();
  });

  // ── forceExecuteQuery updates only the active tab ───────────────────────────

  test("forceExecuteQuery updates only the active tab and increments historyKey", async () => {
    const activeTab = makeTab();
    const otherTab = makeTab({ id: "tab-2", name: "Query 2", query: "SELECT 2" });
    const { tabs, setTabs } = createMutableTabs([activeTab, otherTab]);
    const queryResult = makeQueryResult();
    const onQueryExecute = mock(() => Promise.resolve(queryResult));

    const params = makeHookParams({
      onQueryExecute,
      tabs,
      setTabs,
      currentTab: activeTab,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      result.current.forceExecuteQuery("DROP TABLE users");
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(tabs[0].result).not.toBeNull();
    expect(tabs[0].result!.rows).toEqual(queryResult.rows);
    expect(tabs[0].isExecuting).toBe(false);
    expect(tabs[1].result).toBeNull();
    expect(result.current.historyKey).toBe(1);
  });

  // ── forceExecuteQuery error handling ────────────────────────────────────────

  test("forceExecuteQuery error resets executing state and toasts", async () => {
    const activeTab = makeTab();
    const otherTab = makeTab({ id: "tab-2", name: "Query 2", query: "SELECT 2" });
    const { tabs, setTabs } = createMutableTabs([activeTab, otherTab]);
    const onQueryExecute = mock(() => Promise.reject(new Error("Connection refused")));

    const params = makeHookParams({
      onQueryExecute,
      tabs,
      setTabs,
      currentTab: activeTab,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      result.current.forceExecuteQuery("DROP TABLE users");
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(tabs[0].isExecuting).toBe(false);
    expect(tabs[1].result).toBeNull();
    expect(mockToastError).toHaveBeenCalled();
  });

  // ── cancelQuery leaves non-executing tabs untouched ─────────────────────────

  test("cancelQuery leaves non-executing tabs untouched", () => {
    const executingTab = makeTab({ isExecuting: true });
    const idleTab = makeTab({ id: "tab-2", name: "Query 2", isExecuting: false });
    const { tabs, setTabs } = createMutableTabs([executingTab, idleTab]);

    const params = makeHookParams({
      tabs,
      setTabs,
      currentTab: executingTab,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    act(() => {
      result.current.cancelQuery();
    });

    expect(tabs[0].isExecuting).toBe(false);
    expect(tabs[1].isExecuting).toBe(false);
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  // ── handleLoadMore guards ───────────────────────────────────────────────────

  test("handleLoadMore returns early when there are no more pages", () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    act(() => {
      result.current.handleLoadMore();
    });

    expect(params.onQueryExecute).not.toHaveBeenCalled();
  });

  test("handleLoadMore returns early when no connection", () => {
    const tabWithMore = makeTab({
      result: {
        rows: [{ id: 1 }],
        fields: ["id"],
        rowCount: 1,
        executionTime: 10,
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 1, wasLimited: true },
      },
    });
    const { tabs, setTabs } = createMutableTabs([tabWithMore]);

    const params = makeHookParams({
      activeConnection: null,
      tabs,
      setTabs,
      currentTab: tabWithMore,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    act(() => {
      result.current.handleLoadMore();
    });

    expect(params.onQueryExecute).not.toHaveBeenCalled();
  });

  // ── handleLoadMore appends rows on success ──────────────────────────────────

  test("handleLoadMore appends rows to the current tab and preserves other tabs", async () => {
    const existingRows = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    const tabWithMore = makeTab({
      result: {
        rows: existingRows,
        fields: ["id", "name"],
        rowCount: 2,
        executionTime: 42,
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 2, wasLimited: true },
      },
    });
    const otherTab = makeTab({ id: "tab-2", name: "Query 2" });
    const { tabs, setTabs } = createMutableTabs([tabWithMore, otherTab]);
    const nextPage = makeQueryResult({
      rows: [
        { id: 3, name: "Carol" },
        { id: 4, name: "Dave" },
      ],
      pagination: { limit: 500, offset: 2, hasMore: false, totalReturned: 4, wasLimited: false },
    });
    const onQueryExecute = mock(() => Promise.resolve(nextPage));

    const params = makeHookParams({
      onQueryExecute,
      tabs,
      setTabs,
      currentTab: tabWithMore,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      result.current.handleLoadMore();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(onQueryExecute).toHaveBeenCalledWith("conn-1", "SELECT * FROM users", { limit: 500, offset: 2 });
    expect(tabs[0].result!.rows).toHaveLength(4);
    expect(tabs[0].result!.rowCount).toBe(4);
    expect(tabs[0].allRows).toHaveLength(4);
    expect(tabs[0].currentOffset).toBe(4);
    expect(tabs[0].isLoadingMore).toBe(false);
    expect(tabs[1].result).toBeNull();
  });

  // ── handleLoadMore error handling ───────────────────────────────────────────

  test("handleLoadMore error resets loading state and toasts", async () => {
    const tabWithMore = makeTab({
      result: {
        rows: [{ id: 1 }],
        fields: ["id"],
        rowCount: 1,
        executionTime: 10,
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 1, wasLimited: true },
      },
    });
    const otherTab = makeTab({ id: "tab-2", name: "Query 2" });
    const { tabs, setTabs } = createMutableTabs([tabWithMore, otherTab]);
    const onQueryExecute = mock(() => Promise.reject(new Error("timeout")));

    const params = makeHookParams({
      onQueryExecute,
      tabs,
      setTabs,
      currentTab: tabWithMore,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      result.current.handleLoadMore();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(tabs[0].isLoadingMore).toBe(false);
    expect(tabs[1].result).toBeNull();
    expect(mockToastError).toHaveBeenCalled();
  });

  // ── handleUnlimitedQuery guards ─────────────────────────────────────────────

  test("handleUnlimitedQuery no-ops without a pending query", () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    act(() => {
      result.current.handleUnlimitedQuery();
    });

    expect(params.onQueryExecute).not.toHaveBeenCalled();
  });

  test("handleUnlimitedQuery no-ops without a connection", () => {
    const params = makeHookParams({ activeConnection: null });

    const { result } = renderHook(() => useQueryAdapter(params));

    act(() => {
      result.current.setPendingUnlimitedQuery({ query: "SELECT * FROM big", tabId: "tab-1" });
    });

    act(() => {
      result.current.handleUnlimitedQuery();
    });

    expect(params.onQueryExecute).not.toHaveBeenCalled();
  });

  // ── handleUnlimitedQuery success path ───────────────────────────────────────

  test("handleUnlimitedQuery executes with unlimited flag and updates the target tab", async () => {
    const targetTab = makeTab();
    const otherTab = makeTab({ id: "tab-2", name: "Query 2" });
    const { tabs, setTabs } = createMutableTabs([targetTab, otherTab]);
    const queryResult = makeQueryResult();
    const onQueryExecute = mock(() => Promise.resolve(queryResult));

    const params = makeHookParams({
      onQueryExecute,
      tabs,
      setTabs,
      currentTab: targetTab,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    act(() => {
      result.current.setPendingUnlimitedQuery({ query: "SELECT * FROM big", tabId: "tab-1" });
      result.current.setUnlimitedWarningOpen(true);
    });

    await act(async () => {
      result.current.handleUnlimitedQuery();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(onQueryExecute).toHaveBeenCalledWith("conn-1", "SELECT * FROM big", { unlimited: true });
    expect(tabs[0].result).not.toBeNull();
    expect(tabs[0].result!.rows).toEqual(queryResult.rows);
    expect(tabs[0].isExecuting).toBe(false);
    expect(tabs[1].result).toBeNull();
    expect(result.current.unlimitedWarningOpen).toBe(false);
    expect(result.current.pendingUnlimitedQuery).toBeNull();
    expect(result.current.historyKey).toBe(1);
  });

  // ── handleUnlimitedQuery error handling ─────────────────────────────────────

  test("handleUnlimitedQuery error resets executing state and toasts", async () => {
    const targetTab = makeTab();
    const otherTab = makeTab({ id: "tab-2", name: "Query 2" });
    const { tabs, setTabs } = createMutableTabs([targetTab, otherTab]);
    const onQueryExecute = mock(() => Promise.reject(new Error("out of memory")));

    const params = makeHookParams({
      onQueryExecute,
      tabs,
      setTabs,
      currentTab: targetTab,
    });

    const { result } = renderHook(() => useQueryAdapter(params));

    act(() => {
      result.current.setPendingUnlimitedQuery({ query: "SELECT * FROM big", tabId: "tab-1" });
    });

    await act(async () => {
      result.current.handleUnlimitedQuery();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(tabs[0].isExecuting).toBe(false);
    expect(tabs[1].result).toBeNull();
    expect(mockToastError).toHaveBeenCalled();
    expect(result.current.pendingUnlimitedQuery).toBeNull();
  });
});
