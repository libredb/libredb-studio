import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ObjectTree } from "@/components/object-tree";
import { useTreeNodes } from "@/components/object-tree/use-tree-nodes";
import type { DatabaseObject, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The tree's filter (U25), driven through the hook that owns the cache.
 *
 * The one rule every case leans on: the filter is a VIEW of what was read. Typing never asks for a
 * read, the reader's own expansion state survives it untouched, and a read happens only on a press.
 */

const oneLevel = {
  queryLanguage: "sql",
  containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
  objectKinds: [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
    { id: "view", role: "relation", label: "View", labelPlural: "Views" },
  ],
} as unknown as ProviderCapabilities;

function connectionOf(id: string): DatabaseConnection {
  return { id, name: `conn ${id}`, type: "postgres", createdAt: new Date("2026-01-01") };
}

const appObjects: Record<string, DatabaseObject[]> = {
  table: [
    { path: ["app", "orders"], name: "orders", kind: "table" },
    { path: ["app", "customers"], name: "customers", kind: "table" },
  ],
  view: [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }],
};

interface Call {
  readonly route: string;
  readonly body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;

/** `app` opens on first paint (session default); `audit` is known and never opened. */
function installFetch(): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    const route = text.slice(text.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ route, body });
    const container = (body.container ?? body.path) as string[] | undefined;
    switch (route) {
      case "containers":
        return Response.json([
          { path: ["app"], name: "app", level: 0, isSessionDefault: true },
          { path: ["audit"], name: "audit", level: 0 },
        ]);
      case "counts":
        return Response.json({ table: { count: 2 }, view: { count: 1 } });
      case "list":
        return Response.json(container?.[0] === "app" ? (appObjects[String(body.kind)] ?? []) : []);
      default:
        return Response.json({ path: body.path, columns: [{ name: "id", type: "int" }], indexes: [], foreignKeys: [] });
    }
  }) as never;
  return calls;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

/** Mounts the hook, opens and closes `Tables` so its objects are READ but the folder is COLLAPSED. */
async function mountWithReadTables() {
  const calls = installFetch();
  const hook = renderHook(
    ({ query }: { query: string }) => useTreeNodes(connectionOf("pg"), oneLevel, false, undefined, true, query),
    {
      initialProps: { query: "" },
    },
  );
  await waitFor(() => expect(hook.result.current.rows.some((row) => row.id === "app/table")).toBe(true));
  act(() => hook.result.current.toggle("app/table"));
  await waitFor(() => expect(hook.result.current.rows.some((row) => row.label === "orders")).toBe(true));
  act(() => hook.result.current.toggle("app/table"));
  await waitFor(() => expect(hook.result.current.rows.some((row) => row.label === "orders")).toBe(false));
  return { calls, hook };
}

