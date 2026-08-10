# Storage — LibreDB Studio

LibreDB Studio uses a **pluggable storage abstraction layer** that lets it operate in two modes:

- **Local mode** (default): Zero-config, all data lives in the browser's `localStorage`. Ideal for single-user / open-source usage.
- **Server mode**: Data is persisted to a server-side database (SQLite or PostgreSQL) with per-user scoping. Ideal for teams and enterprise deployments.

Switching between modes requires **only one environment variable** — no code changes, no rebuild.

This document is split into two parts. Most readers want **[Part 1 — Setup & Configuration](#part-1--setup--configuration)**. For internals, see **[Part 2 — Architecture & Internals](#part-2--architecture--internals)**.

---

## Table of Contents

**[Part 1 — Setup & Configuration](#part-1--setup--configuration)**
- [Which Mode Should I Use?](#which-mode-should-i-use)
- [1. Local Mode (Default)](#1-local-mode-default)
- [2. SQLite Mode](#2-sqlite-mode)
- [3. PostgreSQL Mode](#3-postgresql-mode)
- [Migration: Local to Server](#migration-local-to-server)
- [Credential Encryption at Rest](#credential-encryption-at-rest)
- [Environment Variables Reference](#environment-variables-reference)
- [Health Check](#health-check)
- [Troubleshooting](#troubleshooting)
- [Database Schema Reference](#database-schema-reference)

**[Part 2 — Architecture & Internals](#part-2--architecture--internals)**
- [1. Design Goals](#1-design-goals)
- [2. Architecture Overview](#2-architecture-overview)
- [3. Data Model](#3-data-model)
- [4. Module Structure](#4-module-structure)
- [5. Local Storage Layer](#5-local-storage-layer)
- [6. Storage Facade](#6-storage-facade)
- [7. Server Storage Providers](#7-server-storage-providers)
- [8. API Routes](#8-api-routes)
- [9. Write-Through Cache & Sync Hook](#9-write-through-cache--sync-hook)
- [10. Migration Flow](#10-migration-flow)
- [11. Configuration](#11-configuration)
- [12. User Scoping & Security](#12-user-scoping--security)
- [13. Docker Deployment](#13-docker-deployment)
- [14. Adding a New Provider](#14-adding-a-new-provider)

---

# Part 1 — Setup & Configuration

LibreDB Studio supports three storage modes. Pick the one that fits your use case and follow the steps below.

## Which Mode Should I Use?

| Mode | Best For | Persistence | Multi-User | Setup |
|------|----------|-------------|------------|-------|
| **Local** (default) | Solo dev, quick start | Browser only | No | Zero config |
| **SQLite** | Small teams, single server | Server file | Yes | 1 env var |
| **PostgreSQL** | Enterprise, multi-node | External DB | Yes | 2 env vars |

---

## 1. Local Mode (Default)

No configuration needed. All data stays in the browser's `localStorage`.

```bash
# Just start the app — that's it
bun dev
```

**What you get:**
- Instant start, no database required
- Data persists across page reloads
- Data is lost if browser storage is cleared or you switch browsers/devices

**When to move on:** When you need data to survive across devices, browsers, or team members.

---

## 2. SQLite Mode

A single file on the server. Great for self-hosted single-node deployments.

### Minimal Setup (Just One Env Var)

```bash
# .env.local
STORAGE_PROVIDER=sqlite
```

```bash
bun dev
```

That's it. When `STORAGE_SQLITE_PATH` is not provided, the default path is `./data/libredb-storage.db`.

### What Happens Automatically

On the first API request, the SQLite provider:

1. **Creates the directory** — `./data/` (or whatever parent directory the path points to) is created recursively if it doesn't exist
2. **Creates the database file** — `libredb-storage.db` is created by `better-sqlite3`
3. **Enables WAL mode** — Write-Ahead Logging for better concurrent read performance
4. **Creates the table** — `user_storage` table with the schema below

No manual setup, no migrations, no SQL scripts needed.

### Custom Path

If you want the database file in a different location:

```bash
# .env.local
STORAGE_PROVIDER=sqlite
STORAGE_SQLITE_PATH=/var/lib/libredb/storage.db
```

The directory must be writable by the app process. The directory and file are created automatically.

### Docker

```yaml
# docker-compose.yml
services:
  app:
    image: ghcr.io/libredb/libredb-studio:latest
    ports:
      - "3000:3000"
    environment:
      - STORAGE_PROVIDER=sqlite
      - STORAGE_SQLITE_PATH=/app/data/libredb-storage.db
    volumes:
      - storage-data:/app/data

volumes:
  storage-data:
```

```bash
docker-compose up -d
```

> **Volume is essential.** Without it, data is lost when the container restarts.

### Verify

```bash
curl http://localhost:3000/api/storage/config
# → {"provider":"sqlite","serverMode":true}
```

### Manual Table Creation (Optional)

The table is auto-created, but if you prefer to create it yourself (e.g., for auditing or version control):

```sql
CREATE TABLE IF NOT EXISTS user_storage (
  user_id    TEXT NOT NULL,
  collection TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, collection)
);

-- Recommended: enable WAL mode for concurrent read performance
PRAGMA journal_mode = WAL;
```

---

## 3. PostgreSQL Mode

Recommended for production, teams, and high-availability deployments.

> **Important:** Unlike SQLite, `STORAGE_POSTGRES_URL` is **required**. There is no default value. If you set `STORAGE_PROVIDER=postgres` without providing a connection string, the app will throw an error on the first storage request:
> ```
> Error: STORAGE_POSTGRES_URL is required when STORAGE_PROVIDER=postgres
> ```

### Local Development

```bash
# Start a PostgreSQL instance (if you don't have one)
docker run -d --name libredb-pg \
  -e POSTGRES_DB=libredb \
  -e POSTGRES_USER=libredb \
  -e POSTGRES_PASSWORD=secret \
  -p 5432:5432 \
  postgres:16-alpine
```

```bash
# .env.local
STORAGE_PROVIDER=postgres
STORAGE_POSTGRES_URL=postgresql://libredb:secret@localhost:5432/libredb?sslmode=disable
```

```bash
bun dev
```

### What Happens Automatically

On the first API request, the PostgreSQL provider:

1. **Creates a connection pool** — max 5 connections, 30s idle timeout
2. **Handles idle-client failures** — the pool gets an `error` listener immediately (see below)
3. **Creates the table** — `user_storage` table with the schema below via `CREATE TABLE IF NOT EXISTS`

The database itself must already exist. The **table** is auto-created, but the **database** is not.

This pool is long-lived: once created it serves every storage request for the life of the process. A
pooled client that fails while **idle** — the server dropped it, the network went away, the DBA
restarted the database — has no query to reject, so `pg` destroys it and emits `error` on the pool.
Node treats an `error` event with no listener as an uncaught exception, so the provider attaches one
that logs through the storage logger (`provider=postgres`) and lets the pool open a fresh client on
the next request. A dropped idle connection therefore costs one log line, never the server process.
The PostgreSQL *database* provider carries the same guard for the same reason (see
[providers/postgres.md](./providers/postgres.md#42-connection-pooling)).

### Required Privileges

The PostgreSQL user specified in `STORAGE_POSTGRES_URL` needs:

| Privilege | Why |
|-----------|-----|
| `CREATE TABLE` | Auto-create `user_storage` on first request (only needed once) |
| `INSERT` | Save user data |
| `UPDATE` | Update existing data |
| `SELECT` | Read user data |

If your DBA restricts `CREATE TABLE`, you can create the table manually (see below) and the user only needs `INSERT`/`UPDATE`/`SELECT`.

### Docker Compose (App + PostgreSQL)

```yaml
# docker-compose.yml
services:
  app:
    image: ghcr.io/libredb/libredb-studio:latest
    ports:
      - "3000:3000"
    environment:
      - STORAGE_PROVIDER=postgres
      - STORAGE_POSTGRES_URL=postgresql://libredb:secret@db:5432/libredb?sslmode=disable
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:18
    environment:
      - POSTGRES_DB=libredb
      - POSTGRES_USER=libredb
      - POSTGRES_PASSWORD=secret
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U libredb"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

```bash
docker-compose up -d
```

### Using an Existing PostgreSQL

Just set the connection string — the table is auto-created:

```bash
STORAGE_PROVIDER=postgres
STORAGE_POSTGRES_URL=postgresql://user:pass@your-pg-host:5432/your_db
```

Use `sslmode=disable` for local/non-SSL PostgreSQL and `sslmode=require` for managed cloud PostgreSQL:

```bash
# Local PostgreSQL
STORAGE_POSTGRES_URL=postgresql://user:pass@localhost:5432/your_db?sslmode=disable

# Cloud PostgreSQL
STORAGE_POSTGRES_URL=postgresql://user:pass@your-pg-host:5432/your_db?sslmode=require
```

### Verify

```bash
curl http://localhost:3000/api/storage/config
# → {"provider":"postgres","serverMode":true}
```

### Manual Table Creation (Optional)

The table is auto-created on first request. However, if you prefer to create it yourself — for example, in environments where the app user doesn't have `CREATE TABLE` privileges, or you want to track schema changes in version control:

```sql
-- PostgreSQL
CREATE TABLE IF NOT EXISTS user_storage (
  user_id    TEXT NOT NULL,
  collection TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, collection)
);

-- Optional: index for faster lookups by user
CREATE INDEX IF NOT EXISTS idx_user_storage_user_id ON user_storage (user_id);
```

#### Minimal Privileges (When Table Already Exists)

If a DBA creates the table, the app user only needs:

```sql
-- Grant only data access (no DDL needed)
GRANT SELECT, INSERT, UPDATE ON user_storage TO libredb_app;
```

---

## Migration: Local to Server

When you switch from local mode to SQLite or PostgreSQL, **existing browser data is automatically migrated** on first login:

1. User opens the app in server mode
2. The sync hook detects it's the first time (no `libredb_server_migrated` flag)
3. All existing localStorage data is sent to the server via `POST /api/storage/migrate` (a fresh browser with no `libredb_*` data simply sets the flag and skips the upload)
4. Server upserts each collection as a whole JSON blob — one row per user per collection, replacing any existing row
5. A flag is set in localStorage to prevent re-migration
6. From this point on, the server is the source of truth

**No manual steps required.** Just change the env var and restart.

> If multiple users were sharing a browser in local mode, only the data from the user who migrates first will be sent. Each user's server storage is isolated by their login email.

For the full migration lifecycle and the underlying merge semantics, see [Migration Flow](#10-migration-flow) in Part 2.

---

## Credential Encryption at Rest

In `sqlite` and `postgres` modes, credentials are encrypted before they are written. There is
nothing to switch on and nothing to configure.

### What is encrypted

Six fields, all on a saved connection:

| Field | What it is |
|-------|------------|
| `password` | The database password |
| `connectionString` | A URL that can embed `user:password@` |
| `ssl.clientKey` | The TLS client private key |
| `sshTunnel.password` | The SSH password |
| `sshTunnel.privateKey` | The SSH private key |
| `sshTunnel.passphrase` | The passphrase that unlocks the key above |

Everything else stays readable, deliberately: `host`, `port`, `user`, `database`, `name` and the
TLS certificates (`ssl.caCert`, `ssl.clientCert` — certificates are public by construction). An
operator holding a dump has to be able to answer "which of my databases is in here"; that is
incident response, not a leak. No other collection is touched — `history` and `saved_queries` hold
SQL text, which is the product's data rather than its secrets.

Each value is stored as `v1:<iv>:<ciphertext>` using AES-256-GCM with a fresh random IV, so two
identical passwords do not look identical in the store, and a tampered value is detected rather
than silently decrypting to something else.

### The key

| `STORAGE_ENCRYPTION_KEY` | Key used |
|--------------------------|----------|
| unset (default) | Derived from `JWT_SECRET` via HKDF-SHA256 |
| set (min 32 characters) | Derived from that value via HKDF-SHA256 |

Deriving from `JWT_SECRET` is what keeps the zero-config promise: no new required variable, and if
you never set `JWT_SECRET` either, the first-run bootstrap generates and persists one
(`<data dir>/auth-bootstrap.json`), so the key is stable across restarts.

Set a dedicated `STORAGE_ENCRYPTION_KEY` where key separation matters — most usefully so that
rotating your session-signing secret does not also invalidate every saved connection password.

### Rotating a key invalidates stored credentials

**This is the trade-off, stated plainly: rotating whichever key is in use makes every stored
credential unreadable.** That applies to rotating `JWT_SECRET` when `STORAGE_ENCRYPTION_KEY` is
unset, and to rotating `STORAGE_ENCRYPTION_KEY` when it is set. It also applies if you lose the
bootstrap file — a container without a persistent volume for its data directory regenerates
`JWT_SECRET` on every start.

What happens is bounded and recoverable:

- The **connection survives**. Its name, host, port, user and database are still there.
- The unreadable field is **omitted**, not replaced with garbage. The password box is empty.
- A warning is written to the server log once per read: `Stored connection secrets could not be
  decrypted: N field(s) were omitted.`
- Nothing is deleted from the database by the read itself.

To recover, restore the previous key and restart, **before** using the app. Reads happen on page
load; the first time the app writes that collection back, the omitted values are gone for good,
because the browser copy is the source the server is updated from. If you cannot restore the key,
re-enter the affected passwords once and they are re-encrypted under the current key.

### Existing deployments migrate themselves

Reads accept both plaintext and encrypted values, and writes always produce encrypted ones. An
existing store therefore migrates as it is used, with no migration command, no downtime and no
version column. A row that is never written again stays plaintext — which is why the
`STORAGE_ENCRYPTION_KEY` upgrade is safe to roll back.

### What this does not protect

- **Browser `localStorage` is not encrypted.** It is the rendering source and it holds the same
  credentials in the clear. That is a deliberate product decision — it is what lets Studio work
  without a master password — and it is why cross-site scripting is treated as a top-severity
  issue in this project rather than a session-theft issue.
- **Anyone who can read the server's environment can read the credentials.** The key lives there.
  This protects a stolen database file or dump on its own; it is not a vault.
- **For `STORAGE_PROVIDER=sqlite` with no `STORAGE_ENCRYPTION_KEY` set, a backup or volume snapshot
  is NOT protected.** The fallback key derives from `JWT_SECRET`, persisted in
  `<data dir>/auth-bootstrap.json` — the same directory `STORAGE_SQLITE_PATH` puts the database
  file in, and the one directory the Helm chart mounts as a single `/app/data` volume. A snapshot
  of that volume carries the ciphertext and the key that opens it side by side. Set
  `STORAGE_ENCRYPTION_KEY` from outside that volume — a Kubernetes Secret, an environment variable
  your orchestrator supplies — to close this: once the key is not itself part of the backup, a
  snapshot is genuinely useless without it. `STORAGE_PROVIDER=postgres` does not share this
  exposure by default, because the key material lives in the app's own filesystem, a volume
  separate from the database that gets backed up.
- **`GET /api/storage` returns credentials in plaintext to their authenticated owner.** It has to:
  the app must be able to redisplay a saved password for editing.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STORAGE_PROVIDER` | No | `local` | `local`, `sqlite`, or `postgres` |
| `STORAGE_SQLITE_PATH` | No | `./data/libredb-storage.db` | Path to SQLite file. Directory and file are auto-created. |
| `STORAGE_POSTGRES_URL` | **Yes** (postgres mode) | — | PostgreSQL connection string. **No default — app will error without it.** |

> These are **server-side only** variables (no `NEXT_PUBLIC_` prefix). The client discovers the mode at runtime via `GET /api/storage/config`. This means one Docker image works for all modes. See [Why Not `NEXT_PUBLIC_*`?](#why-not-next_public_) for the rationale.

### Default Behavior Summary

| Mode | Config needed | What's auto-created |
|------|--------------|---------------------|
| `local` | Nothing | N/A (browser localStorage) |
| `sqlite` | Just `STORAGE_PROVIDER=sqlite` | Directory + DB file + WAL mode + table |
| `postgres` | `STORAGE_PROVIDER=postgres` + `STORAGE_POSTGRES_URL` | Table only (database must exist) |

---

## Health Check

Check if the storage backend is reachable:

```bash
# Storage mode info (always works, no auth needed)
curl http://localhost:3000/api/storage/config

# Full data fetch (requires auth cookie)
curl -b cookies.txt http://localhost:3000/api/storage
```

---

## Troubleshooting

### "Data not syncing to server"

1. Check storage mode: `curl http://localhost:3000/api/storage/config`
2. Make sure the response shows `"serverMode": true`
3. Check browser console for sync errors (look for `[StorageSync]` prefixed logs)

### SQLite: "SQLITE_CANTOPEN"

- The directory in `STORAGE_SQLITE_PATH` must be writable by the app process
- In Docker, make sure the volume is mounted correctly

### PostgreSQL: "STORAGE_POSTGRES_URL is required"

- You set `STORAGE_PROVIDER=postgres` but didn't provide `STORAGE_POSTGRES_URL`
- Unlike SQLite, PostgreSQL has **no default** — a connection string is always required
- Fix: add `STORAGE_POSTGRES_URL=postgresql://user:pass@host:5432/dbname` to your env

### PostgreSQL: "Connection refused"

- Verify `STORAGE_POSTGRES_URL` is correct and the database is reachable
- In Docker Compose, use the service name (`db`) as the host, not `localhost`
- Check that the PostgreSQL container is healthy: `docker-compose ps`

### PostgreSQL: "server does not support SSL connections"

- Your PostgreSQL server does not accept SSL, but SSL is enabled in the connection URL
- Fix local setups by adding `?sslmode=disable` to `STORAGE_POSTGRES_URL`
- For managed cloud PostgreSQL, use `?sslmode=require`

### "Data disappeared after switching modes"

- Switching from server mode **back** to local mode doesn't pull data from the server
- Local mode only reads from localStorage
- To recover: switch back to server mode, the data is still in the database

### "My connection passwords are blank after a restart"

Look for this line in the server log:

```
Stored connection secrets could not be decrypted: 3 field(s) were omitted.
```

The encryption key changed. Either `JWT_SECRET` was rotated (and `STORAGE_ENCRYPTION_KEY` is not
set), or `STORAGE_ENCRYPTION_KEY` itself changed, or the data directory holding
`auth-bootstrap.json` was not persisted so a fresh `JWT_SECRET` was generated on start.

Restore the previous key and restart **before** using the app — see
[Rotating a key invalidates stored credentials](#rotating-a-key-invalidates-stored-credentials).
If the key is gone, re-enter the affected passwords; everything else about the connection is intact.

### "Duplicate data after migration"

- Migration runs once per browser (guarded by the `libredb_server_migrated` flag) and replaces each collection wholesale, so duplicates shouldn't occur
- If you do see them, check whether the same user pushed data from multiple browsers before the first migration completed

---

## Database Schema Reference

Both SQLite and PostgreSQL use the same single-table design. The table is auto-created on first request, but the full DDL is provided here for reference.

### SQLite

```sql
CREATE TABLE IF NOT EXISTS user_storage (
  user_id    TEXT NOT NULL,
  collection TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, collection)
);

PRAGMA journal_mode = WAL;
```

### PostgreSQL

```sql
CREATE TABLE IF NOT EXISTS user_storage (
  user_id    TEXT NOT NULL,
  collection TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, collection)
);

-- Optional: index for faster lookups by user
CREATE INDEX IF NOT EXISTS idx_user_storage_user_id ON user_storage (user_id);
```

### Schema Explanation

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | TEXT | User's email from JWT token (e.g., `admin@libredb.org`) |
| `collection` | TEXT | Data category: `connections`, `history`, `saved_queries`, `schema_snapshots`, `saved_charts`, `active_connection_id`, `audit_log`, `masking_config`, `threshold_config`, `dismissed_seeds` |
| `data` | TEXT | JSON-serialized collection data |
| `updated_at` | TEXT / TIMESTAMPTZ | Last modification timestamp |

Each row stores **one user's one collection** as a JSON blob. Adding a new collection type requires no schema changes — just a new row.

---

# Part 2 — Architecture & Internals

This part describes the internals of the storage abstraction layer: design goals, module structure, the storage facade API, provider interface, the write-through cache, the `useStorageSync` hook lifecycle, migration flows, and the security model.

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

All application state is organized into **10 collections**, each stored as a JSON blob:

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
| `dismissed_seeds` | `string[]` | Seed IDs the user dismissed (deleted a `managed: false` seed copy) so it is not re-added | — |

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

> The full per-dialect DDL (with defaults and the recommended index) is in [Database Schema Reference](#database-schema-reference) in Part 1.

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
dismissed_seeds   → libredb_dismissed_seeds
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
export function writeJSON(collection: string, data: unknown): boolean;  // false on failure (e.g. QuotaExceededError)
export function readString(collection: string): string | null;
export function writeString(collection: string, value: string): boolean; // false on failure
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
| **Connections** | `getConnections()`, `saveConnection(conn)`, `deleteConnection(id)`, `getDismissedSeeds()` |
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
| **Upsert** | `INSERT ... ON CONFLICT (user_id, collection) DO UPDATE` |
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
  isReady: boolean;          // Init complete (config fetched + initial pull done)?
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
   a. Reads whichever of the 10 collections exist in localStorage (a fresh browser with none simply sets the flag and skips)
   b. POST /api/storage/migrate with the collected payload
   c. Server calls provider.mergeData() — upserts each collection as a whole blob in one transaction
   d. Sets 'libredb_server_migrated' flag in localStorage
4. Pull: GET /api/storage → overwrite localStorage with server data
5. Subsequent mutations sync normally via push
```

This ensures existing localStorage data is preserved when transitioning to server mode.

> For the operator-facing summary of this behavior, see [Migration: Local to Server](#migration-local-to-server) in Part 1.

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

OIDC users (Auth0, Keycloak, Okta, Azure AD) have their `preferred_username` or email claim mapped to the same `username` field used as `user_id`. See [OIDC.md](./OIDC.md) for SSO configuration — it pairs well with server storage for team deployments.

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
    image: postgres:18
    environment:
      POSTGRES_DB: libredb
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
```

No volume needed on the app container — data lives in PostgreSQL.

> For step-by-step operator instructions (including healthchecks and verification), see [Docker](#docker) under SQLite and [Docker Compose (App + PostgreSQL)](#docker-compose-app--postgresql) in Part 1.

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

---

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Overall system architecture
- [OIDC.md](./OIDC.md) — SSO configuration (pairs well with server storage for team deployments)
