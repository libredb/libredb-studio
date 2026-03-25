# Seed Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable pre-configured database connections via YAML/JSON config file with role-based access control and hybrid managed/unmanaged model.

**Architecture:** Dedicated `src/lib/seed/` module reads a volume-mounted config file at runtime (TTL-cached), resolves `${ENV_VAR}` credentials from `process.env`, filters by user role, and serves managed connections via a new API endpoint. A shared `resolveConnection()` utility is injected into 13 existing DB API routes to handle `seed:` prefixed connection IDs server-side. Client hooks merge managed connections with user connections, sending `connectionId` instead of full credentials for managed connections.

**Tech Stack:** TypeScript, Zod v4 (validation — project uses `^4.1.12`), `yaml` npm package (YAML parsing), Next.js API routes, existing JWT auth (`jose`)

**Spec:** `docs/superpowers/specs/2026-03-25-seed-connections-design.md`

**Important notes:**
- Project uses **Zod v4** (`^4.1.12`). All schema code uses v4 API (`.check()` instead of `.refine()` for some patterns, `z.object()` still supports `.strict()`). Verify Zod v4 compatibility at each step.
- **`disconnect/route.ts` is EXCLUDED** from `resolveConnection()` injection — it already accepts `connectionId` as a cache key for provider teardown, not connection establishment. The `seed:X` prefixed IDs flow naturally because `resolveConnection()` sets `id = "seed:X"` which becomes the cache key.
- **`POST /api/db/health`** (connection-level health check) IS included as an affected route.
- `pool-stats/route.ts` and `provider-meta/route.ts` are both **POST** routes, not GET.

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/seed/types.ts` | Zod v4 schemas + TS types: `SeedConfig`, `SeedConnection`, `SeedDefaults`, `ManagedConnection` |
| `src/lib/seed/config-loader.ts` | Read YAML/JSON from disk, validate with Zod, TTL cache |
| `src/lib/seed/credential-resolver.ts` | Resolve `${VAR}` patterns from `process.env`, per-connection error isolation |
| `src/lib/seed/connection-filter.ts` | Merge defaults, filter by role, map to `ManagedConnection` |
| `src/lib/seed/resolve-connection.ts` | Shared utility for all API routes: detect `seed:` prefix, resolve full credentials, verify role |
| `src/lib/seed/index.ts` | Barrel export: `getManagedConnections(roles)` + `getSeedConnectionById()` + `getSeedConnectionByIdUnfiltered()` |
| `src/hooks/use-connection-payload.ts` | Shared helper: `buildConnectionPayload(conn)` — returns `{ connectionId }` or `{ connection }` based on `managed` flag |
| `src/app/api/connections/managed/route.ts` | `GET /api/connections/managed` — auth + role filter + credential stripping |
| `charts/libredb-studio/templates/seed-configmap.yaml` | Helm ConfigMap for seed config |
| `tests/fixtures/seed-connections/valid-config.yaml` | Full valid config fixture |
| `tests/fixtures/seed-connections/valid-config.json` | Same config in JSON format (for format detection test) |
| `tests/fixtures/seed-connections/minimal-config.yaml` | Minimum required fields only |
| `tests/fixtures/seed-connections/invalid-config.yaml` | Validation failure cases |
| `tests/fixtures/seed-connections/mixed-credentials.yaml` | Some `${VAR}`, some plaintext |
| `tests/fixtures/seed-connections/multi-role-config.yaml` | Different roles per connection |
| `tests/unit/seed/types.test.ts` | Zod schema validation tests |
| `tests/unit/seed/config-loader.test.ts` | File read, parse, cache, error handling |
| `tests/unit/seed/credential-resolver.test.ts` | Env var resolution, skip, warn |
| `tests/unit/seed/connection-filter.test.ts` | Role filter, defaults merge, mapping |
| `tests/unit/seed/index.test.ts` | Orchestrator + getSeedConnectionById tests |
| `tests/unit/seed/resolve-connection.test.ts` | Seed prefix detection, role check, fallback |
| `tests/api/seed/managed-route.test.ts` | API endpoint auth, filter, strip, errors |
| `tests/integration/seed/seed-pipeline.test.ts` | Full pipeline + multi-route resolution |

**Not in this plan (future task):** `e2e/seed-connections.spec.ts` — Playwright E2E test for managed connections in sidebar. Requires running app with seed config, best handled as a separate task after core implementation is stable.

### Modified Files

| File | Change |
|------|--------|
| `src/lib/types.ts:42-61` | Add `managed?: boolean`, `seedId?: string` to `DatabaseConnection` |
| `src/lib/audit.ts` | Add `'managed_connection'` to `AuditEventType` |
| `src/app/api/db/query/route.ts` | Import `resolveConnection`, use before `getOrCreateProvider` |
| `src/app/api/db/schema/route.ts` | Same pattern (also change body parsing to `req.json()`) |
| `src/app/api/db/multi-query/route.ts` | Same pattern |
| `src/app/api/db/transaction/route.ts` | Same pattern |
| `src/app/api/db/cancel/route.ts` | Same pattern |
| `src/app/api/db/maintenance/route.ts` | Same pattern |
| `src/app/api/db/monitoring/route.ts` | Same pattern |
| `src/app/api/db/pool-stats/route.ts` | Same pattern (POST route) |
| `src/app/api/db/profile/route.ts` | Same pattern |
| `src/app/api/db/provider-meta/route.ts` | Same pattern (POST route) |
| `src/app/api/db/test-connection/route.ts` | Same pattern |
| `src/app/api/db/schema-snapshot/route.ts` | Same pattern |
| `src/app/api/db/health/route.ts` | Same pattern (POST connection health check) |
| `src/hooks/use-connection-manager.ts` | Fetch managed connections, merge with user connections, update `fetchSchema` |
| `src/hooks/use-query-execution.ts` | Use `buildConnectionPayload()` at all 5 fetch sites |
| `src/hooks/use-transaction-control.ts` | Use `buildConnectionPayload()` |
| `src/components/sidebar/ConnectionItem.tsx:82-106` | Lock icon for managed, hide edit/delete |
| `charts/libredb-studio/values.yaml` | Add `seedConnections` section |
| `charts/libredb-studio/values.schema.json` | Add `seedConnections` schema |
| `charts/libredb-studio/templates/deployment.yaml` | Volume mount + env vars |
| `docker-compose.yml` | Add seed config volume mount example |
| `.env.example` | Document new env vars |

**NOT modified:** `src/app/api/db/disconnect/route.ts` — already accepts `connectionId` as cache key, `seed:X` IDs work naturally.

---

## Task 1: Install `yaml` dependency + add test fixtures

**Files:**
- Modify: `package.json`
- Create: `tests/fixtures/seed-connections/valid-config.yaml`
- Create: `tests/fixtures/seed-connections/valid-config.json`
- Create: `tests/fixtures/seed-connections/minimal-config.yaml`
- Create: `tests/fixtures/seed-connections/invalid-config.yaml`
- Create: `tests/fixtures/seed-connections/mixed-credentials.yaml`
- Create: `tests/fixtures/seed-connections/multi-role-config.yaml`

- [ ] **Step 1: Install yaml package**

```bash
bun add yaml
```

- [ ] **Step 2: Create valid-config.yaml fixture**

```yaml
# tests/fixtures/seed-connections/valid-config.yaml
version: "1"

