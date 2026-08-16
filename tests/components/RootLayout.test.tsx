import "../setup-dom";
import { mock } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";

// Mock the self-hosted geist fonts (they wrap next/font/local, which only
// resolves inside a Next build)
mock.module("geist/font/sans", () => ({
  GeistSans: { variable: "mock-geist-sans", className: "mock-geist-sans" },
}));
mock.module("geist/font/mono", () => ({
  GeistMono: { variable: "mock-geist-mono", className: "mock-geist-mono" },
}));

// Mock @/components/ui/sonner directly to avoid sonner/next-themes/lucide-react chain
mock.module("@/components/ui/sonner", () => ({
  Toaster: (props: Record<string, unknown>) =>
    React.createElement("div", {
      "data-testid": "toaster",
      "data-position": props.position,
      "data-theme": props.theme,
    }),
}));

// Dynamic import so mocks are registered first
const { default: RootLayout, metadata } = await import("@/app/layout");
const { ThemeProvider } = await import("@/components/theme-provider");

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

describe("RootLayout", () => {
  afterEach(() => {
    cleanup();
  });

  test("exports correct metadata title", () => {
    expect(metadata.title).toBe("LibreDB Studio | Universal Database Editor");
  });

  test("exports correct metadata description", () => {
    expect(metadata.description).toBe("Manage PostgreSQL, MySQL, MongoDB, and Redis in one web-based interface.");
  });

  test("renders children", () => {
    const { getByText } = render(
      <RootLayout>
        <div>Test Child</div>
      </RootLayout>,
    );
    expect(getByText("Test Child")).not.toBeNull();
  });

  /**
   * The Toaster used to be handed `theme="dark"`, which overrode the `useTheme()`
   * call inside it (the spread lands after) and pinned toasts to dark even once
   * the rest of the app could switch. Passing NO theme is what makes it follow.
   */
  test("renders Toaster without a theme, so it follows next-themes", () => {
    const { getByTestId } = render(
      <RootLayout>
        <span>content</span>
      </RootLayout>,
    );
    const toaster = getByTestId("toaster");
    expect(toaster).not.toBeNull();
    expect(toaster.getAttribute("data-position")).toBe("bottom-right");
    expect(toaster.getAttribute("data-theme")).toBeNull();
  });

  test("renders html with lang=en and the font classes via SSR", () => {
    const html = ReactDOMServer.renderToString(
      <RootLayout>
        <span>content</span>
      </RootLayout>,
    );
    expect(html).toContain('lang="en"');
    expect(html).toContain("mock-geist-sans");
    expect(html).toContain("antialiased");
  });

  /**
   * `dark` was hardcoded onto <body>, which is why standalone studio had no light
   * theme at all. Ownership of that class now belongs to ThemeProvider — asserting
   * its ABSENCE here is what stops it being reintroduced.
   */
  test("body no longer pins the theme with a hardcoded dark class", () => {
    const element = RootLayout({ children: React.createElement("span") });
    const bodyClassName = element.props.children.props.className as string;
    expect(bodyClassName.split(" ")).not.toContain("dark");
  });

  test("mounts ThemeProvider — theme selection is standalone studio's own", () => {
    const element = RootLayout({ children: React.createElement("span") });
    expect(element.props.children.props.children.type).toBe(ThemeProvider);
  });

  test("renders multiple children correctly", () => {
    const { getByText } = render(
      <RootLayout>
        <div>First</div>
        <div>Second</div>
      </RootLayout>,
    );
    expect(getByText("First")).not.toBeNull();
    expect(getByText("Second")).not.toBeNull();
  });

  test("suppresses hydration warnings on html and body for extension-mutated attrs", () => {
    const element = RootLayout({ children: React.createElement("span") });
    expect(element.props.suppressHydrationWarning).toBe(true);
    expect(element.props.children.props.suppressHydrationWarning).toBe(true);
  });
});