describe("useTreeNodes with a query", () => {
  test("finds an object in a READ folder the reader collapsed, and asks for nothing", async () => {
    const { calls, hook } = await mountWithReadTables();
    const before = calls.length;

    hook.rerender({ query: " ORD" });

    expect(hook.result.current.rows.map((row) => row.label)).toEqual(["app", "Tables", "orders"]);
    expect(hook.result.current.rows[0].setSize).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.length).toBe(before);
  });

  test("collapsing while filtering is the filter's own, and clearing restores the reader's tree", async () => {
    const { hook } = await mountWithReadTables();
    const unfiltered = hook.result.current.rows.map((row) => [row.id, row.expanded]);

    hook.rerender({ query: "ord" });
    act(() => hook.result.current.toggle("app"));
    expect(hook.result.current.rows.map((row) => row.label)).toEqual(["app"]);

    hook.rerender({ query: "orde" });
    expect(hook.result.current.rows.map((row) => row.label)).toEqual(["app", "Tables", "orders"]);

    hook.rerender({ query: "" });
    expect(hook.result.current.rows.map((row) => [row.id, row.expanded])).toEqual(unfiltered);
  });

  test("typing reads nothing for a table whose columns a DDL refresh dropped behind a collapsed folder", async () => {
    const calls = installFetch();
    const hook = renderHook(
      ({ query }: { query: string }) => useTreeNodes(connectionOf("pg"), oneLevel, false, undefined, true, query),
      {
        initialProps: { query: "" },
      },
    );
    await waitFor(() => expect(hook.result.current.rows.some((row) => row.id === "app/table")).toBe(true));
    act(() => hook.result.current.toggle("app/table"));
    await waitFor(() => expect(hook.result.current.rows.some((row) => row.label === "orders")).toBe(true));
    const orders = hook.result.current.rows.find((row) => row.label === "orders")?.id ?? "";
    act(() => hook.result.current.toggle(orders));
    await waitFor(() => expect(hook.result.current.rows.some((row) => row.label === "id")).toBe(true));
    act(() => hook.result.current.toggle("app/table"));
    // The DDL refresh: it drops the columns of an object it is not re-reading.
    act(() => hook.result.current.refresh());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = calls.length;

    hook.rerender({ query: "orders" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.slice(before).map((call) => call.route)).toEqual([]);
    expect(hook.result.current.rows.find((row) => row.label === "orders")?.expanded).toBe(false);
  });

  test("opening a table's columns from the filtered view reads them, though its folder is collapsed", async () => {
    const { calls, hook } = await mountWithReadTables();
    hook.rerender({ query: "orders" });
    const orders = hook.result.current.rows.find((row) => row.label === "orders");

    act(() => hook.result.current.toggle(orders?.id ?? ""));

    await waitFor(() =>
      expect(hook.result.current.rows.map((row) => row.label)).toEqual(["app", "Tables", "orders", "id"]),
    );
    expect(calls.filter((call) => call.route === "describe")).toHaveLength(1);
  });
});

describe("what the filter cannot see", () => {
  test("is counted, never read on its own, and read on a press into the same cache", async () => {
    const { calls, hook } = await mountWithReadTables();
    hook.rerender({ query: "ord" });

    // app/view (count 1) plus audit's two folders (counts unread). app/table is read.
    expect(hook.result.current.search).toMatchObject({ matches: 1, unread: 3, reading: 0, failed: 0 });
    const lists = () =>
      calls.filter((call) => call.route === "list").map((call) => [call.body.container, call.body.kind]);
    expect(lists()).toEqual([[["app"], "table"]]);

    act(() => hook.result.current.search?.readUnread());

    await waitFor(() => expect(hook.result.current.search).toMatchObject({ matches: 2, unread: 0, reading: 0 }));
    expect(lists()).toEqual([
      [["app"], "table"],
      [["app"], "view"],
      [["audit"], "table"],
      [["audit"], "view"],
    ]);
    hook.rerender({ query: "" });
    expect(hook.result.current.rows.find((row) => row.id === "app/view")?.expanded).toBe(false);
  });

  test("a folder whose count is an exact zero or a refusal is not counted as unread", async () => {
    installFetch();
    const zero = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) =>
      String(url).endsWith("/counts")
        ? Response.json({ table: { count: 0 }, view: { unavailable: "not granted" } })
        : zero(url, init),
    ) as never;
    const hook = renderHook(() => useTreeNodes(connectionOf("pg"), oneLevel, false, undefined, true, "x"));
    await waitFor(() => expect(hook.result.current.search?.unread).toBe(2));
  });

  test("reads at most one batch per press", async () => {
    const calls: Call[] = [];
    const schemas = Array.from({ length: 30 }, (_, index) => ({ path: [`s${index}`], name: `s${index}`, level: 0 }));
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      const route = String(url).slice(String(url).lastIndexOf("/") + 1);
      calls.push({ route, body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json(route === "containers" ? schemas : []);
    }) as never;
    const hook = renderHook(() => useTreeNodes(connectionOf("many"), oneLevel, false, undefined, true, "zzz"));
    await waitFor(() => expect(hook.result.current.search?.unread).toBe(60));

    act(() => hook.result.current.search?.readUnread());
    // The fetch is issued inside an async read, so it is waited for rather than read synchronously.
    await waitFor(() => expect(calls.filter((call) => call.route === "list")).toHaveLength(24));

    await waitFor(() => expect(hook.result.current.search).toMatchObject({ unread: 36, reading: 0 }));
    act(() => hook.result.current.search?.readUnread());
    await waitFor(() => expect(calls.filter((call) => call.route === "list")).toHaveLength(48));
  });

  test("a read that failed is counted apart, and is not re-issued by the press", async () => {
    installFetch();
    const ok = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) =>
      String(url).endsWith("/list") ? Response.json({ error: "rate limited" }, { status: 429 }) : ok(url, init),
    ) as never;
    const hook = renderHook(() => useTreeNodes(connectionOf("pg"), oneLevel, false, undefined, true, "x"));
    await waitFor(() => expect(hook.result.current.search?.unread).toBe(4));

    act(() => hook.result.current.search?.readUnread());

    await waitFor(() => expect(hook.result.current.search).toMatchObject({ unread: 0, reading: 0, failed: 4 }));
  });

  test("is absent when nothing is typed", async () => {
    installFetch();
    const hook = renderHook(() => useTreeNodes(connectionOf("pg"), oneLevel));
    await waitFor(() => expect(hook.result.current.rows.length).toBeGreaterThan(0));
    expect(hook.result.current.search).toBeUndefined();
  });
});

