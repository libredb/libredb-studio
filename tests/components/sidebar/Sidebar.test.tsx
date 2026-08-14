import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";

// Mock child components to isolate Sidebar logic
mock.module("@/components/sidebar/ConnectionsList", () => ({
  ConnectionsList: (props: Record<string, unknown>) => {
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

mock.module("@/components/schema-explorer", () => ({
  SchemaExplorer: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    const schema = props.schema as Array<unknown> | undefined;
    return React.createElement(
      "div",
      {
        "data-testid": "schema-explorer",
        "data-schema-count": String(schema?.length ?? 0),
      },
      "SchemaExplorer Mock",
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
import { mockSchema } from "../../fixtures/schemas";

// ---- Load the component under test AFTER all mock.module registrations ----
// A static import would be hoisted and evaluate the real module tree
// (ConnectionsList, ConnectionItem, schema-explorer, ...) before the mocks
// apply, poisoning coverage with zero-hit phantom lines for modules that
// never execute. The dynamic import resolves against the mock registry instead.

const { Sidebar } = await import("@/components/sidebar/Sidebar");

// =============================================================================
// Sidebar Tests
// =============================================================================

function createDefaultProps(overrides: Record<string, unknown> = {}) {
  return {
    connections: [mockPostgresConnection, mockMySQLConnection],
    activeConnection: mockPostgresConnection,
    schema: mockSchema,
    isLoadingSchema: false,
    onSelectConnection: mock(() => {}),
    onDeleteConnection: mock(() => {}),
    onEditConnection: mock(() => {}),
    onAddConnection: mock(() => {}),
    onTableClick: mock(() => {}),
    onGenerateSelect: mock(() => {}),
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

  test("SchemaExplorer only renders when activeConnection exists", () => {
    // With active connection
    const propsWithConn = createDefaultProps({ activeConnection: mockPostgresConnection });
    const { unmount, queryByTestId } = render(<Sidebar {...propsWithConn} />);
    expect(queryByTestId("schema-explorer")).not.toBeNull();
    unmount();

    // Without active connection
    const propsNoConn = createDefaultProps({ activeConnection: null });
    const result2 = render(<Sidebar {...propsNoConn} />);
    expect(result2.queryByTestId("schema-explorer")).toBeNull();
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
    const props = createDefaultProps({
      connections,
      activeConnection: mockPostgresConnection,
    });
    const { getByTestId } = render(<Sidebar {...props} />);

    const connList = getByTestId("connections-list");
    expect(connList.getAttribute("data-connections-count")).toBe("2");
    expect(connList.getAttribute("data-active-connection")).toBe(mockPostgresConnection.id);
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
