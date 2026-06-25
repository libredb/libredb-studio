# LibreDB Embedded Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `libredb` database provider so Studio can browse and write a local `.libredb` file (the embedded `@libredb/libredb` package) directly in the editor, without disturbing any existing provider.

**Architecture:** A new NoSQL-style provider `LibreDBProvider extends BaseDatabaseProvider` under a new `embedded/` family. It lazy-imports the synchronous `@libredb/libredb` package server-side, opens the file in-process (the SQLite embedded pattern), presents keys grouped by `:`-prefix as pseudo-tables (the Redis pattern), and exposes a small `get/put/delete/prefix/range` command grammar over the `kv` lens. The Strategy-Pattern factory dispatches a new `case 'libredb'`; the `DatabaseType` union change is the single compile-forced entry point that surfaces every place needing wiring.

**Tech Stack:** TypeScript (strict), Next.js 16, Bun test runner, `@libredb/libredb@^0.0.1` (ESM, synchronous API: `open`, `kv`), tsup for `build:lib`.

## Global Constraints

- **Commit identity:** commit as `cevheri <cevheribozoglan@gmail.com>`. NEVER add a `Co-Authored-By` / AI-attribution trailer.
- **English only** in all code, comments, docs, and commit messages. No emoji anywhere.
- **No `=== 'libredb'` type-checks outside the provider class** — drive behaviour through capabilities/labels/config (CLAUDE.md DB-abstraction rule).
- **Provider tri-sync invariant:** code (`src/lib/db/providers/embedded/libredb.ts`) ↔ docs (`docs/providers/libredb.md`) ↔ tests (`tests/integration/db/libredb-provider.test.ts`) stay 1:1 and ship in the same PR.
- **Server-side only:** the provider and the `@libredb/libredb` import must never reach a client bundle (lazy dynamic import, like `sqlite.ts` does with `bun:sqlite`).
- **Tests:** always `bun run test`, never bare `bun test`. The libredb integration test uses the REAL package against a temp file (no `mock.module()`), so it does not participate in the mock-isolation hazard.
- **Pre-commit gates (MANDATORY, match CI):** `bun run lint` · `bun run typecheck` · `bun run test` · `bun run build`. Because this is platform-facing, also `bun run build:lib`.
- **Branch:** already on `providers/embedded-libredb-database-provider` (feature branch off `main`). PR base is `main`.

---

### Task 1: Register the `libredb` database type (dependency + config scaffolding)