defaults:
  managed: true
  environment: production

connections:
  - id: "test-postgres"
    name: "Test PostgreSQL"
    type: postgres
    host: pg.internal
    port: 5432
    database: testdb
    user: "testuser"
    password: "${TEST_PG_PASSWORD}"
    environment: production
    group: "Backend"
    roles: ["admin"]
    managed: true
    color: "#10B981"

  - id: "test-mysql"
    name: "Test MySQL"
    type: mysql
    host: mysql.internal
    port: 3306
    database: appdb
    user: "devuser"
    password: "${TEST_MYSQL_PASSWORD}"
    environment: staging
    group: "Backend"
    roles: ["*"]
    managed: false

  - id: "test-mongo"
    name: "Test MongoDB"
    type: mongodb
    connectionString: "${TEST_MONGO_URI}"
    group: "Platform"
    roles: ["admin"]
    managed: true

  - id: "test-redis"
    name: "Test Redis"
    type: redis
    host: redis.internal
    port: 6379
    database: "0"
    password: "${TEST_REDIS_PASSWORD}"
    roles: ["*"]
    managed: true
```

- [ ] **Step 3: Create valid-config.json fixture** (same data, JSON format)

```json
{
  "version": "1",
  "defaults": { "managed": true, "environment": "production" },
  "connections": [
    {
      "id": "test-postgres",
      "name": "Test PostgreSQL",
      "type": "postgres",
      "host": "pg.internal",
      "port": 5432,
      "password": "${TEST_PG_PASSWORD}",
      "roles": ["admin"]
    }
  ]
}
```

- [ ] **Step 4: Create minimal-config.yaml, invalid-config.yaml, mixed-credentials.yaml, multi-role-config.yaml**

(Same content as previous plan version — these fixtures are unchanged)

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lockb tests/fixtures/seed-connections/
git commit -m "feat(seed): add yaml dependency and test fixtures for seed connections"
```

---

## Task 2: Types + Zod v4 Schemas (`src/lib/seed/types.ts`)

**Files:**
- Modify: `src/lib/types.ts:42-61`
- Create: `src/lib/seed/types.ts`
- Create: `tests/unit/seed/types.test.ts`

**Important:** Project uses Zod v4 (`^4.1.12`). Key v4 changes: `z.object()` still works, `.strict()` still works, `.safeParse()` returns `{ success, data, error }`, `.refine()` still works. Verify with `bun test` at each step.

- [ ] **Step 1: Add `managed` and `seedId` to DatabaseConnection**

In `src/lib/types.ts`, add two optional fields after `instanceName?` (line 60):

```typescript
  managed?: boolean;     // true = admin-controlled, read-only in UI
  seedId?: string;       // stable reference to seed config ID
```

- [ ] **Step 2: Write failing tests for Zod schemas**

