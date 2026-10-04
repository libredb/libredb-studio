import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, mock, beforeAll, afterAll, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import type { DatabaseConnection, QueryTab } from "@/lib/types";

/**
 * THE POINT OF #816, asserted directly: two pages over a seeded ordered table produce
 * DISJOINT row sets.
 *
 * Every other test in this change measures one seam. This one measures the whole path at
 * once, with as little doubled as the harness allows: a real SQLite database holding 121
 * ordered rows, the real `SQLiteProvider`, the real `POST /api/db/query` handler, and the
 * real hooks of BOTH products. Only the session, the connection resolution and the
 * provider cache are stubbed, because those are how the route reaches a provider and not
 * what it does with one.
 *
 * It exists because the two defects in the issue hid each other. The control was missing,
 * so nobody ever triggered the dropped offset behind it, and a suite of per-seam tests
 * could have passed with page two still being page one. The row ids are what tells the
 * difference, so the row ids are what this asserts.
 *
 * The two hooks are driven through one matrix, because they render in different products
 * — the standalone app and the embedded `StudioWorkspace` — and they are only kept in
 * step by being asked the same questions.
 */

// ─── The real route, over a real provider ───────────────────────────────────

const PAGE_SIZE = 50;
const SEEDED_ROWS = 121;

let provider: SQLiteProvider;

// The spread form, not a hand-written five-key stub: `src/lib/auth.ts` exports seven
// names and only one of them is being replaced here (BACKLOG D85).
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin" })),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return { resolveConnection: mock(async (body: Record<string, unknown>) => body.connection), SeedConnectionError };
});

// Only `getOrCreateProvider` is replaced, and it hands back the REAL provider: the route's
// `prepareQuery`, the driver's `LIMIT n OFFSET m` and the engine's own answer all stay.
const dbModule = await import("@/lib/db");
mock.module("@/lib/db", () => ({ ...dbModule, getOrCreateProvider: mock(async () => provider) }));

const { POST } = await import("@/app/api/db/query/route");
const { useQueryExecution } = await import("@/hooks/use-query-execution");
const { useQueryAdapter } = await import("@/workspace/hooks/use-query-adapter");

const connection: DatabaseConnection = {
  id: "conn-1",
  name: "Seeded SQLite",
  type: "sqlite",
  database: ":memory:",
  createdAt: new Date(0),
};

/**
 * Holds a PAGE inside the route, so a Run can land while that page is in flight.
 *
 * Only a request carrying an offset waits. The Run that overtakes the page has to reach
 * the engine and commit while the page is still held, because that is the whole window
 * the supersession check exists for, and a gate that held both would close it.
 */
let pageGate: Promise<void> | null = null;

function holdTheNextPage() {
  let open!: () => void;
  pageGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    pageGate = null;
    open();
  };
}

/**
 * Holds a RUN inside the route: the mirror of `holdTheNextPage` for a request that carries
 * no offset, so a Cancel or a Load More can land while the Run is still in flight.
 *
 * Two gates rather than one with a flag, for the reason the page gate states: each of
 * these scenarios needs exactly one of the two requests held and the other one free to
 * reach the engine and commit.
 */
let runGate: Promise<void> | null = null;

function holdTheNextRun() {
  let open!: () => void;
  runGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    runGate = null;
    open();
  };
}

/** The one request path both products share, answered by the real handler. */
async function callRoute(body: Record<string, unknown>) {
  const offset = (body.options as { offset?: number } | undefined)?.offset;
  if (pageGate && offset) await pageGate;
  if (runGate && !offset) await runGate;
  clearRateLimitState();
  const request = new Request("http://localhost:3000/api/db/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connection, ...body }),
  });
  const response = await POST(request as never);
  return (await response.json()) as {
    rows: Record<string, unknown>[];
    fields: string[];
    rowCount: number;
    executionTime: number;
    pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
  };
}

beforeAll(async () => {
  provider = new SQLiteProvider({ ...connection });
  await provider.connect();
  await provider.query("CREATE TABLE orders (id INTEGER PRIMARY KEY, label TEXT)");
  for (let id = 1; id <= SEEDED_ROWS; id++) {
    await provider.query(`INSERT INTO orders (id, label) VALUES (${id}, 'row-${id}')`);
  }
});

afterAll(async () => {
  await provider.disconnect();
});

// ─── One matrix, both products ──────────────────────────────────────────────

const makeTab = (overrides: Partial<QueryTab> = {}): QueryTab => ({
  id: "tab-1",
  name: "orders",
  query: "SELECT * FROM orders ORDER BY id",
  result: null,
  isExecuting: false,
  type: "sql",
  ...overrides,
});

