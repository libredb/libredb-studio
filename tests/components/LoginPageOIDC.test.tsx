import '../setup-dom';
import React from 'react';
import { mock } from 'bun:test';

// Override next/navigation to support searchParams with error
let mockSearchParams = new URLSearchParams();
const mockRouterPush = mock(() => {});
const mockRouterRefresh = mock(() => {});

mock.module('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    refresh: mockRouterRefresh,
    back: mock(() => {}),
    forward: mock(() => {}),
  }),
  usePathname: () => '/',
  useSearchParams: () => mockSearchParams,
}));

const { default: LoginForm } = await import('@/app/login/login-form');

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('LoginPage (OIDC mode)', () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    cleanup();
  });

  test('renders Login with SSO button', () => {
    const { getByText } = render(<LoginForm authProvider="oidc" />);
    expect(getByText('Login with SSO')).not.toBeNull();
  });

  test('does not render email/password form', () => {
    const { container } = render(<LoginForm authProvider="oidc" />);
    const form = container.querySelector('form');
    expect(form).toBeNull();
  });

  test('does not render quick access buttons', () => {
    const { queryByText } = render(<LoginForm authProvider="oidc" />);
    expect(queryByText('Admin')).toBeNull();
    expect(queryByText('User')).toBeNull();
  });

  test('renders LibreDB Studio title', () => {
    const { getByText } = render(<LoginForm authProvider="oidc" />);
    expect(getByText('LibreDB Studio')).not.toBeNull();
  });

  test('shows error message when error param is present', () => {
    mockSearchParams = new URLSearchParams('error=oidc_failed');
    const { getByText } = render(<LoginForm authProvider="oidc" />);
    expect(getByText('Authentication failed. Please try again.')).not.toBeNull();
  });

  test('does not show error message when no error param', () => {
    const { queryByText } = render(<LoginForm authProvider="oidc" />);
    expect(queryByText('Authentication failed. Please try again.')).toBeNull();
  });

  test('SSO button shows Redirecting... when clicked', async () => {
    // Mock window.location to prevent navigation
    const savedDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
    const locationMock = { href: '', assign: mock(() => {}), replace: mock(() => {}) };
    Object.defineProperty(window, 'location', {
      value: locationMock,
      writable: true,
      configurable: true,
    });

    const user = userEvent.setup();
    const { getByText, queryByText } = render(<LoginForm authProvider="oidc" />);

    await user.click(getByText('Login with SSO'));

    expect(queryByText('Redirecting...')).not.toBeNull();
    expect(locationMock.href).toBe('/api/auth/oidc/login');

    // Restore location
    if (savedDescriptor) {
      Object.defineProperty(window, 'location', savedDescriptor);
    }
  });
});