Adds the dependency and every static registration so the type exists and the build stays green. No provider behaviour yet; the factory still rejects `libredb` at runtime until Task 2.

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/lib/types.ts:1` (DatabaseType union)
- Modify: `src/lib/db-ui-config.ts:17-74` (DB_UI_CONFIG entry + helper)
- Modify: `src/components/icons/db-icons.tsx` (add `LibreDBIcon`)
- Modify: `tsup.config.ts` (external list)
- Modify: `src/lib/seed/types.ts:22-24` (SeedDatabaseType zod enum)

**Interfaces:**
- Produces: `DatabaseType` now includes `'libredb'`; `getDBConfig('libredb')` returns a valid `DatabaseUIConfig` with `connectionFields: ['database']`; `isFileBased(type: DatabaseType): boolean` exported from `db-ui-config.ts`; `LibreDBIcon` exported from `db-icons.tsx`.

- [ ] **Step 1: Install the dependency**

Run:
```bash
bun add @libredb/libredb@^0.0.1
```
Expected: `package.json` dependencies gain `"@libredb/libredb": "^0.0.1"`; `bun.lock` updated.

- [ ] **Step 2: Verify the package imports under Bun**

Run:
```bash
bun -e "import('@libredb/libredb').then(m => console.log(Object.keys(m).sort().join(',')))"
```
Expected: output includes `doc,kv,open,table,version` (order may vary). Confirms the ESM package resolves at runtime.

- [ ] **Step 3: Add `'libredb'` to the `DatabaseType` union**

In `src/lib/types.ts:1`, change:
```ts
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 'oracle' | 'mssql';
```
to:
```ts
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 'oracle' | 'mssql' | 'libredb';
```

- [ ] **Step 4: Run typecheck to see the compile-forced gap**

Run:
```bash
bun run typecheck
```
Expected: FAIL — `DB_UI_CONFIG` in `src/lib/db-ui-config.ts` errors because the `Record<DatabaseType, DatabaseUIConfig>` is now missing the `libredb` key. This confirms the union drives the wiring.

- [ ] **Step 5: Add the `LibreDBIcon`**

In `src/components/icons/db-icons.tsx`, add after `MSSQLIcon` (follow the existing `IconProps` pattern; `strokeWidth={1.5}`, no hard-coded width/height per the platform-integration rule). Use a simple, license-safe glyph (a database cylinder with an "L"):
```tsx
export const LibreDBIcon: React.FC<IconProps> = ({ className, ...props }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
       strokeLinecap="round" strokeLinejoin="round" className={className} {...props}>
    <ellipse cx="12" cy="5" rx="7" ry="3" />
    <path d="M5 5v14c0 1.66 3.13 3 7 3s7-1.34 7-3V5" />
    <path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3" />
    <path d="M10 18.5h4" />
  </svg>
);
```

- [ ] **Step 6: Add the `DB_UI_CONFIG` entry and `isFileBased` helper**

In `src/lib/db-ui-config.ts`, import the icon (line 2) by adding `LibreDBIcon` to the existing import from `@/components/icons/db-icons`. Add this entry inside `DB_UI_CONFIG` after `mssql` (line 73):
```ts
  libredb: {
    icon: LibreDBIcon,
    color: 'text-violet-400',
    label: 'LibreDB',
    defaultPort: '',
    showConnectionStringToggle: false,
    connectionFields: ['database'],
  },
```
Then add this helper at the end of the file (after `getDBColor`):
```ts
/**
 * A file-based provider carries only a filesystem path (no host/port/credentials).
 * Derived from connectionFields so callers never hard-code provider type ids.
 */
export function isFileBased(type: DatabaseType): boolean {
  const fields = DB_UI_CONFIG[type].connectionFields;
  return fields.length === 1 && fields[0] === 'database';
}
```

- [ ] **Step 7: Add `@libredb/libredb` to the tsup external list**

In `tsup.config.ts`, in the `external` array, extend the database-drivers line:
```ts
    // Database drivers — consumers install what they need
    'pg', 'mysql2', 'better-sqlite3', 'oracledb', 'mssql', 'mongodb', 'ioredis', '@libredb/libredb',
