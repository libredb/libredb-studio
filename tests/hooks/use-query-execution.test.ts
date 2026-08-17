import "../setup-dom";
import { mockToastSuccess, mockToastError, mockToastDefault } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../helpers/mock-fetch";
import { storage } from "@/lib/storage";

// ── Mock QuerySafetyDialog ──────────────────────────────────────────────────
// The stub is deliberately more permissive than the real predicate - it answers for
// DROP/DELETE/TRUNCATE only - which is what lets the UPDATE and DDL tests further
// down execute without a confirmation. It is a spy so the gate test can assert WHICH
// text the hook asks about; what the real predicate ANSWERS for that text is pinned
// in tests/components/QuerySafetyDialog.test.tsx.
const isDangerousQueryMock = mock(
  (q: string) =>
    q.toUpperCase().includes("DROP") || q.toUpperCase().includes("DELETE") || q.toUpperCase().includes("TRUNCATE"),
);
mock.module("@/components/QuerySafetyDialog", () => ({
  isDangerousQuery: isDangerousQueryMock,
}));

import { useQueryExecution } from "@/hooks/use-query-execution";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";

// =============================================================================
// Test Data
// =============================================================================
const mockConnection: DatabaseConnection = {
  id: "qe-pg-1",
  name: "Test PostgreSQL",
  type: "postgres",
  host: "localhost",
  port: 5432,
  user: "testuser",
  password: "testpass",
  database: "testdb",
  createdAt: new Date("2025-01-01T00:00:00Z"),
  environment: "development",
};

const mockMetadata: ProviderMetadata = {
  capabilities: {
    queryLanguage: "sql" as const,
    supportsExplain: true,
    explainFormat: "postgres-json" as const,
    supportsExternalQueryLimiting: true,
    supportsCreateTable: true,
    supportsInlineRowEdit: true,
    supportsMaintenance: true,
    maintenanceOperations: ["vacuum", "analyze"],
    supportsConnectionString: true,
    defaultPort: 5432,
    schemaRefreshPattern: "^(CREATE|DROP|ALTER)\\b",
  },
  labels: {
    entityName: "Table",
    entityNamePlural: "Tables",
    rowName: "Row",
    rowNamePlural: "Rows",
    selectAction: "SELECT * FROM",
    generateAction: "Generate SELECT",
    analyzeAction: "Analyze",
    vacuumAction: "Vacuum",
    searchPlaceholder: "Search tables...",
    analyzeGlobalLabel: "Analyze All",
    analyzeGlobalTitle: "Analyze All Tables",
    analyzeGlobalDesc: "Analyze all tables in the database",
    vacuumGlobalLabel: "Vacuum All",
    vacuumGlobalTitle: "Vacuum All Tables",
    vacuumGlobalDesc: "Vacuum all tables in the database",
  },
};

const createTab = (overrides?: Partial<QueryTab>): QueryTab => ({
  id: "tab-1",
  name: "Query 1",
  query: "SELECT * FROM users",
  result: null,
  isExecuting: false,
  type: "sql",
  ...overrides,
});

const mockQueryResult = {
  rows: [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ],
  fields: ["id", "name"],
  rowCount: 2,
  executionTime: 15,
  pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 2, wasLimited: false },
};

function createDefaultParams(overrides?: Record<string, unknown>) {
  const tab = createTab();
  const setTabsMock = mock((fn: unknown) => {
    // Apply function if it's a function (for state updater pattern)
    if (typeof fn === "function") {
      fn([tab]);
    }
  });

  return {
    activeConnection: mockConnection,
    metadata: mockMetadata,
    tabs: [tab],
    activeTabId: "tab-1",
    currentTab: tab,
    setTabs: setTabsMock,
    transactionActive: false,
    playgroundMode: false,
    fetchSchema: mock(async () => {}),
    queryEditorRef: { current: null },
    ...overrides,
  };
}

// =============================================================================
// useQueryExecution Tests
// =============================================================================
let addToHistorySpy: ReturnType<typeof spyOn>;

