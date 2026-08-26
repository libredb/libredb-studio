# LibreDB Studio API Documentation

> **Version:** 0.11.0
> **Base URL:** `https://your-domain.com` or `http://localhost:3000`
> **Content-Type:** `application/json`

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [API Endpoints](#api-endpoints)
  - [Auth API](#auth-api)
  - [Database API](#database-api)
  - [AI API](#ai-api)
  - [Agent API](#agent-api)
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

LibreDB Studio provides a RESTful API for database management operations. The API supports PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Apache Trino, and Redis.

### Key Features

- **JWT Authentication** - Secure token-based authentication stored in HTTP-only cookies
- **Multi-Database Support** - PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Apache Trino, Redis
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

The middleware (`src/proxy.ts`) gates every route: all of them require a valid `auth-token` cookie **except** the routes below. It is an optimisation rather than the authorization boundary, though — every handler that reaches a database or a model provider verifies the session again itself, through `guardRoute` (`src/lib/api/require-session.ts`), which is also where the rate-limit bucket and the audit line come from.

- `/api/auth/*` — login, logout, me, and OIDC login/callback
- `/api/db/health` — excluded from the middleware for **both** methods; `GET` is fully public, while `POST` performs its own session check and returns JSON `401` if unauthenticated
- `GET /api/storage/config` — storage-mode discovery (returns `{ provider, serverMode }`, no user data)

Unauthenticated requests to any other (middleware-gated) route are redirected to `/login`. A few allowlisted handlers self-check instead and return JSON — e.g. `POST /api/db/health` (`401`) and `GET /api/auth/me` (`{ "authenticated": false }`).

**One route is session-less without being public: `POST /api/agent/drive`.** It is deliberately *not* on the list above — a path-shaped exemption would admit anything that can reach the port. It carries a server-minted, single-purpose credential instead, verified by the middleware and again by the handler (see the [Agent API](#agent-api) below).

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
- `distinct` - Distinct values for a field. Takes a **required** top-level `field` key (the driver's
  own parameter name); a missing or non-string one is a `QUERY_ERROR` rather than a silent `_id`, and
  `options.projection` is not an alias for it:
  `{"collection":"products","operation":"distinct","field":"category","filter":{"active":true}}`

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

##### Apache Trino Query Format

Trino speaks SQL over its own client protocol (`POST /v1/statement`, port `8080`), so the `sql` field
carries a plain statement. Four things differ from the other SQL providers:

- **`database` is the CATALOG.** Trino's hierarchy is catalog -> schema -> table, and a connection
  pins one catalog exactly as a PostgreSQL connection pins one database. Schemas inside it are the
  schema level, and every table is named `schema.table`. A statement may still name any other
  catalog in full: `SELECT * FROM other_catalog.some_schema.t` runs unchanged. A connection with no
  catalog runs fully qualified statements fine, but `GET /api/db/schema` refuses with the reason.
- **There is no `connectionString`.** `jdbc:trino://host:port/catalog/schema` exists, but the shared
  parser does not accept it, so a connection is `host` + `port` (+ optional `database`, `username`).
  A **`password` requires `ssl: true`**: the coordinator answers `401 Password not allowed for
  insecure authentication` over plain HTTP even with authentication switched off, so a password on
  an `http://` connection is refused by the provider rather than sent and rejected.
- **No positional parameters.** Trino binds through `PREPARE`/`EXECUTE` and a prepared-statement
  header this client does not send, so a request carrying `params` is refused with that reason
  rather than having its values spliced into the SQL.
- **`OFFSET` comes before `LIMIT`.** Trino's grammar is `[ OFFSET count ] [ LIMIT count ]` and only
  that way round, so the auto-limiter's output is transposed before it is sent. A trailing semicolon
  is a syntax error and is never emitted.

```json
{
  "connection": {
    "type": "trino",
    "host": "localhost",
    "port": 8080,
    "database": "tpch"
  },
  "sql": "SELECT nationkey, name FROM tpch.tiny.nation ORDER BY 1"
}
```

**Notes:**
- A **failed statement arrives as HTTP 200** from the coordinator, with the failure inside the
  document. The provider classifies from the body, never from the status, and surfaces the engine's
  own wording (`line 1:15: Table 'tpch.tiny.nope' does not exist`) without the Java stack that
  travels beside it.
- A duplicate output name is disambiguated rather than dropped: `fields` carries `id` and `id (2)`.
- `columnTypes` are Trino's rendered type strings verbatim: `bigint`, `varchar(25)`,
  `array(integer)`, `row(x integer, y varchar)`. Values are passed through as the wire encodes them
  - `decimal` as a string, `varbinary` as base64, `timestamp` as `2020-01-01 10:00:00.000` in UTC.
- `SET SESSION`, `USE`, `PREPARE` and `DEALLOCATE` succeed and then affect nothing: every statement
  is its own stateless exchange. The response carries a `warning` saying so.
- `POST /api/db/maintenance` accepts `kill` only, and its target is a query id from the sessions
  panel. Nothing else has a Trino analogue: it owns no storage to reclaim, and `ANALYZE` is the
  connector's decision rather than the engine's.
- `POST /api/db/cancel` works: cancelling is `DELETE /v1/query/{id}` and abandoning a request does
  **not** stop the work on the cluster.
- Full reference: [`docs/providers/trino.md`](providers/trino.md).

---

##### Apache Cassandra Query Format

Cassandra speaks CQL over the native protocol (port `9042`), so the `sql` field carries a plain CQL
statement. Five things differ from the other SQL providers:

- **A `localDataCenter` is REQUIRED on the connection.** No other engine here has such a field.
  `cassandra-driver` refuses to construct a client without one (`'localDataCenter' is not defined in
  Client options and also was not specified in constructor`), and names the data centres it did find
  when the value is wrong. A stock single-node install reports `datacenter1`.
- **`database` is the KEYSPACE**, pinned for the session exactly as a PostgreSQL connection pins one
  database. Without it an unqualified table name resolves to nothing (`No keyspace has been
  specified`), and a keyspace that does not exist fails the CONNECT rather than the first statement.
- **There is no `connectionString`**: no URI convention carries `localDataCenter`, so one would parse
  into a connection that cannot open.
- **No positional parameters.** CQL binds `?` through a prepared statement this client does not send,
  so a request carrying `params` is refused with that reason rather than having its values spliced
  into the statement.
- **`OFFSET` does not exist**, so a request with a non-zero `offset` is refused: there is no second
  page to ask for. `ALLOW FILTERING` must stay the last clause, so the auto-limiter's `LIMIT n` is
  moved in front of it, and a statement that would end inside a line comment is sent unrewritten
  (CQL has `//` as well as `--`, and neither may be closed by end of input).

```json
{
  "connection": {
    "type": "cassandra",
    "host": "localhost",
    "port": 9042,
    "database": "probe",
    "localDataCenter": "datacenter1"
  },
  "sql": "SELECT id, name FROM probe.customers WHERE id = 1"
}
```

**Notes:**
- **No row count and no size are reported anywhere** - not in `GET /api/db/schema`, not in the
  overview, and the table, index and storage panels answer `[]`. Cassandra publishes partition
  estimates (measured at 143 for a 500-row clustered table) and whole mebibytes (`1 MiB` for 19,476
  bytes), and neither is a number this API will pass on. See
  [`docs/providers/cassandra.md`](providers/cassandra.md#32-there-is-no-honest-row-count-and-no-honest-size).
- `columnTypes` are the wire's declared CQL types (`int`, `bigint`, `list<int>`, `map<varchar, int>`,
  `duration`, `vector<float, 3>`). A `blob` reaches the client as the JSON shape a `Buffer`
  serializes to and is rendered `\x…` there, the same as every other engine's binary value since
  2026-08-24; a `bigint`/`decimal`/`varint` arrives as its
  exact digits in a string (`Number()` would round them), a `vector` as an array of numbers and a
  `duration` as its CQL literal (`1mo2d3h`).
- A write answers no columns and no row count: the protocol reports neither, so `rowCount` is 0
  rather than an invented figure.
- `POST /api/db/maintenance` accepts NOTHING: every Cassandra maintenance operation (compaction,
  repair, flush, cleanup) is a `nodetool` action on a node over JMX, not a statement.
- `POST /api/db/cancel` answers "cancellation is not supported for this database type": the protocol
  has no cancel frame and CQL has no `KILL`.
- There is no EXPLAIN: the keyword is not in the grammar at all.
- Full reference: [`docs/providers/cassandra.md`](providers/cassandra.md).

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
| `target` | string | No | Target table name or PID (for kill). Also selects the *placement* the request is validated as: absent or empty means whole-database, any name means one object |

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

A fourth `400` gates what the operation may be *pointed at*. Each provider declares that separately
(`maintenanceOperationSpecs`, documented per engine under `docs/providers/`), and `target` selects
which half of the declaration this request is: absent or empty is a whole-database request, a name
is a per-object one. When the provider says that placement is not offered for this operation while
the other one is, nothing is run and the reply names the provider's own wording for the control -
`{ "error": "Vacuum Database takes no target on this database: it runs over the whole database. Omit 'target'." }`
for a targeted SQLite `vacuum`, and the mirror-image *"requires a target"* message for a targetless
operation that has no whole-database form. An operation whose declaration offers *neither* placement
is not refused: its target is a session or query id that neither half describes (every engine's
`kill`), so the request passes through.

A `druid` connection fails the second check whatever the `type` is, with `{ "error": "Maintenance operations not supported for this database" }`: no maintenance operation is reachable from Druid SQL, so its supported set is empty by design. Compaction and retention are Coordinator and task concerns, and Druid publishes no catalog of running queries, so there is no id for `kill` to name.

A `trino` connection passes it for `kill` and fails it for everything else, which is the difference between an empty supported set and a set of one: `CALL system.runtime.kill_query` really terminates a statement (verified end to end - the target then fails `ADMINISTRATIVELY_KILLED`), while vacuum, reindex, optimize, check and analyze all describe work that belongs to the connector behind a catalog rather than to the engine.

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

### Agent API

Seven paths, eight handlers, under `src/app/api/agent/`. They drive the read-only agent runtime — full
behaviour in [`docs/AGENT.md`](AGENT.md), the surface in [`docs/AGENT_GUIDE.md`](AGENT_GUIDE.md), and
what a run sends to a model provider in [`docs/AGENT_DATA_FLOW.md`](AGENT_DATA_FLOW.md).

Three properties hold across the whole family and are not repeated per route:

- **Every handler verifies its own caller.** Middleware is an optimisation, not the authorization
  boundary.
- **A run belongs to the session that opened it.** Ownership is decided against the actor persisted
  in the run's ledger, and an admin is not exempt. Somebody else's run, a run that does not exist and
  a malformed run id all answer the same `404 { "error": "No such agent run" }` — a `403` would
  confirm the id.
- **When the server runs no agents, the run-reaching handlers answer `404`** — after the session
  check, so an unauthenticated caller cannot learn whether an agent surface exists. `GET
  /api/agent/config` is the deliberate exception: `{"enabled": false, …}` *is* its answer.

#### GET /api/agent/config

Whether this server runs agents. **Authentication:** required (`401 { "error": "Authentication
required" }` without a session). Never `500`, and never names a key's value.

```json
// 200 — available
{ "enabled": true, "ledgerVerified": true }

// 200 — not available
{ "enabled": false, "reason": "NO_MODEL_CONFIGURED", "detail": "…" }
```

| Field | Meaning |
|-------|---------|
| `enabled` | A literal boolean. The rail compares `=== true` |
| `ledgerVerified` | `true` when the durable ledger's writable-path probe passed; `false` for the Postgres backend, which is accepted without being contacted |
| `reason` | One code per operator action: `OPERATOR_DISABLED`, `NO_MODEL_CONFIGURED`, `LEDGER_UNAVAILABLE`, `LEDGER_INCOMPATIBLE`, `UNSANCTIONED_WORLD_TARGET`, `IMPLICIT_HOSTED_WORLD`. Sent to every session |
| `detail` | The underlying message. **Admin sessions only** — the ledger codes' carry an absolute server path plus an OS error string or a quoted fragment of a file on that disk. Every other session gets one stable sentence instead |

This route is **not** metered out of the `ai` bucket: a visibility probe must not spend a run's
budget. Its ledger half is memoised for a few seconds instead.

---

#### POST /api/agent/classify

Names the workflow an objective would open as, without opening anything. The surface calls it
between the user pressing Start and the run being created, so that a run whose workflow nobody chose
still opens as the right one.

**Authentication:** Required.

**Request:**

```json
{ "objective": "Why is the orders page slow?" }
```

`objective` is required, non-empty, and bounded by the same 4000 characters `POST /api/agent/runs`
applies — an objective this route would classify but that one would refuse is a model call spent on
a run that cannot open.

**Response (200 OK):**

```json
{ "workflowType": "query-optimization", "outcome": "classified" }
```

| Field | Meaning |
|-------|---------|
| `workflowType` | One of the five ids `POST /api/agent/runs` accepts |
| `outcome` | `"classified"` when the model named one of the five; `"unclassified"` when it did not |

**There is no failure response for the classification itself.** A model error, a timeout, an empty
reply and a reply that is not one of the five ids all answer `200 { "workflowType":
"investigation", "outcome": "unclassified" }`. The run the user is starting has to open either way,
so this route never blocks one; `outcome` is what stops a surface from presenting that fallback as a
verdict.

This route **decides nothing**. The caller remains free to send any workflow it likes to `POST
/api/agent/runs`, which validates it there as it always has — so skipping this route, or ignoring
its answer, reaches nothing a caller could not reach without it. It is metered out of the `ai`
bucket like the run routes, because classification doubles the per-run request count against the
model provider.

**Refusals:** `400` for a missing, non-string, empty or oversized `objective`; `401` without a
session; `404` when this server runs no agents.

---

#### POST /api/agent/runs

Opens a run and returns immediately; the drive happens in the background.

**Authentication:** Required.

**Request:**

```json
{
  "mode": "agent",
  "workflowType": "investigation",
  "objective": "Which department has the most employees?",
  "connectionId": "seed:sample"
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | string | Yes | `"planning"` or `"agent"`. A planning run's model is handed no tools and the run executes **no statement of yours and writes nothing**; it does not perform zero database operations — since 2026-08-15 the server reads the connection's schema — its catalog on PostgreSQL and SQLite, its provider's own inspection on every other engine — and the engine's estimated statistics where it holds any (PostgreSQL and SQLite), before the first turn, read-only and audited like every other agent read |
| `workflowType` | string | No | `"investigation"` (the default), `"query-optimization"`, `"database-assessment"`, `"operations"` or `"data-analysis"`. An unrecognised value is **refused, not defaulted** |
| `workflowSource` | string | No | How the workflow above was decided: `"inferred"` (a classifier read it off the objective) or `"chosen"` (a person picked it). Absent means `"chosen"`, which is what every request written before there was a classifier did. An unrecognised value is **refused, not defaulted**, because the surface reads this field back to decide whether to tell the user their workflow was inferred and offer to change it |
| `workflowReading` | string | No | How that decision WENT, as against who made it: `"classified"` (a classifier named this workflow), `"unclassified"` (a classifier was asked and reached its fallback) or `"unrecorded"` (nothing classified anything — what a caller naming its own workflow sends). Absent means `"unrecorded"`. An unrecognised value is **refused, not defaulted**, for the reason `workflowSource` is: the surface reads this field back to choose which of three sentences it says about the run, and a fallback presented as a verdict is the one it may not say |
| `objective` | string | Yes | Non-empty, at most 4000 characters |
| `connectionId` | string | Yes | Must resolve **server-side**. An inline `connection` object in the body is refused |
| `previousRunId` | string | No | Continue the **conversation** a run this session opened belongs to. The server derives the earlier steps' objectives and the most recent step's report from those runs' own ledgers, verifies the named run belongs to this session, is on this connection and has ended, and persists the result as `thread` on the new run's header. A run it cannot reach **does not refuse the start**: the run opens carrying no conversation and the response says so through `thread.declined`. Only a value that is not a non-empty string is refused, with `400` — that is a malformed request rather than a runtime condition |

**Response (202 Accepted):**

```json
{
  "runId": "arun_…",
  "status": "queued",
  "mode": "agent",
  "workflowType": "investigation",
  "workflowSource": "chosen",
  "workflowReading": "unrecorded"
}
```

The mode, workflow type, workflow source and workflow reading echoed back are the **persisted**
ones, so a caller that omitted any of the workflow fields learns what its run actually opened as.
All four are fixed for the life of the run: no other route accepts any of them. Changing a run's workflow therefore means
cancelling it and opening a new one — there is deliberately no parameter through which a workflow
could arrive twice.

**Refusals:**

```json
// 400 Bad Request — one message per rule, e.g.
{ "error": "mode must be \"planning\" or \"agent\"" }
{ "error": "An agent run needs a server-resolvable connectionId; an inline connection cannot be resumed" }
{ "error": "previousRunId must be a non-empty string when provided" }

// 404 Not Found — this server runs no agents
{ "error": "The agent runtime is not enabled on this server" }

// 422 Unprocessable Entity — the configured model was ESTABLISHED as unable to drive an agent run
{
  "error": "The model \"gemma3:270m\" (ollama) cannot drive an agent run: …",
  "missing": ["toolCalling", "structuredOutput", "streaming"],
  "disproved": []
}
```

> `422` rather than `400`: the request is well-formed and it is the server's configuration that
> cannot honour it. Only a **positively established** incapability refuses this way — a bad key, a
> quota or a 5xx start the run and are reported by the drive instead. `missing` is what this run
> needed and did not get; `disproved` is the subset the probe watched fail. A `planning` run is never
> probed at all.

---

#### GET /api/agent/runs/{runId}

The run record, folded from its ledger: status, mode, workflow type, actor, events. `404` unless the
run exists and belongs to the calling session.

#### DELETE /api/agent/runs/{runId}

Requests a stop, and returns the run's status report. Cancellation is enforced by the run loop's own
persisted state rather than by a driver cancel propagating — so this means *asked to stop*, not *has
stopped*.

#### GET /api/agent/runs/{runId}/stream

The ledger as NDJSON — `content-type: application/x-ndjson; charset=utf-8`, one entry per line, in
order. This is what the rail folds into its timeline.

#### GET /api/agent/runs/{runId}/artifacts/{correlationId}

One stored result of that run, for hydration into the results grid.

```json
{ "runId": "arun_…", "correlationId": "…", "operationId": "sql.query.read", "result": { } }
```

`404 { "error": "No such artifact" }` when the run's ledger records no completed step with that
correlation id. `410` when it does but the rows are gone:

```json
{ "error": "This result is no longer held: a run's results are released when it ends.", "reason": "released" }
```

#### POST /api/agent/runs/{runId}/handover

Runs the statement that run answered with, in the user's editor, under the **engine's own read-only
boundary** — `BEGIN READ ONLY` on PostgreSQL, `PRAGMA query_only` on SQLite — at the editor's default
500-row limit and with no statement timeout. It exists because the alternative is the ordinary
`POST /api/db/query`, a read-write session where a `SELECT` calling a VOLATILE function that writes
succeeds; no inspection of the statement's text can tell the two apart.

**The request carries no body.** The statement is read from the run's own `answer-composed` event and
the connection from the run's persisted `connectionId`, resolved under the run's persisted actor — so
this is not an endpoint that will run SQL it is handed, and nothing a user types can reach the
profile it runs under.

```json
{ "runId": "arun_…", "sql": "SELECT …", "result": { "rows": [], "fields": [], "rowCount": 0 } }
```

`404 { "error": "This run composed no answer" }` when the run never presented one. `409` when it did
and the auto-execute gate declined it (`handover` is `applied` or `none`), with the gate's own
warning in the message — the statement belongs in the editor unrun, and this route will not do what
the run decided against. A row or byte budget overrun **refuses** rather than truncating, exactly as
the agent's own read path does.

#### POST /api/agent/drive

The machine-facing resume seam. **It carries no session.** The caller presents a short-lived
(60-second), single-purpose credential this server minted, in the `x-libredb-agent-drive` header;
it names one run, authorizes one thing — driving it — and its signing key is *derived* from
`JWT_SECRET` rather than being it, so a drive token cannot be presented as a session cookie. Without
one: `401 { "error": "A valid agent drive credential is required" }`, audited as a
`permission_denied` event. `404` for an unknown run, `409` for a run that has already ended (the
message is not retryable, so a queue should stop delivering it).

Nothing in the product produces a drive delivery yet, so this route's callers today are its tests.

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

A failure the endpoint attributes to its **own seed configuration** says so, so a client can tell
"the server serves no seeds" (a `200` with an empty `connections`) from "the server could not read
its seeds":

```json
{ "error": "Failed to load managed connections", "reason": "seed-config-unreadable" }
```

`500` with `reason: "seed-config-unreadable"` means `seed-connections.yaml` could not be read or
parsed. A `500` **without** `reason` is any other failure of the request and is not a claim about
that file. The browser holds the second as an unread seed list rather than an empty one, which is
what stops the agent rail reporting a connection's settings as browser-local when the server's own
configuration is what failed.

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
  database?: string;       // Database name (Couchbase: the bucket; Druid: unused, it has one catalog; Trino: the CATALOG; Cassandra: the KEYSPACE)
  connectionString?: string; // Full connection string (alternative; Druid has no URI form, host + port only; Cassandra has none either, no URI carries localDataCenter)
  localDataCenter?: string; // Cassandra only, and REQUIRED there: the driver refuses to connect without it (`datacenter1` on a stock single node)
  authSource?: string; // MongoDB only: the database the credentials live in (`?authSource=admin`). Not the database being opened - without it the driver checks the user against that one, which fails as a credentials error
  createdAt: Date;         // Creation timestamp
}

type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 'oracle' | 'mssql' | 'libredb' | 'couchbase' | 'clickhouse' | 'druid' | 'elasticsearch' | 'opensearch' | 'trino' | 'cassandra';
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
| `ai` | The `/api/ai/*` routes, plus every `/api/agent/*` route except `GET /api/agent/config`: classifying an objective, starting a run, driving one, reading one, cancelling one, streaming one, and fetching an artifact | 20 requests / 60 seconds |
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
| `LLM_API_URL` | No | Custom AI endpoint URL. Read for the `openai`, `ollama` and `custom` kinds, on the chat surface and in the agent alike; **unread for `gemini`** ([`docs/BACKLOG.md`](BACKLOG.md) B20) |
| `LIBREDB_AGENT_ENABLED` | No | The agent's explicit **off**-switch. Availability is otherwise derived from the AI configuration and a writable ledger — see [`docs/AGENT.md`](AGENT.md) |
| `WORKFLOW_TARGET_WORLD` | No | Durable backend for agent run state: `local` (default, single instance) or `@workflow/world-postgres` |
| `WORKFLOW_LOCAL_DATA_DIR` | No | Where the `local` backend keeps run state (`/app/data/workflow` in the container image) |

---

## Changelog

API changes ship with the product releases; see the
[GitHub releases](https://github.com/libredb/libredb-studio/releases) for the
per-version changelog instead of a manually maintained copy here.

---

**Last Updated:** 2026-08-14
