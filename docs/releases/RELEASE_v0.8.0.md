# Release v0.8.0 - Pluggable Storage Layer

This release introduces a **pluggable storage abstraction layer** that allows LibreDB Studio to persist user data beyond the browser. Choose between localStorage (default), SQLite, or PostgreSQL — controlled by a single environment variable, no code changes or rebuild required.

---

## Highlights

- **Three Storage Modes:** localStorage (zero-config default), SQLite (single-node persistent), PostgreSQL (multi-node enterprise)
- **Write-Through Cache:** localStorage always serves reads (instant, synchronous); server storage is the persistent source of truth
- **Automatic Migration:** Existing localStorage data is seamlessly migrated to server storage on first login
- **Per-User Isolation:** Server storage is scoped by JWT username — no cross-user data leaks
- **Single Docker Image:** Runtime config via `STORAGE_PROVIDER` env var — one image supports all modes
- **Zero Breaking Changes:** All 16+ consumer components keep the same synchronous `storage.*` API

---

## New Features

### Pluggable Storage Abstraction

A complete storage module (`src/lib/storage/`) that decouples data persistence from the browser:

```
┌──────────────────────────────┐
│   16+ Consumer Components    │  ← Unchanged, same sync API
│   storage.getConnections()   │
│   storage.saveConnection()   │
└──────────────┬───────────────┘
               │ sync read/write
┌──────────────▼───────────────┐
│   Storage Facade             │  ← localStorage + CustomEvent dispatch
└──────────────┬───────────────┘
               │ CustomEvent: 'libredb-storage-change'
┌──────────────▼───────────────┐
│   useStorageSync Hook        │  ← Write-through cache (server mode only)
└──────────────┬───────────────┘
               │ fetch (debounced 500ms)
┌──────────────▼───────────────┐
│   API Routes /api/storage/*  │  ← JWT auth + user scoping
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│   ServerStorageProvider       │  ← Strategy Pattern
│   ┌─────────┐ ┌────────────┐ │
│   │ SQLite  │ │ PostgreSQL │ │
│   └─────────┘ └────────────┘ │
└──────────────────────────────┘
```

**9 Data Collections** persisted across all modes:

| Collection | Description |
|-----------|-------------|
| `connections` | Saved database connections |
| `history` | Query execution history (max 500) |
| `saved_queries` | User-saved SQL/JSON queries |
| `schema_snapshots` | Schema diff snapshots (max 50) |
| `saved_charts` | Saved chart configurations |
| `active_connection_id` | Currently active connection |
| `audit_log` | Audit trail events (max 1000) |
| `masking_config` | Data masking rules and RBAC |
| `threshold_config` | Monitoring alert thresholds |

### Storage Modes

#### Local Mode (Default)

No configuration needed. All data lives in the browser's `localStorage`.

```bash
# Just start the app
bun dev
```

#### SQLite Mode

A single file on the server. Ideal for self-hosted single-node deployments.

```env
STORAGE_PROVIDER=sqlite
# Optional: STORAGE_SQLITE_PATH=./data/libredb-storage.db (default)
```

- Auto-creates directory, database file, and table on first request
- WAL mode enabled for concurrent read performance
- `better-sqlite3` (Node.js native bindings)

#### PostgreSQL Mode

Recommended for production, teams, and high-availability deployments.

```env
STORAGE_PROVIDER=postgres
STORAGE_POSTGRES_URL=postgresql://user:pass@host:5432/libredb
```

- Connection pool (max 5, 30s idle timeout)
- Table auto-created via `CREATE TABLE IF NOT EXISTS`
- Transactional `mergeData()` for migration safety

### Write-Through Cache & Sync Hook

The `useStorageSync` hook orchestrates all client-server synchronization:

1. **Discovery:** `GET /api/storage/config` determines storage mode at runtime
2. **Migration:** First-time server mode users get localStorage data auto-migrated via `POST /api/storage/migrate`
3. **Pull:** Server data pulled into localStorage on mount
4. **Push:** Mutations debounced (500ms) and pushed to server via `PUT /api/storage/[collection]`
5. **Graceful Degradation:** If server is unreachable, localStorage continues to work

### Automatic Migration

When switching from local to server mode:

1. Sync hook detects first-time server mode (no `libredb_server_migrated` flag)
2. All 9 collections sent to server via `POST /api/storage/migrate`
3. Server performs ID-based deduplication — no duplicates
4. Flag set in localStorage to prevent re-migration
5. From this point, server is the source of truth

