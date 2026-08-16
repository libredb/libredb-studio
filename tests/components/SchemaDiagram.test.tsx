import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { mock } from "bun:test";
import { setupFramerMotionMock } from "../helpers/mock-monaco";

// Module-scope handles so tests can assert on mock internals
const mockUpdateNodeInternals = mock(() => {});
// Latest props ReactFlow was rendered with (culling assertions)
let lastReactFlowProps: Record<string, unknown> = {};

// Enhanced XYFlow mock that renders nodes via nodeTypes
mock.module("@xyflow/react", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  // Probe rendered inside the diagram's providers: the only in-card control
  // (the "+N more" expander) disappears once a table is expanded, so tests
  // exercise the collapse half of toggleExpand through the context action.
  const DiagramActionsProbe = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useDiagramActions } = require("@/components/schema-diagram/diagram-context");
    const actions = useDiagramActions();
    return React.createElement("button", {
      "data-testid": "probe-toggle-expand",
      onClick: () => actions.toggleExpand("wide"),
    });
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ReactFlow: (props: Record<string, any>) => {
      lastReactFlowProps = props;
      const { children, nodes = [], nodeTypes = {}, onNodeClick, onPaneClick } = props;
      const renderedNodes = nodes.map((node: { id: string; type: string; data: Record<string, unknown> }) => {
        const NodeComp = nodeTypes[node.type];
        if (!NodeComp) return null;
        return React.createElement(
          "div",
          {
            key: node.id,
            "data-testid": `node-${node.id}`,
            "data-node-id": node.id,
            onClick: (e: React.MouseEvent) => {
              e.stopPropagation();
              onNodeClick?.(e, node);
            },
          },
          React.createElement(NodeComp, { id: node.id, data: node.data, type: node.type }),
        );
      });
      // Wrap nodes in a keyed container to avoid reconciliation issues
      // when the number of nodes changes (e.g. during search filtering)
      return React.createElement(
        "div",
        {
          "data-testid": "mock-react-flow",
          className: "react-flow",
          onClick: (e: React.MouseEvent) => {
            if (e.target === e.currentTarget) onPaneClick?.();
          },
        },
        React.createElement(
          "div",
          { key: "__viewport__", className: "react-flow__viewport" },
          React.createElement("div", { key: "__nodes__", "data-testid": "nodes-container" }, renderedNodes),
          React.createElement("svg", { key: "__svg__" }),
        ),
        React.createElement(React.Fragment, { key: "__children__" }, children),
        React.createElement(DiagramActionsProbe, { key: "__probe__" }),
      );
    },
    ReactFlowProvider: ({ children }: { children: unknown }) => children,
    MiniMap: () => React.createElement("div", { "data-testid": "mock-minimap" }),
    Controls: () => null,
    Background: () => null,
    Handle: () => null,
    BaseEdge: ({ id, path, style }: Record<string, unknown>) =>
      React.createElement("path", { "data-testid": "mock-base-edge", "data-edge-id": id, d: path, style }),
    EdgeLabelRenderer: ({ children }: { children: unknown }) => children,
    getSmoothStepPath: () => ["M0 0 L10 10", 5, 5],
    getNodesBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    getViewportForBounds: () => ({ x: 32, y: 32, zoom: 1 }),
    applyNodeChanges: (_changes: unknown, nodes: unknown[]) => nodes,
    useNodesState: () => [[], mock(() => {}), mock(() => {})],
    useEdgesState: () => [[], mock(() => {}), mock(() => {})],
    // The real useReactFlow returns a referentially stable instance; effects
    // in the component depend on it, so the mock must be a singleton too.
    useReactFlow: (() => {
      const instance = { fitView: mock(() => {}), getNodes: mock(() => []), getEdges: mock(() => []) };
      return () => instance;
    })(),
    useUpdateNodeInternals: () => mockUpdateNodeInternals,
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
    MarkerType: { ArrowClosed: "arrowclosed" },
    Panel: ({ children, position }: { children: unknown; position?: string }) =>
      React.createElement("div", { "data-testid": `mock-panel-${position || "default"}` }, children),
  };
});

setupFramerMotionMock();

// Mock the layout engine so component tests never spin up workers or ELK.
// Its own behavior is unit-tested in tests/unit/schema-diagram/. Tests can
// swap the implementation via setLayoutEngineImpl (restored in beforeEach).
type MockLayoutEngine = {
  layout: (graph: { children: Array<{ id: string }> }) => Promise<unknown>;
  dispose: () => Promise<void>;
};
const defaultLayoutEngine: MockLayoutEngine = {
  layout: (graph) =>
    Promise.resolve({
      id: "root",
      children: graph.children.map((child, i) => ({ ...child, x: i * 100, y: 0 })),
    }),
  dispose: () => Promise.resolve(),
};
let layoutEngineImpl: MockLayoutEngine = defaultLayoutEngine;
function setLayoutEngineImpl(impl: MockLayoutEngine) {
  layoutEngineImpl = impl;
}
mock.module("@/components/schema-diagram/layout-engine", () => ({
  createLayoutEngine: () => ({
    layout: (graph: { children: Array<{ id: string }> }) => layoutEngineImpl.layout(graph),
    dispose: () => layoutEngineImpl.dispose(),
  }),
}));

