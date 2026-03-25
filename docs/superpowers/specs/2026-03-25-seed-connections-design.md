# Seed Connections — Pre-Configured Database Connections

**Date:** 2026-03-25
**Status:** Approved
**Author:** cevheri + Claude

## Problem

LibreDB Studio'yu Platform/SaaS olarak deploy ederken, kullanıcıların login olduktan sonra önceden tanımlı veritabanı bağlantılarını hazır olarak görmesi gerekiyor. Mevcut sistemde sadece tek bir demo connection mekanizması (`DEMO_DB_*` env vars) var ve çoklu, rol bazlı bağlantı tanımlama desteklenmiyor.

## Goals

- Container başlatıldığında YAML/JSON config dosyasından çoklu veritabanı bağlantısı yüklensin
- Rol bazlı erişim kontrolü: her connection'a hangi rollerin erişebileceği tanımlansın
- Hybrid model: `managed: true` (read-only, admin-controlled) ve `managed: false` (kullanıcıya kopyalanır, düzenlenebilir)
- Credential'lar `${ENV_VAR}` syntax ile inject edilsin, plaintext tutulmasın
- Hot-reload: config değişikliği restart gerektirmesin (TTL-based cache)
- Multi-tenant / role-based fleet yönetimine genişletilebilir altyapı

## Non-Goals

- Multi-tenant UI (tenant yönetim paneli) — gelecek iterasyon
- Vault / External Secrets Operator entegrasyonu — gelecek iterasyon
- Config dosyası UI'dan düzenleme
- SSH tunnel support for seed connections — gelecek iterasyon (requires `${ENV_VAR}` support for SSH private keys)
- Custom OIDC role claim expansion — gelecek iterasyon (see Role Model section)

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Config format | YAML/JSON file (volume mount) | Okunabilir, GitOps-friendly, Helm ConfigMap ile doğal uyum |
| Connection model | Hybrid (managed + unmanaged) | `managed: true` = admin-controlled read-only, `managed: false` = inject & release to user |
| Credential handling | `${ENV_VAR}` injection from env/Secret | Separation of concerns: structure in ConfigMap, secrets in K8s Secret |
| Role model | Whitelist + Wildcard (`roles: ["*"]`) | OIDC role claim ile doğal uyum, secure by default (boş roles = nobody) |
| Config loading | Runtime provider (TTL cache, no storage write) | Hot-reload, clean separation (config != storage), zero storage side effects |
| Architecture | Dedicated Seed Module (`src/lib/seed/`) | Minimal coupling to existing code, independently testable, easy to evolve |

---

## 1. Config File Format

Path: `SEED_CONFIG_PATH` env var (default: `/app/config/seed-connections.yaml`)

```yaml
version: "1"

defaults:
  managed: true
  environment: production
  ssl:
    mode: require
    rejectUnauthorized: true

connections:
  - id: "prod-analytics"
    name: "Production Analytics"
    type: postgres
    host: analytics-db.internal
    port: 5432
    database: analytics
    user: "readonly_user"
    password: "${ANALYTICS_DB_PASSWORD}"
    environment: production
    group: "Data Team"
    roles: ["admin"]
    managed: true
    color: "#10B981"

  - id: "staging-api"
    name: "Staging API Database"
    type: mysql
    host: staging-mysql.internal
    port: 3306
    database: api_db
    user: "dev_user"
    password: "${STAGING_DB_PASSWORD}"
    environment: staging
    group: "Backend"
    roles: ["*"]
    managed: false

  - id: "shared-mongo"
    name: "Shared MongoDB"
    type: mongodb
    connectionString: "${MONGO_CONNECTION_STRING}"
    group: "Platform"
    roles: ["admin"]
    managed: true

  - id: "dev-redis"
    name: "Dev Redis Cache"
    type: redis
    host: redis.internal
    port: 6379
    database: "0"
    password: "${REDIS_PASSWORD}"
    roles: ["*"]
    managed: true
```

