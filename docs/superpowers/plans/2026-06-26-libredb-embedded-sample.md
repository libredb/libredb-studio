# LibreDB Embedded Sample Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On first standalone startup, auto-provide an editable, dismissable `libredb` connection named "Sample (LibreDB)" backed by a `.libredb` file pre-seeded with one example per lens (relational/document/kv), gated by `LIBREDB_EMBEDDED_SAMPLE` (default on).

**Architecture:** A boot-once `src/instrumentation.ts` seeds the sample file (idempotent, graceful). The sample is exposed as a built-in `managed:false` seed connection appended by `getManagedConnections`, so the existing connection-merge machinery copies it into the user's storage. A general `dismissed_seeds` storage collection makes a deleted seed stay gone. Platform is unaffected by construction (none of this code is in the published package surface).

**Tech Stack:** Next.js 16 (App Router) + React 19 + TypeScript; `@libredb/libredb@^0.0.3` (`open`/`kv`/`doc`/`table`/`catalog`); Bun test runner.

## Global Constraints

- Commit identity: `git -c user.name='cevheri' -c user.email='cevheribozoglan@gmail.com' commit ...`. NEVER add a Co-Authored-By / AI-attribution trailer.
- English only in code, comments, commits, docs. No emoji.
- Env flag: `LIBREDB_EMBEDDED_SAMPLE` — default ON; only the literal string `'false'` disables. Server-side only (NOT `NEXT_PUBLIC_`). Optional path: `LIBREDB_EMBEDDED_SAMPLE_PATH`.
- Connection: name `"Sample (LibreDB)"`, `seedId: 'libredb-embedded-sample'`, wire id `seed:libredb-embedded-sample`, `type: 'libredb'`, `managed: false`, `roles: ['*']`.
- Default sample path: `<dirname of (STORAGE_SQLITE_PATH || './data/libredb-storage.db')>/sample.libredb`.
- Seeding MUST be idempotent (never clobber an existing file) and MUST NOT throw out of the boot hook (log a warning and continue).
- `@libredb/libredb` is lazy dynamic-imported (server-side only), like the provider does.
- Tests: always `bun run test` (never bare `bun test`). Pre-commit gates: `bun run lint` · `bun run typecheck` · `bun run test` · `bun run build` · `bun run knip`; plus `bun run build:lib` (touches hooks/storage consumed by the package).
- Branch: `feat/libredb-embedded-sample` (already created, off `main`).

---

### Task 1: Sample module — enable/path/seed/connection

**Files:**
- Create: `src/lib/seed/libredb-sample.ts`
- Test: `tests/integration/seed/libredb-sample.test.ts`

**Interfaces:**
- Consumes: `@libredb/libredb` (`open`, `kv`, `doc`, `table`, `catalog`); `ManagedConnection` from `@/lib/seed/types`.
- Produces:
  - `isSampleEnabled(): boolean`
  - `resolveSamplePath(): string`
  - `seedSampleFile(filePath: string): Promise<void>`
  - `buildSampleConnection(): ManagedConnection`
  - `SAMPLE_SEED_ID = 'libredb-embedded-sample'`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/seed/libredb-sample.test.ts`:
```ts
import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { open, catalog, kv } from '@libredb/libredb';
import {
  isSampleEnabled,
  resolveSamplePath,
  seedSampleFile,
  buildSampleConnection,
  SAMPLE_SEED_ID,
} from '@/lib/seed/libredb-sample';

const tmp: string[] = [];
function tmpPath(): string {
  const p = path.join(os.tmpdir(), `libredb-sample-${Math.random().toString(36).slice(2)}.libredb`);
  tmp.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmp) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  tmp.length = 0;
  delete process.env.LIBREDB_EMBEDDED_SAMPLE;
  delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
});