```

- [ ] **Step 8: Add `'libredb'` to the seed zod enum**

In `src/lib/seed/types.ts` (the `SeedDatabaseType` enum, ~line 22):
```ts
const SeedDatabaseType = z.enum([
  'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'oracle', 'mssql', 'libredb',
]);
```

- [ ] **Step 9: Run typecheck + lint to confirm the scaffolding is complete**

Run:
```bash
bun run typecheck && bun run lint
```
Expected: PASS. The union is now fully registered; no provider exists yet, so the factory's runtime `default` branch still rejects `libredb` (expected, fixed in Task 2).

- [ ] **Step 10: Commit**

```bash
git add package.json bun.lock src/lib/types.ts src/lib/db-ui-config.ts src/components/icons/db-icons.tsx tsup.config.ts src/lib/seed/types.ts
git commit -m "feat(db): register libredb database type and @libredb/libredb dependency"
```

---

### Task 2: LibreDBProvider lifecycle, metadata, and factory wiring (TDD)

Creates the provider class with the lazy package loader, validation, connect/disconnect, capabilities, labels, and `prepareQuery`, plus the factory `case`. Schema/query/monitoring are stubbed (`getSchema` returns `[]`, `query` throws "not implemented") so this task compiles and its tests pass in isolation; later tasks fill them in.

**Files:**
- Create: `src/lib/db/providers/embedded/libredb.ts`
- Create: `tests/integration/db/libredb-provider.test.ts`
- Modify: `src/lib/db/factory.ts:97-101` (add `case 'libredb'`)

**Interfaces:**
- Consumes: `BaseDatabaseProvider`, types from `../../types`, errors from `../../errors`, `formatBytes` from `../../utils/pool-manager`, `@libredb/libredb` (`open`, `kv`, `version`, types `Database`, `Kv`).
- Produces: `class LibreDBProvider extends BaseDatabaseProvider` with public `connect/disconnect/query/getSchema/getHealth/runMaintenance/getOverview/getPerformanceMetrics/getSlowQueries/getActiveSessions/getTableStats/getIndexStats/getStorageStats`, `getCapabilities()`, `getLabels()`, `validate()`. Protected members later tasks rely on: `this.db: LibreDatabase | null`, `this.kv: LibreKv | null`, `this.dbVersion: string`, and private helpers `groupName`, `tokenize`, `renderValue`, `toRows`, `runCommand` (added in Tasks 3-4).

- [ ] **Step 1: Write the failing test**

Create `tests/integration/db/libredb-provider.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
bun run test tests/integration/db/libredb-provider.test.ts
```
Expected: FAIL — cannot resolve `@/lib/db/providers/embedded/libredb` (module does not exist yet).

- [ ] **Step 3: Write the provider (lifecycle + metadata; schema/query stubbed)**

Create `src/lib/db/providers/embedded/libredb.ts`:
```ts
/**
 * LibreDB Embedded Provider
 *
 * Opens a local `.libredb` file in-process via the embedded `@libredb/libredb`
 * package (the SQLite embedded pattern). LibreDB has no server or wire protocol;
 * the file path travels in `config.database`, like SQLite. The on-disk format is
 * raw ordered key-value bytes, so this provider presents keys grouped by their
 * `:`-prefix as pseudo-"tables" (the Redis pattern) and exposes a small
 * get/put/delete/prefix/range command grammar over the kv lens.
 *
 * The package API is synchronous; calls are wrapped to satisfy the async
 * provider contract. The import is lazy and dynamic so the package never enters
 * a client bundle and `build:lib` (tsup) can externalize it.
 */
import { BaseDatabaseProvider } from '../../base-provider';
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderCapabilities,
  type ProviderLabels,
  type PreparedQuery,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from '../../types';
import { DatabaseConfigError, ConnectionError, QueryError } from '../../errors';
import { formatBytes } from '../../utils/pool-manager';
import * as fs from 'fs';

// ============================================================================
// Lazy package loader (mirrors sqlite.ts loading bun:sqlite)
// ============================================================================

type LibreDBModule = typeof import('@libredb/libredb');
type LibreDatabase = import('@libredb/libredb').Database;
type LibreKv = import('@libredb/libredb').Kv;

let libredbModule: LibreDBModule | null = null;
let libredbLoadError: Error | null = null;

async function loadLibreDB(): Promise<LibreDBModule> {
  if (libredbModule) return libredbModule;
  if (libredbLoadError) throw libredbLoadError;
  try {
    libredbModule = await import('@libredb/libredb');
    return libredbModule;
  } catch {
    libredbLoadError = new DatabaseConfigError(
      'LibreDB package (@libredb/libredb) is not available in this environment. Install it with: bun add @libredb/libredb',
      'libredb'
    );
    throw libredbLoadError;
  }
}

// ============================================================================
// LibreDB Provider
// ============================================================================

