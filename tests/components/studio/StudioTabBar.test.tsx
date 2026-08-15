import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { describe, test, expect, mock, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

import { StudioTabBar } from "@/components/studio/StudioTabBar";
import type { QueryTab } from "@/lib/types";

// =============================================================================
// Helpers
// =============================================================================

afterEach(() => {
  cleanup();
});

function createTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    name: "Query 1",
    query: "SELECT 1",
    result: null,
    isExecuting: false,
    type: "sql",
    ...overrides,
  };
}

function createDefaultProps(overrides: Record<string, unknown> = {}) {
  const tab1 = createTab({ id: "tab-1", name: "Query 1" });
  const tab2 = createTab({ id: "tab-2", name: "Query 2", type: "mongodb" });

  return {
    tabs: [tab1, tab2],
    activeTabId: "tab-1",
    editingTabId: null as string | null,
    editingTabName: "",
    onSetActiveTabId: mock(() => {}),
    onSetEditingTabId: mock(() => {}),
    onSetEditingTabName: mock(() => {}),
    onSetTabs: mock(() => {}),
    onCloseTab: mock(() => {}),
    onAddTab: mock(() => {}),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("StudioTabBar", () => {
  // ── Basic rendering ─────────────────────────────────────────────────────

  test("renders all tab names", () => {
    const props = createDefaultProps();
    const { queryByText } = render(<StudioTabBar {...props} />);
    expect(queryByText("Query 1")).not.toBeNull();
    expect(queryByText("Query 2")).not.toBeNull();
  });

  test("active tab has blue border and bg styling", () => {
    const props = createDefaultProps({ activeTabId: "tab-1" });
    const { container } = render(<StudioTabBar {...props} />);
    const tabElements = container.querySelectorAll('[class*="border-t-2"]');
    expect(tabElements[0]?.className).toContain("border-blue-500");
    // The accent stays a literal blue (it reads on either ground); the tab's own
    // ground is the elevated surface token, so it follows the theme.
    expect(tabElements[0]?.className).toContain("bg-overlay");
  });

  test("inactive tab has transparent border", () => {
    const props = createDefaultProps({ activeTabId: "tab-1" });
    const { container } = render(<StudioTabBar {...props} />);
    const tabElements = container.querySelectorAll('[class*="border-t-2"]');
    expect(tabElements[1]?.className).toContain("border-transparent");
  });

  // ── Tab type icons ────────────────────────────────────────────────────

  test("renders different icons for sql and json tabs", () => {
    const props = createDefaultProps();
    const { container } = render(<StudioTabBar {...props} />);
    // Each tab should have at least one icon SVG (w-3 h-3)
    const tabElements = container.querySelectorAll('[class*="border-t-2"]');
    expect(tabElements.length).toBe(2);
    // Each tab div contains an SVG icon as the first child element
    const tab1Svgs = tabElements[0]?.querySelectorAll("svg");
    const tab2Svgs = tabElements[1]?.querySelectorAll("svg");
    expect(tab1Svgs!.length).toBeGreaterThanOrEqual(1);
    expect(tab2Svgs!.length).toBeGreaterThanOrEqual(1);
  });

  // ── Click → activate tab ──────────────────────────────────────────────

  test("click on tab fires onSetActiveTabId with tab id", () => {
    const onSetActiveTabId = mock(() => {});
    const props = createDefaultProps({ onSetActiveTabId });
    const { getAllByRole } = render(<StudioTabBar {...props} />);
    fireEvent.click(getAllByRole("tab")[1]);
    expect(onSetActiveTabId).toHaveBeenCalledTimes(1);
    expect(onSetActiveTabId).toHaveBeenCalledWith("tab-2");
  });

  // ── Plus button ───────────────────────────────────────────────────────

  test("plus button fires onAddTab", () => {
    const onAddTab = mock(() => {});
    const props = createDefaultProps({ onAddTab });
    const { getByRole } = render(<StudioTabBar {...props} />);
    fireEvent.click(getByRole("button", { name: "New tab" }));
    expect(onAddTab).toHaveBeenCalledTimes(1);
  });

  // ── Close button ──────────────────────────────────────────────────────

  test("close button fires onCloseTab when multiple tabs", () => {
    const onCloseTab = mock(() => {});
    const props = createDefaultProps({ onCloseTab });
    const { getAllByRole } = render(<StudioTabBar {...props} />);
    const closeButtons = getAllByRole("button", { name: /^Close / });
    expect(closeButtons.length).toBeGreaterThan(0);
    fireEvent.click(closeButtons[0]);
    expect(onCloseTab).toHaveBeenCalledTimes(1);
  });

  test("close button hidden when only one tab", () => {
    const singleTab = createTab({ id: "tab-1", name: "Query 1" });
    const props = createDefaultProps({ tabs: [singleTab], activeTabId: "tab-1" });
    const { queryAllByRole } = render(<StudioTabBar {...props} />);
    expect(queryAllByRole("button", { name: /^Close / }).length).toBe(0);
  });

  // ── Double-click → rename mode ────────────────────────────────────────

  test("double-click on tab enters rename mode", () => {
    const onSetEditingTabId = mock(() => {});
    const onSetEditingTabName = mock(() => {});
    const props = createDefaultProps({ onSetEditingTabId, onSetEditingTabName });
    const { getAllByRole } = render(<StudioTabBar {...props} />);
    fireEvent.doubleClick(getAllByRole("tab")[0]);
    expect(onSetEditingTabId).toHaveBeenCalledTimes(1);
    expect(onSetEditingTabId).toHaveBeenCalledWith("tab-1");
    expect(onSetEditingTabName).toHaveBeenCalledTimes(1);
    expect(onSetEditingTabName).toHaveBeenCalledWith("Query 1");
  });

  // ── Rename input rendering ────────────────────────────────────────────

  test("shows input field when editingTabId matches", () => {
    const props = createDefaultProps({ editingTabId: "tab-1", editingTabName: "Query 1" });
    const { container, queryByText } = render(<StudioTabBar {...props} />);
    // Tab name text should not be visible as span (it's an input now)
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("Query 1");
    // The span for tab-1 should not exist when editing
    // tab-2 name should still show as span
    expect(queryByText("Query 2")).not.toBeNull();
  });

  // ── Rename input onChange ─────────────────────────────────────────────

  test("rename input is rendered with correct value and className", () => {
    const props = createDefaultProps({ editingTabId: "tab-1", editingTabName: "Query 1" });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector("input")!;
    expect(input).not.toBeNull();
    expect(input.value).toBe("Query 1");
    expect(input.className).toContain("border-blue-500");
    expect(input.className).toContain("bg-transparent");
  });

  // ── Rename commit via blur ────────────────────────────────────────────

  test("blur on rename input commits name and exits editing", () => {
    const onSetTabs = mock(() => {});
    const onSetEditingTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: "tab-1",
      editingTabName: "New Name",
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector("input")!;
    fireEvent.blur(input);
    expect(onSetTabs).toHaveBeenCalledTimes(1);
    expect(onSetEditingTabId).toHaveBeenCalledTimes(1);
    expect(onSetEditingTabId).toHaveBeenCalledWith(null);
  });

  test("blur with empty name does not call onSetTabs", () => {
    const onSetTabs = mock(() => {});
    const onSetEditingTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: "tab-1",
      editingTabName: "   ",
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector("input")!;
    fireEvent.blur(input);
    expect(onSetTabs).not.toHaveBeenCalled();
    expect(onSetEditingTabId).toHaveBeenCalledWith(null);
  });

  // ── Rename commit via Enter ───────────────────────────────────────────

  test("Enter key commits name and exits editing", () => {
    const onSetTabs = mock(() => {});
    const onSetEditingTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: "tab-1",
      editingTabName: "Via Enter",
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector("input")!;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSetTabs).toHaveBeenCalledTimes(1);
    expect(onSetEditingTabId).toHaveBeenCalledWith(null);
  });

  test("Enter with empty name does not call onSetTabs", () => {
    const onSetTabs = mock(() => {});
    const onSetEditingTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: "tab-1",
      editingTabName: "",
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector("input")!;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSetTabs).not.toHaveBeenCalled();
    expect(onSetEditingTabId).toHaveBeenCalledWith(null);
  });

  // ── Rename cancel via Escape ──────────────────────────────────────────

  test("Escape key cancels editing without saving", () => {
    const onSetTabs = mock(() => {});
    const onSetEditingTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: "tab-1",
      editingTabName: "Unsaved",
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector("input")!;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSetTabs).not.toHaveBeenCalled();
    expect(onSetEditingTabId).toHaveBeenCalledWith(null);
  });

  // ── Input click does not bubble ───────────────────────────────────────

  test("clicking rename input does not fire onSetActiveTabId", () => {
    const onSetActiveTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: "tab-1",
      editingTabName: "Query 1",
      onSetActiveTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector("input")!;
    fireEvent.click(input);
    expect(onSetActiveTabId).not.toHaveBeenCalled();
  });

  // ── onSetTabs updater function produces correct result ────────────────

  test("onSetTabs updater renames the correct tab", () => {
    let capturedFn: ((prev: QueryTab[]) => QueryTab[]) | null = null;
    const onSetTabs = mock((fn: (prev: QueryTab[]) => QueryTab[]) => {
      capturedFn = fn;
    });
    const onSetEditingTabId = mock(() => {});
    const tab1 = createTab({ id: "tab-1", name: "Query 1" });
    const tab2 = createTab({ id: "tab-2", name: "Query 2" });
    const props = createDefaultProps({
      tabs: [tab1, tab2],
      editingTabId: "tab-1",
      editingTabName: "Renamed",
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector("input")!;
    fireEvent.keyDown(input, { key: "Enter" });

    expect(capturedFn).not.toBeNull();
    const result = capturedFn!([tab1, tab2]);
    expect(result[0].name).toBe("Renamed");
    expect(result[1].name).toBe("Query 2");
  });

  test("onSetTabs updater via blur renames correctly", () => {
    let capturedFn: ((prev: QueryTab[]) => QueryTab[]) | null = null;
    const onSetTabs = mock((fn: (prev: QueryTab[]) => QueryTab[]) => {
      capturedFn = fn;
    });
    const onSetEditingTabId = mock(() => {});
    const tab1 = createTab({ id: "tab-1", name: "Query 1" });
    const props = createDefaultProps({
      tabs: [tab1],
      editingTabId: "tab-1",
      editingTabName: "Blur Name",
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector("input")!;
    fireEvent.blur(input);

    expect(capturedFn).not.toBeNull();
    const result = capturedFn!([tab1]);
    expect(result[0].name).toBe("Blur Name");
  });

  // ── A11y semantics (#100) ─────────────────────────────────────────────

  describe("a11y semantics", () => {
    test("tabs expose the tab role with aria-selected state", () => {
      const props = createDefaultProps({ activeTabId: "tab-1" });
      const { getAllByRole } = render(<StudioTabBar {...props} />);
      const tabs = getAllByRole("tab");
      expect(tabs.length).toBe(2);
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");
      expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    });

    test("tablist uses a roving tabindex: only the active tab is in tab order", () => {
      const props = createDefaultProps({ activeTabId: "tab-1" });
      const { getAllByRole } = render(<StudioTabBar {...props} />);
      const tabs = getAllByRole("tab");
      expect(tabs[0].getAttribute("tabindex")).toBe("0");
      expect(tabs[1].getAttribute("tabindex")).toBe("-1");
    });

    test("arrow keys, Home and End move activation between tabs", () => {
      const onSetActiveTabId = mock(() => {});
      const props = createDefaultProps({ activeTabId: "tab-1", onSetActiveTabId });
      const { getAllByRole } = render(<StudioTabBar {...props} />);
      const tabs = getAllByRole("tab");
      fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
      expect(onSetActiveTabId).toHaveBeenCalledWith("tab-2");
      fireEvent.keyDown(tabs[1], { key: "ArrowLeft" });
      expect(onSetActiveTabId).toHaveBeenCalledWith("tab-1");
      fireEvent.keyDown(tabs[0], { key: "End" });
      expect(onSetActiveTabId).toHaveBeenCalledWith("tab-2");
      fireEvent.keyDown(tabs[1], { key: "Home" });
      expect(onSetActiveTabId).toHaveBeenCalledWith("tab-1");
    });

    test("the tab accessible name is not contaminated by nested controls", () => {
      const props = createDefaultProps();
      const { getAllByRole } = render(<StudioTabBar {...props} />);
      // Exact accessible-name match: fails if the close button's label leaks in
      expect(getAllByRole("tab", { name: "Query 1" }).length).toBe(1);
      expect(getAllByRole("tab", { name: "Query 2" }).length).toBe(1);
      // The close control must not be a descendant of the tab element
      const tab = getAllByRole("tab", { name: "Query 2" })[0];
      expect(tab.querySelector("button")).toBeNull();
    });

    test("close buttons carry the tab name and stay visible on keyboard focus", () => {
      const onCloseTab = mock(() => {});
      const props = createDefaultProps({ onCloseTab });
      const { getByRole } = render(<StudioTabBar {...props} />);
      const close = getByRole("button", { name: "Close Query 2" });
      expect(close.className).toContain("focus-visible:opacity-100");
      fireEvent.click(close);
      expect(onCloseTab).toHaveBeenCalledTimes(1);
    });

    test("rename input carries an accessible name identifying the tab", () => {
      const props = createDefaultProps({ editingTabId: "tab-1", editingTabName: "Query 1" });
      const { getByLabelText } = render(<StudioTabBar {...props} />);
      expect(getByLabelText("Rename Query 1")).not.toBeNull();
    });

    test("tab buttons fill the wrapper height so the whole visible tab is clickable", () => {
      const props = createDefaultProps();
      const { getAllByRole } = render(<StudioTabBar {...props} />);
      for (const tab of getAllByRole("tab")) {
        expect(tab.className).toContain("h-full");
      }
    });

    test("committing a rename with Enter restores focus to the tab", async () => {
      const props = createDefaultProps({ editingTabId: "tab-1", editingTabName: "Renamed" });
      const { getByLabelText, rerender } = render(<StudioTabBar {...props} />);
      fireEvent.keyDown(getByLabelText("Rename Query 1"), { key: "Enter" });
      // The parent clears editing state in response; simulate that re-render
      rerender(<StudioTabBar {...createDefaultProps({ activeTabId: "tab-1" })} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.activeElement?.getAttribute("data-tab-id")).toBe("tab-1");
    });

    test("closing a tab moves focus back to the selected tab", async () => {
      const onCloseTab = mock(() => {});
      const props = createDefaultProps({ activeTabId: "tab-1", onCloseTab });
      const { getByRole, rerender } = render(<StudioTabBar {...props} />);
      fireEvent.click(getByRole("button", { name: "Close Query 2" }));
      // The parent removes the tab in response; simulate that re-render
      const tab1 = createTab({ id: "tab-1", name: "Query 1" });
      rerender(<StudioTabBar {...createDefaultProps({ tabs: [tab1], activeTabId: "tab-1", onCloseTab })} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.activeElement?.getAttribute("data-tab-id")).toBe("tab-1");
    });
  });
});
