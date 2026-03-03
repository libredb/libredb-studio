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

### Local Development

```bash
# .env.local
STORAGE_PROVIDER=sqlite
STORAGE_SQLITE_PATH=./data/libredb-storage.db
```

```bash
bun dev
```

The database file and directory are created automatically on first request.

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

---

## 3. PostgreSQL Mode

Recommended for production, teams, and high-availability deployments.

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
STORAGE_POSTGRES_URL=postgresql://libredb:secret@localhost:5432/libredb
```

```bash
bun dev
```

The `user_storage` table is created automatically on first request.

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
      - STORAGE_POSTGRES_URL=postgresql://libredb:secret@db:5432/libredb
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

Just set the connection string — no special schema setup needed:

```bash
STORAGE_PROVIDER=postgres
STORAGE_POSTGRES_URL=postgresql://user:pass@your-pg-host:5432/your_db
```

The required table is auto-created on startup. The user needs `CREATE TABLE` and `INSERT`/`UPDATE`/`SELECT` privileges.

### Verify

```bash
curl http://localhost:3000/api/storage/config
# → {"provider":"postgres","serverMode":true}
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

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_PROVIDER` | `local` | `local`, `sqlite`, or `postgres` |
| `STORAGE_SQLITE_PATH` | `./data/libredb-storage.db` | Path to SQLite file (sqlite mode) |
| `STORAGE_POSTGRES_URL` | — | PostgreSQL connection string (postgres mode) |

> These are **server-side only** variables (no `NEXT_PUBLIC_` prefix). The client discovers the mode at runtime via `GET /api/storage/config`. This means one Docker image works for all modes.

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

### PostgreSQL: "Connection refused"

- Verify `STORAGE_POSTGRES_URL` is correct and the database is reachable
- In Docker Compose, use the service name (`db`) as the host, not `localhost`
- Check that the PostgreSQL container is healthy: `docker-compose ps`

### "Data disappeared after switching modes"

- Switching from server mode **back** to local mode doesn't pull data from the server
- Local mode only reads from localStorage
- To recover: switch back to server mode, the data is still in the database

### "Duplicate data after migration"

- Migration uses ID-based deduplication — this shouldn't happen
- If it does, check if the same user logged in from multiple browsers before migration completed

---

## What's Next?

- [STORAGE_ARCHITECTURE.md](./STORAGE_ARCHITECTURE.md) — Deep dive into the write-through cache, sync hook, and provider internals
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Overall system architecture
- [OIDC_SETUP.md](./OIDC_SETUP.md) — SSO configuration (pairs well with server storage for team deployments)