**No manual steps required** — just change the env var and restart.

### Per-User Isolation

Every row in `user_storage` is scoped by `user_id` (JWT email):

- Client never sends `user_id` — server always extracts from JWT cookie
- Every query includes `WHERE user_id = $username`
- OIDC users (Auth0, Keycloak, Okta, Azure AD) fully supported

### Docker Deployment

**SQLite:**
```yaml
services:
  app:
    image: ghcr.io/libredb/libredb-studio:latest
    environment:
      - STORAGE_PROVIDER=sqlite
      - STORAGE_SQLITE_PATH=/app/data/libredb-storage.db
    volumes:
      - storage-data:/app/data
volumes:
  storage-data:
```

**PostgreSQL:**
```yaml
services:
  app:
    image: ghcr.io/libredb/libredb-studio:latest
    environment:
      - STORAGE_PROVIDER=postgres
      - STORAGE_POSTGRES_URL=postgresql://user:pass@db:5432/libredb
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=libredb
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user"]
      interval: 5s
      timeout: 3s
      retries: 5
volumes:
  pgdata:
```

---

## Architecture Changes

### New Files (24 files, ~3,500 lines)

| File | Description |
|------|-------------|
| **Storage Module** | |
| `src/lib/storage/types.ts` | `StorageData`, `StorageCollection`, `ServerStorageProvider` interface |
| `src/lib/storage/local-storage.ts` | Pure localStorage CRUD (SSR-safe, JSON parse safety) |
| `src/lib/storage/storage-facade.ts` | Public `storage` object — sync API + CustomEvent dispatch on every mutation |
| `src/lib/storage/factory.ts` | Singleton provider factory with dynamic imports |
| `src/lib/storage/index.ts` | Barrel export preserving `@/lib/storage` import path |
| `src/lib/storage/providers/sqlite.ts` | `better-sqlite3` backend (WAL, auto-create, upsert) |
| `src/lib/storage/providers/postgres.ts` | `pg` pool backend (upsert, transactional merge) |
| **API Routes** | |
| `src/app/api/storage/config/route.ts` | `GET` — Public runtime storage mode discovery |
| `src/app/api/storage/route.ts` | `GET` — Fetch all collections (JWT auth) |
| `src/app/api/storage/[collection]/route.ts` | `PUT` — Update single collection (JWT auth) |
| `src/app/api/storage/migrate/route.ts` | `POST` — localStorage to server migration (JWT auth) |
| **Sync Hook** | |
| `src/hooks/use-storage-sync.ts` | Write-through cache hook — discovery, migration, pull, push |
| **Documentation** | |
| `docs/STORAGE_ARCHITECTURE.md` | Deep-dive architecture document (565 lines) |
| `docs/STORAGE_QUICK_SETUP.md` | Quick setup guide for all three modes (404 lines) |
| **Tests (10 files)** | |
| `tests/unit/lib/storage/local-storage.test.ts` | localStorage CRUD tests |
| `tests/unit/lib/storage/storage-facade.test.ts` | Facade sync API tests |
| `tests/unit/lib/storage/storage-facade-extended.test.ts` | Extended facade tests (history caps, snapshots, charts) |
| `tests/unit/lib/storage/factory.test.ts` | Factory env-based provider selection |
| `tests/unit/lib/storage/providers/sqlite.test.ts` | SQLite provider with mocked `better-sqlite3` |
| `tests/unit/lib/storage/providers/postgres.test.ts` | PostgreSQL provider with mocked `pg` |
| `tests/api/storage/config.test.ts` | Config endpoint tests |
| `tests/api/storage/storage-routes.test.ts` | Full API route tests (GET/PUT/POST) |
| `tests/isolated/factory-singleton.test.ts` | Factory singleton isolation tests |
| `tests/isolated/use-storage-sync.test.ts` | useStorageSync hook tests (local + server mode) |

### Modified Files