describe('libredb-sample', () => {
  test('isSampleEnabled: default on; only "false" disables', () => {
    expect(isSampleEnabled()).toBe(true);
    process.env.LIBREDB_EMBEDDED_SAMPLE = 'false';
    expect(isSampleEnabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = 'true';
    expect(isSampleEnabled()).toBe(true);
  });

  test('resolveSamplePath: override wins; else derives from data dir', () => {
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = '/custom/x.libredb';
    expect(resolveSamplePath()).toBe('/custom/x.libredb');
    delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
    expect(resolveSamplePath().endsWith(`${path.sep}sample.libredb`)).toBe(true);
  });

  test('seedSampleFile: seeds all three lenses, catalog-aware', async () => {
    const file = tmpPath();
    await seedSampleFile(file);
    expect(fs.existsSync(file)).toBe(true);

    const db = open({ path: file });
    const reg = catalog(db);
    expect(reg.get('users')?.kind).toBe('relational');
    expect(reg.get('articles')?.kind).toBe('document');
    const configKeys = kv(db).prefix('config:').toArray().map((e) => e.key);
    expect(configKeys.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  test('seedSampleFile: idempotent — does not modify an existing file', async () => {
    const file = tmpPath();
    await seedSampleFile(file);
    const before = fs.readFileSync(file);
    await seedSampleFile(file);
    const after = fs.readFileSync(file);
    expect(after.equals(before)).toBe(true);
  });

  test('buildSampleConnection: editable libredb seed pointing at the resolved path', () => {
    const conn = buildSampleConnection();
    expect(conn.seedId).toBe(SAMPLE_SEED_ID);
    expect(conn.id).toBe(`seed:${SAMPLE_SEED_ID}`);
    expect(conn.type).toBe('libredb');
    expect(conn.managed).toBe(false);
    expect(conn.roles).toEqual(['*']);
    expect(conn.name).toBe('Sample (LibreDB)');
    expect(conn.database).toBe(resolveSamplePath());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/integration/seed/libredb-sample.test.ts`
Expected: FAIL — cannot resolve `@/lib/seed/libredb-sample`.

- [ ] **Step 3: Implement the module**

Create `src/lib/seed/libredb-sample.ts`:
```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/integration/seed/libredb-sample.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/seed/libredb-sample.ts tests/integration/seed/libredb-sample.test.ts
git commit -m "feat(seed): libredb sample module (enable/path/seed/connection)"
```

---

### Task 2: Advertise the sample via getManagedConnections

**Files:**
- Modify: `src/lib/seed/index.ts`
- Test: `tests/integration/seed/libredb-sample-managed.test.ts`

**Interfaces:**
- Consumes: `isSampleEnabled`, `resolveSamplePath`, `buildSampleConnection` (Task 1); existing `getManagedConnections(roles)`.
- Produces: `getManagedConnections` now appends the sample connection when `isSampleEnabled()` and the sample file exists.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/seed/libredb-sample-managed.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/integration/seed/libredb-sample-managed.test.ts`
Expected: FAIL — the sample is not in the returned list.

- [ ] **Step 3: Implement — append the sample in getManagedConnections**

In `src/lib/seed/index.ts`, add imports at the top:
```ts
import * as fs from 'fs';
import { isSampleEnabled, resolveSamplePath, buildSampleConnection } from './libredb-sample';
```
Replace the `getManagedConnections` function body's `return` so the sample is appended (role `'*'` matches everyone; gate on file existence so a failed seed never advertises a broken connection):
```ts
export async function getManagedConnections(roles: string[]): Promise<ManagedConnection[]> {
  const config = await loadConfig();
  const fromConfig = config
    ? filterByRoles(
        resolveAllCredentials(config.connections.map((conn) => mergeDefaults(conn, config.defaults))),
        roles,
      )
    : [];

  if (isSampleEnabled()) {
    try {
      if (fs.existsSync(resolveSamplePath())) {
        return [...fromConfig, buildSampleConnection()];
      }
    } catch { /* fs error -> just omit the sample */ }
  }
  return fromConfig;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/integration/seed/libredb-sample-managed.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/seed/index.ts tests/integration/seed/libredb-sample-managed.test.ts
git commit -m "feat(seed): advertise the libredb sample via getManagedConnections"
```

---

### Task 3: Seed the file at server boot (src/instrumentation.ts)

**Files:**
- Create: `src/instrumentation.ts` (this project uses a src/ dir, so Next.js only honors the hook here, not at the repo root)

**Interfaces:**
- Consumes: `isSampleEnabled`, `resolveSamplePath`, `seedSampleFile` (Task 1); `logger` from `@/lib/logger`.
- Produces: Next.js `register()` that seeds the file once at standalone boot. (No unit test — logic is in the Task 1 module; this is a thin, untestable wire. Verified by `bun run build` + manual.)

- [ ] **Step 1: Create the instrumentation hook**

Create `src/instrumentation.ts` (Next.js requires the hook under src/ when a src/ directory is used):
```ts
/**
 * Next.js boot hook. register() runs once per server worker, ONLY when this app
 * boots its own Next.js server (never when @libredb/studio is imported by
 * libredb-platform). On standalone boot, seed the embedded sample .libredb file
 * if enabled. A failure here must never break boot.
 */
export async function register(): Promise<void> {
  // Node.js server runtime only (skip the edge runtime).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { isSampleEnabled, resolveSamplePath, seedSampleFile } = await import('@/lib/seed/libredb-sample');
  if (!isSampleEnabled()) return;

  const { logger } = await import('@/lib/logger');
  const filePath = resolveSamplePath();
  try {
    await seedSampleFile(filePath);
  } catch (error) {
    logger.warn('LibreDB embedded sample seeding skipped', {
      route: 'instrumentation',
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

- [ ] **Step 2: Verify the build picks up instrumentation and compiles**

Run: `bun run build`
Expected: PASS. Build output mentions instrumentation (Next.js compiles `instrumentation.ts`); no type errors. (`@/` alias resolves via tsconfig paths.)

- [ ] **Step 3: Manual boot check (note result in commit body)**

Run `bun dev`, then confirm the file was created at the resolved path:
```bash
ls -la ./data/sample.libredb
```
Expected: the file exists after the dev server boots. Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/instrumentation.ts
git commit -m "feat(boot): seed the libredb embedded sample file on standalone startup"
```

---

### Task 4: Dismissable seeds — storage collection, facade, hook skip

**Files:**
- Modify: `src/lib/storage/types.ts:16-42` (add `dismissed_seeds`)
- Modify: `src/lib/storage/storage-facade.ts` (add `getDismissedSeeds`; record on delete)
- Modify: `src/hooks/use-connection-manager.ts:99-108` (skip dismissed)
- Modify: `src/hooks/use-all-connections.ts:33-37` (skip dismissed)
- Test: `tests/integration/storage/dismissed-seeds.test.ts`

**Interfaces:**
- Consumes: existing `storage` facade (`getConnections`, `deleteConnection`), `readJSON`/`writeJSON`/`dispatchChange` internal helpers.
- Produces: `storage.getDismissedSeeds(): string[]`; `storage.deleteConnection(id)` now records the deleted connection's `seedId` (if any) into `dismissed_seeds`; both merge hooks skip copying/showing a `managed:false` seed whose `seedId` is dismissed.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/storage/dismissed-seeds.test.ts`:
```ts
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
```
> Note: this test runs under the component group (jsdom `localStorage`). Place it where the runner provides a DOM. If `tests/integration` lacks jsdom, put it under `tests/components/` instead; the assertions are unchanged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/integration/storage/dismissed-seeds.test.ts`
Expected: FAIL — `storage.getDismissedSeeds` is not a function.

- [ ] **Step 3a: Add the `dismissed_seeds` collection to storage types**

In `src/lib/storage/types.ts`, add the field to `StorageData` (after `threshold_config`):
```ts
  threshold_config: ThresholdConfig[];
  /** seedIds the user dismissed (deleted a managed:false seed copy) so it is not re-added. */
  dismissed_seeds: string[];
```
And add it to `STORAGE_COLLECTIONS`:
```ts
  'threshold_config',
  'dismissed_seeds',
];
```

- [ ] **Step 3b: Add facade helpers + record on delete**

In `src/lib/storage/storage-facade.ts`, add a `getDismissedSeeds` reader and record the seedId inside `deleteConnection`. Replace the existing `deleteConnection` block:
```ts
  getDismissedSeeds: (): string[] => {
    return readJSON<string[]>('dismissed_seeds') ?? [];
  },

  deleteConnection: (id: string) => {
    const connections = storage.getConnections();
    const target = connections.find((c) => c.id === id);
    if (target?.seedId) {
      const dismissed = storage.getDismissedSeeds();
      if (!dismissed.includes(target.seedId)) {
        const next = [...dismissed, target.seedId];
        writeJSON('dismissed_seeds', next);
        dispatchChange('dismissed_seeds', next);
      }
    }
    const filtered = connections.filter((c) => c.id !== id);
    writeJSON('connections', filtered);
    dispatchChange('connections', filtered);
  },
```

- [ ] **Step 3c: Skip dismissed seeds in `use-connection-manager`**

In `src/hooks/use-connection-manager.ts`, inside `initializeConnections`, read the dismissed set once before the merge loop (just after `const userConns = storage.getConnections();` at line 91):
```ts
            const userConns = storage.getConnections();
            const dismissed = new Set(storage.getDismissedSeeds());
            const merged: DatabaseConnection[] = [];
```
Then in the `else` branch for `managed:false` (currently lines 98-108), skip dismissed ones:
```ts
              } else {
                // managed:false — editable user copy
                if (dismissed.has(mc.seedId)) continue; // user deleted it; do not re-add
                const existingCopy = userConns.find((uc: DatabaseConnection) => uc.seedId === mc.seedId);
                if (existingCopy) {
                  merged.push(existingCopy);
                } else {
                  const userCopy: DatabaseConnection = { ...mc, createdAt: new Date(mc.createdAt), managed: false };
                  storage.saveConnection(userCopy);
                  merged.push(userCopy);
                }
              }
```

- [ ] **Step 3d: Skip dismissed seeds in `use-all-connections`**

In `src/hooks/use-all-connections.ts`, read the dismissed set before the merge loop (just after `const userConns = storage.getConnections();`):
```ts
      const userConns = storage.getConnections();
      const dismissed = new Set(storage.getDismissedSeeds());
```
Then in the "Managed connections first" loop, skip a dismissed `managed:false` seed:
```ts
            for (const mc of managedConns) {
              if (mc.managed === false && mc.seedId && dismissed.has(mc.seedId)) continue;
              merged.push({ ...mc, createdAt: new Date(mc.createdAt) });
              addedIds.add(mc.id);
              if (mc.seedId) addedIds.add(`seed:${mc.seedId}`);
            }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/integration/storage/dismissed-seeds.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage/types.ts src/lib/storage/storage-facade.ts src/hooks/use-connection-manager.ts src/hooks/use-all-connections.ts tests/integration/storage/dismissed-seeds.test.ts
git commit -m "feat(storage): dismissed-seeds tracking so deleted editable seeds stay gone"
```

---

### Task 5: Env documentation

**Files:**
- Modify: `.env.example`
- Modify: `docs/providers/libredb.md` (short note)

**Interfaces:** none (docs).

- [ ] **Step 1: Document the env in `.env.example`**

Add near the storage section of `.env.example`:
```bash
# LibreDB embedded sample: on first standalone startup, auto-provide an editable
# "Sample (LibreDB)" connection seeded with example data (one per lens). Default on.
# Set to "false" to disable. Has no effect when embedded in libredb-platform.
# LIBREDB_EMBEDDED_SAMPLE=true
# Optional file path override (default: <data dir>/sample.libredb):
# LIBREDB_EMBEDDED_SAMPLE_PATH=/app/data/sample.libredb
```

- [ ] **Step 2: Add a short note to `docs/providers/libredb.md`**

Add a brief subsection under the connection section explaining that a fresh standalone Studio auto-creates the "Sample (LibreDB)" connection (env `LIBREDB_EMBEDDED_SAMPLE`, default on; deletable; not present in embedded/platform mode).

- [ ] **Step 3: Commit**

```bash
git add .env.example docs/providers/libredb.md
git commit -m "docs: document LIBREDB_EMBEDDED_SAMPLE env and the sample connection"
```

---

### Task 6: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Run all gates**

Run:
```bash
bun run lint && bun run typecheck && bun run test && bun run knip && bun run build && bun run build:lib
```
Expected: all PASS. If any fails, fix in the owning task's files and re-run.

- [ ] **Step 2: Confirm published surface is unchanged (platform safety)**

Run:
```bash
grep -rnE "libredb-sample|dismissed_seeds|instrumentation|getManagedConnections|use-connection-manager" src/exports/ || echo "OK: sample code not referenced from published exports"
```
Expected: `OK:` — none of the new code is reachable from `src/exports/*` (so it is not in the package platform installs).

- [ ] **Step 3: Final commit (only if gates produced changes)**

```bash
git add -A && git commit -m "chore: finalize libredb embedded sample verification"
```

---

## Self-Review

**Spec coverage:** §3.1 file seeding → Task 1 (`seedSampleFile`) + Task 3 (boot hook). §3.2 connection exposure → Task 2. §3.3 dismissable → Task 4. §2 naming → Global Constraints + Tasks 1-2. §4 platform isolation → Task 6 Step 2 (grep guard). §5 dataset → Task 1 Step 3. §6 storage modes → `dismissed_seeds` in STORAGE_COLLECTIONS (Task 4 3a) syncs like other collections. §7 error handling → Task 1 (idempotent), Task 3 (try/catch warn), Task 2 (file-exists gate). §8 testing → Tasks 1,2,4. §10 gates → Task 6.

**Placeholder scan:** No TBD/"handle edge cases"/bare "write tests". Every code step has complete code; every test has complete assertions. Task 3's "no unit test" is justified (thin wire; logic tested in Task 1) and includes a concrete build + manual check.

**Type consistency:** `SAMPLE_SEED_ID`, `isSampleEnabled`, `resolveSamplePath`, `seedSampleFile`, `buildSampleConnection` defined in Task 1 and consumed unchanged in Tasks 2-3. `ManagedConnection` shape (`id`/`seedId`/`name`/`type`/`database`/`managed`/`roles`/`createdAt`) matches `src/lib/seed/types.ts` + `filterByRoles` output. `dismissed_seeds` collection + `getDismissedSeeds()` consistent across Task 4 sub-steps. `@libredb/libredb` lens calls (`open`/`kv`/`doc`/`table`/`catalog`) match `^0.0.3`.