**Key rules:**

- `version: "1"` — required, enables future format migration. Unrecognized versions are rejected with error log (fail-fast). Migration tooling will be provided when v2 is introduced.
- `defaults` — optional, merged into each connection (connection-level overrides win)
- `id` — required, unique, slug format (`[a-z0-9-]+`), max 64 chars
- `roles` — required, min 1 entry. `["*"]` = all authenticated users. `["admin"]` = admin only. `["user"]` = user only. Empty array = nobody (validation rejects this).
- `managed` — inherits from `defaults.managed` if not set
- `${ENV_VAR}` — resolved at runtime from `process.env`. Unresolvable = connection skipped with error log
- `ssl` — uses the existing `SSLConfig` shape (`mode: SSLMode`, `rejectUnauthorized`, `caCert`, etc.)

### Role Model — Current Scope & Future Expansion

**Current JWT:** The system stores `role: 'admin' | 'user'` in the JWT payload. OIDC claims are collapsed to these two values via `mapOIDCRole()`.

**This iteration:** Config `roles` field only supports `["*"]`, `["admin"]`, `["user"]`, and `["admin", "user"]`. The Zod schema validates against these known values. This matches the existing auth system without modification.

**Future iteration (multi-tenant):** When custom OIDC roles are needed:
1. Expand JWT payload to carry `roles: string[]` (original OIDC claims) alongside binary `role`
2. Update `mapOIDCRole()` to preserve claim array
3. Seed connection filter will already accept `roles: string[]` — only the JWT extraction changes
4. Config can then use `roles: ["data-team", "backend"]` etc.

The data model (`roles: string[]`) is future-proof. Only the runtime filter validation is restricted for now.

---

## 2. Module Architecture

```
src/lib/seed/
  index.ts                  # Public API: getManagedConnections(roles)
  types.ts                  # Zod schemas + TypeScript types
  config-loader.ts          # YAML/JSON parse + Zod validation + TTL cache
  credential-resolver.ts    # ${ENV_VAR} -> process.env resolution
  connection-filter.ts      # Role filter + defaults merge + DatabaseConnection mapping
  resolve-connection.ts     # Shared utility: resolve seed connection by ID for all API routes
```

### Data Flow

```
seed-connections.yaml
        |
  ConfigLoader (parse + validate + cache)
        |  SeedConfig (raw)
  CredentialResolver (${VAR} -> value)
        |  SeedConfig (resolved)
  ConnectionFilter (role + defaults merge)
        |  ManagedConnection[]
  GET /api/connections/managed
```

### types.ts

```typescript
interface SeedDefaults {
  managed?: boolean;
  environment?: ConnectionEnvironment;
  ssl?: SSLConfig;
}

interface SeedConnection {
  id: string;            // slug format, unique
  name: string;
  type: DatabaseType;    // excludes 'demo'
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  connectionString?: string;
  environment?: ConnectionEnvironment;
  group?: string;
  color?: string;
  roles: string[];       // ["*"] = all, ["admin"] = admin only
  managed?: boolean;     // inherits from defaults
  ssl?: SSLConfig;
  serviceName?: string;  // Oracle
  instanceName?: string; // MSSQL
}

interface SeedConfig {
  version: "1";
  defaults?: SeedDefaults;
  connections: SeedConnection[];
}

interface ManagedConnection extends DatabaseConnection {
  managed: boolean;
  roles: string[];
  seedId: string;        // original id from config (stable reference)
}
```

Zod schemas validate all above at parse time. Duplicate `id` values rejected via `.refine()`.

### config-loader.ts

- Reads file from `SEED_CONFIG_PATH` (default `/app/config/seed-connections.yaml`)
- Auto-detects format: `.yaml`/`.yml` = YAML, `.json` = JSON
- Validates with Zod schema
- TTL cache: `SEED_CACHE_TTL_MS` (default 60000ms). Stale reads re-read from disk.
- File not found = graceful empty config (warn log), app continues
- Parse/validation error = error log, endpoint returns 500
- Unrecognized `version` value = error log, endpoint returns 500 (fail-fast)

