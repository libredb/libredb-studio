# Seed Connections — Pre-Configured Database Connections

Seed Connections let administrators pre-configure database connections via a YAML or JSON file. Users see these connections immediately after login — no manual setup required.

**Use cases:**
- Platform/SaaS: provision databases for all users on signup
- Enterprise: give teams access to staging/production databases
- On-prem: DevOps pre-loads connections via Helm values or Docker volumes

## Quick Start

**1.** Create `seed-connections.yaml`:

```yaml
version: "1"

connections:
  - id: "prod-db"
    name: "Production Database"
    type: postgres
    host: "${DB_HOST}"
    port: 5432
    database: "${DB_NAME}"
    user: "${DB_USER}"
    password: "${DB_PASSWORD}"
    roles: ["*"]
```

**2.** Mount and set env vars:

```bash
docker run \
  -v ./seed-connections.yaml:/app/config/seed-connections.yaml:ro \
  -e SEED_CONFIG_PATH=/app/config/seed-connections.yaml \
  -e DB_HOST=mydb.internal -e DB_NAME=mydb \
  -e DB_USER=reader -e DB_PASSWORD=secret \
  ghcr.io/libredb/libredb-studio:latest
```

**3.** Login — the connection appears in the sidebar with a lock icon.

---

## Config File Format

The config file is YAML (`.yaml`, `.yml`) or JSON (`.json`). Format is auto-detected by file extension.

```yaml
version: "1"

defaults:                    # Optional — merged into every connection
  managed: true
  environment: production
  ssl:
    mode: require
    rejectUnauthorized: true

connections:
  - id: "analytics-pg"       # Required, unique, lowercase slug [a-z0-9-]
    name: "Analytics DB"      # Required, display name in UI
    type: postgres            # Required: postgres|mysql|sqlite|mongodb|redis|oracle|mssql|libredb|couchbase|clickhouse|druid|elasticsearch|opensearch|trino|cassandra
    host: "${PG_HOST}"
    port: 5432
    database: analytics
    user: "${PG_USER}"
    password: "${PG_PASSWORD}"
    environment: production   # production|staging|development|local|other
    group: "Data Team"        # Group label in sidebar
    color: "#10B981"          # Hex color for environment badge
    roles: ["admin"]          # Who can see this connection
    managed: true             # Read-only in UI (default from `defaults`)
    ssl:
      mode: require
      rejectUnauthorized: true
    # serviceName: "ORCL"     # Oracle only
    # instanceName: "MSSQL$"  # SQL Server only
    # localDataCenter: "datacenter1"  # Cassandra only - REQUIRED there

  - id: "dev-mysql"
    name: "Dev MySQL"
    type: mysql
    host: "${MYSQL_HOST}"
    port: 3306
    database: devdb
    user: "${MYSQL_USER}"
    password: "${MYSQL_PASSWORD}"
    roles: ["*"]              # Everyone can see this
    managed: false            # User gets an editable copy
    environment: development

  - id: "events-druid"
    name: "Druid Events"
    type: druid
    host: "${DRUID_HOST}"
    port: 8888                # Router. The Broker's 8082 serves the same endpoint
    roles: ["*"]
    environment: production
    # No `database`: Druid reports exactly one catalog, always `druid`, so there is
    # nothing to select. No `connectionString` either - its HTTP SQL API has no URI
    # convention, so host and port are the whole address.
    # user/password are optional and only reach a cluster running druid-basic-security.

  - id: "lake-trino"
    name: "Trino Lakehouse"
    type: trino
    host: "${TRINO_HOST}"
    port: 8080                # The client protocol and the web UI share this port
    database: hive            # The CATALOG, not a database. Pins what the tree shows;
                              # a fully qualified name still reaches any other catalog.
    user: "${TRINO_USER}"
    roles: ["*"]
    environment: production
    # A `password` here would need `ssl.mode` set as well: the coordinator answers
    # 401 "Password not allowed for insecure authentication" over plain HTTP, even
    # with authentication switched off, so a password without TLS breaks a
    # connection that works without one.
    # No `connectionString`: jdbc:trino:// is not a form this build parses.

  - id: "events-ring"
    name: "Cassandra Ring"
    type: cassandra
    host: "${CASSANDRA_HOST}"
    port: 9042                     # The native protocol
    database: events               # The KEYSPACE, pinned for the session. Without it an
                                   # unqualified table name resolves to nothing.
    localDataCenter: datacenter1   # REQUIRED: the driver refuses to connect without it,
                                   # and a stock single-node install reports datacenter1.
    user: "${CASSANDRA_USER}"
    roles: ["*"]
    environment: production
    # No `connectionString`: no URI convention carries localDataCenter, so a pasted
    # one would produce a connection that cannot open.
```

