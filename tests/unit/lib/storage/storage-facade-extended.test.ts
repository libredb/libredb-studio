import { describe, test, expect, beforeEach } from 'bun:test';

// Ensure `typeof window !== 'undefined'` passes
if (typeof globalThis.window === 'undefined') {
  // @ts-expect-error — minimal window stub
  globalThis.window = globalThis;
}

import { storage } from '@/lib/storage';
import type { QueryHistoryItem, SchemaSnapshot } from '@/lib/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeHistoryItem(overrides: Partial<QueryHistoryItem> = {}): QueryHistoryItem {
  return {
    id: `h-${Math.random().toString(36).slice(2, 8)}`,
    connectionId: 'conn-1',
    query: 'SELECT 1',
    executionTime: 42,
    status: 'success',
    executedAt: new Date(),
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return {
    id: `snap-${Math.random().toString(36).slice(2, 8)}`,
    connectionId: 'conn-1',
    connectionName: 'Test DB',
    databaseType: 'postgres',
    schema: [],
    createdAt: new Date(),
    ...overrides,
  };
}

// ── MongoDB JSON round-trip ─────────────────────────────────────────────────

describe('storage facade: MongoDB JSON round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('MongoDB JSON query survives addToHistory round-trip', () => {
    const mongoQuery = JSON.stringify({
      collection: 'users',
      operation: 'find',
      filter: { status: 'active', age: { $gt: 18 } },
      options: { limit: 50, sort: { name: 1 } },
    });

    storage.addToHistory(makeHistoryItem({ id: 'mongo-1', query: mongoQuery }));
    const history = storage.getHistory();

    expect(history.length).toBe(1);
    expect(history[0].query).toBe(mongoQuery);

    // Verify the inner JSON is valid and parseable
    const parsed = JSON.parse(history[0].query);
    expect(parsed.collection).toBe('users');
    expect(parsed.filter.age.$gt).toBe(18);
  });

  test('nested JSON with special characters round-trips correctly', () => {
    const complexQuery = JSON.stringify({
      collection: 'logs',
      operation: 'aggregate',
      pipeline: [
        { $match: { message: { $regex: 'error.*"fatal"' } } },
        { $group: { _id: '$level', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ],
    });

    storage.addToHistory(makeHistoryItem({ id: 'mongo-2', query: complexQuery }));
    const result = storage.getHistory();

    expect(result[0].query).toBe(complexQuery);
    const parsed = JSON.parse(result[0].query);
    expect(parsed.pipeline.length).toBe(3);
  });

  test('multiple MongoDB queries in history maintain separate JSON integrity', () => {
    const queries = [
      JSON.stringify({ collection: 'users', operation: 'find', filter: {} }),
      JSON.stringify({ collection: 'orders', operation: 'insertOne', document: { item: 'laptop', price: 999.99 } }),
      JSON.stringify({ collection: 'products', operation: 'updateMany', filter: { stock: 0 }, update: { $set: { available: false } } }),
    ];

    queries.forEach((q, i) => {
      storage.addToHistory(makeHistoryItem({ id: `m-${i}`, query: q }));
    });

    const history = storage.getHistory();
    expect(history.length).toBe(3);

    // History is prepended, so reverse order
    for (let i = 0; i < 3; i++) {
      const parsed = JSON.parse(history[i].query);
      expect(parsed.collection).toBeDefined();
      expect(parsed.operation).toBeDefined();
    }
  });

  test('mixed SQL and MongoDB queries in same history', () => {
    storage.addToHistory(makeHistoryItem({ id: 'sql-1', query: 'SELECT * FROM users WHERE name = \'O\'\'Brien\'' }));
    storage.addToHistory(makeHistoryItem({
      id: 'mongo-1',
      query: JSON.stringify({ collection: 'users', operation: 'find', filter: { name: "O'Brien" } }),
    }));
    storage.addToHistory(makeHistoryItem({ id: 'sql-2', query: 'INSERT INTO logs (msg) VALUES (\'{"key": "value"}\')' }));

    const history = storage.getHistory();
    expect(history.length).toBe(3);

    // SQL with embedded JSON string
    expect(history[0].query).toContain('{"key": "value"}');
    // MongoDB JSON
    const mongoParsed = JSON.parse(history[1].query);
    expect(mongoParsed.filter.name).toBe("O'Brien");
    // SQL with quotes
    expect(history[2].query).toContain("O''Brien");
  });

  test('Redis JSON command round-trips correctly', () => {
    const redisQuery = JSON.stringify({
      command: 'SET',
      args: ['mykey', '{"nested": "json", "arr": [1,2,3]}'],
    });

    storage.addToHistory(makeHistoryItem({ id: 'redis-1', query: redisQuery }));
    const result = storage.getHistory();

    expect(result[0].query).toBe(redisQuery);
    const parsed = JSON.parse(result[0].query);
    expect(parsed.command).toBe('SET');
    // The nested JSON in args should also survive
    const nestedJson = JSON.parse(parsed.args[1]);
    expect(nestedJson.nested).toBe('json');
    expect(nestedJson.arr).toEqual([1, 2, 3]);
  });
});