### credential-resolver.ts

- Pattern: `${VARIABLE_NAME}` — resolved from `process.env`
- Applies to: `password`, `connectionString`, `user`, `host`, `database` fields
- Unresolvable env var = that connection skipped (error log), others continue
- Plaintext password detection: warns **once per connection ID** (not on every cache refresh) if password doesn't use `${...}` syntax. Uses a `Set<string>` to track warned IDs.
- Pure function (except `process.env` read)

### connection-filter.ts

- Merges `defaults` into each connection (connection values override defaults)
- Filters by role: connection included if `roles` contains `"*"` or any intersection with the user's roles array
- Maps `SeedConnection` to `ManagedConnection` (adds `createdAt`, `seedId`, strips `roles` metadata for non-admin)
- Sets `managed` flag from resolved config

### resolve-connection.ts — Shared Seed Connection Resolver

All API routes that accept connection objects need to handle managed connections. Instead of modifying each route individually, a shared utility resolves seed connections:

```typescript
/**
 * Resolves a connection from the request body.
 * If connectionId starts with "seed:", loads from config with full credentials.
 * Otherwise, returns the connection object from the body as-is.
 *
 * @param body - Request body (may contain `connection` or `connectionId`)
 * @param session - Verified JWT session (for role checking)
 * @returns Resolved DatabaseConnection with full credentials
 * @throws 403 if user role doesn't have access to seed connection
 * @throws 404 if seed connection ID not found in config
 */
export async function resolveConnection(
  body: { connection?: DatabaseConnection; connectionId?: string },
  session: { role: string; username: string }
): Promise<DatabaseConnection>
```

This utility is called at the top of every route handler that currently extracts `connection` from the request body, before passing to `getOrCreateProvider()`.

### index.ts

```typescript
export async function getManagedConnections(roles: string[]): Promise<ManagedConnection[]>
```

Single public function. Orchestrates: loadConfig -> resolveCredentials -> filterByRoles. Signature accepts `roles: string[]` (array) for future multi-role OIDC support. Current callers pass `[session.role]`.

---

## 3. API Endpoint

### GET /api/connections/managed

**Auth:** Required (JWT session)

**Response:**
```json
{
  "connections": ["ManagedConnection, ..."],
  "cacheHint": 60000
}
```

**Behavior:**
1. Extract `role` from JWT session (server-side truth, never client-supplied)
2. Call `getManagedConnections([role])`
3. For `managed: true` connections: strip `password` and `connectionString` from response
4. For `managed: false` connections: include credentials (for initial inject into user storage)
5. Return with `cacheHint` for client-side cache duration

### All DB API Routes — Shared Connection Resolution

Managed connections require server-side credential resolution. This affects **all** routes that accept a `connection` object from the client, not just the query route:

**Affected routes (12+):**
- `POST /api/db/query` — single query execution
- `POST /api/db/multi-query` — multi-statement execution
- `POST /api/db/schema` — schema fetch
- `POST /api/db/health` — connection health check (Note: `GET /api/db/health` is the app-level health check and is unaffected)
- `POST /api/db/cancel` — query cancellation
- `POST /api/db/transaction` — BEGIN/COMMIT/ROLLBACK
- `POST /api/db/maintenance` — VACUUM, ANALYZE, etc.
- `POST /api/db/monitoring` — live metrics
- `GET /api/db/pool-stats` — connection pool stats
- `POST /api/db/profile` — data profiling
- `GET /api/db/provider-meta` — capabilities/labels
- `POST /api/db/test-connection` — connection testing
- `POST /api/db/schema-snapshot` — schema snapshots
- `POST /api/db/disconnect` — explicit disconnection

**Pattern for each route:**

