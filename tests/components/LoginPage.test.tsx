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
  const input = result.container.querySelector('input[type="password"]')! as HTMLInputElement;
  return { ...result, form, input, user };
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

  test('renders login form with password input', () => {
    const { input } = renderLogin();
    expect(input).not.toBeNull();
    expect(input.type).toBe('password');
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

  test('shows error toast when submitting empty password', () => {
    const { form } = renderLogin();
    fireEvent.submit(form);
    expect(mockToastError).toHaveBeenCalledWith('Please enter a password');
  });

  test('calls fetch with correct payload on form submit', async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: 'admin' })))
    );
    globalThis.fetch = mockFetch as never;

    const { form, input, user } = renderLogin();
    await user.type(input, 'mypass');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [url, options] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ password: 'mypass' });
  });

  test('redirects admin to /admin on success', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, role: 'admin' })))
    ) as never;

    const { form, input, user } = renderLogin();
    await user.type(input, 'admin123');
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

    const { form, input, user } = renderLogin();
    await user.type(input, 'user123');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/');
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Welcome back, user!');
  });

  test('shows error toast on failed login', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: false, message: 'Wrong password' })))
    ) as never;

    const { form, input, user } = renderLogin();
    await user.type(input, 'wrong');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Wrong password');
    });
  });

  test('shows generic error toast on network failure', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('Network error'))) as never;

    const { form, input, user } = renderLogin();
    await user.type(input, 'test');
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

    const { form, input, user, queryByText } = renderLogin();
    await user.type(input, 'test');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(queryByText('Authenticating...')).not.toBeNull();
    });

    resolveFetch(new Response(JSON.stringify({ success: false })));
    await waitFor(() => {
      expect(queryByText('Sign In')).not.toBeNull();
    });
  });

  test('Admin quick access button sends admin123 password', async () => {
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
    expect(JSON.parse(options.body as string)).toEqual({ password: 'admin123' });
  });

  test('User quick access button sends user123 password', async () => {
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
    expect(JSON.parse(options.body as string)).toEqual({ password: 'user123' });
  });

  test('disables buttons while loading', async () => {
    let resolveFetch!: (v: Response) => void;
    globalThis.fetch = mock(() =>
      new Promise<Response>((resolve) => { resolveFetch = resolve; })
    ) as never;

    const { form, input, user, getByText } = renderLogin();
    await user.type(input, 'test');
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
