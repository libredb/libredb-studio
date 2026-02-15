import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';
import { setupXYFlowMock, setupFramerMotionMock } from '../helpers/mock-monaco';

// Setup mocks before component imports
setupXYFlowMock();
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
import { render, fireEvent, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  test('search filters tables and updates count', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // Initially 3 tables
    expect(view.queryByText('3 tables')).not.toBeNull();

    const searchInput = view.getByPlaceholderText('Filter tables...');
    await user.type(searchInput, 'users');

    // After filtering, only 1 table matches
    expect(view.queryByText('1 tables')).not.toBeNull();
    expect(view.queryByText('3 tables')).toBeNull();
  });

  test('search is case-insensitive', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Filter tables...');
    await user.type(searchInput, 'ORDERS');

    expect(view.queryByText('1 tables')).not.toBeNull();
  });

  test('search with no matches shows 0 tables', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Filter tables...');
    await user.type(searchInput, 'nonexistent');

    expect(view.queryByText('0 tables')).not.toBeNull();
  });

  test('clearing search restores all tables', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Filter tables...');

    // Type to filter
    await user.type(searchInput, 'users');
    expect(view.queryByText('1 tables')).not.toBeNull();

    // Select all and delete to clear
    await user.tripleClick(searchInput);
    await user.keyboard('{Backspace}');
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

  test('filtering to table with FK shows its relationships', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    // Search for "orders" — has FK to users, but users is filtered out
    const searchInput = view.getByPlaceholderText('Filter tables...');
    await user.type(searchInput, 'orders');

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
});
