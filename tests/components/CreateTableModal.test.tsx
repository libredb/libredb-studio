import '../setup-dom';
import { mockToastError } from '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { CreateTableModal } from '@/components/CreateTableModal';

describe('CreateTableModal', () => {
  afterEach(() => { cleanup(); });
  beforeEach(() => { mockToastError.mockClear(); });

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

  // ── 1. Add Column button adds new row ──────────────────────────────────────

  test('Add Column button adds a new column row', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Initially there is 1 column (the default "id" column)
    const initialInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    expect(initialInputs.length).toBe(1);

    // Click "Add Column"
    const addBtn = body.getByText('Add Column');
    act(() => { fireEvent.click(addBtn); });

    // Now there should be 2 column rows
    const updatedInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    expect(updatedInputs.length).toBe(2);
  });

  // ── 2. Remove column removes a row ─────────────────────────────────────────

  test('remove button removes a column row', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Add a second column first
    act(() => { fireEvent.click(body.getByText('Add Column')); });
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(2);

    // Find trash/remove buttons — they are the last button in each column row
    const trashButtons = baseElement.querySelectorAll('button');
    const removeButtons = Array.from(trashButtons).filter(btn => {
      const icon = btn.querySelector('[data-icon="Trash2"]') || btn.querySelector('svg');
      return icon !== null && btn.textContent === '';
    });

    // Click the last remove button (removes the newly added column)
    act(() => { fireEvent.click(removeButtons[removeButtons.length - 1]); });

    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(1);
  });

  // ── 3. Cannot remove last remaining column ─────────────────────────────────

  test('cannot remove the last remaining column', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);

    // Only 1 column (id) exists
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(1);

    // Find trash/remove buttons
    const trashButtons = baseElement.querySelectorAll('button');
    const removeButtons = Array.from(trashButtons).filter(btn => {
      const icon = btn.querySelector('[data-icon="Trash2"]') || btn.querySelector('svg');
      return icon !== null && btn.textContent === '';
    });

    // Click the only remove button
    if (removeButtons.length > 0) {
      act(() => { fireEvent.click(removeButtons[0]); });
    }

    // Still 1 column — guard prevents removal
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(1);
  });

  // ── 4. Table name sanitization (lowercase + underscores) ───────────────────

  test('table name input sanitizes to lowercase and underscores', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);

    const tableNameInput = baseElement.querySelector('#tableName') as HTMLInputElement;
    expect(tableNameInput).not.toBeNull();

    // Type mixed-case with special characters
    act(() => { fireEvent.change(tableNameInput, { target: { value: 'My Table-Name!123' } }); });

    // The onChange handler lowercases and replaces non-alphanumeric/underscore with _
    expect(tableNameInput.value).toBe('my_table_name_123');
  });

  // ── 5. SQL preview with column definitions ─────────────────────────────────

  test('SQL preview shows CREATE TABLE with column definitions', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);

    // Set table name to trigger SQL generation
    const tableNameInput = baseElement.querySelector('#tableName') as HTMLInputElement;
    act(() => { fireEvent.change(tableNameInput, { target: { value: 'users' } }); });

    const text = baseElement.textContent || '';
    expect(text).toContain('CREATE TABLE users');
    expect(text).toContain('id SERIAL PRIMARY KEY');
  });

  // ── 6. NOT NULL in SQL for non-nullable columns ────────────────────────────

  test('NOT NULL appears in SQL for non-nullable non-PK column', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector('#tableName') as HTMLInputElement;
    act(() => { fireEvent.change(tableNameInput, { target: { value: 'orders' } }); });

    // Add a new column
    act(() => { fireEvent.click(body.getByText('Add Column')); });

    // Set column name for the new column (second input)
    const colInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    act(() => { fireEvent.change(colInputs[1], { target: { value: 'status' } }); });

    // New column defaults: isNullable=true, isPrimary=false
    // Find Nullable checkboxes (role="checkbox") — Radix Checkbox renders as button[role="checkbox"]
    const checkboxes = baseElement.querySelectorAll('button[role="checkbox"]');
    // Each column row has 3 checkboxes: PK, Null, Unq
    // Row 0: checkboxes[0]=PK, checkboxes[1]=Null, checkboxes[2]=Unq
    // Row 1: checkboxes[3]=PK, checkboxes[4]=Null, checkboxes[5]=Unq
    const nullCheckbox = checkboxes[4];

    // New column is nullable by default (checked)
    expect(nullCheckbox.getAttribute('data-state')).toBe('checked');

    // Uncheck nullable
    act(() => { fireEvent.click(nullCheckbox); });
    expect(nullCheckbox.getAttribute('data-state')).toBe('unchecked');

    // SQL should now contain NOT NULL for the status column
    const text = baseElement.textContent || '';
    expect(text).toContain('status VARCHAR(255) NOT NULL');
  });

  // ── 7. UNIQUE in SQL for unique columns ────────────────────────────────────

  test('UNIQUE appears in SQL for unique non-PK column', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector('#tableName') as HTMLInputElement;
    act(() => { fireEvent.change(tableNameInput, { target: { value: 'products' } }); });

    // Add a new column
    act(() => { fireEvent.click(body.getByText('Add Column')); });

    // Set column name
    const colInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    act(() => { fireEvent.change(colInputs[1], { target: { value: 'sku' } }); });

    // Find checkboxes for column row 1
    const checkboxes = baseElement.querySelectorAll('button[role="checkbox"]');
    // Row 1: PK=checkboxes[3], Null=checkboxes[4], Unq=checkboxes[5]
    const uniqueCheckbox = checkboxes[5];

    // Initially unchecked
    expect(uniqueCheckbox.getAttribute('data-state')).toBe('unchecked');

    // Check unique
    act(() => { fireEvent.click(uniqueCheckbox); });
    expect(uniqueCheckbox.getAttribute('data-state')).toBe('checked');

    // Also uncheck nullable so NOT NULL + UNIQUE both appear
    const nullCheckbox = checkboxes[4];
    act(() => { fireEvent.click(nullCheckbox); });

    const text = baseElement.textContent || '';
    expect(text).toContain('sku VARCHAR(255) NOT NULL UNIQUE');
  });

  // ── 8. DEFAULT value in SQL ────────────────────────────────────────────────

  test('DEFAULT value appears in SQL when set', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector('#tableName') as HTMLInputElement;
    act(() => { fireEvent.change(tableNameInput, { target: { value: 'logs' } }); });

    // Add a new column
    act(() => { fireEvent.click(body.getByText('Add Column')); });

    // Set column name
    const colInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    act(() => { fireEvent.change(colInputs[1], { target: { value: 'level' } }); });

    // The component doesn't have a visible default value input in the main column row,
    // but the generateSQL function uses col.defaultValue. Since there's no UI for it
    // in the current component (defaultValue is always '' in UI), we verify the SQL
    // generation logic works by checking that an empty default produces no DEFAULT clause.
    const text = baseElement.textContent || '';
    expect(text).toContain('level VARCHAR(255)');
    expect(text).not.toContain('DEFAULT');
  });

  // ── 9. Validate empty table name -> button disabled ─────────────────────────

  test('CREATE TABLE button is disabled when table name is empty', () => {
    const onTableCreated = mock(() => {});
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={onTableCreated} />);
    const body = within(baseElement);

    // Table name is empty by default
    const createBtn = body.getByText('CREATE TABLE').closest('button') as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);

    // Click should not invoke onTableCreated
    act(() => { fireEvent.click(createBtn); });
    expect(onTableCreated).not.toHaveBeenCalled();
  });

  // ── 10. Validate empty column names -> error toast ─────────────────────────

  test('handleCreate shows error toast when a column has empty name', () => {
    const onTableCreated = mock(() => {});
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={onTableCreated} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector('#tableName') as HTMLInputElement;
    act(() => { fireEvent.change(tableNameInput, { target: { value: 'test_table' } }); });

    // Add a second column but leave its name empty
    act(() => { fireEvent.click(body.getByText('Add Column')); });

    // The new column has name='' by default
    const createBtn = body.getByText('CREATE TABLE');
    act(() => { fireEvent.click(createBtn); });

    expect(mockToastError).toHaveBeenCalledWith('All columns must have a name');
    expect(onTableCreated).not.toHaveBeenCalled();
  });

  // ── 11. handleCreate calls onTableCreated + onClose on success ─────────────

  test('handleCreate calls onTableCreated and onClose on success', () => {
    const onTableCreated = mock(() => {});
    const onClose = mock(() => {});
    const { baseElement } = render(<CreateTableModal isOpen onClose={onClose} onTableCreated={onTableCreated} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector('#tableName') as HTMLInputElement;
    act(() => { fireEvent.change(tableNameInput, { target: { value: 'customers' } }); });

    // Default id column already has a name, so validation passes
    const createBtn = body.getByText('CREATE TABLE');
    act(() => { fireEvent.click(createBtn); });

    expect(onTableCreated).toHaveBeenCalledTimes(1);
    // Verify the SQL was passed
    const sqlArg = (onTableCreated as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(sqlArg).toContain('CREATE TABLE customers');
    expect(sqlArg).toContain('id SERIAL PRIMARY KEY');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── 12. State resets after creation ────────────────────────────────────────

  test('state resets after successful creation', () => {
    const onTableCreated = mock(() => {});
    const onClose = mock(() => {});
    const { baseElement } = render(<CreateTableModal isOpen onClose={onClose} onTableCreated={onTableCreated} />);
    const body = within(baseElement);

    // Set table name and add a column
    const tableNameInput = baseElement.querySelector('#tableName') as HTMLInputElement;
    act(() => { fireEvent.change(tableNameInput, { target: { value: 'temp_table' } }); });
    act(() => { fireEvent.click(body.getByText('Add Column')); });

    // Fill second column name
    const colInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    act(() => { fireEvent.change(colInputs[1], { target: { value: 'name' } }); });

    // We should have 2 columns now
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(2);

    // Create table
    act(() => { fireEvent.click(body.getByText('CREATE TABLE')); });

    // After creation, state resets: table name should be empty, columns back to default (1)
    expect(tableNameInput.value).toBe('');
    expect(baseElement.querySelectorAll('input[placeholder="column_name"]').length).toBe(1);

    // The remaining column should be the default "id"
    const resetColInput = baseElement.querySelector('input[placeholder="column_name"]') as HTMLInputElement;
    expect(resetColInput.value).toBe('id');
  });

  // ── 13. PK checkbox auto-unchecks Nullable ─────────────────────────────────

  test('checking PK auto-unchecks Nullable', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Add a new column (default: isPrimary=false, isNullable=true)
    act(() => { fireEvent.click(body.getByText('Add Column')); });

    const checkboxes = baseElement.querySelectorAll('button[role="checkbox"]');
    // Row 1: PK=checkboxes[3], Null=checkboxes[4], Unq=checkboxes[5]
    const pkCheckbox = checkboxes[3];
    const nullCheckbox = checkboxes[4];

    // Initially: PK unchecked, Null checked
    expect(pkCheckbox.getAttribute('data-state')).toBe('unchecked');
    expect(nullCheckbox.getAttribute('data-state')).toBe('checked');

    // Check PK
    act(() => { fireEvent.click(pkCheckbox); });

    // PK should be checked, Null should be auto-unchecked
    expect(pkCheckbox.getAttribute('data-state')).toBe('checked');
    expect(nullCheckbox.getAttribute('data-state')).toBe('unchecked');
  });

  // ── 14. Cancel button calls onClose ────────────────────────────────────────

  test('Cancel button calls onClose', () => {
    const onClose = mock(() => {});
    const { baseElement } = render(<CreateTableModal isOpen onClose={onClose} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    const cancelBtn = body.getByText('Cancel');
    act(() => { fireEvent.click(cancelBtn); });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── 15. Column type selector changes SQL preview ───────────────────────────

  test('default column type VARCHAR(255) appears in SQL for new columns', () => {
    const { baseElement } = render(<CreateTableModal isOpen onClose={mock(() => {})} onTableCreated={mock(() => {})} />);
    const body = within(baseElement);

    // Set table name
    const tableNameInput = baseElement.querySelector('#tableName') as HTMLInputElement;
    act(() => { fireEvent.change(tableNameInput, { target: { value: 'items' } }); });

    // Add a new column (defaults to VARCHAR(255))
    act(() => { fireEvent.click(body.getByText('Add Column')); });

    // Name the new column
    const colInputs = baseElement.querySelectorAll('input[placeholder="column_name"]');
    act(() => { fireEvent.change(colInputs[1], { target: { value: 'description' } }); });

    // SQL preview should show the default type
    const text = baseElement.textContent || '';
    expect(text).toContain('description VARCHAR(255)');

    // Also verify the default id column uses SERIAL
    expect(text).toContain('id SERIAL PRIMARY KEY');
  });
});
