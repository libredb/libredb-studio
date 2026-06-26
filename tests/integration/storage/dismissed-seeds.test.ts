import { describe, test, expect, beforeEach } from 'bun:test';
import { storage } from '@/lib/storage';
import type { DatabaseConnection } from '@/lib/types';

beforeEach(() => {
  // jsdom localStorage is provided by the component/integration test env.
  localStorage.clear();
});

function conn(over: Partial<DatabaseConnection>): DatabaseConnection {
  return { id: 'c1', name: 'C', type: 'libredb', database: '/x.libredb', createdAt: new Date(), ...over };
}

describe('dismissed seeds', () => {
  test('deleting a connection with a seedId records the dismissal', () => {
    const c = conn({ id: 'seed-copy', seedId: 'libredb-embedded-sample' });
    storage.saveConnection(c);
    expect(storage.getDismissedSeeds()).toEqual([]);
    storage.deleteConnection('seed-copy');
    expect(storage.getDismissedSeeds()).toContain('libredb-embedded-sample');
  });

  test('deleting a plain connection records nothing', () => {
    storage.saveConnection(conn({ id: 'plain' }));
    storage.deleteConnection('plain');
    expect(storage.getDismissedSeeds()).toEqual([]);
  });

  test('dismissals are de-duplicated', () => {
    const c = conn({ id: 'x', seedId: 's1' });
    storage.saveConnection(c);
    storage.deleteConnection('x');
    storage.saveConnection(conn({ id: 'x', seedId: 's1' }));
    storage.deleteConnection('x');
    expect(storage.getDismissedSeeds().filter((s) => s === 's1')).toHaveLength(1);
  });
});