Create `tests/unit/seed/types.test.ts` — same tests as previous plan, but **without `'prefer'` in SSLMode** and with Zod v4 API compatibility confirmed:

```typescript
import { describe, it, expect } from 'bun:test';
import {
  SeedConnectionSchema,
  SeedConfigSchema,
  SeedDefaultsSchema,
} from '@/lib/seed/types';

describe('SeedConnectionSchema', () => {
  const validConn = {
    id: 'test-pg',
    name: 'Test PG',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    roles: ['admin'],
  };

  it('accepts a valid connection', () => {
    const result = SeedConnectionSchema.safeParse(validConn);
    expect(result.success).toBe(true);
  });

  it('rejects invalid id format (uppercase)', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, id: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects demo type', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, type: 'demo' });
    expect(result.success).toBe(false);
  });

  it('rejects empty roles array', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: [] });
    expect(result.success).toBe(false);
  });

  it('accepts wildcard role', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ['*'] });
    expect(result.success).toBe(true);
  });

  it('rejects unknown roles like data-team', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ['data-team'] });
    expect(result.success).toBe(false);
  });

  it('accepts combined admin and user roles', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, roles: ['admin', 'user'] });
    expect(result.success).toBe(true);
  });

  it('rejects invalid port range', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, port: 99999 });
    expect(result.success).toBe(false);
  });

  it('accepts valid color hex', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, color: '#10B981' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid color format', () => {
    const result = SeedConnectionSchema.safeParse({ ...validConn, color: 'red' });
    expect(result.success).toBe(false);
  });

  it('accepts all 7 valid database types', () => {
    for (const type of ['postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'oracle', 'mssql']) {
      const result = SeedConnectionSchema.safeParse({ ...validConn, type });
      expect(result.success).toBe(true);
    }
  });
});

describe('SeedConfigSchema', () => {
  it('accepts valid config with version 1', () => {
    const result = SeedConfigSchema.safeParse({
      version: '1',
      connections: [{ id: 'a', name: 'A', type: 'postgres', host: 'h', roles: ['*'] }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects version 2', () => {
    const result = SeedConfigSchema.safeParse({
      version: '2',
      connections: [{ id: 'a', name: 'A', type: 'postgres', host: 'h', roles: ['*'] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate connection IDs', () => {
    const result = SeedConfigSchema.safeParse({
      version: '1',
      connections: [
        { id: 'dup', name: 'A', type: 'postgres', host: 'h', roles: ['*'] },
        { id: 'dup', name: 'B', type: 'mysql', host: 'h', roles: ['*'] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty connections array', () => {
    const result = SeedConfigSchema.safeParse({ version: '1', connections: [] });
    expect(result.success).toBe(false);
  });
});

describe('SeedDefaultsSchema', () => {
  it('accepts valid ssl config with mode require', () => {
    const result = SeedDefaultsSchema.safeParse({
      ssl: { mode: 'require', rejectUnauthorized: true },
    });
    expect(result.success).toBe(true);
  });

  it('rejects ssl mode prefer (not in SSLMode type)', () => {
    const result = SeedDefaultsSchema.safeParse({
      ssl: { mode: 'prefer' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid environment', () => {
    const result = SeedDefaultsSchema.safeParse({ environment: 'unknown' });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
bun test tests/unit/seed/types.test.ts
```

Expected: FAIL — `@/lib/seed/types` does not exist yet

- [ ] **Step 4: Implement types.ts**

Create `src/lib/seed/types.ts`:

```typescript
import { z } from 'zod';
import type { DatabaseConnection } from '@/lib/types';

// SSLMode matches src/lib/types.ts line 21 — NO 'prefer'
const SSLModeSchema = z.enum(['disable', 'require', 'verify-ca', 'verify-full']);

const SSLConfigSchema = z.object({
  mode: SSLModeSchema.optional(),
  rejectUnauthorized: z.boolean().optional(),
  caCert: z.string().optional(),
  clientCert: z.string().optional(),
  clientKey: z.string().optional(),
}).optional();

const ConnectionEnvironmentSchema = z.enum([
  'production', 'staging', 'development', 'local', 'other',
]);

// Allowed roles in current iteration (matches JWT role: 'admin' | 'user' + wildcard)
const AllowedRoleSchema = z.enum(['*', 'admin', 'user']);

const SeedDatabaseType = z.enum([
  'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'oracle', 'mssql',
]);

export const SeedDefaultsSchema = z.object({
  managed: z.boolean().optional(),
  environment: ConnectionEnvironmentSchema.optional(),
  ssl: SSLConfigSchema,
});

export const SeedConnectionSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'ID must be lowercase alphanumeric with hyphens'),
  name: z.string().min(1).max(128),
  type: SeedDatabaseType,
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  connectionString: z.string().optional(),
  environment: ConnectionEnvironmentSchema.optional(),
  group: z.string().max(64).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  roles: z.array(AllowedRoleSchema).min(1, 'At least one role is required'),
  managed: z.boolean().optional(),
  ssl: SSLConfigSchema,
  serviceName: z.string().optional(),
  instanceName: z.string().optional(),
});

export const SeedConfigSchema = z.object({
  version: z.literal('1'),
  defaults: SeedDefaultsSchema.optional(),
  connections: z.array(SeedConnectionSchema).min(1, 'At least one connection is required'),
}).refine(
  (cfg) => new Set(cfg.connections.map((c) => c.id)).size === cfg.connections.length,
  { message: 'Connection IDs must be unique' },
);

export type SeedConnection = z.infer<typeof SeedConnectionSchema>;
export type SeedDefaults = z.infer<typeof SeedDefaultsSchema>;
export type SeedConfig = z.infer<typeof SeedConfigSchema>;

export interface ManagedConnection extends DatabaseConnection {
  managed: boolean;
  roles: string[];
  seedId: string;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/unit/seed/types.test.ts
```

