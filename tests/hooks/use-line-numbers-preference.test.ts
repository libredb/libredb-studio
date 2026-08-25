import "../setup-dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import React from "react";
import ReactDOMServer from "react-dom/server";

import { setLineNumbersPreference, useLineNumbersPreference } from "@/hooks/use-line-numbers-preference";

const STORAGE_KEY = "editor-line-numbers";

describe("useLineNumbersPreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  /** Line numbers are on until the user says otherwise; an empty store is not "off". */
  test("defaults to on when nothing is stored", () => {
    const { result } = renderHook(() => useLineNumbersPreference());
    expect(result.current).toBe(true);
  });

  test("reads a stored preference of off", () => {
    localStorage.setItem(STORAGE_KEY, "false");
    const { result } = renderHook(() => useLineNumbersPreference());
    expect(result.current).toBe(false);
  });

  test("reads a stored preference of on", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const { result } = renderHook(() => useLineNumbersPreference());
    expect(result.current).toBe(true);
  });

  /**
   * The writer is what notifies this tab — localStorage's own `storage` event only
   * fires in OTHER tabs — so a toggle has to reach every editor mounted here.
   */
  test("a toggle reaches every mounted editor", () => {
    const first = renderHook(() => useLineNumbersPreference());
    const second = renderHook(() => useLineNumbersPreference());

    act(() => {
      setLineNumbersPreference(false);
    });

    expect(first.result.current).toBe(false);
    expect(second.result.current).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
  });

  /**
   * There is no localStorage on the server, so `useSyncExternalStore` must take the
   * server snapshot — a `getSnapshot` that ran there would dereference localStorage
   * and 500 the page. The stored value is set to "off" first ON PURPOSE: the suite's
   * jsdom gives the server render a working localStorage, so with an unset preference
   * both snapshots answer "true" and the assertion could not tell them apart. With
   * "false" stored, only `getServerSnapshot` can produce "true".
   */
  test("assumes on during server rendering, where no localStorage exists", () => {
    localStorage.setItem(STORAGE_KEY, "false");
    function Probe() {
      return React.createElement("span", null, String(useLineNumbersPreference()));
    }
    expect(ReactDOMServer.renderToString(React.createElement(Probe))).toContain("true");
  });

  test("stops listening once unmounted", () => {
    const { result, unmount } = renderHook(() => useLineNumbersPreference());
    unmount();

    act(() => {
      setLineNumbersPreference(false);
    });

    // No throw, no update: the listener went with the subscription.
    expect(result.current).toBe(true);
  });
});
