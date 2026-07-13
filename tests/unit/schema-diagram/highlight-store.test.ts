import { describe, expect, mock, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createHighlightStore,
  HighlightStoreProvider,
  useEdgeHighlight,
  useTableHighlighted,
} from "@/components/schema-diagram/highlight-store";

describe("createHighlightStore", () => {
  test("starts with no selection", () => {
    const store = createHighlightStore();
    expect(store.getSelected()).toBeNull();
    expect(store.isHighlighted("users")).toBe(false);
    expect(store.hasSelection()).toBe(false);
  });

  test("select marks the table and its neighbors highlighted", () => {
    const store = createHighlightStore();
    store.select("orders", new Set(["users"]));
    expect(store.getSelected()).toBe("orders");
    expect(store.hasSelection()).toBe(true);
    expect(store.isHighlighted("orders")).toBe(true);
    expect(store.isHighlighted("users")).toBe(true);
    expect(store.isHighlighted("products")).toBe(false);
  });

  test("select(null) clears the selection", () => {
    const store = createHighlightStore();
    store.select("orders", new Set(["users"]));
    store.select(null);
    expect(store.getSelected()).toBeNull();
    expect(store.isHighlighted("orders")).toBe(false);
    expect(store.hasSelection()).toBe(false);
  });

  test("notifies subscribers on every change and supports unsubscribe", () => {
    const store = createHighlightStore();
    const listener = mock(() => {});
    const unsubscribe = store.subscribe(listener);

    store.select("a", new Set());
    store.select(null);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.select("b", new Set());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("selecting the same table again is a no-op notification-wise", () => {
    const store = createHighlightStore();
    const listener = mock(() => {});
    store.select("a", new Set(["b"]));
    store.subscribe(listener);
    store.select("a", new Set(["b"]));
    expect(listener).not.toHaveBeenCalled();
  });
});

// Server rendering exercises the hooks' server snapshots (useSyncExternalStore
// third argument) without a DOM: highlights must always start unhighlighted so
// hydration never disagrees with the first client snapshot.
describe("highlight hooks", () => {
  function TableProbe({ table }: { table: string }) {
    return React.createElement("span", null, String(useTableHighlighted(table)));
  }

  function EdgeProbe({ source, target }: { source: string; target: string }) {
    return React.createElement("span", null, useEdgeHighlight(source, target));
  }

  test("useTableHighlighted throws when used outside a HighlightStoreProvider", () => {
    expect(() => renderToStaticMarkup(React.createElement(TableProbe, { table: "users" }))).toThrow(
      "useHighlightStore must be used inside a HighlightStoreProvider",
    );
  });

  test("useTableHighlighted server-renders as not highlighted even with an active selection", () => {
    const store = createHighlightStore();
    store.select("users", new Set(["orders"]));
    const html = renderToStaticMarkup(
      React.createElement(
        HighlightStoreProvider,
        { value: store },
        React.createElement(TableProbe, { table: "users" }),
      ),
    );
    expect(html).toContain("false");
  });

  test("useEdgeHighlight server-renders as none even with an active selection", () => {
    const store = createHighlightStore();
    store.select("orders", new Set(["users"]));
    const html = renderToStaticMarkup(
      React.createElement(
        HighlightStoreProvider,
        { value: store },
        React.createElement(EdgeProbe, { source: "orders", target: "users" }),
      ),
    );
    expect(html).toContain("none");
  });
});
