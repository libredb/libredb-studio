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

  /**
   * The gate reads the statement under the ACTIVE CONNECTION's dialect (#292).
   *
   * This file uses the real predicate, so it is where the embedded path's dialect
   * channel is provable end to end: the same text is a commented-out note under
   * one connection's grammar and a `DELETE` the statement operates under
   * another's, and only the connection says which.
   */
  test("executeQuery reads the statement under the active connection's dialect", async () => {
    const hidden = "WITH t AS (\n  #- drop the ) SELECT here\n  SELECT id FROM logs\n) DELETE FROM users";

    const onMysql = makeHookParams({ activeConnection: makeConnection({ type: "mysql" }) });
    const { result: mysql } = renderHook(() => useQueryAdapter(onMysql));
    await act(async () => {
      await mysql.current.executeQuery(hidden);
    });

    expect(mysql.current.safetyCheckQuery).toBe(hidden);
    expect(onMysql.onQueryExecute).not.toHaveBeenCalled();
  });

  /**
   * The embedded path's half of #300: the default connection here is PostgreSQL,
   * where block comments NEST, so a comment carrying a second opener runs past the
   * `*\/` a flat reading stops at. Read flat, the word after that marker answered
   * for the statement - one the operator commented out, never in the dangerous set -
   * so the `DROP` reached the host application's executor with no confirmation. The
   * two shapes ask for different reasons: the balanced one because the `DROP` is now
   * read, the unbalanced one because the text cannot be resolved at all.
   */
  test.each<[string, string]>([
    ["a balanced nested comment", "/* outer /* inner */ still a note */ DROP TABLE users"],
    ["a nested comment that never closes", "/* outer /* inner */ DROP TABLE users"],
  ])("executeQuery sets safetyCheckQuery for a destructive statement behind %s", async (_label, hidden) => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    await act(async () => {
      await result.current.executeQuery(hidden);
    });

    expect(result.current.safetyCheckQuery).toBe(hidden);
    expect(params.onQueryExecute).not.toHaveBeenCalled();
  });

  /**
   * The embedded path's half of #297: a write hidden behind a run the reader cannot
   * resolve reaches the dialog instead of the server.
   *
   * This file uses the REAL predicate, so this is where the new rule is provable on
   * the packaged execution path rather than only in the predicate's unit tests. The
   * script is two statements under PostgreSQL's reading of `'\'` and one under
   * MySQL's; the gate cannot tell which, and it is the second statement that writes.
   */
  test("executeQuery sets safetyCheckQuery for a write hidden behind an unresolvable literal", async () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    const hidden = "SELECT '\\';\nUPDATE t SET x = 1";
    await act(async () => {
      await result.current.executeQuery(hidden);
    });

    expect(result.current.safetyCheckQuery).toBe(hidden);
    expect(params.onQueryExecute).not.toHaveBeenCalled();
  });

  /**
   * The other side of the same rule, on the same path: a statement whose runs all
   * resolve executes without a prompt even though it carries a backslash. The cost
   * of the rule above is a prompt for text that cannot be read, not for text that
   * contains an escape.
   */
  test("executeQuery runs a read whose literal resolves, backslash and all", async () => {
    const params = makeHookParams();

    const { result } = renderHook(() => useQueryAdapter(params));

    const escaped = "SELECT 'a\\nb' FROM t";
    await act(async () => {
      await result.current.executeQuery(escaped);
    });

    expect(result.current.safetyCheckQuery).toBeNull();
    expect(params.onQueryExecute).toHaveBeenCalledWith("conn-1", escaped);
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
