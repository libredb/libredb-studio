import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { SnapshotTimeline } from '@/components/SnapshotTimeline';
import type { SchemaSnapshot } from '@/lib/types';

const snapshots: SchemaSnapshot[] = [
  { id: 's1', connectionId: 'c1', connectionName: 'prod-db', databaseType: 'postgres', label: 'Before migration', createdAt: new Date('2026-01-10T10:00:00Z'), schema: [{ name: 't1', columns: [], indexes: [] }, { name: 't2', columns: [], indexes: [] }] },
  { id: 's2', connectionId: 'c1', connectionName: 'prod-db', databaseType: 'postgres', label: 'After migration', createdAt: new Date('2026-01-15T12:00:00Z'), schema: [{ name: 't1', columns: [], indexes: [] }, { name: 't2', columns: [], indexes: [] }, { name: 't3', columns: [], indexes: [] }] },
];

describe('SnapshotTimeline', () => {
  afterEach(() => { cleanup(); });

  test('shows empty state when no snapshots', () => {
    const { queryByText } = render(
      <SnapshotTimeline snapshots={[]} onCompare={mock(() => {})} onDelete={mock(() => {})} />
    );
    expect(queryByText('No snapshots taken yet. Take a snapshot to start tracking schema changes.')).not.toBeNull();
  });

  test('renders timeline dots and labels', () => {
    const { queryByText } = render(
      <SnapshotTimeline snapshots={snapshots} onCompare={mock(() => {})} onDelete={mock(() => {})} />
    );
    expect(queryByText('Before migration')).not.toBeNull();
    expect(queryByText('After migration')).not.toBeNull();
    expect(queryByText('2 tables')).not.toBeNull();
    expect(queryByText('3 tables')).not.toBeNull();
  });

  test('selecting two snapshots triggers onCompare', () => {
    const onCompare = mock((a: string, b: string) => { void a; void b; });
    const { queryByText } = render(
      <SnapshotTimeline snapshots={snapshots} onCompare={onCompare} onDelete={mock(() => {})} />
    );
    fireEvent.click(queryByText('Before migration')!);
    fireEvent.click(queryByText('After migration')!);
    expect(onCompare).toHaveBeenCalledTimes(1);
  });

  test('delete button fires onDelete', () => {
    const onDelete = mock((id: string) => { void id; });
    const { container } = render(
      <SnapshotTimeline snapshots={snapshots} onCompare={mock(() => {})} onDelete={onDelete} />
    );
    const deleteButtons = container.querySelectorAll('button');
    fireEvent.click(deleteButtons[0]!);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