```typescript
// Before (current):
const { connection, sql } = await request.json();
const provider = await getOrCreateProvider(connection);

// After (with seed support):
import { resolveConnection } from '@/lib/seed/resolve-connection';

const body = await request.json();
const session = await verifySession(request);
const connection = await resolveConnection(body, session);
const provider = await getOrCreateProvider(connection);
```

### Provider Cache Key Namespacing

Seed connections use a namespaced cache key to prevent collision with user-created connections:

```typescript
// In resolveConnection(), seed connections get prefixed ID:
if (isSeedConnection) {
  resolvedConnection.id = `seed:${seedId}`; // e.g., "seed:prod-analytics"
}
```

This ensures the provider cache in `factory.ts` never conflates a seed connection with a user connection that might have the same slug ID.

### Request Format

```
// Existing: client sends full connection object (user connections)
{ connection: { host, port, user, password, ... }, sql: "..." }

// New: managed connections identified by connectionId
{ connectionId: "seed:prod-analytics", sql: "..." }
```

Both formats are supported. `resolveConnection()` detects which format is used and handles accordingly.

---

## 4. Client Integration

### useConnectionManager Hook Changes

```
Current:
  storage.getConnections() -> connections[]

New:
  storage.getConnections() -> userConnections[]
  GET /api/connections/managed -> managedConnections[]
  merge(managed, user) -> allConnections[]
```

**Client-side managed connection handling:**

When a managed connection (`managed: true`) is active, all API calls from hooks (`useQueryExecution`, `useTransactionControl`, etc.) must send `{ connectionId: "seed:<seedId>" }` instead of the full connection object. This is achieved by checking the `managed` flag on the active connection:

```typescript
// In useQueryExecution and other hooks:
const requestBody = activeConnection.managed
  ? { connectionId: `seed:${activeConnection.seedId}`, sql }
  : { connection: activeConnection, sql };
```

**cacheHint behavior:** Client caches managed connections for `cacheHint` milliseconds after mount. No polling. Re-fetch occurs on connection list focus or manual refresh.

**Merge rules:**

| Scenario | Behavior |
|---|---|
| Managed connection, first seen | Added to list |
| `managed: false`, first seen | Copied to user storage with credentials, marked with `seedId` for tracking |
| `managed: false`, already copied (matching `seedId` in storage) | User copy wins, no overwrite (user owns it) |
| Managed connection removed from config | Disappears from list (`managed: true`) or user copy remains (`managed: false`) |
| Same `id` as user connection | `managed: true` wins; `managed: false` user copy wins |

**`managed: false` idempotency:** User connections that were copied from seeds carry a `seedId` field. On merge, `useConnectionManager` checks if a user connection with matching `seedId` already exists. If it does, the copy is skipped. This prevents duplicate entries from concurrent tabs and ensures credential rotation for `managed: false` connections requires the user to delete and re-import (admin should use `managed: true` for connections requiring automated credential rotation).

### UI Changes

- `managed: true`: lock icon, edit/delete buttons hidden, tooltip: "Managed by administrator"
- `managed: false` + not yet copied: "Join Connection" button
- Connection color and group from config
- `data-testid="managed-lock-{id}"` for E2E testing

---

## 5. Deployment Integration

### Docker

```bash
docker run -v ./seed-connections.yaml:/app/config/seed-connections.yaml:ro \
  -e ANALYTICS_DB_PASSWORD=secret \
  ghcr.io/libredb/libredb-studio:latest
```

### docker-compose

```yaml
services:
  app:
    volumes:
      - ./seed-connections.yaml:/app/config/seed-connections.yaml:ro
    environment:
      SEED_CONFIG_PATH: /app/config/seed-connections.yaml
      ANALYTICS_DB_PASSWORD: ${ANALYTICS_DB_PASSWORD}
```

### Helm

**values.yaml additions:**

```yaml
seedConnections:
  enabled: false
  config: {}           # inline YAML config
  existingConfigMap: "" # or reference external ConfigMap
  configMapKey: "seed-connections.yaml"
  cacheTTL: 60000
```

