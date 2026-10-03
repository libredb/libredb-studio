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
      props.actions as { onBrowseKeys?: (object: { name: string; path: readonly string[] }) => void } | undefined
    )?.onBrowseKeys;
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

/**
 * A declaration that includes the key-space walk — what a provider with no catalog answers.
 *
 * Declared here rather than reused from a connection fixture, because the sidebar reads the
 * DECLARATION and never the connection's type: a fixture named after an engine would suggest the
 * panel keys off that name, which is the one thing it must not do.
 */
function walkMetadata(): ProviderMetadata {
  return {
    capabilities: { ...oneLevel, keyScan: { defaultCount: 500, maxCount: 1000 } },
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
    const props = createDefaultProps({ metadata: null, metadataError: "Connection refused", onRetryMetadata });
    const { getByTestId } = render(<Sidebar {...props} />);

    fireEvent.click(getByTestId("sidebar-provider-retry"));

    expect(onRetryMetadata).toHaveBeenCalledTimes(1);
  });

  // The shell that cannot retry does not draw a button that does nothing. The embedded
  // workspace is that shell: its host DECLARES the capabilities, so there is no read to
  // re-issue and it passes neither prop.
  test("no retry is offered when the shell supplied no way to re-read", () => {
    const props = createDefaultProps({ metadata: null, metadataError: "Connection refused" });
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
    const props = createDefaultProps({ objectScanDeferred: true, onLoadObjects });
    const { getByTestId } = render(<Sidebar {...props} />);

    expect(getByTestId("object-tree").getAttribute("data-deferred")).toBe("true");
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
      objectActions: { onProfileObject: mock(() => {}), onCreateObject: mock(() => {}) },
      // The wording travels with the declaration rather than beside it: both halves of
      // `metadata` reach the tree, since the menu's maintenance items need the second.
      metadata: {
        capabilities: { ...oneLevel, keyScan: { defaultCount: 500, maxCount: 1000 } },
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

  test("passes favoriteConnectionIds and onToggleFavoriteConnection through to ConnectionsList", () => {
    const favoriteConnectionIds = new Set([mockPostgresConnection.id]);
    const onToggleFavoriteConnection = mock(() => {});
    const props = createDefaultProps({ favoriteConnectionIds, onToggleFavoriteConnection });

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

  test("no ERD button on a connection declaring Cypher, whose relationship types are no tables (SR20)", () => {
    const cypher = { capabilities: { ...oneLevel, queryLanguage: "cypher" } } as unknown as ProviderMetadata;
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
    // A tree engine keeps the sidebar it had: no tab strip at all, rather than a disabled one.
    expect(withoutWalk.queryByRole("tab", { name: "Keys" })).toBeNull();
    expect(withoutWalk.queryByTestId("key-browser")).toBeNull();
    withoutWalk.unmount();

    const withWalk = render(<Sidebar {...createDefaultProps({ metadata: walkMetadata() })} />);
    expect(withWalk.getByRole("tab", { name: "Objects" })).toBeDefined();
    expect(withWalk.getByRole("tab", { name: "Keys" })).toBeDefined();
    // The tree is what opens, because the panel is an addition rather than a replacement.
    expect(withWalk.queryByTestId("object-tree")).not.toBeNull();
    expect(withWalk.queryByTestId("key-browser")).toBeNull();
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

    rerender(<Sidebar {...createDefaultProps({ activeConnection: mockMySQLConnection, metadata: walkMetadata() })} />);

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
        capabilities: { queryLanguage: "sql", keyScan: { defaultCount: 500, maxCount: 1000 } },
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

  test("hands Browse Keys the bare prefix and its separator under a prefix declaration", () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
      // A walk that reads a literal prefix under `/` and declares no container level: what etcd answers.
      metadata: {
        capabilities: {
          queryLanguage: "json",
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
      capturedBrowseKeys?.({ name: "/apisix/routes/*", path: ["/apisix/routes/*"] });
    });
    expect(queryByTestId("key-browser")?.getAttribute("data-request")).toBe("/apisix/routes/");
    expect(queryByTestId("key-browser")?.getAttribute("data-request-database")).toBe("none");

    // Review Focus 1: a prefix holding a leading `-`, a space, both quotes, `#`, `$` and a glob
    // metacharacter is handed over as its string, with no escape.
    act(() => {
      capturedBrowseKeys?.({ name: "/-a b'\"#$[x]/*", path: ["/-a b'\"#$[x]/*"] });
    });
    expect(queryByTestId("key-browser")?.getAttribute("data-request")).toBe("/-a b'\"#$[x]/");
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
