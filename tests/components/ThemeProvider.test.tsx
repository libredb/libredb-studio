import "../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";

// Capture what the wrapper actually hands next-themes. These four props are the
// whole contract — they decide WHERE the class lands, what an untouched install
// looks like, and whether "system" is even offered.
let received: Record<string, unknown> = {};
mock.module("next-themes", () => ({
  ThemeProvider: (props: Record<string, unknown>) => {
    received = props;
    return React.createElement("div", { "data-testid": "next-themes" }, props.children as React.ReactNode);
  },
}));

const { ThemeProvider } = await import("@/components/theme-provider");

describe("ThemeProvider", () => {
  afterEach(() => {
    cleanup();
    received = {};
  });

  /**
   * `attribute="class"` is what makes `.dark` in the token stylesheet the switch.
   * With next-themes' default (`data-theme`) the tokens would never flip.
   */
  test("drives the theme through the class attribute the tokens key on", () => {
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(received.attribute).toBe("class");
  });

  /** Studio has always been dark; a fresh install must not change appearance. */
  test("defaults to dark", () => {
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(received.defaultTheme).toBe("dark");
  });

  /**
   * The toggle offers two states, so system must be off — and not only for tidiness.
   * With it enabled, next-themes would keep RESOLVING a stored "system" against the
   * OS; with it disabled it writes that value to the document as a literal class,
   * matching neither palette. Both halves of that are why the storage key moved.
   */
  test("does not offer a system state the toggle cannot reach", () => {
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(received.enableSystem).toBe(false);
  });

  /**
   * Not next-themes' default `"theme"`. That key may still hold a value from the
   * three-state build, which this provider can no longer resolve — a fresh key is
   * a clean slate instead of a migration.
   */
  test("reads its own storage key, not the one the old value sits under", () => {
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(received.storageKey).toBe("libredb-theme");
    expect(received.storageKey).not.toBe("theme");
  });

  test("suppresses transitions so a switch does not animate every surface at once", () => {
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(received.disableTransitionOnChange).toBe(true);
  });

  test("renders its children", () => {
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(screen.getByText("child")).not.toBeNull();
  });

  test("caller overrides win — the defaults are defaults, not a lock", () => {
    render(
      <ThemeProvider defaultTheme="light">
        <span>child</span>
      </ThemeProvider>,
    );
    expect(received.defaultTheme).toBe("light");
  });
});
