import '../setup-dom';
import { mock } from 'bun:test';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

// Mock next/font/google
mock.module('next/font/google', () => ({
  Inter: () => ({ className: 'mock-inter' }),
}));

// Mock @/components/ui/sonner directly to avoid sonner/next-themes/lucide-react chain
mock.module('@/components/ui/sonner', () => ({
  Toaster: (props: Record<string, unknown>) =>
    React.createElement('div', {
      'data-testid': 'toaster',
      'data-position': props.position,
      'data-theme': props.theme,
    }),
}));

// Dynamic import so mocks are registered first
const { default: RootLayout, metadata } = await import('@/app/layout');

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';

describe('RootLayout', () => {
  afterEach(() => { cleanup(); });

  test('exports correct metadata title', () => {
    expect(metadata.title).toBe('LibreDB Studio | Universal Database Editor');
  });

  test('exports correct metadata description', () => {
    expect(metadata.description).toBe(
      'Manage PostgreSQL, MySQL, MongoDB, and Redis in one web-based interface.'
    );
  });

  test('renders children', () => {
    const { getByText } = render(
      <RootLayout>
        <div>Test Child</div>
      </RootLayout>
    );
    expect(getByText('Test Child')).not.toBeNull();
  });

  test('renders Toaster with correct props', () => {
    const { getByTestId } = render(
      <RootLayout>
        <span>content</span>
      </RootLayout>
    );
    const toaster = getByTestId('toaster');
    expect(toaster).not.toBeNull();
    expect(toaster.getAttribute('data-position')).toBe('bottom-right');
    expect(toaster.getAttribute('data-theme')).toBe('dark');
  });

  test('renders html with lang=en and body with correct classes via SSR', () => {
    const html = ReactDOMServer.renderToString(
      <RootLayout>
        <span>content</span>
      </RootLayout>
    );
    expect(html).toContain('lang="en"');
    expect(html).toContain('mock-inter');
    expect(html).toContain('antialiased');
    expect(html).toContain('dark');
  });

  test('renders multiple children correctly', () => {
    const { getByText } = render(
      <RootLayout>
        <div>First</div>
        <div>Second</div>
      </RootLayout>
    );
    expect(getByText('First')).not.toBeNull();
    expect(getByText('Second')).not.toBeNull();
  });
});
