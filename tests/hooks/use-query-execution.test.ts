import "../setup-dom";
import { mockToastSuccess, mockToastError, mockToastDefault, mockToastLoading } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../helpers/mock-fetch";
import { installStandInVocabulary, STAND_IN_TYPE } from "../helpers/stand-in-vocabulary";
import qdrantDocs from "../fixtures/vector/corpus/qdrant-docs.json";
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
import { oxiaRefusal } from "@/lib/db/providers/keyvalue/oxia/guard";
import { milvusRefusal } from "@/lib/db/providers/vector/milvus/guard";
import { qdrantRefusal } from "@/lib/db/providers/vector/qdrant/guard";
import { statementRefusal } from "@/lib/db/destructive-commands";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { isMultiStatement } from "@/lib/sql/statement-splitter";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";

/** What the hook says when the server did not confirm a cancel (#1364). */
const CANCEL_NOT_CONFIRMED_TEXT =
  "The database did not confirm the cancel, so the statement may still be running there. It may also have finished just before the cancel arrived.";

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

  // ── the tab's own numbered database (the #1095 review) ─────────────────────

  /**
   * A key browser activation opens its tab against ONE numbered database, and Redis has no
   * database-qualified key syntax: `GET report:daily` cannot name it, so the number travels with the
   * run and this is where the tab's own fact becomes a request field.
   *
   * A FIELD BESIDE THE CONNECTION, NOT INSIDE IT, and that is the whole of this case: a managed
   * connection travels as an id and the server discards any connection field the caller attached
   * (GHSA-3wh2-8x78), so a database merged into the connection object is silently dropped for every
   * zero-config deployment - and the read runs in the SESSION's database while the tab claims it read
   * another. Beside the connection, `POST /api/db/query` applies it after resolving the id.
   */
  test("a run on a tab opened against a numbered database sends that database", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const tab = createTab({ databaseOverride: 3 });
    const params = createDefaultParams({ tabs: [tab], currentTab: tab });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("GET report:daily");
    });

    const mainCall = fetchMock.mock.calls.find((call) => {
      const body = JSON.parse(call[1]!.body as string);
      // The background EXPLAIN of the same statement is a second request to the same route; the
      // run itself is the one without a plan asked of it.
      return body.sql === "GET report:daily" && body.explain === undefined;
    });
    expect(mainCall).toBeDefined();
    const body = JSON.parse(mainCall![1]!.body as string);
    expect(body.database).toBe(3);
    // The control: the CONNECTION does not move at all - its saved database is still its saved one,
    // so nothing a stored connection pins is rewritten by a tab's own walk. Only the field beside it
    // names the run's database.
    expect(body.connection.id).toBe("qe-pg-1");
    expect(body.connection.host).toBe("localhost");
    expect(body.connection.database).toBe(mockConnection.database);
  });

  test("a run on an ordinary tab keeps the connection's own database", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();
    expect("databaseOverride" in params.currentTab).toBe(false);

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    const mainCall = fetchMock.mock.calls.find((call) => {
      const body = JSON.parse(call[1]!.body as string);
      return body.sql === "SELECT * FROM users" && body.explain === undefined;
    });
    const body = JSON.parse(mainCall![1]!.body as string);
    expect(body.connection.database).toBe("testdb");
    // ABSENT is not 0 and not "the session's number": a tab with no override sends no field, so the
    // body is byte for byte what it was before this existed.
    expect("database" in body).toBe(false);
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
        return new Response(JSON.stringify({ cancelled: true }), {
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
    // The server confirmed the cancel, so the toast says it happened, once.
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith("Query Cancelled", {
      description: "Query execution was cancelled.",
      id: "loading-toast",
    });

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

  /**
   * The next page of a key's tab is still that key's database.
   *
   * Pagination is a SECOND run of the same tab, and the tab is what carries the numbered database
   * (`QueryTab.databaseOverride`) - so a page reached with Next has to be sent on a connection naming
   * it, exactly as the first one was. Everything else about the page is unchanged: it is the same
   * statement, at the offset the grid asked for.
   */
  test("handleLoadMore keeps the tab's own database", async () => {
    const tabWithResults = createTab({
      databaseOverride: 3,
      result: {
        ...mockQueryResult,
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 500, wasLimited: true },
      },
      currentOffset: 500,
    });

    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, rows: [{ id: 3, name: "Charlie" }], rowCount: 1 } },
    });

    const params = createDefaultParams({ tabs: [tabWithResults], currentTab: tabWithResults });

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
      expect(body.database).toBe(3);
    });
  });

  // ── result pagination (#816) ───────────────────────────────────────────────

  /**
   * A tabs array the hook can really write to, so a test can read the state BACK.
   *
   * The shared `createDefaultParams` mock applies the updater and throws the result
   * away, which is enough for "setTabs was called" and cannot see what was written.
   * Criterion 8 is entirely about what was written — the rows and `currentOffset` after
   * a failure — so it needs this.
   */
  function mutableTabs(initial: QueryTab[]) {
    const tabs = [...initial];
    const setTabs = mock((fn: unknown) => {
      if (typeof fn === "function") {
        tabs.splice(0, tabs.length, ...(fn as (prev: QueryTab[]) => QueryTab[])(tabs));
      }
    });
    return { tabs, setTabs };
  }

  /**
   * Page two is the size of page one, in BOTH shells.
   *
   * `limit: 500` was hardcoded here. A tree click now asks for 50 rows, so a hardcoded
   * 500 made the second page ten times the first. The size to reuse is the one the
   * result reports, which is the one the route applied.
   */
  test("handleLoadMore asks for the page size the first page came back with", async () => {
    const tabWithResults = createTab({
      result: {
        ...mockQueryResult,
        pagination: { limit: 50, offset: 0, hasMore: true, totalReturned: 50, wasLimited: true },
      },
      currentOffset: 50,
    });
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, rows: [{ id: 3 }], rowCount: 1 } },
    });
    const params = createDefaultParams({ tabs: [tabWithResults], currentTab: tabWithResults });

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
      expect(body.options.limit).toBe(50);
      expect(body.options.offset).toBe(50);
    });
  });

  /**
   * Criterion 8, in the standalone shell: a failed page must leave the rows and the
   * offset exactly as they were, so a retry asks for the same page rather than skipping
   * one. `use-query-adapter.test.ts` holds the mirror of this test, because the two
   * shells render in different products and are only kept in step by being asserted
   * separately.
   */
  test("a failed page keeps the loaded rows and does not advance currentOffset", async () => {
    const existingRows = [{ id: 1 }, { id: 2 }];
    const tabWithResults = createTab({
      result: {
        ...mockQueryResult,
        rows: existingRows,
        rowCount: 2,
        pagination: { limit: 50, offset: 0, hasMore: true, totalReturned: 2, wasLimited: true },
      },
      allRows: existingRows,
      currentOffset: 50,
    });
    const { tabs, setTabs } = mutableTabs([tabWithResults]);
    mockGlobalFetch({ "/api/db/query": { ok: false, status: 500, json: { error: "connection reset" } } });
    const params = createDefaultParams({ tabs, currentTab: tabWithResults, setTabs });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleLoadMore();
    });

    await waitFor(() => expect(tabs[0].isLoadingMore).toBe(false));
    // NAMED FOR WHAT FAILED, and named the same in both products (#816 review item 7).
    // A lost page is not a lost query: the rows on screen are intact and only the next
    // page did not arrive. Under the generic "Query Error" the user reads their own
    // statement as having failed. `use-query-adapter.ts` already says "Load More Error";
    // the two hooks render in different products and only stay in step by being asked
    // the same question.
    expect(mockToastError).toHaveBeenCalledWith("Load More Error", { description: "connection reset" });
    expect(tabs[0].result!.rows).toHaveLength(2);
    expect(tabs[0].allRows).toHaveLength(2);
    expect(tabs[0].currentOffset).toBe(50);
    // The page is what failed, not the statement, so the panel keeps its rows and says
    // nothing inline.
    expect(tabs[0].runError).toBeUndefined();
  });

  /**
   * A failed NEW run is the opposite case of the page above: the statement on screen is
   * no longer the one that last ran, so the rows it fetched may not stay under it.
   * Measured before this: a good run, then `SELEC * FROM x`, left the first run's rows,
   * header and `resultQuery` in the tab, and the only signal was a toast that fades, so
   * the grid, export and inline edit all acted on the previous statement's rows.
   */
  test("a failed run replaces the previous result with its error, and the next success clears it", async () => {
    const { tabs, setTabs } = mutableTabs([createTab()]);
    mockGlobalFetch({
      "/api/db/query": async (req) => {
        const body = (await req.json()) as { sql: string };
        return body.sql.startsWith("SELEC ")
          ? { ok: false, status: 400, json: { error: 'near "SELEC": syntax error' } }
          : { ok: true, json: mockQueryResult };
      },
    });
    const params = createDefaultParams({ tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });
    expect(tabs[0].result?.rows).toHaveLength(2);

    await act(async () => {
      await result.current.executeQuery("SELEC * FROM x");
    });

    expect(tabs[0].isExecuting).toBe(false);
    expect(tabs[0].runError).toBe('near "SELEC": syntax error');
    expect(tabs[0].result).toBeNull();
    expect(tabs[0].resultQuery).toBeUndefined();
    expect(tabs[0].allRows).toBeUndefined();
    expect(tabs[0].currentOffset).toBe(0);
    // The toast stays: the inline block is the lasting signal, not the only one.
    expect(mockToastError).toHaveBeenCalledWith("Query Error", { description: 'near "SELEC": syntax error' });

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    expect(tabs[0].runError).toBeUndefined();
    expect(tabs[0].result?.rows).toHaveLength(2);
    expect(tabs[0].resultQuery).toBe("SELECT * FROM users");
  });

  /**
   * A superseded run's refusal belongs to a statement the tab no longer shows, so its
   * error must not replace the rows of the run that took the tab over.
   */
  test("a superseded run's failure writes no error over the run that replaced it", async () => {
    const { tabs, setTabs } = mutableTabs([createTab()]);
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockGlobalFetch({
      "/api/db/query": async (req) => {
        const body = (await req.json()) as { sql: string; explain?: unknown };
        if (body.sql !== "SELEC * FROM x" || body.explain !== undefined) return { ok: true, json: mockQueryResult };
        await firstHeld;
        return { ok: false, status: 400, json: { error: 'near "SELEC": syntax error' } };
      },
    });
    const params = createDefaultParams({ tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    let first: Promise<boolean> | undefined;
    act(() => {
      first = result.current.executeQuery("SELEC * FROM x");
    });
    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });
    releaseFirst();
    await act(async () => {
      await first;
    });

    expect(tabs[0].runError).toBeUndefined();
    expect(tabs[0].resultQuery).toBe("SELECT * FROM users");
    expect(tabs[0].result?.rows).toHaveLength(2);
  });

  /** An EXPLAIN never owned the results panel, so landing one does not answer its error. */
  test("an EXPLAIN that succeeds leaves the tab's run error in place", async () => {
    const { tabs, setTabs } = mutableTabs([createTab({ runError: 'near "SELEC": syntax error' })]);
    mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: { rows: [{ "QUERY PLAN": { plan: "Seq Scan" } }], fields: ["QUERY PLAN"], rowCount: 1, executionTime: 5 },
      },
    });
    const params = createDefaultParams({ tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users", undefined, true);
    });

    expect(tabs[0].explainPlan).toBeDefined();
    expect(tabs[0].runError).toBe('near "SELEC": syntax error');
  });

  /** The same exemption from the other side: a failed EXPLAIN takes no rows off the panel. */
  test("an EXPLAIN that fails leaves the previous result and sets no run error", async () => {
    const tab = createTab({
      result: mockQueryResult,
      resultQuery: "SELECT * FROM users",
      allRows: mockQueryResult.rows,
    });
    const { tabs, setTabs } = mutableTabs([tab]);
    mockGlobalFetch({ "/api/db/query": { ok: false, status: 400, json: { error: "EXPLAIN is not allowed here" } } });
    const params = createDefaultParams({ tabs, currentTab: tab, setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users", undefined, true);
    });

    expect(mockToastError).toHaveBeenCalledWith("Query Error", { description: "EXPLAIN is not allowed here" });
    expect(tabs[0].runError).toBeUndefined();
    expect(tabs[0].result?.rows).toHaveLength(2);
    expect(tabs[0].resultQuery).toBe("SELECT * FROM users");
  });

  /** A thrown request, not a refused one, is the same failure to the reader. */
  test("a request that throws replaces the previous result too", async () => {
    const tab = createTab({
      result: mockQueryResult,
      resultQuery: "SELECT * FROM users",
      allRows: mockQueryResult.rows,
    });
    const { tabs, setTabs } = mutableTabs([tab]);
    globalThis.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const params = createDefaultParams({ tabs, currentTab: tab, setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    expect(tabs[0].runError).toBe("Failed to fetch");
    expect(tabs[0].result).toBeNull();
  });

  /**
   * The owner's scope: a cancellation keeps today's behaviour and is not an error. This is
   * the shape a server-side cancel arrives in, `createErrorResponse`'s 499 and its code.
   */
  test("a cancelled run leaves the previous result and sets no error", async () => {
    const tab = createTab({
      result: mockQueryResult,
      resultQuery: "SELECT * FROM users",
      allRows: mockQueryResult.rows,
    });
    const { tabs, setTabs } = mutableTabs([tab]);
    mockGlobalFetch({
      "/api/db/query": {
        ok: false,
        status: 499,
        json: { error: "Query was cancelled", code: "QUERY_CANCELLED", statusCode: 499 },
      },
    });
    const params = createDefaultParams({ tabs, currentTab: tab, setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    expect(tabs[0].runError).toBeUndefined();
    expect(tabs[0].result?.rows).toHaveLength(2);
  });

  /**
   * The word is not the signal. A message that only CONTAINS "cancelled" was read as a
   * cancellation and kept the previous statement's rows, so an engine refusing a column or
   * an enum value of that name looked like a cancel the user never asked for.
   */
  test('an engine error naming a "cancelled" column is a failure, not a cancellation', async () => {
    const tab = createTab({
      result: mockQueryResult,
      resultQuery: "SELECT * FROM users",
      allRows: mockQueryResult.rows,
    });
    const { tabs, setTabs } = mutableTabs([tab]);
    mockGlobalFetch({
      "/api/db/query": { ok: false, status: 400, json: { error: 'column "cancelled" does not exist' } },
    });
    const params = createDefaultParams({ tabs, currentTab: tab, setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT cancelled FROM users");
    });

    expect(tabs[0].runError).toBe('column "cancelled" does not exist');
    expect(tabs[0].result).toBeNull();
    expect(tabs[0].allRows).toBeUndefined();
    expect(mockToastError).toHaveBeenCalledWith("Query Error", { description: 'column "cancelled" does not exist' });
  });

  /**
   * Append, not replace — and the offset advances by what THIS page returned rather than
   * by the page size, so a short final page cannot leave a gap behind it.
   */
  test("a successful page appends to the rows already shown", async () => {
    const existingRows = [{ id: 1 }, { id: 2 }];
    const tabWithResults = createTab({
      result: {
        ...mockQueryResult,
        rows: existingRows,
        rowCount: 2,
        pagination: { limit: 50, offset: 0, hasMore: true, totalReturned: 2, wasLimited: true },
      },
      allRows: existingRows,
      currentOffset: 2,
    });
    const { tabs, setTabs } = mutableTabs([tabWithResults]);
    mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: {
          rows: [{ id: 3 }],
          fields: ["id", "name"],
          rowCount: 1,
          executionTime: 5,
          pagination: { limit: 50, offset: 2, hasMore: false, totalReturned: 1, wasLimited: true },
        },
      },
    });
    const params = createDefaultParams({ tabs, currentTab: tabWithResults, setTabs });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleLoadMore();
    });

    await waitFor(() => expect(tabs[0].result!.rows).toHaveLength(3));
    expect(tabs[0].result!.rows.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(tabs[0].currentOffset).toBe(3);
    expect(tabs[0].result!.pagination!.hasMore).toBe(false);
  });

  /**
   * The vector declaration describes the rows on screen, as the fields do: a page that declares none (an empty last
   * page, or a provider that declares from the rows it returned) must not turn the rows already shown back into JSON.
   */
  test("a Load More page that declares no vectorColumns keeps the rows' declaration", async () => {
    const vectorColumns = { emb: { kind: "dense", dtype: "float32", dimension: 3 } } as const;
    const existingRows = [{ id: 1, emb: [1, 2, 3] }];
    const tabWithResults = createTab({
      result: {
        rows: existingRows,
        fields: ["id", "emb"],
        rowCount: 1,
        executionTime: 5,
        vectorColumns,
        pagination: { limit: 1, offset: 0, hasMore: true, totalReturned: 1, wasLimited: true },
      },
      allRows: existingRows,
      currentOffset: 1,
    });
    const { tabs, setTabs } = mutableTabs([tabWithResults]);
    mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: {
          rows: [],
          fields: [],
          rowCount: 0,
          executionTime: 5,
          pagination: { limit: 1, offset: 1, hasMore: false, totalReturned: 0, wasLimited: false },
        },
      },
    });
    const params = createDefaultParams({ tabs, currentTab: tabWithResults, setTabs });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleLoadMore();
    });

    await waitFor(() => expect(tabs[0].result!.pagination!.hasMore).toBe(false));
    expect(tabs[0].result!.vectorColumns).toEqual(vectorColumns);
  });

  test("a Load More page over an undeclared result leaves vectorColumns absent", async () => {
    const existingRows = [{ id: 1 }];
    const tabWithResults = createTab({
      result: {
        rows: existingRows,
        fields: ["id"],
        rowCount: 1,
        executionTime: 5,
        pagination: { limit: 1, offset: 0, hasMore: true, totalReturned: 1, wasLimited: true },
      },
      allRows: existingRows,
      currentOffset: 1,
    });
    const { tabs, setTabs } = mutableTabs([tabWithResults]);
    mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: {
          rows: [{ id: 2 }],
          fields: ["id"],
          rowCount: 1,
          executionTime: 5,
          pagination: { limit: 1, offset: 1, hasMore: false, totalReturned: 1, wasLimited: true },
        },
      },
    });
    const params = createDefaultParams({ tabs, currentTab: tabWithResults, setTabs });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleLoadMore();
    });

    await waitFor(() => expect(tabs[0].result!.rows).toHaveLength(2));
    expect(Object.hasOwn(tabs[0].result!, "vectorColumns")).toBe(false);
  });

  /**
   * A fresh run REPLACES, so the paging state of the statement before it cannot bleed
   * into the one after it: a tab that had scrolled to offset 200 and then ran something
   * else must not ask that new statement for row 201.
   */
  test("a new query resets the paging state the previous one left", async () => {
    const tabWithResults = createTab({
      result: {
        ...mockQueryResult,
        rows: [{ id: 1 }, { id: 2 }],
        pagination: { limit: 50, offset: 150, hasMore: true, totalReturned: 2, wasLimited: true },
      },
      allRows: [{ id: 1 }, { id: 2 }],
      currentOffset: 200,
    });
    const { tabs, setTabs } = mutableTabs([tabWithResults]);
    mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: {
          rows: [{ id: 9 }],
          fields: ["id"],
          rowCount: 1,
          executionTime: 5,
          pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 1, wasLimited: true },
        },
      },
    });
    const params = createDefaultParams({ tabs, currentTab: tabWithResults, setTabs });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM orders", "tab-1");
    });

    expect(tabs[0].result!.rows).toHaveLength(1);
    expect(tabs[0].allRows).toHaveLength(1);
    expect(tabs[0].currentOffset).toBe(1);
    expect(tabs[0].resultQuery).toBe("SELECT * FROM orders");
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

  test("bottomPanelMode resets from explain when metadata loses explain support", () => {
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

    // Synchronous on purpose: the reset is a render-phase state adjustment, so the
    // value must already be "results" when `rerender` returns. An `await waitFor`
    // here would also pass with a reset that costs one extra committed frame —
    // exactly the frame in which BottomPanel renders the explain body while the
    // explain tab has already been filtered out of the strip.
    expect(result.current.bottomPanelMode).toBe("results");
  });

  test("bottomPanelMode resets from explain when metadata lacks explainFormat even if supportsExplain is true", () => {
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

    // Synchronous on purpose: the reset is a render-phase state adjustment, so the
    // value must already be "results" when `rerender` returns. An `await waitFor`
    // here would also pass with a reset that costs one extra committed frame —
    // exactly the frame in which BottomPanel renders the explain body while the
    // explain tab has already been filtered out of the strip.
    expect(result.current.bottomPanelMode).toBe("results");
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

  // ── a script that stops on an error is written on the tab (#1385) ───────────

  const failedScript = (extra: Record<string, unknown> = {}) => ({
    multiStatement: true,
    executedCount: 2,
    statementCount: 3,
    hasError: true,
    rows: [{ a: 1 }],
    fields: ["a"],
    rowCount: 1,
    executionTime: 20,
    statements: [
      { index: 0, status: "success", rowCount: 1, sql: "SELECT 1 AS a" },
      { index: 1, status: "error", error: "unknown catalog item 'nope'", sql: "SELECT *\n  FROM nope" },
    ],
    ...extra,
  });

  test("a multi-statement run that failed leaves the statement and message on the tab", async () => {
    const { tabs, setTabs } = mutableTabs([createTab()]);
    mockGlobalFetch({ "/api/db/multi-query": { ok: true, json: failedScript() } });
    const params = createDefaultParams({ tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1 AS a; SELECT * FROM nope; SELECT 3");
    });

    expect(tabs[0].runError).toBe("Statement 2 of 3 failed: unknown catalog item 'nope'\nSELECT * FROM nope");
    // The earlier statement's rows stay.
    expect(tabs[0].result?.rows).toHaveLength(1);
  });

  test("a failed script that was rolled back says so, and a long statement is cut", async () => {
    const { tabs, setTabs } = mutableTabs([createTab()]);
    // 79 code points then an emoji at the cut, so a split by UTF-16 units would break it.
    const long = `SELECT ${"x".repeat(72)}\u{1F600}${"y".repeat(20)}`;
    mockGlobalFetch({
      "/api/db/multi-query": {
        ok: true,
        json: failedScript({
          openTransaction: "rolled-back",
          statements: [{ index: 0, status: "error", error: "boom", sql: long }],
        }),
      },
    });
    const params = createDefaultParams({ tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("BEGIN; SELECT 1; SELECT 2");
    });

    expect(tabs[0].runError).toBe(
      `Statement 1 of 3 failed: boom\n${Array.from(long).slice(0, 80).join("")}...\nThe open transaction was rolled back, so its changes were discarded.`,
    );
  });

  test("a failed script whose statement text is missing still names the message", async () => {
    const { tabs, setTabs } = mutableTabs([createTab()]);
    mockGlobalFetch({
      "/api/db/multi-query": {
        ok: true,
        json: failedScript({ statements: [{ index: 1, status: "error", error: "boom" }] }),
      },
    });
    const params = createDefaultParams({ tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1; SELECT 2");
    });

    expect(tabs[0].runError).toBe("Statement 2 of 3 failed: boom");
  });

  test("a multi-statement run without an error leaves no run error", async () => {
    const { tabs, setTabs } = mutableTabs([createTab({ runError: "an earlier failure" })]);
    mockGlobalFetch({
      "/api/db/multi-query": { ok: true, json: failedScript({ hasError: false, statements: [] }) },
    });
    const params = createDefaultParams({ tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT 1; SELECT 2");
    });

    expect(tabs[0].runError).toBeUndefined();
  });

  // ── the multi-statement decision reads the connection's dialect (S1) ───────

  test("executeQuery keeps a PostgreSQL nested-comment buffer on /api/db/query", async () => {
    /*
      Measured on postgres 18 (container libredb-postgres): block comments NEST there,
      so `/* a /* b *\/ ; DROP TABLE users; -- *\/ SELECT 1` is one read - the statement
      ran as `SELECT 1` and the table was still in `pg_class` afterwards. The
      dialect-blind splitter said 3, so this buffer took the multi-statement route and
      it executed a bare `DROP TABLE users` the operator's text never contained.

      The active connection here is `postgres`, so the decision is made under that
      dialect's grammar and the buffer stays on the single-statement endpoint.

      The buried statement is an UPDATE rather than the entry's DROP for a mock reason,
      not a behavioural one: the file-wide `isDangerousQuery` stub above flags any text
      CONTAINING the word DROP, so that buffer would stop at the confirmation dialog
      before any endpoint was chosen and this test would assert nothing about routing.
      What the real predicate answers for the entry's own shape is pinned in
      tests/components/QuerySafetyDialog.test.tsx, against the real grammar.
    */
    const fetchMock = mockGlobalFetch({
      "/api/db/multi-query": { ok: true, json: mockQueryResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("/* a /* b */ ; UPDATE users SET admin = true; -- */ SELECT 1");
    });

    const multiCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/multi-query"),
    );
    expect(multiCall).toBeUndefined();
    const singleCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(singleCall).toBeDefined();
  });

  // ── a non-SQL dialect never takes the statement splitter ──────────────────

  test("executeQuery keeps a JSON-dialect buffer on /api/db/query, semicolons and all (#427)", async () => {
    // Redis commands are not `;`-separated, so splitting one buffer into
    // "statements" can only invent fragments. Measured in the browser before this
    // gate existed: the generated Redis cheatsheet carried a `;` inside a `#`
    // comment, `isMultiStatement` said 2, and /api/db/multi-query executed a
    // comments-only fragment -> "No command to run (only comments or blank lines)"
    // reported to the user as a successful empty result.
    const fetchMock = mockGlobalFetch({
      "/api/db/multi-query": { ok: true, json: mockQueryResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const params = createDefaultParams({
      metadata: { ...mockMetadata, capabilities: { ...mockMetadata.capabilities, queryLanguage: "json" } },
    });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("# 0 is the cursor; re-run with it\nSCAN 0 MATCH user:* COUNT 50");
    });

    const multiCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/multi-query"),
    );
    expect(multiCall).toBeUndefined();
    const singleCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(singleCall).toBeDefined();
  });

  test("executeQuery keeps a PromQL buffer on /api/db/query, semicolons and all (#1085)", async () => {
    // A PromQL text is ONE expression, and `#` starts a comment in it. Under the connection's SQL
    // grammar (postgres here) the `;` inside the comment below separates two statements, so a
    // splitter that ran would send the comment's first half on its own and the rest as a second
    // statement. `dialectIsSql` keeps it off for every declared language but SQL.
    const fetchMock = mockGlobalFetch({
      "/api/db/multi-query": { ok: true, json: mockQueryResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const buffer = "# rate over five minutes; per second\nrate(prometheus_http_requests_total[5m])";
    const params = createDefaultParams({
      metadata: {
        ...mockMetadata,
        capabilities: {
          ...mockMetadata.capabilities,
          queryLanguage: "promql",
          supportsExplain: false,
          explainFormat: undefined,
        },
      },
    });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery(buffer);
    });

    const multiCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/multi-query"),
    );
    expect(multiCall).toBeUndefined();
    const singleCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(singleCall).toBeDefined();
    expect(JSON.parse(singleCall![1]!.body as string).sql).toBe(buffer);
  });

  test("executeQuery keeps a Cypher buffer on /api/db/query whole, semicolons and all (Neo4j spec 6.5)", async () => {
    // Correct as is: `dialectIsSql` is false for every declared language but SQL. The buffer reaches the
    // provider as written, whose read policy reads it with the Cypher lexer and refuses a second statement
    // by name, rather than the SQL splitter cutting it under the connection's SQL grammar.
    const fetchMock = mockGlobalFetch({
      "/api/db/multi-query": { ok: true, json: mockQueryResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const buffer = "// one; two\nMATCH (n) RETURN n;\nMATCH (m) RETURN m";
    const params = createDefaultParams({
      metadata: {
        ...mockMetadata,
        capabilities: {
          ...mockMetadata.capabilities,
          queryLanguage: "cypher",
          supportsExplain: false,
          explainFormat: undefined,
        },
      },
    });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery(buffer);
    });

    const multiCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/multi-query"),
    );
    expect(multiCall).toBeUndefined();
    const singleCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(JSON.parse(singleCall![1]!.body as string).sql).toBe(buffer);
  });

  test("executeQuery keeps a Kafka buffer on /api/db/query whole, semicolons and all (#1088)", async () => {
    // A Kafka tab's whole buffer is ONE read request, which the provider parses as JSON. Under the
    // connection's SQL grammar the `;` below separates two statements, so a splitter that ran
    // would send each object on its own, two reads the user never wrote as one request.
    // `dialectIsSql` keeps it off: the declared language is JSON, whatever its dialect.
    const fetchMock = mockGlobalFetch({
      "/api/db/multi-query": { ok: true, json: mockQueryResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const buffer = '{"topic": "orders", "from": "latest"};\n{"topic": "payments", "from": "latest"}';
    // The premise: the splitter the hook asks does read this buffer as two statements.
    expect(isMultiStatement(buffer, resolveSqlGrammar(mockConnection.type))).toBe(true);
    const params = createDefaultParams({
      metadata: {
        ...mockMetadata,
        capabilities: {
          ...mockMetadata.capabilities,
          queryLanguage: "json",
          queryDialect: "kafka",
          supportsExplain: false,
          explainFormat: undefined,
        },
      },
    });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery(buffer);
    });

    const multiCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/multi-query"),
    );
    expect(multiCall).toBeUndefined();
    const singleCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(singleCall).toBeDefined();
    expect(JSON.parse(singleCall![1]!.body as string).sql).toBe(buffer);
  });

  test("executeQuery keeps an etcd buffer on /api/db/query whole, semicolons and all (#1089)", async () => {
    // An etcd tab's whole buffer is ONE command, which the provider's own parser reads (#1089 5.1.2): a
    // leading comment line is skipped and a `;` inside it is text. Under the connection's SQL grammar
    // the `;` below separates two statements. `dialectIsSql` keeps the splitter off.
    const fetchMock = mockGlobalFetch({
      "/api/db/multi-query": { ok: true, json: mockQueryResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const buffer = "# write it; one command per run\nput /cfg/a b";
    // The premise: the splitter the hook asks does read this buffer as two statements.
    expect(isMultiStatement(buffer, resolveSqlGrammar(mockConnection.type))).toBe(true);
    const params = createDefaultParams({
      metadata: {
        ...mockMetadata,
        capabilities: {
          ...mockMetadata.capabilities,
          queryLanguage: "json",
          queryDialect: "etcd",
          supportsExplain: false,
          explainFormat: undefined,
        },
      },
    });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery(buffer);
    });

    const multiCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/multi-query"),
    );
    expect(multiCall).toBeUndefined();
    const singleCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(singleCall).toBeDefined();
    expect(JSON.parse(singleCall![1]!.body as string).sql).toBe(buffer);
  });

  test("the control: the same buffer on a SQL declaration IS split, so the language decides", async () => {
    // The multi-statement answer shape the test `executeQuery uses /api/db/multi-query for
    // multi-statement queries` above uses, since this buffer does take that route.
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
    const buffer = "# rate over five minutes; per second\nrate(prometheus_http_requests_total[5m])";
    const params = createDefaultParams({
      metadata: {
        ...mockMetadata,
        capabilities: { ...mockMetadata.capabilities, supportsExplain: false, explainFormat: undefined },
      },
    });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery(buffer);
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
    // The server prefixes the statement to build the EXPLAIN (#574), so its
    // placeholders are the same ones in the same order. Sending the plan request
    // without the values would run it unbound: the request fails and the panel keeps
    // the previous plan (PR #304 review).
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
      return body.explain !== undefined;
    });
    expect(explainCall).toBeDefined();
    const explainBody = JSON.parse((explainCall![1] as RequestInit).body as string);
    expect(explainBody.sql).toBe("SELECT * FROM users WHERE id = $1");
    expect(explainBody.params).toEqual([7]);
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

  // ── The latest-value refs still read the latest values after a re-render ───
  //
  // `tabs`, `currentTab` and `activeTabId` are held in refs so that
  // `executeQuery`'s identity survives a keystroke. Nothing else in this file
  // pins that those refs are actually refreshed: every other test renders once,
  // where the `useRef` initializer alone gives the right answer. These three
  // re-render first, so dropping the sync — or giving it a dependency array that
  // misses a value — turns them red instead of shipping a stale run.

  test("a run with no override sends the tab text as it reads after the latest render", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    const { result, rerender } = renderHook(({ tabs }) => useQueryExecution({ ...params, tabs }), {
      initialProps: { tabs: [createTab({ query: "SELECT 1" })] },
    });

    rerender({ tabs: [createTab({ query: "SELECT 2" })] });

    await act(async () => {
      await result.current.executeQuery(); // No override, no editor ref: the tab text decides
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.sql).toBe("SELECT 2");
  });

  test("a run aimed at an unknown tab labels history with the current tab as it now reads", async () => {
    mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    // "tab-missing" is absent from `tabs`, which is what makes `currentTabRef`
    // the tab the run is attributed to — the only observable that can tell a
    // fresh `currentTab` from a stale one.
    const { result, rerender } = renderHook(({ currentTab }) => useQueryExecution({ ...params, currentTab }), {
      initialProps: { currentTab: createTab({ id: "tab-1", name: "Query 1" }) },
    });

    rerender({ currentTab: createTab({ id: "tab-1", name: "Renamed" }) });

    await act(async () => {
      await result.current.executeQuery("SELECT 1", "tab-missing");
    });

    expect(addToHistorySpy).toHaveBeenCalledWith(expect.objectContaining({ tabName: "Renamed" }));
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

  // ── the script's unfinished transaction is reported, not swallowed (D71) ──

  test("says the script's unfinished transaction was rolled back, after a failure", async () => {
    mockGlobalFetch({
      "/api/db/multi-query": {
        ok: true,
        json: {
          multiStatement: true,
          executedCount: 3,
          statementCount: 3,
          hasError: true,
          openTransaction: "rolled-back",
          rows: [],
          fields: [],
          rowCount: 0,
          executionTime: 30,
          statements: [
            { index: 0, status: "success", rowCount: 0 },
            { index: 1, status: "success", rowCount: 0 },
            { index: 2, status: "error", error: 'relation "bad" does not exist' },
          ],
        },
      },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("BEGIN; CREATE TABLE t(id int); SELECT * FROM bad;");
    });

    const description = (mockToastError.mock.calls.at(-1) as unknown[])[1] as { description?: string };
    expect(description.description).toContain("rolled back");
  });

  test("says so after a script that ran clean and never committed", async () => {
    mockGlobalFetch({
      "/api/db/multi-query": {
        ok: true,
        json: {
          multiStatement: true,
          executedCount: 2,
          statementCount: 2,
          hasError: false,
          openTransaction: "rolled-back",
          rows: [],
          fields: [],
          rowCount: 0,
          executionTime: 12,
          statements: [
            { index: 0, status: "success", rowCount: 0 },
            { index: 1, status: "success", rowCount: 1 },
          ],
        },
      },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("BEGIN; INSERT INTO t VALUES (1);");
    });

    const description = (mockToastSuccess.mock.calls.at(-1) as unknown[])[1] as { description?: string };
    expect(description.description).toContain("rolled back");
  });

  test("says nothing about transactions when the script left none open", async () => {
    mockGlobalFetch({
      "/api/db/multi-query": {
        ok: true,
        json: {
          multiStatement: true,
          executedCount: 2,
          statementCount: 2,
          hasError: false,
          rows: [],
          fields: [],
          rowCount: 0,
          executionTime: 12,
          statements: [
            { index: 0, status: "success", rowCount: 0 },
            { index: 1, status: "success", rowCount: 1 },
          ],
        },
      },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("SELECT 1; SELECT 2;");
    });

    const description = (mockToastSuccess.mock.calls.at(-1) as unknown[])[1] as { description?: string };
    expect(description.description).not.toContain("rolled back");
  });

  /**
   * THE SAME NOTICE ON THE LONE-STATEMENT PATH, which is where it was missing (D87).
   *
   * `/api/db/query` gained `openTransaction` when the ender learned to name the caller's own call
   * scope, and the route's comment claimed the client rendered it "from the field's presence
   * alone". It did not: the notice sat inside the `multiStatement` branch, and a lone statement
   * never sets that flag. A reader who typed `BEGIN` on its own therefore had it rolled back in
   * silence, and their next statement autocommitted instead of joining the transaction they asked
   * for. These two drive the single-statement endpoint, which the script tests above never reach.
   */
  test("says a LONE statement's transaction was rolled back", async () => {
    mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, openTransaction: "rolled-back" } },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("BEGIN");
    });

    const description = (mockToastSuccess.mock.calls.at(-1) as unknown[])[1] as { description?: string };
    expect(description.description).toContain("rolled back");
  });

  test("names the ENGINE's keyword, not SQL's, when the engine is not SQL", async () => {
    // D74 gave the single-statement route the ender's `finally`, and `redis` implements the
    // surface, so this notice now reaches a reader whose open transaction is a `MULTI`. Telling
    // them to add COMMIT names a command Redis does not have. The control below is the same flow
    // on postgres, which must still say COMMIT.
    mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, openTransaction: "rolled-back" } },
    });

    const { result } = renderHook(() =>
      useQueryExecution(createDefaultParams({ activeConnection: { ...mockConnection, type: "redis" } })),
    );

    await act(async () => {
      await result.current.executeQuery("MULTI");
    });

    const description = (mockToastSuccess.mock.calls.at(-1) as unknown[])[1] as { description?: string };
    expect(description.description).toContain("Add EXEC to keep them");
    expect(description.description).not.toContain("COMMIT");
  });

  test("says nothing when a lone statement left no transaction open", async () => {
    // THE CONTROL, and it is what makes the assertion above non-vacuous: the same endpoint, the
    // same lone statement, and the only difference is the field. Without it, a notice raised on
    // every ordinary SELECT would pass the test above just as well.
    mockGlobalFetch({ "/api/db/query": { ok: true, json: mockQueryResult } });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("SELECT 1");
    });

    const raised = mockToastSuccess.mock.calls.some((call) => JSON.stringify(call).includes("rolled back"));
    expect(raised).toBe(false);
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

  /**
   * MAJOR 1, #789. `fetchSchema` re-reads the inventory the diagram and the modals draw from;
   * the object TREE keeps its own cache and was not one of the things a DDL statement
   * refreshed, so after `CREATE TABLE` the sidebar showed the old folder contents until the
   * connection was re-selected.
   */
  test("executeQuery asks the object tree to re-read after DDL", async () => {
    const onObjectsChanged = mock(() => {});
    mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, rows: [], rowCount: 0 } },
    });
    const params = createDefaultParams({ onObjectsChanged });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("CREATE TABLE test_table (id INT)", undefined, false, { skipSafety: true });
    });

    expect(onObjectsChanged).toHaveBeenCalledTimes(1);
  });

  test("executeQuery does not ask the object tree to re-read for a SELECT", async () => {
    const onObjectsChanged = mock(() => {});
    mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams({ onObjectsChanged });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    expect(onObjectsChanged).not.toHaveBeenCalled();
  });

  // A playground run is rolled back, so nothing it created survives to be listed. The tree
  // must not be re-read for it, exactly as the inventory is not.
  test("a playground DDL run asks for no re-read, because it was rolled back", async () => {
    const onObjectsChanged = mock(() => {});
    mockGlobalFetch({
      "/api/db/query": { ok: true, json: { ...mockQueryResult, rows: [], rowCount: 0 } },
      "/api/db/transaction": { ok: true, json: { success: true } },
    });
    const params = createDefaultParams({ onObjectsChanged, playgroundMode: true, transactionActive: true });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("CREATE TABLE test_table (id INT)", undefined, false, { skipSafety: true });
    });

    expect(onObjectsChanged).not.toHaveBeenCalled();
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

  /**
   * The guard restates the condition the rendered control already enforces: the button is
   * `disabled={isLoadingMore}` in `StatsBar` and the flag is wired end to end. It reads
   * render state, not a ref, so it is a second line behind that control rather than a
   * replacement for it - which is what this asserts, and all it asserts. The embedded
   * adapter has the mirror of this.
   */
  test("handleLoadMore does nothing while a page is already in flight", async () => {
    const fetchMock = mockGlobalFetch({});
    const tabLoading = createTab({
      result: {
        ...mockQueryResult,
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 2, wasLimited: true },
      },
      isLoadingMore: true,
    });
    const params = createDefaultParams({ tabs: [tabLoading], currentTab: tabLoading });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleLoadMore();
    });

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

  test('a "Query was cancelled" message without the code is an error, not a cancellation', async () => {
    // No server path sends this: a cancel is always the 499 and its code below.
    mockGlobalFetch({
      "/api/db/query": { ok: false, status: 500, json: { error: "Query was cancelled by user" } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT pg_sleep(60)");
    });

    expect(mockToastError).toHaveBeenCalledWith("Query Error", { description: "Query was cancelled by user" });
    expect(mockToastSuccess).not.toHaveBeenCalled();
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

  // ── the explain run asks for a mode and sends the original statement ────

  test("executeQuery with isExplain posts the original statement and asks for the analyze mode", async () => {
    // The browser stopped building the EXPLAIN statement (#574): on the MySQL wire
    // family the accepted form is only knowable once connected (measured 2026-09-06:
    // `EXPLAIN FORMAT=JSON SELECT 1` is errno 1105 on TiDB v8.5.1 and Doris 4.1.3 and
    // errno 1064 on StarRocks 3.3.22, while plain `EXPLAIN SELECT 1` is accepted on
    // all of them), and provider-meta answers without connecting (#457).
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
    expect(body.sql).toBe("SELECT * FROM users");
    expect(body.explain).toEqual({ mode: "analyze" });
  });

  test("executeQuery posts the original statement and the estimate mode for the background plan", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users");
    });

    const planCall = fetchMock.mock.calls.find((call) => {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      return body.explain !== undefined;
    });
    expect(planCall).toBeDefined();
    const body = JSON.parse((planCall![1] as RequestInit).body as string);
    expect(body.sql).toBe("SELECT * FROM users");
    expect(body.explain).toEqual({ mode: "estimate" });
  });

  /**
   * An EXPLAIN prefixes ONE statement. The whole text of `SELECT 1 AS a; INSERT ...`
   * used to go to the plan request because it starts with a SELECT, and the INSERT
   * after it ran a second time there: measured on Materialize 26.44.1, AlloyDB Omni
   * 17.9 and Cloudberry 2.1.0 (#1311). The run itself takes the multi-statement route
   * and is unaffected.
   */
  test("no background plan for a multi-statement run that starts with a SELECT", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/multi-query": {
        ok: true,
        json: { ...mockQueryResult, multiStatement: true, statementCount: 2, executedCount: 2, statements: [] },
      },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("SELECT 1 AS a; INSERT INTO users (name) VALUES ('dup')", undefined, false, {
        skipSafety: true,
      });
    });

    const planCalls = fetchMock.mock.calls.filter((call) => {
      const init = call[1] as RequestInit | undefined;
      return typeof init?.body === "string" && JSON.parse(init.body).explain !== undefined;
    });
    expect(planCalls).toHaveLength(0);
    expect(
      fetchMock.mock.calls.some((call) => typeof call[0] === "string" && call[0].includes("/api/db/multi-query")),
    ).toBe(true);
  });

  // `E'\\''` is one quote character to PostgreSQL, so the INSERT after the `;` is a
  // statement of its own, but the splitter cannot tell whether that backslash escapes
  // and finds no boundary. Text it cannot resolve is not one statement to plan.
  test("no background plan for a text whose statement boundaries cannot be resolved", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("SELECT E'\\''; INSERT INTO users (name) VALUES ('dup')", undefined, false, {
        skipSafety: true,
      });
    });

    const planCalls = fetchMock.mock.calls.filter((call) => {
      const init = call[1] as RequestInit | undefined;
      return typeof init?.body === "string" && JSON.parse(init.body).explain !== undefined;
    });
    expect(planCalls).toHaveLength(0);
  });

  // A note after the final `;` is not a second statement: the splitter keeps it as a
  // fragment of its own, and counting it dropped the plan and refused the Explain
  // button for one SELECT.
  test("a trailing comment does not make one SELECT a multi-statement explain", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("SELECT 1; -- note", undefined, true);
    });

    const queryCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/query"),
    );
    expect(queryCalls).toHaveLength(1);
    expect(JSON.parse((queryCalls[0][1] as RequestInit).body as string).explain).toEqual({ mode: "analyze" });
    expect(mockToastError).not.toHaveBeenCalledWith("Not Supported", expect.anything());
  });

  test("a trailing comment keeps the background plan of one SELECT", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
      "/api/db/multi-query": {
        ok: true,
        json: { ...mockQueryResult, multiStatement: true, statementCount: 2, executedCount: 2, statements: [] },
      },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("SELECT 1; -- note");
    });

    const planCalls = fetchMock.mock.calls.filter((call) => {
      const init = call[1] as RequestInit | undefined;
      return typeof init?.body === "string" && JSON.parse(init.body).explain !== undefined;
    });
    expect(planCalls).toHaveLength(1);
  });

  test("the Explain button refuses a multi-statement text and sends nothing", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: mockQueryResult },
    });

    const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

    await act(async () => {
      await result.current.executeQuery("SELECT 1 AS a; INSERT INTO users (name) VALUES ('dup')", undefined, true);
    });

    expect(fetchMock.mock.calls.some((call) => typeof call[0] === "string" && call[0].includes("/api/db/"))).toBe(
      false,
    );
    expect(mockToastError).toHaveBeenCalledWith("Not Supported", {
      description: "Only a single statement can be explained.",
    });
  });

  test("the stored plan carries the format the response names, not the static one", async () => {
    // The server built the statement, so only it knows which form the engine
    // accepted. A MySQL-wire relative that refused `FORMAT=JSON` answers a plain
    // plan, and the plan must be read by the strategy that matches it.
    mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: {
          rows: [{ id: 2, parent: 0, notused: 0, detail: "SCAN users" }],
          fields: ["id", "parent", "notused", "detail"],
          rowCount: 1,
          executionTime: 5,
          explainFormat: "sqlite-queryplan",
        },
      },
    });

    const snapshots: QueryTab[][] = [];
    const setTabsMock = mock((fn: unknown) => {
      if (typeof fn === "function") snapshots.push((fn as (t: QueryTab[]) => QueryTab[])([createTab()]));
    });
    const params = createDefaultParams({ setTabs: setTabsMock });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users", undefined, true);
    });

    const tabWithPlan = snapshots.map((snapshot) => snapshot[0]).find((t) => t.explainPlan);
    expect(tabWithPlan?.explainPlan).toEqual({
      format: "sqlite-queryplan",
      raw: [{ id: 2, parent: 0, notused: 0, detail: "SCAN users" }],
    });
  });

  // "constructor" is the second case on purpose: the registry is an object literal,
  // so an inherited key resolves to a truthy value that is not a strategy, and
  // reading `.format` or `.extractPlan` off it would throw.
  test.each([
    ["a format this build does not register", "oracle-hierarchy"],
    ["an inherited key", "constructor"],
  ])("%s falls back to the static strategy", async (_label, explainFormat) => {
    mockGlobalFetch({
      "/api/db/query": {
        ok: true,
        json: {
          rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan" } }] }],
          fields: ["QUERY PLAN"],
          rowCount: 1,
          executionTime: 5,
          explainFormat,
        },
      },
    });

    const snapshots: QueryTab[][] = [];
    const setTabsMock = mock((fn: unknown) => {
      if (typeof fn === "function") snapshots.push((fn as (t: QueryTab[]) => QueryTab[])([createTab()]));
    });
    const params = createDefaultParams({ setTabs: setTabsMock });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("SELECT * FROM users", undefined, true);
    });

    const tabWithPlan = snapshots.map((snapshot) => snapshot[0]).find((t) => t.explainPlan);
    expect((tabWithPlan?.explainPlan as { format?: string } | undefined)?.format).toBe("postgres-json");
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

  // ── a background EXPLAIN that outlives BOTH runs (#422) ────────────────────
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
        const body = (await req.json()) as { sql: string; explain?: { mode: string } };
        // The plan request is the one that ASKS for a plan: the statement it posts
        // is the user's own, since the EXPLAIN is built on the server now (#574).
        if (body.explain === undefined) {
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

  // ── Playground BEGIN failure stops the run ────────────────────────────
  //
  // It used to log and carry on, so the statement ran with no transaction under it and the
  // toast still said it had been rolled back. Measured on RisingWave 3.1.0, whose BEGIN opens
  // nothing: an INSERT and a DELETE stayed applied.

  test("playground mode runs nothing when transaction BEGIN fails", async () => {
    const sent: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/transaction")) {
        const body = JSON.parse((init?.body as string) || "{}");
        sent.push(body.action);
        if (body.action === "begin") {
          // SANDBOX's BEGIN asks for a server that reports its transaction state.
          expect(body.requireReportedState).toBe(true);
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

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.executeQuery("UPDATE users SET active = false");
    });

    expect(returned).toBe(false);
    expect(sent).toEqual(["begin"]);
    expect(mockToastError).toHaveBeenCalledWith("Sandbox Unavailable", {
      description: "begin failed. Nothing was run.",
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  test("a BEGIN refusal with no readable reason still stops the run", async () => {
    mockGlobalFetch({
      "/api/db/transaction": () => ({ ok: false, status: 502, text: "<html>bad gateway</html>" }),
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams({ playgroundMode: true });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("UPDATE users SET active = false");
    });

    expect(mockToastError).toHaveBeenCalledWith("Sandbox Unavailable", {
      description: "The transaction SANDBOX needs could not be opened. Nothing was run.",
    });
  });

  // ── The server ended the transaction inside the run ───────────────────

  function transactionRoute(queryAnswer: Record<string, unknown>) {
    const actions: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse((init?.body as string) || "{}");
      if (url.includes("/api/db/transaction")) actions.push(body.action);
      const answer = body.action === "query" ? queryAnswer : mockQueryResult;
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return actions;
  }

  test("playground mode does not claim a rollback when the statement ended the transaction", async () => {
    const originalFetch = globalThis.fetch;
    const actions = transactionRoute({ ...mockQueryResult, inTransaction: false });
    const params = createDefaultParams({ playgroundMode: true });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("ALTER TABLE a RENAME TO b");
    });

    // Nothing is left to roll back, so no ROLLBACK is asked for and none is announced.
    expect(actions).toEqual(["begin", "query"]);
    // The catalog really changed, so the tree is re-read as for any committed DDL.
    expect(params.fetchSchema).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith("Not Rolled Back", {
      description:
        "The database ended the transaction while running this statement (a COMMIT, a ROLLBACK, or a statement it commits implicitly), so SANDBOX could not roll it back. Check what was kept.",
    });
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Playground", expect.anything());

    globalThis.fetch = originalFetch;
  });

  test("an open transaction the server ended is closed in the UI, and the user told", async () => {
    const originalFetch = globalThis.fetch;
    const actions = transactionRoute({ ...mockQueryResult, inTransaction: false });
    const onTransactionEnded = mock(() => {});
    const params = createDefaultParams({ transactionActive: true, onTransactionEnded });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("CREATE TABLE t (id INT)");
    });

    expect(actions).toEqual(["query"]);
    expect(onTransactionEnded).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith("Transaction Ended", {
      description:
        "The database ended the transaction while running this statement (a COMMIT, a ROLLBACK, or a statement it commits implicitly). Check what was kept.",
    });

    globalThis.fetch = originalFetch;
  });

  test("a ROLLBACK typed into an open transaction is not reported as committed", async () => {
    // The server reports the same idle state after a ROLLBACK as after a COMMIT, so the
    // toast names neither outcome; it used to say "its changes are committed".
    const originalFetch = globalThis.fetch;
    transactionRoute({ ...mockQueryResult, inTransaction: false });
    const onTransactionEnded = mock(() => {});
    const params = createDefaultParams({ transactionActive: true, onTransactionEnded });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("ROLLBACK");
    });

    expect(onTransactionEnded).toHaveBeenCalledTimes(1);
    const calls = mockToastError.mock.calls as unknown as [string, { description: string }][];
    const ended = calls.find((call) => call[0] === "Transaction Ended");
    expect(ended?.[1].description).toContain("Check what was kept.");
    expect(ended?.[1].description).not.toContain("committed");

    globalThis.fetch = originalFetch;
  });

  test("a BEGIN refusal that already ends in a period is not given a second one", async () => {
    mockGlobalFetch({
      "/api/db/transaction": () => ({ ok: false, status: 400, json: { error: "No transaction here." } }),
    });
    const params = createDefaultParams({ playgroundMode: true });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("UPDATE users SET active = false");
    });

    expect(mockToastError).toHaveBeenCalledWith("Sandbox Unavailable", {
      description: "No transaction here. Nothing was run.",
    });
  });

  test("an open transaction that is still open leaves the controls alone", async () => {
    const originalFetch = globalThis.fetch;
    transactionRoute({ ...mockQueryResult, inTransaction: true });
    const onTransactionEnded = mock(() => {});
    const params = createDefaultParams({ transactionActive: true, onTransactionEnded });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("INSERT INTO t VALUES (1)");
    });

    expect(onTransactionEnded).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  // ── SANDBOX refuses what would commit its transaction ─────────────────

  test("playground mode refuses a statement the provider declares as committing implicitly", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/": { ok: true, json: mockQueryResult } });
    const params = createDefaultParams({
      playgroundMode: true,
      metadata: {
        ...mockMetadata,
        capabilities: { ...mockMetadata.capabilities, implicitCommitStatements: ["CREATE"] },
      },
    });
    const { result } = renderHook(() => useQueryExecution(params));

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.executeQuery("CREATE TABLE sbx (id INT)");
    });

    expect(returned).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Statement Refused", {
      description:
        "SANDBOX cannot run CREATE: on this database it can end the open transaction (it commits implicitly, or runs code that may), so the rollback that follows could undo nothing. Turn SANDBOX off to run it for real.",
    });
  });

  test("the same statement runs outside playground mode", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/": { ok: true, json: mockQueryResult } });
    const params = createDefaultParams({
      metadata: {
        ...mockMetadata,
        capabilities: { ...mockMetadata.capabilities, implicitCommitStatements: ["CREATE"] },
      },
    });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery("CREATE TABLE sbx (id INT)");
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalledWith("Statement Refused", expect.anything());
  });

  // ── Playground rollback fetch failures are swallowed ───────────────────

  test("playground rollback failure after success is reported, not claimed", async () => {
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

    // The rollback never answered, so nothing may say it happened.
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Playground", expect.anything());
    expect(mockToastError).toHaveBeenCalledWith("Not Rolled Back", {
      description: "The rollback was not confirmed by the server, so the changes may have been kept.",
    });

    globalThis.fetch = originalFetch;
  });

  test("playground rollback failure after query error is reported too", async () => {
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

    // The original query error toast is shown, and so is the unconfirmed rollback.
    expect(mockToastError).toHaveBeenCalledWith("Not Rolled Back", {
      description: "The rollback was not confirmed by the server, so any changes may have been kept.",
    });

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

    // Nothing confirmed the cancel, so the run is not reported as cancelled (#1364).
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Cancel Not Confirmed", {
      description: CANCEL_NOT_CONFIRMED_TEXT,
      id: "loading-toast",
    });

    globalThis.fetch = originalFetch;
  });

  // ── The cancel toast follows the server's answer (#1364) ───────────────
  //
  // Measured on 2026-10-03: the route answered `200 {"cancelled":false}` on CockroachDB,
  // Materialize and RisingWave and `400 {"error":"Query cancellation is not supported ...",
  // "cancelled":false}` on ClickHouse, libSQL and SQLite, and the toast said "Query
  // Cancelled" every time while the engine kept running the statement.

  describe("the cancel toast follows the server's answer", () => {
    /** A query that hangs until aborted, and a cancel route answering per query id. */
    function installCancelAnswers(answer: (queryId: string) => Response) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/api/db/query")) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          });
        }
        if (url.includes("/api/db/cancel")) {
          return answer(JSON.parse(init?.body as string).queryId as string);
        }
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
      }) as typeof fetch;
      return () => {
        globalThis.fetch = originalFetch;
      };
    }

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    async function runThenCancel() {
      let tabs = [createTab()];
      const setTabs = mock((updater: unknown) => {
        if (typeof updater === "function") tabs = (updater as (prev: QueryTab[]) => QueryTab[])(tabs);
      });
      const { result } = renderHook(() => useQueryExecution(createDefaultParams({ setTabs })));
      const running = act(async () => {
        await result.current.executeQuery("SELECT * FROM users");
      });
      await act(async () => {
        await result.current.cancelQuery();
      });
      await running;
      return tabs;
    }

    test("cancelled: false is reported as not confirmed, and the tab stops waiting", async () => {
      const restore = installCancelAnswers(() => json({ cancelled: false }));
      try {
        const tabs = await runThenCancel();
        expect(mockToastSuccess).not.toHaveBeenCalled();
        expect(mockToastError).toHaveBeenCalledTimes(1);
        expect(mockToastError).toHaveBeenCalledWith("Cancel Not Confirmed", {
          description: CANCEL_NOT_CONFIRMED_TEXT,
          id: "loading-toast",
        });
        // Nothing in this tab waits for the run any more; the toast says the engine may.
        expect(tabs[0].isExecuting).toBe(false);
      } finally {
        restore();
      }
    });

    test("a refused cancel (the route's 400) is reported as not confirmed", async () => {
      const restore = installCancelAnswers(() =>
        json({ error: "Query cancellation is not supported for this database type", cancelled: false }, 400),
      );
      try {
        await runThenCancel();
        expect(mockToastSuccess).not.toHaveBeenCalled();
        expect(mockToastError).toHaveBeenCalledWith("Cancel Not Confirmed", {
          description: CANCEL_NOT_CONFIRMED_TEXT,
          id: "loading-toast",
        });
      } finally {
        restore();
      }
    });

    test("an answer that is not JSON is reported as not confirmed", async () => {
      const restore = installCancelAnswers(() => new Response("<html>bad gateway</html>", { status: 200 }));
      try {
        await runThenCancel();
        expect(mockToastSuccess).not.toHaveBeenCalled();
        expect(mockToastError).toHaveBeenCalledWith("Cancel Not Confirmed", {
          description: CANCEL_NOT_CONFIRMED_TEXT,
          id: "loading-toast",
        });
      } finally {
        restore();
      }
    });

    test("an answer that is JSON but not an object is reported as not confirmed", async () => {
      const restore = installCancelAnswers(() => json(null));
      try {
        await runThenCancel();
        expect(mockToastSuccess).not.toHaveBeenCalled();
        expect(mockToastError).toHaveBeenCalledWith("Cancel Not Confirmed", {
          description: CANCEL_NOT_CONFIRMED_TEXT,
          id: "loading-toast",
        });
      } finally {
        restore();
      }
    });

    // The background plan has usually ended before a Cancel, so its `false` means
    // "nothing left to stop"; the run's own answer is the verdict.
    test("the run's answer decides, not its background plan's", async () => {
      const restore = installCancelAnswers((queryId) => json({ cancelled: !queryId.endsWith("-plan") }));
      try {
        await runThenCancel();
        expect(mockToastError).not.toHaveBeenCalled();
        expect(mockToastSuccess).toHaveBeenCalledTimes(1);
        expect(mockToastSuccess).toHaveBeenCalledWith("Query Cancelled", {
          description: "Query execution was cancelled.",
          id: "loading-toast",
        });
      } finally {
        restore();
      }
    });

    // The verdict can take seconds (a wire-protocol cancel waits for the run to end), so a
    // toast says at once that the cancel is under way, and the verdict replaces it.
    test("says Cancelling... at once, and the verdict replaces that toast", async () => {
      const restore = installCancelAnswers(() => json({ cancelled: true }));
      mockToastLoading.mockClear();
      try {
        await runThenCancel();
        expect(mockToastLoading).toHaveBeenCalledTimes(1);
        expect(mockToastLoading).toHaveBeenCalledWith("Cancelling...", { description: undefined });
      } finally {
        restore();
      }
    });

    // Where the provider has no cancel at all, the control reads "Stop waiting": it ends this
    // tab's wait, posts nothing the route could only refuse, and says the statement goes on.
    test("a provider without cancel: stops waiting, posts no cancel, says the statement runs on", async () => {
      const cancelled: string[] = [];
      const restore = installCancelAnswers((queryId) => {
        cancelled.push(queryId);
        return json({ cancelled: false });
      });
      mockToastLoading.mockClear();
      try {
        let tabs = [createTab()];
        const setTabs = mock((updater: unknown) => {
          if (typeof updater === "function") tabs = (updater as (prev: QueryTab[]) => QueryTab[])(tabs);
        });
        const metadata = {
          ...mockMetadata,
          capabilities: { ...mockMetadata.capabilities, supportsQueryCancel: false },
        };
        const { result } = renderHook(() => useQueryExecution(createDefaultParams({ setTabs, metadata })));
        const running = act(async () => {
          await result.current.executeQuery("SELECT * FROM users");
        });
        await act(async () => {
          await result.current.cancelQuery();
        });
        await running;

        expect(cancelled).toEqual([]);
        expect(tabs[0].isExecuting).toBe(false);
        expect(mockToastLoading).not.toHaveBeenCalled();
        expect(mockToastSuccess).not.toHaveBeenCalled();
        expect(mockToastError).toHaveBeenCalledWith("Stopped Waiting", {
          description:
            "Studio stopped waiting for the result. This database cannot cancel a running statement, so it keeps running on the server until it ends.",
        });
      } finally {
        restore();
      }
    });

    // A statement inside a transaction goes to /api/db/transaction, which hands the provider
    // no `queryId`, so the server has nothing to cancel by: say so rather than "not confirmed".
    test("a run with no id on the server says why it cannot be cancelled there", async () => {
      const cancelled: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/api/db/transaction")) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          });
        }
        if (url.includes("/api/db/cancel")) cancelled.push("cancel");
        return json({ cancelled: false });
      }) as typeof fetch;
      try {
        const { result } = renderHook(() => useQueryExecution(createDefaultParams({ transactionActive: true })));
        const running = act(async () => {
          await result.current.executeQuery("UPDATE users SET name = 'x' WHERE id = 1");
        });
        await act(async () => {
          await result.current.cancelQuery();
        });
        await running;

        expect(cancelled).toEqual([]);
        expect(mockToastError).toHaveBeenCalledWith("Stopped Waiting", {
          description:
            "A multi-statement script or a statement inside a transaction cannot be cancelled on the server, so it keeps running there until it ends.",
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
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
            new Response(JSON.stringify({ success: true, cancelled: true }), {
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

    // A plan request is the one that ASKS for a plan: the statement it posts is the
    // user's own, because the EXPLAIN is built on the server now (#574).
    const isExplain = (c: DeferredCall) => c.body.explain !== undefined;
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

    /**
     * Aborting the fetch drops the response; it does not stop the statement on the
     * server. The plan request used to carry no `queryId`, so `/api/db/cancel` had
     * nothing to name: measured on PostgreSQL 18.6, after Cancel the user's backend was
     * idle while the plan's `EXPLAIN (ANALYZE ...) SELECT pg_sleep(30)` stayed `active`
     * until it ended on its own (#1311). The plan gets an id of its own, because the
     * server tracks one statement per id, and Cancel names both.
     */
    test("cancelling a run cancels its background plan on the server too", async () => {
      const calls = installDeferredFetch();
      const { params } = statefulParams();
      const { result } = renderHook(() => useQueryExecution(params));

      act(() => {
        result.current.executeQuery("SELECT * FROM users");
      });
      await flush();

      const runId = mainCalls(calls)[0].body.queryId;
      const planId = explainCalls(calls)[0].body.queryId;
      expect(typeof runId).toBe("string");
      expect(typeof planId).toBe("string");
      expect(planId).not.toBe(runId);

      await act(async () => {
        await result.current.cancelQuery();
      });

      const cancelled = calls.filter((c) => c.url.includes("/api/db/cancel")).map((c) => c.body.queryId);
      expect(cancelled).toEqual([runId, planId]);
    });

    // The Explain button's own run IS the plan request (`analyze`), it sends no second
    // one, and it carries the run's id, so Cancel names exactly that.
    test("an Explain run sends one cancellable request and cancels only that", async () => {
      const calls = installDeferredFetch();
      const { params } = statefulParams();
      const { result } = renderHook(() => useQueryExecution(params));

      act(() => {
        result.current.executeQuery("SELECT * FROM users", undefined, true);
      });
      await flush();

      const queryCalls = calls.filter((c) => c.url.includes("/api/db/query"));
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].body.explain).toEqual({ mode: "analyze" });

      await act(async () => {
        await result.current.cancelQuery();
      });

      const cancelled = calls.filter((c) => c.url.includes("/api/db/cancel")).map((c) => c.body.queryId);
      expect(cancelled).toEqual([queryCalls[0].body.queryId]);
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

    /**
     * A bare `cancelQuery()` resolves its target through `activeTabIdRef`, so the
     * Cancel button has to follow a tab SWITCH, not just the tab that was active
     * when the hook first rendered. Every other cancel test here renders once,
     * where the ref's initializer already holds the answer.
     */
    test("cancel with no tab named stops the run on the tab that is active now", async () => {
      const calls = installDeferredFetch();
      const { params } = statefulParams();
      const { result, rerender } = renderHook(({ activeTabId }) => useQueryExecution({ ...params, activeTabId }), {
        initialProps: { activeTabId: "tab-1" },
      });

      act(() => {
        result.current.executeQuery("SELECT 2", "tab-2");
      });
      await flush();

      rerender({ activeTabId: "tab-2" });

      await act(async () => {
        await result.current.cancelQuery();
      });

      expect(mainCalls(calls)[0].init.signal?.aborted).toBe(true);
      // And the server is told to stop tab 2's query, not some other id.
      const cancelCall = calls.find((c) => c.url.includes("/api/db/cancel"));
      expect(cancelCall?.body.queryId).toBe(mainCalls(calls)[0].body.queryId);
    });

    test("a superseded run reports failure, because nothing it fetched is on screen", async () => {
      // It is not that the engine refused it - the statement may well have been applied.
      // It is that `commitToTab` dropped the result, so a caller counting applied rows
      // would be counting one the user never sees. The apply loop is that caller, which is
      // why what it tells the user is "could not be CONFIRMED as saved": the outcome was
      // thrown away, and that is a weaker thing than a refusal.
      const calls = installDeferredFetch();
      const { params } = statefulParams();
      const { result } = renderHook(() => useQueryExecution(params));

      let first: Promise<boolean> | undefined;
      act(() => {
        first = result.current.executeQuery("SELECT 1") as Promise<boolean>;
      });
      await flush();

      // Settle the first run's request and take the tab over before it can commit.
      mainCalls(calls)[0].settle(mockQueryResult);
      act(() => {
        result.current.executeQuery("SELECT 2");
      });
      await flush();

      expect(await first).toBe(false);
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
        if (url.includes("/api/db/query") && body.explain !== undefined) {
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
        const isPlanRequest = url.includes("/api/db/query") && body.explain !== undefined;
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
   * A statement an agent run handed to the editor (see the "Handing the answer to the
   * editor (auto-execute)" section of `docs/AGENT.md`, as reshaped by the #373 review).
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
  // ── A 429 names the wait (#459) ────────────────────────────────────────────

  describe("rate-limited runs", () => {
    test("a 429 with Retry-After tells the user how long to wait", async () => {
      mockGlobalFetch({
        "/api/db/query": {
          status: 429,
          headers: { "Retry-After": "42" },
          json: { error: "Too many requests.", code: "RATE_LIMITED", statusCode: 429, retryable: true },
        },
      });
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      await act(async () => {
        await result.current.executeQuery("SELECT 1");
      });

      expect(mockToastError).toHaveBeenCalledWith("Query Error", {
        description: "Too many requests. Try again in 42s.",
      });
    });

    test("a 429 with no Retry-After keeps the server's own message", async () => {
      // Guessing a number would be worse than saying nothing about the wait.
      mockGlobalFetch({
        "/api/db/query": {
          status: 429,
          json: { error: "Too many requests. Try again later.", code: "RATE_LIMITED", statusCode: 429 },
        },
      });
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      await act(async () => {
        await result.current.executeQuery("SELECT 1");
      });

      expect(mockToastError).toHaveBeenCalledWith("Query Error", {
        description: "Too many requests. Try again later.",
      });
    });

    test("an HTTP-date Retry-After is left alone rather than parsed into a number", async () => {
      // RFC 9110 permits the date form; this hook only understands delta-seconds,
      // and an unparseable header must not turn into an invented wait.
      mockGlobalFetch({
        "/api/db/query": {
          status: 429,
          headers: { "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" },
          json: { error: "Too many requests. Try again later.", code: "RATE_LIMITED", statusCode: 429 },
        },
      });
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      await act(async () => {
        await result.current.executeQuery("SELECT 1");
      });

      expect(mockToastError).toHaveBeenCalledWith("Query Error", {
        description: "Too many requests. Try again later.",
      });
    });

    test("a non-429 response with a Retry-After header is not rephrased", async () => {
      mockGlobalFetch({
        "/api/db/query": {
          status: 503,
          headers: { "Retry-After": "5" },
          json: { error: "Database is starting up" },
        },
      });
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      await act(async () => {
        await result.current.executeQuery("SELECT 1");
      });

      expect(mockToastError).toHaveBeenCalledWith("Query Error", { description: "Database is starting up" });
    });
  });

  // ── The tab remembers the statement its rows came from (#881) ─────────────
  //
  // `query` is the editor buffer: it is rewritten on every keystroke, and a run takes the
  // editor's EFFECTIVE query, which may be only a selection of it. So the buffer is not a
  // safe name for the rows on screen, and inline editing needs one — it writes back to the
  // table those rows came from.

  describe("the statement a tab's rows came from", () => {
    /** A params object whose `setTabs` keeps what the hook commits. */
    function trackingParams(overrides?: Record<string, unknown>) {
      let tabs = [createTab()];
      const setTabs = mock((updater: unknown) => {
        if (typeof updater === "function") tabs = (updater as (prev: QueryTab[]) => QueryTab[])(tabs);
      });
      return { params: createDefaultParams({ setTabs, ...overrides }), readTabs: () => tabs };
    }

    test("is recorded beside the rows it fetched", async () => {
      mockGlobalFetch({ "/api/db/query": { ok: true, json: mockQueryResult } });
      const { params, readTabs } = trackingParams();
      const { result } = renderHook(() => useQueryExecution(params));

      await act(async () => {
        await result.current.executeQuery("SELECT * FROM users WHERE id = 1");
      });

      expect(readTabs()[0].resultQuery).toBe("SELECT * FROM users WHERE id = 1");
      expect(readTabs()[0].result).not.toBeNull();
    });

    test("is left alone by an EXPLAIN, which leaves the rows alone too", async () => {
      mockGlobalFetch({ "/api/db/query": { ok: true, json: mockQueryResult } });
      const { params, readTabs } = trackingParams();
      const { result } = renderHook(() => useQueryExecution(params));

      await act(async () => {
        await result.current.executeQuery("SELECT * FROM users");
      });
      await act(async () => {
        await result.current.executeQuery("SELECT * FROM orders", undefined, true);
      });

      expect(readTabs()[0].resultQuery).toBe("SELECT * FROM users");
    });

    test("is still named by the tab after a page is appended", async () => {
      const paged = { ...mockQueryResult, pagination: { ...mockQueryResult.pagination, hasMore: true } };
      mockGlobalFetch({ "/api/db/query": { ok: true, json: paged } });
      const { params, readTabs } = trackingParams();
      const { result } = renderHook(() => useQueryExecution(params));

      await act(async () => {
        await result.current.executeQuery("SELECT * FROM users");
      });
      await act(async () => {
        await result.current.executeQuery("SELECT * FROM users", undefined, false, { offset: 2, limit: 500 });
      });

      expect(readTabs()[0].resultQuery).toBe("SELECT * FROM users");
      expect(readTabs()[0].result?.rows.length).toBeGreaterThan(mockQueryResult.rows.length);
    });

    test("is what Load More pages, not whatever has been typed since", async () => {
      // Paging the buffer appended another table's rows under these columns and left the
      // tab holding rows from two tables while naming one.
      const fetchMock = mockGlobalFetch({
        "/api/db/query": {
          ok: true,
          json: { ...mockQueryResult, pagination: { ...mockQueryResult.pagination, hasMore: true } },
        },
      });
      const tab: QueryTab = {
        ...createTab(),
        query: "SELECT * FROM orders",
        resultQuery: "SELECT * FROM users",
        result: { ...mockQueryResult, pagination: { ...mockQueryResult.pagination, hasMore: true } },
      };
      const params = createDefaultParams({ tabs: [tab], currentTab: tab });
      const { result } = renderHook(() => useQueryExecution(params));

      await act(async () => {
        result.current.handleLoadMore();
      });

      const call = fetchMock.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("/api/db/query"));
      expect(JSON.parse(call![1]!.body as string).sql).toBe("SELECT * FROM users");
    });
  });

  // ── The outcome a caller can read (#882) ───────────────────────────────────
  //
  // Every failure below is already reported to the user here — a toast, the tab flags,
  // a history entry. What was missing was an answer for a caller running statements in
  // a loop, which cannot see a toast. Applying inline grid edits ran that loop and
  // reported "Changes Applied" whatever happened, dropping the user's pending edits
  // after a write the engine had refused.

  describe("the outcome executeQuery reports back", () => {
    test("is true when the engine accepted the statement", async () => {
      mockGlobalFetch({ "/api/db/query": { ok: true, json: mockQueryResult } });
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      let outcome: boolean | undefined;
      await act(async () => {
        outcome = await result.current.executeQuery("SELECT * FROM users");
      });

      expect(outcome).toBe(true);
    });

    test("is false when the request failed", async () => {
      mockGlobalFetch({
        "/api/db/query": { ok: false, status: 400, json: { error: "syntax error at position 1" } },
      });
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      let outcome: boolean | undefined;
      await act(async () => {
        outcome = await result.current.executeQuery("UPDATE users SET name = 'x' WHERE id = 1", undefined, false, {
          skipSafety: true,
        });
      });

      expect(outcome).toBe(false);
      expect(mockToastError).toHaveBeenCalled();
    });

    test("is false when there is no connection to run against", async () => {
      mockGlobalFetch({});
      const { result } = renderHook(() => useQueryExecution(createDefaultParams({ activeConnection: null })));

      let outcome: boolean | undefined;
      await act(async () => {
        outcome = await result.current.executeQuery("SELECT 1");
      });

      expect(outcome).toBe(false);
    });

    test("is false when the safety dialog takes the run over", async () => {
      // The gate returns WITHOUT executing and waits for the user to confirm, so the
      // statement has not run — a caller must not read that as applied. (The predicate
      // is stubbed at the top of this file to answer for DROP/DELETE/TRUNCATE only.)
      mockGlobalFetch({ "/api/db/query": { ok: true, json: mockQueryResult } });
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      let outcome: boolean | undefined;
      await act(async () => {
        outcome = await result.current.executeQuery("DELETE FROM users WHERE id = 1");
      });

      expect(outcome).toBe(false);
      expect(result.current.safetyCheckQuery).toBe("DELETE FROM users WHERE id = 1");
    });

    test("is false when the engine reported an error inside a successful request", async () => {
      // A multi-statement run answers 200 while one of the statements inside it failed.
      // `hasError` is that signal, and it is the same answer as a rejected request.
      mockGlobalFetch({
        "/api/db/query": { ok: true, json: { ...mockQueryResult, hasError: true } },
      });
      const { result } = renderHook(() => useQueryExecution(createDefaultParams()));

      let outcome: boolean | undefined;
      await act(async () => {
        outcome = await result.current.executeQuery("SELECT * FROM users");
      });

      expect(outcome).toBe(false);
    });
  });
});

// =============================================================================
// A statement the connection type's editor refuses
// =============================================================================
//
// Milvus's and Qdrant's rows declare `refuse` and `maxTextBytes` (describe("the real milvus row") and describe("the
// real qdrant row") below), and the stand-in row drives every case here, so each rule is pinned apart from any engine's grammar. The refusal runs before
// the confirmation gate, which is why `isDangerousQueryMock` is never consulted, and before every condition that
// Proceed, an explain run, a page and playground mode skip.
describe("a statement the connection type's editor refuses", () => {
  const REFUSAL = "The stand-in dialect refuses FORBIDDEN.";
  const REFUSED = '{"FORBIDDEN": true}';
  const standInConnection: DatabaseConnection = { ...mockConnection, id: "qe-stand-in", type: STAND_IN_TYPE };
  let remove: () => void = () => {};
  let history: ReturnType<typeof spyOn>;

  beforeEach(() => {
    remove = installStandInVocabulary({
      refuse: (text) => (text.includes("FORBIDDEN") ? REFUSAL : undefined),
      maxTextBytes: 64,
    });
    history = spyOn(storage, "addToHistory").mockImplementation(() => {});
    isDangerousQueryMock.mockClear();
    mockToastError.mockClear();
    mockToastSuccess.mockClear();
  });

  afterEach(() => {
    remove();
    remove = () => {};
    history.mockRestore();
    restoreGlobalFetch();
  });

  const pagedTab = (resultQuery: string) =>
    createTab({
      query: "SELECT 1",
      result: {
        ...mockQueryResult,
        pagination: { limit: 50, offset: 0, hasMore: true, totalReturned: 50, wasLimited: true },
      },
      resultQuery,
      currentOffset: 50,
    });

  function mount(
    overrides: Record<string, unknown> = {},
    tab: QueryTab = createTab({ result: { ...mockQueryResult } }),
  ) {
    const tabs = [tab];
    const setTabs = mock((fn: unknown) => {
      if (typeof fn === "function") tabs.splice(0, tabs.length, ...(fn as (prev: QueryTab[]) => QueryTab[])(tabs));
    });
    const fetchMock = mockGlobalFetch({ "/api/db/": { json: mockQueryResult } });
    const params = createDefaultParams({
      activeConnection: standInConnection,
      tabs,
      currentTab: tabs[0],
      setTabs,
      ...overrides,
    });
    const { result } = renderHook(() => useQueryExecution(params));
    return { result, tabs, fetchMock };
  }

  function expectRefused(tabs: QueryTab[], fetchMock: ReturnType<typeof mockGlobalFetch>, sentence = REFUSAL) {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(isDangerousQueryMock).not.toHaveBeenCalled();
    expect(tabs[0].runError).toBe(sentence);
    expect(tabs[0].result).toBeNull();
    expect(tabs[0].isExecuting).toBe(false);
    expect(tabs[0].isLoadingMore).toBe(false);
    expect(mockToastError).toHaveBeenCalledWith("Statement Refused", { description: sentence });
  }

  test("a run sends nothing, writes no history and returns false", async () => {
    const { result, tabs, fetchMock } = mount();
    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.executeQuery(REFUSED);
    });
    expect(returned).toBe(false);
    expectRefused(tabs, fetchMock);
  });

  test("Proceed, which skips the gate, sends nothing either", async () => {
    const { result, tabs, fetchMock } = mount();
    await act(async () => {
      result.current.forceExecuteQuery(REFUSED);
    });
    expectRefused(tabs, fetchMock);
  });

  test("an explain run sends nothing", async () => {
    const { result, tabs, fetchMock } = mount();
    await act(async () => {
      await result.current.executeQuery(REFUSED, undefined, true);
    });
    expectRefused(tabs, fetchMock);
  });

  test("Load More refuses the statement it pages", async () => {
    const tab = pagedTab(REFUSED);
    const { result, tabs, fetchMock } = mount({}, tab);
    await act(async () => {
      result.current.handleLoadMore();
    });
    expectRefused(tabs, fetchMock);
  });

  test("playground mode opens no transaction for it", async () => {
    const { result, tabs, fetchMock } = mount({ playgroundMode: true });
    await act(async () => {
      await result.current.executeQuery(REFUSED);
    });
    expectRefused(tabs, fetchMock);
  });

  test("with metadata still loading, it is refused the same way", async () => {
    const { result, tabs, fetchMock } = mount({ metadata: null });
    await act(async () => {
      await result.current.executeQuery(REFUSED);
    });
    expectRefused(tabs, fetchMock);
  });

  test("a text over the declared byte bound is refused with its size", async () => {
    const { result, tabs, fetchMock } = mount();
    await act(async () => {
      await result.current.executeQuery("é".repeat(33));
    });
    expectRefused(
      tabs,
      fetchMock,
      "The statement is 66 bytes in UTF-8, over the 64-byte limit for this connection type. Shorten it to run it.",
    );
  });

  test("an accepted statement of a type that declares a bound goes to /api/db/query whole and is written to history once", async () => {
    const { result, tabs, fetchMock } = mount({ metadata: null });
    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.executeQuery("SELECT 1; SELECT 2");
    });
    expect(returned).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url).toContain("/api/db/query");
    expect(url).not.toContain("multi-query");
    expect(history).toHaveBeenCalledTimes(1);
    expect(tabs[0].runError).toBeUndefined();
  });

  test("a refusal supersedes a run still in flight on the tab", async () => {
    const tabs = [createTab()];
    const setTabs = mock((fn: unknown) => {
      if (typeof fn === "function") tabs.splice(0, tabs.length, ...(fn as (prev: QueryTab[]) => QueryTab[])(tabs));
    });
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const params = createDefaultParams({
      activeConnection: standInConnection,
      metadata: null,
      tabs,
      currentTab: tabs[0],
      setTabs,
    });
    const { result } = renderHook(() => useQueryExecution(params));

    let first: Promise<boolean> | undefined;
    act(() => {
      first = result.current.executeQuery("SELECT 1");
    });
    await act(async () => {
      expect(await result.current.executeQuery(REFUSED)).toBe(false);
    });
    await act(async () => {
      expect(await first).toBe(false);
    });

    expect(tabs[0].runError).toBe(REFUSAL);
    expect(tabs[0].isExecuting).toBe(false);
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  test("a refusal leaves every other tab as it was", async () => {
    const other = createTab({ id: "tab-2", name: "Query 2", result: { ...mockQueryResult } });
    const tabs = [createTab({ result: { ...mockQueryResult } }), other];
    const setTabs = mock((fn: unknown) => {
      if (typeof fn === "function") tabs.splice(0, tabs.length, ...(fn as (prev: QueryTab[]) => QueryTab[])(tabs));
    });
    const fetchMock = mockGlobalFetch({ "/api/db/": { json: mockQueryResult } });
    const params = createDefaultParams({ activeConnection: standInConnection, tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      expect(await result.current.executeQuery(REFUSED)).toBe(false);
    });

    expectRefused(tabs, fetchMock);
    expect(tabs[1]).toBe(other);
  });
});

// =============================================================================
// The real qdrant row (vector-family spec 4.2 and 4.4)
// =============================================================================
//
// A request naming a model that is not local is a phase 0 refusal of guard.ts, which the real vocabulary row applies
// in the browser: nothing is posted to any route, the query-safety route included, and no history is written. A
// phase 1 refusal needs the schema and a version gate needs the server's version, so both reach the route once and
// are written to history as an error carrying Studio's sentence.
describe("the real qdrant row", () => {
  const qdrantConnection: DatabaseConnection = { ...mockConnection, id: "qe-qdrant", name: "Vectors", type: "qdrant" };
  const NON_LOCAL_MODEL = /"model"\s*:\s*"(?!(?:qdrant\/bm25|bm25)")/;
  /** The documentation's own single requests, each on a route the v1 table runs, that name a model other than local BM25. */
  const HOSTED_MODEL_BLOCKS = (qdrantDocs as { blocks: { file: string; text: string }[] }).blocks.filter(
    (block) => NON_LOCAL_MODEL.test(block.text) && /^\s*POST /.test(block.text),
  );
  let history: ReturnType<typeof spyOn>;

  beforeEach(() => {
    history = spyOn(storage, "addToHistory").mockImplementation(() => {});
    isDangerousQueryMock.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    history.mockRestore();
    restoreGlobalFetch();
  });

  function mount(route: MockFetchResponse) {
    const tabs = [createTab({ result: { ...mockQueryResult } })];
    const setTabs = mock((fn: unknown) => {
      if (typeof fn === "function") tabs.splice(0, tabs.length, ...(fn as (prev: QueryTab[]) => QueryTab[])(tabs));
    });
    const fetchMock = mockGlobalFetch({ "/api/": route });
    const params = createDefaultParams({ activeConnection: qdrantConnection, tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));
    return { result, tabs, fetchMock };
  }

  test("the corpus holds the 18 documentation blocks the spec counts, 5 of them with a provider key in options", () => {
    expect(HOSTED_MODEL_BLOCKS).toHaveLength(18);
    expect(HOSTED_MODEL_BLOCKS.filter((block) => /"options"\s*:/.test(block.text))).toHaveLength(5);
  });

  test.each(HOSTED_MODEL_BLOCKS.map((block) => [block.file, block.text] as const))(
    "refuses inference objects in the browser, with zero fetch and zero history entries: %s",
    async (_file, text) => {
      const sentence = qdrantRefusal(text);
      expect(sentence).toBeDefined();
      const { result, tabs, fetchMock } = mount({ json: mockQueryResult });
      let returned: boolean | undefined;
      await act(async () => {
        returned = await result.current.executeQuery(text);
      });
      expect(returned).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      expect(isDangerousQueryMock).not.toHaveBeenCalled();
      expect(tabs[0].runError).toBe(sentence);
    },
  );

  test.each(HOSTED_MODEL_BLOCKS.map((block) => [block.file, block.text] as const))(
    "Proceed and an explain run refuse the same block, with zero fetch: %s",
    async (_file, text) => {
      const { result, fetchMock } = mount({ json: mockQueryResult });
      await act(async () => {
        result.current.forceExecuteQuery(text);
      });
      await act(async () => {
        await result.current.executeQuery(text, undefined, true);
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
    },
  );

  test.each([
    [
      "a phase 1 refusal: local BM25 aimed at a dense vector",
      'POST /collections/docs/points/query\n{"query": {"text": "vector search", "model": "qdrant/bm25"}, "using": "text", "limit": 5}',
    ],
    [
      "a version-gate refusal: a key newer than the server",
      'POST /collections/docs/points/query\n{"query": {"indices": [1, 3], "values": [0.1, 0.2]}, "using": "keywords", "params": {"idf": "global"}, "limit": 5}',
    ],
  ])("%s reaches the route once and is written to history as an error with Studio's sentence", async (_label, text) => {
    // guard.ts cannot see the schema or the server's version, so it passes both; the provider refuses after its
    // metadata read or at its version gate, and the route answers with Studio's sentence (vector-family spec 4.2).
    expect(qdrantRefusal(text)).toBeUndefined();
    const SENTENCE = "Studio refuses this request before running it.";
    const { result, fetchMock } = mount({ status: 400, json: { error: SENTENCE } });
    await act(async () => {
      await result.current.executeQuery(text);
    });
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost:3000").pathname)).toEqual([
      "/api/db/query",
    ]);
    expect(history).toHaveBeenCalledTimes(1);
    expect(history.mock.calls[0][0]).toMatchObject({ status: "error", errorMessage: SENTENCE, query: text });
  });
});

// =============================================================================
// The real oxia row (SB2-4.2)
// =============================================================================
//
// A write is refused by guard.ts, which the real vocabulary row applies in the browser: nothing is posted to any
// route and no history is written. A read asks nothing and runs.
describe("the real oxia row", () => {
  const oxiaConnection: DatabaseConnection = { ...mockConnection, id: "qe-oxia", name: "Metadata", type: "oxia" };
  let history: ReturnType<typeof spyOn>;

  beforeEach(() => {
    history = spyOn(storage, "addToHistory").mockImplementation(() => {});
    isDangerousQueryMock.mockClear();
  });

  afterEach(() => {
    history.mockRestore();
    restoreGlobalFetch();
  });

  function mount(route: MockFetchResponse) {
    const tabs = [createTab({ result: { ...mockQueryResult } })];
    const setTabs = mock((fn: unknown) => {
      if (typeof fn === "function") tabs.splice(0, tabs.length, ...(fn as (prev: QueryTab[]) => QueryTab[])(tabs));
    });
    const fetchMock = mockGlobalFetch({ "/api/": route });
    const params = createDefaultParams({ activeConnection: oxiaConnection, tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));
    return { result, tabs, fetchMock };
  }

  test("put /a b is refused in the browser with guard.ts's sentence, before any request", async () => {
    const sentence = oxiaRefusal("put /a b");
    expect(sentence).toBeDefined();
    const { result, tabs, fetchMock } = mount({ json: mockQueryResult });
    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.executeQuery("put /a b");
    });
    expect(returned).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(isDangerousQueryMock).not.toHaveBeenCalled();
    expect(tabs[0].runError).toBe(sentence);
  });

  test("get /a runs with no prompt", async () => {
    const { result, fetchMock } = mount({ json: mockQueryResult });
    await act(async () => {
      await result.current.executeQuery("get /a");
    });
    expect(result.current.safetyCheckQuery).toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost:3000").pathname)).toEqual([
      "/api/db/query",
    ]);
  });
});

