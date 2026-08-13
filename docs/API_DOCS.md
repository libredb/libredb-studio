# LibreDB Studio API Documentation

> **Version:** 0.9.41
> **Base URL:** `https://your-domain.com` or `http://localhost:3000`
> **Content-Type:** `application/json`

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [API Endpoints](#api-endpoints)
  - [Auth API](#auth-api)
  - [Database API](#database-api)
  - [AI API](#ai-api)
  - [Storage API](#storage-api)
  - [Connections API](#connections-api)
  - [Admin API](#admin-api)
- [Data Types](#data-types)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [CSRF: Origin Check](#csrf-origin-check)
- [Examples](#examples)

---

## Overview

LibreDB Studio provides a RESTful API for database management operations. The API supports PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Couchbase, ClickHouse, Apache Druid, and Redis.

### Key Features

- **JWT Authentication** - Secure token-based authentication stored in HTTP-only cookies
- **Multi-Database Support** - PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Couchbase, ClickHouse, Apache Druid, Redis
- **AI-Powered Insights** - EXPLAIN explanations, query-safety analysis and schema docs, streamed
- **Real-time Health Monitoring** - Database metrics and performance insights

### Request Format

All API requests must include:
- `Content-Type: application/json` header
- Valid authentication cookie (except public endpoints)

### Response Format

Responses are JSON. There is **no global envelope** — each endpoint returns its own shape (documented per-endpoint below). Common patterns:

```json
// Auth endpoints
{ "success": true, "role": "admin" }

// Data / storage endpoints return the payload (or a bare ack) directly
{ "rows": [], "rowCount": 0, "pagination": { } }
{ "ok": true }

// Errors
{ "error": "Human-readable message" }   // route handlers that call createErrorResponse also add "code" and "statusCode" (and sometimes "retryable" / "details"); handlers that return errors inline may send just "error"
```

---

## Authentication

LibreDB Studio uses JWT (JSON Web Tokens) for authentication. Tokens are stored in HTTP-only cookies for security.

### Authentication Flow

1. Client sends credentials to `/api/auth/login`
2. Server validates and returns JWT in `auth-token` cookie
3. Client includes cookie in subsequent requests
4. Middleware validates token on protected routes

### Roles

| Role | Access Level |
|------|--------------|
| `admin` | Full access including maintenance operations and admin panel |
| `user` | Query execution, schema viewing (no maintenance) |

### Public Endpoints (No Auth Required)

Authentication is enforced centrally by the middleware (`src/proxy.ts`), not by individual route handlers: every route requires a valid `auth-token` cookie **except** the routes below. (This is why handlers like `/api/ai/*` don't call `getSession()` themselves — the middleware has already gated them.)

- `/api/auth/*` — login, logout, me, and OIDC login/callback
- `/api/db/health` — excluded from the middleware for **both** methods; `GET` is fully public, while `POST` performs its own session check and returns JSON `401` if unauthenticated
- `GET /api/storage/config` — storage-mode discovery (returns `{ provider, serverMode }`, no user data)

Unauthenticated requests to any other (middleware-gated) route are redirected to `/login`. A few allowlisted handlers self-check instead and return JSON — e.g. `POST /api/db/health` (`401`) and `GET /api/auth/me` (`{ "authenticated": false }`).

---

## API Endpoints

### Auth API

#### POST /api/auth/login

Authenticate user and create session.

**Request:**
```json
{
  "email": "admin@libredb.org",
  "password": "your-password"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "role": "admin"
}
```

**Response (401 Unauthorized):**
```json
{
  "success": false,
  "message": "Invalid email or password"
}
```

**Response (400 Bad Request):**
```json
{
  "success": false,
  "message": "Invalid request body"
}
```

**Notes:**
- Both `email` and `password` are required in the request body; matched against `ADMIN_EMAIL`/`ADMIN_PASSWORD` or `USER_EMAIL`/`USER_PASSWORD` environment variables. `ADMIN_PASSWORD` is mandatory; the `USER_*` account exists only when `USER_PASSWORD` is set
- Sets `auth-token` HTTP-only cookie on success
- A body that is not valid JSON gets the 400 above, not a 500 - and, like a wrong password, spends one unit of the client-address rate-limit budget (see "Rate Limiting" below), so a flood of malformed bodies from one address is eventually refused rather than answered indefinitely

---

#### POST /api/auth/logout

Terminate current session.

**Request:** No body required

**Response (200 OK):**
```json
{
  "success": true
}
```

When `NEXT_PUBLIC_AUTH_PROVIDER=oidc`, the response also includes the provider's RP-initiated logout URL for the client to redirect to:
```json
{
  "success": true,
  "redirectUrl": "https://issuer.example.com/v2/logout?..."
}
```

**Notes:**
- Clears the `auth-token` cookie

---

#### GET /api/auth/me

Get current authenticated user information.

**Response (200 OK):**
```json
{
  "authenticated": true,
  "user": {
    "role": "admin",
    "username": "admin@libredb.org"
  }
}
```

**Response (401 Unauthorized):**
```json
{
  "authenticated": false
}
```

> The `user` object is the JWT session payload (`role`, `username`). It is a public route in the middleware but self-checks the cookie, returning `{ "authenticated": false }` when absent/invalid.

---

### Database API

#### GET /api/db/health

Simple health check for load balancers and container orchestration.

**Authentication:** Not required

**Response (200 OK):**
```json
{
  "status": "healthy",
  "timestamp": "2025-12-24T12:00:00.000Z",
  "service": "libredb-studio"
}
```

---

#### POST /api/db/health

Detailed health check for a specific database connection.

**Authentication:** Required

**Request:**
```json
{
  "connection": {
    "id": "conn-123",
    "name": "Production DB",
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "user": "admin",
    "password": "secret"
  }
}
```

**Response (200 OK):**
```json
{
  "activeConnections": 5,
  "databaseSize": "256 MB",
  "cacheHitRatio": "99.2%",
  "slowQueries": [
    {
      "query": "SELECT * FROM large_table...",
      "calls": 150,
      "avgTime": "245ms"
    }
  ],
  "activeSessions": [
    {
      "pid": 12345,
      "user": "admin",
      "database": "mydb",
      "state": "active",
      "query": "SELECT * FROM users",
      "duration": "1.5s"
    }
  ]
}
```

**Response (503 Service Unavailable):**
```json
{
  "error": "Connection failed: timeout",
  "activeConnections": 0,
  "databaseSize": "N/A",
  "cacheHitRatio": "N/A",
  "slowQueries": [],
  "activeSessions": []
}
```

---

#### POST /api/db/query

Execute SQL query on connected database.

**Authentication:** Required

**Request:**
```json
{
  "connection": {
    "id": "conn-123",
    "name": "My Database",
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "user": "admin",
    "password": "secret"
  },
  "sql": "SELECT id, name, email FROM users WHERE active = true LIMIT 100"
}
```

**Response (200 OK):**
```json
{
  "rows": [
    { "id": 1, "name": "John Doe", "email": "john@example.com" },
    { "id": 2, "name": "Jane Smith", "email": "jane@example.com" }
  ],
  "fields": ["id", "name", "email"],
  "rowCount": 2,
  "executionTime": 12,
  "pagination": {
    "limit": 500,
    "offset": 0,
    "hasMore": false,
    "totalReturned": 2,
    "wasLimited": false
  }
}
```

The `pagination` object reports the auto-limiting applied by the server (default 500 rows). `wasLimited` is `true` when the server injected a `LIMIT` the query didn't specify; `hasMore` indicates more rows are available — re-request with a higher `offset` to page. See [`docs/editor/query-optimization.md`](editor/query-optimization.md).

**Bound parameters (optional):**
```json
{
  "connection": { "type": "mysql", "host": "localhost", "database": "mydb" },
  "sql": "UPDATE users SET `name` = ? WHERE `id` = ?",
  "params": ["O'Brien", 7]
}
```

`params` binds the statement's positional placeholders through the driver, so a value never becomes statement text. Use it for any statement built from data rather than typed by a person — a value carrying `\'` would otherwise close its own string literal on MySQL or ClickHouse and have the rest read as SQL. The placeholder form is the dialect's own: `$n` (PostgreSQL), `?` (MySQL, SQLite), `:n` (Oracle), `@pn` (SQL Server).

Each element must be a string, number, boolean or `null`; anything else is rejected with 400 rather than handed to the driver. `POST /api/db/transaction` accepts the same field for its `query` action.

**Response (400 Bad Request):**
```json
{
  "error": "syntax error at or near \"SELEC\"",
  "code": "QUERY_ERROR"
}
```

**Response (408 Request Timeout):**
```json
{
  "error": "Query timed out. Please try a simpler query or increase timeout."
}
```

##### MongoDB Query Format

For MongoDB connections, the `sql` field should contain a JSON query:

```json
{
  "connection": {
    "type": "mongodb",
    "connectionString": "mongodb://localhost:27017/mydb"
  },
  "sql": "{\"collection\":\"users\",\"operation\":\"find\",\"filter\":{\"active\":true},\"options\":{\"limit\":50}}"
}
```

**Supported MongoDB Operations:**
- `find` - Query documents
- `findOne` - Get single document
- `insertOne` - Insert document
- `insertMany` - Insert multiple documents
- `updateOne` - Update single document
- `updateMany` - Update multiple documents
- `deleteOne` - Delete single document
- `deleteMany` - Delete multiple documents
- `aggregate` - Aggregation pipeline
- `count` - Count documents matching a filter (runs `countDocuments` internally)
- `distinct` - Distinct values for a field (the field is taken from the first key of `options.projection`)

##### Couchbase Query Format

Couchbase speaks **SQL++**, a SQL dialect, so the `sql` field carries an ordinary statement — there
is no JSON envelope. Two things differ from the other SQL providers:

- `connection.database` carries the **bucket** (one bucket per connection), and `connection.port` is
  the **management** port (`8091`, or `18091` with TLS). The query port is discovered from
  `GET /pools/default/nodeServices` at connect time and is never configured.
- Keyspaces are backtick-quoted three-part paths. `SELECT *` nests the document under the keyspace
  name and never yields the document key, so generated statements alias and project it explicitly.

```json
{
  "connection": {
    "type": "couchbase",
    "host": "127.0.0.1",
    "port": 8091,
    "user": "Administrator",
    "password": "password123",
    "database": "travel"
  },
  "sql": "SELECT META(d).id AS __id, d.* FROM `travel`.`inventory`.`hotel` AS d LIMIT 50"
}
```

**Notes:**
- Every statement is sent with `scan_consistency: request_plus`, so a `SELECT` issued right after an
  `INSERT` sees the new rows (the cluster default, `not_bounded`, does not).
- A statement against a keyspace with no usable index returns `400 Bad Request` with code
  `QUERY_ERROR`, and the message carries the runnable remedy
  (``CREATE PRIMARY INDEX ON `travel`.`inventory`.`hotel` ``). A document whose key is known needs no
  index at all: `SELECT d.* FROM ... AS d USE KEYS ["hotel::1"]`.
- `POST /api/db/maintenance` accepts `analyze` (`UPDATE STATISTICS`, Enterprise Edition only),
  `reindex` (`BUILD INDEX` over deferred indexes) and `kill` (a request id), each requiring a target.
- Full reference: [`docs/providers/couchbase.md`](providers/couchbase.md).

---

##### ClickHouse Query Format

ClickHouse speaks ordinary SQL over its HTTP interface, so the `sql` field carries a plain
statement — no JSON envelope, the same as PostgreSQL or MySQL. Two things differ from the other SQL
providers:

- A statement ending in an explicit `FORMAT ...` or `SETTINGS ...` clause is sent unchanged: the
  server rejects a `LIMIT` appended after either, so the auto-limiter skips injection and
  `wasLimited` is `false` for those statements.
- `written_rows` is the only mutation count the server reports, so `rowCount` on an
  `ALTER TABLE ... UPDATE` or a lightweight `DELETE FROM` is `0` even though the statement applied —
  this mirrors the server's own reporting, it is not a bug.

```json
{
  "connection": {
    "type": "clickhouse",
    "host": "localhost",
    "port": 8123,
    "user": "default",
    "password": "",
    "database": "default"
  },
  "sql": "SELECT * FROM events LIMIT 50"
}
```

**Notes:**
- `POST /api/db/maintenance` accepts `optimize` (`OPTIMIZE TABLE ... FINAL`), `analyze` (statistics
  from `system.parts`) and `kill` (`KILL QUERY WHERE query_id = ... SYNC`).
- Full reference: [`docs/providers/clickhouse.md`](providers/clickhouse.md).

---

##### Apache Druid Query Format

Druid speaks SQL over `POST /druid/v2/sql`, so the `sql` field carries a plain statement. Three
things differ from the other SQL providers:

- **There is no `database` and no `connectionString`.** `INFORMATION_SCHEMA.SCHEMATA` reports exactly
  one catalog, always `druid`, so a connection is `host` + `port` alone. `user`/`password` are
  optional and are sent as HTTP basic auth for a cluster running `druid-basic-security`; a default
  install ignores the `Authorization` header entirely. `port` is the Router's `8888`; the Broker's
  `8082` serves the identical endpoint and needs no other change.
- **Druid SQL cannot write.** `UPDATE` and `DELETE` are not in the grammar, `CREATE TABLE` is a
  syntax error, and `INSERT` / `REPLACE` are refused by the native engine ("consider using MSQ").
  Each comes back as `400` / `QUERY_ERROR` carrying Druid's own message, which names the reason and
  the alternative. `POST /api/db/maintenance` accepts no operation at all for a `druid` connection.
- **A statement ending in `OFFSET n` with no `LIMIT` is sent unchanged**, so `wasLimited` is `false`:
  Druid rejects `OFFSET n LIMIT m` ("'OFFSET start LIMIT count' is not allowed under the current SQL
  conformance level"), so the auto-limiter must not append one there. Every other statement is
  limited normally.

```json
{
  "connection": {
    "type": "druid",
    "host": "localhost",
    "port": 8888
  },
  "sql": "SELECT * FROM \"libredb_demo\" LIMIT 50"
}
```

**Notes:**
- A duplicate output name (a join projecting two `id`s, say) is disambiguated rather than dropped:
  `fields` carries `id` and `id (2)`, and both columns reach the grid.
- `ORDER BY` on a non-`__time` column of a plain table scan is refused by the planner ("SQL query
  requires ordering a table by non-time column"). Order by `__time`, or aggregate with `GROUP BY`.
- Druid uses Calcite's reserved-word list, which is large and surprising — `SELECT 1 AS one` is a
  syntax error — so every generated identifier is double-quoted.
- Integers wider than 2^53 are returned as exact strings rather than as JSON numbers, so no value is
  silently rounded on the way to the grid. `ARRAY` columns arrive as JSON strings (`"[1,2]"`), which
  is what Druid's own clients show.
- Full reference: [`docs/providers/druid.md`](providers/druid.md).

---

##### Redis Query Format

Redis is a key-value store, so the `sql` field carries a Redis command instead of SQL. Two interchangeable formats are accepted.

**1. Plain command** (whitespace-separated, single/double-quoted arguments preserved):

```json
{
  "connection": {
    "type": "redis",
    "host": "localhost",
    "port": 6379,
    "database": "0"
  },
  "sql": "HGETALL user:1"
}
```

**2. JSON command object:**

```json
{
  "connection": {
    "type": "redis",
    "host": "localhost",
    "port": 6379
  },
  "sql": "{\"command\":\"GET\",\"args\":[\"user:123\"]}"
}
```

**Result shaping** — the response is normalised into the standard `rows` / `fields` / `rowCount` envelope:

| Redis reply | Rendered as |
|-------------|-------------|
| Simple string / status (`GET`, `PING`, `SET`) | single `result` column |
| Integer (`DEL`, `DBSIZE`, `INCR`) | `result` column as `(integer) N` |
| `nil` / empty list | `(nil)` / `(empty list)` |
| Array (`KEYS`, `SMEMBERS`, `LRANGE`) | `index` + `value` columns |
| Hash (`HGETALL`) | `field` + `value` columns |
| `INFO` | `section` + `key` + `value` columns |

**Notes:**
- Schema introspection (`/api/db/schema`) uses a non-blocking `SCAN` and groups keys by prefix, presenting each prefix (e.g. `user:*`) as a "table".
- Monitoring/health endpoints derive their data from `INFO`, `SLOWLOG GET`, and `CLIENT LIST`.
- Invalid JSON, a missing `command` field, or an unknown/failed Redis command returns `400 Bad Request` with code `QUERY_ERROR`.

---

#### POST /api/db/schema

Get database schema including tables, columns, indexes, and foreign keys.

**Authentication:** Required

**Request:**
```json
{
  "id": "conn-123",
  "name": "My Database",
  "type": "postgres",
  "host": "localhost",
  "port": 5432,
  "database": "mydb",
  "user": "admin",
  "password": "secret"
}
```

**Response (200 OK):**
```json
[
  {
    "name": "users",
    "rowCount": 1500,
    "size": "2.4 MB",
    "columns": [
      {
        "name": "id",
        "type": "integer",
        "nullable": false,
        "isPrimary": true,
        "defaultValue": "nextval('users_id_seq')"
      },
      {
        "name": "email",
        "type": "varchar(255)",
        "nullable": false,
        "isPrimary": false
      },
      {
        "name": "created_at",
        "type": "timestamp",
        "nullable": true,
        "isPrimary": false,
        "defaultValue": "CURRENT_TIMESTAMP"
      }
    ],
    "indexes": [
      {
        "name": "users_pkey",
        "columns": ["id"],
        "unique": true
      },
      {
        "name": "users_email_idx",
        "columns": ["email"],
        "unique": true
      }
    ],
    "foreignKeys": [
      {
        "columnName": "org_id",
        "referencedTable": "organizations",
        "referencedColumn": "id"
      }
    ]
  }
]
```

**Response (503 Service Unavailable):**
```json
{
  "error": "Connection failed: ECONNREFUSED"
}
```

---

#### POST /api/db/maintenance

Run database maintenance operations.

**Authentication:** Required (Admin only). No session returns `401`; a valid session with a
non-admin role returns `403` — the two are distinguishable, unlike the combined check some other
admin routes use.

**Request:**
```json
{
  "connection": {
    "id": "conn-123",
    "name": "Production DB",
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "user": "admin",
    "password": "secret"
  },
  "type": "vacuum",
  "target": "users"
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connection` | object | Yes | Database connection configuration |
| `type` | string | Yes | Maintenance operation type |
| `target` | string | No | Target table name or PID (for kill) |

**Maintenance Types:**

| Type | PostgreSQL | MySQL | SQLite | Description |
|------|------------|-------|--------|-------------|
| `vacuum` | VACUUM ANALYZE | - | VACUUM | Reclaim storage and update statistics |
| `analyze` | ANALYZE | ANALYZE | ANALYZE | Update query planner statistics |
| `reindex` | REINDEX | - | REINDEX | Rebuild indexes |
| `optimize` | - | OPTIMIZE | - | Optimize table (MySQL only) |
| `check` | - | CHECK | PRAGMA integrity_check | Check table integrity |
| `kill` | pg_terminate_backend | KILL | - | Terminate a session by PID |

**Response (200 OK):**
```json
{
  "success": true,
  "executionTime": 1234,
  "message": "VACUUM completed successfully"
}
```

**Response (401 Unauthorized):**
```json
{
  "error": "Authentication required"
}
```

**Response (403 Forbidden):**
```json
{
  "error": "Unauthorized. Admin access required."
}
```

**Response (400 Bad Request):**
```json
{
  "error": "Operation 'vacuum' not supported for this database. Supported: analyze, optimize, check, kill"
}
```

The handler validates against the target provider's capabilities: `type` is required (`{ "error": "Maintenance type is required" }`), the provider must support maintenance at all, and the requested operation must be in that provider's supported set (see the matrix above) — otherwise a `400` is returned listing what the provider does support.

A `druid` connection fails the second check whatever the `type` is, with `{ "error": "Maintenance operations not supported for this database" }`: no maintenance operation is reachable from Druid SQL, so its supported set is empty by design. Compaction and retention are Coordinator and task concerns, and Druid publishes no catalog of running queries, so there is no id for `kill` to name.

---

### AI API

All AI endpoints are `POST`, auth-required (via middleware), and stream `text/plain` with chunked
transfer encoding. They share the optional `schemaContext` and `databaseType` fields; the table lists
each one's primary input and purpose.

| Endpoint | Key input | Purpose |
|----------|-----------|---------|
| `POST /api/ai/explain` | `query` (+ optional `explainPlan`) | Explain an EXPLAIN plan and suggest optimizations |
| `POST /api/ai/query-safety` | `query` | Pre-execution risk analysis; streams a JSON verdict (`riskLevel`, `warnings[]`, `recommendation`) |
| `POST /api/ai/describe-schema` | `schemaContext` (+ optional `mode`: `"table"`\|`"database"`) | Auto-generate schema documentation |

Each of the three validates its key field and returns a `400` with an `error` string if it's missing.
The exact strings differ: `explain` and `query-safety` return `"Query is required"`,
`describe-schema` returns `"Schema context required"` — treat the status code, not the message text,
as the contract.

**Provider-surfaced errors**

These come from the configured **LLM provider** (bad API key, quota, safety filter), not from session
auth — session auth is already enforced by the middleware before the handler runs.

```json
// 401 Unauthorized
{ "error": "Invalid API key. Please check your configuration." }
// 429 Too Many Requests
{ "error": "AI usage limit reached. Please try again later or check your billing status." }
// 400 Bad Request
{ "error": "The prompt was blocked by safety filters." }
```

**LLM Configuration:**

Configure the AI provider via environment variables:

```env
LLM_PROVIDER=gemini          # gemini, openai, ollama, custom
LLM_API_KEY=your-api-key
LLM_MODEL=gemini-2.5-flash   # Model name
LLM_API_URL=http://localhost:11434/v1  # For ollama/custom
```

---

### Storage API

The write-through storage sync layer (see [`docs/STORAGE.md`](STORAGE.md)). Data is per-user, keyed by the session username.

#### GET /api/storage/config

Public. Returns the active storage configuration so the client can discover whether server-side storage is enabled.

```json
{ "provider": "local", "serverMode": false }
```

`provider` is `"local" | "sqlite" | "postgres"`; `serverMode` is `true` whenever `provider` is not `"local"`.

#### GET /api/storage

Auth required. Returns all stored collections for the current user. `404` if server-side storage is not enabled.

#### PUT /api/storage/{collection}

Auth required. Replaces one collection's data. `collection` must be one of the known `STORAGE_COLLECTIONS`; invalid names or a missing `data` field return `400`.

```json
// Request
{ "data": { } }
// Response
{ "ok": true }
```

#### POST /api/storage/migrate

Auth required. Merges a client's localStorage payload into server storage on first sign-in.

```json
// Response
{ "ok": true, "migrated": ["connections", "queryHistory"] }
```

---

### Connections API

#### GET /api/connections/managed

Auth required. Returns seed/managed connections for the current user's role, with secrets (`password`, `connectionString`) stripped. `cacheHint` is the client cache TTL in ms (`SEED_CACHE_TTL_MS`, default 60000). See [`docs/SEED_CONNECTIONS.md`](SEED_CONNECTIONS.md).

```json
{ "connections": [], "cacheHint": 60000 }
```

---

### Admin API

Both require an **admin** role (enforced in-handler in addition to the middleware); non-admins get `403 { "error": "Unauthorized. Admin access required." }`. `GET`/`POST /api/admin/audit` check the session inline and return that same `403` whether there is no session at all or a valid session with the wrong role — the two are not distinguished. `POST /api/admin/fleet-health` goes through the shared route guard instead and distinguishes them: no session returns `401 { "error": "Authentication required" }`, and only a valid session with a non-admin role returns the `403` above.

#### GET /api/admin/audit

Returns audit events. Optional query params: `type` (filter by event type), `limit` (default 100). Response: `{ "events": [], "total": 0 }`. `POST /api/admin/audit` appends an event (user auto-filled from the session).

Events of type `agent_operation` come from the agent execution path (#328) and additionally carry `correlationId` — the id joining one execution's policy-decision event to its execution-outcome event (a refused operation emits the decision event only, with an `agent_*` reason code). It is opaque and per execution: it identifies neither a user nor a session. On the authoritative stdout line the same value appears as `correlation_id`, and it is omitted entirely from every event that does not set it.

#### POST /api/admin/fleet-health

Body `{ "connections": [...] }`; returns per-connection health `{ "results": [{ connectionId, status, latencyMs, ... }] }`. `400` if `connections` is missing. `401` with no session, `403` with a session that is not an admin — see the note above.

---

> **Internal routes (not part of this public reference).** The frontend also calls several internal `/api/db/*` endpoints that mirror provider internals and change with the UI: `multi-query`, `schema/list`, `schema/relations`, `transaction`, `cancel`, `disconnect`, `test-connection`, `monitoring`, `pool-stats`, `profile`, `provider-meta`, `schema-snapshot`. They're auth-gated by the middleware like everything else; consult the route handlers in `src/app/api/db/` for their shapes.

---

## Data Types

### DatabaseConnection

```typescript
interface DatabaseConnection {
  id: string;              // Unique identifier
  name: string;            // Display name
  type: DatabaseType;      // Database type
  host?: string;           // Hostname or IP
  port?: number;           // Port number
  user?: string;           // Username
  password?: string;       // Password
  database?: string;       // Database name (Couchbase: the bucket; Druid: unused, it has one catalog)
  connectionString?: string; // Full connection string (alternative; Druid has no URI form, host + port only)
  createdAt: Date;         // Creation timestamp
}

type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 'oracle' | 'mssql' | 'libredb' | 'couchbase' | 'clickhouse' | 'druid';
```

### TableSchema

```typescript
interface TableSchema {
  name: string;            // Table name
  columns: ColumnSchema[]; // Column definitions
  indexes: IndexSchema[];  // Index definitions
  foreignKeys?: ForeignKeySchema[];
  rowCount?: number;       // Approximate row count
  size?: string;           // Table size (e.g., "2.4 MB")
}

interface ColumnSchema {
  name: string;            // Column name
  type: string;            // Data type
  nullable: boolean;       // Allows NULL
  isPrimary: boolean;      // Primary key
  defaultValue?: string;   // Default value
}

interface IndexSchema {
  name: string;            // Index name
  columns: string[];       // Indexed columns
  unique: boolean;         // Unique constraint
}

interface ForeignKeySchema {
  columnName: string;      // Local column
  referencedTable: string; // Foreign table
  referencedColumn: string; // Foreign column
}
```

### QueryResult

```typescript
interface QueryResult {
  rows: any[];             // Result rows
  fields: string[];        // Column names
  rowCount: number;        // Number of rows returned
  executionTime: number;   // Execution time in ms
  explainPlan?: any;       // Query execution plan (if requested)
  warnings?: QueryWarning[];             // Notices the engine attached; ABSENT when it reported none
  columnTypes?: Record<string, string>;  // Declared type per column, keyed by its name in `fields`
}

interface QueryWarning {
  message: string;         // The notice, as the engine worded it
  code?: number | string;  // The engine's own identifier, when it reported one
}
```

Both optional channels are filled only by providers whose source declares them, and **absence is the
signal**: a run that produced no warnings omits the field rather than sending `[]`, so a client can
decide what to render from the field's presence alone. `columnTypes` is the declared type of *this*
result, which is the only source for a computed column or an ad-hoc projection — the schema has no
catalog entry to answer with.

### HealthInfo

```typescript
interface HealthInfo {
  activeConnections: number;
  databaseSize: string;
  cacheHitRatio: string;
  slowQueries: SlowQuery[];
  activeSessions: ActiveSession[];
}

interface SlowQuery {
  query: string;           // Query text (truncated)
  calls: number;           // Number of executions
  avgTime: string;         // Average execution time
}

interface ActiveSession {
  pid: number | string;    // Process/Session ID
  user: string;            // Database user
  database: string;        // Database name
  state: string;           // Session state
  query: string;           // Current query
  duration: string;        // Query duration
}
```

---

## Error Handling

### HTTP Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `400` | Bad Request - Invalid parameters or query syntax |
| `401` | Unauthorized - Missing or invalid authentication |
| `403` | Forbidden - Insufficient permissions, or the request's Origin does not match this deployment (`ORIGIN_MISMATCH`) |
| `408` | Request Timeout - Query exceeded time limit |
| `429` | Too Many Requests - Rate limit exceeded. Applies to `POST /api/auth/login` and every session-guarded route (see "Rate Limiting" below), not only the AI endpoints |
| `499` | Client Closed Request - Query cancelled by the client |
| `500` | Internal Server Error |
| `502` | Bad Gateway - LLM streaming failure |
| `503` | Service Unavailable - Database connection failed or LLM misconfigured |

### Error Response Format

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE"
}
```

### Error Codes

These are the values of the `code` field emitted by `createErrorResponse` (`src/lib/api/error-codes.ts`):

| Code | Description |
|------|-------------|
| `QUERY_ERROR` | SQL syntax or execution error (400) |
| `QUERY_CANCELLED` | Query cancelled by the client (499) |
| `CONFIG_ERROR` | Invalid database configuration (400) |
| `AUTH_ERROR` | Authentication failed (401) |
| `TIMEOUT_ERROR` | Query exceeded time limit (408) |
| `CONNECTION_ERROR` | Database connection failed (503) |
| `POOL_EXHAUSTED` | Connection pool exhausted (503) |
| `DATABASE_ERROR` | Generic database error (500) |
| `LLM_SAFETY` | Prompt blocked by safety filters (400) |
| `LLM_AUTH` | Invalid LLM API key (401) |
| `LLM_RATE_LIMIT` | LLM usage/rate limit reached (429) |
| `LLM_CONFIG` | LLM misconfigured (503) |
| `LLM_STREAM` | LLM streaming failure (502) |
| `LLM_ERROR` | Generic LLM error |
| `INTERNAL_ERROR` | Unhandled server error (500) |
| `NETWORK_ERROR` | Network failure |
| `RATE_LIMITED` | Application-level rate limit exceeded (429) - see "Rate Limiting" below |

The Origin-mismatch 403 (see "CSRF: Origin Check" below) is not in this table: it is returned
directly by the request middleware (`src/proxy.ts`), before a request ever reaches
`createErrorResponse`, and carries `code: "ORIGIN_MISMATCH"` instead of one of the codes above.

---

## Rate Limiting

The application enforces its own request-rate limits, independent of and in addition to whatever
limits the underlying LLM provider applies. A rate-limited request always gets:

- HTTP `429`
- `code: "RATE_LIMITED"` in the JSON body
- A `Retry-After` header naming the number of seconds until the window resets

```json
{
  "error": "Too many requests. Try again in 42 seconds.",
  "code": "RATE_LIMITED",
  "statusCode": 429,
  "retryable": true
}
```

### Login

`POST /api/auth/login` is limited two ways at once: per client address (5 failed attempts per 300
seconds by default) and per submitted account, keyed on a hash of the email so it cannot be evaded
by rotating the client address (20 failed attempts per 300 seconds by default). A successful login
clears both counters for that request's keys. Both are configurable - see `RATE_LIMIT_LOGIN_MAX`
and `RATE_LIMIT_LOGIN_ACCOUNT_MAX` in `.env.example`. A body that fails to parse as JSON spends the
per-address budget the same way a wrong password does - it is checked and charged before the body
is read, so it cannot bypass the limit the way it would if parsing happened first - but it cannot
spend the per-account budget, since that key comes from a body there was nothing to extract.

### Every session-guarded route

Every route that reaches a database or an LLM provider shares one of two rate-limit buckets, keyed
on the signed-in session, not the client address. The families rather than a total, because a route
can join a bucket two ways — through its session guard, or by spending the bucket directly — and a
single number written here has gone stale every time it was updated:

| Bucket | Applies to | Default |
|--------|-----------|---------|
| `ai` | The `/api/ai/*` routes, plus every `/api/agent/*` route except `GET /api/agent/config`: starting a run, driving one, reading one, cancelling one, streaming one, and fetching an artifact | 20 requests / 60 seconds |
| `query` | Every database-reaching `/api/db/*` route plus `/api/admin/fleet-health`, together | 120 requests / 60 seconds |

Routing the same workload through a different endpoint does not multiply the budget - the bucket is
shared across every route it applies to. All limits are configurable through the `RATE_LIMIT_*`
environment variables documented in `.env.example`; setting a `*_MAX` variable to `0` disables that
bucket.

### AI Endpoint (provider-side limits)

Independent of the application-level `ai` bucket above, LLM API calls are also subject to whatever
limits the underlying provider itself enforces:

| Provider | Limits |
|----------|--------|
| Gemini | 15 RPM (free tier) |
| OpenAI | Varies by plan |
| Ollama | No limits (local) |

A provider-side limit surfaces as `LLM_RATE_LIMIT` (429), distinct from this application's own
`RATE_LIMITED` (429) above - both use the same HTTP status, but the `code` field tells them apart.

### Database Operations

Database operations have a default timeout of 60 seconds (`DEFAULT_QUERY_TIMEOUT`).

---

## CSRF: Origin Check

Every `POST`, `PUT`, `PATCH` and `DELETE` must carry an `Origin` (or, failing that, a `Referer`)
whose host matches this deployment's own host, or the request is refused with `403` and
`code: "ORIGIN_MISMATCH"` - a second layer behind the session cookie's `SameSite=Lax`, and the only
layer on `POST /api/auth/login`, which carries no session cookie yet. There is no way to disable
this check.

**The cURL and fetch examples below keep working without changes.** A request that carries neither
`Origin` nor `Referer` is still allowed when its `Content-Type` is exactly `application/json` - the
one shape a cross-site browser cannot forge (an HTML `<form>` cannot set that content type at all,
and a cross-site `fetch()` that does triggers a CORS preflight this deployment never answers). Every
example below already sends `Content-Type: application/json` and no `Origin`, so all of them are
unaffected. **A caller who drops that header** - and does not substitute an explicit
`Origin: <this deployment's public origin>` - **gets refused with a 403** where it previously
succeeded. Non-browser integrations that cannot set `Content-Type: application/json` (a webhook
sender, for instance) must send `Origin: <this deployment's public origin>` instead.

A deployment behind a reverse proxy that rewrites the `Host` header to an internal name must set
`ALLOWED_ORIGINS` to its public origin (see `.env.example`), or every state-changing request -
including login - is refused this way.

---

## Examples

### cURL Examples

#### Login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@libredb.org", "password": "admin123"}' \
  -c cookies.txt
```

#### Execute Query
```bash
curl -X POST http://localhost:3000/api/db/query \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "connection": {
      "id": "1",
      "name": "Local PG",
      "type": "postgres",
      "host": "localhost",
      "port": 5432,
      "database": "mydb",
      "user": "postgres",
      "password": "postgres"
    },
    "sql": "SELECT * FROM users LIMIT 10"
  }'
```

#### Get Schema
```bash
curl -X POST http://localhost:3000/api/db/schema \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "id": "1",
    "name": "Local PG",
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "user": "postgres",
    "password": "postgres"
  }'
```

#### AI Explanation of a Plan
```bash
curl -X POST http://localhost:3000/api/ai/explain \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "query": "SELECT country, count(*) FROM users GROUP BY country",
    "explainPlan": "HashAggregate ... Seq Scan on users",
    "databaseType": "postgres",
    "schemaContext": "users(id, name, country, created_at)"
  }'
```

#### Health Check
```bash
curl http://localhost:3000/api/db/health
```

#### Run Maintenance (Admin)
```bash
curl -X POST http://localhost:3000/api/db/maintenance \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "connection": {
      "id": "1",
      "name": "Local PG",
      "type": "postgres",
      "host": "localhost",
      "port": 5432,
      "database": "mydb",
      "user": "postgres",
      "password": "postgres"
    },
    "type": "vacuum",
    "target": "users"
  }'
```

### JavaScript/TypeScript Examples

```typescript
// Login and execute query
async function executeQuery(sql: string) {
  // Login
  await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@libredb.org', password: 'admin123' }),
    credentials: 'include'
  });

  // Execute query
  const response = await fetch('/api/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      connection: {
        id: '1',
        name: 'My DB',
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'mydb',
        user: 'postgres',
        password: 'postgres'
      },
      sql
    })
  });

  return response.json();
}

// Stream an AI explanation of a plan
async function streamAIExplanation(query: string, explainPlan: string) {
  const response = await fetch('/api/ai/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      query,
      explainPlan,
      databaseType: 'postgres',
      schemaContext: 'users(id, name, email)'
    })
  });

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;
    console.log(decoder.decode(value));
  }
}
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Recommended | JWT signing secret (min 32 chars). Auto-generated at boot if unset unless `AUTH_BOOTSTRAP=off` (see `.env.example`). Set but shorter than 32 chars: the server exits at startup with code 1 rather than serving a deployment whose logins all fail with 503 |
| `ADMIN_PASSWORD` | Recommended | Admin account password. Auto-generated and printed once at boot if unset unless `AUTH_BOOTSTRAP=off` |
| `ADMIN_EMAIL` | No | Admin login email (default `admin@libredb.org`) |
| `USER_PASSWORD` | No | Optional lower-privilege account password; the `user` account exists only when this is set |
| `USER_EMAIL` | No | Regular-user login email (default `user@libredb.org`, only used when `USER_PASSWORD` is set) |
| `LLM_PROVIDER` | No | AI provider: gemini, openai, ollama, custom |
| `LLM_API_KEY` | No | AI provider API key |
| `LLM_MODEL` | No | AI model name |
| `LLM_API_URL` | No | Custom AI endpoint URL |

---

## Changelog

API changes ship with the product releases; see the
[GitHub releases](https://github.com/libredb/libredb-studio/releases) for the
per-version changelog instead of a manually maintained copy here.

---

**Last Updated:** 2026-07-04
