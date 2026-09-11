import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
let capturedDuplicateHandler: unknown;

// Mock child components to isolate Sidebar logic
mock.module("@/components/sidebar/ConnectionsList", () => ({
  ConnectionsList: (props: Record<string, unknown>) => {
    capturedDuplicateHandler = props.onDuplicateConnection;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    const connections = props.connections as Array<Record<string, unknown>> | undefined;
    const activeConnection = props.activeConnection as Record<string, unknown> | null | undefined;
    return React.createElement(
      "div",
      {
        "data-testid": "connections-list",
        "data-connections-count": String(connections?.length ?? 0),
        "data-active-connection": (activeConnection as Record<string, string>)?.id ?? "none",
      },
      "ConnectionsList Mock",
    );
  },
}));

// The tree is driven by its own fetch double in
// `tests/components/object-tree/first-paint.test.tsx`; here it is a stand-in that
// reports what the sidebar handed it, which is the sidebar's whole job.
mock.module("@/components/object-tree", () => ({
  ObjectTree: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    const connection = props.connection as Record<string, unknown> | undefined;
    const capabilities = props.capabilities as { containerLevels?: unknown[] } | undefined;
    return React.createElement(
      "div",
      {
        "data-testid": "object-tree",
        "data-connection": String(connection?.id ?? "none"),
        "data-levels": String(capabilities?.containerLevels?.length ?? "none"),
        "data-deferred": String(props.deferred ?? false),
        "data-has-load": String(props.onLoad !== undefined),
        "data-actions": Object.keys((props.actions as Record<string, unknown>) ?? {})
          .sort()
          .join(","),
        "data-has-labels": String(props.labels !== undefined),
      },
      "ObjectTree Mock",
    );
  },
}));

