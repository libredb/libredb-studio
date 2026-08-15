import "../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import React from "react";
import ReactDOMServer from "react-dom/server";

import { useEffectiveTheme } from "@/hooks/use-effective-theme";

/** The class is the contract; set it the way both owners actually do. */
function setRootTheme(theme: "dark" | "light") {
  document.documentElement.classList.remove("dark", "light");
  document.documentElement.classList.add(theme);
}

describe("useEffectiveTheme", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark", "light");
  });

  test("reports dark when the document carries the dark class", () => {
    setRootTheme("dark");
    const { result } = renderHook(() => useEffectiveTheme());
    expect(result.current).toBe("dark");
  });

  test("reports light when it does not", () => {
    setRootTheme("light");
    const { result } = renderHook(() => useEffectiveTheme());
    expect(result.current).toBe("light");
  });

  /**
   * A bare document — no theme class at all — is the pre-hydration and the
   * unstyled-host case. Light is the honest answer: nothing has asked for dark.
   */
  test("treats an unclassed document as light", () => {
    const { result } = renderHook(() => useEffectiveTheme());
    expect(result.current).toBe("light");
  });

  /**
   * The reason this is an observer and not a one-time read: whoever owns the
   * class — studio's own toggle, or platform — can change it after mount, and a
   * Monaco canvas that kept the old palette would be the only dark thing left on
   * a light page.
   */
  test("follows the class when it changes after mount", async () => {
    setRootTheme("dark");
    const { result } = renderHook(() => useEffectiveTheme());
    expect(result.current).toBe("dark");

    await act(async () => {
      setRootTheme("light");
      // MutationObserver callbacks are delivered as a microtask.
      await Promise.resolve();
    });

    expect(result.current).toBe("light");
  });

  /**
   * On the server there is no document to read, and `useSyncExternalStore` takes
   * the server snapshot instead. It answers "dark" because that is studio's
   * default theme: a light-first guess would make the common case flash.
   */
  test("assumes dark on the server, where no document exists to ask", () => {
    // The class says light — and is deliberately ignored, because the server
    // snapshot is the only branch React may take during SSR.
    setRootTheme("light");
    function Probe() {
      return React.createElement("span", null, useEffectiveTheme());
    }
    expect(ReactDOMServer.renderToString(React.createElement(Probe))).toContain("dark");
  });

  test("stops observing once unmounted", async () => {
    setRootTheme("dark");
    const { result, unmount } = renderHook(() => useEffectiveTheme());
    unmount();

    await act(async () => {
      setRootTheme("light");
      await Promise.resolve();
    });

    // No throw, no update: the observer was disconnected with the subscription.
    expect(result.current).toBe("dark");
  });
});
