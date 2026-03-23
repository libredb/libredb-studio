# Storage Architecture — LibreDB Studio

This document describes the **Storage Abstraction Layer**, a pluggable persistence system that allows LibreDB Studio to operate in two modes:

- **Local mode** (default): Zero-config, all data lives in the browser's `localStorage`. Ideal for single-user / open-source usage.
- **Server mode**: Data is persisted to a server-side database (SQLite or PostgreSQL) with per-user scoping. Ideal for teams and enterprise deployments.

Switching between modes requires **only one environment variable** — no code changes, no rebuild.

---

## Table of Contents

1. [Design Goals](#1-design-goals)
2. [Architecture Overview](#2-architecture-overview)
3. [Data Model](#3-data-model)
4. [Module Structure](#4-module-structure)
5. [Local Storage Layer](#5-local-storage-layer)
6. [Storage Facade](#6-storage-facade)
7. [Server Storage Providers](#7-server-storage-providers)
8. [API Routes](#8-api-routes)
9. [Write-Through Cache & Sync Hook](#9-write-through-cache--sync-hook)
10. [Migration Flow](#10-migration-flow)
11. [Configuration](#11-configuration)
12. [User Scoping & Security](#12-user-scoping--security)
13. [Docker Deployment](#13-docker-deployment)
14. [Adding a New Provider](#14-adding-a-new-provider)

---

## 1. Design Goals

| Goal | Approach |
|------|----------|
| **Zero breaking changes** | All 16+ consumer components keep the same synchronous `storage.*` API |
| **Zero-config default** | `localStorage` works out of the box — no database, no env vars needed |
| **Single image, all modes** | Runtime config via env var, not build-time `NEXT_PUBLIC_*` |
| **Per-user isolation** | Server storage scoped by JWT `username` — no cross-user leaks |
| **Graceful degradation** | If server is unreachable, `localStorage` continues to work |
| **Extensible** | Adding a new backend (e.g., MySQL, DynamoDB) requires one file implementing `ServerStorageProvider` |

---

## 2. Architecture Overview

```
┌──────────────────────────────┐
│   16+ Consumer Components    │  ← Unchanged, same sync API
│   storage.getConnections()   │
│   storage.saveConnection()   │
└──────────────┬───────────────┘
               │ sync read/write
┌──────────────▼───────────────┐
│   Storage Facade             │  ← localStorage read/write + CustomEvent dispatch
│   src/lib/storage/           │
│   storage-facade.ts          │
└──────────────┬───────────────┘
               │ CustomEvent: 'libredb-storage-change'
┌──────────────▼───────────────┐
│   useStorageSync Hook        │  ← Mounted in Studio.tsx (server mode only)
│   src/hooks/                 │
│   use-storage-sync.ts        │
└──────────────┬───────────────┘
               │ fetch (debounced 500ms)
┌──────────────▼───────────────┐
│   API Routes                 │  ← JWT auth + user scoping
│   /api/storage/*             │
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│   ServerStorageProvider       │  ← Strategy Pattern
│   ┌─────────┐ ┌────────────┐ │
│   │ SQLite  │ │ PostgreSQL │ │
│   └─────────┘ └────────────┘ │
└──────────────────────────────┘
```

**Key insight:** `localStorage` is always the **rendering source** (L1 cache). The server database is the **persistent source of truth** (L2). The sync hook keeps them in sync via a write-through cache pattern.

---

## 3. Data Model

### 3.1 Collections

All application state is organized into **9 collections**, each stored as a JSON blob:

| Collection | Type | Description | Max Items |
|-----------|------|-------------|-----------|
| `connections` | `DatabaseConnection[]` | Saved database connections | — |
| `history` | `QueryHistoryItem[]` | Query execution history | 500 |
| `saved_queries` | `SavedQuery[]` | User-saved SQL/JSON queries | — |
| `schema_snapshots` | `SchemaSnapshot[]` | Schema diff snapshots | 50 |
| `saved_charts` | `SavedChartConfig[]` | Saved chart configurations | — |
| `active_connection_id` | `string \| null` | Currently active connection | — |
| `audit_log` | `AuditEvent[]` | Audit trail events | 1000 |
| `masking_config` | `MaskingConfig` | Data masking rules and RBAC | — |
| `threshold_config` | `ThresholdConfig[]` | Monitoring alert thresholds | — |

### 3.2 Server Database Schema

Both SQLite and PostgreSQL use the same logical schema — a single table with collection-based JSON blobs:

```sql
CREATE TABLE IF NOT EXISTS user_storage (
  user_id    TEXT        NOT NULL,          -- JWT username (email)
  collection TEXT        NOT NULL,          -- 'connections', 'history', etc.
  data       TEXT        NOT NULL,          -- JSON serialized
  updated_at TEXT/TIMESTAMPTZ NOT NULL,     -- Last modification time
  PRIMARY KEY (user_id, collection)
);
```

This design is intentionally simple:
- **No schema migrations** needed when adding new collections
- **One row per user per collection** — efficient upsert
- **JSON blobs** keep the server storage schema-agnostic

### 3.3 localStorage Keys

Each collection maps to a `libredb_`-prefixed localStorage key:

```
connections       → libredb_connections
history           → libredb_history
saved_queries     → libredb_saved_queries
schema_snapshots  → libredb_schema_snapshots
saved_charts      → libredb_saved_charts
active_connection_id → libredb_active_connection_id
audit_log         → libredb_audit_log
masking_config    → libredb_masking_config
threshold_config  → libredb_threshold_config
```

---

## 4. Module Structure

```
src/lib/storage/
├── index.ts              # Barrel export — preserves @/lib/storage import path
├── types.ts              # StorageData, StorageCollection, ServerStorageProvider
├── local-storage.ts      # Pure localStorage CRUD (SSR-safe)
├── storage-facade.ts     # Public storage object with domain methods
├── factory.ts            # Env-based provider instantiation (singleton)
└── providers/
    ├── sqlite.ts         # better-sqlite3 implementation
    └── postgres.ts       # pg (Pool) implementation

src/hooks/
└── use-storage-sync.ts   # Write-through cache hook

src/app/api/storage/
├── config/route.ts       # GET: storage mode discovery (public)
├── route.ts              # GET: fetch all user data (auth required)
├── [collection]/route.ts # PUT: update single collection (auth required)
└── migrate/route.ts      # POST: localStorage → server migration (auth required)
```

---

## 5. Local Storage Layer

**File:** `src/lib/storage/local-storage.ts`

Pure, side-effect-free localStorage CRUD with SSR safety:

```typescript
// All operations check isClient() before accessing localStorage
export function readJSON<T>(collection: string): T | null;
export function writeJSON(collection: string, data: unknown): void;
export function readString(collection: string): string | null;
export function writeString(collection: string, value: string): void;
export function remove(collection: string): void;
export function getKey(collection: string): string;  // → 'libredb_' + collection
```

- Every function is guarded by `isClient()` — safe to call during SSR (returns `null` / no-op)
- JSON parse failures return `null` instead of throwing

---

## 6. Storage Facade

**File:** `src/lib/storage/storage-facade.ts`

The public `storage` object provides the same **synchronous API** that all 16+ consumer components use. Every mutation method:

1. Writes to `localStorage` (immediate)
2. Dispatches a `CustomEvent('libredb-storage-change')` with the collection name and data

```typescript
// Example: saving a connection
storage.saveConnection(conn);
// 1. Reads existing connections from localStorage
// 2. Upserts by ID
// 3. Writes back to localStorage
// 4. Dispatches CustomEvent({ collection: 'connections', data: updatedList })
```

### Public API

| Category | Methods |
|----------|---------|
| **Connections** | `getConnections()`, `saveConnection(conn)`, `deleteConnection(id)` |
| **History** | `getHistory()`, `addToHistory(item)`, `clearHistory()` |
| **Saved Queries** | `getSavedQueries()`, `saveQuery(query)`, `deleteSavedQuery(id)` |
| **Schema Snapshots** | `getSchemaSnapshots(connId?)`, `saveSchemaSnapshot(snap)`, `deleteSchemaSnapshot(id)` |
| **Charts** | `getSavedCharts()`, `saveChart(chart)`, `deleteChart(id)` |
| **Active Connection** | `getActiveConnectionId()`, `setActiveConnectionId(id)` |
| **Audit Log** | `getAuditLog()`, `saveAuditLog(events)` |
| **Masking Config** | `getMaskingConfig()`, `saveMaskingConfig(config)` |
| **Threshold Config** | `getThresholdConfig()`, `saveThresholdConfig(thresholds)` |

All read methods are **synchronous** — they read from `localStorage` only. No network calls.

---

## 7. Server Storage Providers

### 7.1 Provider Interface

**File:** `src/lib/storage/types.ts`

```typescript
interface ServerStorageProvider {
  initialize(): Promise<void>;
  getAllData(userId: string): Promise<Partial<StorageData>>;
  getCollection<K extends StorageCollection>(
    userId: string, collection: K
  ): Promise<StorageData[K] | null>;
  setCollection<K extends StorageCollection>(
    userId: string, collection: K, data: StorageData[K]
  ): Promise<void>;
  mergeData(userId: string, data: Partial<StorageData>): Promise<void>;
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}
```

### 7.2 SQLite Provider

**File:** `src/lib/storage/providers/sqlite.ts`
**Package:** `better-sqlite3` (Node.js compatible, not `bun:sqlite`)

| Feature | Detail |
|---------|--------|
| **WAL mode** | Enabled for concurrent read performance |
| **Auto-create** | Directory and database file created on `initialize()` |
| **Upsert** | `INSERT OR REPLACE INTO user_storage` |
| **Transactions** | `mergeData()` wraps all inserts in a single transaction |
| **Health check** | `SELECT 1 AS ok` |

```env
STORAGE_PROVIDER=sqlite
STORAGE_SQLITE_PATH=./data/libredb-storage.db   # default
```

### 7.3 PostgreSQL Provider

**File:** `src/lib/storage/providers/postgres.ts`
**Package:** `pg` (connection pool)

| Feature | Detail |
|---------|--------|
| **Pool config** | max: 5, idleTimeoutMillis: 30000 |
| **SSL behavior** | `sslmode=disable` for local/non-SSL servers, `sslmode=require` for cloud servers |
| **Upsert** | `INSERT ... ON CONFLICT (user_id, collection) DO UPDATE` |
| **Transactions** | `mergeData()` uses `BEGIN`/`COMMIT`/`ROLLBACK` with client checkout |
| **Health check** | `SELECT 1 AS ok` |

```env
STORAGE_PROVIDER=postgres
STORAGE_POSTGRES_URL=postgresql://user:pass@localhost:5432/libredb?sslmode=disable
```

### 7.4 Factory

**File:** `src/lib/storage/factory.ts`

The factory uses the **Singleton pattern** — one provider instance per process, lazy-initialized on first access:

```typescript
getStorageProviderType()     // → 'local' | 'sqlite' | 'postgres'
isServerStorageEnabled()     // → true if not 'local'
getStorageConfig()           // → { provider, serverMode }
getStorageProvider()         // → ServerStorageProvider | null (singleton)
closeStorageProvider()       // → cleanup for testing
```

Provider classes are **dynamically imported** — SQLite and PostgreSQL dependencies are only loaded when their provider is selected.

---

## 8. API Routes

All routes (except `/config`) require JWT authentication. The authenticated user's `username` (email) is used as the `user_id` for storage scoping.

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/storage/config` | GET | Public | Runtime storage mode discovery |
| `/api/storage` | GET | JWT | Fetch all collections for the authenticated user |
| `/api/storage/[collection]` | PUT | JWT | Update a single collection |
| `/api/storage/migrate` | POST | JWT | Merge localStorage dump into server storage |

### Response Examples

**GET /api/storage/config**
```json
{ "provider": "sqlite", "serverMode": true }
```

**GET /api/storage**
```json
{
  "connections": [{ "id": "c1", "name": "Prod DB", ... }],
  "history": [{ "id": "h1", "query": "SELECT ...", ... }],
  ...
}
```

**PUT /api/storage/connections**
```json
// Request: { "data": [{ "id": "c1", "name": "Prod DB", ... }] }
// Response: { "ok": true }
```

**POST /api/storage/migrate**
```json
// Request: { "connections": [...], "history": [...], ... }
// Response: { "ok": true, "migrated": ["connections", "history"] }
```

When `STORAGE_PROVIDER=local`, all data routes return `404 Not Found` (config route always works).

---

## 9. Write-Through Cache & Sync Hook

**File:** `src/hooks/use-storage-sync.ts`

The hook is mounted in `Studio.tsx` after `useAuth()` and orchestrates all client-server synchronization.

### Sync States

```typescript
interface StorageSyncState {
  isServerMode: boolean;     // Server storage active?
  isSyncing: boolean;        // Currently transferring data?
  lastSyncedAt: Date | null; // Last successful sync timestamp
  syncError: string | null;  // Last error message (null = healthy)
}
```

### Lifecycle

```
App Mount
  │
  ├─ GET /api/storage/config
  │   ├─ serverMode: false → done (localStorage only)
  │   └─ serverMode: true ──┐
  │                          │
  │   ┌──────────────────────▼──────────────────────┐
  │   │ Check libredb_server_migrated flag          │
  │   │  ├─ Not migrated → POST /api/storage/migrate│
  │   │  │   (send all localStorage → server merge) │
  │   │  │   Set flag in localStorage               │
  │   │  └─ Already migrated → skip                 │
  │   └──────────────────────┬──────────────────────┘
  │                          │
  │   ┌──────────────────────▼──────────────────────┐
  │   │ Pull: GET /api/storage                      │
  │   │  → Write server data into localStorage      │
  │   │  → Components re-render from localStorage   │
  │   └──────────────────────┬──────────────────────┘
  │                          │
  │   ┌──────────────────────▼──────────────────────┐
  │   │ Listen: 'libredb-storage-change' events     │
  │   │  → Collect pending collections              │
  │   │  → Debounce 500ms                           │
  │   │  → PUT /api/storage/[collection] for each   │
  │   └─────────────────────────────────────────────┘
  │
  ▼ (ongoing)
```

### Push Behavior (Debounced)

When any `storage.*` mutation fires:

1. Facade writes to `localStorage` (immediate, synchronous)
2. Facade dispatches `CustomEvent('libredb-storage-change', { collection, data })`
3. Hook captures event, adds collection to pending set
4. After 500ms of no new mutations, hook flushes:
   - Reads each pending collection from `localStorage`
   - Sends `PUT /api/storage/[collection]` for each

### Graceful Degradation

- If `/api/storage/config` fails → stays in localStorage-only mode
- If push fails → logs warning, sets `syncError`, does **not** block the UI
- Components always read from `localStorage` — no loading states for storage

---

## 10. Migration Flow

When a user first enables server mode (or a new user logs in for the first time):

```
1. Hook detects serverMode = true
2. Checks localStorage('libredb_server_migrated') flag
3. If not migrated:
   a. Reads all 9 collections from localStorage
   b. POST /api/storage/migrate with full payload
   c. Server calls provider.mergeData() — ID-based deduplication
   d. Sets 'libredb_server_migrated' flag in localStorage
4. Pull: GET /api/storage → overwrite localStorage with server data
5. Subsequent mutations sync normally via push
```

This ensures existing localStorage data is preserved when transitioning to server mode.

---

## 11. Configuration

### Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `STORAGE_PROVIDER` | `local` | No | Storage backend: `local`, `sqlite`, or `postgres` |
| `STORAGE_SQLITE_PATH` | `./data/libredb-storage.db` | No | Path to SQLite database file |
| `STORAGE_POSTGRES_URL` | — | If `postgres` | PostgreSQL connection string (`sslmode=disable` local, `sslmode=require` cloud) |

### Why Not `NEXT_PUBLIC_*`?

Next.js `NEXT_PUBLIC_*` variables are **inlined at build time** as static strings. This means:
- Every storage mode would require a separate Docker build
- Cannot change storage mode without rebuilding

Instead, the client discovers the storage mode at **runtime** via `GET /api/storage/config`. One Docker image supports all modes.

---

## 12. User Scoping & Security

### Per-User Isolation

Every row in `user_storage` is scoped by `user_id`:

```
(admin@libredb.org, connections) → [{"id":"c1", "name":"Prod DB"...}]
(admin@libredb.org, history)     → [{"id":"h1", "query":"SELECT..."...}]
(user@libredb.org,  connections) → [{"id":"c2", "name":"Dev DB"...}]
```

- `user_id` = JWT session `username` (email address)
- **Client never sends `user_id`** — server always extracts from JWT cookie
- Every query includes `WHERE user_id = $username` — no cross-user access possible

### Authentication

- `/api/storage/config` is **public** — returns only `{ provider, serverMode }`, no sensitive data
- All other `/api/storage/*` routes require a valid JWT session via `getSession()`
- Unauthorized requests receive `401 Unauthorized`

### OIDC Users

OIDC users (Auth0, Keycloak, Okta, Azure AD) have their `preferred_username` or email claim mapped to the same `username` field used as `user_id`.

---

## 13. Docker Deployment

### SQLite Mode

```yaml
# docker-compose.yml
services:
  libredb-studio:
    environment:
      STORAGE_PROVIDER: sqlite
      STORAGE_SQLITE_PATH: /app/data/libredb-storage.db
    volumes:
      - storage-data:/app/data

volumes:
  storage-data:
```

The Dockerfile includes `better-sqlite3` native bindings and creates the `/app/data` directory.

### PostgreSQL Mode

```yaml
services:
  libredb-studio:
    environment:
      STORAGE_PROVIDER: postgres
      STORAGE_POSTGRES_URL: postgresql://user:pass@db:5432/libredb
    depends_on:
      - db
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: libredb
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
```

No volume needed on the app container — data lives in PostgreSQL.

---

## 14. Adding a New Provider

To add a new storage backend (e.g., MySQL, DynamoDB):

### Step 1: Implement the Interface

Create `src/lib/storage/providers/your-provider.ts`:

```typescript
import type { ServerStorageProvider, StorageData, StorageCollection } from '../types';

export class YourStorageProvider implements ServerStorageProvider {
  async initialize(): Promise<void> { /* create table */ }
  async getAllData(userId: string): Promise<Partial<StorageData>> { /* ... */ }
  async getCollection<K extends StorageCollection>(
    userId: string, collection: K
  ): Promise<StorageData[K] | null> { /* ... */ }
  async setCollection<K extends StorageCollection>(
    userId: string, collection: K, data: StorageData[K]
  ): Promise<void> { /* upsert */ }
  async mergeData(
    userId: string, data: Partial<StorageData>
  ): Promise<void> { /* batch upsert in transaction */ }
  async isHealthy(): Promise<boolean> { /* SELECT 1 */ }
  async close(): Promise<void> { /* cleanup */ }
}
```

### Step 2: Register in Factory

Update `src/lib/storage/factory.ts`:

```typescript
// Add to StorageProviderType
type StorageProviderType = 'local' | 'sqlite' | 'postgres' | 'your-provider';

// Add dynamic import in getStorageProvider()
case 'your-provider': {
  const { YourStorageProvider } = await import('./providers/your-provider');
  instance = new YourStorageProvider(process.env.STORAGE_YOUR_URL!);
  break;
}
```

### Step 3: Add Tests

Create `tests/unit/lib/storage/providers/your-provider.test.ts` with mocked driver.

That's it — no changes needed to the facade, API routes, sync hook, or any consumer components.