/** A tabs array the hooks really write to, so the assertions can read the state back. */
function mutableTabs(initial: QueryTab[]) {
  const tabs = [...initial];
  const setTabs = (fn: unknown) => {
    if (typeof fn === "function") {
      tabs.splice(0, tabs.length, ...(fn as (prev: QueryTab[]) => QueryTab[])(tabs));
    }
  };
  return { tabs, setTabs: setTabs as never };
}

/** Built per mount, because `provider` is only connected in `beforeAll`. */
const metadata = () => ({ capabilities: provider.getCapabilities() }) as never;

interface Shell {
  name: string;
  /** Renders the hook over `tabs` and returns the entry points this file drives. */
  mount: (
    tabs: QueryTab[],
    setTabs: never,
  ) => {
    run: (query: string, options?: { limit?: number }) => Promise<void>;
    loadMore: () => Promise<void>;
    /** Fires the control and returns, leaving the page in flight for a Run to overtake. */
    startLoadMore: () => void;
    /** Fires Run and returns, leaving it in flight for a Cancel or a page to overtake. */
    startRun: (query: string, options?: { limit?: number }) => void;
    /** The safety dialog's Proceed, left in flight the way `startRun` leaves a Run. */
    startForceRun: (query: string) => void;
    /** The unlimited-warning dialog's Proceed, left in flight the same way. */
    startUnlimited: (query: string, tabId: string) => void;
    /** The Cancel button, on the tab being looked at. */
    cancel: () => Promise<void>;
    /** Run, pressed in ANOTHER tab: the user switches tab first, so the mount follows. */
    runOnTab: (tabId: string, query: string, options?: { limit?: number }) => Promise<void>;
    /** Tears the hook down, the way navigating away from the studio does. */
    unmount: () => void;
    requests: () => number;
  };
}

/** How many times each product asked the route for rows, so "no further request" is assertable. */
let requestCount = 0;