### Field Reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `version` | Yes | — | Must be `"1"` |
| `defaults` | No | — | Merged into all connections (connection values override) |
| `defaults.managed` | No | `true` | Default managed state |
| `defaults.environment` | No | — | Default environment label |
| `defaults.ssl` | No | — | Default SSL config |
| `connections` | Yes | — | Array of connection definitions (min 1) |
| `connections[].id` | Yes | — | Unique slug: `[a-z0-9-]+`, max 64 chars |
| `connections[].name` | Yes | — | Display name, max 128 chars |
| `connections[].type` | Yes | — | Database type: `postgres`, `mysql`, `sqlite`, `mongodb`, `redis`, `oracle`, `mssql`, `libredb`, `couchbase`, `clickhouse`, `druid`, `elasticsearch`, `opensearch`, `trino`, `cassandra` |
| `connections[].host` | No | — | Hostname or IP |
| `connections[].port` | No | — | Port number (1-65535) |
| `connections[].database` | No | — | Database name (Couchbase: the bucket. Druid has one catalog and ignores it. Trino: the **catalog**) |
| `connections[].user` | No | — | Username |
| `connections[].password` | No | — | Password (use `${ENV_VAR}` syntax) |
| `connections[].connectionString` | No | — | Full connection string (use `${ENV_VAR}`). Druid and Trino have no URI form this build parses — those connections need `host` and are addressed by host and port only |
| `connections[].roles` | Yes | — | Access control: `["*"]`, `["admin"]`, `["user"]`, `["admin", "user"]` |
| `connections[].managed` | No | from defaults | `true` = read-only, `false` = editable copy |
| `connections[].environment` | No | from defaults | Environment badge |
| `connections[].group` | No | — | Group label |
| `connections[].color` | No | — | Hex color for badge (e.g., `#10B981`) |
| `connections[].ssl` | No | from defaults | SSL configuration |
| `connections[].serviceName` | No | — | Oracle service name |
| `connections[].instanceName` | No | — | SQL Server instance name |
| `connections[].localDataCenter` | No¹ | — | Cassandra local data centre (`datacenter1`). ¹Optional in the schema because no other engine has it, and **required by the Cassandra provider**: the driver refuses to connect without one |

---

## Credential Management

Credentials are never stored in the config file directly. Use `${ENV_VAR}` syntax to reference environment variables:

```yaml
connections:
  - id: "prod-db"
    password: "${PROD_DB_PASSWORD}"        # Resolved from process.env at runtime
    connectionString: "${MONGO_URI}"       # Also works for connection strings
    user: "${DB_USER}"                     # Any field can use ${} syntax
```

**How it works:**
1. Config file is read from disk (YAML/JSON)
2. `${VARIABLE_NAME}` patterns are resolved from `process.env`
3. If an env var is undefined, that connection is **skipped** (others continue working)
4. Plaintext passwords trigger a warning log (but still work)

**Resolvable fields:** `password`, `connectionString`, `user`, `host`, `database`

### Credential Sources by Deployment

| Deployment | How to provide credentials |
|------------|---------------------------|
| **Docker** | `-e DB_PASSWORD=secret` |
| **Docker Compose** | `environment:` block or `.env` file |
| **Kubernetes** | `Secret` → `extraEnvFrom` in Helm values |
| **Vault/SSM** | External Secrets Operator → K8s Secret → `extraEnvFrom` |

### Kubernetes Example

```yaml
# Create a K8s Secret with credentials
apiVersion: v1
kind: Secret
metadata:
  name: seed-db-credentials
type: Opaque
stringData:
  PG_PASSWORD: "my-secret-password"
  MYSQL_PASSWORD: "another-secret"

---
# Reference in Helm values
extraEnvFrom:
  - secretRef:
      name: seed-db-credentials
```

---

## Role-Based Access Control

Each connection has a `roles` field that controls which users can see it:

| Config | Who sees it |
|--------|-------------|
| `roles: ["*"]` | All authenticated users |
| `roles: ["admin"]` | Admin users only |
| `roles: ["user"]` | Regular users only |
| `roles: ["admin", "user"]` | Both (same as `["*"]`) |

Roles are matched against the JWT session's `role` field. The role is extracted server-side from the JWT token — never from client input.

