import '../setup-dom';
import React from 'react';
import { mockRouterPush, mockRouterRefresh } from '../helpers/mock-navigation';
import { mockToastSuccess, mockToastError } from '../helpers/mock-sonner';
import { mock } from 'bun:test';

// sonner and next/navigation are mocked via preload
// lucide-react resolves fine natively — no mock needed

const { default: LoginPage } = await import('@/app/login/page');

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

function renderLogin() {
  const user = userEvent.setup();
  const result = render(<LoginPage />);
  const form = result.container.querySelector('form')!;
  const emailInput = result.container.querySelector('input[type="email"]')! as HTMLInputElement;
  const passwordInput = result.container.querySelector('input[type="password"]')! as HTMLInputElement;
  return { ...result, form, emailInput, passwordInput, user };
}

describe('LoginPage', () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterRefresh.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    globalThis.fetch = mock(() => Promise.resolve(new Response('{}'))) as never;
  });

  afterEach(() => { cleanup(); });

  test('renders login form with email and password inputs', () => {
    const { emailInput, passwordInput } = renderLogin();
    expect(emailInput).not.toBeNull();
    expect(emailInput.type).toBe('email');
    expect(passwordInput).not.toBeNull();
    expect(passwordInput.type).toBe('password');
  });

  test('renders Sign In button', () => {
    const { getByText } = renderLogin();
    expect(getByText('Sign In')).not.toBeNull();
  });

  test('renders LibreDB Studio title', () => {
    const { getByText } = renderLogin();
    expect(getByText('LibreDB Studio')).not.toBeNull();
  });

  test('renders quick access Admin and User buttons', () => {
    const { getByText } = renderLogin();
    expect(getByText('Admin')).not.toBeNull();
    expect(getByText('User')).not.toBeNull();
  });

  test('shows error toast when submitting empty form', () => {
    const { form } = renderLogin();
    fireEvent.submit(form);
    expect(mockToastError).toHaveBeenCalledWith('Please enter email and password');
  });

  test('calls fetch with correct payload on form submit', async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: 'admin' })))
    );
    globalThis.fetch = mockFetch as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, 'admin@libredb.org');
    await user.type(passwordInput, 'LibreDB.2026');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [url, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ email: 'admin@libredb.org', password: 'LibreDB.2026' });
  });

  test('redirects admin to /admin on success', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: 'admin' })))
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, 'admin@libredb.org');
    await user.type(passwordInput, 'LibreDB.2026');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/admin');
    });
    expect(mockRouterRefresh).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith('Welcome back, admin!');
  });

  test('redirects user to / on success', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: 'user' })))
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, 'user@libredb.org');
    await user.type(passwordInput, 'LibreDB.2026');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/');
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Welcome back, user!');
  });

  test('shows error toast on failed login', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: false, message: 'Invalid email or password' })))
    ) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, 'wrong@example.com');
    await user.type(passwordInput, 'wrong');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Invalid email or password');
    });
  });

  test('shows generic error toast on network failure', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('Network error'))) as never;

    const { form, emailInput, passwordInput, user } = renderLogin();
    await user.type(emailInput, 'test@example.com');
    await user.type(passwordInput, 'test');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('An error occurred. Please try again.');
    });
  });

  test('shows Authenticating... text while loading', async () => {
    let resolveFetch!: (v: Response) => void;
    globalThis.fetch = mock(() =>
      new Promise<Response>((resolve) => { resolveFetch = resolve; })
    ) as never;

    const { form, emailInput, passwordInput, user, queryByText } = renderLogin();
    await user.type(emailInput, 'test@example.com');
    await user.type(passwordInput, 'test');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(queryByText('Authenticating...')).not.toBeNull();
    });

    resolveFetch(new Response(JSON.stringify({ success: false })));
    await waitFor(() => {
      expect(queryByText('Sign In')).not.toBeNull();
    });
  });

  test('Admin quick access button sends admin credentials', async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: 'admin' })))
    );
    globalThis.fetch = mockFetch as never;

    const { getByText, user } = renderLogin();
    await user.click(getByText('Admin'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({ email: 'admin@libredb.org', password: 'LibreDB.2026' });
  });

  test('User quick access button sends user credentials', async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: 'user' })))
    );
    globalThis.fetch = mockFetch as never;

    const { getByText, user } = renderLogin();
    await user.click(getByText('User'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual({ email: 'user@libredb.org', password: 'LibreDB.2026' });
  });

  test('disables buttons while loading', async () => {
    let resolveFetch!: (v: Response) => void;
    globalThis.fetch = mock(() =>
      new Promise<Response>((resolve) => { resolveFetch = resolve; })
    ) as never;

    const { form, emailInput, passwordInput, user, getByText } = renderLogin();
    await user.type(emailInput, 'test@example.com');
    await user.type(passwordInput, 'test');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(getByText('Authenticating...')).not.toBeNull();
    });

    const adminBtn = getByText('Admin').closest('button')!;
    const userBtn = getByText('User').closest('button')!;
    expect(adminBtn.hasAttribute('disabled')).toBe(true);
    expect(userBtn.hasAttribute('disabled')).toBe(true);

    resolveFetch(new Response(JSON.stringify({ success: false })));
    await waitFor(() => {
      expect(getByText('Sign In')).not.toBeNull();
    });
  });
});
