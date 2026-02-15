import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';

mock.module('@/lib/storage', () => ({
  storage: {
    getSavedQueries: () => [
      { id: 'q1', name: 'Active Users', description: 'Get active users', query: 'SELECT * FROM users WHERE active = true', connectionType: 'postgres', tags: ['report'], createdAt: '2026-01-15T10:00:00Z', updatedAt: '2026-01-15T10:00:00Z' },
    ],
    deleteSavedQuery: mock(() => {}),
  },
}));

mock.module('date-fns', () => ({
  format: (d: unknown) => {
    if (d instanceof Date) return d.toISOString().split('T')[0];
    return String(d).split('T')[0];
  },
}));

import { SavedQueries } from '@/components/SavedQueries';

describe('SavedQueries', () => {
  afterEach(() => { cleanup(); });

  test('renders saved query items', () => {
    const { queryByText } = render(<SavedQueries onSelectQuery={mock(() => {})} />);
    expect(queryByText('Active Users')).not.toBeNull();
    expect(queryByText('Get active users')).not.toBeNull();
  });

  test('shows empty state when no queries match', () => {
    mock.module('@/lib/storage', () => ({
      storage: { getSavedQueries: () => [], deleteSavedQuery: mock(() => {}) },
    }));
    const { queryByText } = render(<SavedQueries onSelectQuery={mock(() => {})} />);
    expect(queryByText('No saved queries found')).not.toBeNull();
  });
});