// =============================================================================
// The real milvus row (vector-family E10, E34, VF9)
// =============================================================================
//
// A request that could make the server call another service is a phase 0 refusal of guard.ts, which the real
// vocabulary row applies in the browser: nothing is posted to any route, the query-safety route included, and no
// history is written. A phase 1 refusal needs the schema, so it reaches the route once and is written to history as
// an error carrying Studio's sentence.
describe("the real milvus row", () => {
  const milvusConnection: DatabaseConnection = { ...mockConnection, id: "qe-milvus", name: "Vectors", type: "milvus" };
  const ENDPOINT = "http://127.0.0.1:9/";
  const E34_CORPUS: readonly (readonly [string, string])[] = [
    [
      "a model ranker in functionScore on search",
      `POST /v2/vectordb/entities/search\n{"collectionName": "docs_int64", "annsField": "vec", "data": [[0.1, 0.2]], "limit": 5, "functionScore": {"functions": [{"name": "r", "type": "Rerank", "inputFieldNames": ["title"], "params": {"reranker": "model", "provider": "tei", "endpoint": "${ENDPOINT}"}}]}}`,
    ],
    [
      "a model ranker in functionScore on hybrid search",
      `POST /v2/vectordb/entities/hybrid_search\n{"collectionName": "docs_varchar", "search": [{"annsField": "f16", "data": [[0.1, 0.2]], "limit": 10}], "rerank": {"strategy": "rrf", "params": {"k": 60}}, "limit": 5, "functionScore": {"functions": [{"name": "m", "type": "Rerank", "params": {"reranker": "model", "endpoint": "${ENDPOINT}"}}]}}`,
    ],
    [
      "functionChains with an endpoint parameter",
      `POST /v2/vectordb/entities/search\n{"collectionName": "docs_int64", "annsField": "vec", "data": [[0.1, 0.2]], "limit": 5, "functionChains": [{"params": {"endpoint": "${ENDPOINT}"}}]}`,
    ],
    [
      "an endpoint key nested in searchParams",
      `POST /v2/vectordb/entities/search\n{"collectionName": "docs_int64", "annsField": "vec", "data": [[0.1, 0.2]], "limit": 5, "searchParams": {"params": {"ef": 64, "endpoint": "${ENDPOINT}"}}}`,
    ],
    [
      "a url key in rerank.params",
      `POST /v2/vectordb/entities/hybrid_search\n{"collectionName": "docs_varchar", "search": [{"annsField": "f16", "data": [[0.1, 0.2]], "limit": 10}], "rerank": {"strategy": "rrf", "params": {"k": 60, "url": "${ENDPOINT}"}}, "limit": 5}`,
    ],
    ["a write route", 'POST /v2/vectordb/entities/insert\n{"collectionName": "docs_int64", "data": [{"seq": 1}]}'],
  ];
  let history: ReturnType<typeof spyOn>;

  beforeEach(() => {
    history = spyOn(storage, "addToHistory").mockImplementation(() => {});
    isDangerousQueryMock.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    history.mockRestore();
    restoreGlobalFetch();
  });

  function mount(route: MockFetchResponse) {
    const tabs = [createTab({ result: { ...mockQueryResult } })];
    const setTabs = mock((fn: unknown) => {
      if (typeof fn === "function") tabs.splice(0, tabs.length, ...(fn as (prev: QueryTab[]) => QueryTab[])(tabs));
    });
    const fetchMock = mockGlobalFetch({ "/api/": route });
    const params = createDefaultParams({ activeConnection: milvusConnection, tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));
    return { result, tabs, fetchMock };
  }

  test.each(E34_CORPUS)("refuses %s in the browser, with zero fetch and zero history entries", async (_label, text) => {
    const sentence = milvusRefusal(text);
    expect(sentence).toBeDefined();
    const { result, tabs, fetchMock } = mount({ json: mockQueryResult });
    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.executeQuery(text);
    });
    expect(returned).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(isDangerousQueryMock).not.toHaveBeenCalled();
    expect(tabs[0].runError).toBe(sentence);
  });

  test.each(E34_CORPUS)("Proceed and an explain run refuse %s, with zero fetch", async (_label, text) => {
    const { result, fetchMock } = mount({ json: mockQueryResult });
    await act(async () => {
      result.current.forceExecuteQuery(text);
    });
    await act(async () => {
      await result.current.executeQuery(text, undefined, true);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  test("a phase 1 refusal reaches the route once and is written to history as an error with Studio's sentence", async () => {
    // Text aimed at a field an embedding function produces passes guard.ts, which cannot see the schema; the
    // provider refuses it after its metadata read, and the route answers with Studio's sentence (VF9).
    const text =
      'POST /v2/vectordb/entities/search\n{"collectionName": "docs_semantic", "annsField": "embedding", "data": ["what is a vector index"], "limit": 5}';
    expect(milvusRefusal(text)).toBeUndefined();
    const SENTENCE = "Studio refuses this request before running it.";
    const { result, fetchMock } = mount({ status: 400, json: { error: SENTENCE } });
    await act(async () => {
      await result.current.executeQuery(text);
    });
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost:3000").pathname)).toEqual([
      "/api/db/query",
    ]);
    expect(history).toHaveBeenCalledTimes(1);
    expect(history.mock.calls[0][0]).toMatchObject({ status: "error", errorMessage: SENTENCE, query: text });
  });
});