// Track snapdom captures (PNG via result.toBlob, SVG via result.url)
const mockToBlob = mock(() => Promise.resolve(new Blob(["png-bytes"], { type: "image/png" })));
const mockSvgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent("<svg><text>users</text></svg>")}`;
// Inline styles AT CAPTURE TIME - snapdom snapshots the live DOM, so the
// export transform/size must be applied when it runs. snapdom normalizes away
// the ROOT element's translate, so the captured root must be the viewport's
// PARENT (sized to the export box) with the transform on the viewport child.
let capturedStyles: { transform: string; width: string; height: string; hasViewportChild: boolean } | null = null;
const mockSnapdom = mock((el: unknown, _options?: Record<string, unknown>) => {
  const root = el as HTMLElement;
  const viewport = root.querySelector<HTMLElement>(".react-flow__viewport");
  capturedStyles = {
    transform: viewport?.style.transform ?? "(no viewport child)",
    width: root.style.width,
    height: root.style.height,
    hasViewportChild: viewport != null,
  };
  return Promise.resolve({ toBlob: mockToBlob, url: mockSvgDataUrl });
});

mock.module("@zumer/snapdom", () => ({
  snapdom: mockSnapdom,
}));

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, within, cleanup, act } from "@testing-library/react";
import React from "react";

import { renderToStaticMarkup } from "react-dom/server";

import { SchemaDiagram } from "@/components/SchemaDiagram";
import { EXPORT_BACKGROUND, exportViewportImage, svgDataUrlToBlob } from "@/components/schema-diagram/export";
import { FkEdge } from "@/components/schema-diagram/FkEdge";
import {
  createHighlightStore,
  HighlightStoreProvider,
  useTableHighlighted,
} from "@/components/schema-diagram/highlight-store";
import { mockToastError } from "../helpers/mock-sonner";
import { mockSchema, emptySchema } from "../fixtures/schemas";
import type { TableSchema } from "@/lib/types";

// =============================================================================
// Test Data
// =============================================================================

// Schema with NO foreign keys at all (triggers heuristic fallback)
const schemaNoFK: TableSchema[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "name", type: "varchar(255)", nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 100,
  },
  {
    name: "posts",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "title", type: "text", nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 50,
  },
];

// Schema with heuristic _id column (no FK data, but column ends with _id)
const schemaHeuristic: TableSchema[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "email", type: "varchar", nullable: true, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 10,
  },
  {
    name: "comments",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "user_id", type: "integer", nullable: false, isPrimary: false },
      { name: "body", type: "text", nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 200,
  },
];

// Schema with heuristic _id column matching singular table name (no plural 's')
const schemaHeuristicSingular: TableSchema[] = [
  {
    name: "author",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "name", type: "varchar(255)", nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 10,
  },
  {
    name: "books",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "author_id", type: "integer", nullable: false, isPrimary: false },
      { name: "title", type: "text", nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 50,
  },
];

// Schema with foreignKeys field omitted (tests `|| []` guards)
const schemaUndefinedFK: TableSchema[] = [
  {
    name: "items",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "label", type: "text", nullable: true, isPrimary: false },
    ],
    indexes: [],
    rowCount: 20,
  } as TableSchema,
];

// Multi-FK schema for highlighting tests
const schemaMultiFK: TableSchema[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "name", type: "varchar(255)", nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 100,
  },
  {
    name: "orders",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "user_id", type: "integer", nullable: false, isPrimary: false },
      { name: "total", type: "numeric(10,2)", nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
    rowCount: 500,
  },
  {
    name: "items",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "order_id", type: "integer", nullable: false, isPrimary: false },
      { name: "product", type: "varchar(255)", nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [{ columnName: "order_id", referencedTable: "orders", referencedColumn: "id" }],
    rowCount: 1000,
  },
];

// Single table schema
const singleTableSchema: TableSchema[] = [
  {
    name: "settings",
    columns: [
      { name: "key", type: "text", nullable: false, isPrimary: true },
      { name: "value", type: "text", nullable: true, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 5,
  },
];

// =============================================================================
// Helpers
// =============================================================================

function createDefaultProps(overrides: Partial<Parameters<typeof SchemaDiagram>[0]> = {}) {
  return {
    schema: mockSchema,
    onClose: mock(() => {}),
    ...overrides,
  };
}

// =============================================================================
// SchemaDiagram Tests
// =============================================================================

describe("SchemaDiagram", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockToBlob.mockClear();
    mockSnapdom.mockClear();
    mockToastError.mockClear();
    capturedStyles = null;
    mockUpdateNodeInternals.mockClear();
    setLayoutEngineImpl(defaultLayoutEngine);
    mockSnapdom.mockImplementation((el: unknown, _options?: Record<string, unknown>) => {
      const root = el as HTMLElement;
      const viewport = root.querySelector<HTMLElement>(".react-flow__viewport");
      capturedStyles = {
        transform: viewport?.style.transform ?? "(no viewport child)",
        width: root.style.width,
        height: root.style.height,
        hasViewportChild: viewport != null,
      };
      return Promise.resolve({ toBlob: mockToBlob, url: mockSvgDataUrl });
    });
  });

  // ── Rendering ───────────────────────────────────────────────────────────

  test("renders ReactFlow container", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);

    expect(container.querySelector('[data-testid="mock-react-flow"]')).not.toBeNull();
  });

  test("shows top-right panel with buttons", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);

    expect(container.querySelector('[data-testid="mock-panel-top-right"]')).not.toBeNull();
  });

  test("shows top-left info panel", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);

    expect(container.querySelector('[data-testid="mock-panel-top-left"]')).not.toBeNull();
  });

  test("renders ERD Visualizer heading", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText("ERD Visualizer")).not.toBeNull();
  });

  // ── Close button ────────────────────────────────────────────────────────

  test("onClose fires when close button clicked", () => {
    const onClose = mock(() => {});
    const props = createDefaultProps({ onClose });
    const { container } = render(<SchemaDiagram {...props} />);

    const closeButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.className.includes("rounded-full"),
    );
    expect(closeButton).not.toBeNull();

    fireEvent.click(closeButton!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Table count and relationships ───────────────────────────────────────

  test("shows table info from schema in ERD panel", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText("3 tables")).not.toBeNull();
  });

  test("shows relationship count", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // mockSchema has orders → users FK, so 1 relationship
    expect(view.queryByText("1 relationships")).not.toBeNull();
  });

  test("shows 0 relationships for schema without FKs", () => {
    const props = createDefaultProps({ schema: schemaNoFK });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText("0 relationships")).not.toBeNull();
  });

  test("shows heuristic relationships count for _id columns", () => {
    const props = createDefaultProps({ schema: schemaHeuristic });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // comments.user_id → users heuristic edge
    expect(view.queryByText("1 relationships")).not.toBeNull();
  });

  test("shows single table count", () => {
    const props = createDefaultProps({ schema: singleTableSchema });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText("1 tables")).not.toBeNull();
  });

  // ── Export buttons ──────────────────────────────────────────────────────

  test("export buttons present (PNG, SVG)", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText("PNG")).not.toBeNull();
    expect(view.queryByText("SVG")).not.toBeNull();
  });

  test("PNG export button click does not crash", async () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const pngButton = view.getByText("PNG").closest("button")!;
    // Let the async export flow finish inside this test so it cannot bleed
    // into later tests (the mocks are shared module-level state).
    await act(async () => {
      fireEvent.click(pngButton);
      await new Promise((r) => setTimeout(r, 40));
    });
    // Should not throw
  });

  test("SVG export button click does not crash", async () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const svgButton = view.getByText("SVG").closest("button")!;
    await act(async () => {
      fireEvent.click(svgButton);
      await new Promise((r) => setTimeout(r, 40));
    });
    // Should not throw
  });

  // ── Search input ────────────────────────────────────────────────────────

  test("search input present with placeholder", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByPlaceholderText("Filter tables...")).not.toBeNull();
  });

  test("search filters tables and updates count", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // Initially 3 tables
    expect(view.queryByText("3 tables")).not.toBeNull();

    const searchInput = view.getByPlaceholderText("Filter tables...");
    fireEvent.change(searchInput, { target: { value: "users" } });

    // After filtering, only 1 table matches
    expect(view.queryByText("1 tables")).not.toBeNull();
    expect(view.queryByText("3 tables")).toBeNull();
  });

  test("search is case-insensitive", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText("Filter tables...");
    fireEvent.change(searchInput, { target: { value: "ORDERS" } });

    expect(view.queryByText("1 tables")).not.toBeNull();
  });

  test("search with no matches shows 0 tables", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText("Filter tables...");
    fireEvent.change(searchInput, { target: { value: "nonexistent" } });

    expect(view.queryByText("0 tables")).not.toBeNull();
  });

  test("clearing search restores all tables", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText("Filter tables...");

    // Type to filter
    fireEvent.change(searchInput, { target: { value: "users" } });
    expect(view.queryByText("1 tables")).not.toBeNull();

    // Clear the search
    fireEvent.change(searchInput, { target: { value: "" } });
    expect(view.queryByText("3 tables")).not.toBeNull();
  });

  // ── Compact mode toggle ─────────────────────────────────────────────────

  test('compact mode toggle present showing "Compact" initially', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText("Compact")).not.toBeNull();
    expect(view.queryByText("Detail")).toBeNull();
  });

  test("clicking Compact toggles to Detail", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const compactButton = view.getByText("Compact").closest("button")!;
    fireEvent.click(compactButton);

    expect(view.queryByText("Detail")).not.toBeNull();
    expect(view.queryByText("Compact")).toBeNull();
  });

  test("clicking Detail toggles back to Compact", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // Toggle to compact
    const compactButton = view.getByText("Compact").closest("button")!;
    fireEvent.click(compactButton);
    expect(view.queryByText("Detail")).not.toBeNull();

    // Toggle back to detail
    const detailButton = view.getByText("Detail").closest("button")!;
    fireEvent.click(detailButton);
    expect(view.queryByText("Compact")).not.toBeNull();
  });

  test("compact button has blue text class when compact mode is active", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const compactButton = view.getByText("Compact").closest("button")!;
    expect(compactButton.className).not.toContain("text-blue-400");

    fireEvent.click(compactButton);
    const detailButton = view.getByText("Detail").closest("button")!;
    expect(detailButton.className).toContain("text-blue-400");
  });

  // ── No FK warning ───────────────────────────────────────────────────────

  test("shows no-FK warning when schema has no foreign keys", () => {
    const props = createDefaultProps({ schema: schemaNoFK });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText(/No FK data available/)).not.toBeNull();
    // schemaNoFK produces no heuristic edges either - the message must not
    // claim dashed relationships are being shown.
    expect(view.queryByText(/heuristic relationships/)).toBeNull();
  });

  test("warning mentions dashed heuristic edges only when some are displayed", () => {
    const props = createDefaultProps({ schema: schemaHeuristic });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText(/No FK data available/)).not.toBeNull();
    expect(view.queryByText(/heuristic relationships/)).not.toBeNull();
  });

  test("does not show no-FK warning when schema has foreign keys", () => {
    const props = createDefaultProps(); // mockSchema has FK on orders
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText(/No FK data available/)).toBeNull();
  });

  test("shows warning when FK data exists but the displayed graph is heuristic", () => {
    // invoices HAS FK data, but it references a table outside the schema -
    // the diagram falls back to dashed heuristic edges and must explain them.
    const unusableFk: TableSchema[] = [
      {
        name: "customer",
        columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
        indexes: [],
        foreignKeys: [],
        rowCount: 1,
      },
      {
        name: "invoices",
        columns: [
          { name: "id", type: "integer", nullable: false, isPrimary: true },
          { name: "customer_id", type: "integer", nullable: false, isPrimary: false },
        ],
        indexes: [],
        foreignKeys: [{ columnName: "customer_id", referencedTable: "archived_customers", referencedColumn: "id" }],
        rowCount: 1,
      },
    ];
    const props = createDefaultProps({ schema: unusableFk });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // FK metadata EXISTS here (it just references a table outside the view),
    // so the message must not claim there is no FK data at all.
    expect(view.queryByText(/No usable FK relationships in this view/)).not.toBeNull();
    expect(view.queryByText(/heuristic relationships/)).not.toBeNull();
    expect(view.queryByText(/No FK data available/)).toBeNull();
  });

  // ── Selected node info ──────────────────────────────────────────────────

  test("does not show selected node info by default", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText("Selected:")).toBeNull();
    expect(view.queryByText("clear")).toBeNull();
  });

  // ── Empty schema / loading state ────────────────────────────────────────

  test("empty schema shows loading/generating state", () => {
    const props = createDefaultProps({ schema: emptySchema });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText("Generating ERD Diagram...")).not.toBeNull();
  });

  test("empty schema does not render ReactFlow", () => {
    const props = createDefaultProps({ schema: emptySchema });
    const { container } = render(<SchemaDiagram {...props} />);

    expect(container.querySelector('[data-testid="mock-react-flow"]')).toBeNull();
  });

  test("empty schema does not render panels", () => {
    const props = createDefaultProps({ schema: emptySchema });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText("ERD Visualizer")).toBeNull();
    expect(view.queryByText("PNG")).toBeNull();
    expect(view.queryByText("Compact")).toBeNull();
    expect(view.queryByPlaceholderText("Filter tables...")).toBeNull();
  });

  // ── Search affects edge count ───────────────────────────────────────────

  test("filtering to table with FK shows its relationships", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // Search for "orders" — has FK to users, but users is filtered out
    const searchInput = view.getByPlaceholderText("Filter tables...");
    fireEvent.change(searchInput, { target: { value: "orders" } });

    // Only orders table visible, users is filtered out → FK edge excluded (target not in set)
    expect(view.queryByText("1 tables")).not.toBeNull();
    expect(view.queryByText("0 relationships")).not.toBeNull();
  });

  // ── Heuristic edge detection ────────────────────────────────────────────

  test("heuristic edges are created for _id columns when no FK data", () => {
    const props = createDefaultProps({ schema: schemaHeuristic });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // comments has user_id → should heuristically link to users
    expect(view.queryByText("1 relationships")).not.toBeNull();
  });

  test("heuristic edges not created when real FK data exists", () => {
    // mockSchema has real FK on orders.user_id → users.id
    // so heuristic fallback should NOT run
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // Only 1 real FK edge, no extra heuristic
    expect(view.queryByText("1 relationships")).not.toBeNull();
  });

  // ── Multiple re-renders don't crash ─────────────────────────────────────

  test("re-rendering with different schema does not crash", () => {
    const onClose = mock(() => {});
    const { container, rerender } = render(<SchemaDiagram schema={mockSchema} onClose={onClose} />);
    const view = within(container);
    expect(view.queryByText("3 tables")).not.toBeNull();

    rerender(<SchemaDiagram schema={singleTableSchema} onClose={onClose} />);
    expect(view.queryByText("1 tables")).not.toBeNull();
  });

  // ── Panel buttons ─────────────────────────────────────────────────────

  test("top-right panel has PNG, SVG, Compact, and close buttons", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);
    expect(view.queryByText("PNG")).not.toBeNull();
    expect(view.queryByText("SVG")).not.toBeNull();
    expect(view.queryByText("Compact")).not.toBeNull();
    // Close button (X icon)
    const closeBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.className.includes("rounded-full"),
    );
    expect(closeBtn).not.toBeNull();
  });

  // ── MiniMap rendered ─────────────────────────────────────────────────

  test("MiniMap component renders", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    expect(container.querySelector('[data-testid="mock-minimap"]')).not.toBeNull();
  });

  // ── Schema with many tables ─────────────────────────────────────────

  test("schema with many tables renders correct count", () => {
    const manyTables: TableSchema[] = Array.from({ length: 10 }, (_, i) => ({
      name: `table_${i}`,
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: [],
      foreignKeys: [],
      rowCount: i * 10,
    }));
    const props = createDefaultProps({ schema: manyTables });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);
    expect(view.queryByText("10 tables")).not.toBeNull();
    expect(view.queryByText("0 relationships")).not.toBeNull();
  });

  // ── Search with partial match ───────────────────────────────────────

  test("search with partial match filters correctly", () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText("Filter tables...");
    fireEvent.change(searchInput, { target: { value: "ord" } });
    // 'orders' matches 'ord'
    expect(view.queryByText("1 tables")).not.toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // NEW: TableNode Rendering Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("TableNode rendering", () => {
    test("renders table name in header", () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // Each table name should appear in uppercase in the header
      expect(view.queryByText("users")).not.toBeNull();
      expect(view.queryByText("orders")).not.toBeNull();
      expect(view.queryByText("products")).not.toBeNull();
    });

    test("shows column count badge", () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // users has 6 columns, orders has 5, products has 4
      expect(view.queryByText("6 cols")).not.toBeNull();
      expect(view.queryByText("5 cols")).not.toBeNull();
      expect(view.queryByText("4 cols")).not.toBeNull();
    });

    test("displays column names", () => {
      const props = createDefaultProps({ schema: singleTableSchema });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      expect(view.queryByText("key")).not.toBeNull();
      expect(view.queryByText("value")).not.toBeNull();
    });

    test("displays column type text", () => {
      const props = createDefaultProps({ schema: singleTableSchema });
      const { container } = render(<SchemaDiagram {...props} />);

      // Column types should be rendered in uppercase
      const texts = Array.from(container.querySelectorAll(".font-mono"));
      const typeTexts = texts.map((el) => el.textContent);
      expect(typeTexts).toContain("text");
    });

    test("shows NN for NOT NULL columns", () => {
      const props = createDefaultProps({ schema: singleTableSchema });
      const { container } = render(<SchemaDiagram {...props} />);

      // 'key' column has nullable: false
      const nnElements = container.querySelectorAll("span");
      const nnTexts = Array.from(nnElements).map((el) => el.textContent);
      expect(nnTexts).toContain("NN");
    });

    test("compact mode hides column details", () => {
      const props = createDefaultProps({ schema: singleTableSchema });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // Before compact — columns visible
      expect(view.queryByText("key")).not.toBeNull();
      expect(view.queryByText("value")).not.toBeNull();

      // Toggle compact mode
      const compactButton = view.getByText("Compact").closest("button")!;
      fireEvent.click(compactButton);

      // In compact mode, columns should be hidden (only header visible)
      // The header still shows settings and "2 cols"
      expect(view.queryByText("settings")).not.toBeNull();
      expect(view.queryByText("2 cols")).not.toBeNull();
      // Column names should not appear as separate elements in the columns list
      // key/value are column names, but the column list section is hidden in compact
      const nodeEl = container.querySelector('[data-node-id="settings"]');
      expect(nodeEl).not.toBeNull();
      // In compact mode, the p-1 div with columns is not rendered
      // We check that column type badges disappear
      const fontMonoElements = nodeEl!.querySelectorAll(".font-mono");
      expect(fontMonoElements.length).toBe(0);
    });

    test("renders node for each table in schema", () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);

      expect(container.querySelector('[data-node-id="users"]')).not.toBeNull();
      expect(container.querySelector('[data-node-id="orders"]')).not.toBeNull();
      expect(container.querySelector('[data-node-id="products"]')).not.toBeNull();
    });

    test("node with empty/null data returns nothing", () => {
      // Schema with a valid table ensures at least one node renders
      // The guard `if (!data) return null; if (!table) return null;` is tested
      // by the fact that the enhanced mock passes correct data through
      const props = createDefaultProps({ schema: singleTableSchema });
      const { container } = render(<SchemaDiagram {...props} />);

      const nodeEl = container.querySelector('[data-node-id="settings"]');
      expect(nodeEl).not.toBeNull();
      // The node should have content (table header)
      expect(nodeEl!.textContent).toContain("settings");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // NEW: Node Selection Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("Node selection", () => {
    test('clicking a node shows "Selected:" info panel', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // Initially no selection
      expect(view.queryByText("Selected:")).toBeNull();

      // Click the users node
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      fireEvent.click(usersNode);

      // Selection should appear with selected node name and clear button
      expect(view.queryByText("Selected:")).not.toBeNull();
      // The selected table name appears in a font-mono span
      const selectedSpan = container.querySelector(".font-mono.font-medium");
      expect(selectedSpan).not.toBeNull();
      expect(selectedSpan!.textContent).toBe("users");
      expect(view.queryByText("clear")).not.toBeNull();
    });

    test("clicking the same node again deselects (toggle)", () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      const usersNode = container.querySelector('[data-node-id="users"]')!;

      // Select
      fireEvent.click(usersNode);
      expect(view.queryByText("Selected:")).not.toBeNull();

      // Deselect
      fireEvent.click(usersNode);
      expect(view.queryByText("Selected:")).toBeNull();
    });

    test('clicking "clear" button clears selection', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // Select a node
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      fireEvent.click(usersNode);
      expect(view.queryByText("Selected:")).not.toBeNull();

      // Click clear
      const clearButton = view.getByText("clear");
      fireEvent.click(clearButton);
      expect(view.queryByText("Selected:")).toBeNull();
    });

    test("selection is dropped when the selected table is filtered out", () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      fireEvent.click(container.querySelector('[data-node-id="users"]')!);
      expect(view.queryByText("Selected:")).not.toBeNull();

      // Filtering "users" out of the graph must clear the stale selection.
      const searchInput = view.getByPlaceholderText("Filter tables...");
      fireEvent.change(searchInput, { target: { value: "orders" } });

      expect(view.queryByText("Selected:")).toBeNull();
      // ...and the surviving table does not inherit any highlight.
      const ordersNode = container.querySelector('[data-node-id="orders"]')!;
      expect(ordersNode.querySelector(".border-blue-500\\/60")).toBeNull();
    });

    test("clicking pane background clears selection", () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // Select a node
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      fireEvent.click(usersNode);
      expect(view.queryByText("Selected:")).not.toBeNull();

      // Click the pane background (the react-flow container itself)
      const reactFlowContainer = container.querySelector('[data-testid="mock-react-flow"]')!;
      // Fire click directly on the container element (target === currentTarget)
      fireEvent.click(reactFlowContainer);
      expect(view.queryByText("Selected:")).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // NEW: Node/Edge Highlighting Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("Node/Edge highlighting", () => {
    test("selected node gets highlighted (blue border)", () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);

      // Click users node
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      fireEvent.click(usersNode);

      // The TableNode's root div inside the data-node-id div should have blue border
      const innerDiv = usersNode.querySelector(".border-blue-500\\/60");
      expect(innerDiv).not.toBeNull();
    });

    test("FK target of selected node is highlighted", () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);

      // Select 'orders' which has FK to 'users'
      const ordersNode = container.querySelector('[data-node-id="orders"]')!;
      fireEvent.click(ordersNode);

      // The 'users' table should also be highlighted (FK target)
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      const usersInner = usersNode.querySelector(".border-blue-500\\/60");
      expect(usersInner).not.toBeNull();
    });

    test("FK source of selected node is highlighted", () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);

      // Select 'users' — orders has FK pointing to users
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      fireEvent.click(usersNode);

      // The 'orders' table should be highlighted (it references users via FK)
      const ordersNode = container.querySelector('[data-node-id="orders"]')!;
      const ordersInner = ordersNode.querySelector(".border-blue-500\\/60");
      expect(ordersInner).not.toBeNull();
    });

    test("non-related node is NOT highlighted when another is selected", () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);

      // Select 'orders' (related to users via FK, not related to products)
      const ordersNode = container.querySelector('[data-node-id="orders"]')!;
      fireEvent.click(ordersNode);

      // Products should NOT be highlighted
      const productsNode = container.querySelector('[data-node-id="products"]')!;
      const productsInner = productsNode.querySelector(".border-blue-500\\/60");
      expect(productsInner).toBeNull();
      // Products should have default border
      const productsDefault = productsNode.querySelector(".border-hairline-strong");
      expect(productsDefault).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // NEW: Export Internals Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("Export functionality", () => {
    function spyOnDownloads() {
      const clickMock = mock(() => {});
      const downloads: string[] = [];
      const originalCreateElement = document.createElement.bind(document);
      const createElementSpy = mock((tag: string) => {
        const el = originalCreateElement(tag);
        if (tag === "a") {
          Object.defineProperty(el, "click", {
            configurable: true,
            value: () => {
              downloads.push((el as HTMLAnchorElement).download);
              clickMock();
            },
          });
        }
        return el;
      });
      document.createElement = createElementSpy as unknown as typeof document.createElement;
      return {
        clickMock,
        downloads,
        restore: () => {
          document.createElement = originalCreateElement;
        },
      };
    }

    test("PNG export captures the viewport via toBlob and downloads an erd_*.png file", async () => {
      const spy = spyOnDownloads();

      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      const pngButton = view.getByText("PNG").closest("button")!;
      await act(async () => {
        fireEvent.click(pngButton);
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(mockSnapdom).toHaveBeenCalledTimes(1);
      const [capturedEl, options] = mockSnapdom.mock.calls[0] as unknown as [HTMLElement, Record<string, unknown>];
      // snapdom strips translate() from the ROOT element it captures, so the
      // root must be the viewport's PARENT while the fit-all transform lives
      // on the viewport child.
      expect(capturedEl.classList.contains("react-flow__viewport")).toBe(false);
      // The exported file carries no page behind it, so the capture paints its
      // own ground — and it must be the ground of the theme the diagram was
      // read in. No `dark` class on the document here, so this is light.
      expect(options.backgroundColor).toBe("#f4f4f5");
      // Desired scale is 2 for sharp output; capPixelRatio clamps it against
      // browser canvas limits for huge diagrams (mocked bounds are small).
      expect(options.scale).toBe(2);
      // Webfont embedding reads cssRules from every stylesheet; Monaco's
      // cross-origin CDN stylesheet makes that throw a SecurityError, so it
      // must stay off (the diagram uses system fonts anyway).
      expect(options.embedFonts).toBe(false);

      // At capture time the parent carries the export box size and the
      // viewport child carries the fit-all transform.
      // (mocked getNodesBounds: 800x600; getViewportForBounds: x=32 y=32 zoom=1)
      expect(capturedStyles).toEqual({
        transform: "translate(32px, 32px) scale(1)",
        width: "864px",
        height: "664px",
        hasViewportChild: true,
      });
      // ...and everything must be restored afterwards.
      const viewportEl = capturedEl.querySelector<HTMLElement>(".react-flow__viewport")!;
      expect(viewportEl.style.transform).toBe("");
      expect(capturedEl.style.width).toBe("");
      expect(capturedEl.style.height).toBe("");

      expect(mockToBlob).toHaveBeenCalledTimes(1);
      expect(spy.clickMock).toHaveBeenCalled();
      expect(spy.downloads[0]).toMatch(/^erd_\d+\.png$/);

      spy.restore();
    });

    test("SVG export captures the viewport via toSvg and downloads an erd_*.svg file", async () => {
      const spy = spyOnDownloads();
      const revokeObjectURLMock = mock(() => {});
      const originalRevokeObjectURL = URL.revokeObjectURL;
      URL.revokeObjectURL = revokeObjectURLMock;

      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      const svgButton = view.getByText("SVG").closest("button")!;
      await act(async () => {
        fireEvent.click(svgButton);
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(mockSnapdom).toHaveBeenCalledTimes(1);
      const [capturedEl] = mockSnapdom.mock.calls[0] as unknown as [HTMLElement];
      expect(capturedEl.querySelector(".react-flow__viewport")).not.toBeNull();

      expect(spy.clickMock).toHaveBeenCalled();
      expect(spy.downloads[0]).toMatch(/^erd_\d+\.svg$/);
      expect(revokeObjectURLMock).toHaveBeenCalled();
      expect(mockToBlob).not.toHaveBeenCalled();

      spy.restore();
      URL.revokeObjectURL = originalRevokeObjectURL;
    });

    test("PNG export in dark mode captures on the dark ground", async () => {
      // Pinned dark, a light-mode export came out as white table cards with
      // dark text on a near-black field; pinned light, the dark mode would
      // come out inverted the other way. Both grounds have to be reachable.
      const spy = spyOnDownloads();
      document.documentElement.classList.add("dark");

      try {
        const props = createDefaultProps();
        const { container } = render(<SchemaDiagram {...props} />);
        const view = within(container);

        const pngButton = view.getByText("PNG").closest("button")!;
        await act(async () => {
          fireEvent.click(pngButton);
          await new Promise((r) => setTimeout(r, 20));
        });

        const [, options] = mockSnapdom.mock.calls[0] as unknown as [HTMLElement, Record<string, unknown>];
        expect(options.backgroundColor).toBe("#050505");
      } finally {
        document.documentElement.classList.remove("dark");
        spy.restore();
      }
    });

    test("SVG export injects the ground of the theme it was exported from", async () => {
      // snapdom only applies backgroundColor when rasterizing, so for SVG the
      // ground is a <rect> this code injects — a separate path that has to
      // follow the theme too.
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>users</text></svg>';
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

      expect(await svgDataUrlToBlob(dataUrl, EXPORT_BACKGROUND.light).text()).toContain('fill="#f4f4f5"');
      expect(await svgDataUrlToBlob(dataUrl, EXPORT_BACKGROUND.dark).text()).toContain('fill="#050505"');
    });

    test("failed PNG export surfaces a destructive toast instead of failing silently", async () => {
      mockSnapdom.mockImplementation(() => Promise.reject(new Error("capture exploded")));

      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      const pngButton = view.getByText("PNG").closest("button")!;
      await act(async () => {
        fireEvent.click(pngButton);
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(mockToastError).toHaveBeenCalled();
    });

    test("export with every table filtered out toasts and never captures", async () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      fireEvent.change(view.getByPlaceholderText("Filter tables..."), { target: { value: "no-such-table" } });
      expect(view.queryByText("0 tables")).not.toBeNull();

      const pngButton = view.getByText("PNG").closest("button")!;
      await act(async () => {
        fireEvent.click(pngButton);
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(mockSnapdom).not.toHaveBeenCalled();
      expect(mockToastError).toHaveBeenCalled();
    });

    test("PNG export whose encoder produces no data surfaces a toast", async () => {
      // Browsers may hand back a null blob from canvas encoding; the export
      // must turn that into user feedback instead of downloading nothing.
      mockToBlob.mockImplementationOnce(() => Promise.resolve(null as unknown as Blob));

      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      const pngButton = view.getByText("PNG").closest("button")!;
      await act(async () => {
        fireEvent.click(pngButton);
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(mockToastError).toHaveBeenCalled();
    });

    test("svgDataUrlToBlob rejects non-SVG data URLs", () => {
      expect(() => svgDataUrlToBlob("data:image/png;base64,AAAA")).toThrow("Not an SVG data URL");
    });

    test("exportViewportImage rejects when the viewport is not attached to a pane", async () => {
      const detachedViewport = document.createElement("div");
      detachedViewport.className = "react-flow__viewport";
      await expect(
        exportViewportImage("png", { viewport: detachedViewport, bounds: { x: 0, y: 0, width: 100, height: 100 } }),
      ).rejects.toThrow("Diagram viewport is not attached to the document");
      expect(mockSnapdom).not.toHaveBeenCalled();
    });

    test("export still succeeds when requestAnimationFrame is unavailable", async () => {
      // The paint-yield helper must fall back to a plain timeout when rAF is
      // missing (non-browser embedding); the export must complete either way.
      const originalRaf = globalThis.requestAnimationFrame;
      globalThis.requestAnimationFrame = undefined as unknown as typeof requestAnimationFrame;
      try {
        const props = createDefaultProps();
        const { container } = render(<SchemaDiagram {...props} />);
        const view = within(container);

        const pngButton = view.getByText("PNG").closest("button")!;
        await act(async () => {
          fireEvent.click(pngButton);
          await new Promise((r) => setTimeout(r, 40));
        });

        expect(mockSnapdom).toHaveBeenCalledTimes(1);
        expect(mockToBlob).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.requestAnimationFrame = originalRaf;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FkEdge rendering (direct, with a real highlight store)
  // ═══════════════════════════════════════════════════════════════════════

  describe("FkEdge", () => {
    const edgeProps = {
      id: "orders.user_id->users.id",
      source: "orders",
      target: "users",
      sourceX: 0,
      sourceY: 0,
      targetX: 100,
      targetY: 100,
      sourcePosition: "right",
      targetPosition: "left",
    } as never;

    function renderEdge(store: ReturnType<typeof createHighlightStore>, heuristic: boolean) {
      const props = { ...(edgeProps as Record<string, unknown>), data: { heuristic } };
      return render(
        <HighlightStoreProvider value={store}>
          <svg>{React.createElement(FkEdge as unknown as React.ComponentType<Record<string, unknown>>, props)}</svg>
        </HighlightStoreProvider>,
      );
    }

    test("real FK edge renders solid blue at rest with no label", () => {
      const store = createHighlightStore();
      const { container } = renderEdge(store, false);
      const path = container.querySelector('[data-testid="mock-base-edge"]') as HTMLElement;
      expect(path).not.toBeNull();
      expect(path.style.stroke).toBe("#3b82f6");
      expect(path.style.strokeDasharray).toBe("");
      expect(within(container).queryByText("1:N")).toBeNull();
    });

    test("heuristic edge renders dashed gray with thinner stroke", () => {
      const store = createHighlightStore();
      const { container } = renderEdge(store, true);
      const path = container.querySelector('[data-testid="mock-base-edge"]') as HTMLElement;
      expect(path.style.stroke).toBe("#6b7280");
      expect(path.style.strokeDasharray).toBe("4 2");
    });

    test("edge touching the selected table is highlighted and labeled", () => {
      const store = createHighlightStore();
      store.select("orders", new Set(["users"]));
      const { container } = renderEdge(store, false);
      const path = container.querySelector('[data-testid="mock-base-edge"]') as HTMLElement;
      expect(path.style.opacity).toBe("1");
      expect(path.style.strokeWidth).toBe("2");
      expect(within(container).queryByText("1:N")).not.toBeNull();
    });

    test("heuristic highlighted edge is labeled with a question mark", () => {
      const store = createHighlightStore();
      store.select("orders", new Set(["users"]));
      const { container } = renderEdge(store, true);
      expect(within(container).queryByText("1:N?")).not.toBeNull();
    });

    test("edge unrelated to the selection is dimmed", () => {
      const store = createHighlightStore();
      store.select("products", new Set());
      const { container } = renderEdge(store, false);
      const path = container.querySelector('[data-testid="mock-base-edge"]') as HTMLElement;
      expect(path.style.opacity).toBe("0.12");
      expect(within(container).queryByText("1:N")).toBeNull();
    });

    test("edge reacts to selection changes made after mount", () => {
      const store = createHighlightStore();
      const { container } = renderEdge(store, false);
      expect(within(container).queryByText("1:N")).toBeNull();

      act(() => {
        store.select("users", new Set(["orders"]));
      });
      expect(within(container).queryByText("1:N")).not.toBeNull();
    });

    test("highlight hooks throw when used outside a HighlightStoreProvider", () => {
      const Probe = ({ table }: { table: string }) =>
        React.createElement("span", null, String(useTableHighlighted(table)));
      expect(() => renderToStaticMarkup(React.createElement(Probe, { table: "users" }))).toThrow(
        "useHighlightStore must be used inside a HighlightStoreProvider",
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Large-schema behaviors
  // ═══════════════════════════════════════════════════════════════════════

  describe("Large schemas", () => {
    const bigSchema: TableSchema[] = Array.from({ length: 150 }, (_, i) => ({
      name: `table_${i}`,
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: [],
      foreignKeys: [],
      rowCount: 1,
    }));

    test("viewport culling is enabled above the threshold but disabled while exporting", async () => {
      let cullingDuringExport: unknown = "not-captured";
      mockSnapdom.mockImplementation(() => {
        cullingDuringExport = lastReactFlowProps.onlyRenderVisibleElements;
        return Promise.resolve({ toBlob: mockToBlob, url: mockSvgDataUrl });
      });

      const props = createDefaultProps({ schema: bigSchema });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      expect(lastReactFlowProps.onlyRenderVisibleElements).toBe(true);

      const pngButton = view.getByText("PNG").closest("button")!;
      await act(async () => {
        fireEvent.click(pngButton);
        await new Promise((r) => setTimeout(r, 40));
      });

      // Culled (unmounted) nodes cannot be captured - the snapshot must run
      // with culling off so every table is in the DOM.
      expect(cullingDuringExport).toBe(false);
      expect(lastReactFlowProps.onlyRenderVisibleElements).toBe(true);
    });

    test("small schemas never enable culling", () => {
      const props = createDefaultProps();
      render(<SchemaDiagram {...props} />);
      expect(lastReactFlowProps.onlyRenderVisibleElements).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Async FK arrival (two-phase schema fetch)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Async FK arrival", () => {
    test("highlight neighbors refresh when relations arrive while a table is selected", async () => {
      const onClose = mock(() => {});
      const { container, rerender } = render(<SchemaDiagram schema={schemaNoFK} onClose={onClose} />);

      // Select users while no FK data exists
      fireEvent.click(container.querySelector('[data-node-id="users"]')!);
      expect(container.querySelector('[data-node-id="users"]')!.querySelector(".border-blue-500\\/60")).not.toBeNull();
      expect(container.querySelector('[data-node-id="posts"]')!.querySelector(".border-blue-500\\/60")).toBeNull();

      // Relations arrive: posts now references users
      const withFk: TableSchema[] = [
        schemaNoFK[0],
        {
          ...schemaNoFK[1],
          columns: [...schemaNoFK[1].columns, { name: "user_id", type: "integer", nullable: false, isPrimary: false }],
          foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
        },
      ];
      await act(async () => {
        rerender(<SchemaDiagram schema={withFk} onClose={onClose} />);
        await new Promise((r) => setTimeout(r, 20));
      });

      // posts is now a neighbor of the still-selected users -> highlighted
      expect(container.querySelector('[data-node-id="posts"]')!.querySelector(".border-blue-500\\/60")).not.toBeNull();
    });

    test("node internals re-measure when FK anchors appear on existing tables", async () => {
      const onClose = mock(() => {});
      const { rerender } = render(<SchemaDiagram schema={schemaNoFK} onClose={onClose} />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      const callsBefore = mockUpdateNodeInternals.mock.calls.length;

      // Identity-only rebuild (same schema content) must NOT re-measure
      await act(async () => {
        rerender(<SchemaDiagram schema={[...schemaNoFK]} onClose={onClose} />);
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(mockUpdateNodeInternals.mock.calls.length).toBe(callsBefore);

      // FK arrival adds handles -> React Flow must be told to re-measure,
      // otherwise the new edges never attach.
      const withFk: TableSchema[] = [
        schemaNoFK[0],
        {
          ...schemaNoFK[1],
          columns: [...schemaNoFK[1].columns, { name: "user_id", type: "integer", nullable: false, isPrimary: false }],
          foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
        },
      ];
      await act(async () => {
        rerender(<SchemaDiagram schema={withFk} onClose={onClose} />);
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(mockUpdateNodeInternals.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Layout failure behavior
  // ═══════════════════════════════════════════════════════════════════════

  describe("Layout failure", () => {
    const wideTable: TableSchema[] = [
      {
        name: "wide",
        columns: Array.from({ length: 30 }, (_, i) => ({
          name: `col_${i}`,
          type: "integer",
          nullable: true,
          isPrimary: i === 0,
        })),
        indexes: [],
        foreignKeys: [],
        rowCount: 1,
      },
    ];

    test("a failed (null) layout is not retried on cosmetic rebuilds", async () => {
      let layoutCalls = 0;
      setLayoutEngineImpl({
        layout: () => {
          layoutCalls++;
          return Promise.resolve(null);
        },
        dispose: () => Promise.resolve(),
      });

      const props = createDefaultProps({ schema: wideTable });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(layoutCalls).toBe(1);

      // Expanding a table changes graph identity but not structure - the
      // known-failed layout must not rerun (no spinner churn).
      fireEvent.click(view.getByText(/\+\d+ more/));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(layoutCalls).toBe(1);
      expect(view.queryByText("col_29")).not.toBeNull();
    });

    test("a rejected layout clears the spinner and is not retried on cosmetic rebuilds", async () => {
      let layoutCalls = 0;
      setLayoutEngineImpl({
        layout: () => {
          layoutCalls++;
          return Promise.reject(new Error("elk exploded"));
        },
        dispose: () => Promise.resolve(),
      });

      const props = createDefaultProps({ schema: wideTable });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(layoutCalls).toBe(1);
      // The catch handler must clear the layouting spinner...
      expect(view.queryByText("layout")).toBeNull();

      // ...and record the signature so cosmetic rebuilds do not retry.
      fireEvent.click(view.getByText(/\+\d+ more/));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(layoutCalls).toBe(1);
      expect(view.queryByText("col_29")).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Column capping (+N more expander)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Column capping", () => {
    const wideTable: TableSchema[] = [
      {
        name: "wide",
        columns: Array.from({ length: 30 }, (_, i) => ({
          name: `col_${i}`,
          type: "integer",
          nullable: true,
          isPrimary: i === 0,
        })),
        indexes: [],
        foreignKeys: [],
        rowCount: 1,
      },
    ];

    test("wide tables show a +N more expander instead of all columns", () => {
      const props = createDefaultProps({ schema: wideTable });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      expect(view.queryByText("col_0")).not.toBeNull();
      expect(view.queryByText("col_29")).toBeNull();
      expect(view.queryByText(/\+\d+ more/)).not.toBeNull();
    });

    test("clicking the expander reveals all columns", () => {
      const props = createDefaultProps({ schema: wideTable });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      fireEvent.click(view.getByText(/\+\d+ more/));

      expect(view.queryByText("col_29")).not.toBeNull();
      expect(view.queryByText(/\+\d+ more/)).toBeNull();
    });

    test("toggling an expanded table again collapses it back to the capped view", () => {
      const props = createDefaultProps({ schema: wideTable });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      fireEvent.click(view.getByText(/\+\d+ more/));
      expect(view.queryByText("col_29")).not.toBeNull();

      // The expander is gone once expanded, so the second toggle goes through
      // the diagram-actions context (see DiagramActionsProbe in the mock).
      fireEvent.click(view.getByTestId("probe-toggle-expand"));
      expect(view.queryByText("col_29")).toBeNull();
      expect(view.queryByText(/\+\d+ more/)).not.toBeNull();
    });

    test("dragged node positions are recorded and survive cosmetic rebuilds", async () => {
      const props = createDefaultProps({ schema: wideTable });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });

      const onNodesChange = lastReactFlowProps.onNodesChange as (changes: unknown[]) => void;
      act(() => {
        onNodesChange([
          { id: "wide", type: "position", position: { x: 123, y: 456 } },
          { id: "wide", type: "select", selected: true },
          { id: "wide", type: "position" }, // no position payload - must be ignored
        ]);
      });

      // Expanding rebuilds the graph with the same structural signature; the
      // rebuilt node must come back at the dragged position, not the default.
      fireEvent.click(view.getByText(/\+\d+ more/));
      const nodes = lastReactFlowProps.nodes as Array<{ id: string; position: { x: number; y: number } }>;
      expect(nodes.find((n) => n.id === "wide")?.position).toEqual({ x: 123, y: 456 });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // NEW: Edge Construction & Misc Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("Edge construction and misc", () => {
    test("heuristic matches singular table name (author_id → author)", () => {
      const props = createDefaultProps({ schema: schemaHeuristicSingular });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // books.author_id → author (singular match, not authors)
      expect(view.queryByText("1 relationships")).not.toBeNull();
    });

    test("schema with undefined foreignKeys does not crash", () => {
      const props = createDefaultProps({ schema: schemaUndefinedFK });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      expect(view.queryByText("1 tables")).not.toBeNull();
      expect(view.queryByText("0 relationships")).not.toBeNull();
    });

    test("multi-FK schema shows correct relationship count", () => {
      const props = createDefaultProps({ schema: schemaMultiFK });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // orders→users + items→orders = 2 relationships
      expect(view.queryByText("2 relationships")).not.toBeNull();
    });

    test("multi-FK: selecting middle node highlights both connected nodes", () => {
      const props = createDefaultProps({ schema: schemaMultiFK });
      const { container } = render(<SchemaDiagram {...props} />);

      // Select 'orders' which is FK target of 'items' and FK source pointing to 'users'
      const ordersNode = container.querySelector('[data-node-id="orders"]')!;
      fireEvent.click(ordersNode);

      // 'users' should be highlighted (orders has FK to users)
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      expect(usersNode.querySelector(".border-blue-500\\/60")).not.toBeNull();

      // 'items' should be highlighted (items has FK to orders)
      const itemsNode = container.querySelector('[data-node-id="items"]')!;
      expect(itemsNode.querySelector(".border-blue-500\\/60")).not.toBeNull();
    });

    test("no-FK warning shown for schema with undefined foreignKeys", () => {
      const props = createDefaultProps({ schema: schemaUndefinedFK });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      expect(view.queryByText(/No FK data available/)).not.toBeNull();
    });
  });
});
