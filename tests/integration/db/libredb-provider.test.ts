/**
 * LibreDB Provider Integration Tests
 *
 * Uses the REAL @libredb/libredb package against a temp file — no mock.module(),
 * so this suite is exempt from the mock-isolation hazard in CLAUDE.md.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { LibreDBProvider } from '@/lib/db/providers/embedded/libredb';
import type { DatabaseConnection } from '@/lib/types';
import { open, kv, doc, table } from '@libredb/libredb';
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

/**
 * Seed that, in addition to raw kv keys, creates a catalog-backed relational
 * table ("employees") and a document collection ("articles"). This populates the
 * database's reserved catalog so the provider's catalog-aware schema view can be
 * exercised. The raw kv keys mirror the plain `seed()` so its assertions still
 * hold (user:*, order:*, config).
 */
function seedWithCatalog(file: string): void {
  const db = open({ path: file });

  // Raw kv keys (uncataloged namespaces).
  const store = kv(db);
  store.set('user:1', 'Ada');
  store.set('user:2', JSON.stringify({ name: 'Grace', age: 45 }));
  store.set('order:1', '42');
  store.set('config', 'on');

  // A relational table — records a relational catalog entry with a schema.
  const employees = table(db, 'employees', {
    primaryKey: 'id',
    columns: { id: 'string', name: 'string', salary: 'number', active: 'boolean' },
  });
  employees.insert({ id: '1', name: 'Ada', salary: 100, active: true });
  employees.insert({ id: '2', name: 'Grace', salary: 120, active: false });

  // A document collection — records a document catalog entry on first put.
  const articles = doc(db, 'articles');
  articles.put('a1', { title: 'Hello', body: 'world' });

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

describe('LibreDBProvider — catalog-aware schema', () => {
  let catalogFile: string;

  beforeEach(() => {
    catalogFile = path.join(os.tmpdir(), `libredb-cat-${Math.random().toString(36).slice(2)}.libredb`);
    seedWithCatalog(catalogFile);
  });

  afterEach(() => {
    try { fs.unlinkSync(catalogFile); } catch { /* ignore */ }
  });

  test('getSchema never surfaces the reserved catalog prefix', async () => {
    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();

    for (const t of schema) {
      expect(t.name.startsWith('\x00')).toBe(false);
      expect(t.name).not.toContain('libredb:catalog:');
    }
    // No pseudo-table for the reserved namespace leaks in.
    expect(schema.some((t) => t.name.includes('catalog'))).toBe(false);
  });

  test('range/prefix queries never surface the reserved catalog keys', async () => {
    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();

    // Full-keyspace range — the reserved keys sort first (U+0000) but must be filtered.
    const rng = await provider.query('range \x00 \u{10FFFF}');
    expect(rng.rows.every((r) => !String(r.key).startsWith('\x00'))).toBe(true);
    expect(rng.rows.some((r) => String(r.key).includes('libredb:catalog:'))).toBe(false);

    // A prefix scan over the reserved marker returns nothing user-facing.
    const pre = await provider.query('prefix \x00');
    expect(pre.rowCount).toBe(0);

    await provider.disconnect();
  });

  test('hides the whole reserved namespace, not just the catalog prefix (isReservedKey widening)', async () => {
    // A raw kv key under the U+0000 marker but OUTSIDE the "catalog:" tail. The
    // previous hardcoded `\x00libredb:catalog:` filter would have leaked this;
    // isReservedKey is marker-based, so it hides the entire reserved namespace.
    const reservedKey = '\x00zzz-reserved-not-catalog';
    const writer = open({ path: catalogFile });
    kv(writer).set(reservedKey, 'internal');
    writer.close();

    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();
    const schema = await provider.getSchema();
    const rng = await provider.query('range \x00 \u{10FFFF}');
    await provider.disconnect();

    expect(schema.some((t) => t.name.startsWith('\x00'))).toBe(false);
    expect(rng.rows.some((r) => String(r.key) === reservedKey)).toBe(false);

    // Sanity: the key really is in the file (so the provider hid it, not absence).
    const verify = open({ path: catalogFile });
    expect(kv(verify).get(reservedKey)).toBe('internal');
    verify.close();
  });

  test('a relational table shows its real columns and is labeled relational', async () => {
    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();

    const employees = schema.find((t) => t.name === 'employees:*');
    expect(employees).toBeDefined();
    // Real declared columns from the catalog schema (not raw key/value).
    const cols = Object.fromEntries(employees!.columns.map((c) => [c.name, c]));
    expect(Object.keys(cols).sort()).toEqual(['active', 'id', 'name', 'salary']);
    expect(cols.id.isPrimary).toBe(true);
    expect(cols.name.isPrimary).toBe(false);
    expect(cols.salary.type).toBe('number');
    expect(cols.active.type).toBe('boolean');
    // Relational signal: columns are NOT the raw key/value pair.
    expect(employees!.columns.map((c) => c.name)).not.toEqual(['key', 'value']);
    expect(employees!.rowCount).toBe(2);
  });

  test('a document collection is labeled document (generic id + document columns)', async () => {
    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();

    const articles = schema.find((t) => t.name === 'articles:*');
    expect(articles).toBeDefined();
    expect(articles!.columns.map((c) => c.name)).toEqual(['id', 'document']);
    expect(articles!.columns[0].isPrimary).toBe(true);
    expect(articles!.columns[1].type).toBe('object');
  });

  test('raw kv namespaces still group as key/value pseudo-tables', async () => {
    const provider = new LibreDBProvider(makeConn(catalogFile));
    await provider.connect();
    const schema = await provider.getSchema();
    await provider.disconnect();

    const byName = Object.fromEntries(schema.map((t) => [t.name, t]));
    expect(byName['user:*'].rowCount).toBe(2);
    expect(byName['user:*'].columns.map((c) => c.name)).toEqual(['key', 'value']);
    expect(byName['order:*'].rowCount).toBe(1);
    expect(byName['config'].columns.map((c) => c.name)).toEqual(['key', 'value']);
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

  test('an unterminated quote is rejected', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    await expect(provider.query('put key "unterminated')).rejects.toThrow(/quote/i);
    await provider.disconnect();
  });
});

describe('LibreDBProvider — monitoring', () => {
  test('getOverview reports file size and group count', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const overview = await provider.getOverview();
    expect(overview.databaseSizeBytes).toBeGreaterThan(0);
    expect(overview.tableCount).toBe(3); // user:*, order:*, config
    await provider.disconnect();
  });

  test('getStorageStats lists the file path', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    const storage = await provider.getStorageStats();
    expect(storage).toHaveLength(1);
    expect(storage[0].location).toBe(tmpFile);
    expect(storage[0].sizeBytes).toBeGreaterThan(0);
    await provider.disconnect();
  });

  test('runMaintenance is unsupported', async () => {
    const provider = new LibreDBProvider(makeConn(tmpFile));
    await provider.connect();
    await expect(provider.runMaintenance('vacuum')).rejects.toThrow(/not supported/i);
    await provider.disconnect();
  });
});
