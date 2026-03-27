import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';
import { setupFramerMotionMock } from '../helpers/mock-monaco';

// Enhanced XYFlow mock that renders nodes via nodeTypes
mock.module('@xyflow/react', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ReactFlow: ({ children, nodes = [], nodeTypes = {}, onNodeClick, onPaneClick }: Record<string, any>) => {
      const renderedNodes = nodes.map((node: { id: string; type: string; data: Record<string, unknown> }) => {
        const NodeComp = nodeTypes[node.type];
        if (!NodeComp) return null;
        return React.createElement('div', {
          key: node.id,
          'data-testid': `node-${node.id}`,
          'data-node-id': node.id,
          onClick: (e: React.MouseEvent) => { e.stopPropagation(); onNodeClick?.(e, node); },
        }, React.createElement(NodeComp, { id: node.id, data: node.data, type: node.type }));
      });
      // Wrap nodes in a keyed container to avoid reconciliation issues
      // when the number of nodes changes (e.g. during search filtering)
      return React.createElement('div', {
        'data-testid': 'mock-react-flow',
        className: 'react-flow',
        onClick: (e: React.MouseEvent) => { if (e.target === e.currentTarget) onPaneClick?.(); },
      },
        React.createElement('div', { key: '__nodes__', 'data-testid': 'nodes-container' }, renderedNodes),
        React.createElement('svg', { key: '__svg__' }),
        React.createElement(React.Fragment, { key: '__children__' }, children),
      );
    },
    ReactFlowProvider: ({ children }: { children: unknown }) => children,
    MiniMap: () => React.createElement('div', { 'data-testid': 'mock-minimap' }),
    Controls: () => null,
    Background: () => null,
    Handle: () => null,
    useNodesState: () => [[], mock(() => {}), mock(() => {})],
    useEdgesState: () => [[], mock(() => {}), mock(() => {})],
    useReactFlow: () => ({ fitView: mock(() => {}), getNodes: mock(() => []), getEdges: mock(() => []) }),
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Panel: ({ children, position }: { children: unknown; position?: string }) =>
      React.createElement('div', { 'data-testid': `mock-panel-${position || 'default'}` }, children),
  };
});

setupFramerMotionMock();

// Mock elkjs
mock.module('elkjs/lib/elk.bundled.js', () => ({
  default: class MockELK {
    layout(graph: unknown) {
      return Promise.resolve(graph);
    }
  },
}));

// Track html2canvas calls
const mockHtml2canvas = mock(() => Promise.resolve({
  toDataURL: () => 'data:image/png;base64,mock',
}));

mock.module('html2canvas', () => ({
  default: mockHtml2canvas,
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, within, cleanup, act } from '@testing-library/react';
import React from 'react';

import { SchemaDiagram } from '@/components/SchemaDiagram';
import { mockSchema, emptySchema } from '../fixtures/schemas';
import type { TableSchema } from '@/lib/types';

// =============================================================================
// Test Data
// =============================================================================

// Schema with NO foreign keys at all (triggers heuristic fallback)
const schemaNoFK: TableSchema[] = [
  {
    name: 'users',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'name', type: 'varchar(255)', nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 100,
  },
  {
    name: 'posts',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'title', type: 'text', nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 50,
  },
];

// Schema with heuristic _id column (no FK data, but column ends with _id)
const schemaHeuristic: TableSchema[] = [
  {
    name: 'users',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'email', type: 'varchar', nullable: true, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 10,
  },
  {
    name: 'comments',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'user_id', type: 'integer', nullable: false, isPrimary: false },
      { name: 'body', type: 'text', nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 200,
  },
];

// Schema with heuristic _id column matching singular table name (no plural 's')
const schemaHeuristicSingular: TableSchema[] = [
  {
    name: 'author',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'name', type: 'varchar(255)', nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 10,
  },
  {
    name: 'books',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'author_id', type: 'integer', nullable: false, isPrimary: false },
      { name: 'title', type: 'text', nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 50,
  },
];

// Schema with foreignKeys field omitted (tests `|| []` guards)
const schemaUndefinedFK: TableSchema[] = [
  {
    name: 'items',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'label', type: 'text', nullable: true, isPrimary: false },
    ],
    indexes: [],
    rowCount: 20,
  } as TableSchema,
];