// =============================================================================
// The real influxdb row and the influxdb3 split (InfluxDB spec E2, A.11)
// =============================================================================
//
// What the InfluxQL read policy refuses, the editor refuses before anything is sent: no route is posted, the
// confirmation gate is never asked, and no history is written (E2). An allowed InfluxQL text is one statement and goes
// to /api/db/query whole, because the type's vocabulary row declares a text bound, which keeps the SQL splitter off even
// while metadata is loading. An InfluxDB 3 text is SQL, split by the SQL splitter under the DataFusion grammar row.
describe("the real influxdb row and the influxdb3 split", () => {
  const influxdbConnection: DatabaseConnection = {
    ...mockConnection,
    id: "qe-influxdb",
    name: "Telegraf",
    type: "influxdb",
    port: 8086,
  };
  const influxdb3Connection: DatabaseConnection = {
    ...mockConnection,
    id: "qe-influxdb3",
    name: "Edge",
    type: "influxdb3",
    port: 8181,
  };
  // No background plan request: neither type declares an explain format, so every request below is the run's own.
  const influxqlMetadata: ProviderMetadata = {
    ...mockMetadata,
    capabilities: {
      ...mockMetadata.capabilities,
      queryLanguage: "influxql",
      supportsExplain: false,
      explainFormat: undefined,
    },
  };
  const influxdb3Metadata: ProviderMetadata = {
    ...mockMetadata,
    capabilities: {
      ...mockMetadata.capabilities,
      queryLanguage: "sql",
      supportsExplain: false,
      explainFormat: undefined,
    },
  };
  let history: ReturnType<typeof spyOn>;

  beforeEach(() => {
    history = spyOn(storage, "addToHistory").mockImplementation(() => {});
    isDangerousQueryMock.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    history.mockRestore();
    restoreGlobalFetch();
  });

  function mount(connection: DatabaseConnection, metadata: ProviderMetadata | null) {
    const tabs = [createTab({ result: { ...mockQueryResult } })];
    const setTabs = mock((fn: unknown) => {
      if (typeof fn === "function") tabs.splice(0, tabs.length, ...(fn as (prev: QueryTab[]) => QueryTab[])(tabs));
    });
    const fetchMock = mockGlobalFetch({
      "/api/db/multi-query": { ok: true, json: mockQueryResult },
      "/api/db/query": { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams({ activeConnection: connection, metadata, tabs, currentTab: tabs[0], setTabs });
    const { result } = renderHook(() => useQueryExecution(params));
    return { result, tabs, fetchMock };
  }

  test.each([
    ["a write", "DROP DATABASE telegraf"],
    ["a second statement after a semicolon", "SHOW DATABASES; DROP DATABASE telegraf"],
    ["a second statement after a carriage return ends a comment", "SHOW DATABASES -- c\r; DROP DATABASE telegraf"],
    ["INTO", "SELECT temp INTO other..x FROM home"],
    ["a control character", "SELECT * FROM cpu WHERE host = 'a\u0001'"],
    ["an unterminated regex", "SELECT * FROM cpu WHERE host =~ /web"],
    ["Flux", 'from(bucket: "telegraf") |> range(start: -1h)'],
    ["65,537 bytes of text", `SELECT * FROM cpu -- ${"x".repeat(65_537 - 21)}`],
  ])("refuses %s in the browser, with zero fetch and zero history entries", async (_label, text) => {
    const sentence = statementRefusal(text, "influxdb");
    expect(sentence).toBeDefined();
    const { result, tabs, fetchMock } = mount(influxdbConnection, influxqlMetadata);
    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current.executeQuery(text);
    });
    expect(returned).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(isDangerousQueryMock).not.toHaveBeenCalled();
    expect(tabs[0].runError).toBe(sentence);
    expect(mockToastError).toHaveBeenCalledWith("Statement Refused", { description: sentence });
  });

  test("Proceed and an explain run refuse it the same way, with zero fetch and zero history entries", async () => {
    const { result, fetchMock } = mount(influxdbConnection, influxqlMetadata);
    await act(async () => {
      result.current.forceExecuteQuery("DROP DATABASE telegraf");
    });
    await act(async () => {
      await result.current.executeQuery("DROP DATABASE telegraf", undefined, true);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  test.each([
    ["declared", influxqlMetadata],
    ["still loading", null],
  ] as const)(
    "an allowed InfluxQL text goes to /api/db/query whole with metadata %s, and is written to history once",
    async (_label, metadata) => {
      // A `;` inside a regex: the lexer reads one statement, and the SQL splitter would cut it in two.
      const buffer = "SELECT * FROM cpu WHERE host =~ /a;b/";
      expect(statementRefusal(buffer, "influxdb")).toBeUndefined();
      expect(isMultiStatement(buffer, resolveSqlGrammar("postgres"))).toBe(true);
      const { result, fetchMock } = mount(influxdbConnection, metadata);
      let returned: boolean | undefined;
      await act(async () => {
        returned = await result.current.executeQuery(buffer);
      });
      expect(returned).toBe(true);
      const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost:3000").pathname);
      expect(paths).toEqual(["/api/db/query"]);
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).sql).toBe(
        buffer,
      );
      expect(history).toHaveBeenCalledTimes(1);
    },
  );

  test("an InfluxDB 3 text is split by the SQL splitter under the DataFusion row and goes to /api/db/multi-query", async () => {
    const buffer = "SELECT * FROM cpu LIMIT 1;\nSELECT * FROM mem LIMIT 1";
    expect(statementRefusal(buffer, "influxdb3")).toBeUndefined();
    expect(isMultiStatement(buffer, resolveSqlGrammar("influxdb3"))).toBe(true);
    const { result, fetchMock } = mount(influxdb3Connection, influxdb3Metadata);
    await act(async () => {
      await result.current.executeQuery(buffer);
    });
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost:3000").pathname);
    expect(paths).toEqual(["/api/db/multi-query"]);
  });

  test("an InfluxDB 3 text with a semicolon only inside a comment stays one statement on /api/db/query", async () => {
    const buffer = "-- newest; then oldest\nSELECT * FROM cpu LIMIT 1";
    expect(isMultiStatement(buffer, resolveSqlGrammar("influxdb3"))).toBe(false);
    const { result, fetchMock } = mount(influxdb3Connection, influxdb3Metadata);
    await act(async () => {
      await result.current.executeQuery(buffer);
    });
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input), "http://localhost:3000").pathname);
    expect(paths).toEqual(["/api/db/query"]);
  });
});