Expected: All PASS. If Zod v4 API differs, adjust accordingly.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/seed/types.ts tests/unit/seed/types.test.ts
git commit -m "feat(seed): add Zod v4 schemas and types for seed connections"
```

---

## Task 3: Config Loader (`src/lib/seed/config-loader.ts`)

**Files:**
- Create: `src/lib/seed/config-loader.ts`
- Create: `tests/unit/seed/config-loader.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/seed/config-loader.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import { loadConfig, resetCache } from '@/lib/seed/config-loader';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/seed-connections');

describe('config-loader', () => {
  beforeEach(() => {
    resetCache();
  });

  afterEach(() => {
    delete process.env.SEED_CONFIG_PATH;
    delete process.env.SEED_CACHE_TTL_MS;
  });

  it('loads and parses valid YAML config', async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, 'valid-config.yaml');
    const config = await loadConfig();
    expect(config).not.toBeNull();
    expect(config!.version).toBe('1');
    expect(config!.connections).toHaveLength(4);
    expect(config!.connections[0].id).toBe('test-postgres');
  });

  it('loads and parses valid JSON config', async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, 'valid-config.json');
    const config = await loadConfig();
    expect(config).not.toBeNull();
    expect(config!.version).toBe('1');
    expect(config!.connections).toHaveLength(1);
  });

  it('returns null when config file does not exist', async () => {
    process.env.SEED_CONFIG_PATH = '/nonexistent/path/config.yaml';
    const config = await loadConfig();
    expect(config).toBeNull();
  });

  it('throws on invalid YAML (validation fails)', async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, 'invalid-config.yaml');
    await expect(loadConfig()).rejects.toThrow();
  });

  it('uses default path when SEED_CONFIG_PATH not set', async () => {
    const config = await loadConfig();
    expect(config).toBeNull();
  });

  it('caches result within TTL', async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, 'valid-config.yaml');
    process.env.SEED_CACHE_TTL_MS = '60000';
    const config1 = await loadConfig();
    const config2 = await loadConfig();
    expect(config1).toBe(config2); // same reference
  });

  it('reloads after cache reset', async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, 'valid-config.yaml');
    const config1 = await loadConfig();
    resetCache();
    const config2 = await loadConfig();
    expect(config1).not.toBe(config2); // different reference
    expect(config1!.connections).toHaveLength(config2!.connections.length);
  });

  it('loads minimal config with only required fields', async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, 'minimal-config.yaml');
    const config = await loadConfig();
    expect(config).not.toBeNull();
    expect(config!.connections).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/unit/seed/config-loader.test.ts
```

- [ ] **Step 3: Implement config-loader.ts**

Create `src/lib/seed/config-loader.ts` — same implementation as before (readFile → parse YAML/JSON → Zod validate → TTL cache).

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/unit/seed/config-loader.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/seed/config-loader.ts tests/unit/seed/config-loader.test.ts
git commit -m "feat(seed): implement config loader with YAML/JSON parsing and TTL cache"
```

---

## Task 4: Credential Resolver (`src/lib/seed/credential-resolver.ts`)

**Files:**
- Create: `src/lib/seed/credential-resolver.ts`
- Create: `tests/unit/seed/credential-resolver.test.ts`

- [ ] **Step 1: Write failing tests** (same as before)
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement credential-resolver.ts** (same as before)
- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit**

```bash
git add src/lib/seed/credential-resolver.ts tests/unit/seed/credential-resolver.test.ts
git commit -m "feat(seed): implement credential resolver with env var injection"
```

---

## Task 5: Connection Filter (`src/lib/seed/connection-filter.ts`)

**Files:**
- Create: `src/lib/seed/connection-filter.ts`
- Create: `tests/unit/seed/connection-filter.test.ts`

- [ ] **Step 1: Write failing tests** (same as before)
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement connection-filter.ts** (same as before)
- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit**

```bash
git add src/lib/seed/connection-filter.ts tests/unit/seed/connection-filter.test.ts
git commit -m "feat(seed): implement connection filter with role matching and defaults merge"
```

---

## Task 6: Barrel Export + Orchestrator (`src/lib/seed/index.ts`) + Tests