**New template:** `seed-configmap.yaml` — creates ConfigMap from `seedConnections.config`

**deployment.yaml changes:**
- Volume mount: seed-config ConfigMap at `/app/config` (readOnly)
- Env vars: `SEED_CONFIG_PATH`, `SEED_CACHE_TTL_MS`
- Credentials via `extraEnv` / `extraEnvFrom` referencing K8s Secrets

**values.schema.json:** Updated with `seedConnections` object schema.

---

## 6. Security Model

### Credential Protection

- `managed: true` passwords never reach client — stripped in API response
- Server resolves credentials at query execution time from config via `resolveConnection()`
- `${ENV_VAR}` pattern enforced; plaintext passwords trigger warn log (once per connection ID)
- `credential-resolver.ts` is server-only code (not bundled for client)

### Role Escalation Prevention

- Role extracted from JWT session server-side (never from client request)
- `resolveConnection()` verifies role access before returning credentials
- Every DB API route uses `resolveConnection()` which enforces role check

### Pre-existing Note: Client-Supplied Credentials

The existing architecture allows any authenticated user to submit arbitrary connection credentials via the `{ connection: {...} }` request body pattern. This is by design — users manage their own connections. A user with network access to a database host could connect directly regardless of LibreDB's seed connection role restrictions. Seed connection role filtering protects credential distribution (who sees what in the UI and whose credentials are resolved server-side), not network-level access. Network-level isolation should be handled via Kubernetes NetworkPolicy, VPC rules, or database-level access control.

### Managed Connection Query Flow (all routes)

```
Client: POST /api/db/* { connectionId: "seed:prod-analytics", ... }
Server: 1. Verify JWT session (proxy middleware)
        2. resolveConnection(body, session):
           a. Detect "seed:" prefix in connectionId
           b. Extract role from session
           c. Load seed connection from config
           d. Verify role in connection's roles list (403 if denied)
           e. Resolve credentials from env vars
           f. Return full DatabaseConnection with namespaced ID
        3. getOrCreateProvider(resolvedConnection)
        4. Execute operation
        5. Audit log event (for managed connections)
```

### Audit Trail

Every managed connection operation logged:
```typescript
{ event: 'managed_connection_query', connectionId, user, role, route, timestamp }
```

---

## 7. Error Handling

| Error Level | Example | Behavior |
|---|---|---|
| Config file missing | File not found at path | Graceful: empty array, warn log, app runs |
| Parse error | Invalid YAML/JSON | Fail-fast: Zod error, error log, endpoint returns 500 |
| Version mismatch | `version: "2"` on v1-only code | Fail-fast: error log, endpoint returns 500 |
| Credential resolve error | `${VAR}` undefined | Per-connection skip: that connection omitted, others work |
| Role filter empty result | User role matches nothing | Normal: empty array returned |
| Seed connection not found | `connectionId: "seed:nonexistent"` | 404 response |
| Role access denied | User requests seed connection they can't access | 403 response |

**Principle:** One broken connection definition must not break all others. Pipeline processes each connection independently.

---

## 8. Testing Strategy

### Test Pyramid

| Layer | Count | Scope |
|---|---|---|
| Unit | ~30 | config-loader, credential-resolver, connection-filter, resolve-connection, Zod schemas |
| API | 10 | endpoint auth, role filter, cache, password stripping, errors, seed query resolution |
| Integration | 8 | full pipeline, hot-reload, partial failure, query with managed conn, audit, multi-route seed resolution |
| E2E | 1 | managed connection visible in sidebar after login |

### Test Fixtures

```
tests/fixtures/seed-connections/
  valid-config.yaml
  minimal-config.yaml
  invalid-config.yaml
  mixed-credentials.yaml
  multi-role-config.yaml
```

---

## 9. New Files