| File | Change |
|------|--------|
| `src/components/Studio.tsx` | Mount `useStorageSync` hook after `useAuth()` |
| `src/components/DataCharts.tsx` | Use `@/lib/storage` module instead of direct localStorage |
| `src/components/admin/tabs/SecurityTab.tsx` | Use `@/lib/storage` module instead of direct localStorage |
| `src/components/studio/BottomPanel.tsx` | Use `@/lib/storage` module instead of direct localStorage |
| `src/lib/audit.ts` | Use `@/lib/storage` module instead of direct localStorage |
| `src/lib/data-masking.ts` | Use `@/lib/storage` module instead of direct localStorage |
| `src/proxy.ts` | Add `/api/storage/config` to public route whitelist |
| `.env.example` | Add `STORAGE_PROVIDER`, `STORAGE_SQLITE_PATH`, `STORAGE_POSTGRES_URL` |
| `docker-compose.yml` | Add storage volume and environment variables |
| `Dockerfile` | Include `better-sqlite3` native bindings, create `/app/data` directory |
| `package.json` | Add `better-sqlite3` dependency, version bump to 0.8.0 |
| `docs/ARCHITECTURE.md` | Add storage abstraction section |

### Deleted Files

| File | Reason |
|------|--------|
| `src/lib/storage.ts` | Replaced by modular `src/lib/storage/` directory (same import path preserved) |

---

## Bug Fixes

### Proxy Middleware Blocking `/api/storage/config`

**Problem:** `GET /api/storage/config` returned a 307 redirect to `/login` instead of the expected JSON response. This endpoint is designed to be public (no auth required) for runtime storage mode discovery.

**Root Cause:** The endpoint was not included in the proxy middleware's public route whitelist (`src/proxy.ts`).

**Fix:** Added `/api/storage/config` to both the `if` condition block and the matcher regex in `src/proxy.ts`.

---

## Dependencies

### Added

| Package | Version | Purpose |
|---------|---------|---------|
| `better-sqlite3` | ^11.x | SQLite storage provider (WAL mode, native bindings) |
| `@types/better-sqlite3` | ^7.x | TypeScript definitions for better-sqlite3 |

### Note

PostgreSQL uses the existing `pg` package (already in dependencies for database connections). No new dependency needed for PostgreSQL storage.

---

## Breaking Changes

**None.** This release is fully backward-compatible:

- All 16+ consumer components keep the same synchronous `storage.*` API
- The `@/lib/storage` import path is preserved (barrel export)
- Default mode is `local` — existing deployments work without any changes
- localStorage key prefix standardized to `libredb_` (done in v0.7.1)

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STORAGE_PROVIDER` | No | `local` | Storage backend: `local`, `sqlite`, or `postgres` |
| `STORAGE_SQLITE_PATH` | No | `./data/libredb-storage.db` | Path to SQLite database file |
| `STORAGE_POSTGRES_URL` | Yes (postgres) | — | PostgreSQL connection string |

> These are **server-side only** variables (no `NEXT_PUBLIC_` prefix). The client discovers the mode at runtime via `GET /api/storage/config`. This means **one Docker image works for all modes**.

---

## Testing

### New Tests

| File | Tests | Description |
|------|-------|-------------|
| `local-storage.test.ts` | 7 | localStorage CRUD, SSR safety, JSON parse errors |
| `storage-facade.test.ts` | 18 | All domain methods, CustomEvent dispatch |
| `storage-facade-extended.test.ts` | 33 | History caps, snapshots, charts, edge cases |
| `factory.test.ts` | 7 | Env-based provider selection, singleton behavior |
| `sqlite.test.ts` | 23 | WAL mode, upsert, transactions, health check |
| `postgres.test.ts` | 23 | Pool config, upsert, transactions, health check |
| `config.test.ts` | 4 | Config endpoint responses for all modes |
| `storage-routes.test.ts` | 27 | API route handlers (GET/PUT/POST, auth, validation) |
| `factory-singleton.test.ts` | 15 | Singleton isolation, concurrent access |
| `use-storage-sync.test.ts` | 37 | Hook lifecycle: discovery, migration, pull, push |

**Total: 194 new tests across 10 files**

### E2E Test Results

All three storage modes verified end-to-end:

| Mode | API Tests | Browser Tests | User Isolation | Result |
|------|-----------|---------------|----------------|--------|
| **Local** | 3/3 pass | 2/2 pass | N/A | PASS |
| **SQLite** | 6/6 pass | 3/3 pass | N/A | PASS |
| **PostgreSQL** | 8/8 pass | 3/3 pass | 2-user verified | PASS |

### CI Pipeline

```
bun run lint        # ESLint 9 — clean
bun run typecheck   # TypeScript strict — clean
bun run test        # All tests pass (unit + API + integration + hooks + components)
bun run build       # Next.js production build — clean
```

---

## Extending: Add Your Own Storage Provider

Adding a new backend (e.g., MySQL, DynamoDB, Redis) requires **one file** implementing `ServerStorageProvider`:

```typescript
// src/lib/storage/providers/your-provider.ts
import type { ServerStorageProvider, StorageData, StorageCollection } from '../types';