**Files:**
- Create: `src/lib/seed/index.ts`
- Create: `tests/unit/seed/index.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/seed/index.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import {
  getManagedConnections,
  getSeedConnectionById,
  getSeedConnectionByIdUnfiltered,
  resetCache,
} from '@/lib/seed';
import { resetPlaintextWarnings } from '@/lib/seed/credential-resolver';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/seed-connections');

describe('seed/index orchestrator', () => {
  beforeEach(() => {
    resetCache();
    resetPlaintextWarnings();
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, 'multi-role-config.yaml');
    process.env.ADMIN_PG_PASS = 'admin-secret';
    process.env.USER_MYSQL_PASS = 'user-secret';
    process.env.SHARED_PG_PASS = 'shared-secret';
    process.env.BOTH_PG_PASS = 'both-secret';
  });

  afterEach(() => {
    delete process.env.SEED_CONFIG_PATH;
    delete process.env.ADMIN_PG_PASS;
    delete process.env.USER_MYSQL_PASS;
    delete process.env.SHARED_PG_PASS;
    delete process.env.BOTH_PG_PASS;
  });

  it('getManagedConnections returns role-filtered connections', async () => {
    const adminConns = await getManagedConnections(['admin']);
    expect(adminConns.length).toBeGreaterThanOrEqual(3); // admin-only, everyone, admin-and-user

    const userConns = await getManagedConnections(['user']);
    const userIds = userConns.map((c) => c.seedId);
    expect(userIds).toContain('everyone');
    expect(userIds).toContain('user-only');
    expect(userIds).not.toContain('admin-only');
  });

  it('getSeedConnectionById returns connection with role check', async () => {
    const conn = await getSeedConnectionById('everyone', ['user']);
    expect(conn).not.toBeNull();
    expect(conn!.seedId).toBe('everyone');
    expect(conn!.password).toBe('shared-secret');
  });

  it('getSeedConnectionById returns null when role mismatches', async () => {
    const conn = await getSeedConnectionById('admin-only', ['user']);
    expect(conn).toBeNull();
  });

  it('getSeedConnectionByIdUnfiltered returns connection regardless of role', async () => {
    const conn = await getSeedConnectionByIdUnfiltered('admin-only');
    expect(conn).not.toBeNull();
    expect(conn!.seedId).toBe('admin-only');
  });

  it('getSeedConnectionByIdUnfiltered returns null for nonexistent ID', async () => {
    const conn = await getSeedConnectionByIdUnfiltered('nonexistent');
    expect(conn).toBeNull();
  });

  it('returns empty array when config file missing', async () => {
    process.env.SEED_CONFIG_PATH = '/nonexistent.yaml';
    resetCache();
    const conns = await getManagedConnections(['admin']);
    expect(conns).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/unit/seed/index.test.ts
```

- [ ] **Step 3: Implement index.ts**

Create `src/lib/seed/index.ts`:

```typescript
import { loadConfig, resetCache } from './config-loader';
import { resolveAllCredentials } from './credential-resolver';
import { filterByRoles, mergeDefaults } from './connection-filter';
import type { ManagedConnection } from './types';

export type { ManagedConnection, SeedConfig, SeedConnection, SeedDefaults } from './types';
export { SeedConfigSchema, SeedConnectionSchema, SeedDefaultsSchema } from './types';
export { resetCache } from './config-loader';
export { resetPlaintextWarnings } from './credential-resolver';

async function loadAndResolve(): Promise<ManagedConnection[]> {
  const config = await loadConfig();
  if (!config) return [];

  const withDefaults = config.connections.map((conn) =>
    mergeDefaults(conn, config.defaults),
  );

  const resolved = resolveAllCredentials(withDefaults);
  // Return all resolved connections (unfiltered) for internal use
  return filterByRoles(resolved, ['*', 'admin', 'user']);
}

export async function getManagedConnections(roles: string[]): Promise<ManagedConnection[]> {
  const config = await loadConfig();
  if (!config) return [];

  const withDefaults = config.connections.map((conn) =>
    mergeDefaults(conn, config.defaults),
  );

  const resolved = resolveAllCredentials(withDefaults);
  return filterByRoles(resolved, roles);
}

export async function getSeedConnectionById(
  seedId: string,
  roles: string[],
): Promise<ManagedConnection | null> {
  const all = await getManagedConnections(roles);
  return all.find((c) => c.seedId === seedId) ?? null;
}

/**
 * Get seed connection by ID WITHOUT role filtering.
 * Used only for 403-vs-404 differentiation in resolveConnection().
 */
export async function getSeedConnectionByIdUnfiltered(
  seedId: string,
): Promise<ManagedConnection | null> {
  const all = await loadAndResolve();
  return all.find((c) => c.seedId === seedId) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/unit/seed/index.test.ts
```

- [ ] **Step 5: Run all seed unit tests**

```bash
bun test tests/unit/seed/
```

Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/seed/index.ts tests/unit/seed/index.test.ts
git commit -m "feat(seed): add barrel export with orchestrator and unfiltered lookup"
```

---

## Task 7: Resolve Connection Utility (`src/lib/seed/resolve-connection.ts`)

**Files:**
- Modify: `src/lib/audit.ts` (add `'managed_connection'` event type)
- Create: `src/lib/seed/resolve-connection.ts`
- Create: `tests/unit/seed/resolve-connection.test.ts`

- [ ] **Step 1: Add managed_connection to AuditEventType**

In `src/lib/audit.ts`, add to the `AuditEventType` union:

```typescript
export type AuditEventType =
  | 'maintenance'
  | 'kill_session'
  | 'masking_config'
  | 'threshold_config'
  | 'connection_test'
  | 'query_execution'
  | 'managed_connection';  // NEW