const SHELLS: Shell[] = [
  {
    name: "standalone",
    mount: (tabs, setTabs) => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (!url.includes("/api/db/query")) return new Response("{}", { status: 200 });
        requestCount++;
        const body = JSON.parse(String(init?.body));
        const json = await callRoute({ sql: body.sql, options: body.options, queryId: body.queryId });
        return new Response(JSON.stringify(json), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as never;

      // Re-rendered from the CURRENT tabs array before each call. `currentTab` is a prop,
      // and `handleLoadMore` reads the pagination and the offset off it, so a hook left
      // holding the array as it was at mount would page from a stale offset — which is
      // the harness lying, not the hook.
      const { result, rerender, unmount } = renderHook(
        (props: { tab: QueryTab }) =>
          useQueryExecution({
            activeConnection: connection,
            metadata: metadata(),
            tabs,
            activeTabId: props.tab.id,
            currentTab: props.tab,
            setTabs,
            fetchSchema: mock(async () => {}),
            playgroundMode: false,
          } as never),
        { initialProps: { tab: tabs[0] } },
      );

      return {
        run: async (query, options) => {
          rerender({ tab: tabs[0] });
          await act(async () => {
            await result.current.executeQuery(query, "tab-1", false, options);
          });
        },
        loadMore: async () => {
          rerender({ tab: tabs[0] });
          await act(async () => {
            result.current.handleLoadMore();
            await new Promise((resolve) => setTimeout(resolve, 20));
          });
        },
        startLoadMore: () => {
          rerender({ tab: tabs[0] });
          act(() => {
            result.current.handleLoadMore();
          });
        },
        startRun: (query, options) => {
          rerender({ tab: tabs[0] });
          act(() => {
            void result.current.executeQuery(query, "tab-1", false, options);
          });
        },
        startForceRun: (query) => {
          rerender({ tab: tabs[0] });
          act(() => {
            result.current.forceExecuteQuery(query);
          });
        },
        startUnlimited: (query, tabId) => {
          rerender({ tab: tabs[0] });
          // Two acts, the way `tests/hooks/use-query-adapter.test.ts` reaches this path:
          // the handler reads the pending query out of state, so the render carrying it
          // has to commit before Proceed is pressed. That is also the dialog's own
          // ordering - the warning opens on one render and Proceed is a later click.
          act(() => {
            result.current.setPendingUnlimitedQuery({ query, tabId });
            result.current.setUnlimitedWarningOpen(true);
          });
          act(() => {
            result.current.handleUnlimitedQuery();
          });
        },
        cancel: async () => {
          await act(async () => {
            await result.current.cancelQuery();
          });
        },
        runOnTab: async (tabId, query, options) => {
          // The mount follows the user to the other tab first, because that is how the
          // second Run is reached: the tab being looked at is the one that executes.
          rerender({ tab: tabs.find((t) => t.id === tabId)! });
          await act(async () => {
            await result.current.executeQuery(query, tabId, false, options);
          });
        },
        unmount,
        requests: () => requestCount,
      };
    },
  },
  {
    name: "embedded",
    mount: (tabs, setTabs) => {
      const onQueryExecute = mock(async (_connectionId: string, sql: string, options?: object) => {
        requestCount++;
        return (await callRoute({ sql, options })) as never;
      });

      const { result, rerender, unmount } = renderHook(
        (props: { tab: QueryTab }) =>
          useQueryAdapter({
            activeConnection: connection,
            onQueryExecute,
            tabs,
            activeTabId: props.tab.id,
            currentTab: props.tab,
            setTabs,
            fetchSchema: mock(async () => {}),
            features: {},
          } as never),
        { initialProps: { tab: tabs[0] } },
      );

      return {
        run: async (query, options) => {
          rerender({ tab: tabs[0] });
          await act(async () => {
            await result.current.executeQuery(query, "tab-1", false, options);
          });
        },
        loadMore: async () => {
          rerender({ tab: tabs[0] });
          await act(async () => {
            result.current.handleLoadMore();
            await new Promise((resolve) => setTimeout(resolve, 20));
          });
        },
        startLoadMore: () => {
          rerender({ tab: tabs[0] });
          act(() => {
            result.current.handleLoadMore();
          });
        },
        startRun: (query, options) => {
          rerender({ tab: tabs[0] });
          act(() => {
            void result.current.executeQuery(query, "tab-1", false, options);
          });
        },
        startForceRun: (query) => {
          rerender({ tab: tabs[0] });
          act(() => {
            result.current.forceExecuteQuery(query);
          });
        },
        startUnlimited: (query, tabId) => {
          rerender({ tab: tabs[0] });
          // Two acts, the way `tests/hooks/use-query-adapter.test.ts` reaches this path:
          // the handler reads the pending query out of state, so the render carrying it
          // has to commit before Proceed is pressed. That is also the dialog's own
          // ordering - the warning opens on one render and Proceed is a later click.
          act(() => {
            result.current.setPendingUnlimitedQuery({ query, tabId });
            result.current.setUnlimitedWarningOpen(true);
          });
          act(() => {
            result.current.handleUnlimitedQuery();
          });
        },
        cancel: async () => {
          await act(async () => {
            await result.current.cancelQuery();
          });
        },
        runOnTab: async (tabId, query, options) => {
          // The mount follows the user to the other tab first, because that is how the
          // second Run is reached: the tab being looked at is the one that executes.
          rerender({ tab: tabs.find((t) => t.id === tabId)! });
          await act(async () => {
            await result.current.executeQuery(query, tabId, false, options);
          });
        },
        unmount,
        requests: () => requestCount,
      };
    },
  },
];

