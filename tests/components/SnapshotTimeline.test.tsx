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

  test('deselect snapshot by clicking it again', () => {
    const onCompare = mock(() => {});
    const { queryByText } = render(
      <SnapshotTimeline snapshots={snapshots} onCompare={onCompare} onDelete={mock(() => {})} />
    );
    // Select first snapshot
    fireEvent.click(queryByText('Before migration')!);
    // Deselect it by clicking again
    fireEvent.click(queryByText('Before migration')!);
    // Select both to verify onCompare has NOT been called (first was deselected)
    // At this point nothing is selected, so onCompare should not have been called
    expect(onCompare).toHaveBeenCalledTimes(0);
  });

  test('shows "Comparing 2 snapshots" text when 2 selected', () => {
    const { queryByText } = render(
      <SnapshotTimeline snapshots={snapshots} onCompare={mock(() => {})} onDelete={mock(() => {})} />
    );
    // Before selecting, the text should not be present
    expect(queryByText('Comparing 2 snapshots')).toBeNull();
    // Select both snapshots
    fireEvent.click(queryByText('Before migration')!);
    fireEvent.click(queryByText('After migration')!);
    expect(queryByText('Comparing 2 snapshots')).not.toBeNull();
  });

  test('3rd selection replaces first (max 2)', () => {
    const threeSnapshots: SchemaSnapshot[] = [
      { id: 's1', connectionId: 'c1', connectionName: 'prod-db', databaseType: 'postgres', label: 'Snap A', createdAt: new Date('2026-01-10T10:00:00Z'), schema: [{ name: 't1', columns: [], indexes: [] }] },
      { id: 's2', connectionId: 'c1', connectionName: 'prod-db', databaseType: 'postgres', label: 'Snap B', createdAt: new Date('2026-01-15T12:00:00Z'), schema: [{ name: 't1', columns: [], indexes: [] }] },
      { id: 's3', connectionId: 'c1', connectionName: 'prod-db', databaseType: 'postgres', label: 'Snap C', createdAt: new Date('2026-01-20T14:00:00Z'), schema: [{ name: 't1', columns: [], indexes: [] }] },
    ];
    const onCompare = mock((a: string, b: string) => { void a; void b; });
    const { queryByText } = render(
      <SnapshotTimeline snapshots={threeSnapshots} onCompare={onCompare} onDelete={mock(() => {})} />
    );
    // Select first two
    fireEvent.click(queryByText('Snap A')!);
    fireEvent.click(queryByText('Snap B')!);
    expect(onCompare).toHaveBeenCalledTimes(1);
    expect(onCompare).toHaveBeenLastCalledWith('s1', 's2');
    // Select a third — should replace first, keeping s2 and adding s3
    fireEvent.click(queryByText('Snap C')!);
    expect(onCompare).toHaveBeenCalledTimes(2);
    expect(onCompare).toHaveBeenLastCalledWith('s2', 's3');
  });

  test('snapshots are sorted by createdAt ascending', () => {
    const reversedSnapshots: SchemaSnapshot[] = [
      { id: 's-newer', connectionId: 'c1', connectionName: 'prod-db', databaseType: 'postgres', label: 'Newer', createdAt: new Date('2026-02-01T10:00:00Z'), schema: [{ name: 't1', columns: [], indexes: [] }] },
      { id: 's-older', connectionId: 'c1', connectionName: 'prod-db', databaseType: 'postgres', label: 'Older', createdAt: new Date('2026-01-01T10:00:00Z'), schema: [{ name: 't1', columns: [], indexes: [] }] },
    ];
    const { container } = render(
      <SnapshotTimeline snapshots={reversedSnapshots} onCompare={mock(() => {})} onDelete={mock(() => {})} />
    );
    const labels = container.querySelectorAll('.text-\\[10px\\].font-medium');
    expect(labels[0]?.textContent).toBe('Older');
    expect(labels[1]?.textContent).toBe('Newer');
  });

  test('connector line count is n-1 for n snapshots', () => {
    const threeSnapshots: SchemaSnapshot[] = [
      { id: 's1', connectionId: 'c1', connectionName: 'db', databaseType: 'postgres', label: 'A', createdAt: new Date('2026-01-01T00:00:00Z'), schema: [{ name: 't1', columns: [], indexes: [] }] },
      { id: 's2', connectionId: 'c1', connectionName: 'db', databaseType: 'postgres', label: 'B', createdAt: new Date('2026-01-02T00:00:00Z'), schema: [{ name: 't1', columns: [], indexes: [] }] },
      { id: 's3', connectionId: 'c1', connectionName: 'db', databaseType: 'postgres', label: 'C', createdAt: new Date('2026-01-03T00:00:00Z'), schema: [{ name: 't1', columns: [], indexes: [] }] },
    ];
    const { container } = render(
      <SnapshotTimeline snapshots={threeSnapshots} onCompare={mock(() => {})} onDelete={mock(() => {})} />
    );
    // Each snapshot node is a div with min-w-[100px]. Connector divs are inside nodes (not the last one).
    // Connectors have class: absolute top-[7px] left-[50%] w-full h-[2px] bg-white/10
    const connectors = container.querySelectorAll('.top-\\[7px\\].left-\\[50\\%\\]');
    // n-1 connectors for n=3 snapshots
    expect(connectors.length).toBe(2);
  });

  test('label falls back to connectionName when label is empty', () => {
    const noLabelSnapshots: SchemaSnapshot[] = [
      { id: 's1', connectionId: 'c1', connectionName: 'my-fallback-db', databaseType: 'postgres', createdAt: new Date('2026-01-10T10:00:00Z'), schema: [{ name: 't1', columns: [], indexes: [] }] },
    ];
    const { queryByText } = render(
      <SnapshotTimeline snapshots={noLabelSnapshots} onCompare={mock(() => {})} onDelete={mock(() => {})} />
    );
    expect(queryByText('my-fallback-db')).not.toBeNull();
  });

  test('delete button stopPropagation prevents selection change', () => {
    const onCompare = mock(() => {});
    const onDelete = mock(() => {});
    const { container, queryByText } = render(
      <SnapshotTimeline snapshots={snapshots} onCompare={onCompare} onDelete={onDelete} />
    );
    // Click delete on first snapshot — should NOT trigger selection due to stopPropagation
    const deleteButtons = container.querySelectorAll('button');
    fireEvent.click(deleteButtons[0]!);
    // onDelete should fire
    expect(onDelete).toHaveBeenCalledTimes(1);
    // Now select both snapshots — if delete had leaked a selection, we'd need only 1 more click
    // But since stopPropagation works, we still need 2 clicks to trigger onCompare
    fireEvent.click(queryByText('Before migration')!);
    fireEvent.click(queryByText('After migration')!);
    expect(onCompare).toHaveBeenCalledTimes(1);
  });

  test('delete passes correct snapshot id', () => {
    const onDelete = mock((id: string) => { void id; });
    const { container } = render(
      <SnapshotTimeline snapshots={snapshots} onCompare={mock(() => {})} onDelete={onDelete} />
    );
    const deleteButtons = container.querySelectorAll('button');
    // Snapshots are sorted by createdAt ascending: s1 (2026-01-10), s2 (2026-01-15)
    // First delete button corresponds to s1, second to s2
    fireEvent.click(deleteButtons[0]!);
    expect(onDelete).toHaveBeenCalledWith('s1');
    fireEvent.click(deleteButtons[1]!);
    expect(onDelete).toHaveBeenCalledWith('s2');
    expect(onDelete).toHaveBeenCalledTimes(2);
  });
});