export class LibreDBProvider extends BaseDatabaseProvider {
  protected db: LibreDatabase | null = null;
  protected kv: LibreKv | null = null;
  protected dbVersion = 'unknown';

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // --------------------------------------------------------------------------
  // Metadata
  // --------------------------------------------------------------------------

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: 'json',
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: null,
      schemaRefreshPattern: '\\b(put|delete)\\b',
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      entityName: 'Key Prefix',
      entityNamePlural: 'Key Prefixes',
      rowName: 'key',
      rowNamePlural: 'keys',
      selectAction: 'Scan Keys',
      generateAction: 'Generate Command',
      analyzeAction: 'Key Info',
      vacuumAction: 'Compact',
      searchPlaceholder: 'Search keys...',
      analyzeGlobalLabel: 'Info',
      analyzeGlobalTitle: 'Database Info',
      analyzeGlobalDesc: 'Show LibreDB file information and key statistics.',
      vacuumGlobalLabel: 'Compact',
      vacuumGlobalTitle: 'Compact',
      vacuumGlobalDesc: 'Not supported for LibreDB in this version.',
    };
  }

  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: 500, offset: 0 };
  }

  // --------------------------------------------------------------------------
  // Validation & lifecycle
  // --------------------------------------------------------------------------

  public validate(): void {
    super.validate();
    if (!this.config.database) {
      throw new DatabaseConfigError(
        'LibreDB requires a file path (use the "database" field, e.g. /data/app.libredb)',
        'libredb'
      );
    }
  }

  public async connect(): Promise<void> {
    const lib = await loadLibreDB(); // DatabaseConfigError propagates if unavailable
    try {
      this.db = lib.open({ path: this.config.database! });
      this.kv = lib.kv(this.db);
      this.dbVersion = lib.version;
      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to open LibreDB file: ${error instanceof Error ? error.message : String(error)}`,
        'libredb'
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.db) {
      try { this.db.close(); } catch { /* close is idempotent; ignore */ }
      this.db = null;
      this.kv = null;
    }
    this.setConnected(false);
  }

  // --------------------------------------------------------------------------
  // Schema & query (filled in Tasks 3-4)
  // --------------------------------------------------------------------------

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();
    return [];
  }

  public async query(_input: string): Promise<QueryResult> {
    this.ensureConnected();
    throw new QueryError('LibreDB query support is not implemented yet', 'libredb');
  }

  // --------------------------------------------------------------------------
  // Monitoring (filled in Task 5; honest minimal defaults for now)
  // --------------------------------------------------------------------------

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();
    return { activeConnections: 1, databaseSize: this.fileSizeHuman(), cacheHitRatio: '100.0', slowQueries: [], activeSessions: [] };
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();
    return {
      version: this.dbVersion,
      uptime: '-',
      activeConnections: 1,
      maxConnections: 1,
      databaseSize: this.fileSizeHuman(),
      databaseSizeBytes: this.fileSizeBytes(),
      tableCount: 0,
      indexCount: 0,
    };
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return { cacheHitRatio: 100 };
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> { return []; }
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> { return []; }
  public async getTableStats(): Promise<TableStats[]> { return []; }
  public async getIndexStats(): Promise<IndexStats[]> { return []; }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return [{ name: 'File', location: this.config.database, size: this.fileSizeHuman(), sizeBytes: this.fileSizeBytes() }];
  }

  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    throw new QueryError(`Maintenance operation "${type}" is not supported for LibreDB`, 'libredb');
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private fileSizeBytes(): number {
    try { return fs.statSync(this.config.database!).size; } catch { return 0; }
  }

  private fileSizeHuman(): string {
    return formatBytes(this.fileSizeBytes());
  }
}
```

- [ ] **Step 4: Add the factory case**

In `src/lib/db/factory.ts`, after the `case 'redis'` block (line 101), add:
```ts
    // Embedded databases - dynamically imported
    case 'libredb': {
      const { LibreDBProvider } = await import('./providers/embedded/libredb');
      return new LibreDBProvider(connection, options);
    }
```
Also update the `default` error message string (line 105) to append `, libredb`.

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
bun run test tests/integration/db/libredb-provider.test.ts
```
Expected: PASS (4 tests in the lifecycle & metadata describe block).

- [ ] **Step 6: Run typecheck + lint**

Run:
```bash
bun run typecheck && bun run lint
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/providers/embedded/libredb.ts tests/integration/db/libredb-provider.test.ts src/lib/db/factory.ts
git commit -m "feat(db): add LibreDBProvider lifecycle, metadata, and factory wiring"
```

---

### Task 3: `getSchema()` — prefix grouping (TDD)

**Files:**
- Modify: `src/lib/db/providers/embedded/libredb.ts` (replace `getSchema` stub, add `groupName`, update `getOverview.tableCount`)
- Modify: `tests/integration/db/libredb-provider.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `this.kv` (from Task 2), `kv.range(start, end)` returning an iterable of `{ key: string; value: string }`.
- Produces: `getSchema()` returns one `TableSchema` per `:`-prefix group, columns `key`/`value`, `rowCount` = keys in the group, sorted by `rowCount` desc.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/db/libredb-provider.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
bun run test tests/integration/db/libredb-provider.test.ts
```
Expected: FAIL — `getSchema` returns `[]`, so `byName['user:*']` is undefined.

- [ ] **Step 3: Implement `getSchema` + `groupName`**

In `src/lib/db/providers/embedded/libredb.ts`, replace the `getSchema` stub with:
```ts
  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();
    const groups = new Map<string, number>();
    let scanned = 0;
    const MAX_SCAN = 10000;
    // Empty-string start encodes to the lowest bytes; '\u{10FFFF}' encodes above
    // any UTF-8 text key the lenses produce, so [start, end) covers the keyspace.
    // (kv.prefix cannot be used here — it rejects an empty prefix.)
    for (const { key } of this.kv!.range('', '\u{10FFFF}')) {
      if (scanned >= MAX_SCAN) break;
      scanned++;
      const name = this.groupName(key);
      groups.set(name, (groups.get(name) ?? 0) + 1);
    }

    const schemas: TableSchema[] = [];
    for (const [name, rowCount] of groups) {
      schemas.push({
        name,
        columns: [
          { name: 'key', type: 'string', nullable: false, isPrimary: true },
          { name: 'value', type: 'string', nullable: true, isPrimary: false },
        ],
        indexes: [],
        rowCount,
      });
    }
    return schemas.sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0));
  }

  /** Group key "user:1" under "user:*"; a key with no ":" is its own group. */
  private groupName(key: string): string {
    const colon = key.indexOf(':');
    return colon > 0 ? `${key.slice(0, colon)}:*` : key;
  }