**Current limitation:** The system supports `admin` and `user` roles only (matching the JWT `role` claim). Custom roles (e.g., `data-team`, `backend`) are planned for a future release with expanded OIDC role claim support.

### How Role Filtering Works

```
User logs in → JWT contains { role: "user" }
                    ↓
GET /api/connections/managed
                    ↓
Server reads config → filters by role
                    ↓
User sees only connections where roles includes "user" or "*"
```

---

## Managed vs. Unmanaged Connections

### `managed: true` (default)

- Connection appears with a **lock icon** in the sidebar
- Users **cannot edit or delete** it
- Credentials are **never sent to the client** — server resolves them at query time
- If admin updates the config (e.g., password rotation), all users get the new credentials automatically
- Best for: production databases, shared resources

### `managed: false`

- On first load, the connection is **copied to the user's local storage** with credentials
- User **can edit or delete** their copy
- Once copied, the connection belongs to the user — admin changes to the seed config won't affect existing copies
- If the user deletes their copy, the seed ID is recorded in a local "dismissed" list and the connection is **not** re-imported on subsequent loads (see [Dismissed Seeds](#dismissed-seeds) below)
- Best for: development databases, sandbox environments

### Comparison

| Behavior | `managed: true` | `managed: false` |
|----------|-----------------|-------------------|
| UI edit/delete | Locked | Allowed |
| Credentials on client | Never | Copied once |
| Password rotation | Automatic | User must re-import |
| Admin removes from config | Disappears for all | User copy remains |
| Server-side credential resolution | Yes | No (user has local copy) |
| User deletes their copy | N/A (locked) | Dismissed permanently — will not reappear |

### Dismissed Seeds

Deleting a `managed: false` connection from the sidebar does not simply remove it — the client records the seed's `id` in a local `dismissed_seeds` list (synced through the same write-through storage as connections). On every subsequent load, `dismissed_seeds` is checked before re-importing `managed: false` connections from `/api/connections/managed`, so a deleted seed connection stays gone even after the admin's config is untouched. There is currently no UI to un-dismiss a seed; the only way to bring it back is to clear the `dismissed_seeds` entry from local storage (see [Troubleshooting](#troubleshooting)).

---

## Hot Reload

The config file is **cached in memory** with a TTL (default 60 seconds). When the file changes:

1. Next API request after TTL expires triggers a re-read
2. New connections appear, removed connections disappear
3. Updated credentials take effect immediately (for `managed: true`)
4. **No restart required**

### Tuning the Cache TTL

```bash
# Default: 60 seconds
SEED_CACHE_TTL_MS=60000

# Faster refresh (5 seconds) — useful during development
SEED_CACHE_TTL_MS=5000

# Slower refresh (5 minutes) — production with infrequent changes
SEED_CACHE_TTL_MS=300000
```

In Kubernetes, ConfigMap updates propagate in ~60-120s (kubelet sync period). Combined with the cache TTL, expect ~2-3 minutes for changes to take effect.

---

## Deployment Examples

### Docker

```bash
docker run \
  -v ./seed-connections.yaml:/app/config/seed-connections.yaml:ro \
  -e SEED_CONFIG_PATH=/app/config/seed-connections.yaml \
  -e PG_PASSWORD=secret \
  -e JWT_SECRET=your-32-char-jwt-secret-here!! \
  -e ADMIN_PASSWORD=MyAdmin123 \
  -e USER_PASSWORD=MyUser123 \
  -p 3000:3000 \
  ghcr.io/libredb/libredb-studio:latest
```

### Docker Compose

```yaml
services:
  libredb:
    image: ghcr.io/libredb/libredb-studio:latest
    ports:
      - "3000:3000"
    volumes:
      - ./seed-connections.yaml:/app/config/seed-connections.yaml:ro
    environment:
      SEED_CONFIG_PATH: /app/config/seed-connections.yaml
      JWT_SECRET: your-32-char-jwt-secret-here!!
      ADMIN_PASSWORD: MyAdmin123
      USER_PASSWORD: MyUser123
      PG_PASSWORD: ${PG_PASSWORD}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    env_file:
      - .env  # Store credentials here
```

### Kubernetes (Helm)

**Option A — Inline config in values.yaml:**

```yaml
seedConnections:
  enabled: true
  config:
    version: "1"
    defaults:
      managed: true
      environment: production
    connections:
      - id: "prod-analytics"
        name: "Production Analytics"
        type: postgres
        host: analytics-db.internal
        port: 5432
        database: analytics
        user: readonly
        password: "${ANALYTICS_DB_PASSWORD}"
        roles: ["admin"]
        color: "#10B981"
      - id: "staging-api"
        name: "Staging API DB"
        type: mysql
        host: staging-mysql.internal
        password: "${STAGING_DB_PASSWORD}"
        roles: ["*"]
        managed: false
        environment: staging

extraEnvFrom:
  - secretRef:
      name: seed-db-credentials
```

**Option B — External ConfigMap:**

```yaml
seedConnections:
  enabled: true
  existingConfigMap: "my-seed-connections"  # Pre-created ConfigMap
  configMapKey: "connections.yaml"          # Key within the ConfigMap

extraEnvFrom:
  - secretRef:
      name: seed-db-credentials
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Config file not found | App runs normally, no seed connections. Warning logged. |
| Invalid YAML/JSON | Endpoint returns 500. Error logged with details. |
| Invalid config (Zod validation fails) | Endpoint returns a generic 500. Validation errors are logged server-side, not returned in the response body. |
| Unrecognized `version` | Endpoint returns 500. Future versions require code update. |
| `${ENV_VAR}` not defined | That connection is **skipped**. Others work normally. Error logged. |
| User role doesn't match any connection | Empty list returned. Normal behavior. |
| Seed connection not found at query time | 404 response. |
| User doesn't have access to seed connection | 403 response. |

**Design principle:** One broken connection never breaks the others. Each connection is resolved independently.

---

## Security Model

### Credential Protection

- `managed: true` connections: passwords **never reach the client**. The API strips `password` and `connectionString` from responses. Server resolves credentials at query execution time.
- Config file should be mounted **read-only** (`:ro` in Docker, `readOnly: true` in Kubernetes).
- Use `${ENV_VAR}` for all secrets. Plaintext passwords trigger a warning log.

### Role Enforcement

- User role is extracted from the JWT session **server-side** — never from client headers or request params.
- Every database operation (query, schema, health check, etc.) goes through `resolveConnection()` which verifies role access before returning credentials.
- Role check failures return 403 with no credential information.

### Audit Trail

`resolveConnection()` (`src/lib/seed/resolve-connection.ts`) logs every seed-connection lookup through the structured logger:

- A successful resolution logs at `debug` level with `route`, `connectionId`, and `user`.
- A denied lookup (connection exists but the caller's role isn't in `roles`) logs at `warn` level with `route`, `connectionId`, `user`, and `role`, before the 403 is returned.

This is the standard application logger (`src/lib/logger.ts`), not a persisted audit-log entry — there is currently no dedicated `managed_connection` audit-ring-buffer event wired up for seed connections, despite that event type existing in `src/lib/audit.ts`'s `AuditEventType` union.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SEED_CONFIG_PATH` | `/app/config/seed-connections.yaml` | Path to config file |
| `SEED_CACHE_TTL_MS` | `60000` | Cache TTL in milliseconds |

These are unrelated to the embedded sample connection described below, which uses its own `LIBREDB_EMBEDDED_SAMPLE` / `LIBREDB_EMBEDDED_SAMPLE_PATH` variables.

---

## Built-in Sample Connections

Standalone deployments also get automatic, code-defined seed connections (none of this has any effect when embedded in libredb-platform — it is not part of the published `@libredb/studio` package surface):

- **Sample (LibreDB)** — on first startup, `src/lib/seed/libredb-sample.ts` creates an embedded LibreDB file (default `<data dir>/sample.libredb`, alongside the SQLite storage DB) and seeds it with example data — a `users` table, an `articles` document collection, and a couple of KV entries — one per LibreDB lens. Seeded synchronously during boot.
- **Sample (Employees)** — `src/lib/seed/sqlite-sample.ts` copies the vendored employees SQLite database (`seed-assets/sqlite/employee.db`, from [bytebase/employee-sample-database](https://github.com/bytebase/employee-sample-database) `dataset_small`, originally [datacharmer/test_db](https://github.com/datacharmer/test_db); see `seed-assets/sqlite/ATTRIBUTION.md`) to `<data dir>/sample-employees.db`. Seeded **asynchronously and fail-open**: boot never waits for the copy; while it is in flight `GET /api/connections/managed` lists the seed id in `pendingSeeds` and the client polls (1s, max 30 attempts; the interval constant is inlined at build time — `NEXT_PUBLIC_MANAGED_POLL_MS` only affects source builds and tests, not packaged artifacts) so the connection appears without a page refresh.

`getManagedConnections()` appends each sample to the managed-connections list once its file exists (`managed: false`, `roles: ["*"]`), so they behave like any other unmanaged seed: editable, and if deleted they go to the dismissed list rather than reappearing.

This is separate from the `SEED_CONFIG_PATH` file and needs no config of its own:

| Variable | Default | Description |
|----------|---------|-------------|
| `LIBREDB_EMBEDDED_SAMPLE` | `true` | Set to `false` (exact match) to disable the LibreDB sample |
| `LIBREDB_EMBEDDED_SAMPLE_PATH` | `<data dir>/sample.libredb` | Override the LibreDB sample file's location |
| `SQLITE_EMBEDDED_SAMPLE` | `true` | Set to `false` (exact match) to disable the SQLite sample |
| `SQLITE_EMBEDDED_SAMPLE_PATH` | `<data dir>/sample-employees.db` | Override the SQLite sample file's location |
| `SQLITE_EMBEDDED_SAMPLE_TEMPLATE` | `<cwd>/seed-assets/sqlite/employee.db` | Override the vendored template's location |

The sample files are only created if they don't already exist — the seeding is idempotent and never overwrites a user's edits.

---

## Troubleshooting

### Connections don't appear after login

1. Check if the config file exists at `SEED_CONFIG_PATH`
2. Check server logs for `Seed config file not found` warning
3. Verify the YAML is valid: `cat seed-connections.yaml | python3 -c "import yaml,sys; yaml.safe_load(sys.stdin)"`
4. Check if `${ENV_VAR}` values are set: connections with unresolvable vars are silently skipped

### "Access denied" error when querying

The user's role doesn't match the connection's `roles` array. Check:
- User JWT role: login as admin vs user
- Connection `roles` field in config

### Credentials not updating after config change

- `managed: true`: Wait for TTL to expire (default 60s), or restart the app
- `managed: false`: The user has a local copy that never re-syncs from the config. Deleting it from the sidebar does not bring back the updated version either — it only marks the seed as dismissed (see [Dismissed Seeds](#dismissed-seeds)). To pick up new credentials, the user must delete their local copy from the `libredb_connections` entry in localStorage **and** remove the matching seed ID from `libredb_dismissed_seeds`, then reload.

### Two identical connections in sidebar

Clear browser localStorage (`libredb_connections` key) and refresh. This can happen if a connection was persisted before being marked as managed.

### A deleted seed connection won't come back

This is expected: deleting a `managed: false` connection adds its seed ID to `libredb_dismissed_seeds` in localStorage, and it is intentionally excluded from re-import on every subsequent load (see [Dismissed Seeds](#dismissed-seeds)). Remove the ID from that key (or clear it) to let the connection be re-imported.

---

## Architecture

```
seed-connections.yaml (volume mount)
        │
  ┌─────▼──────────┐
  │  ConfigLoader   │  Read + YAML/JSON parse + Zod validate + TTL cache
  └─────┬──────────┘
        │
  ┌─────▼──────────────┐
  │ CredentialResolver  │  ${ENV_VAR} → process.env + plaintext warning
  └─────┬──────────────┘
        │
  ┌─────▼──────────────┐
  │ ConnectionFilter    │  Role filter + defaults merge → ManagedConnection[]
  └─────┬──────────────┘
        │         ┌───────────────────────────────────────┐
        ├─────────┤ Embedded samples (libredb-sample.ts,   │  Appended if enabled and the
        │         │ sqlite-sample.ts)                      │  sample file exists
        │         └───────────────────────────────────────┘
  ┌─────▼───────────────────────┐
  │ GET /api/connections/managed │  Auth + strip credentials for managed:true
  └─────┬───────────────────────┘
        │
  ┌─────▼────────────────────┐
  │ useConnectionManager     │  Merge managed + user connections
  └─────┬────────────────────┘
        │
  ┌─────▼────────────────────────────┐
  │ resolveConnection() (all routes) │  seed: prefix → server-side credential resolution
  └──────────────────────────────────┘
```

**Module:** `src/lib/seed/` — 7 files, ~480 lines total

| File | Responsibility |
|------|---------------|
| `types.ts` | Zod schemas + TypeScript types |
| `config-loader.ts` | File read + parse + validate + cache |
| `credential-resolver.ts` | `${ENV_VAR}` resolution |
| `connection-filter.ts` | Role filter + defaults merge |
| `resolve-connection.ts` | Shared utility for all API routes |
| `libredb-sample.ts` | Built-in "Sample (LibreDB)" connection: file seeding + descriptor |
| `index.ts` | Public API: `getManagedConnections()` |
