/**
 * LibreDB Provider Integration Tests
 *
 * Uses the REAL @libredb/libredb package against a temp file — no mock.module(),
 * so this suite is exempt from the mock-isolation hazard in CLAUDE.md.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { LibreDBProvider } from '@/lib/db/providers/embedded/libredb';
import type { DatabaseConnection } from '@/lib/types';
import { open, kv } from '@libredb/libredb';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpFile: string;

function makeConn(database: string | undefined): DatabaseConnection {
  return { id: 'libredb-test', name: 'LibreDB Test', type: 'libredb', database, createdAt: new Date() };
}

function seed(file: string): void {
  const db = open({ path: file });
  const store = kv(db);
  store.set('user:1', 'Ada');
  store.set('user:2', JSON.stringify({ name: 'Grace', age: 45 }));
  store.set('order:1', '42');
  store.set('config', 'on');
  db.close();
}

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `libredb-test-${Math.random().toString(36).slice(2)}.libredb`);
  seed(tmpFile);
});

afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
});

describe('LibreDBProvider — lifecycle & metadata', () => {
  test('validate() rejects a connection with no file path', () => {
    const provider = new LibreDBProvider(makeConn(undefined));
    expect(() => provider.validate()).toThrow(/path/i);
  });

  test('connect() with no file path throws (no silent in-memory open)', async () => {
    const provider = new LibreDBProvider(makeConn(undefined));
    await expect(provider.connect()).rejects.toThrow(/path/i);
    expect(provider.isConnected()).toBe(false);
  });

  test('connect() then disconnect() against a real file', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    await provider.disconnect(); // idempotent
  });

  test('getCapabilities() declares a non-SQL, read/write provider', () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    const caps = provider.getCapabilities();
    expect(caps.queryLanguage).toBe('json');
    expect(caps.supportsCreateTable).toBe(false);
    expect(caps.supportsExplain).toBe(false);
    expect(caps.defaultPort).toBeNull();
  });

  test('getLabels() uses key-oriented labels', () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    expect(provider.getLabels().rowNamePlural).toBe('keys');
  });
});

describe('LibreDBProvider — getSchema', () => {
  test('groups keys by colon-prefix into pseudo-tables', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();

    const byName = Object.fromEntries(schema.map((t) => [t.name, t]));
    expect(byName['user:*'].rowCount).toBe(2);
    expect(byName['order:*'].rowCount).toBe(1);
    expect(byName['config'].rowCount).toBe(1); // no colon -> own group
    // columns are key (primary) + value
    expect(byName['user:*'].columns.map((c) => c.name)).toEqual(['key', 'value']);
    expect(byName['user:*'].columns[0].isPrimary).toBe(true);
    // sorted by rowCount desc -> user:* first
    expect(schema[0].name).toBe('user:*');
  });
});

describe('LibreDBProvider — query commands', () => {
  test('get returns one row, JSON value pretty-printed', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const plain = await provider.query('get user:1');
    expect(plain.rows).toEqual([{ key: 'user:1', value: 'Ada' }]);

    const json = await provider.query('get user:2');
    expect(json.rows[0].value).toBe(JSON.stringify({ name: 'Grace', age: 45 }, null, 2));
    await provider.disconnect();
  });

  test('get on a missing key returns zero rows', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const res = await provider.query('get nope');
    expect(res.rowCount).toBe(0);
    expect(res.rows).toEqual([]);
    await provider.disconnect();
  });

  test('prefix scans a group; range scans a half-open interval', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const pre = await provider.query('prefix user:');
    expect(pre.rows.map((r) => r.key)).toEqual(['user:1', 'user:2']);

    const rng = await provider.query('range user:1 user:2');
    expect(rng.rows.map((r) => r.key)).toEqual(['user:1']); // end excluded
    await provider.disconnect();
  });

  test('put then delete round-trips durably', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();

    const put = await provider.query('put greeting hello');
    expect(put.rows).toEqual([{ changed: 1 }]);
    expect((await provider.query('get greeting')).rows[0].value).toBe('hello');

    const del = await provider.query('delete greeting');
    expect(del.rows).toEqual([{ changed: 1 }]);
    expect((await provider.query('get greeting')).rowCount).toBe(0);
    await provider.disconnect();
  });

  test('put preserves the rest of a multi-word value', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    await provider.query('put note hello world');
    expect((await provider.query('get note')).rows[0].value).toBe('hello world');
    await provider.disconnect();
  });

  test('an unknown command throws QueryError listing supported verbs', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    await expect(provider.query('select * from users')).rejects.toThrow(/get, put, delete, prefix, range/);
    await provider.disconnect();
  });
});