```
Then update `getOverview` so `tableCount` reflects the groups:
```ts
      tableCount: (await this.getSchema()).length,
```
(replace the `tableCount: 0,` line).

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
bun run test tests/integration/db/libredb-provider.test.ts
```
Expected: PASS (lifecycle + getSchema describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/providers/embedded/libredb.ts tests/integration/db/libredb-provider.test.ts
git commit -m "feat(db): implement libredb getSchema prefix grouping"
```

---

### Task 4: `query()` — get / put / delete / prefix / range command grammar (TDD)

**Files:**
- Modify: `src/lib/db/providers/embedded/libredb.ts` (replace `query` stub; add `runCommand`, `tokenize`, `renderValue`, `toRows`)
- Modify: `tests/integration/db/libredb-provider.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `this.kv` with `get(key): string | undefined`, `set(key, value): { changed }`, `delete(key): { changed }`, `prefix(p): Iterable<{key,value}>`, `range(start,end): Iterable<{key,value}>`.
- Produces: `query(input)` returns a `QueryResult`. Read rows use fields `['key','value']`; writes use fields `['changed']`. JSON values are pretty-printed.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/db/libredb-provider.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
bun run test tests/integration/db/libredb-provider.test.ts
```
Expected: FAIL — `query` throws "not implemented yet".

- [ ] **Step 3: Implement the command grammar**

In `src/lib/db/providers/embedded/libredb.ts`, replace the `query` stub with:
```ts
  public async query(input: string): Promise<QueryResult> {
    this.ensureConnected();
    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => this.runCommand(input));
      return { ...result, executionTime };
    });
  }

  private runCommand(input: string): Omit<QueryResult, 'executionTime'> {
    const parts = this.tokenize(input.trim());
    if (parts.length === 0) throw new QueryError('Empty command', 'libredb');
    const kv = this.kv!;
    const verb = parts[0].toLowerCase();

    switch (verb) {
      case 'get': {
        if (parts.length < 2) throw new QueryError('Usage: get <key>', 'libredb');
        const value = kv.get(parts[1]);
        if (value === undefined) return { rows: [], fields: ['key', 'value'], rowCount: 0 };
        return { rows: [{ key: parts[1], value: this.renderValue(value) }], fields: ['key', 'value'], rowCount: 1 };
      }
      case 'put': {
        if (parts.length < 3) throw new QueryError('Usage: put <key> <value>', 'libredb');
        const { changed } = kv.set(parts[1], parts.slice(2).join(' '));
        return { rows: [{ changed }], fields: ['changed'], rowCount: changed };
      }
      case 'delete': {
        if (parts.length < 2) throw new QueryError('Usage: delete <key>', 'libredb');
        const { changed } = kv.delete(parts[1]);
        return { rows: [{ changed }], fields: ['changed'], rowCount: changed };
      }
      case 'prefix': {
        if (parts.length < 2) throw new QueryError('Usage: prefix <p>', 'libredb');
        return this.toRows(kv.prefix(parts[1]));
      }
      case 'range': {
        if (parts.length < 3) throw new QueryError('Usage: range <start> <end>', 'libredb');
        return this.toRows(kv.range(parts[1], parts[2]));
      }
      default:
        throw new QueryError(`Unknown command "${verb}". Supported: get, put, delete, prefix, range`, 'libredb');
    }
  }

  /** Split on whitespace, honoring single/double quotes (Redis-style). */
  private tokenize(input: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    let sawToken = false;
    for (const ch of input) {
      if (!inQuote && (ch === '"' || ch === "'")) {
        inQuote = true; quoteChar = ch; sawToken = true;
      } else if (inQuote && ch === quoteChar) {
        inQuote = false;
      } else if (!inQuote && /\s/.test(ch)) {
        if (sawToken) { parts.push(current); current = ''; sawToken = false; }
      } else {
        current += ch; sawToken = true;
      }
    }
    if (sawToken) parts.push(current);
    return parts;
  }

  /** Pretty-print a JSON value; leave non-JSON strings as-is. */
  private renderValue(value: string): string {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }

  private toRows(scan: Iterable<{ key: string; value: string }>): Omit<QueryResult, 'executionTime'> {
    const rows: Record<string, unknown>[] = [];
    for (const { key, value } of scan) rows.push({ key, value: this.renderValue(value) });
    return { rows, fields: ['key', 'value'], rowCount: rows.length };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
bun run test tests/integration/db/libredb-provider.test.ts
```
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/providers/embedded/libredb.ts tests/integration/db/libredb-provider.test.ts
git commit -m "feat(db): implement libredb query command grammar"
```

---

### Task 5: Monitoring fidelity (TDD)

Locks the monitoring surface with a test now that `getSchema` is real: overview reports the actual file size and group count; storage lists the file; unsupported maintenance throws.

**Files:**
- Modify: `tests/integration/db/libredb-provider.test.ts` (add a describe block)
- Modify: `src/lib/db/providers/embedded/libredb.ts` (only if a test fails — the Task 2/3 implementations should already satisfy these)

**Interfaces:**
- Consumes: `getOverview`, `getStorageStats`, `runMaintenance` from Task 2/3.
- Produces: no new symbols; this task is a behavioural lock.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/db/libredb-provider.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the test**

Run:
```bash
bun run test tests/integration/db/libredb-provider.test.ts
```
Expected: PASS (the Task 2/3 implementations already satisfy these). If any assertion fails, fix the corresponding method in `libredb.ts` minimally to satisfy it, then re-run.

- [ ] **Step 3: Run the full unit/api/integration suite**

Run:
```bash
bun run test
```
Expected: PASS — confirms the new provider did not disturb existing suites.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/db/libredb-provider.test.ts src/lib/db/providers/embedded/libredb.ts
git commit -m "test(db): lock libredb monitoring surface"
```

---

### Task 6: Connection UI — file-based layout and editor selectability

Makes `libredb` selectable in the connection dropdown and renders a file-path-only form (no host/port/credentials/SSL/SSH), driven by `isFileBased(type)` so no provider id is hard-coded. This also corrects the modal for any file-based provider.

**Files:**
- Modify: `src/hooks/use-connection-form.ts:292` (selectableTypes)
- Modify: `src/components/ConnectionModal.tsx` (file-based field layout; `isFileBased` guard for SSL/SSH)

**Interfaces:**
- Consumes: `isFileBased` from `@/lib/db-ui-config` (Task 1).
- Produces: a `libredb` option in the connection dropdown; a file-path input bound to `database` when `isFileBased(type)`.

- [ ] **Step 1: Add `libredb` to the selectable types**

In `src/hooks/use-connection-form.ts:292`:
```ts
  const selectableTypes: DatabaseType[] = ['postgres', 'mysql', 'oracle', 'mssql', 'mongodb', 'redis', 'libredb'];
```

- [ ] **Step 2: Import the helper and branch the field layout**

In `src/components/ConnectionModal.tsx`, add `isFileBased` to the existing import from `@/lib/db-ui-config` (line 11):
```ts
import { getDBConfig, isFileBased } from '@/lib/db-ui-config';
```
Wrap the existing host/user/password/database block. Find the `) : (` at line 284 that opens the non-connection-string branch and its matching `</>` close at line 351-352. Replace the opening `<>` (line 285) with a file-based conditional. Concretely, change line 284-285 from:
```tsx
                  ) : (
                    <>
```
to:
```tsx
                  ) : isFileBased(type) ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-1">
                        <Database strokeWidth={1.5} className="w-3 h-3 text-zinc-500" />
                        <Label htmlFor="database" className="text-xs font-mediumr text-zinc-500">Database File Path</Label>
                      </div>
                      <Input
                        id="database"
                        value={database}
                        onChange={(e) => setDatabase(e.target.value)}
                        placeholder="/data/app.libredb"
                        className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-xs font-mono"
                      />
                    </div>
                  ) : (
                    <>
```
(The `Database` icon and `Input`/`Label` components are already imported in this file.)

- [ ] **Step 3: Hide SSL/SSH for file-based providers**

In `src/components/ConnectionModal.tsx:418`, change:
```tsx
          {type !== 'sqlite' && (
```
to:
```tsx
          {!isFileBased(type) && (
```

- [ ] **Step 4: Run typecheck + lint**

Run:
```bash
bun run typecheck && bun run lint
```
Expected: PASS.

- [ ] **Step 5: Manually verify the form (dev server)**

Run `bun dev`, open the app, click "Add Connection", choose **LibreDB** from the type dropdown. Confirm: only a "Database File Path" input shows (no host/port/user/password), and the SSL/SSH panels are hidden. Point it at a `.libredb` file created by `@libredb/libredb`, connect, and confirm key prefixes appear as tables and `get <key>` returns rows. Note the result in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/use-connection-form.ts src/components/ConnectionModal.tsx
git commit -m "feat(ui): make libredb selectable with a file-path connection form"
```

---

### Task 7: Provider documentation (tri-sync)

**Files:**
- Create: `docs/providers/libredb.md`
- Modify: `docs/providers/libredb-provider-design.md` (mark superseded — point to the spec and this doc)

**Interfaces:** none (documentation).

- [ ] **Step 1: Write `docs/providers/libredb.md`**

Follow the structure of a sibling doc (open `docs/providers/redis.md` for the template — sections: overview, connection fields, query format, capabilities, schema model, examples, limitations). The doc MUST mirror the implemented code exactly:
- **Type id:** `libredb`. **Connection:** `{ type: 'libredb', database: '/path/to/app.libredb' }` — file-based, server-side only, embedded in-process.
- **Query format:** the command grammar `get <key>`, `put <key> <value>`, `delete <key>`, `prefix <p>`, `range <start> <end>`; reads return `key`/`value` rows (JSON pretty-printed), writes return `changed`.
- **Schema model:** keys grouped by `:`-prefix into pseudo-tables (`key`/`value` columns); not relational tables — a `.libredb` file is raw ordered KV.
- **Capabilities:** no SQL, no explain, no create-table, no maintenance; read+write.
- **Limitations:** no multi-key transactions in the UI; no in-memory connections; faithful per-kind catalog views deferred to a future database-side catalog.
Cross-reference the spec at `docs/superpowers/specs/2026-06-24-libredb-embedded-provider-design.md`.

- [ ] **Step 2: Mark the precursor design doc superseded**

At the top of `docs/providers/libredb-provider-design.md`, change the status line to note it is superseded by `docs/superpowers/specs/2026-06-24-libredb-embedded-provider-design.md` (spec) and `docs/providers/libredb.md` (provider reference).

- [ ] **Step 3: Verify links resolve**

Run:
```bash
ls docs/providers/libredb.md docs/superpowers/specs/2026-06-24-libredb-embedded-provider-design.md
```
Expected: both paths exist.

- [ ] **Step 4: Commit**

```bash
git add docs/providers/libredb.md docs/providers/libredb-provider-design.md
git commit -m "docs(providers): add libredb provider reference (tri-sync)"
```

---

### Task 8: Full verification gates

**Files:** none (verification only).

- [ ] **Step 1: Run the four mandatory gates**

Run:
```bash
bun run lint && bun run typecheck && bun run test && bun run build
```
Expected: all PASS. If any fails, fix it in the owning task's files and re-run before proceeding.

- [ ] **Step 2: Run the library build (platform-facing change)**

Run:
```bash
bun run build:lib
```
Expected: PASS. Confirm `@libredb/libredb` is treated as external (not bundled) — it must not appear inlined in `dist/`. Spot-check:
```bash
grep -rl "@libredb/libredb" dist/ | head
```
Expected: references are `import`/`require('@libredb/libredb')` (externalized), not the package's inlined source.

- [ ] **Step 3: Final commit (only if the gates produced changes)**

```bash
git add -A
git commit -m "chore(db): finalize libredb provider verification"
```
(Skip if there is nothing to commit.)

---

## Self-Review

**Spec coverage** (each spec section → task):
- §3 Dependency strategy → Task 1 (install + tsup external) + Task 2 (lazy loader).
- §4 Connection shape (reuse `database`, union) → Task 1 (union) + Task 6 (form).
- §5.1 Lifecycle → Task 2. §5.2 getSchema prefix grouping → Task 3. §5.3 query grammar → Task 4. §5.4 capabilities/labels → Task 2. §5.5 monitoring → Task 2 + Task 5.
- §6 UI/config wiring → Task 1 (union, UI config, icon, seed) + Task 6 (dropdown, modal). Connection-string-parser intentionally skipped (file-based providers have no URI, matching SQLite). Studio.tsx tab mapping intentionally untouched (capability-driven: `queryLanguage: 'json'` yields the same editor behaviour Redis already has).
- §7 Tri-sync deliverables → code (Tasks 2-4), tests (Tasks 2-5), docs (Task 7).
- §8 Testing strategy (TDD, real package, temp file, no mock.module) → Tasks 2-5.
- §9 Later (catalog) → documented in Task 7; out of build scope.
- §10 Verification gates → Task 8.

**Placeholder scan:** No "TBD"/"handle edge cases"/"write tests for the above" — every code step shows complete code; every test step shows complete assertions.

**Type consistency:** `this.db`/`this.kv`/`this.dbVersion` declared in Task 2 and used unchanged in Tasks 3-5. `groupName`/`tokenize`/`renderValue`/`toRows`/`runCommand` are introduced and consumed consistently. `isFileBased` defined in Task 1, consumed in Task 6. `QueryResult` rows/fields/rowCount match `src/lib/types.ts`. Error constructors match `errors.ts` signatures (`QueryError(message, provider)`, `ConnectionError(message, provider)`, `DatabaseConfigError(message, provider)`).
