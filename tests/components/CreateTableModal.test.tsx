import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, within } from '@testing-library/react';
import { CreateTableModal } from '@/components/CreateTableModal';

describe('CreateTableModal', () => {
  afterEach(() => { cleanup(); });

  test('renders dialog content when isOpen', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);
    expect(body.queryByText('Create New Table')).not.toBeNull();
    expect(body.queryByText('SQL Preview')).not.toBeNull();
    expect(body.queryByText('Add Column')).not.toBeNull();
    expect(body.queryByText('General Settings')).not.toBeNull();
    expect(body.queryByText('Column Definitions')).not.toBeNull();
  });

  test('shows default id column and SQL placeholder', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    expect(baseElement.textContent).toContain('-- Name your table to see SQL');
    expect(baseElement.textContent).toContain('SERIAL (Auto-Inc)');
  });
});
