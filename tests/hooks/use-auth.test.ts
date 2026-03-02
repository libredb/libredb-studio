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

  // ── /api/auth/me non-ok response ───────────────────────────────────────────

  test('/api/auth/me returns non-ok → user stays null', async () => {
    mockGlobalFetch({
      '/api/auth/me': { ok: false, status: 401, json: { error: 'Unauthorized' } },
    });

    const { result } = renderHook(() => useAuth());

    // Wait for fetch to complete
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(result.current.user).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });

  // ── /api/auth/me throws network error ──────────────────────────────────────

  test('/api/auth/me throws network error → user stays null, no crash', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/auth/me')) {
        throw new Error('Network error');
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(result.current.user).toBeNull();
    expect(result.current.isAdmin).toBe(false);

    globalThis.fetch = originalFetch;
  });

  // ── User with no role property → isAdmin=false ─────────────────────────────

  test('user with no role property → isAdmin=false', async () => {
    mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { name: 'john' } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    expect(result.current.isAdmin).toBe(false);
  });

  // ── User with role='' → isAdmin=false ──────────────────────────────────────

  test('user with role="" → isAdmin=false', async () => {
    mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { role: '' } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    expect(result.current.isAdmin).toBe(false);
  });

  // ── User with role='viewer' → isAdmin=false ────────────────────────────────

  test('user with role="viewer" → isAdmin=false', async () => {
    mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { role: 'viewer' } } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    expect(result.current.isAdmin).toBe(false);
  });

  // ── handleLogout function is stable ────────────────────────────────────────

  test('handleLogout can be called before user fetch completes', async () => {
    // Slow fetch for /me, fast for logout
    let resolveMe: ((value: Response) => void) | undefined;
    const mePromise = new Promise<Response>((resolve) => { resolveMe = resolve; });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/auth/me')) return mePromise;
      if (url.includes('/api/auth/logout')) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useAuth());

    // Logout before me resolves
    await act(async () => {
      await result.current.handleLogout();
    });

    expect(mockRouterPush).toHaveBeenCalledWith('/login');

    // Now resolve me
    resolveMe!(new Response(JSON.stringify({ user: { role: 'user' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
  });

  // ── handleLogout with OIDC redirect ──────────────────────────────────────

  test('handleLogout redirects to OIDC logout URL when present', async () => {
    // Mock window.location to prevent navigation side effects
    const savedDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
    const locationMock = { href: '' };
    Object.defineProperty(window, 'location', {
      value: locationMock,
      writable: true,
      configurable: true,
    });

    mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { role: 'user' } } },
      '/api/auth/logout': { ok: true, json: { success: true, redirectUrl: 'https://auth0.com/v2/logout?client_id=abc' } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    // redirectUrl branch: window.location.href should be set, router.push should NOT
    expect(locationMock.href).toBe('https://auth0.com/v2/logout?client_id=abc');
    expect(mockRouterPush).not.toHaveBeenCalledWith('/login');

    // Restore window.location
    if (savedDescriptor) {
      Object.defineProperty(window, 'location', savedDescriptor);
    }
  });

  // ── Logout with non-ok response still navigates ───────────────────────────

  test('handleLogout navigates even if logout API returns non-ok', async () => {
    mockGlobalFetch({
      '/api/auth/me': { ok: true, json: { user: { role: 'user' } } },
      '/api/auth/logout': { ok: false, status: 500, json: { error: 'Server error' } },
    });

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    // The fetch didn't throw, so logout path should succeed
    expect(mockRouterPush).toHaveBeenCalledWith('/login');
  });
});
