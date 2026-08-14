import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, fireEvent } from "@testing-library/react";

mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) =>
    React.createElement(
      "div",
      { onClick: disabled ? undefined : onClick, role: "menuitem", "aria-disabled": disabled },
      children,
    ),
  DropdownMenuSeparator: ({ className }: { className?: string }) => React.createElement("hr", { className }),
}));

mock.module("@/components/ui/button", () => ({
  Button: ({ children, onClick, className, disabled, ...rest }: Record<string, unknown>) =>
    React.createElement(
      "button",
      { onClick: onClick as () => void, className, disabled, ...rest },
      children as React.ReactNode,
    ),
}));

mock.module("lucide-react", () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "__esModule") return true;
        return (props: Record<string, unknown>) =>
          React.createElement("span", { "data-icon": prop, className: props.className as string });
      },
    },
  );
});

import { StudioMobileHeader } from "@/components/studio/StudioMobileHeader";
import type { DatabaseConnection } from "@/lib/types";

const conn: DatabaseConnection = {
  id: "1",
  name: "prod-db",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "db",
  user: "u",
  password: "p",
  createdAt: new Date(),
};

describe("StudioMobileHeader", () => {
  afterEach(() => {
    cleanup();
  });

  const mockOnAskAgent = mock(() => {});
  const mockOnExplain = mock(() => {});
  const mockOnBeginTransaction = mock(() => {});
  const mockOnCommitTransaction = mock(() => {});
  const mockOnRollbackTransaction = mock(() => {});
  const mockOnTogglePlayground = mock(() => {});
  const mockOnToggleEditing = mock(() => {});
  const mockOnImport = mock(() => {});

  const defaults = {
    connections: [conn],
    activeConnection: conn,
    connectionPulse: "healthy" as const,
    user: { role: "admin" },
    isAdmin: true,
    activeMobileTab: "editor" as const,
    isExecuting: false,
    currentQuery: "SELECT 1",
    queryEditorRef: {
      current: {
        format: mock(() => {}),
        getValue: mock(() => "SELECT 1"),
        getSelectedText: mock(() => ""),
        getEffectiveQuery: mock(() => "SELECT 1"),
        setValue: mock(() => {}),
        focus: mock(() => {}),
      },
    },
    transactionActive: false,
    playgroundMode: false,
    editingEnabled: false,
    onSelectConnection: mock(() => {}),
    onAddConnection: mock(() => {}),
    onLogout: mock(() => {}),
    onSaveQuery: mock(() => {}),
    onClearQuery: mock(() => {}),
    onExecuteQuery: mock(() => {}),
    onCancelQuery: mock(() => {}),
    onBeginTransaction: mockOnBeginTransaction,
    onCommitTransaction: mockOnCommitTransaction,
    onRollbackTransaction: mockOnRollbackTransaction,
    onTogglePlayground: mockOnTogglePlayground,
    onToggleEditing: mockOnToggleEditing,
    onImport: mockOnImport,
    onAskAgent: mockOnAskAgent,
  };

  beforeEach(() => {
    mockOnAskAgent.mockClear();
    mockOnExplain.mockClear();
    mockOnBeginTransaction.mockClear();
    mockOnCommitTransaction.mockClear();
    mockOnRollbackTransaction.mockClear();
    mockOnTogglePlayground.mockClear();
    mockOnToggleEditing.mockClear();
    mockOnImport.mockClear();
  });

  test("renders DB selector and Online badge", () => {
    const { queryAllByText, container } = render(<StudioMobileHeader {...defaults} />);
    expect(queryAllByText("prod-db").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Online");
  });

  test("shows RUN button when on editor tab", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    expect(queryByText("RUN")).not.toBeNull();
  });

  test("shows CANCEL button when executing", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} isExecuting />);
    expect(queryByText("CANCEL")).not.toBeNull();
  });

  test("hides action row when not on editor tab", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} activeMobileTab="database" />);
    expect(queryByText("RUN")).toBeNull();
  });

  test("shows Select DB when no active connection", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} activeConnection={null} />);
    expect(queryByText("Select DB")).not.toBeNull();
  });

  // =========================================================================
  // Callbacks & Badges
  // =========================================================================

  /**
   * The button that opened the in-editor chat now asks the shell to ask the agent
   * about the statement (#331 T3). What it asks ABOUT is the shell's decision, not
   * this header's: the header holds no statement of its own worth asking with.
   *
   * It is named for the ask rather than for the rail because `MobileNav` already
   * renders an "Agent" control on this same tab that opens the rail and asks
   * nothing (review of #331 T3) — two identical labels, two different actions.
   */
  test("the ask-about-this-query button asks the shell to make the ask", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    const agentBtn = queryByText("Ask about this query");
    expect(agentBtn).not.toBeNull();
    fireEvent.click(agentBtn!.closest("button")!);
    expect(mockOnAskAgent).toHaveBeenCalledTimes(1);
  });

  /** Nothing on this row may read as `MobileNav`'s rail control does. */
  test("the button does not borrow the nav control's name", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    expect(queryByText("Agent")).toBeNull();
  });

  test("no agent button while the shell wires no agent", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} onAskAgent={undefined} />);
    expect(queryByText("Ask about this query")).toBeNull();
    // The row it lives in is still there.
    expect(queryByText("RUN")).not.toBeNull();
  });

  test("Explain Plan click calls onExplain when provided", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} onExplain={mockOnExplain} />);
    const explainItem = queryByText("Explain Plan");
    expect(explainItem).not.toBeNull();
    fireEvent.click(explainItem!.closest('[role="menuitem"]')!);
    expect(mockOnExplain).toHaveBeenCalledTimes(1);
  });

  test("Explain Plan not rendered when onExplain is undefined", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    expect(queryByText("Explain Plan")).toBeNull();
  });

  test("BEGIN Transaction click calls onBeginTransaction", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    const item = queryByText("BEGIN Transaction");
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnBeginTransaction).toHaveBeenCalledTimes(1);
  });

  test("transactionActive=true shows COMMIT and calls onCommitTransaction", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} transactionActive />);
    const item = queryByText("COMMIT");
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnCommitTransaction).toHaveBeenCalledTimes(1);
  });

  test("transactionActive=true shows ROLLBACK and calls onRollbackTransaction", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} transactionActive />);
    const item = queryByText("ROLLBACK");
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnRollbackTransaction).toHaveBeenCalledTimes(1);
  });

  test("Enable Sandbox click calls onTogglePlayground", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    const item = queryByText("Enable Sandbox");
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnTogglePlayground).toHaveBeenCalledTimes(1);
  });

  test("Enable Editing click calls onToggleEditing", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    const item = queryByText("Enable Editing");
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnToggleEditing).toHaveBeenCalledTimes(1);
  });

  test("Enable Editing not rendered when onToggleEditing is undefined (#269)", () => {
    // Same shape as Explain Plan above: Studio withholds the callback where the
    // provider declares no single-table row-update statement.
    const { queryByText } = render(<StudioMobileHeader {...defaults} onToggleEditing={undefined} />);
    expect(queryByText("Enable Editing")).toBeNull();
    expect(queryByText("Enable Sandbox")).not.toBeNull();
    expect(queryByText("Import Data")).not.toBeNull();
  });

  test("Import Data click calls onImport", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    const item = queryByText("Import Data");
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnImport).toHaveBeenCalledTimes(1);
  });

  test("shows Add Connection item when connections list is empty and click calls onAddConnection", () => {
    const onAddConnection = mock(() => {});
    const { queryByText } = render(
      <StudioMobileHeader {...defaults} connections={[]} activeConnection={null} onAddConnection={onAddConnection} />,
    );
    const item = queryByText("Add Connection");
    expect(item).not.toBeNull();
    // The "Add New" variant only renders when connections exist
    expect(queryByText("Add New")).toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(onAddConnection).toHaveBeenCalledTimes(1);
  });

  test("Copy Query click writes the editor query to the clipboard", () => {
    const writeText = mock(async () => {});
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    const item = queryByText("Copy Query");
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect((writeText.mock.calls as unknown[][])[0][0]).toBe("SELECT 1");
  });

  test("Copy Query falls back to currentQuery when the editor has no value", () => {
    const writeText = mock(async () => {});
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const emptyEditorRef = {
      current: {
        ...defaults.queryEditorRef.current,
        getValue: mock(() => ""),
      },
    };
    const { queryByText } = render(
      <StudioMobileHeader {...defaults} queryEditorRef={emptyEditorRef} currentQuery="SELECT 2" />,
    );
    fireEvent.click(queryByText("Copy Query")!.closest('[role="menuitem"]')!);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect((writeText.mock.calls as unknown[][])[0][0]).toBe("SELECT 2");
  });

  test("renders a repository link in the header actions", () => {
    const { container } = render(<StudioMobileHeader {...defaults} />);
    const link = container.querySelector('a[aria-label="LibreDB Studio on GitHub"]');

    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://github.com/libredb/libredb-studio");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  // Asserted through the observable effect rather than `not.toThrow()`: the
  // handler swallows every storage error, so a throw assertion could not fail.
  test("following the repository link marks the star prompt handled", () => {
    localStorage.removeItem("libredb_star_prompt_handled");
    const { container } = render(<StudioMobileHeader {...defaults} />);
    const link = container.querySelector('a[aria-label="LibreDB Studio on GitHub"]')!;

    fireEvent.click(link);

    expect(localStorage.getItem("libredb_star_prompt_handled")).not.toBeNull();
    localStorage.removeItem("libredb_star_prompt_handled");
  });

  test("transactionActive=true shows TXN badge", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} transactionActive />);
    expect(queryByText("TXN")).not.toBeNull();
  });

  test("playgroundMode=true shows SANDBOX badge", () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} playgroundMode />);
    expect(queryByText("SANDBOX")).not.toBeNull();
  });
});