// Mock radix scroll area to pass through children
mock.module("@radix-ui/react-scroll-area", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");

  const Root = React.forwardRef(({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement("div", { ...props, ref, "data-slot": "scroll-area" }, children),
  );
  Root.displayName = "ScrollAreaRoot";

  const Viewport = React.forwardRef(({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement("div", { ...props, ref, "data-slot": "scroll-area-viewport" }, children),
  );
  Viewport.displayName = "ScrollAreaViewport";

  const ScrollAreaScrollbar = React.forwardRef(
    ({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
      React.createElement("div", { ...props, ref }, children),
  );
  ScrollAreaScrollbar.displayName = "ScrollAreaScrollbar";

  const ScrollAreaThumb = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement("div", { ...props, ref }),
  );
  ScrollAreaThumb.displayName = "ScrollAreaThumb";

  const Corner = () => null;
  Corner.displayName = "Corner";

  return {
    Root,
    Viewport,
    ScrollAreaScrollbar,
    ScrollAreaThumb,
    Corner,
  };
});

import { describe, test, expect, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

import { mockPostgresConnection, mockMySQLConnection } from "../../fixtures/connections";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";

// ---- Load the component under test AFTER all mock.module registrations ----
// A static import would be hoisted and evaluate the real module tree
// (ConnectionsList, ConnectionItem, object-tree, ...) before the mocks
// apply, poisoning coverage with zero-hit phantom lines for modules that
// never execute. The dynamic import resolves against the mock registry instead.

const { Sidebar } = await import("@/components/sidebar/Sidebar");

// =============================================================================
// Sidebar Tests
// =============================================================================

const oneLevel = {
  queryLanguage: "sql",
  containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
  objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
} as unknown as ProviderMetadata["capabilities"];

function createDefaultProps(overrides: Record<string, unknown> = {}) {
  return {
    connections: [mockPostgresConnection, mockMySQLConnection],
    activeConnection: mockPostgresConnection,
    metadata: { capabilities: oneLevel } as ProviderMetadata,
    onSelectConnection: mock(() => {}),
    onDeleteConnection: mock(() => {}),
    onEditConnection: mock(() => {}),
    onAddConnection: mock(() => {}),
    onObjectClick: mock(() => {}),
    onShowDiagram: mock(() => {}),
    ...overrides,
  };
}

describe("Sidebar", () => {
  // The version tests mutate a process-wide value. The file happens to run alone
  // in its group today, but that isolation is incidental - restore it explicitly
  // so a later regrouping cannot turn this into an order-dependent flake.
  const originalAppVersion = process.env.NEXT_PUBLIC_APP_VERSION;

  afterEach(() => {
    cleanup();
    if (originalAppVersion === undefined) {
      delete process.env.NEXT_PUBLIC_APP_VERSION;
    } else {
      process.env.NEXT_PUBLIC_APP_VERSION = originalAppVersion;
    }
  });

  test("renders LibreDB Studio header", () => {
    const props = createDefaultProps();
    const { queryByText } = render(<Sidebar {...props} />);

    expect(queryByText("LibreDB Studio")).not.toBeNull();
  });

  test('shows "Add Connection" button (Plus icon)', () => {
    const onAddConnection = mock(() => {});
    const props = createDefaultProps({ onAddConnection });
    const { getAllByRole } = render(<Sidebar {...props} />);

    // The Plus button is in the header
    const buttons = getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
  });

  test("the object tree only renders when activeConnection exists", () => {
    // With active connection
    const propsWithConn = createDefaultProps({ activeConnection: mockPostgresConnection });
    const { unmount, queryByTestId } = render(<Sidebar {...propsWithConn} />);
    expect(queryByTestId("object-tree")).not.toBeNull();
    unmount();

    // Without active connection
    const propsNoConn = createDefaultProps({ activeConnection: null });
    const result2 = render(<Sidebar {...propsNoConn} />);
    expect(result2.queryByTestId("object-tree")).toBeNull();
  });

  /**
   * The tree windows its own rows against the height of its scroll box and scrolls itself.
   * Inside the sidebar's `ScrollArea` it would be a scroller inside a scroller, measuring a
   * box the reader cannot see the bottom of, and Task 6's windowing would read the wrong
   * height - which is what a fixed `h-[60vh]` was papering over. So the connections list
   * keeps the ScrollArea and the tree gets the panel's remaining height.
   */
  test("the tree is not nested inside the sidebar's own scroll area", () => {
    const props = createDefaultProps();
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").closest('[data-slot="scroll-area"]')).toBeNull();
    // The control: the element that IS meant to scroll with the sidebar still does, so
    // this is not passing because the ScrollArea disappeared.
    expect(getByTestId("connections-list").closest('[data-slot="scroll-area"]')).not.toBeNull();
  });

  // The tree reads the catalog itself, so what it needs from the sidebar is the
  // connection to read and the declaration that says what to read for it.
  test("the active connection and its capabilities reach the tree", () => {
    const props = createDefaultProps();
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-connection")).toBe(mockPostgresConnection.id);
    expect(getByTestId("object-tree").getAttribute("data-levels")).toBe("1");
  });

  /**
   * The tree cannot be rendered without the declaration: `containerDepth` of an absent
   * one is 0, which is a real answer for five engines, so handing the tree an empty
   * capability object would make a one-level engine read the counts of a container that
   * does not exist rather than list its schemas.
   */
  test("no tree is drawn until the provider has described the connection", () => {
    const props = createDefaultProps({ metadata: null });
    const { queryByTestId, getByTestId } = render(<Sidebar {...props} />);

    expect(queryByTestId("object-tree")).toBeNull();
    expect(getByTestId("sidebar-provider-pending")).not.toBeNull();
  });

  // #765: the connection's own answer decides, and the press is handed to the owner of
  // that answer rather than performed here.
  test("a deferred connection hands the tree the deferral and the load action", () => {
    const onLoadObjects = mock(() => {});
    const props = createDefaultProps({ objectScanDeferred: true, onLoadObjects });
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-deferred")).toBe("true");
    expect(getByTestId("object-tree").getAttribute("data-has-load")).toBe("true");
  });

  /**
   * U22. The shell decides what it CAN do and the tree decides what the declaration
   * ALLOWS; the sidebar joins neither question and hands both straight through. The
   * engine's own wording goes with them, because the menu's maintenance items read it.
   */
  test("the shell's row actions and the engine's wording reach the tree unchanged", () => {
    const props = createDefaultProps({
      objectActions: { onProfileObject: mock(() => {}), onCreateObject: mock(() => {}) },
      // The wording travels with the declaration rather than beside it: both halves of
      // `metadata` reach the tree, since the menu's maintenance items need the second.
      metadata: { capabilities: oneLevel, labels: { vacuumActionOperation: "optimize" } } as ProviderMetadata,
    });
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-actions")).toBe("onCreateObject,onProfileObject");
    expect(getByTestId("object-tree").getAttribute("data-has-labels")).toBe("true");
  });

  test("control: a shell that offers no row actions hands the tree none", () => {
    const props = createDefaultProps();
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-actions")).toBe("");
  });

  test("control: a connection that is not deferred hands the tree no deferral", () => {
    const props = createDefaultProps({ onLoadObjects: mock(() => {}) });
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-deferred")).toBe("false");
  });

  test("ERD button only appears when activeConnection exists", () => {
    // With active connection — should have ERD button (title="Show ERD Diagram")
    const propsWithConn = createDefaultProps({ activeConnection: mockPostgresConnection });
    const { unmount, container: c1 } = render(<Sidebar {...propsWithConn} />);
    const erdButton = c1.querySelector('[title="Show ERD Diagram"]');
    expect(erdButton).not.toBeNull();
    unmount();

    // Without active connection — no ERD button
    const propsNoConn = createDefaultProps({ activeConnection: null });
    const { container: c2 } = render(<Sidebar {...propsNoConn} />);
    const noErdButton = c2.querySelector('[title="Show ERD Diagram"]');
    expect(noErdButton).toBeNull();
  });

  test("passes correct props to ConnectionsList", () => {
    const connections = [mockPostgresConnection, mockMySQLConnection];
    const onDuplicateConnection = mock(() => {});
    const props = createDefaultProps({
      connections,
      activeConnection: mockPostgresConnection,
      onDuplicateConnection,
    });
    const { getByTestId } = render(<Sidebar {...props} />);

    const connList = getByTestId("connections-list");
    expect(connList.getAttribute("data-connections-count")).toBe("2");
    expect(connList.getAttribute("data-active-connection")).toBe(mockPostgresConnection.id);
    expect(capturedDuplicateHandler).toBe(onDuplicateConnection);
  });

  /**
   * The footer used to print a hardcoded "v1.2.5" while the package had long
   * moved on, so the sidebar told users a version the build never was. It now
   * reads the same injected value as the two studio headers and the login form.
   */
  test("footer shows the build's version, not a hardcoded one", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "9.8.7";
    const props = createDefaultProps();
    const { queryByText } = render(<Sidebar {...props} />);

    expect(queryByText("v9.8.7")).not.toBeNull();
    expect(queryByText("v1.2.5")).toBeNull();
  });

  /**
   * The embedded case, and the reason this footer cannot simply interpolate the
   * env var: the tsup library build declares no `define`, so inside the npm
   * package the lookup resolves against the HOST's environment, where the
   * variable is absent. Rendering "vundefined" in a paid product is worse than
   * rendering nothing at all.
   */
  test("footer renders no version token when nothing injected one", () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    const props = createDefaultProps();
    const { container, queryByText } = render(<Sidebar {...props} />);

    expect(queryByText("vundefined")).toBeNull();
    expect(container.textContent).not.toContain("undefined");
    // The footer itself is still there - only the token is dropped.
    expect(queryByText("Connected")).not.toBeNull();
  });

  /**
   * The sidebar is the only chrome BOTH modes render: the embedded workspace
   * supplies its own header, so a link mounted only in the studio headers would
   * never reach a platform tenant.
   */
  test("footer links to the repository, in both standalone and embedded chrome", () => {
    const props = createDefaultProps();
    const { container } = render(<Sidebar {...props} />);
    const link = container.querySelector('a[aria-label="LibreDB Studio on GitHub"]');

    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://github.com/libredb/libredb-studio");
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("footer shows connected status", () => {
    const props = createDefaultProps();
    const { queryByText } = render(<Sidebar {...props} />);

    expect(queryByText("Connected")).not.toBeNull();
  });

  test("clicking ERD button calls onShowDiagram", () => {
    const onShowDiagram = mock(() => {});
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      onShowDiagram,
    });
    const { container } = render(<Sidebar {...props} />);

    const erdButton = container.querySelector('[title="Show ERD Diagram"]');
    expect(erdButton).not.toBeNull();
    fireEvent.click(erdButton!);

    expect(onShowDiagram).toHaveBeenCalledTimes(1);
  });
});
