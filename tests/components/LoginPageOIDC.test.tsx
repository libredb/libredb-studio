import '../setup-dom';
import React from 'react';
import { mock } from 'bun:test';

// Override auth provider to OIDC BEFORE importing the page
process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'oidc';

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

const { default: LoginPage } = await import('@/app/login/page');

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('LoginPage (OIDC mode)', () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'oidc';
  });

  afterEach(() => {
    cleanup();
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'local';
  });

  test('renders Login with SSO button', () => {
    const { getByText } = render(<LoginPage />);
    expect(getByText('Login with SSO')).not.toBeNull();
  });

  test('does not render email/password form', () => {
    const { container } = render(<LoginPage />);
    const form = container.querySelector('form');
    expect(form).toBeNull();
  });

  test('does not render quick access buttons', () => {
    const { queryByText } = render(<LoginPage />);
    expect(queryByText('Admin')).toBeNull();
    expect(queryByText('User')).toBeNull();
  });

  test('renders LibreDB Studio title', () => {
    const { getByText } = render(<LoginPage />);
    expect(getByText('LibreDB Studio')).not.toBeNull();
  });

  test('shows error message when error param is present', () => {
    mockSearchParams = new URLSearchParams('error=oidc_failed');
    const { getByText } = render(<LoginPage />);
    expect(getByText('Authentication failed. Please try again.')).not.toBeNull();
  });

  test('does not show error message when no error param', () => {
    const { queryByText } = render(<LoginPage />);
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
    const { getByText, queryByText } = render(<LoginPage />);

    await user.click(getByText('Login with SSO'));

    expect(queryByText('Redirecting...')).not.toBeNull();
    expect(locationMock.href).toBe('/api/auth/oidc/login');

    // Restore location
    if (savedDescriptor) {
      Object.defineProperty(window, 'location', savedDescriptor);
    }
  });
});
