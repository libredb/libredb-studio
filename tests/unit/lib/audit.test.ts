import { describe, test, expect, beforeEach } from 'bun:test';
import {
  AuditRingBuffer,
  type AuditEvent,
  type AuditEventType,
  loadAuditFromStorage,
  saveAuditToStorage,
} from '@/lib/audit';

describe('AuditRingBuffer', () => {
  let buffer: AuditRingBuffer;

  beforeEach(() => {
    buffer = new AuditRingBuffer(10);
  });

  // ==========================================================================
  // push
  // ==========================================================================

  describe('push', () => {
    test('generates id and timestamp on pushed event', () => {
      const result = buffer.push({
        type: 'query_execution',
        action: 'execute',
        target: 'users',
        user: 'admin',
        result: 'success',
      });

      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
      expect(result.timestamp).toBeDefined();
      // ISO date string format check
      expect(() => new Date(result.timestamp)).not.toThrow();
    });

    test('returns the full AuditEvent with all fields', () => {
      const result = buffer.push({
        type: 'maintenance',
        action: 'vacuum',
        target: 'orders',
        connectionName: 'prod-db',
        user: 'admin',
        result: 'success',
        duration: 1500,
        details: 'Vacuum completed',
      });

      expect(result.type).toBe('maintenance');
      expect(result.action).toBe('vacuum');
      expect(result.target).toBe('orders');
      expect(result.connectionName).toBe('prod-db');
      expect(result.user).toBe('admin');
      expect(result.result).toBe('success');
      expect(result.duration).toBe(1500);
      expect(result.details).toBe('Vacuum completed');
    });
  });

  // ==========================================================================
  // getAll
  // ==========================================================================

  describe('getAll', () => {
    test('returns a copy of events (not the internal array)', () => {
      buffer.push({ type: 'query_execution', action: 'run', target: 't1', user: 'u', result: 'success' });
      const all1 = buffer.getAll();
      const all2 = buffer.getAll();
      expect(all1).not.toBe(all2);
      expect(all1).toEqual(all2);
    });

    test('returns events in chronological order', () => {
      buffer.push({ type: 'query_execution', action: 'a1', target: 't1', user: 'u', result: 'success' });
      buffer.push({ type: 'maintenance', action: 'a2', target: 't2', user: 'u', result: 'failure' });
      buffer.push({ type: 'kill_session', action: 'a3', target: 't3', user: 'u', result: 'success' });

      const all = buffer.getAll();
      expect(all[0].action).toBe('a1');
      expect(all[1].action).toBe('a2');
      expect(all[2].action).toBe('a3');
    });
  });

  // ==========================================================================
  // getRecent
  // ==========================================================================

  describe('getRecent', () => {
    test('returns last N events', () => {
      for (let i = 0; i < 5; i++) {
        buffer.push({ type: 'query_execution', action: `action-${i}`, target: 't', user: 'u', result: 'success' });
      }

      const recent = buffer.getRecent(3);
      expect(recent).toHaveLength(3);
      expect(recent[0].action).toBe('action-2');
      expect(recent[1].action).toBe('action-3');
      expect(recent[2].action).toBe('action-4');
    });
  });

  // ==========================================================================
  // filter
  // ==========================================================================

  describe('filter', () => {
    beforeEach(() => {
      buffer.push({ type: 'query_execution', action: 'exec', target: 't1', connectionName: 'prod', user: 'admin', result: 'success' });
      buffer.push({ type: 'maintenance', action: 'vacuum', target: 't2', connectionName: 'staging', user: 'admin', result: 'failure' });
      buffer.push({ type: 'query_execution', action: 'exec', target: 't3', connectionName: 'prod', user: 'user1', result: 'failure' });
      buffer.push({ type: 'kill_session', action: 'kill', target: 'pid-1', connectionName: 'prod', user: 'admin', result: 'success' });
    });

    test('filters by type', () => {
      const result = buffer.filter({ type: 'query_execution' });
      expect(result).toHaveLength(2);
      result.forEach(e => expect(e.type).toBe('query_execution'));
    });

    test('filters by result', () => {
      const result = buffer.filter({ result: 'failure' });
      expect(result).toHaveLength(2);
      result.forEach(e => expect(e.result).toBe('failure'));
    });

    test('filters by connectionName', () => {
      const result = buffer.filter({ connectionName: 'staging' });
      expect(result).toHaveLength(1);
      expect(result[0].action).toBe('vacuum');
    });

    test('filters by since (timestamp string comparison)', () => {
      const all = buffer.getAll();
      // Use the timestamp of the 3rd event as "since"
      const sinceTimestamp = all[2].timestamp;
      const result = buffer.filter({ since: sinceTimestamp });
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    test('combines multiple filters', () => {
      const result = buffer.filter({ type: 'query_execution', result: 'success', connectionName: 'prod' });
      expect(result).toHaveLength(1);
      expect(result[0].action).toBe('exec');
      expect(result[0].target).toBe('t1');
    });
  });

  // ==========================================================================
  // clear
  // ==========================================================================

  describe('clear', () => {
    test('empties the buffer', () => {
      buffer.push({ type: 'query_execution', action: 'x', target: 't', user: 'u', result: 'success' });
      buffer.push({ type: 'maintenance', action: 'y', target: 't', user: 'u', result: 'success' });

      buffer.clear();
      expect(buffer.getAll()).toEqual([]);
    });

    test('resets size to 0', () => {
      buffer.push({ type: 'query_execution', action: 'x', target: 't', user: 'u', result: 'success' });
      buffer.clear();
      expect(buffer.size).toBe(0);
    });
  });

  // ==========================================================================
  // size
  // ==========================================================================

  describe('size', () => {
    test('tracks number of events correctly', () => {
      expect(buffer.size).toBe(0);
      buffer.push({ type: 'query_execution', action: 'a', target: 't', user: 'u', result: 'success' });
      expect(buffer.size).toBe(1);
      buffer.push({ type: 'maintenance', action: 'b', target: 't', user: 'u', result: 'success' });
      expect(buffer.size).toBe(2);
    });
  });

  // ==========================================================================
  // toJSON
  // ==========================================================================

  describe('toJSON', () => {
    test('returns events array', () => {
      buffer.push({ type: 'query_execution', action: 'exec', target: 't', user: 'u', result: 'success' });
      const json = buffer.toJSON();
      expect(Array.isArray(json)).toBe(true);
      expect(json).toHaveLength(1);
      expect(json[0].action).toBe('exec');
    });
  });

  // ==========================================================================
  // loadFrom
  // ==========================================================================

  describe('loadFrom', () => {
    test('loads events into the buffer', () => {
      const events: AuditEvent[] = [
        { id: '1', timestamp: '2026-01-01T00:00:00Z', type: 'query_execution', action: 'a1', target: 't', user: 'u', result: 'success' },
        { id: '2', timestamp: '2026-01-02T00:00:00Z', type: 'maintenance', action: 'a2', target: 't', user: 'u', result: 'failure' },
      ];

      buffer.loadFrom(events);
      expect(buffer.size).toBe(2);
      expect(buffer.getAll()[0].id).toBe('1');
      expect(buffer.getAll()[1].id).toBe('2');
    });

    test('trims to maxSize if loaded events exceed capacity', () => {
      const smallBuffer = new AuditRingBuffer(3);
      const events: AuditEvent[] = Array.from({ length: 10 }, (_, i) => ({
        id: `id-${i}`,
        timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        type: 'query_execution' as AuditEventType,
        action: `action-${i}`,
        target: 't',
        user: 'u',
        result: 'success' as const,
      }));

      smallBuffer.loadFrom(events);
      expect(smallBuffer.size).toBe(3);
      // Should keep the last 3 events
      const all = smallBuffer.getAll();
      expect(all[0].id).toBe('id-7');
      expect(all[1].id).toBe('id-8');
      expect(all[2].id).toBe('id-9');
    });
  });

  // ==========================================================================
  // Max size enforcement
  // ==========================================================================

  describe('max size enforcement', () => {
    test('pushing beyond maxSize drops oldest events', () => {
      const smallBuffer = new AuditRingBuffer(3);
      for (let i = 0; i < 5; i++) {
        smallBuffer.push({ type: 'query_execution', action: `a-${i}`, target: 't', user: 'u', result: 'success' });
      }

      expect(smallBuffer.size).toBe(3);
      const all = smallBuffer.getAll();
      expect(all[0].action).toBe('a-2');
      expect(all[1].action).toBe('a-3');
      expect(all[2].action).toBe('a-4');
    });
  });
});

// ============================================================================
// Storage Functions
// Note: loadAuditFromStorage / saveAuditToStorage check
// `typeof window === 'undefined'` and bail out in SSR.
// We define globalThis.window so the code reaches localStorage.
// ============================================================================

// Set up window globally for storage tests — only once, non-deletable is fine
if (typeof globalThis.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    writable: true,
    configurable: true,
  });
}

