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
- [Connections whose type this Studio has no provider for](#connections-whose-type-this-studio-has-no-provider-for)
- [Saved queries whose type this Studio has no provider for](#saved-queries-whose-type-this-studio-has-no-provider-for)
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

Server storage (`sqlite` or `postgres`) gives each person their own private workspace by partitioning connections, saved queries, and settings by the login username.
For a team of three or more, pair server storage with Single Sign-On via [OIDC](OIDC.md) to provide individual logins, personal workspaces, and an audit trail that attributes actions to each user.
In server storage the browser copy belongs to the signed-in account: signing out clears this browser's copy, open editor tabs included, and signing in as a different account starts from that account's server data.
The default `local` mode stores data in the browser and does not isolate workspaces between people using the same browser profile.
In `local` mode the next account to sign in on that browser profile sees, and can open, the connections saved there before it.

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
4. **Turns foreign keys on**: `PRAGMA foreign_keys = ON`, read back, so passkeys follow their account; the start fails if the engine does not enable it
5. **Creates the tables**: `storage_meta`, `user_storage`, `accounts` and the three passkey tables, with the schema below

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
-- Facts about the store itself, such as its credential envelope state.
CREATE TABLE IF NOT EXISTS storage_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_storage (
  user_id    TEXT NOT NULL,
  collection TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, collection)
);

-- Recommended: enable WAL mode for concurrent read performance
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS accounts (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,
  totp_secret   TEXT,
  totp_pending  TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Passkeys (#785). Every connection that deletes accounts must enforce foreign keys:
-- Studio's own do, the sqlite3 shell does not unless told.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS passkey_users (
  account_email TEXT PRIMARY KEY REFERENCES accounts(email) ON DELETE CASCADE,
  user_handle   TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id              TEXT PRIMARY KEY,
  credential_id   TEXT NOT NULL UNIQUE,
  account_email   TEXT NOT NULL REFERENCES passkey_users(account_email) ON DELETE CASCADE,
  public_key      TEXT NOT NULL,
  sign_count      INTEGER NOT NULL,
  transports      TEXT NOT NULL,
  backup_eligible INTEGER NOT NULL,
  backup_state    INTEGER NOT NULL,
  rp_id           TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT
);
CREATE INDEX IF NOT EXISTS passkey_credentials_account ON passkey_credentials (account_email);
CREATE TABLE IF NOT EXISTS passkey_spent_challenges (
  challenge_hash TEXT PRIMARY KEY,
  expires_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS passkey_spent_challenges_expiry ON passkey_spent_challenges (expires_at);
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
docker run --name libredb-pg \
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
3. **Creates the tables**: `storage_meta`, `user_storage`, `accounts` and the three passkey tables, with the schema below, via `CREATE TABLE IF NOT EXISTS` on every start

The database itself must already exist. The **tables** are auto-created, but the **database** is not.

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
| `CREATE` on the schema | Every start runs `CREATE TABLE IF NOT EXISTS`, and PostgreSQL checks this privilege even when the table already exists |
| `REFERENCES` on `accounts` | The passkey tables' foreign keys, only while the app creates those tables itself |
| `SELECT`, `INSERT`, `UPDATE`, `DELETE` | Read and write the six tables; deleting an account or a passkey, and purging spent passkey challenges, delete rows. The credential re-seal also takes `LOCK TABLE ... IN EXCLUSIVE MODE` on `storage_meta`, `accounts` and `user_storage`, which `UPDATE` covers, and creates its backup tables with the `CREATE` above ([Re-sealing the store](#re-sealing-the-store)) |

The app user owns the tables it creates, which covers the data privileges on them.
A default PostgreSQL 17 `public` schema grants other roles no `CREATE`, so grant it explicitly (`GRANT CREATE ON SCHEMA public TO libredb_app;`) when the app user does not own the schema.
A missing privilege stops the start with an error that names the passkey tables, the privileges and the manual DDL below.
Measured on PostgreSQL 17.11; which earlier versions check `CREATE` the same way was not measured.

### A Named Schema (`STORAGE_POSTGRES_SCHEMA`)

By default the statements name the tables without a schema, so they land wherever the connection's `search_path` puts them, usually `public`.
Set `STORAGE_POSTGRES_SCHEMA` to keep them in one schema instead:

```bash
STORAGE_POSTGRES_SCHEMA=studio
```

With it set, every table, foreign key, index and existence check is written as `"studio".<name>`, so the tables never follow a `search_path` into another schema, and a role with no `CREATE` on `public` works.
Unset or empty, every statement is exactly what it was before the variable existed.

Studio never creates the schema.
Create it first, owned by the role in `STORAGE_POSTGRES_URL`, and that role then needs no other privilege on the database:

```sql
CREATE SCHEMA studio AUTHORIZATION libredb_studio;
```

When the schema is missing, the first storage request fails with `schema studio does not exist: create it with CREATE SCHEMA studio AUTHORIZATION <role>`, naming the role the connection runs as.
The value must be a lowercase identifier of up to 63 characters (`^[a-z_][a-z0-9_]{0,62}$`); with `STORAGE_PROVIDER=postgres`, any other value stops the boot with a banner that names the variable.
The [Manual Table Creation](#manual-table-creation-optional-1) DDL below applies once every table name in it, including those after `REFERENCES` and `ON`, carries the schema, as in `CREATE TABLE IF NOT EXISTS studio.user_storage (...)`.
`tests/live/storage-schema-postgres.ts` proves this on a real server, for a role that owns only schema `studio` and has no `CREATE` on `public`.

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
      # PostgreSQL 18+ images expect the mount at /var/lib/postgresql, not /var/lib/postgresql/data.
      # A pgdata volume from the old layout has to be removed once: run docker compose down, then
      # docker volume rm on the volume whose name ends in _pgdata (find it with docker volume ls).
      - pgdata:/var/lib/postgresql
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

# Cloud PostgreSQL, with the server certificate actually verified
STORAGE_POSTGRES_URL=postgresql://user:pass@your-pg-host:5432/your_db?sslmode=verify-system
```

> **`sslmode=require` here encrypts but does not verify** (`rejectUnauthorized: false`) — this pool
> has no channel for a CA certificate, so a verifying default would break every deployment whose
> storage database presents a self-signed certificate. `sslmode=verify-system` is the connection
> form's own mode name (`SSLMode` in [`src/lib/types.ts`](../src/lib/types.ts)), not a libpq one, and
> it is the one value this reader treats as "verify the chain against the runtime's trust store" —
> which is what a managed provider's publicly-signed certificate needs. Before D26 it fell through
> every branch and landed on the non-local default, `rejectUnauthorized: false`: the opposite of what
> it says.

### Verify

```bash
curl http://localhost:3000/api/storage/config
# → {"provider":"postgres","serverMode":true}
```

### Manual Table Creation (Optional)

The table is auto-created on first request. However, if you prefer to create it yourself — for example, in environments where the app user doesn't have `CREATE TABLE` privileges, or you want to track schema changes in version control:

```sql
-- PostgreSQL
-- Facts about the store itself, such as its credential envelope state.
CREATE TABLE IF NOT EXISTS storage_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_storage (
  user_id    TEXT NOT NULL,
  collection TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, collection)
);

-- Optional: index for faster lookups by user
CREATE INDEX IF NOT EXISTS idx_user_storage_user_id ON user_storage (user_id);

CREATE TABLE IF NOT EXISTS accounts (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,
  totp_secret   TEXT,
  totp_pending  TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Passkeys (#785). Create these before an image with passkey sign-in starts.
CREATE TABLE IF NOT EXISTS passkey_users (
  account_email TEXT PRIMARY KEY REFERENCES accounts(email) ON DELETE CASCADE,
  user_handle   TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id              TEXT PRIMARY KEY,
  credential_id   TEXT NOT NULL UNIQUE,
  account_email   TEXT NOT NULL REFERENCES passkey_users(account_email) ON DELETE CASCADE,
  public_key      TEXT NOT NULL,
  sign_count      BIGINT NOT NULL,
  transports      TEXT NOT NULL,
  backup_eligible INTEGER NOT NULL,
  backup_state    INTEGER NOT NULL,
  rp_id           TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT
);
CREATE INDEX IF NOT EXISTS passkey_credentials_account ON passkey_credentials (account_email);
CREATE TABLE IF NOT EXISTS passkey_spent_challenges (
  challenge_hash TEXT PRIMARY KEY,
  expires_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS passkey_spent_challenges_expiry ON passkey_spent_challenges (expires_at);
```

#### Minimal Privileges (When Table Already Exists)

If a DBA creates all six tables, the app user needs no `REFERENCES`, but it still needs `CREATE` on the schema, because every start runs `CREATE TABLE IF NOT EXISTS` and PostgreSQL checks that privilege even for a table that exists:

```sql
GRANT CREATE ON SCHEMA public TO libredb_app;
-- DELETE: removing an account removes its user_storage rows in the same transaction,
-- and passkey removals and the purge of spent challenges delete rows too.
GRANT SELECT, INSERT, UPDATE, DELETE ON storage_meta TO libredb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_storage TO libredb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts TO libredb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON passkey_users TO libredb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON passkey_credentials TO libredb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON passkey_spent_challenges TO libredb_app;
```

The earlier claim that data grants alone suffice does not hold where the schema gives the app user no `CREATE`, as on a default PostgreSQL 17.
The app user need not own the tables: Studio creates a passkey index only when it is missing, because PostgreSQL checks ownership before it honours `IF NOT EXISTS` on `CREATE INDEX`, so the DBA creates both passkey indexes with the tables.
A start that needs no `CREATE` at all is `docs/BACKLOG.md` PK9.

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
> From then on the browser copy belongs to that account (`libredb_workspace_owner`), and a different account signing in on the same browser starts from its own server data.

For the full migration lifecycle and the underlying merge semantics, see [Migration Flow](#10-migration-flow) in Part 2.

---

## Connections whose type this Studio has no provider for

A stored connection can carry a `type` that names no provider this Studio has, no `type` at all, or a type that is not text.
It happens when a newer Studio that shares the same server storage saved a connection of an engine this one does not ship, or when a record was written by hand or by another tool.

Studio keeps such a record in the browser copy and in server storage alike, and never rewrites its `type` or any other field it was saved with.
The one exception is `createdAt`: like every stored connection's, it is normalised to an ISO date, or to `null` when it does not parse as a date, the next time the list is saved.
Whether a connection is available is decided each time it is listed, from its `type`, and never written into the record, so a later save of another connection cannot change it.

The sidebar, the mobile connections list, the mobile header menu and the command palette show it with an **Unavailable** marker whose tooltip gives the reason, such as `No provider for the connection type "acmefoo" is installed in this LibreDB Studio.`
The admin overview's fleet card draws it with the unavailable icon and the same marker, and shows the server's refusal as the item's error.
The monitoring dashboard, the admin Operations tab and the schema diff's list of connections to fetch from show it with the same marker.
It cannot be opened: a pick of it from any list that marks it is refused by name, and nothing is sent to the server.
The editor's four lists, the monitoring dashboard and the Operations tab raise a **Connection unavailable** notice that names the connection and the reason; the schema diff says on its own line that nothing was fetched from it, and why.
A `?connection=` link that names it, or the connection the browser had open last time naming it, is refused with the same **Connection unavailable** notice, and the active connection stays as it was or falls to the first available one, if there is one.
Studio never makes it the active connection by itself, at sign-in, on a reload or when another connection is deleted.
The monitoring dashboard and the Operations tab never open on it by themselves either: they open on the connection the editor had open last while a provider can open it, otherwise on the first one a provider can open, or on none.
When the connection the editor had open last is listed with such a type, they say so with the same **Connection unavailable** notice as they open.
The connection either page shows, whether the reader chose it or the page opened on it, stays shown when a later refresh lists it with such a type: the selector draws it with the marker, and the page draws the reason in place of its sections, so nothing read from it before is shown as current.
A connection that leaves the list is replaced on the Operations tab, by the one it would open on.
On the monitoring dashboard, a connection the reader chose that leaves the list leaves the page with no connection selected, and one it opened on is replaced by the one it would open on.
It cannot be edited or duplicated, because the connection dialog has no form for an engine this Studio does not have; it can be deleted, favourited, grouped and reordered like any other.
A Studio that has the provider lists and opens the same record as usual.

The API answers a request that sends such a connection with `400 PROVIDER_UNKNOWN` and the same sentence, before any provider is built or any SSH tunnel opened (see [API_DOCS.md](./API_DOCS.md#post-apidbquery)).

An operator's seed entry whose type names no provider is listed and shown the same way, with the lock a managed connection gets and no Delete, as [SEED_CONNECTIONS.md](./SEED_CONNECTIONS.md#a-connection-whose-type-this-studio-has-no-provider-for) describes.

In the npm package, the embedded `StudioWorkspace` lists a host connection whose `type` names no provider in that version of the package, has none, or is not text, with the same **Unavailable** marker, and never opens it by itself: it opens on the first connection a provider can open, or on none.
A pick of it is refused with the same **Connection unavailable** notice, drawn on a line at the top of the workspace, since the embedded shell shows no toasts, and the workspace keeps its connection.
The line about a pick is withdrawn when the host lists that connection under a type a provider can open, or drops it.
When the host's list gives the open connection such a type, the workspace closes it, opens no other connection in its place, and says why on the same line, in place of a line about an earlier pick; it opens the same connection again, and withdraws the line, when the host gives the type back.
Otherwise, when no connection is open and the host's list holds one of these connections, the line names the first of them, so the reason is drawn below the mobile breakpoint too, where the workspace draws no sidebar and no marker.
Below the mobile breakpoint the workspace draws no connection picker, so after a retype of the open connection the reader cannot open another listed connection there: a host that wants the workspace to move on drops the retyped connection from its list, and the workspace then opens the first connection a provider can open.
While no connection is open, RUN is disabled and Save is not offered.
A statement confirmed in the safety dialog runs only on the connection it was confirmed for: when the host's list has closed or replaced that connection by the time Proceed is pressed, nothing is run and the tab says why.
A Save Query dialog saves the text it was opened on, under the type of the connection it was opened for.
An import run while no connection is open imports nothing, and the import dialog stays open and says why.
A statement the Test Data dialog sends while no connection is open is not run, and the tab says why.
The published `ConnectionModal`, handed such a connection to edit, shows the same notice in place of its form when it opens and offers only Close, so nothing is tested or saved under another type.
Handed such a connection while closed, it draws nothing and does not fail.
The published `QuerySafetyDialog` and `TestDataGenerator` take the connection's type as a plain `databaseType` string.
Handed one that names no provider in that version of the package, an empty string, `null`, or a value that is not text, they draw the same **Connection unavailable** notice in place of the safety analysis or the generated statement: the safety dialog sends nothing to be analysed and keeps Execute disabled, and the test data dialog offers neither Copy nor Execute.
Without a `databaseType` the safety dialog reads the statement as it does with no connection open, and so does the test data dialog when it is handed no `capabilities` either.
The published `QueryEditor` and `ResultsGrid` type `databaseType` as one of the package's type ids, and handed any other value they throw an error named `UnknownProviderError`, with the same sentence, while they render, before they read anything with it, so the host's error boundary receives it.
An SQL engine's identifier quoting and the forms the test data dialog and editor completion write follow the connection's type, never the port its declaration names, so a declaration alone cannot say how to write for its engine.
So `TestDataGenerator` and `QueryEditor` handed a connection's `capabilities` without its `databaseType` refuse it the same way, the dialog with the notice and the editor with `UnknownProviderError`, with a sentence that says the call needs the connection's type.
With neither, the editor reads as it does with no connection open.

## Saved queries whose type this Studio has no provider for

A saved query keeps the type of the connection it was saved from, in its `connectionType`.
One saved by a newer Studio that shares the same server storage can name a type this Studio has no provider for, and a record written by hand or by another tool can name none, or one that is not text.

Studio keeps such a query as saved, in the browser copy and in server storage alike, and **Export all** writes it like any other.
The Saved tab lists the queries of the active connection's type, so it lists such a query only while no connection is active, which Studio reaches only when no listed connection can be opened.
The command palette lists the first ten saved queries, so it lists such a query only when it is among them.
Both show it with an **Unavailable** marker whose tooltip gives the reason.

It is never loaded into the editor.
The Saved tab offers no way to open or edit it, and where it lists it, it can be deleted like any other query.
A pick of it in the command palette is refused with a **Saved query unavailable** notice that names it and gives the reason.

**Import JSON** checks every entry of a backup before it saves anything.
An entry whose `connectionType` names no provider this Studio has, or is missing, empty or not text, is not imported, so a file **Export all** wrote from a store that holds such a query imports the rest.
The Saved tab then shows a line under its buttons that names each such entry with the reason, in the standalone app and in the embedded `StudioWorkspace` alike, until it is dismissed, the next import starts or the Saved tab is left, and the backup's other entries are imported as usual.
An entry with any other field that is not valid refuses the whole backup.
Release 1.3.0 refused the whole backup for such an entry.

---

## Credential Encryption at Rest

In `sqlite` and `postgres` modes, credentials are encrypted before they are written. There is
nothing to switch on and nothing to configure.

### What is encrypted

Eleven fields on a saved connection, and an account's two second-factor fields (`src/lib/storage/secret-fields.ts` is the authority for the connection fields):

| Field | What it is |
|-------|------------|
| `password` | The database password, or the token an engine takes in its place (a Snowflake programmatic access token among them) |
| `connectionString` | A URL that can embed `user:password@` |
| `agentPassword` | The optional least-privilege agent-profile password (#328) |
| `apiKeyId`, `apiKeySecret` | Elasticsearch's API key pair |
| `privateKey` | Snowflake's key-pair private key, as pasted |
| `privateKeyPassphrase` | The passphrase that unlocks the key above |
| `ssl.clientKey` | The TLS client private key |
| `sshTunnel.password` | The SSH password |
| `sshTunnel.privateKey` | The SSH private key |
| `sshTunnel.passphrase` | The passphrase that unlocks the key above |
| `accounts.totp_secret`, `accounts.totp_pending` | An account's confirmed TOTP secret, and an enrolment not yet confirmed |

Everything else stays readable, deliberately: `host`, `port`, `user`, `agentUser`, `database`,
`name` and the TLS certificates (`ssl.caCert`, `ssl.clientCert` — certificates are public by
construction). An
operator holding a dump has to be able to answer "which of my databases is in here"; that is
incident response, not a leak. No other collection is touched — `history` and `saved_queries` hold
SQL text, which is the product's data rather than its secrets.

Each value is stored as `v2:<iv>:<ciphertext>` using AES-256-GCM with a fresh random IV, so two
identical passwords do not look identical in the store, and a tampered value is detected rather
than silently decrypting to something else.
The previous release wrote `v1:<iv>:<ciphertext>`; this one reads that form until the store is re-sealed ([Re-sealing the store](#re-sealing-the-store)) and never writes it.

### Where a sealed value opens

Each sealed value opens only in the place it was sealed for: the row owner, the connection (or the account), the field, and the connection's identity fields.
Anywhere else it is omitted and named in the server log, exactly as a value the key cannot open is, and it is never returned raw.

The place is the value's AES-256-GCM additional authenticated data: the UTF-8 of the RFC 8785 canonical JSON of `{d, f, o, r, s, t}` (`src/lib/storage/envelope-binding.ts`):

| Member | Value |
|--------|-------|
| `s` | `"v2"`, the envelope format |
| `t` | `"connections"` or `"accounts"`, where the value is stored |
| `o` | The owner: the `user_id` of the `user_storage` row for a connection, the account's email for a factor |
| `r` | The record: the connection's `id` as the store holds it (`null` when absent), the account's email for a factor |
| `f` | The field path: `password`, `connectionString`, `privateKey`, `privateKeyPassphrase`, `agentPassword`, `apiKeyId`, `apiKeySecret`, `ssl.clientKey`, `sshTunnel.password`, `sshTunnel.privateKey`, `sshTunnel.passphrase`, `totpSecret` or `totpPending` |
| `d` | The unpadded base64url SHA-256 of the UTF-8 canonical JSON of the connection's identity fields as the store holds them; for an account, of `{}` |

The identity fields are the readable fields `src/lib/storage/secret-fields.ts` classifies `identity`: the ones that decide where a connection's credentials are sent, as whom they authenticate, and how safely they travel.
There are thirty:

| Where | Identity fields |
|-------|-----------------|
| The connection | `type`, `host`, `port`, `user`, `database`, `serviceName`, `instanceName`, `authSource`, `saslMechanism`, `allowInsecureAuth`, `dataServers`, `apiPath`, `tlsServerName`, `amqpPort`, `securityMode`, `securityPolicyUri`, `serverCertificateThumbprint`, `hostKeyFingerprint`, `clientCertificatePath`, `clientPrivateKeyPath`, `agentUser` |
| `ssl` | `mode`, `rejectUnauthorized`, `caCert`, `clientCert` |
| `sshTunnel` | `enabled`, `host`, `port`, `username`, `hostKeyFingerprint` |

A change to an identity field made in Studio seals the connection's credentials again, because the browser sends them with the edit (see [Paths that change an identity field](#paths-that-change-an-identity-field)).
A change made outside Studio leaves the sealed values bound to the old fields, so they read as omitted until the user enters them again.

The identity set is part of the `v2` format.
A field added later as identity changes nothing stored, because records written before it do not carry it.
Moving an existing field into or out of the set would change the digest of every record that carries it, so it is a new envelope version with its own re-seal, never an edit.

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
- A warning is written to the server log once per read, naming each omitted value by its
  connection id, its field and the reason: `Stored connection secrets could not be decrypted: N
  field(s) were omitted: <id> <field> (unopenable), ...`, followed by what to do.
- Nothing is deleted from the database by the read itself.

To recover, restore the previous key and restart, **before** using the app. Reads happen on page
load; the first time the app writes that collection back, the omitted values are gone for good,
because the browser copy is the source the server is updated from. If you cannot restore the key,
re-enter the affected passwords once and they are re-encrypted under the current key.

### Existing deployments migrate themselves

Until the store is re-sealed, reads accept version 1 envelopes and values stored before encryption existed, and every write produces a `v2` envelope for the record as written.
An existing store therefore moves to `v2` as it is used, with no downtime.
A value that is never written again keeps its old form until the operator re-seal converts it.
While the store still accepts version 1, each server logs one warning at its first use of the store that names the state and the command below.

### Re-sealing the store

Set `STORAGE_ENCRYPTION_RESEAL=true` (also `1` or `on`, in any letter case) on every server once every server runs this version, and restart them.
At its start, before it serves, the first server:

1. Takes the store's write lock for one transaction.
2. Writes a complete backup of the store as it is.
3. Seals every version 1 envelope and every unsealed value as `v2` for the place it is stored in, keeps every `v2` value that already opens there, and leaves a value that opens nowhere exactly as it is, naming it in the log.
4. Records in `storage_meta` (`credential_envelope = v2`) that version 1 is retired, and commits.

From then on a version 1 or unsealed value is refused by name, as `retired`, and omitted like any value that does not open.
Every other server that starts while the first holds the lock waits for it, finds the store retired, and logs that nothing was read, written or backed up.
Remove `STORAGE_ENCRYPTION_RESEAL` afterwards; a store that is already retired is never read, written or backed up again, but the variable has no further use.

The backup:

| Provider | Backup | Where |
|----------|--------|-------|
| `sqlite` | `VACUUM INTO` a standalone database file, taken on a second connection under the re-seal's write lock | `<STORAGE_SQLITE_PATH>.pre-reseal-<UTC yyyymmddThhmmssZ>`, beside the store file |
| `postgres` | `CREATE TABLE <table>_pre_reseal_<stamp> AS TABLE <table>` for all six store tables, inside the re-seal transaction | In the store's own schema (`STORAGE_POSTGRES_SCHEMA` when set), for example `user_storage_pre_reseal_20261122t053000z` |

The start refuses, with a banner and exit status 1, when:

- the value is anything other than `true`, `1`, `on`, `false`, `0`, `off` or empty, because a requested re-seal that cannot be read must not be skipped;
- `STORAGE_PROVIDER` is `local`, which has no server store;
- the backup cannot be written (a target that already exists, a directory the process cannot write, or an in-memory SQLite store);
- anything else fails during the re-seal.

A refused or failed run leaves the store exactly as it was, and version 1 still accepted.

The log lines, at warning level:

```
STORAGE_ENCRYPTION_RESEAL: backed up the store to <backup>, re-sealed N value(s) and kept M already sealed for their place; version 1 is retired.
STORAGE_ENCRYPTION_RESEAL: left N value(s) as they were, because they open nowhere here: <owner> <connection id> <field>, ...
STORAGE_ENCRYPTION_RESEAL: left N row(s) or element(s) unread, because they are not connections: <owner> connections, ...
STORAGE_ENCRYPTION_RESEAL: remove it now; every start re-checks the store while it is set.
```

The second and third lines appear only when they have something to name.

How to set it:

| Channel | Where |
|---------|-------|
| Docker, Docker Compose | `-e STORAGE_ENCRYPTION_RESEAL=true`, or the service's `environment` |
| `npx @libredb/studio`, packages | The environment of the process |
| Helm chart | `extraEnv`, for example `--set 'extraEnv[0].name=STORAGE_ENCRYPTION_RESEAL' --set-string 'extraEnv[0].value=true'`; no chart change is needed |

### Upgrading to envelope v2

In this order:

1. Back up the store as usual.
   This version writes `v2` from its first save, which an older version cannot read.
2. Upgrade every server.
3. Once no older server runs, set `STORAGE_ENCRYPTION_RESEAL=true` on every server and restart them.
   The first start backs up, re-seals and retires version 1; the others wait on the lock and find nothing to do.
4. Remove `STORAGE_ENCRYPTION_RESEAL`.
5. Keep the re-seal's backup until a downgrade is out of the question, then delete it: the file, or `DROP TABLE` each `*_pre_reseal_*` table.
   It holds version 1 values.

The chart's SQLite deployment runs one replica and stops the old pod before the new one starts, so the two versions never serve one store together.
PostgreSQL deployments with several replicas roll pods one by one, so for a while both versions serve the same store:

- A new server reads version 1 and unsealed values, and writes `v2`.
- An old server omits a `v2` value as undecryptable, with its key-rotation warning.
  A browser that loaded its connections from an old server and then saves a connection drops that value for good.
- An account that a new server wrote cannot finish a TOTP sign-in on an old server, and an account change an old server makes in that window writes an unusable factor back, which an admin clears.

To avoid that window, stop the old servers before new ones serve, for example `kubectl scale deployment <name> --replicas=0`, upgrade, then scale back.

A process reads the store's envelope state once, at its first use of the store.
A server that started before another one re-sealed keeps accepting version 1 until it restarts, which is why step 3 restarts every server.

#### Downgrading

Every value this version wrote, through any save, any account change or the re-seal, is unreadable to an older version: the field is omitted and the next save drops it, and an account with a second factor is locked until an admin clears it (the environment admin through `ADMIN_PASSWORD_RESET`).
To downgrade, stop every server, restore the re-seal's backup, and start the older version.
Every change made after the backup is lost.

- SQLite: put the backup file in place of the store file, or point `STORAGE_SQLITE_PATH` at it.
- PostgreSQL: run, with `<stamp>` the backup's suffix and every name schema-qualified when `STORAGE_POSTGRES_SCHEMA` is set:

```sql
BEGIN;
DELETE FROM user_storage;
INSERT INTO user_storage SELECT * FROM user_storage_pre_reseal_<stamp>;
UPDATE accounts AS a SET totp_secret = b.totp_secret, totp_pending = b.totp_pending
  FROM accounts_pre_reseal_<stamp> AS b WHERE a.email = b.email;
DELETE FROM storage_meta WHERE key = 'credential_envelope';
COMMIT;
```

Restoring a full snapshot taken before the re-seal also restores "version 1 accepted", so run the re-seal again after upgrading.

#### An interrupted re-seal

The re-seal is one transaction.
An error, a lost database connection or a killed process leaves every row as it was and version 1 accepted, and the start stops with the reason.
A SQLite run that stopped after its backup leaves that file, a copy of the unchanged store; delete it or keep it.
Fix the cause and start again.
On PostgreSQL the re-seal blocks writes, not reads, for its duration; a start probe that kills a very slow re-seal makes it roll back and run again at the next start, so for a very large store run the first re-sealing start with one replica or a longer start probe.

### Paths that change an identity field

| Path | Seals again | Why |
|------|-------------|-----|
| `PUT /api/storage/connections`: the connection dialog's save and edit, duplicate, import, client-side migrations, editable seed copies | Yes | The browser holds the plaintext `GET /api/storage` returned and sends whole records; each value is sealed for the record as written |
| `POST /api/storage/migrate` | Yes | The same, for a whole localStorage dump |
| The re-seal | Yes | Each value is sealed for the record as stored |
| Account insert and update | Yes | Each factor is sealed for the account's email; an account's email never changes |
| Server code that edits stored connections | None exists | Such code must seal again from the plaintext it opened (`src/lib/storage/secret-fields.ts` says so) |
| Edits outside Studio: SQL, a file edit, a partial restore | No, by design | The value is omitted and named until the user enters it again |
| Turning governance or OpenShift sign-in on or off, an OIDC email change without governance | Not applicable | Rows are not moved between owners; the user starts over under the new owner key, and the old rows stay bound to the old one ([Governance Mode](#governance-mode)) |
| A browser holding a record without its secret, because it was omitted on read, saves an edit | Nothing to seal | The omitted value is lost on that write, as an undecryptable one is |
| A server of an older version during a mixed rollout | No, it writes version 1 | Accepted until the re-seal retires version 1; the upgrade order above prevents it |

### What this does not protect

- **Browser `localStorage` is not encrypted.** It is the rendering source and it holds the same
  credentials in the clear. That is a deliberate product decision — it is what lets Studio work
  without a master password — and it is why cross-site scripting is treated as a top-severity
  issue in this project rather than a session-theft issue. It applies to every field above alike:
  a Snowflake private key and its passphrase sit in the same connection object, so for anyone who
  can read this browser's storage an encrypted key is no better protected than an unencrypted one,
  exactly as an SSH key and its passphrase are. The connection dialog does not draw a saved key
  again (it shows that one is entered, with Show key and Replace key), which keeps it off a screen
  share; it does not change what the browser stores.
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
- **Readable fields are neither sealed nor authenticated.** The binding protects the sealed values:
  a change to an identity field outside Studio makes that connection's sealed values unreadable
  rather than sending them on, but it does not make `host`, `name` or any other readable field
  tamper-proof.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STORAGE_PROVIDER` | No | `local` | `local`, `sqlite`, or `postgres` |
| `STORAGE_SQLITE_PATH` | No | `./data/libredb-storage.db` | Path to SQLite file. Directory and file are auto-created. |
| `STORAGE_POSTGRES_URL` | **Yes** (postgres mode) | — | PostgreSQL connection string. **No default — app will error without it.** |
| `STORAGE_POSTGRES_SCHEMA` | No | unset | Schema that holds the storage tables, such as `studio`. The schema must exist. Unset keeps the tables unqualified. See [A Named Schema](#a-named-schema-storage_postgres_schema). |
| `STORAGE_ENCRYPTION_RESEAL` | No | unset | `true`, `1` or `on` re-seals every stored credential at start, after a complete backup, and retires version 1 envelopes. Set it once, restart, remove it. See [Re-sealing the store](#re-sealing-the-store). |

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

### Store Outage: 503 "ACCOUNT_STORE_UNAVAILABLE"

When `STORAGE_PROVIDER=sqlite` or `postgres`, each authenticated request checks that the session's account remains active and permitted in the account store. If the store suffers an outage (e.g. PostgreSQL is unreachable or SQLite is locked):

- **Three surfaces answer 503** — they call `readSession()` and return `{ "error": "Account store unavailable", "code": "ACCOUNT_STORE_UNAVAILABLE" }` with no permission-denial audit and without touching the cookie:
  1. `guardRoute` (`src/lib/api/require-session.ts`) — protects all database, query, admin, and AI routes.
  2. `GET /api/auth/me` (`src/app/api/auth/me/route.ts`) — the browser polls this to establish session state.
  3. `/api/mcp` (`src/app/api/mcp/route.ts` via `mcpTokenOwnerAllowed`) — the MCP bearer-token route.

- **Other routes that call `getSession()` directly** still receive `null` under its non-throwing contract and answer `401`. These are routes that bypass `guardRoute` and check the session themselves (e.g. `GET /api/connections/managed`, which the editor calls on load).

- The browser's session cookie is **preserved** throughout. Verified with a valid cookie against a mocked storage outage: the browser did not loop to `/login` because `/api/auth/me` answered 503, not 401, so the client-side `AUTH_REQUIRED` redirect guard did not fire (#1942).

- Once the store recovers, client requests resume immediately without requiring the user to sign in again.

### SQLite: "SQLITE_CANTOPEN"

- The directory in `STORAGE_SQLITE_PATH` must be writable by the app process
- In Docker, make sure the volume is mounted correctly

### PostgreSQL: "STORAGE_POSTGRES_URL is required"

- You set `STORAGE_PROVIDER=postgres` but didn't provide `STORAGE_POSTGRES_URL`
- Unlike SQLite, PostgreSQL has **no default** — a connection string is always required
- Fix: add `STORAGE_POSTGRES_URL=postgresql://user:pass@host:5432/dbname` to your env

### PostgreSQL: "schema studio does not exist"

- `STORAGE_POSTGRES_SCHEMA` names a schema the database does not have, and Studio never creates one
- Fix: run the `CREATE SCHEMA ... AUTHORIZATION ...` statement the message prints, as a role allowed to create schemas

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
Stored connection secrets could not be decrypted: 3 field(s) were omitted: c1 password (unopenable), c1 sshTunnel.password (unopenable), c2 password (unopenable). ...
```

The line names each omitted value by its connection id, its field and the reason.
For `unopenable`, the encryption key changed, or the value is not stored in the place it was sealed for (see [Where a sealed value opens](#where-a-sealed-value-opens)).
For `retired`, see the next entry.

The encryption key changes when `JWT_SECRET` is rotated (and `STORAGE_ENCRYPTION_KEY` is not
set), when `STORAGE_ENCRYPTION_KEY` itself changes, or when the data directory holding
`auth-bootstrap.json` was not persisted so a fresh `JWT_SECRET` was generated on start.

Restore the previous key and restart **before** using the app — see
[Rotating a key invalidates stored credentials](#rotating-a-key-invalidates-stored-credentials).
If the key is gone, re-enter the affected passwords; everything else about the connection is intact.

### "Values refused as retired after the re-seal"

The warning line names a value with the reason `retired`, or an account's second factor stops working with `(retired)` in the log.
The value is a version 1 envelope or an unsealed value, which the store refuses since `STORAGE_ENCRYPTION_RESEAL` retired version 1.
It was written after the re-seal, by a server of an older version or by an edit outside Studio.
Stop every older server, then re-enter the affected credentials; an admin clears an affected second factor.

### "Duplicate data after migration"

- Migration runs once per browser (guarded by the `libredb_server_migrated` flag) and replaces each collection wholesale, so duplicates shouldn't occur
- If you do see them, check whether the same user pushed data from multiple browsers before the first migration completed

---

## Database Schema Reference

Both SQLite and PostgreSQL use the same six tables. They are auto-created on first request, but the full DDL is provided here for reference. `storage_meta` holds facts about the store itself. `user_storage` holds each person's product data. `accounts` holds local email/password identities when the server store is on. `passkey_users`, `passkey_credentials` and `passkey_spent_challenges` hold passkeys ([PASSKEYS.md](./PASSKEYS.md)).

### SQLite

```sql
CREATE TABLE IF NOT EXISTS storage_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_storage (
  user_id    TEXT NOT NULL,
  collection TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, collection)
);

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS accounts (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,
  totp_secret   TEXT,
  totp_pending  TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS passkey_users (
  account_email TEXT PRIMARY KEY REFERENCES accounts(email) ON DELETE CASCADE,
  user_handle   TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id              TEXT PRIMARY KEY,
  credential_id   TEXT NOT NULL UNIQUE,
  account_email   TEXT NOT NULL REFERENCES passkey_users(account_email) ON DELETE CASCADE,
  public_key      TEXT NOT NULL,
  sign_count      INTEGER NOT NULL,
  transports      TEXT NOT NULL,
  backup_eligible INTEGER NOT NULL,
  backup_state    INTEGER NOT NULL,
  rp_id           TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT
);
CREATE INDEX IF NOT EXISTS passkey_credentials_account ON passkey_credentials (account_email);
CREATE TABLE IF NOT EXISTS passkey_spent_challenges (
  challenge_hash TEXT PRIMARY KEY,
  expires_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS passkey_spent_challenges_expiry ON passkey_spent_challenges (expires_at);
```

### PostgreSQL

```sql
CREATE TABLE IF NOT EXISTS storage_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_storage (
  user_id    TEXT NOT NULL,
  collection TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, collection)
);

-- Optional: index for faster lookups by user
CREATE INDEX IF NOT EXISTS idx_user_storage_user_id ON user_storage (user_id);

CREATE TABLE IF NOT EXISTS accounts (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,
  totp_secret   TEXT,
  totp_pending  TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passkey_users (
  account_email TEXT PRIMARY KEY REFERENCES accounts(email) ON DELETE CASCADE,
  user_handle   TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id              TEXT PRIMARY KEY,
  credential_id   TEXT NOT NULL UNIQUE,
  account_email   TEXT NOT NULL REFERENCES passkey_users(account_email) ON DELETE CASCADE,
  public_key      TEXT NOT NULL,
  sign_count      BIGINT NOT NULL,
  transports      TEXT NOT NULL,
  backup_eligible INTEGER NOT NULL,
  backup_state    INTEGER NOT NULL,
  rp_id           TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT
);
CREATE INDEX IF NOT EXISTS passkey_credentials_account ON passkey_credentials (account_email);
CREATE TABLE IF NOT EXISTS passkey_spent_challenges (
  challenge_hash TEXT PRIMARY KEY,
  expires_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS passkey_spent_challenges_expiry ON passkey_spent_challenges (expires_at);
```

### Schema Explanation

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | TEXT | User's email from JWT token (e.g., `admin@libredb.org`), or under governance `sub:` followed by the identity provider's subject ([Governance Mode](#governance-mode)) |
| `collection` | TEXT | Data category: `connections`, `history`, `saved_queries`, `schema_snapshots`, `saved_charts`, `active_connection_id`, `audit_log`, `masking_config`, `threshold_config`, `dismissed_seeds`, `favorite_connections`, `connection_order`, `connection_groups` |
| `data` | TEXT | JSON-serialized collection data |
| `updated_at` | TEXT / TIMESTAMPTZ | Last modification timestamp |

Each row stores **one user's one collection** as a JSON blob. Adding a new collection type requires no schema changes — just a new row.

`storage_meta` holds one row per fact about the store itself:

| `key` | `value` | Meaning |
|-------|---------|---------|
| `credential_envelope` | `v2` | The credential re-seal retired version 1 envelopes ([Re-sealing the store](#re-sealing-the-store)); no row means version 1 is still accepted, and any other value stops the start, as a store written by a newer version |

The passkey tables:

| Column | Meaning |
|--------|---------|
| `passkey_users.user_handle` | The account's WebAuthn user handle: 64 random bytes, base64url, never derived from the email |
| `passkey_credentials.id` | Internal UUID; the only passkey identifier the UI, the API and the audit log carry |
| `passkey_credentials.credential_id` | The WebAuthn credential ID, unique across all accounts; never in a passkey list, a URL or the audit log |
| `passkey_credentials.public_key` | The base64url COSE public key |
| `passkey_credentials.sign_count` | The last signature counter; `BIGINT` on PostgreSQL because WebAuthn counters are unsigned 32-bit |
| `passkey_credentials.transports` | JSON array of transport hints (`ble`, `cable`, `hybrid`, `internal`, `nfc`, `smart-card`, `usb`) |
| `passkey_credentials.backup_eligible`, `backup_state` | 0 or 1: whether the passkey can sync, and whether it has |
| `passkey_credentials.rp_id` | The host name the passkey was registered under |
| `passkey_spent_challenges.challenge_hash`, `expires_at` | Lowercase hex SHA-256 of a challenge that completed a ceremony, and its token's expiry |

Timestamps are ISO-8601 `TEXT` on both engines, as on `accounts`, so rows copy between engines unchanged.
None of these columns is secret, so they are not sealed with the storage encryption key.

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

All application state is organized into **13 collections**, each stored as a JSON blob:

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
| `favorite_connections` | `string[]` | Connection ids the user has starred | — |
| `connection_order` | `string[]` | Connection ids in the user's custom drag order | — |
| `connection_groups` | `ConnectionGroup[]` | The user's own sections in the Connections panel, in display order: `{ id, name, collapsed, connectionIds }` | — |

**A snapshot taken before the object model has no kind and no path.** `schema_snapshots` holds what
the schema list held when the snapshot was taken, and a live reading now always carries an object's
kind and its full address; a record written by an older version carries the name and the columns
only. Those records are kept and stay comparable rather than being migrated or discarded, so the
diff matches an old snapshot to a new reading BY NAME, and a diff against one cannot tell a view
from a table or two same-named objects in different schemas apart. Take a fresh snapshot to get a
baseline that carries both. Nothing is lost either way: a stored snapshot is the user's own data and
this product does not rewrite it in place.

### 3.2 Server Database Schema

Both SQLite and PostgreSQL use the same logical schema — `user_storage` holds collection-based JSON blobs, and `accounts` holds the local identity registry:

```sql
CREATE TABLE IF NOT EXISTS storage_meta (
  key        TEXT PRIMARY KEY,              -- 'credential_envelope'
  value      TEXT NOT NULL,                 -- 'v2' once the re-seal retired version 1
  updated_at TEXT/TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS user_storage (
  user_id    TEXT        NOT NULL,          -- JWT username (email)
  collection TEXT        NOT NULL,          -- 'connections', 'history', etc.
  data       TEXT        NOT NULL,          -- JSON serialized
  updated_at TEXT/TIMESTAMPTZ NOT NULL,     -- Last modification time
  PRIMARY KEY (user_id, collection)
);

CREATE TABLE IF NOT EXISTS accounts (
  email         TEXT PRIMARY KEY,  -- local login email; also the user_storage user_id
  password_hash TEXT NOT NULL,     -- scrypt encoding, never the password; for an account a launch created,
                                   --   launch-identity$<iss>$<sub> (base64url), which no password matches (LAUNCH.md)
  role          TEXT NOT NULL,     -- 'admin' or 'user'
  totp_secret   TEXT,              -- confirmed TOTP secret, sealed for this account like a connection password, or NULL
  totp_pending  TEXT,              -- enrolment not yet confirmed, sealed; login ignores it
  disabled      INTEGER NOT NULL,  -- 1 rejects login and keeps this user's rows
  session_version INTEGER NOT NULL, -- signed into each session; a change ends older sessions
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passkey_users (        -- one row per account with a passkey
  account_email TEXT PRIMARY KEY,                 -- REFERENCES accounts ON DELETE CASCADE
  user_handle   TEXT NOT NULL UNIQUE,             -- random WebAuthn user handle
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passkey_credentials (  -- one row per passkey
  id            TEXT PRIMARY KEY,                 -- internal id, the only one clients see
  credential_id TEXT NOT NULL UNIQUE,             -- WebAuthn credential ID
  account_email TEXT NOT NULL,                    -- REFERENCES passkey_users ON DELETE CASCADE
  ...                                             -- public key, counter, flags, rp_id, name, dates
);

CREATE TABLE IF NOT EXISTS passkey_spent_challenges ( -- challenges of successful ceremonies
  challenge_hash TEXT PRIMARY KEY,
  expires_at     TEXT NOT NULL                    -- purged 600 seconds after this
);
```

`user_storage` is intentionally simple:
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
favorite_connections → libredb_favorite_connections
connection_order  → libredb_connection_order
connection_groups → libredb_connection_groups
```

---

## 4. Module Structure

```
src/lib/storage/
├── index.ts              # Barrel export — preserves @/lib/storage import path
├── types.ts              # StorageData, StorageCollection, ServerStorageProvider, PasskeyStore
├── local-storage.ts      # Pure localStorage CRUD (SSR-safe)
├── storage-facade.ts     # Public storage object with domain methods
├── provider-type.ts      # getStorageProviderType(), import-free so the proxy can read it
├── factory.ts            # Env-based provider instantiation (singleton)
├── owner-key.ts          # storageOwnerKey(): the user_id a session's rows are filed under
├── passkey-row.ts        # passkey_credentials row to StoredPasskey, refusing a malformed row
├── secret-fields.ts      # Which connection fields are secret or identity, and the one walk over them
├── encryption.ts         # The key, and sealSecret / openSecret / readStoredSecret under a binding
├── envelope-binding.ts   # Where a v2 envelope opens: owner, record, field and identity digest
├── envelope-claim.ts     # isEnvelopeClaim(): the version-tag shape rule, import-free
├── connection-secrets.ts # Seals, opens and re-seals a connection list for its owner
├── encrypting-provider.ts # withCredentialEncryption(): the decorator the factory installs
├── reseal.ts             # resealStore(): the operator re-seal's rule for each stored value
├── reseal-at-boot.ts     # STORAGE_ENCRYPTION_RESEAL, read by register() at start
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
| **Connections** | `getConnections()`, `saveConnection(conn)`, `deleteConnection(id)`, `getDismissedSeeds()`, `getFavoriteConnectionIds()`, `toggleFavoriteConnection(id)`, `getConnectionOrder()`, `setConnectionOrder(order)` |
| **History** | `getHistory()`, `addToHistory(item)`, `clearHistory()` |
| **Saved Queries** | `getSavedQueries()`, `saveQuery(query)`, `deleteSavedQuery(id)`, `importSavedQueries(queries)` |
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
interface ServerStorageProvider extends PasskeyStore {
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
  listAccounts(): Promise<StoredAccount[]>;
  getAccount(email: string): Promise<StoredAccount | null>;
  insertAccount(account: StoredAccount): Promise<void>; // first removes passkey rows left under that email
  // Writes only while the row still has options.expected (the version the caller read), else
  // AccountWriteConflict; resolves to the number of passkeys removed (clearPasskeys).
  updateAccount(account: StoredAccount, options: AccountUpdateOptions): Promise<number>;
  deleteAccount(email: string, options?: AccountWriteOptions): Promise<void>; // also user_storage rows; passkeys cascade
  // storage_meta's credential_envelope: no row is "v1-accepted", "v2" is "v1-retired", any other value throws.
  readEnvelopeState(): Promise<CredentialEnvelopeState>;
  // The operator re-seal in one transaction under the write lock: a complete backup named with backupLabel, then
  // each connections row and each account's factors through rewrite, then the marker; "already-retired" reads nothing.
  rewriteStoredCredentials(
    rewrite: StoredCredentialRewrite, backupLabel: string
  ): Promise<StoredCredentialRewriteResult>;
}

interface AccountUpdateOptions {
  expected: { sessionVersion: number; updatedAt: string };
  keepEnabledAdmin?: boolean; // refuse a write that would leave no enabled admin
  clearPasskeys?: boolean;    // delete the account's passkeys in the same transaction
}

interface PasskeyStore {
  listPasskeys(email: string): Promise<StoredPasskey[]>;
  countPasskeys(): Promise<Map<string, number>>;
  getPasskeyUserHandle(email: string): Promise<string | null>;
  findPasskey(credentialId: string): Promise<PasskeyMatch | null>;
  insertPasskey(write: PasskeyRegistrationWrite): Promise<void>;     // PasskeyRegistrationConflict
  recordPasskeySignIn(write: PasskeySignInWrite): Promise<void>;     // PasskeySignInConflict
  renamePasskey(email: string, id: string, name: string): Promise<boolean>;
  deletePasskey(write: PasskeyRemovalWrite): Promise<void>;          // PasskeyRemovalConflict
}
```

Each passkey write is one transaction that changes or locks the account row first, and refuses with a typed conflict carrying a closed reason instead of writing part of its change.
A registration applies only while the account's session version equals the one its ceremony was confirmed under, and a removal only while it equals the caller's; the removal moves the account to the next version in the same transaction, which ends the account's other sessions.

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
isServerStorageEnabled()     // → true if not 'local'
getStorageConfig()           // → { provider, serverMode }
getStorageProvider()         // → ServerStorageProvider | null (singleton)
closeStorageProvider()       // → cleanup for testing
```

Provider classes are **dynamically imported** — SQLite and PostgreSQL dependencies are only loaded when their provider is selected.

`getStorageProviderType()` (→ `'local' | 'sqlite' | 'postgres'`) lives in `src/lib/storage/provider-type.ts`, which imports nothing, so `src/proxy.ts` can read the storage type for its `Permissions-Policy` without loading storage.

---

## 8. API Routes

All routes (except `/config`) require JWT authentication.
The `user_id` for storage scoping is the authenticated user's `username` (email), or under governance `sub:` followed by the identity provider's subject ([Governance Mode](#governance-mode)).

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
  │   │ Owner: GET /api/auth/me → username          │
  │   │  ├─ Unreadable → syncError, isReady stays   │
  │   │  │   false, nothing is pulled or pushed     │
  │   │  ├─ libredb_workspace_owner = username      │
  │   │  │   → keep the browser copy                │
  │   │  ├─ No owner, never migrated → keep it,     │
  │   │  │   owner = username (local-mode data,     │
  │   │  │   migrated below into this account only) │
  │   │  └─ Otherwise → clear the browser copy,     │
  │   │      mark it migrated, owner = username     │
  │   └──────────────────────┬──────────────────────┘
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
  │   │  → Write server data into localStorage,     │
  │   │    only while the owner is still username   │
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

### The Browser Copy Belongs to the Signed-In Account

In server mode the browser copy is bound to the account that signed in: `libredb_workspace_owner` holds its username, and it is compared with `GET /api/auth/me` before any page reads the copy.
Every page that reads it (the editor, the admin dashboard and the monitoring page) renders inside `WorkspaceOwnerGate`, which runs that check first; the lifecycle above runs it again when it starts, before anything is migrated or pulled, and from then on every request names the owner (see below).
The settings pages (`/settings/mcp`, `/settings/authenticator`) do not read the copy but render inside the gate too, because a sign-in can land on them, and the gate records the owner there.
While the check runs, those pages show a loading indicator; when the signed-in account cannot be read, they show a message instead of the copy.
They show it too when `GET /api/storage/config` cannot be read and the copy carries an owner or the migration flag, both written only in server mode; a copy with neither renders as it is, so local mode does not change.
The copy is every synced collection, the editor tabs (never stored on the server), the object-source drafts, the agent thread hint, the names of the collections a sign-out could not push, the migration flag and the owner key itself; per-browser preferences such as the theme and line numbers are not part of it.
`clearAccountWorkspace()` in `src/lib/storage/local-storage.ts` holds that list.

- **Same account:** the copy is kept, the collections a sign-out could not push are pushed, and the pull overwrites each collection the server holds, except one still waiting to be pushed; a collection the server does not hold yet stays local.
- **A different account, or a copy with no owner that was already migrated:** the copy is cleared first and recorded as this account's, so the account starts from its own server data.
- **A copy with no owner that was never migrated:** local-mode data, recorded as the signed-in account's and migrated into that account as described in [Migration Flow](#10-migration-flow).
  A different account that signs in before the migration ran finds it owned by the first account, so the copy is cleared for it.
- **Sign-out** (the editor, the admin dashboard and the launch page): the signing-out tab's pending collections are pushed while the session is still valid, then `POST /api/auth/logout` ends the session, and only then is the copy cleared.
  Only the signing-out tab's pending collections are pushed first: a change waiting in another open tab reaches the server only if that tab pushes it before the session ends, and is refused after.
  The cleared copy keeps the migration flag and no owner, so whatever is written to it afterwards is cleared at the next sign-in rather than migrated.
  A pending push that does not land does not stop the sign-out: when it failed because the session had already ended, the copy is cleared and the tab goes to sign in; otherwise (server storage unreachable) the session still ends, the copy stays for this account with the names of the collections that were not pushed, and the sign-out says so.
  The next sign-in of the same account on this browser pushes those collections before it pulls, and a pull does not replace a collection still waiting to be pushed; the next sign-in of a different account clears the copy, those changes with it.
  A change made in the signing-out tab while the sign-out request is out is not pushed; it goes with the cleared copy.
  When the server refuses the sign-out, or its answer is lost, the tab asks `GET /api/auth/me`: with no session left the sign-out counts as done and the copy is cleared, and while the session goes on the copy stays, the sync goes on, and the sign-out says it did not complete.
  When the storage mode cannot be read, a copy that carries the owner key or the migration flag fails the sign-out and stays; a copy with neither is local-mode data, and the session just ends.
  A sign-out from a tab whose session another tab has meanwhile replaced with a different account's gets `409 WORKSPACE_OWNER_MISMATCH` on its push and reloads; a logout request it sends before the reload lands ends the session the browser holds, which is that other account's.
- **Other open tabs:** every tab of the browser profile shares the copy, so when another tab records a different owner or clears the copy (a sign-out, or a different account signing in and landing on the editor, an admin page, the monitoring page or a settings page), each page inside `WorkspaceOwnerGate` stops rendering and reloads, and the owner check runs again for the account signed in now.
  A sign-in can also land where no owner is recorded (an unknown address), so a page inside `WorkspaceOwnerGate` also asks which account is signed in whenever its tab is shown again, and reloads the same way when that is no longer the account it rendered for.
  The editor's sync asks which account is signed in once more when it starts, and reloads the same way when that is no longer the account the page matched the copy for.
- **Every request names the account:** once a page has matched the copy, every request it sends names that account in the `X-LibreDB-Workspace-Owner` header, and the server refuses one that names an account other than the signed-in one with `409 WORKSPACE_OWNER_MISMATCH` before the route runs, on every route that needs a session; the public routes (`src/proxy.ts`) are not checked ([API_DOCS.md](API_DOCS.md#storage-api)).
- **The embedded workspace:** none of this applies to `StudioWorkspace` from the npm package, which mounts no sync, gate or owner check: its host supplies the connections, and the editor tabs it keeps in the host page's storage are the host's to scope to its own accounts.
  The page then reloads, and the owner check runs again for the account signed in now, so a push, a pull or a migration a page sends after another tab signed in as a different account never reaches that account's server data, also in a tab that stays visible.
  In the browser the same rule holds: a page writes the copy (the storage facade, its editor tabs, its object-source drafts, and each collection of a pull) only while the owner key still names the account it claimed, so a page that has not reloaded yet writes nothing into the copy another tab claimed.
- **A session that ended on its own** (expiry, a disabled account) clears nothing: the copy stays until the next sign-in's owner check, which covers a different account on the first of these pages it opens.
  A page inside `WorkspaceOwnerGate` that finds no session when it opens, or when its tab is shown again, shows neither the copy nor a message and goes to sign in.
  It does not cover a copy written while `GET /api/storage/config` could not be read on a browser profile that had no owner and no migration flag yet: such a copy is treated as local-mode data, so the next account to sign in records it as its own and migrates it.
- **The first sign-in after upgrading to a release that records the owner:** a browser that was already migrated has no owner yet, so its copy is cleared once, for the same account too, and that sign-in starts from the account's server data.
  Open editor tabs from before the upgrade are not kept, since they are never stored on the server, and neither are object-source drafts or any change that had not reached the server.

In local mode none of this runs: the browser copy is the only copy, it stays on sign-out, and no owner is recorded.

### Graceful Degradation

- If `/api/storage/config` fails → stays in localStorage-only mode, unless the browser copy carries `libredb_workspace_owner` or `libredb_server_migrated`: then the pages that read the copy show a message instead of it, because the copy may belong to a different account
- If push fails → logs warning, sets `syncError`, does **not** block the UI
- Components always read from `localStorage` — no loading states for storage

---

## 10. Migration Flow

When a user first enables server mode (or a new user logs in for the first time):

```
1. Hook detects serverMode = true
2. Reads the signed-in username (GET /api/auth/me), clears a browser copy that belongs to another account, and sets 'libredb_workspace_owner' to the username
3. Checks localStorage('libredb_server_migrated') flag
4. If not migrated:
   a. Reads whichever of the 13 collections exist in localStorage (a fresh browser with none simply sets the flag and skips)
   b. POST /api/storage/migrate with the collected payload
   c. Server calls provider.mergeData() — upserts each collection as a whole blob in one transaction
   d. Sets 'libredb_server_migrated' flag in localStorage
5. Pull: GET /api/storage → overwrite localStorage with server data, unless a sign-out cleared the copy while the pull was out
6. Subsequent mutations sync normally via push
```

Step 2 is described in [The Browser Copy Belongs to the Signed-In Account](#the-browser-copy-belongs-to-the-signed-in-account).

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

- `user_id` = JWT session `username` (email address), or under governance `sub:` followed by the identity provider's subject ([Governance Mode](#governance-mode))
- **Client never sends `user_id`** — server always extracts from JWT cookie
- Every query includes `WHERE user_id = $username` — no cross-user access possible

### Authentication

- `/api/storage/config` is **public** — returns only `{ provider, serverMode }`, no sensitive data
- All other `/api/storage/*` routes require a valid JWT session via `getSession()`
- Unauthorized requests receive `401 Unauthorized`

### OIDC Users

OIDC users (Auth0, Keycloak, Okta, Azure AD) have their email claim, else their `preferred_username`, mapped to the same `username` field used as `user_id`, under the rule in [OIDC.md](./OIDC.md#session-identity). See [OIDC.md](./OIDC.md) for SSO configuration; it pairs well with server storage for team deployments.

### Governance Mode

With `GOVERNANCE_SOURCE=postgres` ([GOVERNANCE.md](./GOVERNANCE.md#sign-in)) the key is not the username.
Studio files every row under `sub:` followed by the session's `idpSubject`, the identity provider's subject for the user ([OIDC.md](./OIDC.md#session-identity)), which for Keycloak is the user id:

```
(sub:6f1c2b7e-0d4a-4c51-9a1e-2f3b8c9d0e11, connections) → [...]
(sub:6f1c2b7e-0d4a-4c51-9a1e-2f3b8c9d0e11, history)     → [...]
```

- The subject is the key a control plane writes the user's grants under, and it stays when the email changes.
  So a later email change does not move a user's storage: the next sign-in reads and writes the same rows.
- The username keeps its other uses: display, rate limiting and the owner of the browser copy, so the `X-LibreDB-Workspace-Owner` header still names it ([The Browser Copy Belongs to the Signed-In Account](#the-browser-copy-belongs-to-the-signed-in-account)).
  After an email change the next sign-in finds a copy owned by the old address, clears it, and pulls the same rows from the server again.
- The prefix keeps subjects apart from usernames.
  Rows a store filed under a username before governance was switched on stay under that username, and governance mode neither reads nor moves them.
- Under governance sign-in refuses a session without a subject, and a storage route that meets one answers 500 rather than file rows under the username.
- `src/lib/storage/owner-key.ts` builds the key.
  Without governance it is the username exactly as before, also for an OIDC session that carries a subject.

### Accounts

`STORAGE_PROVIDER=sqlite` or `postgres` keeps local email/password identities in an `accounts` table next to `user_storage`.
`STORAGE_PROVIDER=local` has no server database, so it keeps using `ADMIN_PASSWORD` and the optional `USER_PASSWORD` on every login.
`NEXT_PUBLIC_AUTH_PROVIDER=oidc` does not read or write `accounts`: the issuer is the only identity, and a stored role cannot deny or elevate someone the issuer already named.

On the first start with an empty table, `ADMIN_EMAIL` / `ADMIN_PASSWORD` (and `USER_EMAIL` / `USER_PASSWORD` when the password is set) are copied in and then left alone.
Passwords are stored as scrypt (RFC 7914) with N=16384, r=8, p=1, a 16-byte salt and a 32-byte key, encoded `scrypt$<N>$<r>$<p>$<salt>$<key>`.
A stored hash whose parameters differ is rewritten with the current parameters after a successful login.
A failed login does not write.

Further accounts are created under Admin → Accounts.
Disabling an account stops login and leaves its `user_storage` rows in place, so enabling it again restores that person's connections.
Deleting an account removes those rows in the same transaction, so creating the same email later does not inherit them.
Its passkeys and user handle go with it through the foreign keys of the passkey tables.
Studio's own SQLite connections enforce foreign keys; a delete made outside Studio, such as in the `sqlite3` shell, must run `PRAGMA foreign_keys = ON` first.
On PostgreSQL the foreign keys always hold, except for a delete made with `session_replication_role = replica`.
When a delete bypassed them on either engine, creating an account under the same email later removes the passkey rows left behind in the same transaction and logs a warning with their count, so the old passkeys never sign in to the new account.
A DBA-managed PostgreSQL schema must create the passkey tables before an image with passkey sign-in starts; see [PASSKEYS.md](./PASSKEYS.md#upgrading-a-dba-managed-schema).
The last enabled admin cannot be disabled, demoted, or deleted, and the store decides that inside the write's own transaction, so two concurrent requests cannot each remove one of the last two admins.

**Sessions follow the account.**
Each session token carries the account's `session_version`, and every request reads the row again: a session ends at its next request when its account is disabled, deleted, demoted or promoted, or has its password reset by an admin.
An admin who changes their own role or password keeps the session making the change, and their other sessions end.
An admin password set also removes the account's passkeys unless the admin keeps them, and removing a passkey ends the account's other sessions too; see [PASSKEYS.md](./PASSKEYS.md#admin-actions-and-recovery).
Every account write applies only while the row still has the session version and update time its writer read, so a change that lands first is never reverted by a request that read the row before it; the loser answers 409.
MCP tokens minted for a stored account carry the same version and stop working the same way.
A new row starts at a random version, so a session of a deleted account never matches a later account with the same email.
Upgrading an existing `sqlite` or `postgres` deployment to a release with the registry signs every local user out once: a session from before it carries no version.

**The environment after seeding.**
Once the table has rows, changing `ADMIN_PASSWORD` no longer changes the admin's password.
Each start compares the two once and logs a warning when `ADMIN_PASSWORD` does not match the stored admin, or when `ADMIN_EMAIL` has no row.
To apply the environment, for a rotated secret or an admin locked out of every account, set `ADMIN_PASSWORD_RESET=true` and restart: `ADMIN_EMAIL` becomes an enabled admin that signs in with `ADMIN_PASSWORD`, with `ADMIN_TOTP_SECRET` as its second factor or none, its older sessions end, and the audit log records the change with actor `environment`; it has no passkeys afterwards.
Remove the variable afterwards, because every start applies it again while it is set, and the log says so.

TOTP secrets that were set in the environment are copied onto the seeded rows.
After that, enrolment is per account, and the stored secrets are sealed with the same key as connection passwords.
See [MFA.md](./MFA.md#when-accounts-live-in-the-server-store).

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
