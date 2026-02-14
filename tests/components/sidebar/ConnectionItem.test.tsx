import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { mock } from 'bun:test';

// Mock framer-motion with proper React elements (not plain objects)
mock.module('framer-motion', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  const handler = {
    get(_target: unknown, prop: string) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const MotionComponent = React.forwardRef(({ children, initial, animate, exit, variants, whileHover, whileTap, layoutId, transition, ...rest }: Record<string, unknown>, ref: React.Ref<HTMLElement>) => {
        return React.createElement(prop, { ...rest, ref }, children);
      });
      MotionComponent.displayName = `Motion${prop}`;
      return MotionComponent;
    }
  };
  const MockAnimatePresence = ({ children }: Record<string, unknown>) => children;
  MockAnimatePresence.displayName = 'AnimatePresence';
  return {
    motion: new Proxy({}, handler),
    AnimatePresence: MockAnimatePresence,
    useAnimation: () => ({ start: mock(() => {}), stop: mock(() => {}) }),
    useInView: () => true,
  };
});

// Mock db-ui-config
mock.module('@/lib/db-ui-config', () => ({
  getDBIcon: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    const MockDBIcon = (props: Record<string, unknown>) => React.createElement('span', { ...props, 'data-testid': 'db-icon' });
    MockDBIcon.displayName = 'MockDBIcon';
    return MockDBIcon;
  },
  getDBConfig: () => ({ icon: () => null, color: 'text-blue-400', label: 'PostgreSQL', defaultPort: '5432' }),
  getDBColor: () => 'text-blue-400',
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { ConnectionItem } from '@/components/sidebar/ConnectionItem';
import { mockPostgresConnection } from '../../fixtures/connections';

// =============================================================================
// ConnectionItem Tests
// =============================================================================

describe('ConnectionItem', () => {
  const defaultOnSelect = mock(() => {});
  const defaultOnDelete = mock(() => {});
  const defaultOnEdit = mock(() => {});

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    defaultOnSelect.mockClear();
    defaultOnDelete.mockClear();
    defaultOnEdit.mockClear();
  });

  test('renders connection name', () => {
    const { queryByText } = render(
      <ConnectionItem
        connection={mockPostgresConnection}
        isActive={false}
        onSelect={defaultOnSelect}
        onDelete={defaultOnDelete}
      />
    );

    expect(queryByText('Test PostgreSQL')).not.toBeNull();
  });

  test('shows environment badge for non-other environments', () => {
    // mockPostgresConnection has environment: 'development' => ENVIRONMENT_LABELS['development'] = 'DEV'
    const { queryByText } = render(
      <ConnectionItem
        connection={mockPostgresConnection}
        isActive={false}
        onSelect={defaultOnSelect}
        onDelete={defaultOnDelete}
      />
    );

    expect(queryByText('DEV')).not.toBeNull();
  });

  test('does not show environment badge for "other" environment', () => {
    const otherConn = {
      ...mockPostgresConnection,
      id: 'other-conn',
      environment: 'other' as const,
    };

    const { queryByText } = render(
      <ConnectionItem
        connection={otherConn}
        isActive={false}
        onSelect={defaultOnSelect}
        onDelete={defaultOnDelete}
      />
    );

    // environment === 'other' is checked and badge won't render
    expect(queryByText('PROD')).toBeNull();
    expect(queryByText('DEV')).toBeNull();
    expect(queryByText('STAGING')).toBeNull();
    expect(queryByText('LOCAL')).toBeNull();
  });

  test('active state applies correct styling classes', () => {
    const { container } = render(
      <ConnectionItem
        connection={mockPostgresConnection}
        isActive={true}
        onSelect={defaultOnSelect}
        onDelete={defaultOnDelete}
      />
    );

    // The active connection's outer div should contain the active class
    const connectionDiv = container.firstElementChild;
    expect(connectionDiv).not.toBeNull();
    const className = connectionDiv?.className || '';
    expect(className.includes('bg-blue-600/10')).toBe(true);
  });

  test('onSelect fires on click', () => {
    const { container } = render(
      <ConnectionItem
        connection={mockPostgresConnection}
        isActive={false}
        onSelect={defaultOnSelect}
        onDelete={defaultOnDelete}
      />
    );

    // Click the outermost connection element (first child of container)
    const connectionEl = container.firstElementChild!;
    fireEvent.click(connectionEl);

    expect(defaultOnSelect).toHaveBeenCalledTimes(1);
    expect(defaultOnSelect).toHaveBeenCalledWith(mockPostgresConnection);
  });

  test('onEdit fires on edit button click with stopPropagation', () => {
    const { container } = render(
      <ConnectionItem
        connection={mockPostgresConnection}
        isActive={false}
        onSelect={defaultOnSelect}
        onDelete={defaultOnDelete}
        onEdit={defaultOnEdit}
      />
    );

    // Find buttons within this component's container
    const buttons = container.querySelectorAll('button');
    // First button is edit (Pencil), second is delete (Trash2)
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    const editButton = buttons[0];
    fireEvent.click(editButton);

    expect(defaultOnEdit).toHaveBeenCalledTimes(1);
    expect(defaultOnEdit).toHaveBeenCalledWith(mockPostgresConnection);
    // onSelect should NOT have been called (stopPropagation)
    expect(defaultOnSelect).toHaveBeenCalledTimes(0);
  });

  test('onDelete fires on delete button click with stopPropagation', () => {
    const { container } = render(
      <ConnectionItem
        connection={mockPostgresConnection}
        isActive={false}
        onSelect={defaultOnSelect}
        onDelete={defaultOnDelete}
        onEdit={defaultOnEdit}
      />
    );

    const buttons = container.querySelectorAll('button');
    // Second button is delete (Trash2)
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    const deleteButton = buttons[1];
    fireEvent.click(deleteButton);

    expect(defaultOnDelete).toHaveBeenCalledTimes(1);
    expect(defaultOnDelete).toHaveBeenCalledWith(mockPostgresConnection.id);
    // onSelect should NOT have been called (stopPropagation)
    expect(defaultOnSelect).toHaveBeenCalledTimes(0);
  });
});
