# Storage Quick Setup Guide

LibreDB Studio supports three storage modes. Pick the one that fits your use case and follow the steps below.

> For a deep dive into the architecture, see [STORAGE_ARCHITECTURE.md](./STORAGE_ARCHITECTURE.md).

---

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
2. **Creates the table** — `user_storage` table with the schema below via `CREATE TABLE IF NOT EXISTS`

The database itself must already exist. The **table** is auto-created, but the **database** is not.

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
    image: postgres:16-alpine
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
3. All localStorage data is sent to the server via `POST /api/storage/migrate`
4. Server merges the data (ID-based deduplication — no duplicates)
5. A flag is set in localStorage to prevent re-migration
6. From this point on, the server is the source of truth

**No manual steps required.** Just change the env var and restart.

> If multiple users were sharing a browser in local mode, only the data from the user who migrates first will be sent. Each user's server storage is isolated by their login email.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STORAGE_PROVIDER` | No | `local` | `local`, `sqlite`, or `postgres` |
| `STORAGE_SQLITE_PATH` | No | `./data/libredb-storage.db` | Path to SQLite file. Directory and file are auto-created. |
| `STORAGE_POSTGRES_URL` | **Yes** (postgres mode) | — | PostgreSQL connection string. **No default — app will error without it.** |

> These are **server-side only** variables (no `NEXT_PUBLIC_` prefix). The client discovers the mode at runtime via `GET /api/storage/config`. This means one Docker image works for all modes.

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

### "Duplicate data after migration"

- Migration uses ID-based deduplication — this shouldn't happen
- If it does, check if the same user logged in from multiple browsers before migration completed

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
| `collection` | TEXT | Data category: `connections`, `history`, `saved_queries`, `schema_snapshots`, `saved_charts`, `active_connection_id`, `audit_log`, `masking_config`, `threshold_config` |
| `data` | TEXT | JSON-serialized collection data |
| `updated_at` | TEXT / TIMESTAMPTZ | Last modification timestamp |

Each row stores **one user's one collection** as a JSON blob. Adding a new collection type requires no schema changes — just a new row.

---

## What's Next?

- [STORAGE_ARCHITECTURE.md](./STORAGE_ARCHITECTURE.md) — Deep dive into the write-through cache, sync hook, and provider internals
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Overall system architecture
- [OIDC_SETUP.md](./OIDC_SETUP.md) — SSO configuration (pairs well with server storage for team deployments)
