import "../setup-dom";

import { describe, test, expect, afterEach } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useTabSummaries } from "@/hooks/use-tab-summaries";
import type { QueryTab } from "@/lib/types";

afterEach(cleanup);

const tab = (overrides: Partial<QueryTab> = {}): QueryTab => ({
  id: "tab-1",
  name: "Query 1",
  query: "SELECT 1",
  result: null,
  isExecuting: false,
  type: "sql",
  ...overrides,
});

/*
 * X5: both shells hand the memoized tab bar these summaries instead of the tabs. A keystroke
 * writes the query into the tabs, so the tabs array is new on every keystroke; the summary
 * array has to stay the same array for as long as nothing the strip draws has changed.
 */
describe("useTabSummaries", () => {
  test("summarises what the strip draws and nothing else", () => {
    const { result } = renderHook(() =>
      useTabSummaries([
        tab(),
        tab({ id: "src", name: "Source: app.f", source: { path: ["app", "f"], kind: "function", dirty: true } }),
      ]),
    );
    expect(result.current).toEqual([
      { id: "tab-1", name: "Query 1", type: "sql", isSource: false, dirty: false },
      { id: "src", name: "Source: app.f", type: "sql", isSource: true, dirty: true },
    ]);
  });

  test("a change that only rewrites the query, the result or the run state keeps the same array", () => {
    const { result, rerender } = renderHook(({ tabs }) => useTabSummaries(tabs), {
      initialProps: { tabs: [tab(), tab({ id: "tab-2", name: "Query 2" })] },
    });
    const first = result.current;

    rerender({ tabs: [tab({ query: "SELECT 12" }), tab({ id: "tab-2", name: "Query 2" })] });
    expect(result.current).toBe(first);

    rerender({
      tabs: [tab({ query: "SELECT 12", isExecuting: true, runError: "boom" }), tab({ id: "tab-2", name: "Query 2" })],
    });
    expect(result.current).toBe(first);
  });

  test.each<[string, QueryTab[]]>([
    ["a rename", [tab({ name: "Renamed" })]],
    ["a new dialect", [tab({ type: "mongodb" })]],
    ["a tab becoming a Source tab", [tab({ source: { path: ["app", "f"], kind: "function" } })]],
    ["an added tab", [tab(), tab({ id: "tab-2" })]],
    ["a removed tab", []],
  ])("%s hands the strip a new array", (_label, next) => {
    const { result, rerender } = renderHook(({ tabs }) => useTabSummaries(tabs), {
      initialProps: { tabs: [tab()] },
    });
    const first = result.current;

    rerender({ tabs: next });
    expect(result.current).not.toBe(first);
    // And the new array is itself kept from then on.
    const second = result.current;
    rerender({ tabs: next.map((t) => ({ ...t, query: "SELECT 99" })) });
    expect(result.current).toBe(second);
  });

  test("a Source tab's edit flipping dirty hands the strip a new array", () => {
    const source = (dirty: boolean) => tab({ id: "src", source: { path: ["app", "f"], kind: "function", dirty } });
    const { result, rerender } = renderHook(({ tabs }) => useTabSummaries(tabs), {
      initialProps: { tabs: [source(false)] },
    });
    const first = result.current;

    rerender({ tabs: [source(true)] });
    expect(result.current).not.toBe(first);
    expect(result.current[0].dirty).toBe(true);
  });

  test("reordering the tabs hands the strip a new array", () => {
    const a = tab({ id: "a" });
    const b = tab({ id: "b" });
    const { result, rerender } = renderHook(({ tabs }) => useTabSummaries(tabs), { initialProps: { tabs: [a, b] } });
    const first = result.current;

    rerender({ tabs: [b, a] });
    expect(result.current.map((summary) => summary.id)).toEqual(["b", "a"]);
    expect(result.current).not.toBe(first);
  });
});