// ── Buffer boundary tests ───────────────────────────────────────────────────

describe('storage facade: history buffer boundary (500)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('trims history to 500 when adding item over limit', () => {
    // Fill to exactly 500
    for (let i = 0; i < 500; i++) {
      storage.addToHistory(makeHistoryItem({ id: `h-${i}` }));
    }
    expect(storage.getHistory().length).toBe(500);

    // Add one more — should trim oldest
    storage.addToHistory(makeHistoryItem({ id: 'h-new' }));
    const history = storage.getHistory();
    expect(history.length).toBe(500);
    expect(history[0].id).toBe('h-new'); // newest first
  });

  test('exactly 500 items are kept without trimming', () => {
    for (let i = 0; i < 500; i++) {
      storage.addToHistory(makeHistoryItem({ id: `h-${i}` }));
    }
    expect(storage.getHistory().length).toBe(500);
  });

  test('oldest items are dropped when buffer overflows', () => {
    // Fill with 500 items
    for (let i = 0; i < 500; i++) {
      storage.addToHistory(makeHistoryItem({ id: `old-${i}` }));
    }

    // Add 3 new items
    for (let i = 0; i < 3; i++) {
      storage.addToHistory(makeHistoryItem({ id: `new-${i}` }));
    }

    const history = storage.getHistory();
    expect(history.length).toBe(500);
    // Newest 3 should be at the top
    expect(history[0].id).toBe('new-2');
    expect(history[1].id).toBe('new-1');
    expect(history[2].id).toBe('new-0');
    // Oldest should be dropped
    expect(history.find((h) => h.id === 'old-0')).toBeUndefined();
    expect(history.find((h) => h.id === 'old-1')).toBeUndefined();
    expect(history.find((h) => h.id === 'old-2')).toBeUndefined();
  });
});

describe('storage facade: schema snapshot buffer boundary (50)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('trims snapshots to 50 when over limit', () => {
    for (let i = 0; i < 50; i++) {
      storage.saveSchemaSnapshot(makeSnapshot({ id: `snap-${i}` }));
    }
    expect(storage.getSchemaSnapshots().length).toBe(50);

    // Add one more
    storage.saveSchemaSnapshot(makeSnapshot({ id: 'snap-new' }));
    const snapshots = storage.getSchemaSnapshots();
    expect(snapshots.length).toBe(50);
    // Oldest should be dropped (sliced from end, keeps last 50)
    expect(snapshots.find((s) => s.id === 'snap-0')).toBeUndefined();
  });

  test('exactly 50 snapshots kept without trimming', () => {
    for (let i = 0; i < 50; i++) {
      storage.saveSchemaSnapshot(makeSnapshot({ id: `snap-${i}` }));
    }
    expect(storage.getSchemaSnapshots().length).toBe(50);
  });
});

