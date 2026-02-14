import { describe, test, expect } from 'bun:test';

// Ensure `typeof window !== 'undefined'` passes in storage.ts getter guards
if (typeof globalThis.window === 'undefined') {
  // @ts-expect-error — minimal window stub for SSR guard
  globalThis.window = globalThis;
}

import { storage } from '@/lib/storage';
import type {
  DatabaseConnection,
  QueryHistoryItem,
  SavedQuery,
  SchemaSnapshot,
  SavedChartConfig,
} from '@/lib/types';

// ============================================================================
// Helpers — localStorage is cleared by afterEach in tests/setup.ts
// ============================================================================

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'conn-1',
    name: 'Test DB',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeHistoryItem(overrides: Partial<QueryHistoryItem> = {}): QueryHistoryItem {
  return {
    id: 'hist-1',
    connectionId: 'conn-1',
    query: 'SELECT 1',
    executionTime: 42,
    status: 'success',
    executedAt: new Date('2025-06-01'),
    ...overrides,
  };
}

function makeSavedQuery(overrides: Partial<SavedQuery> = {}): SavedQuery {
  return {
    id: 'sq-1',
    name: 'My Query',
    query: 'SELECT * FROM users',
    connectionType: 'postgres',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return {
    id: 'snap-1',
    connectionId: 'conn-1',
    connectionName: 'Test DB',
    databaseType: 'postgres',
    schema: [],
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeChart(overrides: Partial<SavedChartConfig> = {}): SavedChartConfig {
  return {
    id: 'chart-1',
    name: 'Revenue Chart',
    chartType: 'bar',
    xAxis: 'month',
    yAxis: ['revenue'],
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

// ============================================================================
// Connections
// ============================================================================

describe('storage: connections', () => {
  test('getConnections returns empty array when nothing stored', () => {
    expect(storage.getConnections()).toEqual([]);
  });

  test('saveConnection and getConnections round-trip', () => {
    const conn = makeConnection();
    storage.saveConnection(conn);
    const result = storage.getConnections();
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('conn-1');
    expect(result[0].name).toBe('Test DB');
    expect(result[0].createdAt).toBeInstanceOf(Date);
  });

  test('saveConnection updates existing connection by id', () => {
    storage.saveConnection(makeConnection());
    storage.saveConnection(makeConnection({ name: 'Updated DB' }));
    const result = storage.getConnections();
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('Updated DB');
  });

  test('deleteConnection removes by id', () => {
    storage.saveConnection(makeConnection({ id: 'a' }));
    storage.saveConnection(makeConnection({ id: 'b' }));
    storage.deleteConnection('a');
    const result = storage.getConnections();
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('b');
  });
});

// ============================================================================
// History
// ============================================================================

describe('storage: history', () => {
  test('getHistory returns empty array initially', () => {
    expect(storage.getHistory()).toEqual([]);
  });

  test('addToHistory prepends item', () => {
    storage.addToHistory(makeHistoryItem({ id: 'h1' }));
    storage.addToHistory(makeHistoryItem({ id: 'h2' }));
    const result = storage.getHistory();
    expect(result.length).toBe(2);
    expect(result[0].id).toBe('h2'); // most recent first
  });

  test('addToHistory trims to MAX_HISTORY_ITEMS (500)', () => {
    for (let i = 0; i < 510; i++) {
      storage.addToHistory(makeHistoryItem({ id: `h-${i}` }));
    }
    const result = storage.getHistory();
    expect(result.length).toBe(500);
  });

  test('clearHistory empties the list', () => {
    storage.addToHistory(makeHistoryItem());
    storage.clearHistory();
    expect(storage.getHistory()).toEqual([]);
  });
});

// ============================================================================
// Saved Queries
// ============================================================================

describe('storage: saved queries', () => {
  test('getSavedQueries returns empty array initially', () => {
    expect(storage.getSavedQueries()).toEqual([]);
  });

  test('saveQuery adds new query', () => {
    storage.saveQuery(makeSavedQuery());
    const result = storage.getSavedQueries();
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('My Query');
  });

  test('saveQuery updates existing query by id', () => {
    storage.saveQuery(makeSavedQuery());
    storage.saveQuery(makeSavedQuery({ name: 'Updated Query' }));
    const result = storage.getSavedQueries();
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('Updated Query');
  });

  test('deleteSavedQuery removes by id', () => {
    storage.saveQuery(makeSavedQuery({ id: 'a' }));
    storage.saveQuery(makeSavedQuery({ id: 'b' }));
    storage.deleteSavedQuery('a');
    const result = storage.getSavedQueries();
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('b');
  });
});

// ============================================================================
// Schema Snapshots
// ============================================================================

describe('storage: schema snapshots', () => {
  test('getSchemaSnapshots returns empty array initially', () => {
    expect(storage.getSchemaSnapshots()).toEqual([]);
  });

  test('saveSchemaSnapshot adds snapshot', () => {
    storage.saveSchemaSnapshot(makeSnapshot());
    const result = storage.getSchemaSnapshots();
    expect(result.length).toBe(1);
  });

  test('saveSchemaSnapshot trims to MAX_SNAPSHOTS (50)', () => {
    for (let i = 0; i < 55; i++) {
      storage.saveSchemaSnapshot(makeSnapshot({ id: `snap-${i}` }));
    }
    const result = storage.getSchemaSnapshots();
    expect(result.length).toBe(50);
  });

  test('deleteSchemaSnapshot removes by id', () => {
    storage.saveSchemaSnapshot(makeSnapshot({ id: 's1' }));
    storage.saveSchemaSnapshot(makeSnapshot({ id: 's2' }));
    storage.deleteSchemaSnapshot('s1');
    const result = storage.getSchemaSnapshots();
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('s2');
  });

  test('getSchemaSnapshots filters by connectionId', () => {
    storage.saveSchemaSnapshot(makeSnapshot({ id: 's1', connectionId: 'c1' }));
    storage.saveSchemaSnapshot(makeSnapshot({ id: 's2', connectionId: 'c2' }));
    const filtered = storage.getSchemaSnapshots('c1');
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe('s1');
  });

  test('getSchemaSnapshots returns all when no connectionId filter', () => {
    storage.saveSchemaSnapshot(makeSnapshot({ id: 's1', connectionId: 'c1' }));
    storage.saveSchemaSnapshot(makeSnapshot({ id: 's2', connectionId: 'c2' }));
    const all = storage.getSchemaSnapshots();
    expect(all.length).toBe(2);
  });
});

// ============================================================================
// Charts
// ============================================================================

describe('storage: charts', () => {
  test('getSavedCharts returns empty array initially', () => {
    expect(storage.getSavedCharts()).toEqual([]);
  });

  test('saveChart adds new chart', () => {
    storage.saveChart(makeChart());
    const result = storage.getSavedCharts();
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('Revenue Chart');
  });

  test('saveChart updates existing chart by id', () => {
    storage.saveChart(makeChart());
    storage.saveChart(makeChart({ name: 'Updated Chart' }));
    const result = storage.getSavedCharts();
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('Updated Chart');
  });

  test('deleteChart removes by id', () => {
    storage.saveChart(makeChart({ id: 'a' }));
    storage.saveChart(makeChart({ id: 'b' }));
    storage.deleteChart('a');
    const result = storage.getSavedCharts();
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('b');
  });
});

// ============================================================================
// Active Connection ID
// ============================================================================

describe('storage: active connection ID', () => {
  test('getActiveConnectionId returns null initially', () => {
    expect(storage.getActiveConnectionId()).toBeNull();
  });

  test('setActiveConnectionId stores and retrieves value', () => {
    storage.setActiveConnectionId('conn-42');
    expect(storage.getActiveConnectionId()).toBe('conn-42');
  });

  test('setActiveConnectionId(null) clears the value', () => {
    storage.setActiveConnectionId('conn-42');
    storage.setActiveConnectionId(null);
    expect(storage.getActiveConnectionId()).toBeNull();
  });
});

// ============================================================================
// Broken JSON handling
// ============================================================================

describe('storage: broken JSON', () => {
  test('getConnections returns empty array on invalid JSON', () => {
    localStorage.setItem('orchids_db_connections', 'not-json{{{');
    expect(storage.getConnections()).toEqual([]);
  });

  test('getHistory returns empty array on invalid JSON', () => {
    localStorage.setItem('orchids_db_history', '{bad');
    expect(storage.getHistory()).toEqual([]);
  });

  test('getSavedQueries returns empty array on invalid JSON', () => {
    localStorage.setItem('orchids_db_saved', 'nope');
    expect(storage.getSavedQueries()).toEqual([]);
  });

  test('getSchemaSnapshots returns empty array on invalid JSON', () => {
    localStorage.setItem('libredb_schema_snapshots', '[[invalid');
    expect(storage.getSchemaSnapshots()).toEqual([]);
  });

  test('getSavedCharts returns empty array on invalid JSON', () => {
    localStorage.setItem('libredb_saved_charts', 'corrupt');
    expect(storage.getSavedCharts()).toEqual([]);
  });
});
