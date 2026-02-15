import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { PoolTab } from '@/components/monitoring/tabs/PoolTab';

const mockFetch = mock(() =>
  Promise.resolve(new Response(JSON.stringify({ total: 10, idle: 6, active: 3, waiting: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
);
globalThis.fetch = mockFetch as never;

const conn = { id: '1', name: 'test', type: 'postgres' as const, host: 'localhost', port: 5432, database: 'db', user: 'u', password: 'p', createdAt: new Date() };

describe('PoolTab', () => {
  afterEach(() => { cleanup(); mockFetch.mockClear(); });

  test('shows empty state when no connection', () => {
    const { queryByText } = render(<PoolTab connection={null} />);
    expect(queryByText('Select a connection to view pool statistics')).not.toBeNull();
  });

  test('renders pool stats after fetch', async () => {
    const { queryByText } = render(<PoolTab connection={conn} />);
    await waitFor(() => {
      expect(queryByText('Connection Pool')).not.toBeNull();
      expect(queryByText('10')).not.toBeNull();
    });
  });

  test('shows error state on fetch failure', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Pool not available' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
    );
    const { queryByText } = render(<PoolTab connection={conn} />);
    await waitFor(() => {
      expect(queryByText('Pool not available')).not.toBeNull();
    });
  });
});
