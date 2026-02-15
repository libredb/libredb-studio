import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { mock } from 'bun:test';

// Mock child components to isolate Sidebar logic
mock.module('@/components/sidebar/ConnectionsList', () => ({
  ConnectionsList: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    const connections = props.connections as Array<Record<string, unknown>> | undefined;
    const activeConnection = props.activeConnection as Record<string, unknown> | null | undefined;
    return React.createElement('div', {
      'data-testid': 'connections-list',
      'data-connections-count': String(connections?.length ?? 0),
      'data-active-connection': (activeConnection as Record<string, string>)?.id ?? 'none',
    }, 'ConnectionsList Mock');
  },
}));

mock.module('@/components/schema-explorer', () => ({
  SchemaExplorer: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    const schema = props.schema as Array<unknown> | undefined;
    return React.createElement('div', {
      'data-testid': 'schema-explorer',
      'data-schema-count': String(schema?.length ?? 0),
    }, 'SchemaExplorer Mock');
  },
}));

// Mock radix scroll area to pass through children
mock.module('@radix-ui/react-scroll-area', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');

  const Root = React.forwardRef(({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement('div', { ...props, ref, 'data-slot': 'scroll-area' }, children));
  Root.displayName = 'ScrollAreaRoot';

  const Viewport = React.forwardRef(({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement('div', { ...props, ref, 'data-slot': 'scroll-area-viewport' }, children));
  Viewport.displayName = 'ScrollAreaViewport';

  const ScrollAreaScrollbar = React.forwardRef(({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement('div', { ...props, ref }, children));
  ScrollAreaScrollbar.displayName = 'ScrollAreaScrollbar';

  const ScrollAreaThumb = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement('div', { ...props, ref }));
  ScrollAreaThumb.displayName = 'ScrollAreaThumb';

  const Corner = () => null;
  Corner.displayName = 'Corner';

  return {
    Root,
    Viewport,
    ScrollAreaScrollbar,
    ScrollAreaThumb,
    Corner,
  };
});

import { describe, test, expect, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { Sidebar } from '@/components/sidebar/Sidebar';
import { mockPostgresConnection, mockMySQLConnection } from '../../fixtures/connections';
import { mockSchema } from '../../fixtures/schemas';

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

describe('Sidebar', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders LibreDB Studio header', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<Sidebar {...props} />);

    expect(queryByText('LibreDB Studio')).not.toBeNull();
  });

  test('shows "Add Connection" button (Plus icon)', () => {
    const onAddConnection = mock(() => {});
    const props = createDefaultProps({ onAddConnection });
    const { getAllByRole } = render(<Sidebar {...props} />);

    // The Plus button is in the header
    const buttons = getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  test('SchemaExplorer only renders when activeConnection exists', () => {
    // With active connection
    const propsWithConn = createDefaultProps({ activeConnection: mockPostgresConnection });
    const { unmount, queryByTestId } = render(<Sidebar {...propsWithConn} />);
    expect(queryByTestId('schema-explorer')).not.toBeNull();
    unmount();

    // Without active connection
    const propsNoConn = createDefaultProps({ activeConnection: null });
    const result2 = render(<Sidebar {...propsNoConn} />);
    expect(result2.queryByTestId('schema-explorer')).toBeNull();
  });

  test('ERD button only appears when activeConnection exists', () => {
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

  test('passes correct props to ConnectionsList', () => {
    const connections = [mockPostgresConnection, mockMySQLConnection];
    const props = createDefaultProps({
      connections,
      activeConnection: mockPostgresConnection,
    });
    const { getByTestId } = render(<Sidebar {...props} />);

    const connList = getByTestId('connections-list');
    expect(connList.getAttribute('data-connections-count')).toBe('2');
    expect(connList.getAttribute('data-active-connection')).toBe(mockPostgresConnection.id);
  });

  test('footer shows version info', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<Sidebar {...props} />);

    expect(queryByText('v1.2.5')).not.toBeNull();
  });

  test('footer shows connected status', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<Sidebar {...props} />);

    expect(queryByText('Connected')).not.toBeNull();
  });

  test('clicking ERD button calls onShowDiagram', () => {
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
