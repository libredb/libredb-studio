import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, within, fireEvent, act } from '@testing-library/react';
import { DataImportModal } from '@/components/DataImportModal';
import type { TableSchema } from '@/lib/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const noop = mock(() => {});

const sampleTables: TableSchema[] = [
  { name: 'users', columns: [{ name: 'id', type: 'integer', nullable: false, isPrimary: true }], indexes: [] },
  { name: 'orders', columns: [{ name: 'id', type: 'integer', nullable: false, isPrimary: true }], indexes: [] },
];

/**
 * Simulate a file upload by creating a mock File and dispatching a change event,
 * then synchronously invoking the FileReader's onload callback.
 */
function simulateFileUpload(container: HTMLElement, content: string, filename: string) {
  const file = new File([content], filename, { type: filename.endsWith('.json') ? 'application/json' : 'text/csv' });

  // Capture FileReader.readAsText calls and synchronously fire onload
  const origFileReader = globalThis.FileReader;
  const mockReaderInstance = {
    readAsText: mock(function (this: { onload: ((e: { target: { result: string } }) => void) | null }) {
      // fire onload synchronously
      if (this.onload) {
        this.onload({ target: { result: content } });
      }
    }),
    onload: null as ((e: { target: { result: string } }) => void) | null,
  };
  globalThis.FileReader = class {
    onload = null as ((e: { target: { result: string } }) => void) | null;
    readAsText() {
      mockReaderInstance.onload = this.onload;
      mockReaderInstance.readAsText.call(this);
    }
  } as unknown as typeof FileReader;

  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], writable: false });
  fireEvent.change(input);

  globalThis.FileReader = origFileReader;
}

// =============================================================================
// DataImportModal Tests
// =============================================================================

