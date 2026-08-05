import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";
import { storage } from "@/lib/storage";

import { useQueryExecution } from "@/hooks/use-query-execution";
import type { DatabaseConnection, QueryTab } from "@/lib/types";

// ── The standalone execution path against the REAL confirmation gate (#297) ──
//
// Isolated, and this is the whole reason the file exists: tests/hooks/
// use-query-execution.test.ts stubs `@/components/QuerySafetyDialog` with
// `mock.module`, which is process-wide in bun, so no test that shares a process
// with it can observe what the real predicate answers. That stub is deliberate -
// it is what lets that file's UPDATE and DDL cases execute without a
// confirmation - but it also means the standalone path's half of #297 cannot be
// proved there: the stub answers on a substring, so a test written against it
// would pass with the fix reverted.
//
// The embedded adapter needs no such file (tests/hooks/use-query-adapter.test.ts
// already uses the real predicate). This one covers the other path: a script
// whose reading cannot be resolved must reach the dialog rather than the server,
// with nothing between the gate and the assertion.

const connection: DatabaseConnection = {
  id: "gate-pg-1",
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

const tab: QueryTab = {
  id: "tab-1",
  name: "Query 1",
  query: "SELECT 1",
  result: null,
  isExecuting: false,
  type: "sql",
};

function params() {
  return {
    activeConnection: connection,
    // No provider metadata: the gate runs before anything reads capabilities, so a
    // null one keeps this file to the one thing it is here to prove.
    metadata: null,
    tabs: [tab],
    activeTabId: "tab-1",
    currentTab: tab,
    setTabs: mock((fn: unknown) => {
      if (typeof fn === "function") (fn as (prev: QueryTab[]) => QueryTab[])([tab]);
    }),
    transactionActive: false,
    playgroundMode: false,
    fetchSchema: mock(async () => {}),
    queryEditorRef: { current: null },
  };
}

describe("useQueryExecution: the real safety gate", () => {
  let addToHistorySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    addToHistorySpy = spyOn(storage, "addToHistory").mockImplementation(() => {});
  });

  afterEach(() => {
    addToHistorySpy.mockRestore();
    restoreGlobalFetch();
  });

  /**
   * `'\'` closes the string under PostgreSQL's reading and continues it under
   * MySQL's, so the span reader declines to resolve it and everything after the
   * quote is invisible to a reader walking code words - which is why this script
   * used to execute with no confirmation at all. The write is its second
   * statement, and node-postgres sends both through the simple query protocol.
   */
  test("opens the dialog for a write hidden behind an unresolvable literal", async () => {
    const fetchMock = mockGlobalFetch({});
    const { result } = renderHook(() => useQueryExecution(params()));

    const hidden = "SELECT '\\';\nUPDATE t SET x = 1";
    await act(async () => {
      await result.current.executeQuery(hidden);
    });

    expect(result.current.safetyCheckQuery).toBe(hidden);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The cost of the rule above, on this path too: a statement whose runs all
   * resolve executes even though it carries a backslash. A prompt for every
   * escape would be the "cries wolf" outcome the issue weighed.
   */
  test("runs a read whose literal resolves, backslash and all", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/query": { ok: true, json: { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 3 } },
    });
    const { result } = renderHook(() => useQueryExecution(params()));

    await act(async () => {
      await result.current.executeQuery("SELECT 'a\\nb' FROM t");
    });

    expect(result.current.safetyCheckQuery).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
  });

  /**
   * #300's dialog half on this path: the connection is PostgreSQL, where block
   * comments NEST, so a comment carrying a second opener runs past the `*\/` a flat
   * reading stops at. Read flat, the word after that marker answered for the
   * statement - a word the operator commented out, never in the dangerous set - so
   * the `DROP` reached the server with no confirmation. Both shapes are asserted
   * because they ask for different reasons: the balanced one because the reader now
   * reads the `DROP`, the unbalanced one because the text cannot be resolved at all.
   */
  test.each<[string, string]>([
    ["a balanced nested comment", "/* outer /* inner */ still a note */ DROP TABLE users"],
    ["a nested comment that never closes", "/* outer /* inner */ DROP TABLE users"],
  ])("opens the dialog for a destructive statement behind %s", async (_label, hidden) => {
    const fetchMock = mockGlobalFetch({});
    const { result } = renderHook(() => useQueryExecution(params()));

    await act(async () => {
      await result.current.executeQuery(hidden);
    });

    expect(result.current.safetyCheckQuery).toBe(hidden);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * And the #294 fixture on the real predicate here as well: a note above a
   * destructive statement is the most ordinary habit there is, and it used to
   * skip the dialog entirely.
   */
  test("opens the dialog for a destructive statement behind a comment", async () => {
    const fetchMock = mockGlobalFetch({});
    const { result } = renderHook(() => useQueryExecution(params()));

    const annotated = "-- cleanup\nDROP TABLE users";
    await act(async () => {
      await result.current.executeQuery(annotated);
    });

    expect(result.current.safetyCheckQuery).toBe(annotated);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