```

- [ ] **Step 2: Write failing tests**

Create `tests/unit/seed/resolve-connection.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import type { DatabaseConnection } from '@/lib/types';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/seed-connections');
process.env.SEED_CONFIG_PATH = path.join(FIXTURES, 'multi-role-config.yaml');
process.env.ADMIN_PG_PASS = 'admin-secret';
process.env.USER_MYSQL_PASS = 'user-secret';
process.env.SHARED_PG_PASS = 'shared-secret';
process.env.BOTH_PG_PASS = 'both-secret';

import { resolveConnection, SeedConnectionError } from '@/lib/seed/resolve-connection';
import { resetCache } from '@/lib/seed/config-loader';

describe('resolve-connection', () => {
  beforeEach(() => {
    resetCache();
  });

  it('returns connection object as-is when no connectionId', async () => {
    const conn: DatabaseConnection = {
      id: 'user-conn', name: 'User DB', type: 'postgres', host: 'localhost', createdAt: new Date(),
    };
    const result = await resolveConnection({ connection: conn }, { role: 'user', username: 'test' });
    expect(result.id).toBe('user-conn');
  });

  it('resolves seed connection by connectionId', async () => {
    const result = await resolveConnection(
      { connectionId: 'seed:everyone' },
      { role: 'user', username: 'test' },
    );
    expect(result.id).toBe('seed:everyone');
    expect(result.password).toBe('shared-secret');
  });

  it('throws 403 when role does not have access', async () => {
    try {
      await resolveConnection({ connectionId: 'seed:admin-only' }, { role: 'user', username: 'test' });
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(403);
    }
  });

  it('throws 404 when seed connection does not exist', async () => {
    try {
      await resolveConnection({ connectionId: 'seed:nonexistent' }, { role: 'admin', username: 'test' });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(404);
    }
  });

  it('admin can access admin-only connections', async () => {
    const result = await resolveConnection(
      { connectionId: 'seed:admin-only' },
      { role: 'admin', username: 'test' },
    );
    expect(result.password).toBe('admin-secret');
  });

  it('throws 400 when neither connection nor connectionId', async () => {
    try {
      await resolveConnection({}, { role: 'admin', username: 'test' });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(SeedConnectionError);
      expect((err as SeedConnectionError).statusCode).toBe(400);
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**
- [ ] **Step 4: Implement resolve-connection.ts**

Create `src/lib/seed/resolve-connection.ts`:

```typescript
import type { DatabaseConnection } from '@/lib/types';
import { getSeedConnectionById, getSeedConnectionByIdUnfiltered } from './index';
import { logger } from '@/lib/logger';

export class SeedConnectionError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'SeedConnectionError';
  }
}

export async function resolveConnection(
  body: { connection?: DatabaseConnection; connectionId?: string },
  session: { role: string; username: string },
): Promise<DatabaseConnection> {
  const { connection, connectionId } = body;

  if (connection && !connectionId) {
    return connection;
  }

  if (connectionId) {
    if (!connectionId.startsWith('seed:')) {
      throw new SeedConnectionError('Invalid connection ID format', 400);
    }

    const seedId = connectionId.slice(5);
    const seedConn = await getSeedConnectionById(seedId, [session.role]);

    if (!seedConn) {
      // Differentiate 403 vs 404 using unfiltered lookup
      const exists = await getSeedConnectionByIdUnfiltered(seedId);
      if (exists) {
        logger.warn('Seed connection access denied', {
          route: 'seed/resolve-connection',
          connectionId: seedId,
          user: session.username,
          role: session.role,
        });
        throw new SeedConnectionError(
          `Access denied: connection "${seedId}" not available for role "${session.role}"`,
          403,
        );
      }
      throw new SeedConnectionError(`Seed connection "${seedId}" not found`, 404);
    }

    logger.debug('Resolved seed connection', {
      route: 'seed/resolve-connection',
      connectionId: seedId,
      user: session.username,
    });

    return seedConn;
  }

  throw new SeedConnectionError('Either connection or connectionId is required', 400);
}
```

- [ ] **Step 5: Run tests to verify they pass**
- [ ] **Step 6: Commit**

```bash
git add src/lib/audit.ts src/lib/seed/resolve-connection.ts tests/unit/seed/resolve-connection.test.ts
git commit -m "feat(seed): implement resolveConnection with 403/404 differentiation and audit"
```

---

## Task 8: API Endpoint (`GET /api/connections/managed`)

**Files:**
- Create: `src/app/api/connections/managed/route.ts`
- Create: `tests/api/seed/managed-route.test.ts`

- [ ] **Step 1: Write failing tests** (same as before, with auth mock)
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement the API route**

Create `src/app/api/connections/managed/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getManagedConnections } from '@/lib/seed';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const connections = await getManagedConnections([session.role]);

    const sanitized = connections.map((conn) => {
      if (conn.managed) {
        const { password, connectionString, ...rest } = conn;
        return rest;
      }
      return conn;
    });

    const cacheTTL = Number(process.env.SEED_CACHE_TTL_MS) || 60_000;

    return NextResponse.json({ connections: sanitized, cacheHint: cacheTTL });
  } catch (error) {
    logger.error('Failed to load managed connections', {
      route: 'GET /api/connections/managed',
      error: (error as Error).message,
    });
    return NextResponse.json({ error: 'Failed to load managed connections' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit**

```bash
git add src/app/api/connections/managed/route.ts tests/api/seed/managed-route.test.ts
git commit -m "feat(seed): add GET /api/connections/managed endpoint"
```

---

## Task 9: Integrate `resolveConnection` into all DB API routes

**Files:**
- Modify: 13 routes in `src/app/api/db/` (all POST, **excluding** `disconnect/route.ts`)

**Note:** `disconnect/route.ts` is excluded — it already accepts `connectionId` as a cache key. The `seed:X` IDs flow naturally through the provider cache.

- [ ] **Step 1: Read each route to identify body extraction pattern**

All affected routes use one of:
- Pattern A: `const { connection, ... } = await request.json()`
- Pattern B: `const connection = JSON.parse(await request.text())` (schema route only)

- [ ] **Step 2: Modify each route with resolveConnection**

For each route, add at the top:

```typescript
import { resolveConnection, SeedConnectionError } from '@/lib/seed/resolve-connection';
import { getSession } from '@/lib/auth';
```

Change body extraction:

```typescript
const body = await request.json();
const session = await getSession();
if (!session) {
  return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
}
const connection = await resolveConnection(body, session);
```

Add to catch block:

```typescript
if (error instanceof SeedConnectionError) {
  return NextResponse.json({ error: error.message }, { status: error.statusCode });
}
```

**Special case — `schema/route.ts`:** Currently uses `req.text()` + `JSON.parse()`. Change to `req.json()` for consistency. Client will send `{ connection: conn }` or `{ connectionId: "seed:X" }`.

**Special case — `maintenance/route.ts`:** Already has session check. Reuse existing session.

Apply to all 13 routes:
1. `query/route.ts`
2. `multi-query/route.ts`
3. `schema/route.ts`
4. `transaction/route.ts`
5. `cancel/route.ts`
6. `maintenance/route.ts`
7. `monitoring/route.ts`
8. `pool-stats/route.ts` (POST)
9. `profile/route.ts`
10. `provider-meta/route.ts` (POST)
11. `test-connection/route.ts`
12. `schema-snapshot/route.ts`
13. `health/route.ts` (POST connection health check — needs auth added)

- [ ] **Step 3: Run all existing tests**

```bash
bun run test
```

Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/api/db/
git commit -m "feat(seed): integrate resolveConnection into all DB API routes"
```

---

## Task 10: Shared client helper + useConnectionManager merge

**Files:**
- Create: `src/hooks/use-connection-payload.ts`
- Modify: `src/hooks/use-connection-manager.ts`

- [ ] **Step 1: Create shared helper**

Create `src/hooks/use-connection-payload.ts`:

```typescript
import type { DatabaseConnection } from '@/lib/types';

/**
 * Builds the connection portion of an API request body.
 * For managed connections: sends { connectionId: "seed:X" } (no credentials).
 * For user connections: sends { connection: conn } (full object).
 */
export function buildConnectionPayload(
  conn: DatabaseConnection,
): { connectionId: string } | { connection: DatabaseConnection } {
  if (conn.managed && conn.seedId) {
    return { connectionId: `seed:${conn.seedId}` };
  }
  return { connection: conn };
}
```

- [ ] **Step 2: Update useConnectionManager — add managed connection fetch + merge**

In `src/hooks/use-connection-manager.ts`, after the demo connection fetch block and before the `return` statement of the initialization effect:

```typescript
// Fetch managed (seed) connections
try {
  const managedRes = await fetch('/api/connections/managed');
  if (managedRes.ok) {
    const { connections: managedConns } = await managedRes.json();
    if (managedConns?.length > 0) {
      // ... merge logic as described in spec Section 4
    }
  }
} catch {
  // Managed connections are optional
}
```

- [ ] **Step 3: Update fetchSchema to use buildConnectionPayload**

In `use-connection-manager.ts`, `fetchSchema` callback (line 27-30):

```typescript
// Before:
body: JSON.stringify(conn),

// After:
import { buildConnectionPayload } from './use-connection-payload';
body: JSON.stringify(buildConnectionPayload(conn)),
```

**Important:** The schema route was updated in Task 9 to use `req.json()` + `resolveConnection()`. The client must now send `{ connection: conn }` (wrapped) or `{ connectionId: "seed:X" }`, NOT the bare `conn` object. `buildConnectionPayload()` handles both cases correctly.

- [ ] **Step 4: Update health pulse fetch** (line ~171):

```typescript
body: JSON.stringify(buildConnectionPayload(conn)),
```

- [ ] **Step 5: Run tests**

```bash
bun run test:hooks
```

- [ ] **Step 6: Commit**

```bash
git add src/hooks/use-connection-payload.ts src/hooks/use-connection-manager.ts
git commit -m "feat(seed): add managed connection merge to useConnectionManager"
```

---

## Task 11: Client hooks — useQueryExecution + useTransactionControl

**Files:**
- Modify: `src/hooks/use-query-execution.ts`
- Modify: `src/hooks/use-transaction-control.ts`

- [ ] **Step 1: Update ALL 6 fetch calls in useQueryExecution**

Import helper and update each fetch site:

```typescript
import { buildConnectionPayload } from './use-connection-payload';
```

**Site 1 — Playground BEGIN** (line 150):
```typescript
body: JSON.stringify({ ...buildConnectionPayload(activeConnection), action: 'begin' }),
```

**Site 2 — Main query** (line ~179):
```typescript
body: JSON.stringify({
  ...buildConnectionPayload(activeConnection),
  ...(useTransaction ? { action: 'query', sql, options } : { sql, options, ...(!useMultiQuery && { queryId }) }),
}),
```

**Site 3 — Background EXPLAIN query** (line ~198-202):
```typescript
body: JSON.stringify({
  ...buildConnectionPayload(activeConnection),
  sql: explainSql,
  options: {},
}),
```

**Site 4 — Playground rollback success** (line ~357):
```typescript
body: JSON.stringify({ ...buildConnectionPayload(activeConnection), action: 'rollback' }),
```

**Site 5 — Playground rollback error** (line ~382):
```typescript
body: JSON.stringify({ ...buildConnectionPayload(activeConnection), action: 'rollback' }),
```

**Site 6 — Cancel query** (line ~433):
```typescript
body: JSON.stringify({
  ...buildConnectionPayload(activeConnection),
  queryId: activeQueryIdRef.current,
}),
```

- [ ] **Step 2: Update useTransactionControl** (line 20-24):

```typescript
import { buildConnectionPayload } from './use-connection-payload';

body: JSON.stringify({
  ...buildConnectionPayload(activeConnection),
  action,
}),
```

- [ ] **Step 3: Run tests**

```bash
bun run test:hooks
```

- [ ] **Step 4: Commit**

```bash
git add src/hooks/use-query-execution.ts src/hooks/use-transaction-control.ts
git commit -m "feat(seed): send connectionId for managed connections in all hook fetch calls"
```

---

## Task 12: UI — Lock icon + hide edit/delete for managed connections

**Files:**
- Modify: `src/components/sidebar/ConnectionItem.tsx`

- [ ] **Step 1: Add lock icon and conditional buttons**

Import Lock icon, add managed lock indicator, wrap edit/delete with `!conn.managed` check.

- [ ] **Step 2: Run component tests**

```bash
bun run test:components
```

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/ConnectionItem.tsx
git commit -m "feat(seed): add lock icon and hide edit/delete for managed connections"
```

---

## Task 13: Integration Tests

**Files:**
- Create: `tests/integration/seed/seed-pipeline.test.ts`

- [ ] **Step 1: Write integration tests** — full pipeline, partial failure, hot-reload, defaults merge, audit trail
- [ ] **Step 2: Run integration tests**

```bash
bun test tests/integration/seed/
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/seed/
git commit -m "test(seed): add integration tests for full seed pipeline"
```

---

## Task 14: Helm chart + Docker + env documentation

**Files:**
- Create: `charts/libredb-studio/templates/seed-configmap.yaml`
- Modify: `charts/libredb-studio/values.yaml`
- Modify: `charts/libredb-studio/values.schema.json`
- Modify: `charts/libredb-studio/templates/deployment.yaml`
- Modify: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Create seed-configmap.yaml**
- [ ] **Step 2: Add seedConnections to values.yaml**
- [ ] **Step 3: Update values.schema.json**
- [ ] **Step 4: Update deployment.yaml** (volume mount + env vars)
- [ ] **Step 5: Update docker-compose.yml** (commented example)
- [ ] **Step 6: Update .env.example** (new env vars)
- [ ] **Step 7: Lint Helm chart**

```bash
helm lint charts/libredb-studio --strict
helm template test charts/libredb-studio --set secrets.jwtSecret=test-secret-32-chars-minimum-here --set secrets.adminPassword=test123 --set secrets.userPassword=test123 --set seedConnections.enabled=true
```

- [ ] **Step 8: Commit**

```bash
git add charts/ docker-compose.yml .env.example
git commit -m "feat(seed): add Helm chart, Docker, and env documentation for seed connections"
```

---

## Task 15: CI Verification

- [ ] **Step 1: Lint**

```bash
bun run lint
```

- [ ] **Step 2: Type check**

```bash
bun run typecheck
```

- [ ] **Step 3: Run all tests**

```bash
bun run test
```

- [ ] **Step 4: Build**

```bash
bun run build
```

- [ ] **Step 5: Fix any failures and commit**

```bash
git log --oneline -15  # verify all seed commits
```