describe('loadAuditFromStorage', () => {
  test('returns empty array when localStorage is empty', () => {
    const result = loadAuditFromStorage();
    expect(result).toEqual([]);
  });

  test('returns parsed events from localStorage', () => {
    const events: AuditEvent[] = [
      { id: '1', timestamp: '2026-01-01T00:00:00Z', type: 'query_execution', action: 'exec', target: 't', user: 'u', result: 'success' },
    ];
    localStorage.setItem('libredb_audit_log', JSON.stringify(events));

    const result = loadAuditFromStorage();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });
});

describe('saveAuditToStorage', () => {
  test('saves events to localStorage', () => {
    const events: AuditEvent[] = [
      { id: '1', timestamp: '2026-01-01T00:00:00Z', type: 'query_execution', action: 'exec', target: 't', user: 'u', result: 'success' },
    ];
    saveAuditToStorage(events);

    const stored = localStorage.getItem('libredb_audit_log');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('1');
  });

  test('trims events to 1000 before saving', () => {
    const events: AuditEvent[] = Array.from({ length: 1500 }, (_, i) => ({
      id: `id-${i}`,
      timestamp: '2026-01-01T00:00:00Z',
      type: 'query_execution' as AuditEventType,
      action: `action-${i}`,
      target: 't',
      user: 'u',
      result: 'success' as const,
    }));

    saveAuditToStorage(events);

    const stored = localStorage.getItem('libredb_audit_log');
    const parsed = JSON.parse(stored!);
    expect(parsed).toHaveLength(1000);
    // Should keep the last 1000 (indices 500-1499)
    expect(parsed[0].id).toBe('id-500');
    expect(parsed[999].id).toBe('id-1499');
  });
});