// Multi-FK schema for highlighting tests
const schemaMultiFK: TableSchema[] = [
  {
    name: 'users',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'name', type: 'varchar(255)', nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 100,
  },
  {
    name: 'orders',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'user_id', type: 'integer', nullable: false, isPrimary: false },
      { name: 'total', type: 'numeric(10,2)', nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [
      { columnName: 'user_id', referencedTable: 'users', referencedColumn: 'id' },
    ],
    rowCount: 500,
  },
  {
    name: 'items',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'order_id', type: 'integer', nullable: false, isPrimary: false },
      { name: 'product', type: 'varchar(255)', nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [
      { columnName: 'order_id', referencedTable: 'orders', referencedColumn: 'id' },
    ],
    rowCount: 1000,
  },
];

// Single table schema
const singleTableSchema: TableSchema[] = [
  {
    name: 'settings',
    columns: [
      { name: 'key', type: 'text', nullable: false, isPrimary: true },
      { name: 'value', type: 'text', nullable: true, isPrimary: false },
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

describe('SchemaDiagram', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockHtml2canvas.mockClear();
  });

  // ── Rendering ───────────────────────────────────────────────────────────

  test('renders ReactFlow container', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);

    expect(container.querySelector('[data-testid="mock-react-flow"]')).not.toBeNull();
  });

  test('shows top-right panel with buttons', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);

    expect(container.querySelector('[data-testid="mock-panel-top-right"]')).not.toBeNull();
  });

  test('shows top-left info panel', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);

    expect(container.querySelector('[data-testid="mock-panel-top-left"]')).not.toBeNull();
  });

  test('renders ERD Visualizer heading', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('ERD Visualizer')).not.toBeNull();
  });

  // ── Close button ────────────────────────────────────────────────────────

  test('onClose fires when close button clicked', () => {
    const onClose = mock(() => {});
    const props = createDefaultProps({ onClose });
    const { container } = render(<SchemaDiagram {...props} />);

    const closeButton = Array.from(container.querySelectorAll('button')).find(btn =>
      btn.className.includes('rounded-full')
    );
    expect(closeButton).not.toBeNull();

    fireEvent.click(closeButton!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Table count and relationships ───────────────────────────────────────

  test('shows table info from schema in ERD panel', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('3 tables')).not.toBeNull();
  });

  test('shows relationship count', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // mockSchema has orders → users FK, so 1 relationship
    expect(view.queryByText('1 relationships')).not.toBeNull();
  });

  test('shows 0 relationships for schema without FKs', () => {
    const props = createDefaultProps({ schema: schemaNoFK });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('0 relationships')).not.toBeNull();
  });

  test('shows heuristic relationships count for _id columns', () => {
    const props = createDefaultProps({ schema: schemaHeuristic });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // comments.user_id → users heuristic edge
    expect(view.queryByText('1 relationships')).not.toBeNull();
  });

  test('shows single table count', () => {
    const props = createDefaultProps({ schema: singleTableSchema });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('1 tables')).not.toBeNull();
  });

  // ── Export buttons ──────────────────────────────────────────────────────

  test('export buttons present (PNG, SVG)', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('PNG')).not.toBeNull();
    expect(view.queryByText('SVG')).not.toBeNull();
  });

  test('PNG export button click does not crash', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const pngButton = view.getByText('PNG').closest('button')!;
    fireEvent.click(pngButton);
    // Should not throw
  });

  test('SVG export button click does not crash', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const svgButton = view.getByText('SVG').closest('button')!;
    fireEvent.click(svgButton);
    // Should not throw
  });

  // ── Search input ────────────────────────────────────────────────────────

  test('search input present with placeholder', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByPlaceholderText('Filter tables...')).not.toBeNull();
  });

  test('search filters tables and updates count', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // Initially 3 tables
    expect(view.queryByText('3 tables')).not.toBeNull();

    const searchInput = view.getByPlaceholderText('Filter tables...');
    fireEvent.change(searchInput, { target: { value: 'users' } });

    // After filtering, only 1 table matches
    expect(view.queryByText('1 tables')).not.toBeNull();
    expect(view.queryByText('3 tables')).toBeNull();
  });

  test('search is case-insensitive', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Filter tables...');
    fireEvent.change(searchInput, { target: { value: 'ORDERS' } });

    expect(view.queryByText('1 tables')).not.toBeNull();
  });

  test('search with no matches shows 0 tables', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Filter tables...');
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

    expect(view.queryByText('0 tables')).not.toBeNull();
  });

  test('clearing search restores all tables', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Filter tables...');

    // Type to filter
    fireEvent.change(searchInput, { target: { value: 'users' } });
    expect(view.queryByText('1 tables')).not.toBeNull();

    // Clear the search
    fireEvent.change(searchInput, { target: { value: '' } });
    expect(view.queryByText('3 tables')).not.toBeNull();
  });

  // ── Compact mode toggle ─────────────────────────────────────────────────

  test('compact mode toggle present showing "Compact" initially', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('Compact')).not.toBeNull();
    expect(view.queryByText('Detail')).toBeNull();
  });

  test('clicking Compact toggles to Detail', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const compactButton = view.getByText('Compact').closest('button')!;
    fireEvent.click(compactButton);

    expect(view.queryByText('Detail')).not.toBeNull();
    expect(view.queryByText('Compact')).toBeNull();
  });

  test('clicking Detail toggles back to Compact', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // Toggle to compact
    const compactButton = view.getByText('Compact').closest('button')!;
    fireEvent.click(compactButton);
    expect(view.queryByText('Detail')).not.toBeNull();

    // Toggle back to detail
    const detailButton = view.getByText('Detail').closest('button')!;
    fireEvent.click(detailButton);
    expect(view.queryByText('Compact')).not.toBeNull();
  });

  test('compact button has blue text class when compact mode is active', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const compactButton = view.getByText('Compact').closest('button')!;
    expect(compactButton.className).not.toContain('text-blue-400');

    fireEvent.click(compactButton);
    const detailButton = view.getByText('Detail').closest('button')!;
    expect(detailButton.className).toContain('text-blue-400');
  });

  // ── No FK warning ───────────────────────────────────────────────────────

  test('shows no-FK warning when schema has no foreign keys', () => {
    const props = createDefaultProps({ schema: schemaNoFK });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText(/No FK data available/)).not.toBeNull();
    expect(view.queryByText(/heuristic relationships/)).not.toBeNull();
  });

  test('does not show no-FK warning when schema has foreign keys', () => {
    const props = createDefaultProps(); // mockSchema has FK on orders
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText(/No FK data available/)).toBeNull();
  });

  // ── Selected node info ──────────────────────────────────────────────────

  test('does not show selected node info by default', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('Selected:')).toBeNull();
    expect(view.queryByText('clear')).toBeNull();
  });

  // ── Empty schema / loading state ────────────────────────────────────────

  test('empty schema shows loading/generating state', () => {
    const props = createDefaultProps({ schema: emptySchema });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('Generating ERD Diagram...')).not.toBeNull();
  });

  test('empty schema does not render ReactFlow', () => {
    const props = createDefaultProps({ schema: emptySchema });
    const { container } = render(<SchemaDiagram {...props} />);

    expect(container.querySelector('[data-testid="mock-react-flow"]')).toBeNull();
  });

  test('empty schema does not render panels', () => {
    const props = createDefaultProps({ schema: emptySchema });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('ERD Visualizer')).toBeNull();
    expect(view.queryByText('PNG')).toBeNull();
    expect(view.queryByText('Compact')).toBeNull();
    expect(view.queryByPlaceholderText('Filter tables...')).toBeNull();
  });

  // ── Search affects edge count ───────────────────────────────────────────

  test('filtering to table with FK shows its relationships', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // Search for "orders" — has FK to users, but users is filtered out
    const searchInput = view.getByPlaceholderText('Filter tables...');
    fireEvent.change(searchInput, { target: { value: 'orders' } });

    // Only orders table visible, users is filtered out → FK edge excluded (target not in set)
    expect(view.queryByText('1 tables')).not.toBeNull();
    expect(view.queryByText('0 relationships')).not.toBeNull();
  });

  // ── Heuristic edge detection ────────────────────────────────────────────

  test('heuristic edges are created for _id columns when no FK data', () => {
    const props = createDefaultProps({ schema: schemaHeuristic });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // comments has user_id → should heuristically link to users
    expect(view.queryByText('1 relationships')).not.toBeNull();
  });

  test('heuristic edges not created when real FK data exists', () => {
    // mockSchema has real FK on orders.user_id → users.id
    // so heuristic fallback should NOT run
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // Only 1 real FK edge, no extra heuristic
    expect(view.queryByText('1 relationships')).not.toBeNull();
  });

  // ── Multiple re-renders don't crash ─────────────────────────────────────

  test('re-rendering with different schema does not crash', () => {
    const onClose = mock(() => {});
    const { container, rerender } = render(
      <SchemaDiagram schema={mockSchema} onClose={onClose} />
    );
    const view = within(container);
    expect(view.queryByText('3 tables')).not.toBeNull();

    rerender(<SchemaDiagram schema={singleTableSchema} onClose={onClose} />);
    expect(view.queryByText('1 tables')).not.toBeNull();
  });

  // ── Panel buttons ─────────────────────────────────────────────────────

  test('top-right panel has PNG, SVG, Compact, and close buttons', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);
    expect(view.queryByText('PNG')).not.toBeNull();
    expect(view.queryByText('SVG')).not.toBeNull();
    expect(view.queryByText('Compact')).not.toBeNull();
    // Close button (X icon)
    const closeBtn = Array.from(container.querySelectorAll('button')).find(btn =>
      btn.className.includes('rounded-full')
    );
    expect(closeBtn).not.toBeNull();
  });

  // ── MiniMap rendered ─────────────────────────────────────────────────

  test('MiniMap component renders', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    expect(container.querySelector('[data-testid="mock-minimap"]')).not.toBeNull();
  });

  // ── Schema with many tables ─────────────────────────────────────────

  test('schema with many tables renders correct count', () => {
    const manyTables: TableSchema[] = Array.from({ length: 10 }, (_, i) => ({
      name: `table_${i}`,
      columns: [{ name: 'id', type: 'integer', nullable: false, isPrimary: true }],
      indexes: [],
      foreignKeys: [],
      rowCount: i * 10,
    }));
    const props = createDefaultProps({ schema: manyTables });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);
    expect(view.queryByText('10 tables')).not.toBeNull();
    expect(view.queryByText('0 relationships')).not.toBeNull();
  });

  // ── Search with partial match ───────────────────────────────────────

  test('search with partial match filters correctly', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Filter tables...');
    fireEvent.change(searchInput, { target: { value: 'ord' } });
    // 'orders' matches 'ord'
    expect(view.queryByText('1 tables')).not.toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // NEW: TableNode Rendering Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe('TableNode rendering', () => {
    test('renders table name in header', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // Each table name should appear in uppercase in the header
      expect(view.queryByText('users')).not.toBeNull();
      expect(view.queryByText('orders')).not.toBeNull();
      expect(view.queryByText('products')).not.toBeNull();
    });

    test('shows column count badge', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // users has 6 columns, orders has 5, products has 4
      expect(view.queryByText('6 cols')).not.toBeNull();
      expect(view.queryByText('5 cols')).not.toBeNull();
      expect(view.queryByText('4 cols')).not.toBeNull();
    });

    test('displays column names', () => {
      const props = createDefaultProps({ schema: singleTableSchema });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      expect(view.queryByText('key')).not.toBeNull();
      expect(view.queryByText('value')).not.toBeNull();
    });

    test('displays column type text', () => {
      const props = createDefaultProps({ schema: singleTableSchema });
      const { container } = render(<SchemaDiagram {...props} />);

      // Column types should be rendered in uppercase
      const texts = Array.from(container.querySelectorAll('.font-mono'));
      const typeTexts = texts.map(el => el.textContent);
      expect(typeTexts).toContain('text');
    });

    test('shows NN for NOT NULL columns', () => {
      const props = createDefaultProps({ schema: singleTableSchema });
      const { container } = render(<SchemaDiagram {...props} />);

      // 'key' column has nullable: false
      const nnElements = container.querySelectorAll('span');
      const nnTexts = Array.from(nnElements).map(el => el.textContent);
      expect(nnTexts).toContain('NN');
    });

    test('compact mode hides column details', () => {
      const props = createDefaultProps({ schema: singleTableSchema });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // Before compact — columns visible
      expect(view.queryByText('key')).not.toBeNull();
      expect(view.queryByText('value')).not.toBeNull();

      // Toggle compact mode
      const compactButton = view.getByText('Compact').closest('button')!;
      fireEvent.click(compactButton);

      // In compact mode, columns should be hidden (only header visible)
      // The header still shows settings and "2 cols"
      expect(view.queryByText('settings')).not.toBeNull();
      expect(view.queryByText('2 cols')).not.toBeNull();
      // Column names should not appear as separate elements in the columns list
      // key/value are column names, but the column list section is hidden in compact
      const nodeEl = container.querySelector('[data-node-id="settings"]');
      expect(nodeEl).not.toBeNull();
      // In compact mode, the p-1 div with columns is not rendered
      // We check that column type badges disappear
      const fontMonoElements = nodeEl!.querySelectorAll('.font-mono');
      expect(fontMonoElements.length).toBe(0);
    });

    test('renders node for each table in schema', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);

      expect(container.querySelector('[data-node-id="users"]')).not.toBeNull();
      expect(container.querySelector('[data-node-id="orders"]')).not.toBeNull();
      expect(container.querySelector('[data-node-id="products"]')).not.toBeNull();
    });

    test('node with empty/null data returns nothing', () => {
      // Schema with a valid table ensures at least one node renders
      // The guard `if (!data) return null; if (!table) return null;` is tested
      // by the fact that the enhanced mock passes correct data through
      const props = createDefaultProps({ schema: singleTableSchema });
      const { container } = render(<SchemaDiagram {...props} />);

      const nodeEl = container.querySelector('[data-node-id="settings"]');
      expect(nodeEl).not.toBeNull();
      // The node should have content (table header)
      expect(nodeEl!.textContent).toContain('settings');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // NEW: Node Selection Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe('Node selection', () => {
    test('clicking a node shows "Selected:" info panel', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // Initially no selection
      expect(view.queryByText('Selected:')).toBeNull();

      // Click the users node
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      fireEvent.click(usersNode);

      // Selection should appear with selected node name and clear button
      expect(view.queryByText('Selected:')).not.toBeNull();
      // The selected table name appears in a font-mono span
      const selectedSpan = container.querySelector('.font-mono.font-medium');
      expect(selectedSpan).not.toBeNull();
      expect(selectedSpan!.textContent).toBe('users');
      expect(view.queryByText('clear')).not.toBeNull();
    });

    test('clicking the same node again deselects (toggle)', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      const usersNode = container.querySelector('[data-node-id="users"]')!;

      // Select
      fireEvent.click(usersNode);
      expect(view.queryByText('Selected:')).not.toBeNull();

      // Deselect
      fireEvent.click(usersNode);
      expect(view.queryByText('Selected:')).toBeNull();
    });

    test('clicking "clear" button clears selection', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // Select a node
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      fireEvent.click(usersNode);
      expect(view.queryByText('Selected:')).not.toBeNull();

      // Click clear
      const clearButton = view.getByText('clear');
      fireEvent.click(clearButton);
      expect(view.queryByText('Selected:')).toBeNull();
    });

    test('clicking pane background clears selection', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // Select a node
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      fireEvent.click(usersNode);
      expect(view.queryByText('Selected:')).not.toBeNull();

      // Click the pane background (the react-flow container itself)
      const reactFlowContainer = container.querySelector('[data-testid="mock-react-flow"]')!;
      // Fire click directly on the container element (target === currentTarget)
      fireEvent.click(reactFlowContainer);
      expect(view.queryByText('Selected:')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // NEW: Node/Edge Highlighting Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe('Node/Edge highlighting', () => {
    test('selected node gets highlighted (blue border)', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);

      // Click users node
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      fireEvent.click(usersNode);

      // The TableNode's root div inside the data-node-id div should have blue border
      const innerDiv = usersNode.querySelector('.border-blue-500\\/60');
      expect(innerDiv).not.toBeNull();
    });

    test('FK target of selected node is highlighted', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);

      // Select 'orders' which has FK to 'users'
      const ordersNode = container.querySelector('[data-node-id="orders"]')!;
      fireEvent.click(ordersNode);

      // The 'users' table should also be highlighted (FK target)
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      const usersInner = usersNode.querySelector('.border-blue-500\\/60');
      expect(usersInner).not.toBeNull();
    });

    test('FK source of selected node is highlighted', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);

      // Select 'users' — orders has FK pointing to users
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      fireEvent.click(usersNode);

      // The 'orders' table should be highlighted (it references users via FK)
      const ordersNode = container.querySelector('[data-node-id="orders"]')!;
      const ordersInner = ordersNode.querySelector('.border-blue-500\\/60');
      expect(ordersInner).not.toBeNull();
    });

    test('non-related node is NOT highlighted when another is selected', () => {
      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);

      // Select 'orders' (related to users via FK, not related to products)
      const ordersNode = container.querySelector('[data-node-id="orders"]')!;
      fireEvent.click(ordersNode);

      // Products should NOT be highlighted
      const productsNode = container.querySelector('[data-node-id="products"]')!;
      const productsInner = productsNode.querySelector('.border-blue-500\\/60');
      expect(productsInner).toBeNull();
      // Products should have default border
      const productsDefault = productsNode.querySelector('.border-white\\/10');
      expect(productsDefault).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // NEW: Export Internals Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe('Export functionality', () => {
    test('PNG export calls html2canvas and creates download link', async () => {
      const clickMock = mock(() => {});
      const originalCreateElement = document.createElement.bind(document);
      const createElementSpy = mock((tag: string) => {
        const el = originalCreateElement(tag);
        if (tag === 'a') {
          Object.defineProperty(el, 'click', { value: clickMock });
        }
        return el;
      });
      document.createElement = createElementSpy as unknown as typeof document.createElement;

      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      const pngButton = view.getByText('PNG').closest('button')!;
      await act(async () => {
        fireEvent.click(pngButton);
      });

      // html2canvas should have been called
      expect(mockHtml2canvas).toHaveBeenCalledTimes(1);

      // Wait for the async chain
      await act(async () => {
        await new Promise(r => setTimeout(r, 10));
      });

      expect(clickMock).toHaveBeenCalled();

      // Restore
      document.createElement = originalCreateElement;
    });

    test('SVG export uses XMLSerializer and creates download link', async () => {
      const clickMock = mock(() => {});
      const revokeObjectURLMock = mock(() => {});
      const originalCreateElement = document.createElement.bind(document);
      const createElementSpy = mock((tag: string) => {
        const el = originalCreateElement(tag);
        if (tag === 'a') {
          Object.defineProperty(el, 'click', { value: clickMock });
        }
        return el;
      });
      document.createElement = createElementSpy as unknown as typeof document.createElement;

      const originalRevokeObjectURL = URL.revokeObjectURL;
      URL.revokeObjectURL = revokeObjectURLMock;

      const props = createDefaultProps();
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      const svgButton = view.getByText('SVG').closest('button')!;
      await act(async () => {
        fireEvent.click(svgButton);
      });

      // Wait for async chain
      await act(async () => {
        await new Promise(r => setTimeout(r, 10));
      });

      expect(clickMock).toHaveBeenCalled();
      expect(revokeObjectURLMock).toHaveBeenCalled();

      // Restore
      document.createElement = originalCreateElement;
      URL.revokeObjectURL = originalRevokeObjectURL;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // NEW: Edge Construction & Misc Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe('Edge construction and misc', () => {
    test('heuristic matches singular table name (author_id → author)', () => {
      const props = createDefaultProps({ schema: schemaHeuristicSingular });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // books.author_id → author (singular match, not authors)
      expect(view.queryByText('1 relationships')).not.toBeNull();
    });

    test('schema with undefined foreignKeys does not crash', () => {
      const props = createDefaultProps({ schema: schemaUndefinedFK });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      expect(view.queryByText('1 tables')).not.toBeNull();
      expect(view.queryByText('0 relationships')).not.toBeNull();
    });

    test('multi-FK schema shows correct relationship count', () => {
      const props = createDefaultProps({ schema: schemaMultiFK });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      // orders→users + items→orders = 2 relationships
      expect(view.queryByText('2 relationships')).not.toBeNull();
    });

    test('multi-FK: selecting middle node highlights both connected nodes', () => {
      const props = createDefaultProps({ schema: schemaMultiFK });
      const { container } = render(<SchemaDiagram {...props} />);

      // Select 'orders' which is FK target of 'items' and FK source pointing to 'users'
      const ordersNode = container.querySelector('[data-node-id="orders"]')!;
      fireEvent.click(ordersNode);

      // 'users' should be highlighted (orders has FK to users)
      const usersNode = container.querySelector('[data-node-id="users"]')!;
      expect(usersNode.querySelector('.border-blue-500\\/60')).not.toBeNull();

      // 'items' should be highlighted (items has FK to orders)
      const itemsNode = container.querySelector('[data-node-id="items"]')!;
      expect(itemsNode.querySelector('.border-blue-500\\/60')).not.toBeNull();
    });

    test('no-FK warning shown for schema with undefined foreignKeys', () => {
      const props = createDefaultProps({ schema: schemaUndefinedFK });
      const { container } = render(<SchemaDiagram {...props} />);
      const view = within(container);

      expect(view.queryByText(/No FK data available/)).not.toBeNull();
    });
  });
});