/**
 * The rendered rows' labels, read from the label span rather than from the accessible name. A
 * highlighted label is split by a `<mark>`, and happy-dom reports no `display` for one, so
 * `dom-accessibility-api` treats it as a block and names the row "cust om ers". A browser draws
 * `mark` inline and names it "customers"; the label's text is the same in both.
 */
function shownLabels(): (string | null)[] {
  return screen.queryAllByTestId("tree-row-label").map((label) => label.textContent);
}

describe("ObjectTree filter box", () => {
  async function mountTree() {
    const calls = installFetch();
    const view = render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await userEvent.click(await screen.findByRole("treeitem", { name: /Tables/ }));
    await screen.findByRole("treeitem", { name: /orders/ });
    return { calls, view };
  }

  test("typing filters the tree, announces the count, and issues no request", async () => {
    const { calls } = await mountTree();
    const before = calls.length;
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter objects" }), "cust");

    await waitFor(() => expect(screen.getByTestId("tree-filter-matches").textContent).toBe("1 match"));
    expect(shownLabels()).toEqual(["app", "Tables", "customers"]);
    expect(calls.length).toBe(before);
  });

  test("Escape clears it and ArrowDown hands focus to the first row", async () => {
    await mountTree();
    const box = screen.getByRole("searchbox", { name: "Filter objects" });
    await userEvent.type(box, "cust");
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(document.activeElement?.getAttribute("data-row-id")).toBe("app"));

    box.focus();
    await userEvent.keyboard("{Escape}");
    expect((box as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(screen.getByRole("treeitem", { name: /orders/ })).toBeTruthy());
  });

  test("no match keeps the status line and offers the unread read", async () => {
    const { calls } = await mountTree();
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter objects" }), "summary");

    await waitFor(() => expect(screen.getByTestId("tree-no-match")).toBeTruthy());
    expect(screen.getByTestId("tree-no-match").textContent).toBe(
      'No loaded object matches "summary"Only folders that have been read are searched.',
    );
    expect(screen.getByTestId("tree-filter-unread").textContent).toBe("3 not read yet");
    await userEvent.click(screen.getByTestId("tree-filter-read"));

    await waitFor(() => expect(shownLabels()).toContain("order_summary"));
    expect(calls.filter((call) => call.route === "list")).toHaveLength(4);
  });

  test("switching connection starts unfiltered", async () => {
    const { view } = await mountTree();
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter objects" }), "cust");
    view.rerender(<ObjectTree connection={connectionOf("other")} capabilities={oneLevel} />);
    await waitFor(() =>
      expect((screen.getByRole("searchbox", { name: "Filter objects" }) as HTMLInputElement).value).toBe(""),
    );
  });

  test("clearing after a scroll draws the rows the new scroll box is showing, not the old offset", async () => {
    installFetch();
    const many = Array.from({ length: 300 }, (_, index) => ({
      path: ["app", `t${index}`],
      name: `t${index}`,
      kind: "table",
    }));
    const ok = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) =>
      String(url).endsWith("/list") ? Response.json(many) : ok(url, init),
    ) as never;
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await userEvent.click(await screen.findByRole("treeitem", { name: /Tables/ }));
    await waitFor(() => expect(shownLabels()).toContain("t0"));
    fireEvent.scroll(screen.getByRole("tree"), { target: { scrollTop: 28 * 150 } });
    await waitFor(() => expect(shownLabels()).not.toContain("t0"));
    const box = screen.getByRole("searchbox", { name: "Filter objects" });

    await userEvent.type(box, "t1");
    await userEvent.clear(box);

    // A new scroll box starts at the top, so the window must start there too.
    await waitFor(() => expect(shownLabels()[0]).toBe("app"));
  });

  test("the clear button empties the box", async () => {
    await mountTree();
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter objects" }), "cust");
    await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect((screen.getByRole("searchbox", { name: "Filter objects" }) as HTMLInputElement).value).toBe("");
  });

  test("a batch in flight is shown, and the action waits for it", async () => {
    const releases: (() => void)[] = [];
    const schemas = Array.from({ length: 30 }, (_, index) => ({ path: [`s${index}`], name: `s${index}`, level: 0 }));
    globalThis.fetch = mock(async (url: string | URL) => {
      const route = String(url).slice(String(url).lastIndexOf("/") + 1);
      if (route === "containers") return Response.json(schemas);
      return new Promise<Response>((resolve) => releases.push(() => resolve(Response.json([]))));
    }) as never;
    render(<ObjectTree connection={connectionOf("many")} capabilities={oneLevel} />);
    await userEvent.type(await screen.findByRole("searchbox", { name: "Filter objects" }), "zzz");
    await waitFor(() => expect(screen.getByTestId("tree-filter-read").textContent).toBe("Read 24 more"));

    await userEvent.click(screen.getByTestId("tree-filter-read"));

    await waitFor(() => expect(screen.getByTestId("tree-filter-reading").textContent).toBe("Reading 24..."));
    expect(screen.getByTestId("tree-filter-unread").textContent).toBe("36 not read yet");
    expect((screen.getByTestId("tree-filter-read") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      for (const release of releases.splice(0)) release();
    });
    await waitFor(() => expect(screen.queryByTestId("tree-filter-reading")).toBeNull());
    expect((screen.getByTestId("tree-filter-read") as HTMLButtonElement).disabled).toBe(false);
  });

  test("reads that failed are counted apart", async () => {
    installFetch();
    const ok = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) =>
      String(url).endsWith("/list") ? Response.json({ error: "rate limited" }, { status: 429 }) : ok(url, init),
    ) as never;
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await userEvent.type(await screen.findByRole("searchbox", { name: "Filter objects" }), "x");
    await waitFor(() => expect(screen.getByTestId("tree-filter-read").textContent).toBe("Read and search"));

    await userEvent.click(screen.getByTestId("tree-filter-read"));

    await waitFor(() => expect(screen.getByTestId("tree-filter-failed").textContent).toBe("4 could not be read"));
    expect(screen.queryByTestId("tree-filter-unread")).toBeNull();
  });
});
