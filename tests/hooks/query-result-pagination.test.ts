import "../setup-dom";
import "../helpers/mock-navigation";
import { mockToastError } from "../helpers/mock-sonner";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { useState } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useQueryExecution } from "@/hooks/use-query-execution";
import { useQueryAdapter } from "@/workspace/hooks/use-query-adapter";
import { useTabManager } from "@/hooks/use-tab-manager";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { generateTableQuery } from "@/lib/query-generators";
import type { DatabaseConnection, QueryTab, QueryResult } from "@/lib/types";
import type { QueryExecutionOptions } from "@/hooks/use-query-execution";

const connection: DatabaseConnection = {
  id: "pagination-sqlite",
  name: "Pagination fixture",
  type: "sqlite",
  database: ":memory:",
  createdAt: new Date(),
};
const provider = new SQLiteProvider(connection);
const metadata = {
  capabilities: { ...provider.getCapabilities(), supportsExplain: false, explainFormat: undefined },
  labels: provider.getLabels(),
};
const orderedQuery = "SELECT * FROM people ORDER BY id";
let db: Database;
let requests: { sql: string; options?: QueryExecutionOptions }[];
let nextResult: ((sql: string, options?: QueryExecutionOptions) => Promise<QueryResult>) | null;

async function execute(sql: string, options?: QueryExecutionOptions): Promise<QueryResult> {
  requests.push({ sql, options });
  if (nextResult) return nextResult(sql, options);
  const prepared = provider.prepareQuery(sql, options);
  const rows = db.query(prepared.query).all() as Record<string, unknown>[];
  return {
    rows,
    fields: ["id"],
    rowCount: rows.length,
    executionTime: 1,
    pagination: {
      limit: prepared.limit,
      offset: prepared.offset,
      wasLimited: prepared.wasLimited,
      hasMore: prepared.wasLimited && rows.length === prepared.limit,
      totalReturned: rows.length,
    },
  };
}

beforeEach(() => {
  requests = [];
  nextResult = null;
  mockToastError.mockClear();
  db = new Database(":memory:");
  db.run("CREATE TABLE people (id INTEGER PRIMARY KEY)");
  for (let id = 1; id <= 121; id++) db.run("INSERT INTO people VALUES (?)", [id]);
  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith("/api/db/query")) return Response.json({});
    const body = JSON.parse(String(init?.body));
    try {
      return Response.json(await execute(body.sql, body.options));
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }) as typeof fetch);
});

afterEach(() => {
  cleanup();
  mock.restore();
  db.close();
});

