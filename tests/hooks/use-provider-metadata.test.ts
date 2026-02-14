import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { mockGlobalFetch, restoreGlobalFetch } from '../helpers/mock-fetch';

import { useProviderMetadata } from '@/hooks/use-provider-metadata';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';
import type { DatabaseConnection } from '@/lib/types';

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'conn-1',
    name: 'Test DB',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'testdb',
    createdAt: new Date(),
    ...overrides,
  };
}

const mockMetadata: ProviderMetadata = {
  capabilities: {
    queryLanguage: 'sql',
    supportsExplain: true,
    supportsCreateTable: true,
    maintenanceOperations: [],
    schemaRefreshPattern: 'CREATE|ALTER|DROP',
    defaultPort: 5432,
    supportsPrepareQuery: true,
  },
  labels: {
    entityName: 'Table',
    selectAction: 'SELECT',
    searchPlaceholder: 'Search tables...',
  },
} as ProviderMetadata;

describe('useProviderMetadata', () => {
  beforeEach(() => {
    // Suppress console.error from the hook's catch block
    mock.module('console', () => ({
      ...console,
    }));
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test('returns null metadata when connection is null', () => {
    const { result } = renderHook(() => useProviderMetadata(null));

    expect(result.current.metadata).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  test('fetches metadata on connection change', async () => {
    const connection = makeConnection();
    const fetchMock = mockGlobalFetch({
      '/api/db/provider-meta': { ok: true, status: 200, json: mockMetadata },
    });

    const { result } = renderHook(() => useProviderMetadata(connection));

    await waitFor(() => {
      expect(result.current.metadata).not.toBeNull();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/db/provider-meta');
    expect(options?.method).toBe('POST');
    const body = JSON.parse(options?.body as string);
    expect(body.id).toBe('conn-1');
  });

  test('sets isLoading true during fetch', async () => {
    const connection = makeConnection();

    // Use a delayed response to observe isLoading
    let resolveResponse!: (value: Response) => void;
    globalThis.fetch = mock(async () => {
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useProviderMetadata(connection));

    // isLoading should become true
    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });

    // Now resolve the fetch
    resolveResponse(new Response(JSON.stringify(mockMetadata), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    // isLoading should become false after resolution
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
  });

  test('sets isLoading false after fetch completes', async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      '/api/db/provider-meta': { ok: true, status: 200, json: mockMetadata },
    });

    const { result } = renderHook(() => useProviderMetadata(connection));

    // Wait for fetch to complete
    await waitFor(() => {
      expect(result.current.metadata).not.toBeNull();
    });

    expect(result.current.isLoading).toBe(false);
  });

  test('sets metadata from successful response', async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      '/api/db/provider-meta': { ok: true, status: 200, json: mockMetadata },
    });

    const { result } = renderHook(() => useProviderMetadata(connection));

    await waitFor(() => {
      expect(result.current.metadata).not.toBeNull();
    });

    expect(result.current.metadata!.capabilities.queryLanguage).toBe('sql');
    expect(result.current.metadata!.capabilities.supportsExplain).toBe(true);
    expect(result.current.metadata!.labels.entityName).toBe('Table');
  });

  test('sets metadata to null on fetch error', async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      '/api/db/provider-meta': { ok: false, status: 500, json: { error: 'Internal error' } },
    });

    const { result } = renderHook(() => useProviderMetadata(connection));

    // Wait for the fetch to settle — metadata should remain null
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.metadata).toBeNull();
  });

  test('does not refetch for same connection ID', async () => {
    const connection = makeConnection();
    const fetchMock = mockGlobalFetch({
      '/api/db/provider-meta': { ok: true, status: 200, json: mockMetadata },
    });

    const { result, rerender } = renderHook(
      ({ conn }) => useProviderMetadata(conn),
      { initialProps: { conn: connection } }
    );

    // Wait for first fetch
    await waitFor(() => {
      expect(result.current.metadata).not.toBeNull();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Re-render with the same connection (same id)
    const sameConnection = makeConnection({ name: 'Different Name But Same ID' });
    rerender({ conn: sameConnection });

    // Give it time to potentially refetch
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Should still only have been called once
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('resets metadata when connection becomes null', async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      '/api/db/provider-meta': { ok: true, status: 200, json: mockMetadata },
    });

    const { result, rerender } = renderHook(
      ({ conn }) => useProviderMetadata(conn),
      { initialProps: { conn: connection as DatabaseConnection | null } }
    );

    // Wait for metadata to load
    await waitFor(() => {
      expect(result.current.metadata).not.toBeNull();
    });

    // Set connection to null
    rerender({ conn: null });

    await waitFor(() => {
      expect(result.current.metadata).toBeNull();
    });
  });
});