export class YourStorageProvider implements ServerStorageProvider {
  async initialize(): Promise<void> { /* create table */ }
  async getAllData(userId: string): Promise<Partial<StorageData>> { /* ... */ }
  async getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null> { /* ... */ }
  async setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void> { /* upsert */ }
  async mergeData(userId: string, data: Partial<StorageData>): Promise<void> { /* batch upsert */ }
  async isHealthy(): Promise<boolean> { /* SELECT 1 */ }
  async close(): Promise<void> { /* cleanup */ }
}
```

Then register it in `factory.ts` — no changes to facade, API routes, sync hook, or consumer components.

---

## Migration Guide

### From v0.7.x to v0.8.0

**No action required** for existing deployments. The default mode is `local` and the API is unchanged.

### To Enable Server Storage

1. **SQLite (simplest):**
   ```env
   # Add to .env.local
   STORAGE_PROVIDER=sqlite
   ```
   That's it. Directory, file, WAL mode, and table are auto-created.

2. **PostgreSQL:**
   ```env
   # Add to .env.local
   STORAGE_PROVIDER=postgres
   STORAGE_POSTGRES_URL=postgresql://user:pass@host:5432/libredb
   ```
   The database must exist; the table is auto-created.

3. **Existing localStorage data** is automatically migrated to the server on first login. No manual export/import needed.

---

## Documentation

- **[STORAGE_ARCHITECTURE.md](../STORAGE_ARCHITECTURE.md)** — Deep-dive into write-through cache, sync hook, provider internals, and data model
- **[STORAGE_QUICK_SETUP.md](../STORAGE_QUICK_SETUP.md)** — Step-by-step setup for all three modes with Docker examples and troubleshooting

---

## What's Next

### v0.8.x (Planned)
- S3/MinIO storage provider for object storage deployments
- Storage admin panel with usage metrics and data export
- Cross-device sync indicator in the UI
- Conflict resolution for concurrent multi-tab edits in server mode

---

## Full Changelog

### Added
- Pluggable storage abstraction layer (`src/lib/storage/`) with Strategy Pattern
- SQLite storage provider (`better-sqlite3`, WAL mode, auto-create)
- PostgreSQL storage provider (`pg` pool, transactional merge)
- Storage API routes: `/api/storage/config`, `/api/storage`, `/api/storage/[collection]`, `/api/storage/migrate`
- `useStorageSync` write-through cache hook with debounced push (500ms)
- Automatic localStorage-to-server migration on first login
- Per-user data isolation via JWT username scoping
- Runtime storage mode discovery (no `NEXT_PUBLIC_*` build-time coupling)
- `STORAGE_PROVIDER`, `STORAGE_SQLITE_PATH`, `STORAGE_POSTGRES_URL` environment variables
- Docker Compose examples for SQLite and PostgreSQL modes
- `better-sqlite3` and `@types/better-sqlite3` dependencies
- 194 new tests across 10 test files
- `STORAGE_ARCHITECTURE.md` — comprehensive architecture documentation (565 lines)
- `STORAGE_QUICK_SETUP.md` — quick setup guide with Docker examples (404 lines)

### Changed
- Monolithic `src/lib/storage.ts` refactored into modular `src/lib/storage/` directory
- localStorage keys standardized to `libredb_` prefix (v0.7.1)
- `DataCharts.tsx`, `SecurityTab.tsx`, `BottomPanel.tsx`, `audit.ts`, `data-masking.ts` — use storage module
- `Dockerfile` — includes `better-sqlite3` native bindings and `/app/data` directory
- `docker-compose.yml` — storage volume and environment variables
- `.env.example` — storage configuration section

### Fixed
- `/api/storage/config` blocked by proxy middleware (307 redirect instead of JSON response)

### Removed
- `src/lib/storage.ts` — replaced by `src/lib/storage/` module (import path preserved via barrel export)

---

**Full Changelog:** [Compare v0.7.0...v0.8.0](https://github.com/libredb/libredb-studio/compare/v0.7.0...v0.8.0)

**Docker Image:** `ghcr.io/libredb/libredb-studio:0.8.0`
