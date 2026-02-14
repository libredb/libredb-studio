import '../setup-dom';

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { mockGlobalFetch, restoreGlobalFetch } from '../helpers/mock-fetch';

// Shared mocks — process-wide singletons (no contamination)
import { mockToastSuccess, mockToastError } from '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { useTransactionControl } from '@/hooks/use-transaction-control';
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

describe('useTransactionControl', () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test('initially transactionActive is false and playgroundMode is false', () => {
    const { result } = renderHook(() =>
      useTransactionControl({ activeConnection: makeConnection() })
    );

    expect(result.current.transactionActive).toBe(false);
    expect(result.current.playgroundMode).toBe(false);
  });

  test('handleTransaction begin calls fetch and sets transactionActive true', async () => {
    const connection = makeConnection();
    const fetchMock = mockGlobalFetch({
      '/api/db/transaction': { ok: true, status: 200, json: { success: true } },
    });

    const { result } = renderHook(() =>
      useTransactionControl({ activeConnection: connection })
    );

    await act(async () => {
      await result.current.handleTransaction('begin');
    });

    // fetch was called with correct params
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/db/transaction');
    expect(options?.method).toBe('POST');
    const body = JSON.parse(options?.body as string);
    expect(body.action).toBe('begin');
    expect(body.connection.id).toBe('conn-1');

    // State updated
    expect(result.current.transactionActive).toBe(true);

    // Toast called with success (real useToast calls sonnerToast.success)
    expect(mockToastSuccess).toHaveBeenCalledWith('Transaction Started', expect.any(Object));
  });

  test('handleTransaction commit calls fetch and sets transactionActive false', async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      '/api/db/transaction': { ok: true, status: 200, json: { success: true } },
    });

    const { result } = renderHook(() =>
      useTransactionControl({ activeConnection: connection })
    );

    // First begin to set transactionActive true
    await act(async () => {
      await result.current.handleTransaction('begin');
    });
    expect(result.current.transactionActive).toBe(true);

    // Now commit
    await act(async () => {
      await result.current.handleTransaction('commit');
    });

    expect(result.current.transactionActive).toBe(false);
    expect(mockToastSuccess).toHaveBeenCalledWith('Transaction Committed', expect.any(Object));
  });

  test('handleTransaction rollback calls fetch and sets transactionActive false', async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      '/api/db/transaction': { ok: true, status: 200, json: { success: true } },
    });

    const { result } = renderHook(() =>
      useTransactionControl({ activeConnection: connection })
    );

    // Begin first
    await act(async () => {
      await result.current.handleTransaction('begin');
    });
    expect(result.current.transactionActive).toBe(true);

    // Now rollback
    await act(async () => {
      await result.current.handleTransaction('rollback');
    });

    expect(result.current.transactionActive).toBe(false);
    expect(mockToastSuccess).toHaveBeenCalledWith('Transaction Rolled Back', expect.any(Object));
  });

  test('handleTransaction does nothing when activeConnection is null', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/transaction': { ok: true, status: 200, json: { success: true } },
    });

    const { result } = renderHook(() =>
      useTransactionControl({ activeConnection: null })
    );

    await act(async () => {
      await result.current.handleTransaction('begin');
    });

    // fetch should never have been called
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.transactionActive).toBe(false);
  });

  test('handleTransaction shows destructive toast on API error', async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      '/api/db/transaction': { ok: false, status: 400, json: { error: 'Transaction not supported' } },
    });

    const { result } = renderHook(() =>
      useTransactionControl({ activeConnection: connection })
    );

    await act(async () => {
      await result.current.handleTransaction('begin');
    });

    expect(result.current.transactionActive).toBe(false);
    expect(mockToastError).toHaveBeenCalledWith('Transaction Error', expect.objectContaining({ description: 'Transaction not supported' }));
  });

  test('handleTransaction shows destructive toast on network error', async () => {
    const connection = makeConnection();
    // Override fetch to throw a network error
    globalThis.fetch = mock(async () => {
      throw new Error('Network failure');
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useTransactionControl({ activeConnection: connection })
    );

    await act(async () => {
      await result.current.handleTransaction('begin');
    });

    expect(result.current.transactionActive).toBe(false);
    expect(mockToastError).toHaveBeenCalledWith('Transaction Error', expect.objectContaining({ description: 'Network failure' }));
  });

  test('resetTransactionState resets both states', async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      '/api/db/transaction': { ok: true, status: 200, json: { success: true } },
    });

    const { result } = renderHook(() =>
      useTransactionControl({ activeConnection: connection })
    );

    // Set transactionActive via begin
    await act(async () => {
      await result.current.handleTransaction('begin');
    });
    expect(result.current.transactionActive).toBe(true);

    // Set playgroundMode
    act(() => {
      result.current.setPlaygroundMode(true);
    });
    expect(result.current.playgroundMode).toBe(true);

    // Reset both
    act(() => {
      result.current.resetTransactionState();
    });

    expect(result.current.transactionActive).toBe(false);
    expect(result.current.playgroundMode).toBe(false);
  });
});
