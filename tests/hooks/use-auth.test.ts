import '../setup-dom';
import { mockToastSuccess, mockToastError } from '../helpers/mock-sonner';
import { mockRouterPush, mockRouterRefresh } from '../helpers/mock-navigation';

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { mockGlobalFetch, restoreGlobalFetch } from '../helpers/mock-fetch';

import { useAuth } from '@/hooks/use-auth';

// =============================================================================
// useAuth Tests
// =============================================================================
describe('useAuth', () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterRefresh.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  // ── Initial State ─────────────────────────────────────────────────────────

  test('initially user is null and isAdmin is false', () => {
    mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: null } },
    });

    const { result } = renderHook(() => useAuth());

    expect(result.current.user).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });

  // ── Fetch User on Mount ───────────────────────────────────────────────────

  test('after mount fetches /api/auth/me and sets user', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { role: 'user' } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).toEqual({ role: 'user' });
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me');
  });

  // ── isAdmin Derived State ─────────────────────────────────────────────────

  test('isAdmin is true when user role is admin', async () => {
    mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { role: 'admin' } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.isAdmin).toBe(true);
    });

    expect(result.current.user?.role).toBe('admin');
  });

  test('isAdmin is false when user role is user', async () => {
    mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { role: 'user' } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    expect(result.current.isAdmin).toBe(false);
  });

  // ── handleLogout ──────────────────────────────────────────────────────────

  test('handleLogout calls /api/auth/logout with POST method', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { role: 'user' } } },
      '/api/auth/logout': { ok: true, json: { success: true } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    // Find the logout call among all fetch calls
    const logoutCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/auth/logout')
    );
    expect(logoutCall).toBeDefined();
    expect(logoutCall![1]).toEqual({ method: 'POST' });
  });

  test('handleLogout calls router.push("/login") and router.refresh()', async () => {
    mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { role: 'user' } } },
      '/api/auth/logout': { ok: true, json: { success: true } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/login');
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  test('handleLogout shows success toast on success', async () => {
    mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { role: 'user' } } },
      '/api/auth/logout': { ok: true, json: { success: true } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    // useToast wraps sonnerToast.success for non-destructive variant
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'Logged out',
      { description: 'You have been successfully logged out.' }
    );
  });

  test('handleLogout shows destructive toast on error', async () => {
    mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { role: 'user' } } },
    });

    // Override fetch so logout throws a network error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/auth/logout')) {
        throw new Error('Network error');
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    // useToast wraps sonnerToast.error for destructive variant
    expect(mockToastError).toHaveBeenCalledWith(
      'Error',
      { description: 'Failed to logout.' }
    );
  });
});
