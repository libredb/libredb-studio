import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, within } from '@testing-library/react';
import { DataImportModal } from '@/components/DataImportModal';

describe('DataImportModal', () => {
  afterEach(() => { cleanup(); });

  test('renders upload step when open', () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={mock(() => {})} onImport={mock(() => {})} tables={[]} />);
    expect(within(baseElement).queryByText('Import Data')).not.toBeNull();
  });

  test('shows file upload zone and format icons', () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={mock(() => {})} onImport={mock(() => {})} tables={[]} />);
    const body = within(baseElement);
    expect(body.queryByText('CSV')).not.toBeNull();
    expect(body.queryByText('JSON')).not.toBeNull();
  });
});