for (const product of ["standalone", "workspace"] as const) {
  describe(`${product} result pagination (#816)`, () => {
    test("a new table tab opened from the sidebar can load another page", async () => {
      const { result } = renderHook(() => {
        const mgr = useTabManager({ activeConnection: connection, metadata, schema: [] });
        const common = {
          activeConnection: connection,
          tabs: mgr.tabs,
          currentTab: mgr.currentTab,
          activeTabId: mgr.activeTabId,
          setTabs: mgr.setTabs,
          fetchSchema: async () => {},
        };
        const standalone = useQueryExecution({
          ...common,
          metadata,
          transactionActive: false,
          playgroundMode: false,
          queryEditorRef: { current: null },
        });
        const workspace = useQueryAdapter({
          ...common,
          onQueryExecute: (_id, sql, options) => execute(sql, options),
          features: {},
          supportsResultPagination: true,
        });
        return { mgr, exec: product === "standalone" ? standalone : workspace };
      });
      act(() => {
        result.current.mgr.handleTableClick(["people"], result.current.exec.executeQuery);
      });
      await waitFor(() => expect(result.current.mgr.currentTab.result?.rows).toHaveLength(50));
      expect(result.current.mgr.currentTab.resultSourceQuery).toBe("SELECT * FROM people;");
      await act(async () => {
        await result.current.exec.handleLoadMore();
      });
      expect(result.current.mgr.currentTab.result?.rows).toHaveLength(100);
      expect(requests[1].options).toMatchObject({ limit: 50, offset: 50 });
    });

    function harness(supported = true) {
      const onQueryExecute = mock((_id: string, sql: string, options?: QueryExecutionOptions) => execute(sql, options));
      return renderHook(
        ({ activeConnection }: { activeConnection: DatabaseConnection }) => {
          const [tabs, setTabs] = useState<QueryTab[]>([
            {
              id: "page-tab",
              name: "People",
              type: "sql",
              query: orderedQuery,
              result: null,
              isExecuting: false,
            },
          ]);
          const common = {
            activeConnection,
            tabs,
            setTabs,
            currentTab: tabs[0],
            activeTabId: "page-tab",
            fetchSchema: async () => {},
          };
          const standalone = useQueryExecution({
            ...common,
            metadata: { ...metadata, capabilities: { ...metadata.capabilities, supportsResultPagination: supported } },
            transactionActive: false,
            playgroundMode: false,
            queryEditorRef: { current: null },
          });
          const workspace = useQueryAdapter({
            ...common,
            onQueryExecute,
            features: {},
            supportsResultPagination: supported,
          });
          return { tabs, setTabs, exec: product === "standalone" ? standalone : workspace };
        },
        { initialProps: { activeConnection: connection } },
      );
    }

    test("the starter query loads 50, then disjoint pages of 50 and 21 and stops", async () => {
      const { result } = harness();
      const sql = generateTableQuery(["people"], metadata.capabilities);
      expect(sql).toBe("SELECT * FROM people;");
      await act(async () => {
        await result.current.exec.executeQuery(orderedQuery, undefined, false, { limit: 50 });
      });
      expect(result.current.tabs[0].result?.rows).toHaveLength(50);
      await act(async () => {
        await result.current.exec.handleLoadMore();
      });
      expect(requests[1].options).toMatchObject({ limit: 50, offset: 50 });
      expect(result.current.tabs[0].result?.rows).toHaveLength(100);
      expect(new Set(result.current.tabs[0].result?.rows.map((row) => row.id)).size).toBe(100);
      await act(async () => {
        await result.current.exec.handleLoadMore();
      });
      expect(result.current.tabs[0].result?.rows).toHaveLength(121);
      expect(result.current.tabs[0].currentOffset).toBe(121);
      expect(result.current.tabs[0].result?.pagination?.hasMore).toBe(false);
      await act(async () => {
        await result.current.exec.handleLoadMore();
      });
      expect(requests).toHaveLength(3);
    });

    test("two immediate clicks make only one page request", async () => {
      const { result } = harness();
      await act(async () => {
        await result.current.exec.executeQuery(orderedQuery, undefined, false, { limit: 50 });
      });
      await act(async () => {
        await Promise.all([result.current.exec.handleLoadMore(), result.current.exec.handleLoadMore()]);
      });
      expect(requests).toHaveLength(2);
      expect(result.current.tabs[0].result?.rows).toHaveLength(100);
    });

    test("a provider without offset pagination never requests another page", async () => {
      const { result } = harness(false);
      await act(async () => {
        await result.current.exec.executeQuery(orderedQuery, undefined, false, { limit: 50 });
        await result.current.exec.handleLoadMore();
      });
      expect(requests).toHaveLength(1);
      expect(result.current.tabs[0].result?.rows).toHaveLength(50);
    });

    if (product === "workspace") {
      test("a cancelled page is ignored and the same offset can be retried", async () => {
        const { result } = harness();
        await act(async () => {
          await result.current.exec.executeQuery(orderedQuery, undefined, false, { limit: 50 });
        });
        let resolvePage!: (result: QueryResult) => void;
        nextResult = () =>
          new Promise((resolve) => {
            resolvePage = resolve;
          });
        let pending: unknown;
        act(() => {
          pending = result.current.exec.handleLoadMore();
        });
        await act(async () => {
          await result.current.exec.cancelQuery();
        });
        await act(async () => {
          resolvePage({ rows: [{ id: 51 }], fields: ["id"], rowCount: 1, executionTime: 1 });
          await pending;
        });
        expect(result.current.tabs[0].result?.rows).toHaveLength(50);
        expect(result.current.tabs[0].isLoadingMore).toBe(false);
        nextResult = null;
        await act(async () => {
          await result.current.exec.handleLoadMore();
        });
        expect(result.current.tabs[0].result?.rows).toHaveLength(100);
        expect(requests[2].options?.offset).toBe(50);
        expect(result.current.tabs[0].isLoadingMore).toBe(false);
      });
    }

    test("a failed page retains the rows and offset, reports the error and can be retried", async () => {
      const { result } = harness();
      await act(async () => {
        await result.current.exec.executeQuery(orderedQuery, undefined, false, { limit: 50 });
      });
      const firstRows = result.current.tabs[0].result?.rows;
      nextResult = async () => {
        throw new Error("page failed");
      };
      await act(async () => {
        await result.current.exec.handleLoadMore();
      });
      expect(result.current.tabs[0].result?.rows).toBe(firstRows);
      expect(result.current.tabs[0].currentOffset).toBe(50);
      expect(result.current.tabs[0].isLoadingMore).toBe(false);
      expect(result.current.tabs[0].loadMoreError).toBe("page failed");
      expect(mockToastError).toHaveBeenCalled();
      nextResult = null;
      await act(async () => {
        await result.current.exec.handleLoadMore();
      });
      expect(result.current.tabs[0].result?.rows).toHaveLength(100);
      expect(requests[2].options?.offset).toBe(50);
      expect(result.current.tabs[0].loadMoreError).toBeUndefined();
    });

    test("a user bound is honoured and never paged past", async () => {
      const { result } = harness();
      await act(async () => {
        await result.current.exec.executeQuery("SELECT * FROM people ORDER BY id LIMIT 50", undefined, false, {
          limit: 50,
        });
      });
      expect(result.current.tabs[0].result?.rows).toHaveLength(50);
      expect(result.current.tabs[0].result?.pagination?.hasMore).toBe(false);
      await act(async () => {
        await result.current.exec.handleLoadMore();
      });
      expect(requests).toHaveLength(1);
    });

    test("editing the query prevents appending old pages and a new run resets pagination", async () => {
      const { result } = harness();
      await act(async () => {
        await result.current.exec.executeQuery(orderedQuery, undefined, false, { limit: 50 });
      });
      act(() => {
        result.current.setTabs((prev) =>
          prev.map((tab) => ({ ...tab, query: "SELECT * FROM people WHERE id > 100 ORDER BY id" })),
        );
      });
      await act(async () => {
        await result.current.exec.handleLoadMore();
      });
      expect(requests).toHaveLength(1);
      await act(async () => {
        await result.current.exec.executeQuery();
      });
      expect(result.current.tabs[0].result?.rows).toHaveLength(21);
      expect(result.current.tabs[0].currentOffset).toBe(21);
    });

    test("a page settling after a new query cannot overwrite or append to its result", async () => {
      const { result } = harness();
      await act(async () => {
        await result.current.exec.executeQuery(orderedQuery, undefined, false, { limit: 50 });
      });
      let resolvePage!: (result: QueryResult) => void;
      nextResult = () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        });
      let pending: unknown;
      act(() => {
        pending = result.current.exec.handleLoadMore();
      });
      nextResult = null;
      await act(async () => {
        await result.current.exec.executeQuery("SELECT * FROM people WHERE id > 100 ORDER BY id");
      });
      await act(async () => {
        resolvePage({ rows: [{ id: 51 }], fields: ["id"], rowCount: 1, executionTime: 1 });
        await pending;
      });
      expect(result.current.tabs[0].result?.rows).toHaveLength(21);
      expect(result.current.tabs[0].result?.rows[0].id).toBe(101);
    });

    test("a page settling after a connection change is ignored", async () => {
      const { result, rerender } = harness();
      await act(async () => {
        await result.current.exec.executeQuery(orderedQuery, undefined, false, { limit: 50 });
      });
      let resolvePage!: (result: QueryResult) => void;
      nextResult = () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        });
      let pending: unknown;
      act(() => {
        pending = result.current.exec.handleLoadMore();
      });
      rerender({ activeConnection: { ...connection, id: "different-connection" } });
      await act(async () => {
        resolvePage({ rows: [{ id: 51 }], fields: ["id"], rowCount: 1, executionTime: 1 });
        await pending;
      });
      expect(result.current.tabs[0].result?.rows).toHaveLength(50);
    });
  });
}
