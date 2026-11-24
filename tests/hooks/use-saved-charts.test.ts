import "../setup-dom";

import { describe, test, expect, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import ReactDOMServer from "react-dom/server";

import { useSavedCharts } from "@/hooks/use-saved-charts";
import { storage } from "@/lib/storage";
import type { SavedChartConfig } from "@/lib/types";

function chart(overrides: Partial<SavedChartConfig> = {}): SavedChartConfig {
  return {
    id: "chart-1",
    name: "Revenue",
    chartType: "bar",
    xAxis: "month",
    yAxis: ["revenue"],
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("useSavedCharts (#2281)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("returns the charts already saved, with their dates revived", () => {
    storage.saveChart(chart());
    const { result } = renderHook(() => useSavedCharts());
    expect(result.current.map((c) => c.id)).toEqual(["chart-1"]);
    expect(result.current[0].createdAt).toBeInstanceOf(Date);
  });

  test("picks up a chart saved while it is mounted", () => {
    const { result } = renderHook(() => useSavedCharts());
    expect(result.current).toEqual([]);

    act(() => {
      storage.saveChart(chart({ id: "chart-2", name: "Fresh" }));
    });

    expect(result.current.map((c) => c.name)).toEqual(["Fresh"]);
  });

  test("drops a chart deleted while it is mounted", () => {
    storage.saveChart(chart());
    const { result } = renderHook(() => useSavedCharts());

    act(() => {
      storage.deleteChart("chart-1");
    });

    expect(result.current).toEqual([]);
  });

  test("keeps the same array across renders while nothing changed", () => {
    storage.saveChart(chart());
    const { result, rerender } = renderHook(() => useSavedCharts());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  test("does not re-read on a change to another collection", () => {
    const { result } = renderHook(() => useSavedCharts());
    // Written past the facade, so only an event could tell the hook about it.
    localStorage.setItem("libredb_saved_charts", JSON.stringify([chart()]));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("libredb-storage-change", { detail: { collection: "favorite_connections", data: [] } }),
      );
    });

    expect(result.current).toEqual([]);
  });

  test("reports no charts during server rendering, even with charts already saved", () => {
    storage.saveChart(chart({ name: "should-not-appear" }));

    function Probe() {
      const charts = useSavedCharts();
      return React.createElement("span", null, `count=${charts.length}`);
    }

    expect(ReactDOMServer.renderToString(React.createElement(Probe))).toContain("count=0");
  });

  test("removes its event listener on unmount", () => {
    const originalRemove = window.removeEventListener.bind(window);
    let removed = false;
    window.removeEventListener = ((...args: Parameters<typeof window.removeEventListener>) => {
      if (args[0] === "libredb-storage-change") removed = true;
      return originalRemove(...args);
    }) as typeof window.removeEventListener;

    try {
      const { unmount } = renderHook(() => useSavedCharts());
      unmount();
      expect(removed).toBe(true);
    } finally {
      window.removeEventListener = originalRemove;
    }
  });
});
