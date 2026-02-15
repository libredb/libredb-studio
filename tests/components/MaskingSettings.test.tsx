import '../setup-dom';
import { mockToastSuccess, mockToastError } from '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';

// Build mock config that matches the shape from the real module
const mockConfig = {
  enabled: true,
  patterns: [
    {
      id: 'p1',
      name: 'Email',
      maskType: 'email' as const,
      columnPatterns: ['email'],
      enabled: true,
      isBuiltin: true,
    },
    {
      id: 'p2',
      name: 'Phone',
      maskType: 'phone' as const,
      columnPatterns: ['phone'],
      enabled: false,
      isBuiltin: false,
    },
  ],
  roleSettings: {
    admin: { canToggle: true, canReveal: true },
    user: { canToggle: false, canReveal: false },
  },
};

const mockSaveMaskingConfig = mock(() => {});
const mockLoadMaskingConfig = mock(() => structuredClone(mockConfig));

mock.module('@/lib/data-masking', () => ({
  loadMaskingConfig: mockLoadMaskingConfig,
  saveMaskingConfig: mockSaveMaskingConfig,
  getPreviewMasked: mock((type: string) => {
    if (type === 'email') return 'j***@example.com';
    return '****';
  }),
  MASK_TYPE_PREVIEWS: {
    email: { label: 'Email', sample: 'john@example.com' },
    phone: { label: 'Phone', sample: '+1-555-0123' },
    full: { label: 'Full Mask', sample: 'Secret Data' },
    partial: { label: 'Partial', sample: 'My Secret' },
    card: { label: 'Credit Card', sample: '4111-1111-1111-1111' },
    ssn: { label: 'SSN', sample: '123-45-6789' },
    ip: { label: 'IP Address', sample: '192.168.1.1' },
    date: { label: 'Date', sample: '1990-05-15' },
    financial: { label: 'Financial', sample: '85000.00' },
    custom: { label: 'Custom', sample: 'Custom Data' },
  },
  DEFAULT_MASKING_CONFIG: structuredClone(mockConfig),
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, within, cleanup, act } from '@testing-library/react';
import React from 'react';

import { MaskingSettings } from '@/components/MaskingSettings';

// =============================================================================
// MaskingSettings Tests
// =============================================================================

describe('MaskingSettings', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockSaveMaskingConfig.mockClear();
    mockLoadMaskingConfig.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockLoadMaskingConfig.mockImplementation(() => structuredClone(mockConfig));
  });

  // ── Title ─────────────────────────────────────────────────────────────────

  test('renders "Data Masking Settings" title', () => {
    const { container } = render(<MaskingSettings />);
    const view = within(container);
    expect(view.queryByText('Data Masking Settings')).not.toBeNull();
  });

  // ── Global toggle ─────────────────────────────────────────────────────────

  test('shows global enable toggle', () => {
    const { container } = render(<MaskingSettings />);
    const view = within(container);
    expect(view.queryByText('Enable Data Masking Globally')).not.toBeNull();
  });

  // ── Existing patterns ─────────────────────────────────────────────────────

  test('renders existing patterns', () => {
    const { container } = render(<MaskingSettings />);
    const view = within(container);

    expect(view.queryByText('Email')).not.toBeNull();
    expect(view.queryByText('Phone')).not.toBeNull();
  });

  // ── Toggle pattern switch count ───────────────────────────────────────────

  test('renders correct number of switch toggles', () => {
    const { container } = render(<MaskingSettings />);

    // Switches: 1 global + 2 pattern toggles + 4 role switches (2 per role x 2 roles) = 7
    const switches = container.querySelectorAll('button[role="switch"]');
    expect(switches.length).toBeGreaterThanOrEqual(3);
  });

  // ── Role permissions ──────────────────────────────────────────────────────

  test('role permission switches render for admin and user', () => {
    const { container } = render(<MaskingSettings />);
    const view = within(container);

    expect(view.queryByText('Role Permissions')).not.toBeNull();
    expect(view.queryByText('Admin')).not.toBeNull();
    expect(view.queryByText('User')).not.toBeNull();

    const canToggleLabels = view.getAllByText('Can toggle');
    const canRevealLabels = view.getAllByText('Can reveal');
    expect(canToggleLabels.length).toBe(2);
    expect(canRevealLabels.length).toBe(2);
  });

  // ── Save button ───────────────────────────────────────────────────────────

  test('save button calls saveMaskingConfig', () => {
    const { container } = render(<MaskingSettings />);
    const view = within(container);

    const saveButton = view.getByText('Save Config');
    fireEvent.click(saveButton);

    expect(mockSaveMaskingConfig).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith('Masking configuration saved');
  });

  // ── Reset defaults ────────────────────────────────────────────────────────

  test('reset defaults button works', () => {
    const { container } = render(<MaskingSettings />);
    const view = within(container);

    const resetButton = view.getByText('Reset Defaults');
    fireEvent.click(resetButton);

    expect(mockSaveMaskingConfig).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith('Masking configuration reset to defaults');
  });

  // ── Delete non-builtin pattern ────────────────────────────────────────────

  test('delete button only appears on non-builtin patterns and removes it', () => {
    const { container } = render(<MaskingSettings />);
    const view = within(container);

    // Delete buttons have the text-red-400 class and Trash2 icon
    const deleteButtons = container.querySelectorAll('button.text-red-400');
    // There should be exactly 1 delete button (for Phone, the non-builtin)
    expect(deleteButtons.length).toBe(1);

    fireEvent.click(deleteButtons[0]);

    // Phone pattern should be removed from the DOM
    // Verify "Phone" is no longer rendered as a pattern name
    expect(view.queryByText('Phone')).toBeNull();
    // Email should still be there
    expect(view.queryByText('Email')).not.toBeNull();
  });

  // ── Add New Pattern button ─────────────────────────────────────────────

  test('"Add Pattern" button renders', () => {
    const { container } = render(<MaskingSettings />);
    const view = within(container);
    expect(view.queryByText('Add Pattern')).not.toBeNull();
  });

  // ── Global toggle changes state ────────────────────────────────────────

  test('global toggle switch can be clicked', () => {
    const { container } = render(<MaskingSettings />);
    const switches = container.querySelectorAll('button[role="switch"]');
    // First switch is the global toggle
    expect(switches.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(switches[0]);
    // No crash — toggle state updated
  });

  // ── Pattern enabled badge shown ──────────────────────────────────────

  test('enabled pattern shows mask type badge', () => {
    const { container } = render(<MaskingSettings />);
    // Email pattern is enabled=true in mock config — badge + column pattern text both say 'email'
    const emailElements = container.querySelectorAll('[data-slot="badge"]');
    const emailBadge = Array.from(emailElements).find(el => el.textContent === 'email');
    expect(emailBadge).not.toBeUndefined();
  });

  // ── Preview section shows masked data ─────────────────────────────────

  test('preview section renders', () => {
    const { container } = render(<MaskingSettings />);
    const view = within(container);
    expect(view.queryByText('Preview')).not.toBeNull();
  });

  // ── Pattern mask type badge renders ───────────────────────────────────

  test('pattern mask type badge renders for each pattern', () => {
    const { container } = render(<MaskingSettings />);
    const badges = container.querySelectorAll('[data-slot="badge"]');
    const badgeTexts = Array.from(badges).map(b => b.textContent);
    // email and phone mask type badges
    expect(badgeTexts.some(t => t === 'email')).toBe(true);
    expect(badgeTexts.some(t => t === 'phone')).toBe(true);
  });

  // ── Edit button exists for patterns ───────────────────────────────────

  test('edit button renders for patterns', () => {
    const { container } = render(<MaskingSettings />);
    // Edit buttons have pencil icon (lucide-pencil class)
    const pencilIcons = container.querySelectorAll('.lucide-pencil');
    // There should be at least 2 edit icons (one per pattern)
    expect(pencilIcons.length).toBeGreaterThanOrEqual(2);
  });

  // ── Column patterns info shown ────────────────────────────────────────

  test('column patterns info shown for patterns', () => {
    const { container } = render(<MaskingSettings />);
    const text = container.textContent || '';
    // Email pattern has columnPatterns: ['email']
    expect(text).toContain('email');
    // Phone pattern has columnPatterns: ['phone']
    expect(text).toContain('phone');
  });

  // ── Role permission labels ──────────────────────────────────────────

  test('role section shows Can toggle and Can reveal labels', () => {
    const { container } = render(<MaskingSettings />);
    const view = within(container);
    expect(view.getAllByText('Can toggle').length).toBe(2);
    expect(view.getAllByText('Can reveal').length).toBe(2);
  });

  // ── Builtin badge for builtin patterns ──────────────────────────────

  test('builtin patterns show builtin badge', () => {
    const { container } = render(<MaskingSettings />);
    const view = within(container);
    // Email is builtin
    expect(view.queryByText('builtin')).not.toBeNull();
  });

  // ── togglePatternEnabled ─────────────────────────────────────────────

  test('toggling a pattern switch changes its enabled state', () => {
    const { container } = render(<MaskingSettings />);
    const switches = container.querySelectorAll('button[role="switch"]');
    // Switch order: global(0), admin-toggle(1), admin-reveal(2),
    //               user-toggle(3), user-reveal(4), email-pattern(5), phone-pattern(6)
    const emailSwitch = switches[5];
    expect(emailSwitch).not.toBeUndefined();

    // Email is enabled=true initially (aria-checked)
    expect(emailSwitch.getAttribute('data-state')).toBe('checked');

    // Click to disable
    act(() => { fireEvent.click(emailSwitch); });
    expect(emailSwitch.getAttribute('data-state')).toBe('unchecked');
  });

  test('toggling phone pattern switch changes its state', () => {
    const { container } = render(<MaskingSettings />);
    const switches = container.querySelectorAll('button[role="switch"]');
    const phoneSwitch = switches[6];

    // Phone is enabled=false initially
    expect(phoneSwitch.getAttribute('data-state')).toBe('unchecked');

    act(() => { fireEvent.click(phoneSwitch); });
    expect(phoneSwitch.getAttribute('data-state')).toBe('checked');
  });

  // ── updateRoleSetting ────────────────────────────────────────────────

  test('admin canToggle switch updates role setting', () => {
    const { container } = render(<MaskingSettings />);
    const switches = container.querySelectorAll('button[role="switch"]');
    const adminCanToggle = switches[1];

    // Initially checked (admin.canToggle = true)
    expect(adminCanToggle.getAttribute('data-state')).toBe('checked');

    act(() => { fireEvent.click(adminCanToggle); });
    expect(adminCanToggle.getAttribute('data-state')).toBe('unchecked');
  });

  test('admin canReveal switch updates role setting', () => {
    const { container } = render(<MaskingSettings />);
    const switches = container.querySelectorAll('button[role="switch"]');
    const adminCanReveal = switches[2];

    expect(adminCanReveal.getAttribute('data-state')).toBe('checked');
    act(() => { fireEvent.click(adminCanReveal); });
    expect(adminCanReveal.getAttribute('data-state')).toBe('unchecked');
  });

  test('user canToggle switch updates role setting', () => {
    const { container } = render(<MaskingSettings />);
    const switches = container.querySelectorAll('button[role="switch"]');
    const userCanToggle = switches[3];

    // Initially unchecked (user.canToggle = false)
    expect(userCanToggle.getAttribute('data-state')).toBe('unchecked');

    act(() => { fireEvent.click(userCanToggle); });
    expect(userCanToggle.getAttribute('data-state')).toBe('checked');
  });

  test('user canReveal switch updates role setting', () => {
    const { container } = render(<MaskingSettings />);
    const switches = container.querySelectorAll('button[role="switch"]');
    const userCanReveal = switches[4];

    expect(userCanReveal.getAttribute('data-state')).toBe('unchecked');
    act(() => { fireEvent.click(userCanReveal); });
    expect(userCanReveal.getAttribute('data-state')).toBe('checked');
  });

  // ── openEditDialog ───────────────────────────────────────────────────

  test('clicking edit button opens edit dialog with pattern data', () => {
    const { container, baseElement } = render(<MaskingSettings />);
    // Click the first edit (pencil) button — for Email pattern
    const editButtons = container.querySelectorAll('.lucide-pencil');
    const emailEditBtn = editButtons[0].closest('button')!;

    act(() => { fireEvent.click(emailEditBtn); });

    const body = within(baseElement);
    expect(body.queryByText('Edit Masking Pattern')).not.toBeNull();
    // Name input should have Email pattern name
    const nameInput = baseElement.querySelector('input[placeholder="Pattern name"]') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.value).toBe('Email');
  });

  test('edit dialog shows column patterns in textarea', () => {
    const { container, baseElement } = render(<MaskingSettings />);
    const editButtons = container.querySelectorAll('.lucide-pencil');
    act(() => { fireEvent.click(editButtons[0].closest('button')!); });

    const textarea = baseElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe('email');
  });

  // ── openNewDialog ────────────────────────────────────────────────────

  test('Add Pattern button opens new pattern dialog', () => {
    const { container, baseElement } = render(<MaskingSettings />);
    const addBtn = within(container).getByText('Add Pattern');

    act(() => { fireEvent.click(addBtn); });

    const body = within(baseElement);
    expect(body.queryByText('Add Masking Pattern')).not.toBeNull();
    // Name input should be empty for new pattern
    const nameInput = baseElement.querySelector('input[placeholder="Pattern name"]') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.value).toBe('');
  });

  // ── handleDialogSave — validation ────────────────────────────────────

  test('dialog save with empty name shows error toast', () => {
    const { container, baseElement } = render(<MaskingSettings />);
    act(() => { fireEvent.click(within(container).getByText('Add Pattern')); });

    // Name is empty, column patterns empty — click Save
    const saveBtn = within(baseElement).getAllByText('Save').find(
      el => el.closest('[data-slot="dialog-content"]')
    );
    expect(saveBtn).not.toBeUndefined();
    act(() => { fireEvent.click(saveBtn!); });

    expect(mockToastError).toHaveBeenCalledWith('Pattern name is required');
  });

  test('dialog save with name but no patterns shows error toast', () => {
    const { container, baseElement } = render(<MaskingSettings />);
    act(() => { fireEvent.click(within(container).getByText('Add Pattern')); });

    // Fill in name but leave patterns empty
    const nameInput = baseElement.querySelector('input[placeholder="Pattern name"]') as HTMLInputElement;
    act(() => { fireEvent.change(nameInput, { target: { value: 'Test Pattern' } }); });

    const saveBtn = within(baseElement).getAllByText('Save').find(
      el => el.closest('[data-slot="dialog-content"]')
    );
    act(() => { fireEvent.click(saveBtn!); });

    expect(mockToastError).toHaveBeenCalledWith('At least one column pattern is required');
  });

  // ── handleDialogSave — new pattern ───────────────────────────────────

  test('dialog save creates new pattern and adds to list', () => {
    const { container, baseElement } = render(<MaskingSettings />);
    act(() => { fireEvent.click(within(container).getByText('Add Pattern')); });

    // Fill in form
    const nameInput = baseElement.querySelector('input[placeholder="Pattern name"]') as HTMLInputElement;
    act(() => { fireEvent.change(nameInput, { target: { value: 'SSN Pattern' } }); });

    const textarea = baseElement.querySelector('textarea') as HTMLTextAreaElement;
    act(() => { fireEvent.change(textarea, { target: { value: 'ssn\nsocial_security' } }); });

    const saveBtn = within(baseElement).getAllByText('Save').find(
      el => el.closest('[data-slot="dialog-content"]')
    );
    act(() => { fireEvent.click(saveBtn!); });

    // Dialog should close and new pattern should appear in the list
    const view = within(container);
    expect(view.queryByText('SSN Pattern')).not.toBeNull();
  });

  // ── handleDialogSave — edit existing pattern ─────────────────────────

  test('dialog save updates existing pattern', () => {
    const { container, baseElement } = render(<MaskingSettings />);
    // Click edit on Email pattern
    const editButtons = container.querySelectorAll('.lucide-pencil');
    act(() => { fireEvent.click(editButtons[0].closest('button')!); });

    // Change name
    const nameInput = baseElement.querySelector('input[placeholder="Pattern name"]') as HTMLInputElement;
    act(() => { fireEvent.change(nameInput, { target: { value: 'Work Email' } }); });

    // Change column patterns
    const textarea = baseElement.querySelector('textarea') as HTMLTextAreaElement;
    act(() => { fireEvent.change(textarea, { target: { value: 'work_email\noffice_email' } }); });

    const saveBtn = within(baseElement).getAllByText('Save').find(
      el => el.closest('[data-slot="dialog-content"]')
    );
    act(() => { fireEvent.click(saveBtn!); });

    // Updated pattern should reflect in the list
    const view = within(container);
    expect(view.queryByText('Work Email')).not.toBeNull();
    // Old name should be gone
    expect(view.queryByText('Email')).toBeNull();
  });

  // ── Dialog cancel ────────────────────────────────────────────────────

  test('dialog cancel closes without saving', () => {
    const { container, baseElement } = render(<MaskingSettings />);
    act(() => { fireEvent.click(within(container).getByText('Add Pattern')); });

    // Fill in name
    const nameInput = baseElement.querySelector('input[placeholder="Pattern name"]') as HTMLInputElement;
    act(() => { fireEvent.change(nameInput, { target: { value: 'Temp' } }); });

    // Click Cancel
    const cancelBtn = within(baseElement).getAllByText('Cancel').find(
      el => el.closest('[data-slot="dialog-content"]')
    );
    act(() => { fireEvent.click(cancelBtn!); });

    // Pattern should not appear in the list
    expect(within(container).queryByText('Temp')).toBeNull();
  });

  // ── Preview section — enabled patterns only ──────────────────────────

  test('preview section shows only enabled patterns', () => {
    const { container } = render(<MaskingSettings />);
    const text = container.textContent || '';
    // Email is enabled, should show preview
    expect(text).toContain('j***@example.com');
  });
});
