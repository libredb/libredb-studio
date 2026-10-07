import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
