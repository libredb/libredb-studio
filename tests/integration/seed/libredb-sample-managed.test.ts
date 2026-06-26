import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getManagedConnections } from '@/lib/seed';
import { SAMPLE_SEED_ID } from '@/lib/seed/libredb-sample';

let file: string;
afterEach(() => {
  try { if (file) fs.unlinkSync(file); } catch { /* ignore */ }
  delete process.env.LIBREDB_EMBEDDED_SAMPLE;
  delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
});

function useTempSamplePath(): void {
  file = path.join(os.tmpdir(), `libredb-mc-${Math.random().toString(36).slice(2)}.libredb`);
  process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = file;
}

describe('getManagedConnections — embedded sample', () => {
  test('includes the sample when enabled and the file exists', async () => {
    useTempSamplePath();
    fs.writeFileSync(file, ''); // file exists
    const conns = await getManagedConnections(['*']);
    const sample = conns.find((c) => c.seedId === SAMPLE_SEED_ID);
    expect(sample).toBeDefined();
    expect(sample?.managed).toBe(false);
    expect(sample?.type).toBe('libredb');
    expect(sample?.database).toBe(file);
  });

  test('excludes the sample when the file is absent', async () => {
    useTempSamplePath(); // env points at a path, but no file created
    const conns = await getManagedConnections(['*']);
    expect(conns.find((c) => c.seedId === SAMPLE_SEED_ID)).toBeUndefined();
  });

  test('excludes the sample when disabled', async () => {
    useTempSamplePath();
    fs.writeFileSync(file, '');
    process.env.LIBREDB_EMBEDDED_SAMPLE = 'false';
    const conns = await getManagedConnections(['*']);
    expect(conns.find((c) => c.seedId === SAMPLE_SEED_ID)).toBeUndefined();
  });
});
