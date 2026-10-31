import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
let capturedDuplicateHandler: unknown;
let capturedFavoriteIds: unknown;
let capturedToggleFavoriteHandler: unknown;
let capturedConnectionOrder: unknown;
let capturedReorderHandler: unknown;
let capturedGroupProps: Record<string, unknown> = {};
/** The row menu's Browse Keys item, as the tree received it from the sidebar. */
let capturedBrowseKeys: ((object: { name: string; path: readonly string[] }) => void) | undefined;
/** The tree's `refresh`, as the sidebar reaches it through the tree's ref (#1986). */
const treeRefresh = mock(() => {});

// Mock child components to isolate Sidebar logic
mock.module("@/components/sidebar/ConnectionsList", () => ({
  ConnectionsList: (props: Record<string, unknown>) => {
    capturedDuplicateHandler = props.onDuplicateConnection;
    capturedFavoriteIds = props.favoriteConnectionIds;
    capturedToggleFavoriteHandler = props.onToggleFavoriteConnection;
    capturedConnectionOrder = props.connectionOrder;
    capturedReorderHandler = props.onReorderConnections;
    capturedGroupProps = props;
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
    // The row menu's entry point into the keys panel, captured so a test can press it: the sidebar
    // hands the tree this handler and nothing else about the panel.
    capturedBrowseKeys = (
      props.actions as
        | {
            onBrowseKeys?: (object: { name: string; path: readonly string[] }) => void;
          }
        | undefined
    )?.onBrowseKeys;
    React.useImperativeHandle(props.ref, () => ({ refresh: treeRefresh }));
    return React.createElement(
      "div",
      {
        "data-testid": "object-tree",
        "data-connection": String(connection?.id ?? "none"),
        "data-levels": String(capabilities?.containerLevels?.length ?? "none"),
        "data-deferred": String(props.deferred ?? false),
        "data-deferred-billed": String(props.deferredForBilledCompute ?? false),
        "data-has-load": String(props.onLoad !== undefined),
        "data-actions": Object.keys((props.actions as Record<string, unknown>) ?? {})
          .sort()
          .join(","),
        "data-has-labels": String(props.labels !== undefined),
        "data-current": JSON.stringify(props.currentContainer ?? null),
        "data-has-container-activate": String(props.onContainerActivate !== undefined),
      },
      "ObjectTree Mock",
    );
  },
}));

// Mock radix scroll area to pass through children
// The keys panel has its own suite and its own fetch double; here it is a stand-in that reports what
// the sidebar handed it, because what the sidebar decides is the HANDOVER.
mock.module("@/components/key-browser", () => ({
  KeyBrowser: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    const connection = props.connection as Record<string, unknown> | undefined;
    const capability = props.capability as Record<string, unknown> | undefined;
    const request = props.request as { pattern?: string; database?: string } | undefined;
    const level = props.databaseLevel as { label?: string } | undefined;
    return React.createElement(
      "div",
      {
        "data-testid": "key-browser",
        "data-connection": String(connection?.id ?? "none"),
        "data-default-count": String(capability?.defaultCount ?? "none"),
        "data-has-open-key": String(props.onOpenKey !== undefined),
        "data-request": String(request?.pattern ?? "none"),
        "data-request-database": String(request?.database ?? "none"),
        "data-level": String(level?.label ?? "none"),
      },
      "KeyBrowser Mock",
    );
  },
}));

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
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

import { mockPostgresConnection, mockMySQLConnection } from "../../fixtures/connections";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import { connectionPulseTitle } from "@/hooks/use-connection-pulse";

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

/**
 * A declaration that includes the key-space walk — what a provider with no catalog answers.
 *
 * Declared here rather than reused from a connection fixture, because the sidebar reads the
 * DECLARATION and never the connection's type: a fixture named after an engine would suggest the
 * panel keys off that name, which is the one thing it must not do.
 */