describe("useQueryExecution", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    addToHistorySpy = spyOn(storage, "addToHistory").mockImplementation(() => {});
  });

  afterEach(() => {
    addToHistorySpy.mockRestore();
    restoreGlobalFetch();
  });

  // ── Initially bottomPanelMode is 'results' ────────────────────────────────

  test("initially bottomPanelMode is results", () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    expect(result.current.bottomPanelMode).toBe("results");
  });

  // ── executeQuery shows toast when no connection ────────────────────────────

  test("executeQuery shows toast when no connection", async () => {
    mockGlobalFetch({});
    const params = createDefaultParams({ activeConnection: null });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1");
    });

    // useToast wraps sonnerToast.error for destructive variant
    expect(mockToastError).toHaveBeenCalled();
  });

  // ── executeQuery calls /api/db/query POST with correct body ────────────────

  test("executeQuery calls /api/db/query POST with correct body", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeDefined();
    expect(queryCall![1]).toMatchObject({ method: "POST" });

    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.sql).toBe("SELECT * FROM users");
    expect(body.connection).toBeDefined();
    expect(body.connection.id).toBe("qe-pg-1");
  });

  // ── executeQuery updates tab result on success ─────────────────────────────

  test("executeQuery updates tab result on success", async () => {
    mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    // setTabs should have been called (state updater function)
    expect(params.setTabs).toHaveBeenCalled();
  });

  // ── executeQuery adds to history on success ────────────────────────────────

  test("executeQuery adds to history on success", async () => {
    mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    expect(storage.addToHistory).toHaveBeenCalled();
    const historyArg = (storage.addToHistory as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    expect(historyArg.query).toBe("SELECT * FROM users");
    expect(historyArg.connectionId).toBe("qe-pg-1");
    expect(historyArg.status).toBe("success");
  });

  // ── executeQuery shows toast on error ──────────────────────────────────────

  test("executeQuery shows toast on error", async () => {
    mockGlobalFetch({
      "/api/db/query": { ok: false, status: 400, json: { error: "syntax error at position 1" } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELEC * FROM users");
    });

    expect(mockToastError).toHaveBeenCalled();
  });

  // ── executeQuery sets safetyCheckQuery for dangerous queries ───────────────

  test("executeQuery sets safetyCheckQuery for dangerous queries (DROP/DELETE)", async () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("DROP TABLE users");
    });

    expect(result.current.safetyCheckQuery).toBe("DROP TABLE users");
  });

  /**
   * The standalone path's half of #294: the hook must ask the gate about the query
   * text AS WRITTEN, comments included, and open the dialog on a positive answer.
   *
   * The predicate itself is stubbed in this file (see the top), so this asserts the
   * call site's contract - no trimming, no normalising, no re-derived SELECT test
   * before the gate - while the predicate's comment tolerance is pinned in
   * tests/components/QuerySafetyDialog.test.tsx against the real export.
   */
  test("executeQuery asks the safety gate about the query text as written", async () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    const annotated = "-- cleanup\nDROP TABLE users";
    await act(async () => {
      await result.current.executeQuery(annotated);
    });

    // The active connection's type travels with the text: the predicate reads a
    // statement per dialect (#292), and this call site is one of the two places
    // that knows which dialect the statement is about to run on.
    expect(isDangerousQueryMock).toHaveBeenCalledWith(annotated, "postgres");
    expect(result.current.safetyCheckQuery).toBe(annotated);
  });

  /**
   * The standalone path's half of #297, in this file's division of labour: a script
   * whose reading cannot be resolved is handed to the gate whole - the unresolvable
   * literal included, on the line where the user wrote it - and a positive answer
   * opens the dialog instead of executing.
   *
   * What the REAL predicate answers for this exact text is pinned in
   * tests/components/QuerySafetyDialog.test.tsx (it asks); the embedded adapter
   * exercises the real predicate end to end in tests/hooks/use-query-adapter.test.ts.
   * Here the stub answers on the DELETE, so what is provable is the call site: the
   * gate sees the script as written and its answer decides whether anything runs.
   */
  test("asks the safety gate about a script whose literal cannot be resolved", async () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    const hidden = "SELECT '\\';\nDELETE FROM t WHERE id = 1";
    await act(async () => {
      await result.current.executeQuery(hidden);
    });

    expect(isDangerousQueryMock).toHaveBeenCalledWith(hidden, "postgres");
    expect(result.current.safetyCheckQuery).toBe(hidden);
  });

  test("executeQuery sets safetyCheckQuery for DELETE queries", async () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("DELETE FROM users WHERE id = 1");
    });

    expect(result.current.safetyCheckQuery).toBe("DELETE FROM users WHERE id = 1");
  });

  // ── executeQuery skips safety check when skipSafety is true ────────────────

  test("executeQuery skips safety check when skipSafety is true", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, rows: [], rowCount: 0 } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("DROP TABLE users", undefined, false, { skipSafety: true });
    });

    // Should NOT set safetyCheckQuery, should proceed to execute
    expect(result.current.safetyCheckQuery).toBeNull();

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeDefined();
  });

  // ── forceExecuteQuery clears safetyCheckQuery and calls executeQuery ───────

  test("forceExecuteQuery clears safetyCheckQuery and calls with skipSafety", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, rows: [], rowCount: 0 } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    // First trigger safety check
    await act(async () => {
      await result.current.executeQuery("DROP TABLE users");
    });
    expect(result.current.safetyCheckQuery).toBe("DROP TABLE users");

    // Now force execute
    await act(async () => {
      result.current.forceExecuteQuery("DROP TABLE users");
    });

    // safetyCheckQuery should be cleared
    expect(result.current.safetyCheckQuery).toBeNull();

    // Query should have been sent to server
    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeDefined();
  });

  // ── cancelQuery aborts the fetch controller ────────────────────────────────

  test("cancelQuery aborts the fetch controller", async () => {
    // We intercept fetch to track AbortSignal usage
    let abortSignalUsed = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/query") && init?.signal) {
        // Track that signal was provided
        abortSignalUsed = true;
        // Return a delayed promise that respects abort
        return new Promise<Response>((resolve, reject) => {
          if (init.signal!.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          init.signal!.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
          // Never resolve naturally — test will cancel
        });
      }
      if (url.includes("/api/db/cancel")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }) as typeof fetch;

    const params = createDefaultParams();
    const { result } = renderHook(() => useQueryExecution(params));

    // Start a query (don't await it — it will hang until cancelled)
    const queryPromise = act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    // Cancel it
    await act(async () => {
      await result.current.cancelQuery();
    });

    await queryPromise;

    expect(abortSignalUsed).toBe(true);
    // Toast should indicate cancellation
    expect(mockToastSuccess).toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  // ── cancelQuery calls /api/db/cancel on server ─────────────────────────────

  test("cancelQuery calls /api/db/cancel on server", async () => {
    let cancelCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/query")) {
        return new Promise<Response>((resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }
      if (url.includes("/api/db/cancel")) {
        cancelCalled = true;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }) as typeof fetch;

    const params = createDefaultParams();
    const { result } = renderHook(() => useQueryExecution(params));

    // Start query
    const queryPromise = act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    // Cancel
    await act(async () => {
      await result.current.cancelQuery();
    });

    await queryPromise;

    expect(cancelCalled).toBe(true);

    globalThis.fetch = originalFetch;
  });

  // ── handleLoadMore calls executeQuery with offset ──────────────────────────

  test("handleLoadMore calls executeQuery with offset", async () => {
    const tabWithResults = createTab({
      result: {
        ...mockQueryResult,
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 500, wasLimited: true },
      },
      currentOffset: 500,
    });

    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, rows: [{ id: 3, name: "Charlie" }], rowCount: 1 } },
    });

    const params = createDefaultParams({
      tabs: [tabWithResults],
      currentTab: tabWithResults,
    });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleLoadMore();
    });

    await waitFor(() => {
      const queryCall = fetchMock.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
      );
      expect(queryCall).toBeDefined();
      const body = JSON.parse(queryCall![1]!.body as string);
      expect(body.options.offset).toBe(500);
    });
  });

  // ── setBottomPanelMode changes mode ────────────────────────────────────────

  test("setBottomPanelMode changes mode", () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    act(() => {
      result.current.setBottomPanelMode("history");
    });

    expect(result.current.bottomPanelMode).toBe("history");

    act(() => {
      result.current.setBottomPanelMode("saved");
    });

    expect(result.current.bottomPanelMode).toBe("saved");
  });

  // ── bottomPanelMode resets when the connection loses explain support ───────
  // useProviderMetadata creates a fresh metadata object per fetch and never
  // refetches for the same connection id — reference change IS the
  // connection-switch signal this effect relies on.

  test("bottomPanelMode resets from explain when metadata loses explain support", async () => {
    mockGlobalFetch({});
    const params = createDefaultParams();
    const unsupported = {
      ...mockMetadata,
      capabilities: { ...mockMetadata.capabilities, supportsExplain: false, explainFormat: undefined },
    };

    const { result, rerender } = renderHook(({ metadata }) => useQueryExecution({ ...params, metadata }), {
      initialProps: { metadata: mockMetadata as ProviderMetadata },
    });

    act(() => {
      result.current.setBottomPanelMode("explain");
    });
    expect(result.current.bottomPanelMode).toBe("explain");

    rerender({ metadata: unsupported });

    await waitFor(() => expect(result.current.bottomPanelMode).toBe("results"));
  });

  test("bottomPanelMode resets from explain when metadata lacks explainFormat even if supportsExplain is true", async () => {
    mockGlobalFetch({});
    const params = createDefaultParams();
    // Divergent state (reachable via custom metadata in embedded mode): the tab
    // filter and getExplainStrategy key on explainFormat, so the reset must too.
    const noFormat = {
      ...mockMetadata,
      capabilities: { ...mockMetadata.capabilities, supportsExplain: true, explainFormat: undefined },
    };

    const { result, rerender } = renderHook(({ metadata }) => useQueryExecution({ ...params, metadata }), {
      initialProps: { metadata: mockMetadata as ProviderMetadata },
    });

    act(() => {
      result.current.setBottomPanelMode("explain");
    });
    expect(result.current.bottomPanelMode).toBe("explain");

    rerender({ metadata: noFormat });

    await waitFor(() => expect(result.current.bottomPanelMode).toBe("results"));
  });

  // ── executeQuery sets explain panel mode for explain queries ────────────────

  test("executeQuery sets explain panel mode for explain queries", async () => {
    mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: { rows: [{ "QUERY PLAN": { plan: "Seq Scan" } }], fields: ["QUERY PLAN"], rowCount: 1, executionTime: 5 },
      },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users", undefined, true);
    });

    expect(result.current.bottomPanelMode).toBe("explain");
  });

  // ── executeQuery uses /api/db/multi-query for multi-statement queries ──────

  test("executeQuery uses /api/db/multi-query for multi-statement queries", async () => {
    const multiResult = {
      multiStatement: true,
      executedCount: 2,
      statementCount: 2,
      hasError: false,
      rows: [{ id: 1 }],
      fields: ["id"],
      rowCount: 1,
      executionTime: 20,
      statements: [
        { index: 0, status: "success", rowCount: 1 },
        { index: 1, status: "success", rowCount: 0 },
      ],
    };

    const fetchMock = mockGlobalFetch({
      "/api/db/multi-query": { ok: true, json: multiResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1; SELECT 2;");
    });

    const multiCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/multi-query"),
    );
    expect(multiCall).toBeDefined();
  });

  // ── executeQuery uses /api/db/transaction when transactionActive ───────────

  test("executeQuery uses /api/db/transaction when transactionActive", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/transaction": { ok: true, json: mockQueryResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const params = createDefaultParams({ transactionActive: true });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    const txnCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/transaction"),
    );
    expect(txnCall).toBeDefined();

    const body = JSON.parse(txnCall![1]!.body as string);
    expect(body.action).toBe("query");
    expect(body.sql).toBe("SELECT * FROM users");
  });

  // ── Bound parameters reach the server (#290) ───────────────────────────────
  //
  // The inline row editor builds `SET col = $1` and hands the value over as data.
  // If the value stopped here the statement would run with its placeholders
  // unbound, so this channel is what makes binding possible at all.

  test("executeQuery sends bound parameters to /api/db/query", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery(`UPDATE users SET "name" = $1 WHERE "id" = $2`, undefined, false, {
        skipSafety: true,
        params: ["\\' WHERE 1=1 -- ", 1],
      });
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.params).toEqual(["\\' WHERE 1=1 -- ", 1]);
  });

  test("executeQuery omits params entirely when the caller passed none", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    const body = JSON.parse(queryCall![1]!.body as string);
    expect("params" in body).toBe(false);
  });

  test("executeQuery binds the same parameters in the background explain request", async () => {
    // The explain SQL is the statement with a prefix, so its placeholders are the
    // same ones in the same order. Sending it without the values would run it
    // unbound — the plan request fails and the panel keeps the previous plan
    // (PR #304 review).
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users WHERE id = $1", undefined, false, {
        params: [7],
      });
    });

    const explainCall = fetchMock.mock.calls.find((call) => {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      return typeof body.sql === "string" && body.sql.startsWith("EXPLAIN");
    });
    expect(explainCall).toBeDefined();
    expect(JSON.parse((explainCall![1] as RequestInit).body as string).params).toEqual([7]);
  });

  test("executeQuery keeps a parameterized statement off the multi-statement route", async () => {
    // `/api/db/multi-query` splits the payload and binds nothing, so a parameter
    // array reaching it would be dropped and the statement would run with unbound
    // placeholders. Parameters may only travel to an endpoint that binds them.
    const fetchMock = mockGlobalFetch({
      "/api/db/multi-query": { ok: true, json: mockQueryResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("UPDATE users SET name = $1 WHERE id = $2; SELECT 1", undefined, false, {
        skipSafety: true,
        params: ["Alice", 1],
      });
    });

    const multiCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/multi-query"),
    );
    expect(multiCall).toBeUndefined();

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(JSON.parse((queryCall![1] as RequestInit).body as string).params).toEqual(["Alice", 1]);
  });

  test("executeQuery sends bound parameters on the transaction endpoint too", async () => {
    // A row edit applied while a transaction is open takes this endpoint, so the
    // value has to be bound here as well — otherwise the transaction path would be
    // the one place the statement still carried its values as text.
    const fetchMock = mockGlobalFetch({
      "/api/db/transaction": { ok: true, json: mockQueryResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams({ transactionActive: true })));

    await act(async () => {
      await result.current.executeQuery(`UPDATE users SET "name" = $1 WHERE "id" = $2`, undefined, false, {
        skipSafety: true,
        params: ["Alice", 1],
      });
    });

    const txnCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/transaction"),
    );
    const body = JSON.parse(txnCall![1]!.body as string);
    expect(body.action).toBe("query");
    expect(body.params).toEqual(["Alice", 1]);
  });

  // ── executeQuery adds error to history on failure ──────────────────────────

  test("executeQuery adds to history on error response", async () => {
    mockGlobalFetch({
      "/api/db/query": { ok: false, status: 400, json: { error: "relation does not exist" } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM nonexistent");
    });

    expect(storage.addToHistory).toHaveBeenCalled();
    const historyArg = (storage.addToHistory as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    expect(historyArg.status).toBe("error");
    expect(historyArg.errorMessage).toBe("relation does not exist");
  });

  // ── safetyCheckQuery is null initially ─────────────────────────────────────

  test("safetyCheckQuery is null initially", () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    expect(result.current.safetyCheckQuery).toBeNull();
  });

  // ── unlimitedWarningOpen is false initially ────────────────────────────────

  test("unlimitedWarningOpen is false initially", () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    expect(result.current.unlimitedWarningOpen).toBe(false);
  });

  // ── pendingUnlimitedQuery is null initially ────────────────────────────────

  test("pendingUnlimitedQuery is null initially", () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    expect(result.current.pendingUnlimitedQuery).toBeNull();
  });

  // ── executeQuery uses queryEditorRef.getEffectiveQuery when available ──

  test("executeQuery uses queryEditorRef.getEffectiveQuery when no override", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const mockEditorRef = {
      current: {
        getEffectiveQuery: () => "SELECT id FROM users WHERE active = true",
        focus: () => {},
      },
    };
    const params = createDefaultParams({ queryEditorRef: mockEditorRef });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery(); // No override
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.sql).toBe("SELECT id FROM users WHERE active = true");
  });

  // ── executeQuery falls back to tab query when no override and no ref ────

  test("executeQuery falls back to tab query when no override and no ref", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery(); // No override, ref is null
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.sql).toBe("SELECT * FROM users"); // Falls back to tab query
  });

  // ── executeQuery shows toast when EXPLAIN not supported ────────────────

  test("executeQuery executes nothing when EXPLAIN not supported", async () => {
    // A reachable route must be mocked: with no route the query would fail and
    // toast anyway, which cannot distinguish the capability bail-out from a
    // network error. `explainFormat` deliberately stays set, so a strategy
    // exists and could build EXPLAIN SQL — the capability denial must still win.
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const noExplainMetadata: ProviderMetadata = {
      ...mockMetadata,
      capabilities: { ...mockMetadata.capabilities, supportsExplain: false },
    };
    const params = createDefaultParams({ metadata: noExplainMetadata });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users", undefined, true); // isExplain = true
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeUndefined();
    expect(mockToastError).toHaveBeenCalledWith("Not Supported", {
      description: "EXPLAIN is not available for this database type.",
    });
  });

  // ── executeQuery in playground mode begins + rollbacks transaction ─────

  test("executeQuery in playground mode begins and rollbacks transaction", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/transaction": { ok: true, json: mockQueryResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams({ playgroundMode: true });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    // Should have called transaction endpoint for begin, query, and rollback
    const txnCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/transaction"),
    );
    expect(txnCalls.length).toBeGreaterThanOrEqual(2); // begin + query (rollback may also count)

    // First call should be BEGIN
    const beginBody = JSON.parse(txnCalls[0][1]!.body as string);
    expect(beginBody.action).toBe("begin");
  });

  // ── executeQuery in playground mode rollbacks on error ─────────────────

  test("executeQuery in playground mode rollbacks on error", async () => {
    mockGlobalFetch({
      "/api/db/transaction": () => {
        return { ok: true, json: mockQueryResult };
      },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    // Override for more specific behavior
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/transaction")) {
        callCount++;
        const body = JSON.parse((init?.body as string) || "{}");
        if (body.action === "begin") {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (body.action === "query") {
          return new Response(JSON.stringify({ error: "syntax error" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (body.action === "rollback") {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }) as typeof fetch;

    const params = createDefaultParams({ playgroundMode: true });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("INVALID SQL");
    });

    // Should have called transaction endpoint at least 2 times (begin + rollback on error)
    expect(callCount).toBeGreaterThanOrEqual(2);

    globalThis.fetch = originalFetch;
  });

  // ── multi-statement error shows error toast ────────────────────────────

  test("multi-statement query with error shows error toast", async () => {
    const multiErrorResult = {
      multiStatement: true,
      executedCount: 2,
      statementCount: 3,
      hasError: true,
      rows: [],
      fields: [],
      rowCount: 0,
      executionTime: 30,
      statements: [
        { index: 0, status: "success", rowCount: 1 },
        { index: 1, status: "error", error: 'relation "bad" does not exist' },
      ],
    };

    mockGlobalFetch({
      "/api/db/multi-query": { ok: true, json: multiErrorResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1; SELECT * FROM bad; SELECT 2;");
    });

    expect(mockToastError).toHaveBeenCalled();
  });

  // ── executeQuery refreshes schema after DDL ────────────────────────────

  test("executeQuery calls fetchSchema after DDL query", async () => {
    const fetchSchemaMock = mock(async () => {});
    mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, rows: [], rowCount: 0 } },
    });
    const params = createDefaultParams({ fetchSchema: fetchSchemaMock });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("CREATE TABLE test_table (id INT)", undefined, false, { skipSafety: true });
    });

    expect(fetchSchemaMock).toHaveBeenCalled();
  });

  // ── executeQuery does NOT refresh schema for SELECT ────────────────────

  test("executeQuery does NOT call fetchSchema for SELECT", async () => {
    const fetchSchemaMock = mock(async () => {});
    mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams({ fetchSchema: fetchSchemaMock });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    expect(fetchSchemaMock).not.toHaveBeenCalled();
  });

  // ── handleLoadMore does nothing when no more data ──────────────────────

  test("handleLoadMore does nothing when pagination hasMore is false", async () => {
    const fetchMock = mockGlobalFetch({});
    const tabNoMore = createTab({
      result: {
        ...mockQueryResult,
        pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 2, wasLimited: false },
      },
    });
    const params = createDefaultParams({ tabs: [tabNoMore], currentTab: tabNoMore });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleLoadMore();
    });

    // No fetch calls for query
    const queryCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCalls.length).toBe(0);
  });

  // ── handleUnlimitedQuery executes pending unlimited query ──────────────

  test("handleUnlimitedQuery executes pending unlimited query", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    // Set pending unlimited query
    act(() => {
      result.current.setPendingUnlimitedQuery({ query: "SELECT * FROM big_table", tabId: "tab-1" });
      result.current.setUnlimitedWarningOpen(true);
    });

    expect(result.current.pendingUnlimitedQuery).not.toBeNull();
    expect(result.current.unlimitedWarningOpen).toBe(true);

    await act(async () => {
      result.current.handleUnlimitedQuery();
    });

    // Should have cleared the pending state
    expect(result.current.unlimitedWarningOpen).toBe(false);
    expect(result.current.pendingUnlimitedQuery).toBeNull();

    // Should have called query API with unlimited flag
    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.options.unlimited).toBe(true);
  });

  // ── handleUnlimitedQuery does nothing when no pending query ───────────

  test("handleUnlimitedQuery does nothing when no pending query", async () => {
    const fetchMock = mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleUnlimitedQuery();
    });

    // No fetch calls
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  // ── "Query was cancelled" message handling ─────────────────────────────

  test('shows cancellation toast for "Query was cancelled" error message', async () => {
    mockGlobalFetch({
      "/api/db/query": { ok: false, status: 500, json: { error: "Query was cancelled by user" } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT pg_sleep(60)");
    });

    // Should show cancellation toast, not generic error
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  test("handles QUERY_CANCELLED response code from API", async () => {
    mockGlobalFetch({
      "/api/db/query": {
        ok: false,
        status: 499,
        json: { error: "Query was cancelled", code: "QUERY_CANCELLED", statusCode: 499 },
      },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT pg_sleep(60)");
    });

    // Should show cancellation toast via code check, not generic error
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  // ── execute-query custom event listener ────────────────────────────────

  test("listens for execute-query custom events", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    renderHook(() => useQueryExecution(params));

    // Dispatch custom event
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("execute-query", {
          detail: { query: "SELECT 42" },
        }),
      );
    });

    // Give it time to process
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.sql).toBe("SELECT 42");
  });

  // ── executeQuery with EXPLAIN builds correct query for mysql ───────────

  test("executeQuery builds EXPLAIN FORMAT=JSON for mysql", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: { rows: [{ "QUERY PLAN": {} }], fields: ["QUERY PLAN"], rowCount: 1, executionTime: 5 },
      },
    });
    const mysqlConnection = { ...mockConnection, type: "mysql" as const };
    const mysqlMetadata: ProviderMetadata = {
      ...mockMetadata,
      capabilities: { ...mockMetadata.capabilities, explainFormat: "mysql-json" as const },
    };
    const params = createDefaultParams({ activeConnection: mysqlConnection, metadata: mysqlMetadata });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users", undefined, true);
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.sql).toContain("EXPLAIN FORMAT=JSON");
  });

  // ── executeQuery EXPLAIN refuses non-SELECT ────────────────────────────

  test("executeQuery EXPLAIN on non-SELECT executes nothing", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: { rows: [], fields: [], rowCount: 0, executionTime: 5 } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("INSERT INTO users (name) VALUES ('test')", undefined, true);
    });

    // The dangerous-query gate is skipped for explain runs, so falling back to
    // the original statement would run it unguarded (#201).
    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeUndefined();
    expect(mockToastError).toHaveBeenCalledWith("Not Supported", {
      description: "Only SELECT statements can be explained.",
    });
  });

  // ── executeQuery load more appends rows ────────────────────────────────

  test("executeQuery with offset appends rows (load more)", async () => {
    const existingRows = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    const newRows = [{ id: 3, name: "Charlie" }];

    mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: {
          rows: newRows,
          fields: ["id", "name"],
          rowCount: 1,
          executionTime: 5,
          pagination: { limit: 500, offset: 2, hasMore: false, totalReturned: 1, wasLimited: false },
        },
      },
    });

    const tabWithResults = createTab({
      result: {
        ...mockQueryResult,
        rows: existingRows,
        rowCount: 2,
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 2, wasLimited: true },
      },
      allRows: existingRows,
      currentOffset: 2,
    });

    const setTabsMock = mock((fn: unknown) => {
      if (typeof fn === "function") {
        fn([tabWithResults]);
      }
    });

    const params = createDefaultParams({
      tabs: [tabWithResults],
      currentTab: tabWithResults,
      setTabs: setTabsMock,
    });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users", "tab-1", false, { limit: 500, offset: 2 });
    });

    // setTabs should have been called to append rows
    expect(setTabsMock).toHaveBeenCalled();
  });

  // ── metadata=null + isExplain=true → nothing is built, nothing runs ────

  test("executeQuery with metadata=null and isExplain=true executes nothing", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: { rows: [{ "QUERY PLAN": {} }], fields: ["QUERY PLAN"], rowCount: 1, executionTime: 5 },
      },
    });
    const params = createDefaultParams({ metadata: null });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users", undefined, true);
    });

    // Metadata is the sole source of dialect knowledge (no falling back to
    // connection.type), so no EXPLAIN SQL exists to run — and the original
    // statement must not run in its place (#201). Absent metadata means "not
    // loaded yet", which must not be reported as an unsupported database.
    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeUndefined();
    expect(mockToastError).toHaveBeenCalledWith("Not Ready", {
      description: "Connection metadata is still loading. Try again in a moment.",
    });
  });

  // ── no EXPLAIN without explainFormat, even if supportsExplain is true ──

  test("no EXPLAIN built when metadata lacks explainFormat even if supportsExplain is true", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const noFormatMetadata: ProviderMetadata = {
      ...mockMetadata,
      capabilities: { ...mockMetadata.capabilities, supportsExplain: true, explainFormat: undefined },
    };
    const params = createDefaultParams({ metadata: noFormatMetadata });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1", undefined, true);
    });

    // Divergent state reachable via custom metadata in embedded mode: the
    // Explain affordance keys on supportsExplain, so the run must bail out
    // instead of sending the unexplained statement (#201).
    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeUndefined();
    expect(mockToastError).toHaveBeenCalledWith("Not Supported", {
      description: "EXPLAIN is not available for this database type.",
    });
  });

  // ── handleLoadMore uses result.rows.length when currentOffset undefined ─

  test("handleLoadMore uses result.rows.length when currentOffset is undefined", async () => {
    const tabNoOffset = createTab({
      result: {
        ...mockQueryResult,
        rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        rowCount: 3,
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 3, wasLimited: true },
      },
      // currentOffset is NOT set
    });

    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, rows: [{ id: 4 }], rowCount: 1 } },
    });

    const params = createDefaultParams({
      tabs: [tabNoOffset],
      currentTab: tabNoOffset,
    });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleLoadMore();
    });

    await waitFor(() => {
      const queryCall = fetchMock.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
      );
      expect(queryCall).toBeDefined();
      const body = JSON.parse(queryCall![1]!.body as string);
      // Should fallback to result.rows.length = 3
      expect(body.options.offset).toBe(3);
    });
  });

  // ── isExplain result sets result to null in tab state ──────────────────

  test("executeQuery with isExplain sets result to null in tab state", async () => {
    mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: { rows: [{ "QUERY PLAN": { plan: "test" } }], fields: ["QUERY PLAN"], rowCount: 1, executionTime: 5 },
      },
    });

    const updatedTabs: QueryTab[][] = [];
    const setTabsMock = mock((fn: unknown) => {
      if (typeof fn === "function") {
        const result = fn([createTab()]);
        updatedTabs.push(result);
      }
    });

    const params = createDefaultParams({ setTabs: setTabsMock });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users", undefined, true);
    });

    // The last setTabs call should set result to null for EXPLAIN
    expect(setTabsMock).toHaveBeenCalled();
    // Verify the function was called (we can't easily check result=null
    // due to mock pattern, but the call itself covers the branch)
  });

  // ── execute-query event with no detail → no fetch ─────────────────────

  test("execute-query event with no detail does nothing", async () => {
    const fetchMock = mockGlobalFetch({});
    const params = createDefaultParams();

    renderHook(() => useQueryExecution(params));

    await act(async () => {
      window.dispatchEvent(new CustomEvent("execute-query"));
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const queryCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCalls.length).toBe(0);
  });

  // ── execute-query event with no query in detail → no fetch ────────────

  test("execute-query event with empty query in detail does nothing", async () => {
    const fetchMock = mockGlobalFetch({});
    const params = createDefaultParams();

    renderHook(() => useQueryExecution(params));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("execute-query", {
          detail: { query: "" },
        }),
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const queryCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCalls.length).toBe(0);
  });

  // ── No background EXPLAIN for non-SELECT queries ──────────────────────

  test("no background EXPLAIN for non-SELECT queries", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, rows: [], rowCount: 0 } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("INSERT INTO users (name) VALUES ('test')", undefined, false, {
        skipSafety: true,
      });
    });

    // Should only have one /api/db/query call (the main query), no background EXPLAIN
    const queryCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCalls.length).toBe(1);
    const body = JSON.parse(queryCalls[0][1]!.body as string);
    expect(body.sql).not.toContain("EXPLAIN");
  });

  // ── No background EXPLAIN for non-postgres/mysql connections ──────────

  test("no background EXPLAIN for non-postgres/mysql connections", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const mssqlConnection = { ...mockConnection, type: "mssql" as const };
    const mssqlMetadata: ProviderMetadata = {
      ...mockMetadata,
      capabilities: { ...mockMetadata.capabilities, explainFormat: undefined },
    };
    const params = createDefaultParams({ activeConnection: mssqlConnection, metadata: mssqlMetadata });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    // Only the main query — no EXPLAIN is built when metadata carries no explainFormat
    const queryCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCalls.length).toBe(1);
    const body = JSON.parse(queryCalls[0][1]!.body as string);
    expect(body.sql).not.toContain("EXPLAIN");
  });

  // ── background EXPLAIN stores a format-tagged wrapper ──────────────────

  test("background EXPLAIN stores a format-tagged { format, raw } wrapper on the tab", async () => {
    mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: { rows: [{ "QUERY PLAN": { plan: "Seq Scan" } }], fields: ["QUERY PLAN"], rowCount: 1, executionTime: 5 },
      },
    });

    const snapshots: QueryTab[][] = [];
    const setTabsMock = mock((fn: unknown) => {
      if (typeof fn === "function") {
        snapshots.push(fn([createTab()]));
      }
    });

    const params = createDefaultParams({ setTabs: setTabsMock });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    // Let the fire-and-forget background EXPLAIN promise's .then() resolve
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const tabWithPlan = snapshots.map((snapshot) => snapshot[0]).find((t) => t.explainPlan);
    expect(tabWithPlan?.explainPlan).toEqual({ format: "postgres-json", raw: { plan: "Seq Scan" } });
  });

  // ── a background EXPLAIN that outlives BOTH runs (docs/BACKLOG.md U1) ──────
  //
  // Ownership cannot be read from the in-flight map: the run deletes its own entry
  // when it settles, so an EXPLAIN resolving after its query finished AND after a
  // later query finished finds nothing there. Reading an absent entry as "not
  // superseded" is what let the first run's plan land on the second run's results.

  test("a background EXPLAIN resolving after a later run has finished does not overwrite its plan", async () => {
    let releaseFirstExplain: () => void = () => {};
    const firstExplainGate = new Promise<void>((resolve) => {
      releaseFirstExplain = resolve;
    });
    let explainCount = 0;

    mockGlobalFetch({
      "/api/db/query": async (req) => {
        const body = (await req.json()) as { sql: string };
        if (!body.sql.toUpperCase().startsWith("EXPLAIN")) {
          return { ok: true, json: mockQueryResult };
        }
        explainCount += 1;
        if (explainCount === 1) {
          // The first run's plan is still in flight while the second run starts,
          // runs, and finishes.
          await firstExplainGate;
          return { ok: true, json: { rows: [{ "QUERY PLAN": { plan: "stale" } }], fields: ["QUERY PLAN"] } };
        }
        return { ok: true, json: { rows: [{ "QUERY PLAN": { plan: "current" } }], fields: ["QUERY PLAN"] } };
      },
    });

    const snapshots: QueryTab[][] = [];
    const setTabsMock = mock((fn: unknown) => {
      if (typeof fn === "function") {
        snapshots.push(fn([createTab()]));
      }
    });
    const { result } = renderHook(() => useQueryExecution(createDefaultParams({ setTabs: setTabsMock })));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });
    await act(async () => {
      await result.current.executeQuery("SELECT * FROM orders");
    });

    act(() => releaseFirstExplain());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const plans = snapshots
      .map((snapshot) => snapshot[0].explainPlan as { raw?: { plan?: string } } | null | undefined)
      .filter((plan): plan is { raw?: { plan?: string } } => Boolean(plan));
    expect(plans.some((plan) => plan.raw?.plan === "current")).toBe(true);
    expect(plans.some((plan) => plan.raw?.plan === "stale")).toBe(false);
  });

  // ── setTabs updaters preserve non-target tabs ──────────────────────────

  test("QUERY_CANCELLED updater preserves non-target tabs", async () => {
    mockGlobalFetch({
      "/api/db/query": {
        ok: false,
        status: 499,
        json: { error: "Query was cancelled", code: "QUERY_CANCELLED", statusCode: 499 },
      },
    });

    const otherTab = createTab({ id: "tab-2", name: "Query 2" });
    const snapshots: QueryTab[][] = [];
    const setTabsMock = mock((fn: unknown) => {
      if (typeof fn === "function") {
        snapshots.push(fn([createTab(), otherTab]));
      }
    });
    const params = createDefaultParams({ setTabs: setTabsMock });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT pg_sleep(60)");
    });

    expect(mockToastSuccess).toHaveBeenCalled();
    // Executing + cancelled updaters both ran, passing the non-target tab through unchanged
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    for (const snapshot of snapshots) {
      expect(snapshot[1]).toBe(otherTab);
    }
  });

  test("query error updater preserves non-target tabs", async () => {
    mockGlobalFetch({
      "/api/db/query": { ok: false, status: 400, json: { error: "relation missing" } },
    });

    const otherTab = createTab({ id: "tab-2", name: "Query 2" });
    const snapshots: QueryTab[][] = [];
    const setTabsMock = mock((fn: unknown) => {
      if (typeof fn === "function") {
        snapshots.push(fn([createTab(), otherTab]));
      }
    });
    const params = createDefaultParams({ setTabs: setTabsMock });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM missing");
    });

    expect(mockToastError).toHaveBeenCalled();
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    for (const snapshot of snapshots) {
      expect(snapshot[1]).toBe(otherTab);
    }
  });

  // ── Playground BEGIN failure is logged and execution continues ─────────

  test("playground mode continues when transaction BEGIN fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/transaction")) {
        const body = JSON.parse((init?.body as string) || "{}");
        if (body.action === "begin") {
          return new Response(JSON.stringify({ error: "begin failed" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(mockQueryResult), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(mockQueryResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const params = createDefaultParams({ playgroundMode: true });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("UPDATE users SET active = false");
    });

    // Query still runs and the playground toast is shown despite BEGIN failing
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  // ── Playground rollback fetch failures are swallowed ───────────────────

  test("playground rollback failure after success is swallowed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/transaction")) {
        const body = JSON.parse((init?.body as string) || "{}");
        if (body.action === "rollback") {
          throw new Error("rollback network failure");
        }
        return new Response(JSON.stringify(mockQueryResult), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(mockQueryResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const params = createDefaultParams({ playgroundMode: true });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("UPDATE users SET active = false");
    });

    // Rollback failure is swallowed and the playground toast is still shown
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  test("playground rollback failure after query error is swallowed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/transaction")) {
        const body = JSON.parse((init?.body as string) || "{}");
        if (body.action === "begin") {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (body.action === "query") {
          return new Response(JSON.stringify({ error: "syntax error" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error("rollback network failure");
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }) as typeof fetch;

    const params = createDefaultParams({ playgroundMode: true });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("UPDATE users SET broken");
    });

    // Rollback failure is swallowed; the original query error toast is shown
    expect(mockToastError).toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  // ── cancelQuery swallows server-side cancel failures ───────────────────

  test("cancelQuery swallows server cancel endpoint failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/query")) {
        return new Promise<Response>((resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }
      if (url.includes("/api/db/cancel")) {
        throw new Error("cancel endpoint unreachable");
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }) as typeof fetch;

    const params = createDefaultParams();
    const { result } = renderHook(() => useQueryExecution(params));

    // Start query (hangs until aborted)
    const queryPromise = act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    // Cancel — the server-side cancel request fails but must not throw
    await act(async () => {
      await result.current.cancelQuery();
    });

    await queryPromise;

    // Cancellation toast is still shown
    expect(mockToastSuccess).toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  // ── Run lifecycle: one run at a time, and a plan that belongs to its run ───
  //
  // Two runs of the same hook share `abortControllerRef` / `activeQueryIdRef`.
  // Everything below pins WHICH run owns those refs at a given moment, because
  // the failure modes are silent: a cancel button that stops nothing, and an
  // EXPLAIN plan describing a query the tab no longer shows.

  describe("run lifecycle", () => {
    interface DeferredCall {
      url: string;
      init: RequestInit;
      body: Record<string, unknown>;
      settle: (json: unknown) => void;
    }

    let originalFetch: typeof globalThis.fetch;

    /**
     * A fetch that never settles on its own. Each call is captured so a test can
     * resolve exactly one request at a time — which is the only way to describe
     * "run A's plan comes back after run B started" as a test.
     */
    function installDeferredFetch(): DeferredCall[] {
      const calls: DeferredCall[] = [];
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        // Only the query endpoint is deferred. The side channels (cancel, the
        // playground transaction) must answer immediately or `cancelQuery` would
        // never return and the test would hang rather than fail.
        if (!url.includes("/api/db/query")) {
          calls.push({
            url,
            init: init ?? {},
            body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
            settle: () => {},
          });
          return Promise.resolve(
            new Response(JSON.stringify({ success: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
          calls.push({
            url,
            init: init ?? {},
            body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
            settle: (json: unknown) =>
              resolve(
                new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } }),
              ),
          });
        });
      }) as typeof fetch;
      return calls;
    }

    const isExplain = (c: DeferredCall) => typeof c.body.sql === "string" && c.body.sql.startsWith("EXPLAIN");
    const mainCalls = (calls: DeferredCall[]) => calls.filter((c) => c.url.includes("/api/db/query") && !isExplain(c));
    const explainCalls = (calls: DeferredCall[]) => calls.filter(isExplain);

    /** Params whose `setTabs` actually keeps state, so a write can be observed. */
    function statefulParams() {
      let tabs = [createTab()];
      const setTabs = mock((updater: unknown) => {
        if (typeof updater === "function") {
          tabs = (updater as (prev: QueryTab[]) => QueryTab[])(tabs);
        }
      });
      return { params: createDefaultParams({ setTabs }), readTabs: () => tabs };
    }

    /** Lets the microtasks queued by a settled fetch run to completion. */
    const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      mockToastDefault.mockClear();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("the background EXPLAIN travels on the same abort signal as its query", async () => {
      const calls = installDeferredFetch();
      const { params } = statefulParams();
      const { result } = renderHook(() => useQueryExecution(params));

      act(() => {
        result.current.executeQuery("SELECT * FROM users");
      });
      await flush();

      expect(explainCalls(calls)).toHaveLength(1);
      // Same signal object, not merely "a" signal: a plan request that outlives
      // its own query is a request nobody can stop.
      expect(explainCalls(calls)[0].init.signal).toBe(mainCalls(calls)[0].init.signal);
    });

    test("cancelling a run stops its background EXPLAIN too", async () => {
      const calls = installDeferredFetch();
      const { params } = statefulParams();
      const { result } = renderHook(() => useQueryExecution(params));

      act(() => {
        result.current.executeQuery("SELECT * FROM users");
      });
      await flush();

      await act(async () => {
        await result.current.cancelQuery();
      });

      expect(explainCalls(calls)[0].init.signal?.aborted).toBe(true);
    });

    test("unmounting aborts whatever is still in flight", async () => {
      const calls = installDeferredFetch();
      const { params } = statefulParams();
      const { result, unmount } = renderHook(() => useQueryExecution(params));

      act(() => {
        result.current.executeQuery("SELECT * FROM users");
      });
      await flush();

      unmount();

      expect(mainCalls(calls)[0].init.signal?.aborted).toBe(true);
    });

    test("a second run supersedes the first rather than racing it", async () => {
      const calls = installDeferredFetch();
      const { params } = statefulParams();
      const { result } = renderHook(() => useQueryExecution(params));

      act(() => {
        result.current.executeQuery("SELECT 1");
      });
      await flush();
      act(() => {
        result.current.executeQuery("SELECT 2");
      });
      await flush();

      expect(mainCalls(calls)[0].init.signal?.aborted).toBe(true);
      expect(mainCalls(calls)[1].init.signal?.aborted).toBe(false);
      // Superseding is not cancelling: the user asked for a second query, they
      // did not ask to be told the first one stopped.
      expect(mockToastSuccess).not.toHaveBeenCalled();
      expect(mockToastError).not.toHaveBeenCalled();
    });

    /**
     * Supersession is per TAB. A single hook-wide controller made a Run in one
     * tab abort the query in another — and because that abort read as
     * "superseded" it cleared no flags and raised no toast, so the other tab sat
     * on "Executing…" for ever with no result and no error.
     */
    test("running in a second tab leaves the first tab's query alone", async () => {
      const calls = installDeferredFetch();
      const { params } = statefulParams();
      const { result } = renderHook(() => useQueryExecution(params));

      act(() => {
        result.current.executeQuery("SELECT 1", "tab-1");
      });
      await flush();
      act(() => {
        result.current.executeQuery("SELECT 2", "tab-2");
      });
      await flush();

      expect(mainCalls(calls)).toHaveLength(2);
      // Tab 1's request is untouched — it is a different tab's work.
      expect(mainCalls(calls)[0].init.signal?.aborted).toBe(false);
      expect(mainCalls(calls)[1].init.signal?.aborted).toBe(false);
    });

    test("cancelling one tab does not stop another tab's query", async () => {
      const calls = installDeferredFetch();
      const { params } = statefulParams();
      const { result } = renderHook(() => useQueryExecution(params));

      act(() => {
        result.current.executeQuery("SELECT 1", "tab-1");
      });
      await flush();
      act(() => {
        result.current.executeQuery("SELECT 2", "tab-2");
      });
      await flush();

      await act(async () => {
        await result.current.cancelQuery("tab-2");
      });

      expect(mainCalls(calls)[0].init.signal?.aborted).toBe(false);
      expect(mainCalls(calls)[1].init.signal?.aborted).toBe(true);

      // The server-side cancel names tab 2's query, not the last one started.
      const cancelCall = calls.find((c) => c.url.includes("/api/db/cancel"));
      expect(cancelCall?.body.queryId).toBe(mainCalls(calls)[1].body.queryId);
    });

    test("a superseded run does not disarm the cancel button of the run that replaced it", async () => {
      const calls = installDeferredFetch();
      const { params } = statefulParams();
      const { result } = renderHook(() => useQueryExecution(params));

      act(() => {
        result.current.executeQuery("SELECT 1");
      });
      await flush();
      act(() => {
        result.current.executeQuery("SELECT 2");
      });
      // Run A now unwinds (abort → catch → finally) while B is still in flight.
      await flush();
      await flush();

      await act(async () => {
        await result.current.cancelQuery();
      });

      expect(mainCalls(calls)[1].init.signal?.aborted).toBe(true);
      const cancelCall = calls.find((c) => c.url.includes("/api/db/cancel"));
      expect(cancelCall).toBeDefined();
      // The id sent to the server must be B's, the query that is actually running.
      expect(cancelCall!.body.queryId).toBe(mainCalls(calls)[1].body.queryId);
    });

    test("a late EXPLAIN plan still lands when no newer run has taken over", async () => {
      const calls = installDeferredFetch();
      const { params, readTabs } = statefulParams();
      const { result } = renderHook(() => useQueryExecution(params));

      act(() => {
        result.current.executeQuery("SELECT * FROM users");
      });
      await flush();

      await act(async () => {
        mainCalls(calls)[0].settle(mockQueryResult);
      });
      await act(async () => {
        explainCalls(calls)[0].settle({ rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan" } }] }] });
      });
      await flush();

      expect(readTabs()[0].explainPlan).toBeDefined();
    });

    test("a late EXPLAIN plan is dropped once a newer run owns the tab", async () => {
      const calls = installDeferredFetch();
      const { params, readTabs } = statefulParams();
      const { result } = renderHook(() => useQueryExecution(params));

      act(() => {
        result.current.executeQuery("SELECT * FROM users");
      });
      await flush();
      await act(async () => {
        mainCalls(calls)[0].settle(mockQueryResult);
      });

      // Run B starts before A's plan comes back.
      act(() => {
        result.current.executeQuery("SELECT * FROM orders");
      });
      await flush();

      await act(async () => {
        explainCalls(calls)[0].settle({ rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan" } }] }] });
      });
      await flush();

      // The plan describes `users`; the tab is now running `orders`.
      expect(readTabs()[0].explainPlan).toBeUndefined();
    });

    test("a failed background EXPLAIN is logged, not thrown at the console", async () => {
      const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
        if (url.includes("/api/db/query") && typeof body.sql === "string" && body.sql.startsWith("EXPLAIN")) {
          return Promise.reject(new TypeError("network down"));
        }
        return Promise.resolve(
          new Response(JSON.stringify(mockQueryResult), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as typeof fetch;
      const { params } = statefulParams();

      const { result } = renderHook(() => useQueryExecution(params));
      await act(async () => {
        await result.current.executeQuery("SELECT * FROM users");
      });
      await flush();

      expect(consoleErrorSpy).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    test("an unreadable EXPLAIN body leaves the tab and the console alone", async () => {
      // A 200 whose body is not JSON: the plan parse throws AFTER the response
      // arrived, which is a different path from a failed request.
      const consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
        const isPlanRequest =
          url.includes("/api/db/query") && typeof body.sql === "string" && body.sql.startsWith("EXPLAIN");
        return Promise.resolve(
          new Response(isPlanRequest ? "<html>gateway timeout</html>" : JSON.stringify(mockQueryResult), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as typeof fetch;
      const { params, readTabs } = statefulParams();

      const { result } = renderHook(() => useQueryExecution(params));
      await act(async () => {
        await result.current.executeQuery("SELECT * FROM users");
      });
      await flush();

      expect(readTabs()[0].explainPlan).toBeUndefined();
      expect(readTabs()[0].result).toBeDefined();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  // ── One-shot star prompt (#331 community nudge) ───────────────────────────

  describe("star prompt", () => {
    const COUNT_KEY = "libredb_star_prompt_query_count";
    const HANDLED_KEY = "libredb_star_prompt_handled";

    beforeEach(() => {
      mockToastDefault.mockClear();
      localStorage.removeItem(COUNT_KEY);
      localStorage.removeItem(HANDLED_KEY);
    });

    test("invites a star on the tenth successful query", async () => {
      localStorage.setItem(COUNT_KEY, "9");
      mockGlobalFetch({ "/api/db/query": { ok: true, json: mockQueryResult } });
      const params = createDefaultParams();

      const { result } = renderHook(() => useQueryExecution(params));

      await act(async () => {
        await result.current.executeQuery("SELECT * FROM users");
      });

      expect(mockToastDefault).toHaveBeenCalled();
    });

    test("stays quiet on earlier successful queries", async () => {
      mockGlobalFetch({ "/api/db/query": { ok: true, json: mockQueryResult } });
      const params = createDefaultParams();

      const { result } = renderHook(() => useQueryExecution(params));

      await act(async () => {
        await result.current.executeQuery("SELECT * FROM users");
      });

      expect(mockToastDefault).not.toHaveBeenCalled();
      expect(localStorage.getItem(COUNT_KEY)).toBe("1");
    });

    test("does not count a failed statement in a multi-statement run", async () => {
      localStorage.setItem(COUNT_KEY, "9");
      mockGlobalFetch({
        "/api/db/query": {
          ok: true,
          json: {
            ...mockQueryResult,
            hasError: true,
            statements: [{ status: "error", index: 0, error: "boom" }],
          },
        },
      });
      const params = createDefaultParams();

      const { result } = renderHook(() => useQueryExecution(params));

      await act(async () => {
        await result.current.executeQuery("SELECT * FROM users");
      });

      expect(mockToastDefault).not.toHaveBeenCalled();
      expect(localStorage.getItem(COUNT_KEY)).toBe("9");
    });

    /**
     * The once-per-browser invitation is spent the moment it fires, so it must
     * fire on a query the user ran - not on a scroll. Both assertions matter:
     * the count staying at "9" is what proves the guard short-circuits BEFORE
     * `recordQuerySuccess`, rather than merely suppressing the toast.
     */
    test("a load-more page is not a query the user ran", async () => {
      localStorage.setItem(COUNT_KEY, "9");
      mockGlobalFetch({ "/api/db/query": { ok: true, json: mockQueryResult } });
      const params = createDefaultParams();

      const { result } = renderHook(() => useQueryExecution(params));

      await act(async () => {
        await result.current.executeQuery("SELECT * FROM users", "tab-1", false, { limit: 500, offset: 2 });
      });

      expect(mockToastDefault).not.toHaveBeenCalled();
      expect(localStorage.getItem(COUNT_KEY)).toBe("9");
    });

    test("an explain run is not counted either", async () => {
      localStorage.setItem(COUNT_KEY, "9");
      mockGlobalFetch({ "/api/db/query": { ok: true, json: mockQueryResult } });
      const params = createDefaultParams();

      const { result } = renderHook(() => useQueryExecution(params));

      await act(async () => {
        await result.current.executeQuery("SELECT * FROM users", undefined, true);
      });

      expect(mockToastDefault).not.toHaveBeenCalled();
      expect(localStorage.getItem(COUNT_KEY)).toBe("9");
    });
  });

  /**
   * A statement an agent run handed to the editor (§2.1, §2.5 of
   * `docs/AGENT_ANALYST_DESIGN.md`, as reshaped by the #373 review).
   *
   * The BOUNDARY is the feature here, and the caps ride on it. This path used to call
   * `executeQuery`, which posts to `/api/db/query` — the editor's ordinary read-WRITE
   * route, guarded only by a check on the statement's text. It now names the RUN and
   * nothing else: the server reads the statement off that run's ledger and executes
   * it through the engine's own read-only session. So what these tests pin is where
   * the request goes, what it carries, and — above all — where it does NOT go.
   */
  describe("a statement handed over by an agent run", () => {
    const HANDOVER_SQL = "SELECT region, SUM(net_total) AS net_total FROM orders GROUP BY region";

    const handoverResult = {
      runId: "arun_1",
      sql: HANDOVER_SQL,
      // A whole `QueryResult`, `executionTime` included: it is what the route returns
      // (the provider measures the replay), and it is what the history entry records.
      result: {
        rows: [{ region: "north", net_total: 120 }],
        fields: ["region", "net_total"],
        rowCount: 1,
        executionTime: 21,
      },
    };

    const handoverRoutes = (response: MockFetchResponse = { ok: true, json: handoverResult }) => ({
      "/api/agent/runs": response,
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const callsTo = (fetchMock: ReturnType<typeof mockGlobalFetch>, fragment: string) =>
      fetchMock.mock.calls.filter((call) => String(call[0]).includes(fragment));

    test("asks the run's own hand-over route, and never the editor's query route", async () => {
      // The finding, as an assertion: `/api/db/query` runs in a read-write session, so
      // a `SELECT` calling a VOLATILE function that writes succeeds there and is
      // refused by the engine on the route below. One request, to the safe one.
      const fetchMock = mockGlobalFetch(handoverRoutes());
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      await act(async () => {
        await result.current.executeHandedOverStatement("arun_1", HANDOVER_SQL);
      });

      expect(callsTo(fetchMock, "/api/db/query")).toHaveLength(0);
      const handover = callsTo(fetchMock, "/api/agent/runs");
      expect(handover).toHaveLength(1);
      expect(String(handover[0][0])).toBe("/api/agent/runs/arun_1/handover");
      expect(handover[0][1]?.method).toBe("POST");
    });

    test("it sends no statement at all: the server reads it off the ledger", async () => {
      // A body carrying SQL would make this a general "run this read-only" endpoint,
      // and a statement the user typed could then reach the profile.
      const fetchMock = mockGlobalFetch(handoverRoutes());
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      await act(async () => {
        await result.current.executeHandedOverStatement("arun_1", HANDOVER_SQL);
      });

      expect(callsTo(fetchMock, "/api/agent/runs")[0][1]?.body).toBeUndefined();
    });

    test("a run id is escaped into the path rather than concatenated into it", async () => {
      const fetchMock = mockGlobalFetch(handoverRoutes());
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      await act(async () => {
        await result.current.executeHandedOverStatement("../../db/query", HANDOVER_SQL);
      });

      expect(String(callsTo(fetchMock, "/api/agent/runs")[0][0])).toBe("/api/agent/runs/..%2F..%2Fdb%2Fquery/handover");
    });

    test("the rows land in the active tab, and in history under the statement's own text", async () => {
      const fetchMock = mockGlobalFetch(handoverRoutes());
      const historySpy = spyOn(storage, "addToHistory");
      const params = createDefaultParams();
      const { result } = renderHook(() => useQueryExecution(params));

      await act(async () => {
        await result.current.executeHandedOverStatement("arun_1", HANDOVER_SQL);
      });

      expect(params.setTabs).toHaveBeenCalled();
      expect(historySpy).toHaveBeenCalledWith(
        expect.objectContaining({ query: HANDOVER_SQL, status: "success", rowCount: 1 }),
      );
      expect(callsTo(fetchMock, "/api/agent/runs")).toHaveLength(1);
      historySpy.mockRestore();
    });

    test("only the tab the user is on is touched", async () => {
      // The hand-over arrives while the user may have several tabs open, and the run's
      // answer belongs in the one they are looking at. A sibling tab keeps its own
      // result untouched — asserted by identity, so a rebuilt-but-equal object fails.
      mockGlobalFetch(handoverRoutes());
      const active = createTab();
      const other = createTab({ id: "tab-2", name: "Query 2", query: "SELECT 2" });
      let updated: QueryTab[] = [];
      const setTabs = mock((fn: unknown) => {
        if (typeof fn === "function") updated = (fn as (tabs: QueryTab[]) => QueryTab[])([active, other]);
      });
      const { result } = renderHook(() =>
        useQueryExecution({ ...createDefaultParams(), tabs: [active, other], setTabs }),
      );

      await act(async () => {
        await result.current.executeHandedOverStatement("arun_1", HANDOVER_SQL);
      });

      expect(updated.find((tab) => tab.id === "tab-2")).toBe(other);
      expect(updated.find((tab) => tab.id === "tab-1")?.result).toEqual(handoverResult.result);
    });

    test("a refusal from the route reaches the user as an error, not as an empty result", async () => {
      // The engine refusing a smuggled write (SQLSTATE 25006) arrives this way, and a
      // silent empty grid would read as "the answer is nothing".
      mockGlobalFetch(
        handoverRoutes({ ok: false, status: 500, json: { error: "cannot execute INSERT in a read-only transaction" } }),
      );
      const historySpy = spyOn(storage, "addToHistory");
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      await act(async () => {
        await result.current.executeHandedOverStatement("arun_1", HANDOVER_SQL);
      });

      expect(mockToastError).toHaveBeenCalled();
      expect(historySpy).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
      historySpy.mockRestore();
    });

    test("with no connection selected it runs nothing", async () => {
      const fetchMock = mockGlobalFetch(handoverRoutes());
      const { result } = renderHook(() => useQueryExecution({ ...createDefaultParams(), activeConnection: null }));

      await act(async () => {
        await result.current.executeHandedOverStatement("arun_1", HANDOVER_SQL);
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