describe.each(SHELLS)("$name: paging a seeded table end to end (#816)", (shell) => {
  beforeEach(() => {
    requestCount = 0;
  });

  /**
   * CRITERION 2, stated as row identity rather than as a row count. A grid that appended
   * the same fifty rows twice also reaches a hundred rows, and the user cannot tell the
   * duplicates from new ones — which is exactly the failure the Cassandra provider refuses
   * rather than commit.
   */
  test("a 50-row first page is followed by disjoint pages of 50 and 21, then stops", async () => {
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    // Page one, asked for the way a tree click asks: the bound is an OPTION, not text.
    await hook.run("SELECT * FROM orders ORDER BY id", { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));
    expect(tabs[0].result!.pagination!.hasMore).toBe(true);
    expect(tabs[0].result!.pagination!.wasLimited).toBe(true);
    expect(tabs[0].currentOffset).toBe(PAGE_SIZE);
    const firstPageIds = tabs[0].result!.rows.map((row) => row.id);
    expect(firstPageIds[0]).toBe(1);
    expect(firstPageIds[PAGE_SIZE - 1]).toBe(50);

    // Page two. Every id must be new.
    await hook.loadMore();
    await waitFor(() => expect(tabs[0].result!.rows).toHaveLength(2 * PAGE_SIZE));
    const afterTwo = tabs[0].result!.rows.map((row) => row.id);
    expect(new Set(afterTwo).size).toBe(2 * PAGE_SIZE);
    expect(afterTwo.slice(PAGE_SIZE)[0]).toBe(51);
    expect(tabs[0].currentOffset).toBe(2 * PAGE_SIZE);
    expect(tabs[0].result!.pagination!.hasMore).toBe(true);

    // Page three is short, so the offset advances by what ARRIVED and the route stops
    // offering more: 21 rows against a limit of 50.
    await hook.loadMore();
    await waitFor(() => expect(tabs[0].result!.rows).toHaveLength(SEEDED_ROWS));
    const all = tabs[0].result!.rows.map((row) => row.id);
    expect(new Set(all).size).toBe(SEEDED_ROWS);
    expect(all).toEqual(Array.from({ length: SEEDED_ROWS }, (_, i) => i + 1));
    expect(tabs[0].currentOffset).toBe(SEEDED_ROWS);
    expect(tabs[0].result!.pagination!.hasMore).toBe(false);

    // And a fourth click asks for nothing, because there is nothing to ask for.
    const before = hook.requests();
    await hook.loadMore();
    expect(hook.requests()).toBe(before);
  });

  /**
   * CRITERION 5. A `LIMIT n` the user typed is a hard bound: the limiter returns the
   * statement untouched with `wasLimited: false`, the route's `hasMore` requires that
   * flag, and no page two is offered however many rows come back. This is the case that
   * used to be indistinguishable from a preview cap, because both were text in the same
   * string.
   */
  test("a bound the user typed is honoured and never paged past", async () => {
    const { tabs, setTabs } = mutableTabs([makeTab({ query: "SELECT * FROM orders ORDER BY id LIMIT 50" })]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run("SELECT * FROM orders ORDER BY id LIMIT 50", { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    // Exactly `limit` rows came back, which is the whole trap: the old rule, `rows.length
    // === prepared.limit`, said "there is more" for a statement whose offset would have
    // been silently dropped on the next click.
    expect(tabs[0].result!.pagination!.totalReturned).toBe(PAGE_SIZE);
    expect(tabs[0].result!.pagination!.wasLimited).toBe(false);
    expect(tabs[0].result!.pagination!.hasMore).toBe(false);

    const before = hook.requests();
    await hook.loadMore();
    expect(hook.requests()).toBe(before);
    expect(tabs[0].result!.rows).toHaveLength(PAGE_SIZE);
  });

  /**
   * THE LAST PAGE OF A TABLE WHOSE SIZE IS AN EXACT MULTIPLE OF THE PAGE SIZE (#1440).
   *
   * 100 rows at 50 a page fills the second page exactly. The route used to guess "more"
   * from a full page, so the control and the limited badge stood after the 100th row until
   * a click fetched nothing. The statement that runs now asks for one row past the page,
   * and the second page, which has no such row, is the last one: no control, no badge, and
   * no request left to make.
   */
  test("a table that ends exactly on a page boundary offers no page after it", async () => {
    const EXACT = "SELECT * FROM orders WHERE id <= 100 ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab({ query: EXACT })]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run(EXACT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));
    expect(tabs[0].result!.pagination!.hasMore).toBe(true);

    await hook.loadMore();
    await waitFor(() => expect(tabs[0].result!.rows).toHaveLength(2 * PAGE_SIZE));
    expect(tabs[0].result!.pagination!.hasMore).toBe(false);
    expect(tabs[0].result!.pagination!.wasLimited).toBe(false);
    expect(tabs[0].result!.rowCount).toBe(2 * PAGE_SIZE);

    const before = hook.requests();
    await hook.loadMore();
    expect(hook.requests()).toBe(before);
    expect(tabs[0].result!.rows).toHaveLength(2 * PAGE_SIZE);
  });

  /**
   * A PAGE THAT COMES BACK EMPTY, because the table shrank between two clicks.
   *
   * SQLite answers a query that matched nothing with `fields: []` (measured: `SELECT * FROM
   * orders ORDER BY id LIMIT 50 OFFSET 100` returns `rows: 0, fields: []`), and both hooks
   * rebuilt the tab's result from the NEW page, so the grid kept its rows and lost the
   * columns they are rendered under: "50 rows / 0 columns", no headers and no cells.
   *
   * A page of the same statement cannot change the shape, so the shape the rows on screen
   * were rendered under is what survives. Page one still offers a page two, the rows behind
   * it are moved away, and the click finds nothing.
   */
  test("a page that comes back empty leaves the columns the rows are rendered under", async () => {
    const EXACT = "SELECT * FROM orders WHERE id <= 100 ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab({ query: EXACT })]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run(EXACT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));
    const fields = tabs[0].result!.fields;
    expect(fields).toEqual(["id", "label"]);
    expect(tabs[0].result!.pagination!.hasMore).toBe(true);

    await provider.query("UPDATE orders SET id = id + 1000 WHERE id > 50 AND id <= 100");
    try {
      await hook.loadMore();
      await waitFor(() => expect(tabs[0].result!.pagination!.hasMore).toBe(false));
    } finally {
      await provider.query("UPDATE orders SET id = id - 1000 WHERE id > 1050 AND id <= 1100");
    }
    expect(tabs[0].result!.rows).toHaveLength(PAGE_SIZE);
    expect(tabs[0].result!.rowCount).toBe(PAGE_SIZE);
    expect(tabs[0].result!.fields).toEqual(fields);
  });

  /**
   * CRITERION 8, over the real path: a failed page leaves the rows and the offset alone,
   * so a retry asks for the same page rather than skipping one.
   */
  test("a failed page leaves the loaded rows and the offset untouched", async () => {
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run("SELECT * FROM orders ORDER BY id", { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    // The next page names a table that is not there, so the engine refuses it.
    const healthy = tabs[0].resultQuery;
    tabs.splice(0, 1, { ...tabs[0], resultQuery: "SELECT * FROM no_such_table ORDER BY id" });
    await hook.loadMore();

    await waitFor(() => expect(tabs[0].isLoadingMore ?? false).toBe(false));
    expect(tabs[0].result!.rows).toHaveLength(PAGE_SIZE);
    expect(tabs[0].currentOffset).toBe(PAGE_SIZE);
    expect(healthy).toBe("SELECT * FROM orders ORDER BY id");
  });

  /**
   * A RUN THAT LANDS WHILE A PAGE IS IN FLIGHT OWNS THE TAB, AND THE PAGE DOES NOT.
   *
   * The user clicks Load More, waits, gives up and presses Run. The Run replaces the
   * grid; then the page it overtook arrives and appends its rows ON TOP of the new ones
   * and relabels them with the paged statement, so the tab ends up holding rows from two
   * statements while naming one. That is #881's class again, on the paging path.
   *
   * The standalone hook has answered this since #422, through `lastRunRef`: the last run
   * started on a tab owns the tab, and nothing older may write to it. The embedded
   * adapter cannot abort, because the host owns the fetch behind `onQueryExecute`, so
   * ownership is the only mechanism it has, and it had none.
   *
   * Both the rows AND `resultQuery` are asserted, because the two can fail apart: a page
   * that wrote only the statement would leave the new rows labelled with the old query.
   */
  test("a run that lands mid-page owns the tab, and the overtaken page is dropped", async () => {
    const RERUN = "SELECT id, label FROM orders WHERE id <= 3 ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run("SELECT * FROM orders ORDER BY id", { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    // Page two is held inside the route, so it is genuinely in flight and not merely slow.
    const releasePage = holdTheNextPage();
    hook.startLoadMore();
    await waitFor(() => expect(tabs[0].isLoadingMore).toBe(true));

    // The Run overtakes it and lands.
    await hook.run(RERUN, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(3));

    // Only now does the page arrive.
    await act(async () => {
      releasePage();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(tabs[0].result!.rows.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(tabs[0].result!.rowCount).toBe(3);
    expect(tabs[0].resultQuery).toBe(RERUN);
    expect(tabs[0].allRows).toHaveLength(3);
    expect(tabs[0].currentOffset).toBe(3);
    expect(tabs[0].isLoadingMore ?? false).toBe(false);
  });

  /**
   * A CANCEL DOES NOT TAKE THE LOAD MORE CONTROL WITH IT.
   *
   * Cancel is the one thing a user does to a run they have given up on, and the rows
   * already on screen survive it: the grid still shows its first page and still offers
   * the next one. So the very next thing they can do is click Load More.
   *
   * The embedded adapter answers "was this cancelled" with one hook-wide boolean that
   * only a new run clears, and paging was not one of the places that cleared it. The page
   * went out, the flag went up, and the success arm then refused its own write - so the
   * rows never arrived and `isLoadingMore` stayed set, which the control reads as a page
   * still in flight. One Cancel and the button was dead for the rest of the session
   * (#816).
   */
  test("Load More still pages after a run was cancelled", async () => {
    const STATEMENT = "SELECT * FROM orders ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run(STATEMENT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    // A second Run, cancelled while it is genuinely in flight rather than before it left.
    const releaseRun = holdTheNextRun();
    hook.startRun(STATEMENT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].isExecuting).toBe(true));
    await hook.cancel();
    await act(async () => {
      releaseRun();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(tabs[0].isExecuting ?? false).toBe(false);

    // The rows are still there, the control is still offered, and it still works.
    expect(tabs[0].result!.pagination!.hasMore).toBe(true);
    await hook.loadMore();
    await waitFor(() => expect(tabs[0].result!.rows).toHaveLength(2 * PAGE_SIZE));
    expect(tabs[0].result!.rows.map((row) => row.id)).toEqual(Array.from({ length: 2 * PAGE_SIZE }, (_, i) => i + 1));
    expect(tabs[0].isLoadingMore ?? false).toBe(false);
  });

  /**
   * THE SAME RACE IN THE OTHER ORDER: RUN FIRST, THEN LOAD MORE.
   *
   * The run above has the page in flight and the Run overtaking it. This one is the user
   * who presses Run, waits, gives up on it and asks for the next page of what is still on
   * screen. Now it is the PAGE that owns the tab, and the Run that is refused when it
   * lands.
   *
   * A refused run may not write, so it cannot clear the `isExecuting: true` it set itself,
   * and the claim that took the tab from it set only `isLoadingMore`. For as long as the
   * page is in flight the tab therefore carries BOTH flags: a spinner and a CANCEL button
   * for a run that has already been disowned, over a Cancel that would now hit the page
   * instead. Before the ownership check the run's own settle cleared it; the only thing
   * that clears it now is the page's eventual commit, a flag the page never set.
   *
   * The standalone has never had this, because its claim is one write that takes over both
   * flags at once (`isExecuting: !isLoadMore, isLoadingMore: isLoadMore`), which is what
   * this asserts of both products (#816).
   */
  test("a page that overtakes a run leaves no spinner behind", async () => {
    const STATEMENT = "SELECT * FROM orders ORDER BY id";
    const RERUN = "SELECT id, label FROM orders WHERE id <= 3 ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run(STATEMENT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    const releaseRun = holdTheNextRun();
    hook.startRun(RERUN, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].isExecuting).toBe(true));

    // The page is asked for while the run is still out, and takes the tab over.
    const releasePage = holdTheNextPage();
    hook.startLoadMore();
    await waitFor(() => expect(tabs[0].isLoadingMore).toBe(true));

    // The run lands and is refused. It is the page that is running now, and the page
    // alone: what the user is shown has to say so while it is still true.
    await act(async () => {
      releaseRun();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(tabs[0].isLoadingMore).toBe(true);
    expect(tabs[0].isExecuting ?? false).toBe(false);

    // Then the page arrives, and it is the page's rows under the page's statement.
    await act(async () => {
      releasePage();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(tabs[0].isExecuting ?? false).toBe(false);
    expect(tabs[0].isLoadingMore ?? false).toBe(false);
    expect(tabs[0].result!.rows).toHaveLength(2 * PAGE_SIZE);
    expect(tabs[0].resultQuery).toBe(STATEMENT);
  });

  /**
   * OWNERSHIP IS PER TAB, AND THIS IS WHAT PINS IT.
   *
   * Both hooks key the run that owns a tab by tab id, and both say in prose that they do
   * it because tabs execute independently. Nothing measured it: collapsing either map to
   * a single shared slot passed every other test in the suite, and the next reader would
   * have had only the comment.
   *
   * With one slot, the run in tab B disowns the page in flight in tab A. A's rows never
   * append, A's `isLoadingMore` never clears, and A sits there loading for good - the
   * embedded copy of the cross-tab failure the standalone's `runsRef` docblock records
   * (#816).
   */
  test("a run in another tab does not disown a page in flight in this one", async () => {
    const STATEMENT = "SELECT * FROM orders ORDER BY id";
    const OTHER = "SELECT id, label FROM orders WHERE id <= 3 ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab(), makeTab({ id: "tab-2", name: "second", query: OTHER })]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run(STATEMENT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    const releasePage = holdTheNextPage();
    hook.startLoadMore();
    await waitFor(() => expect(tabs[0].isLoadingMore).toBe(true));

    // The user switches to the other tab and runs something there while A is still paging.
    await hook.runOnTab("tab-2", OTHER, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[1].result?.rows).toHaveLength(3));

    await act(async () => {
      releasePage();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // Tab A's page belongs to tab A, and arrives.
    expect(tabs[0].result!.rows).toHaveLength(2 * PAGE_SIZE);
    expect(tabs[0].result!.rows.map((row) => row.id)).toEqual(Array.from({ length: 2 * PAGE_SIZE }, (_, i) => i + 1));
    expect(tabs[0].currentOffset).toBe(2 * PAGE_SIZE);
    expect(tabs[0].isLoadingMore ?? false).toBe(false);
    expect(tabs[0].resultQuery).toBe(STATEMENT);
    // And tab B still holds its own result.
    expect(tabs[1].result!.rows).toHaveLength(3);
  });

  /**
   * NOTHING EITHER HOOK STARTED MAY OUTLIVE IT.
   *
   * The standalone states the reason where it aborts on unmount: "a fetch left running
   * after the studio unmounts resolves into a setState on a component that is gone". The
   * embedded adapter cannot abort, because the host owns the fetch behind
   * `onQueryExecute`, so dropping its ownership claims is how it keeps the same rule: a
   * page whose claim is gone no longer owns its tab, and every commit arm refuses it
   * (#816).
   */
  test("a page that lands after the hook is gone writes nothing", async () => {
    const STATEMENT = "SELECT * FROM orders ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run(STATEMENT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    const releasePage = holdTheNextPage();
    hook.startLoadMore();
    await waitFor(() => expect(tabs[0].isLoadingMore).toBe(true));

    hook.unmount();
    await act(async () => {
      releasePage();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(tabs[0].result!.rows).toHaveLength(PAGE_SIZE);
    expect(tabs[0].currentOffset).toBe(PAGE_SIZE);
  });

  /**
   * THE MIRROR ORDERING: THE PAGE IS ALREADY IN FLIGHT AND THE CANCEL COMES SECOND.
   *
   * "Load More still pages after a run was cancelled" is Cancel first, Load More second.
   * This is the other way round, and it is the ordering a user reaches without trying:
   * click Load More, watch it spin, press Cancel on it.
   *
   * `cancelQuery` in the embedded adapter sets the hook-wide cancelled flag and then
   * clears the tab flags only where `isExecuting` is true, so it skips the very tab the
   * user cancelled: a paging tab carries `isExecuting: false`. That is not something the
   * Load More claim introduced - at the merge base (474c2e3e) the claim wrote only
   * `isLoadingMore: true` and the tab still carried the `isExecuting: false` its previous
   * run had settled, so Cancel missed it there too. The page then lands, its success arm
   * refuses itself on the cancelled flag, and nothing clears `isLoadingMore` short of
   * another Run, so the control, which is `disabled={isLoadingMore}` in `StatsBar`, is
   * dead in the meantime (#816).
   */
  test("a cancel taken while a page is in flight leaves the control usable", async () => {
    const STATEMENT = "SELECT * FROM orders ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run(STATEMENT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    // Held inside the route, so Cancel is genuinely pressed on a page in flight rather
    // than on one that had already come back.
    const releasePage = holdTheNextPage();
    hook.startLoadMore();
    await waitFor(() => expect(tabs[0].isLoadingMore).toBe(true));

    await hook.cancel();
    await act(async () => {
      releasePage();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // Whether the cancelled page was dropped or allowed to land, the tab is not paging.
    expect(tabs[0].isLoadingMore ?? false).toBe(false);
    expect(tabs[0].isExecuting ?? false).toBe(false);

    // And the control that flag disables is live: the next page still arrives. Asserted
    // as growth rather than as an exact row set, because the two products legitimately
    // differ on whether the cancelled page itself landed - only the flag is the subject.
    expect(tabs[0].result!.pagination!.hasMore).toBe(true);
    await hook.loadMore();
    await waitFor(() => expect(tabs[0].result!.rows.length).toBeGreaterThan(PAGE_SIZE));
    expect(tabs[0].isLoadingMore ?? false).toBe(false);
  });

  /**
   * A RUN'S CLAIM TAKES OVER BOTH FLAGS, NOT ONLY ITS OWN.
   *
   * The reverse of "a page that overtakes a run leaves no spinner behind": there the page
   * claim has to take `isExecuting` over from the run it disowns, and here the run claim
   * has to take `isLoadingMore` over from the page it disowns. One rule, both directions,
   * and only one of them was closed.
   *
   * A disowned page may not write, so it can no longer clear the `isLoadingMore: true` it
   * set itself. A claim that writes `isExecuting: true` and nothing else therefore leaves
   * the tab spinning a Load More, for the whole of the new run, over a page whose rows
   * will never be shown. The standalone writes both in one go
   * (`isExecuting: !isLoadMore, isLoadingMore: isLoadMore`), which is what this asks of
   * both products (#816).
   */
  test("a run that claims a tab mid-page takes the paging flag over too", async () => {
    const STATEMENT = "SELECT * FROM orders ORDER BY id";
    const RERUN = "SELECT id, label FROM orders WHERE id <= 3 ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run(STATEMENT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    const releasePage = holdTheNextPage();
    hook.startLoadMore();
    await waitFor(() => expect(tabs[0].isLoadingMore).toBe(true));

    // The Run is held as well, because the defect lives in the window between its claim
    // and its settle: the settle clears both flags either way, so a Run awaited to
    // completion cannot see it.
    const releaseRun = holdTheNextRun();
    hook.startRun(RERUN, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].isExecuting).toBe(true));

    expect(tabs[0].isLoadingMore ?? false).toBe(false);

    // The disowned page lands and is refused, so it moves nothing in either direction.
    await act(async () => {
      releasePage();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(tabs[0].isExecuting).toBe(true);
    expect(tabs[0].isLoadingMore ?? false).toBe(false);

    // Then the Run settles, with its own rows under its own statement and no flag left.
    await act(async () => {
      releaseRun();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(tabs[0].isExecuting ?? false).toBe(false);
    expect(tabs[0].isLoadingMore ?? false).toBe(false);
    expect(tabs[0].result!.rows.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(tabs[0].resultQuery).toBe(RERUN);
  });

  /**
   * THE SAME RULE ON THE SAFETY DIALOG'S PROCEED.
   *
   * "a run that claims a tab mid-page takes the paging flag over too" asks it of the Run
   * button. This asks it of the other run entry point a user can reach with a page in
   * flight: type a DELETE, press Run, get the dangerous-statement dialog, press Proceed.
   * `StudioWorkspace` wires that button straight to `forceExecuteQuery`
   * (`src/workspace/StudioWorkspace.tsx`), so it is a second claim on the tab with none of
   * `executeQuery` above it.
   *
   * It is the claim, not the settle, that has to write both flags: a claim disowns the
   * page in flight, and a disowned page may not write, so it can no longer clear the
   * `isLoadingMore: true` it set itself. Held on both sides for that reason - the settle
   * clears both flags either way, so a Proceed awaited to completion cannot see the window
   * this is about (#816).
   */
  test("the safety dialog's Proceed takes the paging flag over too", async () => {
    const STATEMENT = "SELECT * FROM orders ORDER BY id";
    const FORCED = "SELECT id, label FROM orders WHERE id <= 3 ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run(STATEMENT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    const releasePage = holdTheNextPage();
    hook.startLoadMore();
    await waitFor(() => expect(tabs[0].isLoadingMore).toBe(true));

    const releaseRun = holdTheNextRun();
    hook.startForceRun(FORCED);
    await waitFor(() => expect(tabs[0].isExecuting).toBe(true));

    expect(tabs[0].isLoadingMore ?? false).toBe(false);

    // The disowned page lands and is refused, so it moves nothing in either direction.
    await act(async () => {
      releasePage();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(tabs[0].isExecuting).toBe(true);
    expect(tabs[0].isLoadingMore ?? false).toBe(false);

    await act(async () => {
      releaseRun();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(tabs[0].isExecuting ?? false).toBe(false);
    expect(tabs[0].isLoadingMore ?? false).toBe(false);
    expect(tabs[0].result!.rows.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(tabs[0].resultQuery).toBe(FORCED);
  });

  /**
   * AND ON THE UNLIMITED-WARNING DIALOG'S PROCEED, THE THIRD AND LAST RUN ENTRY POINT.
   *
   * `handleUnlimitedQuery` is the fourth claim on the tab in the embedded adapter and it
   * had the same hole. Nothing in `src/` calls `setPendingUnlimitedQuery` or opens the
   * warning today, in either product, so there is no click to reproduce this from: it is
   * driven here the way the adapter's own unit tests drive it, by setting the pending
   * query and then pressing Proceed. A reader should not go hunting for the UI path.
   *
   * It is fixed anyway, and asserted anyway, because the hook exports the handler and the
   * dialog that calls it is already rendered in both products - the day something sets a
   * pending query, this claim is live, and a rule that holds for three of four entry
   * points is not a rule (#816).
   */
  test("the unlimited dialog's Proceed takes the paging flag over too", async () => {
    const STATEMENT = "SELECT * FROM orders ORDER BY id";
    const UNBOUNDED = "SELECT id, label FROM orders WHERE id <= 3 ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run(STATEMENT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    const releasePage = holdTheNextPage();
    hook.startLoadMore();
    await waitFor(() => expect(tabs[0].isLoadingMore).toBe(true));

    const releaseRun = holdTheNextRun();
    hook.startUnlimited(UNBOUNDED, "tab-1");
    await waitFor(() => expect(tabs[0].isExecuting).toBe(true));

    expect(tabs[0].isLoadingMore ?? false).toBe(false);

    await act(async () => {
      releasePage();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(tabs[0].isExecuting).toBe(true);
    expect(tabs[0].isLoadingMore ?? false).toBe(false);

    await act(async () => {
      releaseRun();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(tabs[0].isExecuting ?? false).toBe(false);
    expect(tabs[0].isLoadingMore ?? false).toBe(false);
    expect(tabs[0].result!.rows.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(tabs[0].resultQuery).toBe(UNBOUNDED);
  });
});