function walkMetadata(): ProviderMetadata {
  return {
    capabilities: {
      ...oneLevel,
      keyScan: { defaultCount: 500, maxCount: 1000 },
    },
  } as unknown as ProviderMetadata;
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
    const propsWithConn = createDefaultProps({
      activeConnection: mockPostgresConnection,
    });
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

  // #1530: the tree is the one place a server-level connection's database is chosen and shown.
  test("the current container and the container activation reach the tree, and no database select is drawn", () => {
    const onContainerActivate = mock((_path: readonly string[]) => {});
    const props = createDefaultProps({ currentContainer: ["sales"], onContainerActivate });
    const { getByTestId, queryByRole } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-current")).toBe('["sales"]');
    expect(getByTestId("object-tree").getAttribute("data-has-container-activate")).toBe("true");
    expect(queryByRole("combobox", { name: "Database" })).toBeNull();
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

  /**
   * MAJOR 3, #789. Absence and failure are two different facts, and the pending spinner
   * above is the answer to only one of them. A refused `provider-meta` read left the reader
   * watching "Reading the connection..." for ever with no message and nothing to press.
   */
  test("a refused declaration read is shown in the route's own words, not as a spinner", () => {
    const props = createDefaultProps({
      metadata: null,
      metadataError: "authentication failed for user postgres",
    });
    const { queryByTestId, getByTestId } = render(<Sidebar {...props} />);

    expect(queryByTestId("sidebar-provider-pending")).toBeNull();
    expect(queryByTestId("object-tree")).toBeNull();
    expect(getByTestId("sidebar-provider-failure").textContent).toContain("authentication failed for user postgres");
  });

  test("the failure offers a retry, and the press reaches the owner of the read", () => {
    const onRetryMetadata = mock(() => {});
    const props = createDefaultProps({
      metadata: null,
      metadataError: "Connection refused",
      onRetryMetadata,
    });
    const { getByTestId } = render(<Sidebar {...props} />);

    fireEvent.click(getByTestId("sidebar-provider-retry"));

    expect(onRetryMetadata).toHaveBeenCalledTimes(1);
  });

  // The shell that cannot retry does not draw a button that does nothing. The embedded
  // workspace is that shell: its host DECLARES the capabilities, so there is no read to
  // re-issue and it passes neither prop.
  test("no retry is offered when the shell supplied no way to re-read", () => {
    const props = createDefaultProps({
      metadata: null,
      metadataError: "Connection refused",
    });
    const { queryByTestId } = render(<Sidebar {...props} />);

    expect(queryByTestId("sidebar-provider-retry")).toBeNull();
  });

  // The control: a failure that has been cleared gives the tree back rather than leaving
  // the panel up, so the retry's success is visible.
  test("a declaration that arrives after a failure draws the tree", () => {
    const props = createDefaultProps({ metadataError: null });
    const { queryByTestId, getByTestId } = render(<Sidebar {...props} />);

    expect(queryByTestId("sidebar-provider-failure")).toBeNull();
    expect(getByTestId("object-tree")).not.toBeNull();
  });

  // #765: the connection's own answer decides, and the press is handed to the owner of
  // that answer rather than performed here.
  test("a deferred connection hands the tree the deferral and the load action", () => {
    const onLoadObjects = mock(() => {});
    const props = createDefaultProps({
      objectScanDeferred: true,
      onLoadObjects,
    });
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-deferred")).toBe("true");
    expect(getByTestId("object-tree").getAttribute("data-has-load")).toBe("true");
    expect(getByTestId("object-tree").getAttribute("data-deferred-billed")).toBe("false");
  });

  // CL-CORE-2: the shell holds a restored connection whose requests resume billed compute, and says why.
  test("a connection held for billed compute hands the tree the deferral, its reason and the load action", () => {
    const onLoadObjects = mock(() => {});
    const props = createDefaultProps({
      objectScanDeferred: true,
      deferredForBilledCompute: true,
      onLoadObjects,
    });
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-deferred")).toBe("true");
    expect(getByTestId("object-tree").getAttribute("data-deferred-billed")).toBe("true");
    expect(getByTestId("object-tree").getAttribute("data-has-load")).toBe("true");
  });

  /**
   * U22. The shell decides what it CAN do and the tree decides what the declaration
   * ALLOWS; the sidebar joins neither question and hands both straight through. The
   * engine's own wording goes with them, because the menu's maintenance items read it.
   *
   * The ONE item the sidebar adds is the one whose destination it owns — the keys panel — and
   * `rowActions` is what decides whether any row may offer it, so this addition cannot put a
   * destination the engine has no surface for into a menu.
   */
  test("the shell's row actions and the engine's wording reach the tree, plus the panel's own", () => {
    const props = createDefaultProps({
      objectActions: {
        onProfileObject: mock(() => {}),
        onCreateObject: mock(() => {}),
      },
      // The wording travels with the declaration rather than beside it: both halves of
      // `metadata` reach the tree, since the menu's maintenance items need the second.
      metadata: {
        capabilities: {
          ...oneLevel,
          keyScan: { defaultCount: 500, maxCount: 1000 },
        },
        labels: { vacuumActionOperation: "optimize" },
      } as unknown as ProviderMetadata,
    });
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-actions")).toBe("onBrowseKeys,onCreateObject,onProfileObject");
    expect(getByTestId("object-tree").getAttribute("data-has-labels")).toBe("true");
  });

  test("control: a shell that offers no row actions hands the tree only the sidebar's own", () => {
    const props = createDefaultProps({ metadata: walkMetadata() });
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-actions")).toBe("onBrowseKeys");
  });

  test("control: an engine that declares no walk is handed none of them", () => {
    const props = createDefaultProps();
    const { getByTestId } = render(<Sidebar {...props} />);

    // The panel's item is offered where the panel is, and nowhere else: this engine has no key-space
    // walk, so `rowActions` would refuse the item on every row and the handler would be dead weight.
    expect(getByTestId("object-tree").getAttribute("data-actions")).toBe("");
  });

  test("control: a connection that is not deferred hands the tree no deferral", () => {
    const props = createDefaultProps({ onLoadObjects: mock(() => {}) });
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-deferred")).toBe("false");
  });

  test("ERD button only appears when activeConnection exists", () => {
    // With active connection — should have ERD button (title="Show ERD Diagram")
    const propsWithConn = createDefaultProps({
      activeConnection: mockPostgresConnection,
    });
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

  test("passes favoriteConnectionIds and onToggleFavoriteConnection through to ConnectionsList", () => {
    const favoriteConnectionIds = new Set([mockPostgresConnection.id]);
    const onToggleFavoriteConnection = mock(() => {});
    const props = createDefaultProps({
      favoriteConnectionIds,
      onToggleFavoriteConnection,
    });

    render(<Sidebar {...props} />);

    expect(capturedFavoriteIds).toBe(favoriteConnectionIds);
    expect(capturedToggleFavoriteHandler).toBe(onToggleFavoriteConnection);
  });

  test("passes connectionOrder and onReorderConnections through to ConnectionsList", () => {
    const connectionOrder = [mockMySQLConnection.id, mockPostgresConnection.id];
    const onReorderConnections = mock(() => {});
    const props = createDefaultProps({ connectionOrder, onReorderConnections });

    render(<Sidebar {...props} />);

    expect(capturedConnectionOrder).toBe(connectionOrder);
    expect(capturedReorderHandler).toBe(onReorderConnections);
  });

  test("passes the governance state through to ConnectionsList", () => {
    render(<Sidebar {...createDefaultProps({ governed: true, connectionAccessUnavailable: true })} />);
    expect(capturedGroupProps.governed).toBe(true);
    expect(capturedGroupProps.accessUnavailable).toBe(true);

    cleanup();
    render(<Sidebar {...createDefaultProps()} />);
    expect(capturedGroupProps.governed).toBeUndefined();
    expect(capturedGroupProps.accessUnavailable).toBeUndefined();
  });

  test("passes the connection groups and every group callback through to ConnectionsList (#1170)", () => {
    const groupProps = {
      connectionGroups: [{ id: "g1", name: "Prod", collapsed: false, connectionIds: [] }],
      onCreateGroup: mock(() => "g1" as string | null),
      onRenameGroup: mock(() => {}),
      onDeleteGroup: mock(() => {}),
      onToggleGroupCollapsed: mock(() => {}),
      onMoveConnectionToGroup: mock(() => {}),
    };
    const props = createDefaultProps(groupProps);

    render(<Sidebar {...props} />);

    for (const [name, value] of Object.entries(groupProps)) {
      expect(capturedGroupProps[name]).toBe(value);
    }
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

  /**
   * CL-CORE-4: the header said "Not checked" over a connection Studio sends no health check, while this footer drew a
   * pulsing green "Connected" under it. The footer reads the same pulse state as the header.
   */
  test("under a connection Studio does not check, the footer says Not checked, with a still neutral dot", () => {
    const { container, queryByText, getByText } = render(
      <Sidebar {...createDefaultProps({ connectionPulse: "not-checked" })} />,
    );

    expect(queryByText("Connected")).toBeNull();
    const status = container.querySelector('[data-testid="sidebar-connection-status"]');
    expect(status?.getAttribute("title")).toBe(connectionPulseTitle("not-checked"));
    expect(status?.textContent).toBe("Not checked");
    expect(getByText("Not checked")).not.toBeNull();
    const dot = status?.querySelector("div");
    expect(dot?.className).not.toContain("animate-pulse");
    expect(dot?.className).not.toContain("green");
  });

  test("control: a checked connection, or a shell with no pulse, keeps the pulsing Connected", () => {
    for (const connectionPulse of ["healthy", null, undefined]) {
      const { container, queryByText, unmount } = render(<Sidebar {...createDefaultProps({ connectionPulse })} />);
      expect(queryByText("Connected"), String(connectionPulse)).not.toBeNull();
      expect(queryByText("Not checked")).toBeNull();
      const dot = container.querySelector('[data-testid="sidebar-connection-status"] div');
      expect(dot?.className).toContain("animate-pulse");
      unmount();
    }
  });

  test("no ERD button on a connection declaring Cypher, whose relationship types are no tables (SR20)", () => {
    const cypher = {
      capabilities: { ...oneLevel, queryLanguage: "cypher" },
    } as unknown as ProviderMetadata;
    const { container, unmount } = render(<Sidebar {...createDefaultProps({ metadata: cypher })} />);
    expect(container.querySelector('[title="Show ERD Diagram"]')).toBeNull();
    unmount();

    // The control: the same connection while its capabilities have not answered keeps the button.
    const pending = render(<Sidebar {...createDefaultProps({ metadata: null })} />);
    expect(pending.container.querySelector('[title="Show ERD Diagram"]')).not.toBeNull();
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

  // ── Icon-only controls announce their name (#919) ──────────────────────────
  //
  // Measured on a running 0.15.0: 17 of the 71 buttons on the default view had no text,
  // no `aria-label`, no `aria-labelledby` and no `title`, so a screen reader announced
  // "button" and nothing else. Each already had an obvious name.

  test("the new-connection control has a name, not just a plus sign", () => {
    const props = createDefaultProps();
    const { getByRole } = render(<Sidebar {...props} />);

    const button = getByRole("button", { name: "New connection" });
    fireEvent.click(button);

    expect(props.onAddConnection).toHaveBeenCalledTimes(1);
  });

  // ALLOW_CUSTOM_CONNECTIONS off: the standalone shell hands no add handler, and the header then
  // draws no control at all rather than one that does nothing.
  test("draws no new-connection control when the shell offers none", () => {
    const { queryByRole } = render(<Sidebar {...createDefaultProps({ onAddConnection: undefined })} />);

    expect(queryByRole("button", { name: "New connection" })).toBeNull();
    expect(capturedGroupProps.onAddConnection).toBeUndefined();
  });

  /**
   * #1986: the reader's way to see a table another client made. The tree's own `refresh` is what
   * the press reaches, not the shell's counter, which would also mark every Source tab stale.
   *
   * IT LIVES IN THE HEADER, beside the other active-connection action, because a control pressed
   * this rarely must not cost the panel a row: on an engine with no Objects / Keys switch the
   * panel below the header is the tree and nothing else, as it was before the control existed.
   */
  test("the refresh control sits in the header, just before the diagram control", () => {
    const { getByRole, getByTitle } = render(<Sidebar {...createDefaultProps()} />);
    const control = getByRole("button", { name: "Read the objects again" });

    expect(control.parentElement).toBe(getByRole("button", { name: "New connection" }).parentElement);
    expect(control.nextElementSibling).toBe(getByTitle("Show ERD Diagram"));
  });

  test("the refresh control is drawn only while a tree is", () => {
    const noConnection = render(<Sidebar {...createDefaultProps({ activeConnection: null })} />);
    expect(noConnection.queryByRole("button", { name: "Read the objects again" })).toBeNull();
    noConnection.unmount();

    // A declaration still being read mounts no tree, so there is nothing to ask.
    const pending = render(<Sidebar {...createDefaultProps({ metadata: null })} />);
    expect(pending.queryByTestId("object-tree")).toBeNull();
    expect(pending.queryByRole("button", { name: "Read the objects again" })).toBeNull();
  });

  test("the refresh control asks the tree to read again", () => {
    treeRefresh.mockClear();
    const { getByRole } = render(<Sidebar {...createDefaultProps()} />);
    fireEvent.click(getByRole("button", { name: "Read the objects again" }));
    expect(treeRefresh).toHaveBeenCalledTimes(1);
  });

  test("the refresh control works from the keyboard", async () => {
    treeRefresh.mockClear();
    const { getByRole } = render(<Sidebar {...createDefaultProps()} />);
    getByRole("button", { name: "Read the objects again" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(treeRefresh).toHaveBeenCalledTimes(1);
  });

  test("the refresh control is not drawn while Keys is shown, and returns with the tree", () => {
    const { getByRole, queryByRole } = render(<Sidebar {...createDefaultProps({ metadata: walkMetadata() })} />);
    expect(getByRole("button", { name: "Read the objects again" })).toBeDefined();

    fireEvent.click(getByRole("tab", { name: "Keys" }));
    expect(queryByRole("button", { name: "Read the objects again" })).toBeNull();

    fireEvent.click(getByRole("tab", { name: "Objects" }));
    expect(getByRole("button", { name: "Read the objects again" })).toBeDefined();
  });

  test("a deferred tree's refresh control is disabled and reads nothing", () => {
    treeRefresh.mockClear();
    const { getByRole, getByTestId } = render(<Sidebar {...createDefaultProps({ objectScanDeferred: true })} />);
    const control = getByRole("button", { name: "Read the objects again" }) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    fireEvent.click(control);
    expect(treeRefresh).not.toHaveBeenCalled();
    // Deferred or not, the panel below the header is the tree alone.
    const treeWrapper = getByTestId("object-tree").parentElement!;
    expect(Array.from(treeWrapper.parentElement!.children)).toEqual([treeWrapper]);
  });

  /**
   * The key browser is a SECOND READING of the same connection, offered where the engine declares
   * one and absent everywhere else.
   *
   * The tab pair is driven by `capabilities.keyScan` and never by the connection's type, which is
   * the rule the whole db layer runs on: a provider that gained the walk without being one of the
   * engines this was written for gets the panel, and one that merely LOOKS like such an engine does
   * not.
   */
  test("offers the key browser only where the engine declares a key-space walk", () => {
    const withoutWalk = render(<Sidebar {...createDefaultProps()} />);
    // A tree engine keeps the sidebar it had: no tab strip at all, rather than a disabled one, and
    // no row of any other kind either. The panel holds the tree's wrapper and nothing else.
    expect(withoutWalk.queryByRole("tab", { name: "Keys" })).toBeNull();
    expect(withoutWalk.queryByTestId("key-browser")).toBeNull();
    const treeWrapper = withoutWalk.getByTestId("object-tree").parentElement!;
    expect(Array.from(treeWrapper.parentElement!.children)).toEqual([treeWrapper]);
    withoutWalk.unmount();

    const withWalk = render(<Sidebar {...createDefaultProps({ metadata: walkMetadata() })} />);
    expect(withWalk.getByRole("tab", { name: "Objects" })).toBeDefined();
    expect(withWalk.getByRole("tab", { name: "Keys" })).toBeDefined();
    // The switch is a row of the panel itself, and holds the two tabs and nothing else.
    const tablist = withWalk.getByRole("tablist", { name: "Sidebar view" });
    expect(tablist.parentElement).toBe(withWalk.getByTestId("object-tree").parentElement!.parentElement);
    expect(Array.from(tablist.children).map((child) => child.getAttribute("role"))).toEqual(["tab", "tab"]);
    // The tree is what opens, because the panel is an addition rather than a replacement.
    expect(withWalk.queryByTestId("object-tree")).not.toBeNull();
    expect(withWalk.queryByTestId("key-browser")).toBeNull();
  });

  /**
   * #1169: DEFERRING THE CATALOG DOES NOT DEFER THE WALK, and the switch says so.
   *
   * `skipObjectScan` (#765) promises that opening a connection reads NOTHING, and that promise holds
   * here for the reason it holds everywhere else: the key panel is what reads a key space, and the
   * panel mounts only when the reader chooses Keys. So the tab pair stays, because the switch itself
   * is not a read, and the walk that follows the choice is a bounded sample that says it is one.
   *
   * Both halves are pinned together on purpose: the switch surviving the deferral is only correct
   * while the panel is still absent before the choice, so a change that mounted the panel eagerly
   * (a read on connect under another name) fails here rather than in the browser.
   */
  test("a deferred connection that declares keyScan keeps the switch, and mounts no walk until Keys is chosen", () => {
    const onLoadObjects = mock(() => {});
    const props = createDefaultProps({
      metadata: walkMetadata(),
      objectScanDeferred: true,
      onLoadObjects,
    });
    const { getByRole, queryByTestId } = render(<Sidebar {...props} />);

    // The engine's declaration decides the switch: the deferral is about the catalog, and this
    // engine has none to read.
    expect(getByRole("tab", { name: "Objects" })).toBeDefined();
    expect(getByRole("tab", { name: "Keys" })).toBeDefined();

    // The deferral still reaches the tree, with its load action.
    expect(queryByTestId("object-tree")?.getAttribute("data-deferred")).toBe("true");
    expect(queryByTestId("object-tree")?.getAttribute("data-has-load")).toBe("true");

    // Nothing has read a key: the panel IS the walk, and it is not mounted until Keys is chosen.
    expect(queryByTestId("key-browser")).toBeNull();

    fireEvent.click(getByRole("tab", { name: "Keys" }));
    expect(queryByTestId("key-browser")).not.toBeNull();
  });

  test("hands the panel the connection and the declared batch size when Keys is chosen", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: walkMetadata(),
    });
    const { getByRole, queryByTestId } = render(<Sidebar {...props} />);

    fireEvent.click(getByRole("tab", { name: "Keys" }));

    const panel = queryByTestId("key-browser");
    expect(panel).not.toBeNull();
    // The sidebar joins neither question: it hands over the connection and the declaration, and the
    // panel decides what a batch is from the declaration rather than from a number here.
    expect(panel?.getAttribute("data-connection")).toBe(mockPostgresConnection.id);
    expect(panel?.getAttribute("data-default-count")).toBe("500");
    expect(queryByTestId("object-tree")).toBeNull();

    fireEvent.click(getByRole("tab", { name: "Objects" }));
    expect(queryByTestId("object-tree")).not.toBeNull();
    // HIDDEN rather than gone: a walk costs round trips over the whole key space, so the reader's
    // sample survives a look at the object tree (#3).
    expect(queryByTestId("key-browser-panel")?.className).toContain("hidden");
  });

  test("keeps the same panel mounted across a trip to the tree and back", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: walkMetadata(),
    });
    const { getByRole, queryByTestId } = render(<Sidebar {...props} />);
    fireEvent.click(getByRole("tab", { name: "Keys" }));
    const panel = queryByTestId("key-browser");

    fireEvent.click(getByRole("tab", { name: "Objects" }));
    fireEvent.click(getByRole("tab", { name: "Keys" }));

    // The SAME element, not an equivalent one: a remount is what would take the walk back to cursor
    // `"0"`, and it is the thing a reader notices as "it scans again every time".
    expect(queryByTestId("key-browser")).toBe(panel);
    expect(queryByTestId("key-browser-panel")?.className).not.toContain("hidden");
  });

  test("drops the hidden panel when the connection changes, so it cannot walk another server", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: walkMetadata(),
    });
    const { getByRole, queryByTestId, rerender } = render(<Sidebar {...props} />);
    fireEvent.click(getByRole("tab", { name: "Keys" }));
    fireEvent.click(getByRole("tab", { name: "Objects" }));
    expect(queryByTestId("key-browser")).not.toBeNull();

    rerender(
      <Sidebar
        {...createDefaultProps({
          activeConnection: mockMySQLConnection,
          metadata: walkMetadata(),
        })}
      />,
    );

    // A hidden panel still walks, and the connection it was walking is no longer the one on screen:
    // keeping it would spend the server's `SCAN` on a key space nobody is looking at.
    expect(queryByTestId("key-browser")).toBeNull();
    expect(queryByTestId("object-tree")).not.toBeNull();
  });

  test("hands a key pattern from the row menu to the panel, and switches to it", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: walkMetadata(),
      objectActions: { onGenerateSelect: () => {} },
    });
    const { getByRole, queryByTestId } = render(<Sidebar {...props} />);
    // The tree is drawn and was never switched away from; the row menu is the only gesture here.
    expect(capturedBrowseKeys).toBeDefined();

    act(() => {
      capturedBrowseKeys?.({ name: "user:*", path: ["0", "user:*"] });
    });

    // The pattern the row named, ready to send: its `*` is the `MATCH` glob the panel needs, and the
    // panel is what shows it.
    expect(queryByTestId("key-browser")?.getAttribute("data-request")).toBe("user:*");
    expect(getByRole("tab", { name: "Keys" }).getAttribute("aria-selected")).toBe("true");
    expect(queryByTestId("object-tree")).toBeNull();
  });

  test("hands the row's OWN database over with its pattern", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: {
        capabilities: {
          ...oneLevel,
          keyScan: { defaultCount: 500, maxCount: 1000 },
          containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
        },
      } as unknown as ProviderMetadata,
      objectActions: { onGenerateSelect: () => {} },
    });
    const { queryByTestId } = render(<Sidebar {...props} />);

    // The tree lists `Key Patterns` under EVERY database, so the item is reachable from a row that
    // does not belong to the session's database. An object's path starts with its container's path,
    // and that first segment is what the panel's own choice is made of.
    act(() => {
      capturedBrowseKeys?.({ name: "user:*", path: ["2", "user:*"] });
    });

    expect(queryByTestId("key-browser")?.getAttribute("data-request-database")).toBe("2");
  });

  test("hands no database over when the engine declares no level to name", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      // The walk declared and NO container level: the key space is walked as a whole, so the row's
      // first segment is part of the key and not the name of a container.
      metadata: {
        capabilities: {
          queryLanguage: "sql",
          keyScan: { defaultCount: 500, maxCount: 1000 },
        },
      } as unknown as ProviderMetadata,
      objectActions: { onGenerateSelect: () => {} },
    });
    const { queryByTestId } = render(<Sidebar {...props} />);

    act(() => {
      capturedBrowseKeys?.({ name: "user:*", path: ["user:*"] });
    });

    // Nothing to point at: the walk is the whole key space, and the panel's own picker is not drawn.
    expect(queryByTestId("key-browser")?.getAttribute("data-request-database")).toBe("none");
  });

  test("escapes the PREFIX half of the row name it hands over, and only that half", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: walkMetadata(),
      objectActions: { onGenerateSelect: () => {} },
    });
    const { queryByTestId } = render(<Sidebar {...props} />);

    // A real key segment can contain a glob metacharacter, and the pattern this hands over is what
    // the server matches with: unescaped, `a[b:*` opens a character class and the walk answers about
    // keys nobody asked for. The one `*` the row is ADVERTISED with stays a glob, because that is
    // what it is for.
    act(() => {
      capturedBrowseKeys?.({ name: "a[b:*", path: ["0", "a[b:*"] });
    });

    expect(queryByTestId("key-browser")?.getAttribute("data-request")).toBe("a\\[b:*");
  });

  /**
   * AN ENGINE THAT ENUMERATES NOTHING OPENS ON THE KEYS TAB, which a browser run is what found.
   * MQTT and OPC UA declare a key walk and no enumerable object kind at all, so the object tree
   * asked them for objects, the provider refused by design, and the reader's FIRST screen after
   * connecting was an empty panel and a red "Schema Error" toast. Every other engine still opens on
   * Objects: the key browser is an addition, not a replacement.
   */
  test("an engine with a key walk and no enumerable kind opens on Keys", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: {
        capabilities: {
          queryLanguage: "json",
          // What MQTT and OPC UA declare: one kind, enumerated by the Keys panel alone.
          objectKinds: [
            {
              id: "node",
              role: "relation",
              label: "Node",
              labelPlural: "Nodes",
              enumeratedBy: "key-browser",
            },
          ],
          keyScan: {
            defaultCount: 200,
            maxCount: 1000,
            separator: "/",
            cursor: "opaque",
            pattern: "prefix",
          },
        },
      } as unknown as ProviderMetadata,
    });
    const { queryByTestId } = render(<Sidebar {...props} />);
    expect(queryByTestId("key-browser")).not.toBeNull();
  });

  test("an engine that does enumerate objects still opens on Objects", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: walkMetadata(),
    });
    const { queryByTestId } = render(<Sidebar {...props} />);
    expect(queryByTestId("key-browser")).toBeNull();
  });

  /**
   * What MQTT and OPC UA declare, as its own fixture: the three tests below are about the default
   * LEAVING this engine, so each of them needs the engine twice.
   */
  function enumeratesNothingMetadata(): ProviderMetadata {
    return {
      capabilities: {
        queryLanguage: "json",
        objectKinds: [
          {
            id: "node",
            role: "relation",
            label: "Node",
            labelPlural: "Nodes",
            enumeratedBy: "key-browser",
          },
        ],
        keyScan: {
          defaultCount: 200,
          maxCount: 1000,
          separator: "/",
          cursor: "opaque",
          pattern: "prefix",
        },
      },
    } as unknown as ProviderMetadata;
  }

  /** The tab the sidebar has selected, read the way a reader reads it. */
  function selectedTab(): string | null {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    return tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent ?? null;
  }

  /*
   * A DEFAULT MUST NOT OUTLIVE THE CONNECTION IT WAS DERIVED FOR, which is what storing it did: the
   * first version of the test above passed while one OPC UA or MQTT connection left `keys` in the
   * sidebar's state for good, so the next Redis, etcd, Oxia or S3 connection opened on a key walk
   * nobody asked for - on Redis an unrequested `SCAN` against whatever server that is - with the
   * object tree absent until the reader found the tab. Two connections in ONE sidebar is the only
   * shape that can see it; a test that renders one never will.
   */
  test("the Keys default does not follow the reader to an engine that enumerates objects", () => {
    const { rerender, queryByTestId } = render(
      <Sidebar
        {...createDefaultProps({
          activeConnection: mockPostgresConnection,
          metadata: enumeratesNothingMetadata(),
        })}
      />,
    );
    expect(queryByTestId("key-browser")).not.toBeNull();

    rerender(
      <Sidebar
        {...createDefaultProps({
          activeConnection: mockMySQLConnection,
          metadata: walkMetadata(),
        })}
      />,
    );
    expect(queryByTestId("object-tree")).not.toBeNull();
    expect(queryByTestId("key-browser")).toBeNull();
    expect(selectedTab()).toBe("Objects");
  });

  /* The reader's own choice still carries, which is the behaviour the stored default was hiding. */
  test("a reader who chose Keys keeps Keys on the next connection", () => {
    const { rerender, queryByTestId, getByText } = render(
      <Sidebar
        {...createDefaultProps({
          activeConnection: mockPostgresConnection,
          metadata: walkMetadata(),
        })}
      />,
    );
    fireEvent.click(getByText("Keys"));
    expect(queryByTestId("key-browser")).not.toBeNull();

    rerender(
      <Sidebar
        {...createDefaultProps({
          activeConnection: mockMySQLConnection,
          metadata: walkMetadata(),
        })}
      />,
    );
    expect(queryByTestId("key-browser")).not.toBeNull();
    expect(selectedTab()).toBe("Keys");
  });

  /*
   * And a choice of Objects is not carried ONTO an engine with nothing to enumerate: the reader who
   * chose it chose it about another server, and the tab it names is empty there by design. Pressing
   * it on THIS engine is a different thing, and the next test is that one.
   */
  test("a chosen Objects is not carried onto an engine that enumerates nothing", () => {
    const { rerender, queryByTestId, getByText } = render(
      <Sidebar
        {...createDefaultProps({
          activeConnection: mockPostgresConnection,
          metadata: walkMetadata(),
        })}
      />,
    );
    fireEvent.click(getByText("Keys"));
    fireEvent.click(getByText("Objects"));
    expect(queryByTestId("object-tree")).not.toBeNull();

    rerender(
      <Sidebar
        {...createDefaultProps({
          activeConnection: mockMySQLConnection,
          metadata: enumeratesNothingMetadata(),
        })}
      />,
    );
    expect(queryByTestId("key-browser")).not.toBeNull();
    expect(selectedTab()).toBe("Keys");
  });

  /*
   * A PATTERN BELONGS TO THE CONNECTION IT WAS ASKED FOR ON. `docs/BACKLOG.md` U108 recorded the
   * opposite as deferred - a Browse Keys pattern carried to the next connection, where it reads
   * `Scanned 0` - and the Keys default above turned it from "a reader who presses Keys meets it"
   * into "it is the first screen after connecting", because MQTT and OPC UA open on that panel.
   * Measured in a copy of the tree before the fix: the next engine's first screen carried `user:*`.
   */
  test("a Browse Keys pattern does not reach the next connection's panel", () => {
    const props = createDefaultProps({ activeConnection: mockPostgresConnection, metadata: walkMetadata() });
    const { rerender, queryByTestId } = render(<Sidebar {...props} />);
    capturedBrowseKeys?.({ name: "user:*", path: ["user:*"] } as never);

    rerender(
      <Sidebar
        {...createDefaultProps({ activeConnection: mockMySQLConnection, metadata: enumeratesNothingMetadata() })}
      />,
    );

    expect(queryByTestId("key-browser")).not.toBeNull();
    expect(queryByTestId("key-browser")?.getAttribute("data-request")).toBe("none");
  });

  /*
   * AND IT TRAVELS TO THE NEXT SERVER OF THE SAME KIND. A reader who presses Objects on an OPC UA
   * server has read what that tab says and asked for it anyway; switching to a second OPC UA server
   * used to put them back on Keys, which is the opposite of what the Redis-to-Redis rule promises.
   */
  test("a chosen Objects travels between two engines that both enumerate nothing", () => {
    const { rerender, queryByTestId, getByText } = render(
      <Sidebar
        {...createDefaultProps({ activeConnection: mockPostgresConnection, metadata: enumeratesNothingMetadata() })}
      />,
    );
    fireEvent.click(getByText("Objects"));
    expect(queryByTestId("object-tree")).not.toBeNull();

    rerender(
      <Sidebar
        {...createDefaultProps({ activeConnection: mockMySQLConnection, metadata: enumeratesNothingMetadata() })}
      />,
    );
    expect(queryByTestId("object-tree")).not.toBeNull();
    expect(selectedTab()).toBe("Objects");
  });

  test("pressing Objects on an engine that enumerates nothing stays on Objects", () => {
    const { queryByTestId, getByText } = render(
      <Sidebar
        {...createDefaultProps({
          activeConnection: mockPostgresConnection,
          metadata: enumeratesNothingMetadata(),
        })}
      />,
    );
    expect(queryByTestId("key-browser")).not.toBeNull();
    fireEvent.click(getByText("Objects"));
    expect(queryByTestId("object-tree")).not.toBeNull();
    expect(selectedTab()).toBe("Objects");
  });

  test("hands Browse Keys the bare prefix and its separator under a prefix declaration", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      // A walk that reads a literal prefix under `/` and declares no container level: what etcd answers.
      // `objectKinds` is declared because etcd declares five: an engine that enumerates NOTHING now
      // opens on the Keys tab (MQTT and OPC UA are the only two), and this test is about the
      // handover FROM the object tree, which such an engine has no reason to draw.
      metadata: {
        capabilities: {
          queryLanguage: "json",
          objectKinds: [
            {
              id: "prefix",
              role: "container",
              label: "Prefix",
              labelPlural: "Prefixes",
            },
          ],
          keyScan: {
            defaultCount: 500,
            maxCount: 1000,
            separator: "/",
            cursor: "opaque",
            pattern: "prefix",
            totalScope: "walk",
          },
        },
      } as unknown as ProviderMetadata,
      objectActions: { onGenerateSelect: () => {} },
    });
    const { queryByTestId } = render(<Sidebar {...props} />);

    // The group's advertised name loses only its star: the separator stays, so the walk does not also
    // read `/apisix/routes-v2/`, and nothing is escaped, because every byte of a prefix is data.
    act(() => {
      capturedBrowseKeys?.({
        name: "/apisix/routes/*",
        path: ["/apisix/routes/*"],
      });
    });
    expect(queryByTestId("key-browser")?.getAttribute("data-request")).toBe("/apisix/routes/");
    expect(queryByTestId("key-browser")?.getAttribute("data-request-database")).toBe("none");

    // Review Focus 1: a prefix holding a leading `-`, a space, both quotes, `#`, `$` and a glob
    // metacharacter is handed over as its string, with no escape.
    act(() => {
      capturedBrowseKeys?.({
        name: "/-a b'\"#$[x]/*",
        path: ["/-a b'\"#$[x]/*"],
      });
    });
    expect(queryByTestId("key-browser")?.getAttribute("data-request")).toBe("/-a b'\"#$[x]/");
  });

  test("hands a bucket row's name and the separator to the Keys view under a level declaration", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      // A level walk under `/` with no container level: what an object store declares, its buckets being
      // the key space's first segment. `objectKinds` is declared because S3 declares one (`object`
      // is key-browser enumerated, and the bucket kind is what the tree draws): an engine that
      // enumerates NOTHING now opens on the Keys tab, and this test is about the handover from the
      // object tree.
      metadata: {
        capabilities: {
          queryLanguage: "json",
          containerLevels: [],
          objectKinds: [
            {
              id: "bucket",
              role: "container",
              label: "Bucket",
              labelPlural: "Buckets",
            },
          ],
          keyScan: {
            defaultCount: 500,
            maxCount: 1000,
            separator: "/",
            cursor: "opaque",
            pattern: "prefix",
            totalScope: "none",
            levels: { rootKind: "bucket" },
          },
        },
      } as unknown as ProviderMetadata,
      objectActions: { onGenerateSelect: () => {} },
    });
    const { queryByTestId, getByRole } = render(<Sidebar {...props} />);

    act(() => {
      capturedBrowseKeys?.({ name: "sales", path: ["sales"] });
    });

    // The bucket's folder, `sales/`, and no database: the panel's first request for it carries the
    // pattern and `level: true` (KeyBrowser.test.tsx, "opens a handed-over prefix ...").
    expect(queryByTestId("key-browser")?.getAttribute("data-request")).toBe("sales/");
    expect(queryByTestId("key-browser")?.getAttribute("data-request-database")).toBe("none");
    expect(getByRole("tab", { name: "Keys" }).getAttribute("aria-selected")).toBe("true");
  });

  /**
   * The panel is not offered to a shell that answers the reads itself.
   *
   * `keyScan` is a declaration about the ENGINE, and the embedded workspace's host declares it for
   * whatever server it mounted - but the published package ships no API routes, so
   * `/api/db/keys/scan` would answer HTTP 404 to the tab's own first page. `objectSource` is the
   * shell-level fact: a shell that answers the tree's reads itself has no routes of its own.
   */
  test("offers no Keys tab, and no Browse Keys, to a shell that owns the reads", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: walkMetadata(),
      objectSource: async () => ({}),
    });
    const { queryByRole, queryByTestId, getByTestId } = render(<Sidebar {...props} />);

    expect(queryByRole("tab", { name: "Keys" })).toBeNull();
    expect(queryByRole("tab", { name: "Objects" })).toBeNull();
    expect(queryByTestId("key-browser")).toBeNull();
    // The row menu loses the item too, because the item's destination does not exist here.
    expect(getByTestId("object-tree").getAttribute("data-actions")).toBe("");
  });

  test("control: the same declaration DOES offer it to the standalone shell", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: walkMetadata(),
    });
    const { getByRole, getByTestId } = render(<Sidebar {...props} />);

    // The control that makes the assertion above non-vacuous: same metadata, no `objectSource`.
    expect(getByRole("tab", { name: "Keys" })).toBeDefined();
    expect(getByTestId("object-tree").getAttribute("data-actions")).toBe("onBrowseKeys");
  });

  test("offers no Keys tab to a shell that owns the reads when the declaration is S3's level walk", () => {
    // The embedded workspace's host answers the tree's reads itself and ships no /api/db/keys/scan, so S3's level walk
    // (a `levels` declaration with the bucket as its root) is withheld exactly as a flat walk is.
    const props = createDefaultProps({
      activeConnection: {
        ...mockPostgresConnection,
        id: "s3-1",
        type: "s3",
        port: 9000,
      },
      metadata: {
        capabilities: {
          queryLanguage: "json",
          containerLevels: [],
          objectKinds: [
            {
              id: "bucket",
              role: "config",
              label: "Bucket",
              labelPlural: "Buckets",
            },
          ],
          keyScan: {
            defaultCount: 500,
            maxCount: 1000,
            levels: { rootKind: "bucket" },
          },
        },
      } as unknown as ProviderMetadata,
      objectSource: async () => ({}),
    });
    const { queryByRole, queryByTestId, getByTestId } = render(<Sidebar {...props} />);

    expect(queryByRole("tab", { name: "Keys" })).toBeNull();
    expect(queryByTestId("key-browser")).toBeNull();
    expect(getByTestId("object-tree").getAttribute("data-actions")).toBe("");
  });

  test("adds the one action it owns to the handlers the shell handed down, and no others", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: walkMetadata(),
      objectActions: { onGenerateSelect: () => {}, onViewSource: () => {} },
    });
    const { queryByTestId } = render(<Sidebar {...props} />);

    // The shell decides what it can do and the sidebar adds only what it can do ITSELF: the panel is
    // this component's, so the item that opens it is too, and the rest passes through untouched.
    expect(queryByTestId("object-tree")?.getAttribute("data-actions")).toBe(
      "onBrowseKeys,onGenerateSelect,onViewSource",
    );
  });

  test("hands the panel the engine's own container level, as the walk's database", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: {
        capabilities: {
          ...oneLevel,
          keyScan: { defaultCount: 500, maxCount: 1000 },
          containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
        },
      } as unknown as ProviderMetadata,
    });
    const { getByRole, queryByTestId } = render(<Sidebar {...props} />);

    fireEvent.click(getByRole("tab", { name: "Keys" }));

    // The label is the ENGINE's word for the level, handed over rather than written here: the panel
    // labels its choice with it and never invents one.
    expect(queryByTestId("key-browser")?.getAttribute("data-level")).toBe("Database");
  });

  test("hands the key browser the activation handler it was given", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: walkMetadata(),
      onOpenKey: () => {},
    });
    const { getByRole, queryByTestId } = render(<Sidebar {...props} />);

    fireEvent.click(getByRole("tab", { name: "Keys" }));

    // Handed through and not acted on: the sidebar mounts the panel and joins neither question — what
    // to open, and what a key's type means — exactly as it joins neither for the object tree's own
    // row handlers.
    expect(queryByTestId("key-browser")?.getAttribute("data-has-open-key")).toBe("true");
  });

  test("falls back to the tree when the next connection declares no walk", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      metadata: walkMetadata(),
    });
    const { getByRole, queryByTestId, rerender } = render(<Sidebar {...props} />);
    fireEvent.click(getByRole("tab", { name: "Keys" }));
    expect(queryByTestId("key-browser")).not.toBeNull();

    // Keys stays the reader's choice across connections — somebody switching between two servers of
    // the same engine meant to keep looking at keys — so the CAPABILITY is what has to keep the
    // choice honest, and an engine without the walk renders the tree with no tabs beside it.
    rerender(<Sidebar {...createDefaultProps({ activeConnection: mockPostgresConnection })} />);
    expect(queryByTestId("key-browser")).toBeNull();
    expect(queryByTestId("object-tree")).not.toBeNull();
  });
});