```
src/lib/seed/
  index.ts
  types.ts
  config-loader.ts
  credential-resolver.ts
  connection-filter.ts
  resolve-connection.ts

src/app/api/connections/managed/route.ts

charts/libredb-studio/templates/seed-configmap.yaml

tests/unit/seed/config-loader.test.ts
tests/unit/seed/credential-resolver.test.ts
tests/unit/seed/connection-filter.test.ts
tests/unit/seed/resolve-connection.test.ts
tests/unit/seed/types.test.ts
tests/api/seed/managed-route.test.ts
tests/integration/seed/seed-pipeline.test.ts
tests/fixtures/seed-connections/*.yaml
e2e/seed-connections.spec.ts
```

## 10. Modified Files

| File | Change |
|---|---|
| `src/hooks/use-connection-manager.ts` | Managed connection fetch + merge logic + seedId tracking |
| `src/hooks/use-query-execution.ts` | Send `connectionId` for managed connections instead of full connection |
| `src/hooks/use-transaction-control.ts` | Send `connectionId` for managed connections |
| `src/app/api/db/query/route.ts` | Use `resolveConnection()` before `getOrCreateProvider()` |
| `src/app/api/db/multi-query/route.ts` | Use `resolveConnection()` |
| `src/app/api/db/schema/route.ts` | Use `resolveConnection()` |
| `src/app/api/db/transaction/route.ts` | Use `resolveConnection()` |
| `src/app/api/db/cancel/route.ts` | Use `resolveConnection()` |
| `src/app/api/db/maintenance/route.ts` | Use `resolveConnection()` |
| `src/app/api/db/monitoring/route.ts` | Use `resolveConnection()` |
| `src/app/api/db/pool-stats/route.ts` | Use `resolveConnection()` |
| `src/app/api/db/profile/route.ts` | Use `resolveConnection()` |
| `src/app/api/db/provider-meta/route.ts` | Use `resolveConnection()` |
| `src/app/api/db/test-connection/route.ts` | Use `resolveConnection()` |
| `src/app/api/db/schema-snapshot/route.ts` | Use `resolveConnection()` |
| `src/app/api/db/disconnect/route.ts` | Use `resolveConnection()` |
| `src/lib/db/factory.ts` | Accept namespaced `seed:` IDs in provider cache key |
| `src/components/sidebar/ConnectionItem.tsx` | Lock icon + hide edit/delete for managed |
| `src/lib/types.ts` | `ManagedConnection` type, `managed` + `seedId` fields on `DatabaseConnection` |
| `charts/libredb-studio/values.yaml` | `seedConnections` section |
| `charts/libredb-studio/values.schema.json` | Schema update |
| `charts/libredb-studio/templates/deployment.yaml` | Volume mount + env vars |
| `docker-compose.yml` | Config volume mount example |
| `.env.example` | New env var documentation |

## 11. New Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SEED_CONFIG_PATH` | No | `/app/config/seed-connections.yaml` | Config file path |
| `SEED_CACHE_TTL_MS` | No | `60000` | Cache TTL in milliseconds |

## 12. Future Extensions

- **Multi-Tenant:** Add `tenant` field to config connections, filter by tenant ID from JWT claims
- **Custom OIDC Roles:** Expand JWT payload to `roles: string[]`, update `mapOIDCRole()` to preserve claim array, enable `roles: ["data-team", "backend"]` in config
- **RBAC UI:** Admin panel tab for viewing/managing seed connections
- **Vault Integration:** New credential resolver backend for HashiCorp Vault / AWS SSM
- **SSH Tunnel Support:** Add `sshTunnel` field to `SeedConnection` with `${ENV_VAR}` support for SSH keys
- **Connection Source Abstraction:** Evolve to Approach 3 (ConnectionRegistry) when 3+ sources needed
- **Demo Connection Migration:** Existing `GET /api/demo-connection` with `DEMO_DB_*` env vars can be migrated to a seed connection entry. Both mechanisms coexist for backward compatibility; demo deprecation planned for a future major version.
