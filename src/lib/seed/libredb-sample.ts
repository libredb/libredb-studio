/**
 * The built-in "Sample (LibreDB)" connection and its seed data.
 *
 * On first standalone startup (see instrumentation.ts) the sample file is
 * created and seeded with one example per lens; getManagedConnections() then
 * advertises an editable, dismissable connection pointing at it. None of this
 * is in the published @libredb/studio surface, so platform is unaffected.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ManagedConnection } from './types';

export const SAMPLE_SEED_ID = 'libredb-embedded-sample';

/** Default on; only the literal "false" disables. Server-side env. */
export function isSampleEnabled(): boolean {
  return process.env.LIBREDB_EMBEDDED_SAMPLE !== 'false';
}

/** Override via LIBREDB_EMBEDDED_SAMPLE_PATH, else `<data dir>/sample.libredb`,
 * where the data dir mirrors the SQLite storage location (writable in Docker). */
export function resolveSamplePath(): string {
  const override = process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
  if (override) return override;
  const storageDb = process.env.STORAGE_SQLITE_PATH || './data/libredb-storage.db';
  return path.join(path.dirname(storageDb), 'sample.libredb');
}

/**
 * Create and seed the sample file. Idempotent: if the file already exists it is
 * left untouched (never clobber the user's edits). Seeds all three lenses so the
 * connection showcases relational/document/raw-kv views.
 */
export async function seedSampleFile(filePath: string): Promise<void> {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const { open, kv, doc, table } = await import('@libredb/libredb');
  const db = open({ path: filePath });
  try {
    const users = table(db, 'users', {
      primaryKey: 'id',
      columns: { id: 'string', name: 'string', age: 'number', active: 'boolean' },
    });
    users.insert({ id: '1', name: 'Ada', age: 36, active: true });
    users.insert({ id: '2', name: 'Grace', age: 45, active: false });
    users.insert({ id: '3', name: 'Edsger', age: 40, active: true });

    const articles = doc(db, 'articles');
    articles.put('a1', { title: 'Welcome to LibreDB', body: 'One core, three lenses.', tags: ['intro'] });
    articles.put('a2', { title: 'Embedded by design', body: 'No server, no wire protocol.', tags: ['design'] });

    const store = kv(db);
    store.set('config:theme', 'dark');
    store.set('config:locale', 'en');
  } finally {
    db.close();
  }
}

/** The built-in editable seed connection descriptor (managed:false). */
export function buildSampleConnection(): ManagedConnection {
  return {
    id: `seed:${SAMPLE_SEED_ID}`,
    seedId: SAMPLE_SEED_ID,
    name: 'Sample (LibreDB)',
    type: 'libredb',
    database: resolveSamplePath(),
    managed: false,
    roles: ['*'],
    createdAt: new Date(0),
  };
}