describe('DataImportModal', () => {
  afterEach(() => { cleanup(); });

  // ── Render basics ──────────────────────────────────────────────────────────

  test('renders nothing when not open', () => {
    const { baseElement } = render(
      <DataImportModal isOpen={false} onClose={noop} onImport={noop} tables={[]} />
    );
    expect(within(baseElement).queryByText('Import Data')).toBeNull();
  });

  test('renders upload step when open', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />
    );
    expect(within(baseElement).queryByText('Import Data')).not.toBeNull();
  });

  test('shows file upload zone and format icons', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />
    );
    const body = within(baseElement);
    expect(body.queryByText('CSV')).not.toBeNull();
    expect(body.queryByText('JSON')).not.toBeNull();
    expect(body.queryByText(/Drop a file here/)).not.toBeNull();
  });

  test('shows step indicators', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />
    );
    const text = baseElement.textContent || '';
    expect(text).toContain('Upload');
    expect(text).toContain('Preview');
    expect(text).toContain('Configure');
    expect(text).toContain('Import');
  });

  test('has hidden file input accepting csv, json, tsv', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />
    );
    const input = baseElement.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.accept).toContain('.csv');
    expect(input.accept).toContain('.json');
  });

  // ── CSV file upload → Preview step ─────────────────────────────────────────

  test('advances to preview step after CSV file upload', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30\nBob,25', 'test.csv');
    });

    const body = within(baseElement);
    // Preview step shows file name (appears in header + preview body)
    expect(body.queryAllByText('test.csv').length).toBeGreaterThanOrEqual(1);
    expect(body.queryByText(/2 rows/)).not.toBeNull();
    expect(body.queryByText(/2 columns/)).not.toBeNull();
  });

  test('shows preview table headers from CSV', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30\nBob,25', 'data.csv');
    });

    const body = within(baseElement);
    expect(body.queryByText('name')).not.toBeNull();
    expect(body.queryByText('age')).not.toBeNull();
  });

  test('shows preview table data rows', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30\nBob,25', 'data.csv');
    });

    const body = within(baseElement);
    expect(body.queryByText('Alice')).not.toBeNull();
    expect(body.queryByText('Bob')).not.toBeNull();
    expect(body.queryByText('30')).not.toBeNull();
  });

  test('shows "more rows" indicator when data has >10 rows', () => {
    const rows = Array.from({ length: 15 }, (_, i) => `user${i},${20 + i}`).join('\n');
    const csv = `name,age\n${rows}`;

    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, csv, 'large.csv');
    });

    expect(baseElement.textContent).toContain('and 5 more rows');
  });

  test('shows Configure Import button in preview step', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    expect(within(baseElement).queryByText('Configure Import')).not.toBeNull();
  });

  test('Reset button returns to upload step', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    // Should be in preview step (filename appears in header + preview body)
    expect(within(baseElement).queryAllByText('data.csv').length).toBeGreaterThanOrEqual(1);

    // Click Reset
    const resetBtn = within(baseElement).getByText('Reset');
    act(() => { fireEvent.click(resetBtn); });

    // Should be back to upload step
    expect(within(baseElement).queryByText(/Drop a file here/)).not.toBeNull();
  });

  // ── JSON file upload ───────────────────────────────────────────────────────

  test('advances to preview step after JSON file upload', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, '[{"name":"Alice","age":30}]', 'data.json');
    });

    const body = within(baseElement);
    // File name appears in header + preview body
    expect(body.queryAllByText('data.json').length).toBeGreaterThanOrEqual(1);
    expect(body.queryByText(/1 row/)).not.toBeNull();
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  test('shows error for invalid JSON file', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'not valid json', 'bad.json');
    });

    expect(baseElement.textContent).toContain('Failed to parse file');
  });

  test('shows error for empty CSV file', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />
    );

    act(() => {
      simulateFileUpload(baseElement, '', 'empty.csv');
    });

    expect(baseElement.textContent).toContain('No data found in file');
  });

  // ── Preview → Configure step ──────────────────────────────────────────────

  test('advances to configure step from preview', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    // Click Configure Import
    const configBtn = within(baseElement).getByText('Configure Import');
    act(() => { fireEvent.click(configBtn); });

    const body = within(baseElement);
    // Configure step shows target table options
    expect(body.queryByText('Target Table')).not.toBeNull();
    expect(body.queryByText('Existing Table')).not.toBeNull();
    expect(body.queryByText('New Table')).not.toBeNull();
  });

  test('configure step shows column mapping section', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    expect(within(baseElement).queryByText('Column Mapping')).not.toBeNull();
    expect(within(baseElement).queryByText('Source Column')).not.toBeNull();
    expect(within(baseElement).queryByText('Target Column')).not.toBeNull();
  });

  test('configure step shows existing tables in dropdown', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    const select = baseElement.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    const options = Array.from(select.querySelectorAll('option'));
    const optionTexts = options.map(o => o.textContent);
    expect(optionTexts).toContain('users');
    expect(optionTexts).toContain('orders');
  });

  test('Review SQL button is disabled when no table is selected', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    const reviewBtn = within(baseElement).getByText('Review SQL');
    expect(reviewBtn.closest('button')?.disabled).toBe(true);
  });

  test('selecting existing table enables Review SQL button', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    // Select a table
    const select = baseElement.querySelector('select') as HTMLSelectElement;
    act(() => {
      fireEvent.change(select, { target: { value: 'users' } });
    });

    const reviewBtn = within(baseElement).getByText('Review SQL');
    expect(reviewBtn.closest('button')?.disabled).toBe(false);
  });

  test('switching to "New Table" shows name input and enables Review SQL', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    // Click "New Table"
    act(() => {
      fireEvent.click(within(baseElement).getByText('New Table'));
    });

    expect(within(baseElement).queryByText('New Table Name')).not.toBeNull();

    // Review SQL should be enabled for new tables (default name "imported_data")
    const reviewBtn = within(baseElement).getByText('Review SQL');
    expect(reviewBtn.closest('button')?.disabled).toBe(false);
  });

  test('Back button in configure goes to preview', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    // Back button
    act(() => {
      fireEvent.click(within(baseElement).getByText('Back'));
    });

    // Should be back in preview
    expect(within(baseElement).queryByText('Configure Import')).not.toBeNull();
  });

  // ── Configure → Ready step ────────────────────────────────────────────────

  test('advances to ready step after configuring new table', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30\nBob,25', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('New Table'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Review SQL'));
    });

    const body = within(baseElement);
    expect(body.queryByText('Ready to Import')).not.toBeNull();
    expect(body.queryByText(/2 rows into/)).not.toBeNull();
  });

  test('ready step shows SQL preview with CREATE TABLE', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30\nBob,25', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('New Table'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Review SQL'));
    });

    const preEl = baseElement.querySelector('pre');
    expect(preEl).not.toBeNull();
    expect(preEl!.textContent).toContain('CREATE TABLE');
    expect(preEl!.textContent).toContain('INSERT INTO');
  });

  test('ready step shows SQL preview for existing table', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    const select = baseElement.querySelector('select') as HTMLSelectElement;
    act(() => {
      fireEvent.change(select, { target: { value: 'users' } });
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Review SQL'));
    });

    const preEl = baseElement.querySelector('pre');
    expect(preEl).not.toBeNull();
    expect(preEl!.textContent).toContain('INSERT INTO users');
    expect(preEl!.textContent).not.toContain('CREATE TABLE');
  });

  test('ready step shows databaseType badge when provided', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} databaseType="postgres" />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('New Table'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Review SQL'));
    });

    expect(within(baseElement).queryByText('postgres')).not.toBeNull();
  });

  test('ready step has Copy SQL and Execute Import buttons', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('New Table'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Review SQL'));
    });

    expect(within(baseElement).queryByText('Copy SQL')).not.toBeNull();
    expect(within(baseElement).queryByText('Execute Import')).not.toBeNull();
  });

  test('Execute Import calls onImport with generated SQL', () => {
    const mockImport = mock(() => {});
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={mockImport} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('New Table'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Review SQL'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Execute Import'));
    });

    expect(mockImport).toHaveBeenCalledTimes(1);
    const sql = (mockImport.mock.calls[0] as unknown[])[0] as string;
    expect(sql).toContain('CREATE TABLE');
    expect(sql).toContain('INSERT INTO');
  });

  test('Back button in ready step goes to configure', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('New Table'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Review SQL'));
    });

    // Back
    const backBtns = within(baseElement).getAllByText('Back');
    act(() => {
      fireEvent.click(backBtns[backBtns.length - 1]);
    });

    // Should be in configure step
    expect(within(baseElement).queryByText('Target Table')).not.toBeNull();
  });

  // ── Column mapping ─────────────────────────────────────────────────────────

  test('column mapping shows source column names', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'first_name,last_name\nAlice,Smith', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    const text = baseElement.textContent || '';
    expect(text).toContain('first_name');
    expect(text).toContain('last_name');
  });

  // ── New table name input ───────────────────────────────────────────────────

  test('new table name input changes target', () => {
    const mockImport = mock(() => {});
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={mockImport} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name\nAlice', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('New Table'));
    });

    // Type a table name
    const nameInput = baseElement.querySelector('input[placeholder="imported_data"]') as HTMLInputElement;
    act(() => {
      fireEvent.change(nameInput, { target: { value: 'my_custom_table' } });
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Review SQL'));
    });

    // The ready step should show the custom table name
    expect(baseElement.textContent).toContain('my_custom_table');

    act(() => {
      fireEvent.click(within(baseElement).getByText('Execute Import'));
    });

    const sql = (mockImport.mock.calls[0] as unknown[])[0] as string;
    expect(sql).toContain('my_custom_table');
  });

  // ── Drag and drop ─────────────────────────────────────────────────────────

  test('drag over handler is attached to drop zone', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />
    );

    const dropZone = baseElement.querySelector('.border-dashed') as HTMLElement;
    expect(dropZone).not.toBeNull();

    // fireEvent.dragOver triggers React's synthetic onDragOver handler
    // which calls e.preventDefault() — this should not throw
    fireEvent.dragOver(dropZone);

    // Drop zone should still be visible after drag over
    expect(dropZone).not.toBeNull();
  });

  // ── File name display ─────────────────────────────────────────────────────

  test('shows file name in header after upload', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name,age\nAlice,30', 'my_data_file.csv');
    });

    // File name appears in dialog title area
    expect(baseElement.textContent).toContain('my_data_file.csv');
  });

  // ── Copy SQL ──────────────────────────────────────────────────────────────

  test('Copy SQL button calls navigator.clipboard', () => {
    const mockWriteText = mock(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    });

    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name\nAlice', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('New Table'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Review SQL'));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Copy SQL'));
    });

    expect(mockWriteText).toHaveBeenCalledTimes(1);
  });

  // ── Switching between Existing / New ──────────────────────────────────────

  test('toggling between existing and new table modes', () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />
    );

    act(() => {
      simulateFileUpload(baseElement, 'name\nAlice', 'data.csv');
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText('Configure Import'));
    });

    // Default is existing table — select dropdown visible
    expect(baseElement.querySelector('select')).not.toBeNull();

    // Switch to new table
    act(() => {
      fireEvent.click(within(baseElement).getByText('New Table'));
    });

    expect(baseElement.querySelector('input[placeholder="imported_data"]')).not.toBeNull();
    expect(baseElement.querySelector('select')).toBeNull();

    // Switch back to existing table
    act(() => {
      fireEvent.click(within(baseElement).getByText('Existing Table'));
    });

    expect(baseElement.querySelector('select')).not.toBeNull();
  });
});