describe('storage facade: audit log buffer boundary (1000)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('trims audit log to 1000 events', () => {
    const events = Array.from({ length: 1050 }, (_, i) => ({
      id: `evt-${i}`,
      timestamp: new Date().toISOString(),
      type: 'query_execution' as const,
      action: 'SELECT',
      target: 'users',
      user: 'admin',
      result: 'success' as const,
    }));

    storage.saveAuditLog(events);
    const result = storage.getAuditLog();
    expect(result.length).toBe(1000);
    // Keeps the last 1000 (newest)
    expect(result[0].id).toBe('evt-50');
    expect(result[999].id).toBe('evt-1049');
  });

  test('exactly 1000 events kept without trimming', () => {
    const events = Array.from({ length: 1000 }, (_, i) => ({
      id: `evt-${i}`,
      timestamp: new Date().toISOString(),
      type: 'query_execution' as const,
      action: 'SELECT',
      target: 'users',
      user: 'admin',
      result: 'success' as const,
    }));

    storage.saveAuditLog(events);
    expect(storage.getAuditLog().length).toBe(1000);
  });
});

// ── Delete non-existent ID ──────────────────────────────────────────────────

describe('storage facade: delete non-existent items', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('deleteConnection with non-existent id does not throw', () => {
    expect(() => storage.deleteConnection('non-existent')).not.toThrow();
  });

  test('deleteSavedQuery with non-existent id does not throw', () => {
    expect(() => storage.deleteSavedQuery('non-existent')).not.toThrow();
  });

  test('deleteSchemaSnapshot with non-existent id does not throw', () => {
    expect(() => storage.deleteSchemaSnapshot('non-existent')).not.toThrow();
  });

  test('deleteChart with non-existent id does not throw', () => {
    expect(() => storage.deleteChart('non-existent')).not.toThrow();
  });

  test('deleteConnection does not affect existing items', () => {
    storage.saveConnection({
      id: 'c1', name: 'DB1', type: 'postgres', host: 'localhost', port: 5432, createdAt: new Date(),
    });
    storage.deleteConnection('non-existent');
    expect(storage.getConnections().length).toBe(1);
    expect(storage.getConnections()[0].id).toBe('c1');
  });
});

// ── Event dispatch for all mutation methods ─────────────────────────────────

describe('storage facade: event dispatch completeness', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const mutations: Array<{ name: string; fn: () => void; expectedCollection: string }> = [
    { name: 'clearHistory', fn: () => storage.clearHistory(), expectedCollection: 'history' },
    { name: 'saveQuery', fn: () => storage.saveQuery({ id: 'q1', name: 'Test', query: 'SELECT 1', connectionType: 'postgres', createdAt: new Date(), updatedAt: new Date() }), expectedCollection: 'saved_queries' },
    { name: 'deleteSavedQuery', fn: () => storage.deleteSavedQuery('q1'), expectedCollection: 'saved_queries' },
    { name: 'saveSchemaSnapshot', fn: () => storage.saveSchemaSnapshot(makeSnapshot()), expectedCollection: 'schema_snapshots' },
    { name: 'deleteSchemaSnapshot', fn: () => storage.deleteSchemaSnapshot('snap-1'), expectedCollection: 'schema_snapshots' },
    { name: 'saveChart', fn: () => storage.saveChart({ id: 'ch1', name: 'Chart', chartType: 'bar', xAxis: 'x', yAxis: ['y'], createdAt: new Date() }), expectedCollection: 'saved_charts' },
    { name: 'deleteChart', fn: () => storage.deleteChart('ch1'), expectedCollection: 'saved_charts' },
    { name: 'saveAuditLog', fn: () => storage.saveAuditLog([]), expectedCollection: 'audit_log' },
    { name: 'saveMaskingConfig', fn: () => storage.saveMaskingConfig({ enabled: true, patterns: [], roleSettings: { admin: { canToggle: true, canReveal: true }, user: { canToggle: false, canReveal: false } } }), expectedCollection: 'masking_config' },
    { name: 'saveThresholdConfig', fn: () => storage.saveThresholdConfig([]), expectedCollection: 'threshold_config' },
  ];

  for (const { name, fn, expectedCollection } of mutations) {
    test(`${name} dispatches event for '${expectedCollection}'`, () => {
      let captured: CustomEvent | null = null;
      const handler = (e: Event) => { captured = e as CustomEvent; };
      window.addEventListener('libredb-storage-change', handler);

      fn();

      expect(captured).not.toBeNull();
      expect(captured!.detail.collection).toBe(expectedCollection);

      window.removeEventListener('libredb-storage-change', handler);
    });
  }
});
