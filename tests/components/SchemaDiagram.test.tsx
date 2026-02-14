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

// Mock html2canvas for export
mock.module('html2canvas', () => ({
  default: mock(() => Promise.resolve({
    toDataURL: () => 'data:image/png;base64,mock',
  })),
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, within, cleanup } from '@testing-library/react';
import React from 'react';

import { SchemaDiagram } from '@/components/SchemaDiagram';
import { mockSchema, emptySchema } from '../fixtures/schemas';

// =============================================================================
// SchemaDiagram Tests
// =============================================================================

function createDefaultProps(overrides: Partial<Parameters<typeof SchemaDiagram>[0]> = {}) {
  return {
    schema: mockSchema,
    onClose: mock(() => {}),
    ...overrides,
  };
}

describe('SchemaDiagram', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    // Clear any mocks between tests
  });

  // ── Renders ReactFlow container ───────────────────────────────────────────

  test('renders ReactFlow container', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);

    expect(container.querySelector('[data-testid="mock-react-flow"]')).not.toBeNull();
  });

  // ── Shows top-right panel (close, export buttons) ─────────────────────────

  test('shows top-right panel with buttons', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);

    expect(container.querySelector('[data-testid="mock-panel-top-right"]')).not.toBeNull();
  });

  // ── onClose fires when close button clicked ───────────────────────────────

  test('onClose fires when close button clicked', () => {
    const onClose = mock(() => {});
    const props = createDefaultProps({ onClose });
    const { container } = render(<SchemaDiagram {...props} />);

    // The close button has a rounded-full class
    const closeButton = Array.from(container.querySelectorAll('button')).find(btn =>
      btn.className.includes('rounded-full')
    );
    expect(closeButton).not.toBeNull();

    fireEvent.click(closeButton!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Shows table info from schema ──────────────────────────────────────────

  test('shows table info from schema in ERD panel', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('3 tables')).not.toBeNull();
    expect(view.queryByText('ERD Visualizer')).not.toBeNull();
  });

  // ── Export buttons present ────────────────────────────────────────────────

  test('export buttons present (PNG, SVG)', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('PNG')).not.toBeNull();
    expect(view.queryByText('SVG')).not.toBeNull();
  });

  // ── Search input present ──────────────────────────────────────────────────

  test('search input present', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByPlaceholderText('Filter tables...')).not.toBeNull();
  });

  // ── Compact mode toggle present ───────────────────────────────────────────

  test('compact mode toggle present', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('Compact')).not.toBeNull();
  });

  // ── Empty schema shows loading state ──────────────────────────────────────

  test('empty schema shows loading/generating state', () => {
    const props = createDefaultProps({ schema: emptySchema });
    const { container } = render(<SchemaDiagram {...props} />);
    const view = within(container);

    expect(view.queryByText('Generating ERD Diagram...')).not.toBeNull();
  });
});
