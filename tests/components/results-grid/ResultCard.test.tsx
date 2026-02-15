import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ResultCard } from '@/components/results-grid/ResultCard';

mock.module('@/lib/data-masking', () => ({
  maskValueByPattern: (value: unknown) => {
    void value;
    return '***MASKED***';
  },
}));

describe('results-grid/ResultCard', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders primary, id and preview fields', () => {
    const onSelect = mock(() => {});
    const row = {
      id: 42,
      name: 'Alice',
      email: 'alice@example.com',
      status: 'active',
      role: 'admin',
      city: 'Istanbul',
      country: 'TR',
      phone: '+900000',
    };
    const fields = ['id', 'name', 'email', 'status', 'role', 'city', 'country', 'phone'];
    const { queryByText } = render(
      <ResultCard
        row={row}
        fields={fields}
        primaryColumn="name"
        idColumn="id"
        index={0}
        onSelect={onSelect}
      />
    );

    expect(queryByText('Alice')).not.toBeNull();
    expect(queryByText('#42')).not.toBeNull();
    expect(queryByText('email')).not.toBeNull();
    expect(queryByText('status')).not.toBeNull();
    expect(queryByText('role')).not.toBeNull();
    expect(queryByText('city')).not.toBeNull();
    expect(queryByText('+2 more fields')).not.toBeNull();
  });

  test('calls onSelect when card is clicked', () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <ResultCard
        row={{ id: 1, name: 'Bob' }}
        fields={['id', 'name']}
        primaryColumn="name"
        idColumn="id"
        index={0}
        onSelect={onSelect}
      />
    );
    fireEvent.click(container.firstElementChild as Element);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test('masks primary and preview sensitive values', () => {
    const sensitiveColumns = new Map<string, unknown>([
      ['name', { type: 'email' }],
      ['email', { type: 'email' }],
    ]);
    const { queryAllByText } = render(
      <ResultCard
        row={{ id: 7, name: 'carol', email: 'carol@example.com', status: 'active' }}
        fields={['id', 'name', 'email', 'status']}
        primaryColumn="name"
        idColumn="id"
        index={0}
        onSelect={mock(() => {})}
        maskingActive
        sensitiveColumns={sensitiveColumns as never}
      />
    );

    expect(queryAllByText('***MASKED***').length).toBeGreaterThan(1);
  });

  test('falls back to row label when primary value is null', () => {
    const { queryByText } = render(
      <ResultCard
        row={{ id: 9, name: null }}
        fields={['id', 'name']}
        primaryColumn="name"
        idColumn="id"
        index={3}
        onSelect={mock(() => {})}
      />
    );
    expect(queryByText('Row 4')).not.toBeNull();
  });
});
