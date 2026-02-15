import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { describe, test, expect, mock, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { QueryToolbar } from '@/components/studio/QueryToolbar';
import { mockPostgresConnection } from '../../fixtures/connections';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';

// =============================================================================
// QueryToolbar Tests
// =============================================================================

const sqlMetadata: ProviderMetadata = {
  capabilities: {
    queryLanguage: 'sql',
    supportsExplain: true,
    supportsExternalQueryLimiting: true,
    supportsCreateTable: true,
    supportsMaintenance: false,
    maintenanceOperations: [],
    supportsConnectionString: false,
    defaultPort: 5432,
    schemaRefreshPattern: '',
  },
  labels: {
    entityName: 'table',
    entityNamePlural: 'tables',
    rowName: 'row',
    rowNamePlural: 'rows',
    selectAction: 'SELECT * FROM',
    generateAction: 'Generate',
    analyzeAction: 'Analyze',
    vacuumAction: 'Vacuum',
    searchPlaceholder: 'Search tables...',
    analyzeGlobalLabel: 'Analyze All',
    analyzeGlobalTitle: 'Analyze All Tables',
    analyzeGlobalDesc: 'Update statistics for all tables',
    vacuumGlobalLabel: 'Vacuum All',
    vacuumGlobalTitle: 'Vacuum All Tables',
    vacuumGlobalDesc: 'Reclaim storage for all tables',
  },
};

function createDefaultProps(overrides: Record<string, unknown> = {}) {
  return {
    activeConnection: mockPostgresConnection,
    metadata: sqlMetadata,
    isExecuting: false,
    playgroundMode: false,
    transactionActive: false,
    editingEnabled: false,
    onSaveQuery: mock(() => {}),
    onExecuteQuery: mock(() => {}),
    onCancelQuery: mock(() => {}),
    onBeginTransaction: mock(() => {}),
    onCommitTransaction: mock(() => {}),
    onRollbackTransaction: mock(() => {}),
    onTogglePlayground: mock(() => {}),
    onToggleEditing: mock(() => {}),
    onImport: mock(() => {}),
    ...overrides,
  };
}

describe('QueryToolbar', () => {
  afterEach(() => {
    cleanup();
  });

  test('Run button shown when not executing', () => {
    const props = createDefaultProps({ isExecuting: false });
    const { queryByText } = render(<QueryToolbar {...props} />);

    expect(queryByText('RUN')).not.toBeNull();
    expect(queryByText('CANCEL')).toBeNull();
  });

  test('Cancel button shown when executing', () => {
    const props = createDefaultProps({ isExecuting: true });
    const { queryByText } = render(<QueryToolbar {...props} />);

    expect(queryByText('CANCEL')).not.toBeNull();
    expect(queryByText('RUN')).toBeNull();
  });

  test('Transaction BEGIN button visible when not in transaction', () => {
    const props = createDefaultProps({ transactionActive: false });
    const { queryByText } = render(<QueryToolbar {...props} />);

    expect(queryByText('BEGIN')).not.toBeNull();
    expect(queryByText('COMMIT')).toBeNull();
    expect(queryByText('ROLLBACK')).toBeNull();
  });

  test('COMMIT/ROLLBACK shown when transactionActive', () => {
    const props = createDefaultProps({ transactionActive: true });
    const { queryByText } = render(<QueryToolbar {...props} />);

    expect(queryByText('COMMIT')).not.toBeNull();
    expect(queryByText('ROLLBACK')).not.toBeNull();
    expect(queryByText('TXN')).not.toBeNull();
    // BEGIN should not be shown when transaction is active
    expect(queryByText('BEGIN')).toBeNull();
  });

  test('Sandbox button highlights when playgroundMode true', () => {
    const { queryByText } = render(<QueryToolbar {...createDefaultProps({ playgroundMode: true })} />);

    // The sandbox mode banner should be shown
    expect(queryByText(/Sandbox Mode/)).not.toBeNull();

    // Find SANDBOX button and check it has the highlighted class
    const sandboxText = queryByText('SANDBOX');
    expect(sandboxText).not.toBeNull();
    const sandboxButton = sandboxText!.closest('button');
    expect(sandboxButton).not.toBeNull();
    expect(sandboxButton?.className.includes('text-emerald-400')).toBe(true);
  });

  test('Edit button highlights when editingEnabled true', () => {
    const { queryByText } = render(<QueryToolbar {...createDefaultProps({ editingEnabled: true })} />);

    const editText = queryByText('EDIT');
    expect(editText).not.toBeNull();
    const editButton = editText!.closest('button');
    expect(editButton).not.toBeNull();
    expect(editButton?.className.includes('text-amber-400')).toBe(true);
  });

  test('Run button disabled when no activeConnection', () => {
    const props = createDefaultProps({ activeConnection: null });
    const { queryByText } = render(<QueryToolbar {...props} />);

    const runText = queryByText('RUN');
    expect(runText).not.toBeNull();
    const runButton = runText!.closest('button');
    expect(runButton).not.toBeNull();
    expect(runButton?.disabled).toBe(true);
  });

  test('callbacks fire correctly on click', () => {
    const onExecuteQuery = mock(() => {});
    const onCancelQuery = mock(() => {});
    const onSaveQuery = mock(() => {});
    const onBeginTransaction = mock(() => {});
    const onTogglePlayground = mock(() => {});
    const onToggleEditing = mock(() => {});

    // Test Run button and other action buttons
    const props = createDefaultProps({
      onExecuteQuery,
      onCancelQuery,
      onSaveQuery,
      onBeginTransaction,
      onTogglePlayground,
      onToggleEditing,
    });
    const { getByText, unmount } = render(<QueryToolbar {...props} />);

    // Click RUN
    fireEvent.click(getByText('RUN').closest('button')!);
    expect(onExecuteQuery).toHaveBeenCalledTimes(1);

    // Click Save
    fireEvent.click(getByText('Save').closest('button')!);
    expect(onSaveQuery).toHaveBeenCalledTimes(1);

    // Click BEGIN
    fireEvent.click(getByText('BEGIN').closest('button')!);
    expect(onBeginTransaction).toHaveBeenCalledTimes(1);

    // Click SANDBOX
    fireEvent.click(getByText('SANDBOX').closest('button')!);
    expect(onTogglePlayground).toHaveBeenCalledTimes(1);

    // Click EDIT
    fireEvent.click(getByText('EDIT').closest('button')!);
    expect(onToggleEditing).toHaveBeenCalledTimes(1);

    unmount();

    // Test Cancel button (requires isExecuting=true)
    const cancelProps = createDefaultProps({ isExecuting: true, onCancelQuery });
    const result2 = render(<QueryToolbar {...cancelProps} />);
    fireEvent.click(result2.getByText('CANCEL').closest('button')!);
    expect(onCancelQuery).toHaveBeenCalledTimes(1);
  });

  // ===========================================================================
  // Additional coverage tests
  // ===========================================================================

  test('Playground mode banner text when playgroundMode=true', () => {
    const props = createDefaultProps({ playgroundMode: true });
    const { queryByText } = render(<QueryToolbar {...props} />);

    expect(queryByText(/Sandbox Mode/)).not.toBeNull();
    expect(queryByText(/All changes will be auto-rolled back/)).not.toBeNull();
  });

  test('Banner hidden when playgroundMode=false', () => {
    const props = createDefaultProps({ playgroundMode: false });
    const { queryByText } = render(<QueryToolbar {...props} />);

    expect(queryByText(/Sandbox Mode/)).toBeNull();
    expect(queryByText(/All changes will be auto-rolled back/)).toBeNull();
  });

  test('BEGIN button disabled when playgroundMode=true', () => {
    const props = createDefaultProps({ playgroundMode: true, transactionActive: false });
    const { queryByText } = render(<QueryToolbar {...props} />);

    const beginText = queryByText('BEGIN');
    expect(beginText).not.toBeNull();
    const beginButton = beginText!.closest('button');
    expect(beginButton).not.toBeNull();
    expect(beginButton?.disabled).toBe(true);
  });

  test('SANDBOX button disabled when transactionActive=true', () => {
    const props = createDefaultProps({ transactionActive: true });
    const { queryByText } = render(<QueryToolbar {...props} />);

    const sandboxText = queryByText('SANDBOX');
    expect(sandboxText).not.toBeNull();
    const sandboxButton = sandboxText!.closest('button');
    expect(sandboxButton).not.toBeNull();
    expect(sandboxButton?.disabled).toBe(true);
  });

  test('COMMIT callback fires', () => {
    const onCommitTransaction = mock(() => {});
    const props = createDefaultProps({ transactionActive: true, onCommitTransaction });
    const { getByText } = render(<QueryToolbar {...props} />);

    fireEvent.click(getByText('COMMIT').closest('button')!);
    expect(onCommitTransaction).toHaveBeenCalledTimes(1);
  });

  test('ROLLBACK callback fires', () => {
    const onRollbackTransaction = mock(() => {});
    const props = createDefaultProps({ transactionActive: true, onRollbackTransaction });
    const { getByText } = render(<QueryToolbar {...props} />);

    fireEvent.click(getByText('ROLLBACK').closest('button')!);
    expect(onRollbackTransaction).toHaveBeenCalledTimes(1);
  });

  test('IMPORT button callback fires', () => {
    const onImport = mock(() => {});
    const props = createDefaultProps({ onImport });
    const { getByText } = render(<QueryToolbar {...props} />);

    fireEvent.click(getByText('IMPORT').closest('button')!);
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  test('No transaction controls when activeConnection=null', () => {
    const props = createDefaultProps({ activeConnection: null });
    const { queryByText } = render(<QueryToolbar {...props} />);

    expect(queryByText('BEGIN')).toBeNull();
    expect(queryByText('SANDBOX')).toBeNull();
    expect(queryByText('EDIT')).toBeNull();
    expect(queryByText('IMPORT')).toBeNull();
  });

  test('No transaction controls when metadata=null', () => {
    const props = createDefaultProps({ metadata: null });
    const { queryByText } = render(<QueryToolbar {...props} />);

    expect(queryByText('BEGIN')).toBeNull();
    expect(queryByText('SANDBOX')).toBeNull();
    expect(queryByText('EDIT')).toBeNull();
    expect(queryByText('IMPORT')).toBeNull();
  });

  test('No transaction controls for non-SQL queryLanguage', () => {
    const mongoMetadata: ProviderMetadata = {
      capabilities: {
        ...sqlMetadata.capabilities,
        queryLanguage: 'json',
      },
      labels: {
        ...sqlMetadata.labels,
        entityName: 'collection',
        entityNamePlural: 'collections',
      },
    };
    const props = createDefaultProps({ metadata: mongoMetadata });
    const { queryByText } = render(<QueryToolbar {...props} />);

    expect(queryByText('BEGIN')).toBeNull();
    expect(queryByText('SANDBOX')).toBeNull();
    expect(queryByText('EDIT')).toBeNull();
    expect(queryByText('IMPORT')).toBeNull();
  });

  test('Query label always shown', () => {
    // With connection
    const props1 = createDefaultProps();
    const { queryByText: q1 } = render(<QueryToolbar {...props1} />);
    expect(q1('Query')).not.toBeNull();
    cleanup();

    // Without connection
    const props2 = createDefaultProps({ activeConnection: null });
    const { queryByText: q2 } = render(<QueryToolbar {...props2} />);
    expect(q2('Query')).not.toBeNull();
    cleanup();

    // Without metadata
    const props3 = createDefaultProps({ metadata: null });
    const { queryByText: q3 } = render(<QueryToolbar {...props3} />);
    expect(q3('Query')).not.toBeNull();
  });
});
