import "../setup-dom";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ReactDOMServer from "react-dom/server";

// ── next-themes stand-in ─────────────────────────────────────────────────────
// The real provider writes to <html> and localStorage; what these tests are about
// is the toggle's OWN decisions — which icon, which next theme, and whether it
// renders at all — so the hook is driven directly.
let themeState: { theme: string | undefined; themes: string[] } = {
  theme: "dark",
  themes: ["dark", "light"],
};
const setThemeMock = mock((_theme: string) => {});

mock.module("next-themes", () => ({
  useTheme: () => ({ theme: themeState.theme, themes: themeState.themes, setTheme: setThemeMock }),
}));

const { ThemeToggle } = await import("@/components/theme-toggle");

function withTheme(theme: string | undefined, themes = ["dark", "light"]) {
  themeState = { theme, themes };
}

describe("ThemeToggle", () => {
  afterEach(() => {
    cleanup();
    setThemeMock.mockClear();
    withTheme("dark");
  });

  /**
   * The embedded case. A host app owns the `dark` class, studio has no provider,
   * and next-themes' default context reports an empty `themes` array. A button
   * that calls a no-op `setTheme` would look functional and do nothing, so it
   * must not exist at all.
   */
  test("renders nothing when no ThemeProvider is mounted above it", () => {
    withTheme(undefined, []);
    const { container } = render(<ThemeToggle />);
    expect(container.innerHTML).toBe("");
  });

  test("renders a labelled control when a provider is present", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).not.toBeNull();
  });

  // ── The dark ↔ light toggle ────────────────────────────────────────────────

  test("dark switches to light", () => {
    withTheme("dark");
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(setThemeMock).toHaveBeenCalledWith("light");
  });

  test("light switches back to dark", () => {
    withTheme("light");
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(setThemeMock).toHaveBeenCalledWith("dark");
  });

  /**
   * Two clicks return the viewer to where they started. That is the property the
   * third state cost, and the reason it was dropped.
   */
  test("two clicks come back to the start", () => {
    withTheme("dark");
    const { unmount } = render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(setThemeMock).toHaveBeenLastCalledWith("light");
    unmount();

    withTheme("light");
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(setThemeMock).toHaveBeenLastCalledWith("dark");
  });

  /**
   * `theme` is undefined until next-themes has read storage, and the key may still
   * hold "system" from the three-state build. Neither may leave the control stuck
   * or ambiguous: everything that is not "light" reads as dark, which is also the
   * provider's default.
   */
  test("a stored theme from the three-state build reads as dark", () => {
    withTheme("system");
    render(<ThemeToggle />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Switch to light theme");
    fireEvent.click(screen.getByRole("button"));
    expect(setThemeMock).toHaveBeenCalledWith("light");
  });

  test("an unresolved theme reads as dark", () => {
    withTheme(undefined);
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(setThemeMock).toHaveBeenCalledWith("light");
  });

  // ── Affordance ─────────────────────────────────────────────────────────────

  test("the label names where the click goes, not where the theme is", () => {
    withTheme("dark");
    render(<ThemeToggle />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Switch to light theme");
  });

  /**
   * And the icon names the same thing. It shipped naming the CURRENT theme while
   * the label named the destination, so the button a sighted user saw and the
   * button a screen reader announced were two different controls.
   */
  test("the icon names the same destination the label does", () => {
    withTheme("dark");
    const { unmount } = render(<ThemeToggle />);
    expect(screen.getByRole("button").querySelector("svg")?.getAttribute("class")).toContain("lucide-sun");
    unmount();

    withTheme("light");
    render(<ThemeToggle />);
    expect(screen.getByRole("button").querySelector("svg")?.getAttribute("class")).toContain("lucide-moon");
  });

  // ── The labelled form (#401) ────────────────────────────────────────────────

  /**
   * The desktop header has room for an icon beside other icons; a dropdown row does
   * not read that way, and an unlabelled 14px glyph in a menu is not a control a
   * viewer finds. `showLabel` puts the destination in the button as visible text.
   */
  test("showLabel puts the destination in the button as text", () => {
    withTheme("dark");
    render(<ThemeToggle showLabel />);
    expect(screen.getByRole("button").textContent).toContain("Switch to light theme");
  });

  test("the visible text follows the theme, as the aria-label does", () => {
    withTheme("light");
    render(<ThemeToggle showLabel />);
    expect(screen.getByRole("button").textContent).toContain("Switch to dark theme");
  });

  /**
   * The label lives INSIDE the button rather than beside it, so the embedded
   * contract survives: no provider means no control AND no orphan caption for a
   * control that is not there. A caller that wrapped its own text around the
   * toggle would leave that caption behind.
   */
  test("the labelled form still renders nothing without a provider", () => {
    withTheme(undefined, []);
    const { container } = render(<ThemeToggle showLabel />);
    expect(container.innerHTML).toBe("");
  });

  test("accepts a className so the header can place it", () => {
    render(<ThemeToggle className="mr-1" />);
    expect(screen.getByRole("button").className).toContain("mr-1");
  });

  /**
   * The icon follows the resolved theme, which the server cannot know. Rendering
   * it before hydration would emit an icon the client may immediately replace —
   * so the first paint is a same-size placeholder, and the box never reflows.
   */
  test("holds the icon's space until hydration instead of guessing", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.textContent).toBe("");
  });

  // ── Hydration ──────────────────────────────────────────────────────────────

  /**
   * The client-side tests above cannot see this: `useSyncExternalStore` hands
   * jsdom the CLIENT snapshot immediately, so `hydrated` is never false there and
   * the pre-hydration markup is only reachable through an actual server render.
   *
   * That gap let a real hydration mismatch ship — the icon was guarded but the
   * label was not, so the server named one destination and the client another,
   * and React refused to patch the attributes.
   */
  test("the server names no destination it might have to take back", () => {
    withTheme("light");
    const html = ReactDOMServer.renderToStaticMarkup(<ThemeToggle />);
    expect(html).toContain('aria-label="Toggle theme"');
    expect(html).toContain('title="Toggle theme"');
  });

  /**
   * The label must not depend on the stored theme server-side either — that is
   * precisely what differed between the two renders.
   */
  test("the server markup is the same whatever theme is stored", () => {
    withTheme("dark");
    const asDark = ReactDOMServer.renderToStaticMarkup(<ThemeToggle />);
    withTheme("light");
    const asLight = ReactDOMServer.renderToStaticMarkup(<ThemeToggle />);
    withTheme(undefined);
    const asUnset = ReactDOMServer.renderToStaticMarkup(<ThemeToggle />);

    expect(asLight).toBe(asDark);
    expect(asUnset).toBe(asDark);
  });
});
