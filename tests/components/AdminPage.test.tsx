import '../setup-dom';
import { mock } from 'bun:test';
import React from 'react';

// Mock AdminDashboard to avoid its massive dependency tree
mock.module('@/components/admin/AdminDashboard', () => ({
  default: () => React.createElement('div', { 'data-testid': 'admin-dashboard' }, 'AdminDashboard Mock'),
}));

const { default: AdminPage } = await import('@/app/admin/page');

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';

describe('AdminPage', () => {
  afterEach(() => { cleanup(); });

  test('renders AdminDashboard component', () => {
    const { getByTestId } = render(<AdminPage />);
    expect(getByTestId('admin-dashboard')).not.toBeNull();
  });

  test('renders AdminDashboard content', () => {
    const { getByText } = render(<AdminPage />);
    expect(getByText('AdminDashboard Mock')).not.toBeNull();
  });

  test('wraps AdminDashboard in Suspense', () => {
    // Verify the component renders without throwing (Suspense boundary works)
    const element = AdminPage();
    expect(element.type).toBe(React.Suspense);
  });
});
