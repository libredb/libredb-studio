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
