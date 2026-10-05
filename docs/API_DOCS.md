# LibreDB Studio API Documentation

> **Version:** 0.16.2
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
  - [MCP API](#mcp-api)
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

LibreDB Studio provides a RESTful API for database management operations. The API supports PostgreSQL, MySQL, SQLite, libSQL, DuckDB, Oracle, Db2 LUW, SQL Server, MongoDB, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Trino, Apache Cassandra, Redis, Prometheus, InfluxDB (InfluxQL), InfluxDB 3 (SQL), Apache Kafka, etcd, Neo4j, Milvus, Qdrant and Oxia.

### Key Features

- **JWT Authentication** - Secure token-based authentication stored in HTTP-only cookies
- **Multi-Database Support** - Twenty-six engines: PostgreSQL, MySQL, SQLite, libSQL, DuckDB, Oracle, Db2 LUW, SQL Server, MongoDB, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Trino, Apache Cassandra, Redis, Prometheus, InfluxDB (InfluxQL), InfluxDB 3 (SQL), Apache Kafka, etcd, Neo4j, Milvus, Qdrant, Oxia
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

- `/api/auth/*`: login, logout, me, OIDC login/callback, `POST /api/auth/passkey/sign-in` and `POST /api/auth/launch`, which create the session and so cannot need one; the other auth routes that act on an account (`/api/auth/totp`, `/api/auth/passkey`) check the session themselves
- `/launch`: the page a platform's launch link opens; it posts the token from its URL fragment to `POST /api/auth/launch`, after a Continue click when the browser has no session ([LAUNCH.md](./LAUNCH.md))
- `/health` and `/api/health` — liveness, fully public, no dependencies
- `/api/db/health` — excluded from the middleware for **both** methods; `GET` is fully public and answers the same as the two above, while `POST` performs its own session check and returns JSON `401` if unauthenticated
- `GET /api/storage/config` — storage-mode discovery (returns `{ provider, serverMode }`, no user data)

Without a session, or with one that no longer verifies (expired, signed with a rotated `JWT_SECRET`, tampered), the middleware answers any other API route with `401 { "error": "Authentication required" | "Session expired. Sign in again.", "code": "AUTH_REQUIRED" }`, and any other page with a redirect to `/login?next=<the page's path and query>`, or to a bare `/login` from the bare root `/`, so signing in returns to the page asked for, a `/?connection=<id>` link included; a visitor who already holds a valid session and opens such a sign-in address goes straight to its `next` page, judged by the rules below. API routes used to get the redirect too, which a `fetch` follows to the sign-in page's HTML (#1420). Every route-level session check answers the same `AUTH_REQUIRED` code, which is distinct from `AUTH_ERROR` (a database refused its credentials) and `LLM_AUTH` (a model provider refused its key): those two are `401` as well, with the Studio session intact. A few allowlisted handlers self-check instead and return JSON, for example `POST /api/db/health` (`401`) and `GET /api/auth/me` (`{ "authenticated": false }`).

The standalone app's browser code reacts to `AUTH_REQUIRED`, and only to it, by sending the tab to `/login?next=<the page it was on>`; signing in again, with a password, a passkey or OIDC, returns there. `next` is honoured only as an app-relative path, judged on the path it resolves to rather than the string as written (so `/..//host` and `/%2e%2e//host`, which resolve to `//host`, are refused): it must stay on this origin, must not resolve to a path starting `//` or to `/login`, holds no backslash or control character, and is at most 1024 UTF-8 bytes. The resolved form is what is used; anything else falls back to the role's landing page. One redirect per ten seconds per tab: a second refusal inside that window stays on the page as an error, so a session the server refuses while its cookie still verifies cannot loop between the editor and `/login`. An application that embeds the published `@libredb/studio` components gets no such redirect: the 401 reaches its own code unchanged, and handling sign-in stays with the host.
`/api/mcp` is the exception: without a valid bearer token it answers 401 with `WWW-Authenticate`, never a redirect (see the [MCP API](#mcp-api) below).

**Two routes are session-less without being public: `POST /api/agent/drive` and `/api/mcp`.**
Neither is on the list above, because a path-shaped exemption would admit anything that can reach the port.
Each carries a server-minted credential of its own instead, verified by the middleware and again by the handler: the drive callback a single-purpose credential (see the [Agent API](#agent-api) below), and the MCP endpoint a scoped bearer token (see the [MCP API](#mcp-api) below).

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

> The `user` object is the JWT session payload (`role`, `username`, and `sessionVersion` for an account in the server store). It is a public route in the middleware but self-checks the cookie, returning `{ "authenticated": false }` when absent/invalid.
> With `STORAGE_PROVIDER=sqlite` or `postgres` and local sign-in, a session whose stored account was disabled, deleted, demoted or password-reset since it was issued also answers `401`.

#### GET /api/auth/totp

The signed-in account's own second factor.
Answers `{ "available": true, "enabled": false }` for an account in the server store, or `{ "available": false, "reason": "..." }` under OIDC or `STORAGE_PROVIDER=local`, where setup is not offered here.
`401` without a session.

#### POST /api/auth/totp

Sets up or turns off the signed-in account's own authenticator; the body's `action` picks one.

| `action` | Body | Answer |
|---|---|---|
| `begin` | `{ "password": "<current password>" }` | `{ "secret": "<base32>", "otpauthUrl": "otpauth://..." }`; `409` while a factor is already on |
| `confirm` | `{ "code": "123456" }`, a code from the secret `begin` returned | `{ "ok": true }`; `400` for a wrong or reused code |
| `disable` | `{ "password": "...", "code": "123456" }`; the code only while a factor is on | `{ "ok": true }` |

A missing field is `400`.
A wrong password or code is `401` and is charged to the same two budgets as a failed login, so `429` with `Retry-After` follows once either is spent.
`409` under OIDC or `STORAGE_PROVIDER=local`. See [MFA.md](./MFA.md#when-accounts-live-in-the-server-store).

#### GET /api/auth/passkey

The signed-in account's own passkeys ([PASSKEYS.md](./PASSKEYS.md)).
Every answer of the passkey routes carries `Cache-Control: no-store`.
`401 { "error": "Authentication required", "code": "AUTH_REQUIRED" }` without a session, and `404 { "error": "This session has no account in the registry." }` when the session's account row is missing.
`200` answers one of:

```json
{ "available": false, "mode": "oidc", "reason": "Passkeys for this sign-in are managed by your identity provider." }
{ "available": true, "canAdd": true, "origin": "https://studio.example.com", "rpId": "studio.example.com", "totpEnabled": false, "passkeys": [] }
{ "available": true, "canAdd": false, "reason": "Passkeys are off on this server. ...", "totpEnabled": false, "passkeys": [] }
```

`mode` is `"oidc"` or `"local-storage"`.
`canAdd` is `false` while `PASSKEY_ORIGIN` is unset or invalid, with the reason, and the stored passkeys are still listed.
Each passkey is `{ "id", "name", "createdAt", "lastUsedAt", "backupEligible", "backupState", "usable" }`: `id` is the internal id, `lastUsedAt` is `null` before the first use, and `usable` is `false` for a passkey registered under another host name, or `null` while passkeys are off or misconfigured.
No answer carries a credential ID, a public key or a user handle.

#### POST /api/auth/passkey

Adds, renames and removes the signed-in account's passkeys; the body's `action` picks one.
Bodies over 65536 bytes are `413 { "error": "Request body is too large" }`, unparseable ones `400 { "error": "Invalid request body" }`, and an unknown action `400 { "error": "action must be register-options, register-verify, rename or remove" }`.

| `action` | Body | Answer |
|---|---|---|
| `register-options` | `{ "password": "...", "code"?: "123456" }` | `{ "options": PublicKeyCredentialCreationOptionsJSON }`, and sets the `passkey-registration` cookie |
| `register-verify` | `{ "response": RegistrationResponseJSON, "name"?: "..." }` | `{ "passkey": {...} }`; clears the cookie whatever the outcome |
| `rename` | `{ "id": "...", "name": "..." }` | `{ "passkey": {...} }` |
| `remove` | `{ "id": "...", "password": "...", "code"?: "123456" }` | `{ "ok": true }`, and re-issues the caller's session cookie |

`register-options` and `remove` check the current password, and a current code when the account has TOTP.
Without a code on such an account they answer `400 { "error": "Enter a current code from your authenticator app.", "codeRequired": true }`, which no budget charges.
A wrong password or code is `401` and is charged to the same two budgets as a failed login, so `429` with `Retry-After` follows once either is spent.
`register-options` answers `409 "An account holds at most 20 passkeys. Remove one before adding another."` before it checks the password.

`register-verify` answers `400 "The passkey setup expired or belongs to another sign-in. Start again."` for a missing, expired or replayed ceremony, `400 "The passkey could not be verified. Try again."` for a refused response, and `409` for "This passkey is already registered.", "Another passkey was added at the same time. Start again.", the passkey limit, or "The account changed at the same time. Reload the page and try again." when the account's session version moved during the ceremony.
A name is 1 to 64 characters after trimming with no control characters, else `400 "Name a passkey with 1 to 64 characters."`; `register-verify` without one names the passkey "Passkey".
`rename` and `remove` answer `404 "No passkey with that id on your account."` for an id the account does not have.
`remove` ends every other session and MCP token of the account and keeps the caller's through the re-issued cookie; when the session version moved since the request began it removes nothing, re-issues nothing and answers `409 "The account changed at the same time. Reload the page and try again."`.

Every error body is `{ "error": "..." }`.
Every action answers `409` with the reason under OIDC or `STORAGE_PROVIDER=local`; `register-options` and `register-verify` also answer `409` while `PASSKEY_ORIGIN` is unset and `503` naming the variable while it is invalid, while `rename` and `remove` keep working then.
Every addition, rename and removal is an `account` event in the audit log, and so is a wrong password or code, a registration whose ceremony, origin or attestation is refused or that conflicts with another change to the account, and a removal that crosses one; [PASSKEYS.md](PASSKEYS.md#troubleshooting) lists the refusals that are not audited.

#### POST /api/auth/passkey/sign-in

Signs in with a passkey, without an email; no session is needed.

| `action` | Body | Answer |
|---|---|---|
| `options` | `{ "action": "options" }` | `{ "options": PublicKeyCredentialRequestOptionsJSON }` (no `allowCredentials`, `userVerification: "required"`), and sets the `passkey-sign-in` cookie; writes nothing to the store |
| `verify` | `{ "action": "verify", "response": AuthenticationResponseJSON }` | `{ "success": true, "role": "admin" \| "user" }`, and sets the session cookie; clears the ceremony cookie whatever the outcome |

Every refusal answers the same `401 { "success": false, "message": "That passkey could not sign you in. If it was removed from Studio, delete it from your password manager too. Sign in with your password." }`, whatever the reason, and the reason is recorded only in the audit log.
A malformed body is `400 { "success": false, "message": "Invalid request body" }`, an unknown action the same `400`, and a body over 65536 bytes `413 { "success": false, "message": "Request body is too large" }`.
`409 { "success": false, "message": "<reason>" }` under OIDC, with `STORAGE_PROVIDER=local` or while `PASSKEY_ORIGIN` is unset, and `503` with the problem while it is invalid.
Each refusal and each malformed body spends one unit of the `passkey_client` budget, which is checked before the body is read, so `429` follows once it is spent; see [Rate Limiting](#rate-limiting).

#### POST /api/auth/launch

Exchanges a platform launch token for a session; no session is needed ([LAUNCH.md](./LAUNCH.md)).
The `/launch` page posts it with the token from its URL fragment: at once when the browser holds a session, and otherwise only after the person clicks Continue on a page that names the account the token signs into.
With local sign-in the route exists only while `LAUNCH_TOKEN_SECRET` is set; under `NEXT_PUBLIC_AUTH_PROVIDER=oidc` it answers `503`.

**Request:**
```json
{ "token": "<compact JWS>" }
```

| Status | Body | When |
|---|---|---|
| `200` | `{ "success": true, "redirect": "/" }` or `{ "success": true, "redirect": "/?connection=seed%3A<conn>" }` | The token verified; the session cookie is set |
| `400` | `{ "success": false, "message": "Invalid request body" }` | The body is not JSON or carries no non-empty string `token` |
| `401` | `{ "success": false, "message": "<reason>" }` | The token is refused, or its account is disabled |
| `403` | `{ "success": false, "message": "<reason>" }` | The email is `ADMIN_EMAIL`, or with `STORAGE_PROVIDER=local` `USER_EMAIL` while `USER_PASSWORD` is set; in the server store, the account has a password, an authenticator or a passkey, or a launch created it for another `iss` or `sub` |
| `404` | `{ "success": false, "message": "Launch sign-in is not enabled on this server." }` | `LAUNCH_TOKEN_SECRET` is unset or empty and `NEXT_PUBLIC_AUTH_PROVIDER` is not `oidc` |
| `409` | `{ "success": false, "message": "<reason>", "signedInAs": "<current username>", "launchFor": "<token email>" }` | The browser holds a valid session for another account; that session stays and the token is spent |
| `409` | `{ "success": false, "message": "<reason>" }` | The role change would demote the last enabled admin, or crossed another change to the account |
| `413` | `{ "success": false, "message": "Request body is too large" }` | The body is over 8192 bytes |
| `503` | `{ "success": false, "message": "<problem>" }` | `NEXT_PUBLIC_AUTH_PROVIDER=oidc` (`Launch sign-in is not available when NEXT_PUBLIC_AUTH_PROVIDER=oidc.`), the launch variables are misconfigured, the server cannot sign sessions, or more launches arrived in the last minute than the process can remember |

Every answer carries `Cache-Control: no-store`.
The `401` messages name the refusal (expired, already used, issued for a different Studio, not signed for this Studio, and the rest), and the audit log records one reason per refusal; [LAUNCH.md](./LAUNCH.md#audit) lists them.
Each refusal and each malformed body spends one unit of the `login_client` budget, which is checked before the body is read, so `429` follows once it is spent; see [Rate Limiting](#rate-limiting).

---

### Database API

#### GET /health, GET /api/health, GET /api/db/health

Liveness, for load balancers and container orchestration. All three answer the same body and
depend on nothing, so a check reads the same whichever path its platform's form defaults to.
Point a probe at any of them.

They are public in the middleware for a reason worth keeping: an unknown path is redirected
to `/login`, and a check that follows redirects reads `200` from a login page whether or not
the app works. A health path that can answer with a redirect is worse than one that 404s.

For a check scoped to one database connection, use `POST /api/db/health` below — that is a
different question, and a liveness probe that touches a database reports a database outage as
a dead application.

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
  "code": "CONNECTION_ERROR",
  "statusCode": 503
}
```

> A failed health read answers the shared error shape, NOT a `HealthInfo` filled with zeros. This
> block used to show `"activeConnections": 0` beside `"error"`, which is a fabricated measurement in
> a document other people build clients against: the route's failure path is
> `createErrorResponse` (`src/lib/api/errors.ts`) and it never composes a reading.

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

A cell holding NaN, Infinity or -Infinity as a number is answered as the string `"NaN"`, `"Infinity"` or `"-Infinity"`, at any depth inside an array or object cell, because JSON has no form for the three and `JSON.stringify` would write each as `null`, which reads as SQL NULL ([`src/lib/non-finite.ts`](../src/lib/non-finite.ts)).
`POST /api/db/multi-query`, `POST /api/db/transaction`, `GET /api/agent/runs/{runId}/artifacts/{correlationId}`, the agent's row rendering and the MCP serializer write them the same way.
In the rows a word cell cannot be told from a text cell that holds the same word; only `columnTypes`, where the provider declares it, says which one it is.
The JSON export writes the words.
The CSV export writes `NaN` and `Infinity` as they are, and `-Infinity` as `'-Infinity`, because the formula guard prefixes a cell that opens with `-` and is not a plain number.
The SQL INSERT export writes a non-finite JavaScript number, or a word in a column whose `columnTypes` entry is a float type, in the form the dialect reads back, each replayed into the engine on 2026-10-04: PostgreSQL and DuckDB the quoted word (`'NaN'`); SQLite `9e999` and `-9e999`, and NULL for NaN, which SQLite cannot store; Oracle `BINARY_DOUBLE_NAN`, `BINARY_DOUBLE_INFINITY` and `-BINARY_DOUBLE_INFINITY`; every other dialect NULL, as before.
A word in a column with no declared float type is written as the quoted text it is.
A value the engine itself sends as `null` stays `null`: ClickHouse's JSON format does that for `nan` and `inf` unless `output_format_json_quote_denormals` is set, and SQLite stores a NaN as NULL.

The `pagination` object reports the auto-limiting applied by the server.
`limit` is `options.limit` when the caller sent one and 500 otherwise; the app's own tree click sends 50.
`wasLimited` is `true` when the server injected a `LIMIT` the query didn't specify and a row past that limit came back, and also when the provider bounded its own result and reported that bound on the result it returned: the Prometheus provider does so whenever it cut the result, at its series cap, at its matrix cell budget or at its result byte budget, and names each cut in a `warnings` entry (#1085, section 5.4), and the Kafka provider does so whenever its row limit left records unread or its result byte budget or its cell limit cut the result, and names the budget's and the cell limit's cuts in `warnings` entries (#1088, section 5.4), and the etcd provider does so whenever its row limit or its result byte budget stopped a `get` before the end of its range, or ended a watch before its window, and whenever its row limit held a list etcd answers whole (`lease list`, `lease timetolive --keys`, `user list`, `role list`, `user get --detail` and `role get`) to its row limit, and names the stop, or how many entries etcd answered, in a `warnings` entry (#1089, section 5.4).
A value the etcd provider's cell bound cut sets no `wasLimited`: its encoding gains `, cut`, and one `warnings` entry counts the cut values.

A shorter result under an injected cap has `wasLimited: false`.
Under that cap, a result of exactly `limit` rows has `wasLimited: false` and `hasMore: false`: the statement that runs asks for `limit + 1` rows, the extra row is never answered, and only its arrival makes `hasMore` and `wasLimited` true (#1440).
`POST /api/db/transaction` answers a query inside a transaction by the same rule. Because the statement that runs asks for one row more, a `SELECT ... FOR UPDATE` without its own `LIMIT` in a held transaction now locks `limit + 1` rows.
`options.limit` and `options.offset` must be non-negative integers when sent; anything else is answered `400` before a provider is reached.

`hasMore` is `wasLimited && rows.length > limit` over the probed statement, with `wasLimited` read from the server's own limiter alone, and both halves matter.
A bound the provider reported sets `wasLimited` and never `hasMore`, because no `offset` can advance a bound the server did not write.
A statement the server returned **untouched** — one carrying its own `LIMIT n`, or one whose end the limiter declined to cut into — runs identically at every `offset`, because the requested offset is discarded along with the rewrite. `hasMore` is `false` for those however many rows come back, and re-requesting with a higher `offset` would return the same rows again. Where `hasMore` is `true`, re-request with `offset` advanced by the number of rows you received. See [`docs/editor/query-optimization.md`](editor/query-optimization.md).

Not every engine can serve a positive `offset`. Cassandra and Elasticsearch answer one with HTTP 400 rather than silently returning page one; MongoDB, Redis, LibreDB, Prometheus, InfluxDB (InfluxQL), Kafka, etcd, Neo4j, Milvus, Qdrant and Oxia ignore it. `POST /api/db/provider-meta` reports each one's `capabilities.supportsResultPagination`, which is the same flag the app reads before offering its Load More control.

**The database a run reads (optional):**
```json
{
  "connectionId": "seed:test-redis-6380",
  "sql": "GET db1:only:key",
  "database": 3
}
```

`database` is a **non-negative integer** that sits BESIDE the connection, and it is applied *after* the
connection is resolved — which is the whole reason it is its own field rather than a field of
`connection`. A managed connection travels as an id and the server discards whatever the caller
attached to the connection it sent (`resolveConnection`, GHSA-3wh2-8x78), so a `database` merged into
that object reaches no server on a zero-config deployment and the run falls back to the session's
database while the caller believes it named another.

The value it carries is the walk's own number: a key lives in exactly one numbered database and
`GET <key>` cannot name it, so a tab opened under a chosen database sends it here and the statement
runs where the key is. The connection's own `database` field is not rewritten by it. **Absent** is the
ordinary case and the one every statement other than a key read sends.

The field is accepted only where the provider declares `keyScan` and a container level to name, which is Redis: a Redis key space belongs to one numbered database, and a run cannot name that database in its statement.
On an engine that declares no walk it would be a per-run override of an operator-pinned `database` with no walk to justify it, so it is refused rather than quietly honoured.
etcd and Oxia declare the walk and no container level, because one connection is one key space (one etcd cluster, one Oxia namespace), so they refuse the field as well.
The declaration is read without connecting, so each refusal costs no socket, and an unreachable host still answers 400:

| Condition | Status | Body |
|-----------|--------|------|
| `database` present and not a non-negative integer | `400` | `{ "error": "\"database\" must be a non-negative integer" }` — the same sentence `POST /api/db/keys/scan` refuses with, shared in `optionalDatabase` |
| The provider declares no `keyScan` | `400` | `{ "error": "<type> declares no key-space walk: \"database\" names the database a key was walked in, and only an engine that needs such a name accepts it" }` |
| The provider declares `keyScan` and no container level (etcd, Oxia) | `400` | `{ "error": "<type> walks one key space and declares no database level: \"database\" names the numbered database a key was walked in, and this engine has none to name" }` |
| The server has no such database | `400` | `{ "error": "Redis refused database <n>: ERR DB index is out of range", "code": "QUERY_ERROR", "statusCode": 400 }`, never a read of database 0 |

**A connection type's console text bound:**

A connection type can declare a bound on its statement text in UTF-8 bytes, on its row in `src/lib/db/destructive-commands.ts`.
For such a type this route counts the bytes of `sql` after resolving the connection and before reading `params`, building the provider or preparing the statement, so an oversize text opens no socket.
The bound is read after the request body is parsed, because the type that selects it is inside the body.

| Condition | Status | Body |
|-----------|--------|------|
| `sql` is over the declared bound | `413` | `{ "error": "The statement is <n> bytes in UTF-8, over the <limit>-byte limit for this connection type. Shorten it to run it." }`, which never repeats the text |
| `sql` is not a string | `400` | `{ "error": "sql must be a string" }` |

`POST /api/db/multi-query` refuses every connection whose type declares such a bound with `400 { "error": "This connection type runs one statement per request: send it to POST /api/db/query, because this route would split its text into several requests." }`, before it splits anything.
Milvus and Qdrant each declare a bound of 1,048,576 bytes and InfluxDB (InfluxQL) and Oxia one of 65,536 bytes each, and no other shipped engine declares one, so neither answer changes anything for a connection of another type.

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

**`inTransaction` in a transaction `query` answer.** `POST /api/db/transaction` answers its `query` action with `inTransaction`, and `false` there means the server ended the transaction while running the statement: a typed `COMMIT` or `ROLLBACK`, or a statement the engine commits implicitly (MySQL DDL). The answer does not say whether the work was kept, because the server reports the same state after either; the session is released, and a following `rollback` answers 400 "No active transaction" rather than reporting a rollback that undid nothing. A `begin` the server accepts without opening a transaction (RisingWave's `BEGIN`) answers 400 with the reason, and nothing has been held. A `begin` answer carries `stateReported`: `false` when the server opened the transaction without reporting any transaction state (Databend, StarRocks and Apache Doris over the MySQL wire), `true` when it reported an open one, `null` when the provider does not say. A `begin` sent with `requireReportedState: true`, which is what SANDBOX sends, answers 400 on a `stateReported: false` server instead, with nothing left open.

**Several statements in a transaction `query`.** When the `sql` of a `query` action holds more than one statement under the connection's dialect (a fragment of comments only does not count), `POST /api/db/transaction` runs them one by one, in order, on the transaction's connection and stops at the first one that fails. The answer has the shape `POST /api/db/multi-query` gives a script: `multiStatement: true`, `statementCount`, `executedCount`, `hasError`, `statements` with each statement's outcome, and the last result that has rows as `rows`/`fields`, plus `inTransaction`. A failure is part of that 200 answer, not an error status: the statements before it ran inside the transaction and stay there to commit or roll back. There is no `pagination`, because a next page would run every statement again. A request with `params` is one statement, as before. Measured on MySQL 26.7.0 before this: two `UPDATE` lines sent inside BEGIN answered 500 "You have an error in your SQL syntax ... at line 2".

**Query plan (optional):**
```json
{
  "connection": { "type": "mysql", "host": "localhost", "database": "mydb" },
  "sql": "SELECT id, name FROM users WHERE active = true",
  "explain": { "mode": "estimate" }
}
```

`explain` asks for a PLAN of `sql` rather than a run of it, and the server builds the EXPLAIN statement
from the connected provider's own plan format. `mode` is `"estimate"` (describe the statement) or
`"analyze"` (the deeper form, where the dialect has one); it is required, and any other shape is a 400.
The client never sends EXPLAIN text of its own: on the MySQL and PostgreSQL wire families alike the
accepted form is only knowable once connected - the relatives do not share `EXPLAIN FORMAT=JSON` (#574)
or `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` (#597) - and `POST /api/db/provider-meta` answers without
connecting, so the statement is built where the connection is. Which means `explainFormat` can differ
between two connections of the same `type`, and is the field to read rather than the type id.

The 200 response is an ordinary query response plus `explainFormat`, naming the strategy that built the
statement, so a client reads the plan with the strategy that really produced it:

```json
{
  "rows": [{ "EXPLAIN": "{ \"query_block\": { \"select_id\": 1 } }" }],
  "fields": ["EXPLAIN"],
  "rowCount": 1,
  "executionTime": 3,
  "explainFormat": "mysql-json",
  "pagination": { "limit": 500, "offset": 0, "hasMore": false, "totalReturned": 1, "wasLimited": false }
}
```

A `params` array may accompany an explain request. The strategies only prefix the statement, so the
placeholders are the same ones in the same order and the values bind the built statement, which is how a
generated statement that sends its values separately still gets a plan.

`estimate` never executes the statement, on any strategy: on PostgreSQL it is `EXPLAIN (FORMAT JSON)`,
and only `analyze` builds `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, which runs it. The editor asks for
the estimate in the background beside every run of a SELECT, so an executing estimate would run every
SELECT twice; until #1311 the PostgreSQL strategy did exactly that.

A `queryId` may accompany an explain request like any other, and `POST /api/db/cancel` with that id
stops the plan statement on the server. The editor gives its background plan request an id of its own
and cancels it together with the run.

Three refusals, each a 400 that runs nothing:

- `Only a single statement can be explained` when `sql` holds more than one statement, read under the
  connection type's own grammar (a `;` inside a quote or a comment does not count, and neither does a
  trailing one). An EXPLAIN prefixes one statement: handed `SELECT 1; INSERT ...`, PostgreSQL explains
  the SELECT and then runs the INSERT. A text with a quote or comment the grammar cannot close is refused
  the same way, since no boundary can be read in it (`SELECT E'\''; INSERT ...` is two statements to
  PostgreSQL). Refused before a provider is opened (#1311).
- `This server does not support EXPLAIN` when the provider declares `supportsExplain: false` or no plan
  format at all.
- `Only SELECT statements can be explained` when the dialect's strategy declines the statement. The
  original `sql` is never run as a fallback.

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

The query is read as MongoDB Extended JSON, relaxed or canonical, so `filter`, `pipeline`, `update`
and `documents` can name an ObjectId or a Date: `{"_id":{"$oid":"650000000000000000000001"}}`,
`{"created":{"$gte":{"$date":"2020-01-01T00:00:00Z"}}}`. A wrapper must be the only key of its object, and a malformed one is a `QUERY_ERROR`
carrying the reason. Details: [MongoDB provider](providers/mongodb.md#extended-json-in-the-query).

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
  "sql": "SELECT META(d).id AS __id, d.* FROM `travel`.`inventory`.`hotel` AS d",
  "options": { "limit": 50 }
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
  "sql": "SELECT * FROM events",
  "options": { "limit": 50 }
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
  "sql": "SELECT * FROM \"libredb_demo\"",
  "options": { "limit": 50 }
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

##### Trino Query Format

Trino speaks SQL over its own client protocol (`POST /v1/statement`, port `8080`), so the `sql` field
carries a plain statement. Four things differ from the other SQL providers:

- **`database` is the CATALOG.** Trino's hierarchy is catalog -> schema -> table, and a connection
  pins one catalog exactly as a PostgreSQL connection pins one database. Schemas inside it are the
  schema level, and every table is named `schema.table`. A statement may still name any other
  catalog in full: `SELECT * FROM other_catalog.some_schema.t` runs unchanged. A connection with no
  catalog runs fully qualified statements fine, but the object reads refuse with the reason.
- **There is no `connectionString`.** `jdbc:trino://host:port/catalog/schema` exists, but the shared
  parser does not accept it, so a connection is `host` + `port` (+ optional `database` catalog,
  `schema`, and `username`).
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
- **No row count and no size are reported anywhere** - not on a listed object, not in the
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
- Schema introspection (`/api/db/objects/*`) uses a non-blocking `SCAN` and groups keys by prefix, presenting each prefix (e.g. `user:*`) as a "table".
- Monitoring/health endpoints derive their data from `INFO`, `SLOWLOG GET`, and `CLIENT LIST`.
- Invalid JSON, a missing `command` field, or an unknown/failed Redis command returns `400 Bad Request` with code `QUERY_ERROR`.

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
  "target": "users",
  "container": "app"
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connection` | object | Yes | Database connection configuration |
| `type` | string | Yes | Maintenance operation type |
| `target` | string | No | Target table name or PID (for kill). Also selects the *placement* the request is validated as: absent or empty means whole-database, any name means one object |
| `container` | string | No | The container the target lives in, as the row carries it in `schemaName`: the schema on PostgreSQL and SQL Server, the database on ClickHouse, the bucket on a document store. A non-string value (an object, a number, an array, `null`) returns `400`. Absent or empty means the request names no container and the provider falls back to its own reading of `target` |

`container` is what disambiguates a target whose namespace the name alone cannot settle:
`app.orders` and `public.orders` carry the same `target` and different `container` values, and the
provider qualifies with it rather than splitting the name. Engines with one attached namespace
(SQLite, libSQL, Trino's query-id `kill`) ignore it; each provider's own meaning is in
`docs/providers/<engine>.md`. The maintenance audit event records it beside `target`.

Every request that reaches the provider's `runMaintenance` writes one audit event, of type `kill_session` for `kill` and `maintenance` otherwise.
A run the engine completed records `result: "success"`, and a run the engine answered with `success: false` records `result: "failure"` with no reason.
A run that throws records `result: "failure"` with the reason `maintenance_execution_failed` and the time the call took, never the thrown message, and the response is the one the thrown error maps to, as it was before the event existed.
A request refused before the provider is called writes no maintenance event.
An event also carries `engineUser`, the engine principal the connection acts as, when the provider implements the optional `engineUser()` method: on the completed, the failed (`success: false`) and the thrown rows alike.
It is a user name and never any part of a secret.
On the authoritative stdout line, `libredb.audit.v1`, it appears as `engine_user`, and the key is absent from every row whose provider names no engine principal.
Milvus's provider implements `engineUser()`: the Milvus user name, the user name before the colon when Password or token carries a `user:password` token with User empty, or the word `token` for a token with no colon.

**Maintenance Types:**

| Type | PostgreSQL | MySQL | SQLite | Description |
|------|------------|-------|--------|-------------|
| `vacuum` | VACUUM ANALYZE | - | VACUUM | Reclaim storage and update statistics |
| `analyze` | ANALYZE | ANALYZE | ANALYZE | Update query planner statistics |
| `reindex` | REINDEX | - | REINDEX | Rebuild indexes |
| `optimize` | - | OPTIMIZE | - | Optimize table (MySQL only) |
| `check` | - | CHECK | PRAGMA integrity_check | Check table integrity |
| `kill` | pg_terminate_backend | KILL | - | Terminate a session by PID |
| `compact` | - | - | - | etcd: compact history to the current revision |
| `defragment` | - | - | - | etcd: defragment the member the connection reaches |
| `disarm` | - | - | - | etcd: disarm every raised alarm |
| `load` | - | - | - | Milvus: load a collection into query-node memory, after a preview |
| `release` | - | - | - | Milvus: release a collection, confirmed by typing its exact name |

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
  "error": "Authentication required",
  "code": "AUTH_REQUIRED"
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
A body that is not JSON, or JSON that is not an object, answers `400` with `{ "error": "Invalid request body" }` before any provider is opened.

`container` is type-checked before any provider is opened: a value that is neither absent nor a string
answers `{ "error": "\"container\" must be a string naming the target's container" }` with `400`.
Without this the value reached the provider's identifier escaper, where it failed as
`identifier.replace is not a function` and the caller read a `500` for a malformed request. An
empty string is not malformed: it reads as a request that named no container, the same way an empty
`target` reads as the whole-database form.

A fifth `400` gates what the operation may be *pointed at*. Each provider declares that separately
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

On a `postgres` or `mysql` connection the supported set and its placements are the CONNECTED server's, measured when the provider connects, and not the type id's (#1387): CockroachDB keeps only a targeted `analyze`, RisingWave keeps only `kill`, YugabyteDB loses `reindex`, TiDB keeps `analyze` and Vitess loses `check`. A request for an operation the server refused gets the same `400` as any other unsupported operation, before anything is sent. The per-engine measurements are in `docs/providers/postgres.md` section 9.1 and `docs/providers/mysql.md` section 9.1.

When the engine itself refuses the statement, the reply is the engine's answer, not a server fault (#1387): the thrown driver error is typed by `mapDatabaseError`, and one whose driver code says the statement is at fault answers `400` with `code: "QUERY_ERROR"` and the engine's own sentence, for example `{ "error": "at or near \"vacuum\": syntax error", "code": "QUERY_ERROR", "statusCode": 400 }`. Any other thrown error keeps a `5xx`.

#### POST /api/db/maintenance/preview

Read what one per-object maintenance operation will do, before an admin confirms it.

**Authentication:** Required (Admin only), on the same rate-limit bucket as `POST /api/db/maintenance`.
No session returns `401`; a valid session with a non-admin role returns `403` with `{ "error": "Unauthorized. Admin access required." }` and writes a `permission_denied` audit event with the reason `insufficient_role`.

**Request:** the body of `POST /api/db/maintenance`, with `target` required.

```json
{
  "connection": { "id": "conn-123", "type": "postgres", "host": "localhost", "port": 5432, "database": "mydb" },
  "type": "<operation>",
  "target": "orders",
  "container": "app"
}
```

The route maps the request to the object's path, container levels then the object: `[container, target]`, or `[target]` when `container` is absent or empty.
It calls the provider's `previewMaintenance(type, path)` and nothing else, and writes no audit event for a preview it answers, because a preview changes nothing.

**Response (200 OK):**

```json
{
  "preview": {
    "summary": "One sentence saying what the operation will do to this object.",
    "facts": [{ "label": "Rows (estimate)", "value": "1,200" }],
    "refusal": "Present only when a preflight refuses the operation.",
    "note": "How fresh or exact the facts are."
  }
}
```

`preview` is a `MaintenancePreview`, published from `@libredb/studio/types`.
A dialog that receives a `refusal` shows it and offers no confirm button.

**Response (400 Bad Request):** the checks of `POST /api/db/maintenance`, made in the same order before the provider's method runs (a body that is not a JSON object, a missing `type`, a non-string `container`, maintenance unsupported, an operation the provider does not declare, an operation that takes no target), and these two:

| Condition | Body |
|---|---|
| `target` absent, empty or not a string | `{ "error": "\"target\" must name the object the operation would run on" }` |
| The operation's spec does not declare `perEntity: true` and `preview: true`, or the provider does not implement `previewMaintenance` | `{ "error": "This operation has no preview" }` |

A missing `type`, a non-string `container` and a missing `target` are refused before any provider is opened.
Whether the object exists is the provider's to say: its `previewMaintenance` raises a `QueryError` naming what is missing, answered with `400`.

**Declaring a per-object operation.** A provider declares it on the operation's `MaintenanceOperationSpec` in `maintenanceOperationSpecs`:

- `perEntity: true` on an operation outside the six of `MaintenanceType` gives it a control of its own on the Operations tab, the monitoring Tables tab and both row menus, after their own controls, in declaration order, under the spec's `label`.
- `confirmation: "typed-target"` makes that control ask for the object's own name, typed exactly and case-sensitively, before it sends anything; never a fixed word and never the connection's name.
  Such a spec declares `perEntity: true` and `global: false`.
- `preview: true` makes the control's dialog read this route and show the preview before it offers the confirm button; the provider implements the optional `DatabaseProvider.previewMaintenance(type, path)`.
  A preview belongs to the per-row control, so it is declared beside `perEntity: true`, and this route answers no preview for a spec that offers no row.

Milvus is the one shipped provider that declares them: Load and Release per collection, each with a preview, and Release confirmed by the collection's exact name.

#### Container paths on the object routes

Four object routes take a container path, and they check it by two different rules before the provider is called (#1147).

`container` on `POST /api/db/objects/counts` and `POST /api/db/objects/list`, and every entry of `containers` on `POST /api/db/objects/inventory`, is an address: the container a read binds its segments from.
The route accepts it only in a shape the engine declares as `containerPathShapes` in its capabilities, and it reads that declaration through the same kernel function the provider refuses by, `acceptedContainerShapes()` in `src/lib/db/object-kinds.ts`.
An `exact` engine accepts the declared depth and nothing else.
A `prefixes` engine accepts every depth from one level up to the declared one, so on Trino a catalog alone is an address as well as a catalog and a schema.
An engine that declares no value reads as `exact`.
A path the engine does not accept is refused at the edge, whether it is too short or too long, with one sentence and one wire shape.

| Condition | Status | Body |
|-----------|--------|------|
| `container`, or one entry of `containers`, is not a shape the engine accepts | `400` | `{ "error": "<type> accepts \"<field>\" as <shapes>, received <path>" }` |

The body carries no `code`, like the route's other refusals of a caller mistake, and no listing runs: on the inventory every named entry is checked before the first one is read.
`<shapes>` spells each accepted shape from the engine's level labels, lowercased.
A declaration with no level prints `empty` when only `[]` is accepted, and `nothing: this declaration carries no container level` when no path is.

| Engine | Request field | Answer |
|--------|---------------|--------|
| PostgreSQL | `"container": []` | `400` `{ "error": "postgres accepts \"container\" as [schema], received []" }` |
| PostgreSQL | `"container": ["app", "x"]` | `400` `{ "error": "postgres accepts \"container\" as [schema], received [\"app\",\"x\"]" }` |
| PostgreSQL | `"containers": [["app"], []]` | `400` `{ "error": "postgres accepts \"containers\" as [schema], received []" }` |
| Trino | `"container": ["memory"]` | reaches the engine |
| Trino | `"container": ["memory", "app", "x"]` | `400` `{ "error": "trino accepts \"container\" as [catalog] or [catalog, schema], received [\"memory\",\"app\",\"x\"]" }` |
| SQLite | `"container": ["main"]` | `400` `{ "error": "sqlite accepts \"container\" as empty, received [\"main\"]" }` |

`parent` on `POST /api/db/objects/containers` is a tree cursor rather than an address, and it keeps the depth ceiling on every engine.
Any depth up to and including the declared one is accepted, and a parent at the declared depth answers `[]`, because nothing nests below the last level.
Only a deeper parent is refused, at `400` with `{ "error": "<type> declares a container depth of <n>, and \"parent\" has <m> segments: <path>" }`.

A caller that reaches a provider without these routes, such as the MCP `inspect-schema` tool or a host behind the embedded workspace, is refused by the provider itself under the same rule, in the provider's own words: `A PostgreSQL container path is [schema], received []`.

#### POST /api/db/objects/describe

Read the columns, indexes and foreign keys of ONE object.

This is the object tree's per-row read: one request when a reader expands an object row, and none
before that.
It executes nothing and writes nothing.

**Authentication:** Required.
No admin gate, for the same reason the two edit routes below have none: the role decides which
connection may be OPENED and nothing about what may be read through it.

**Request:**
```json
{
  "connection": { "id": "conn-123", "type": "postgres", "host": "localhost", "port": 5432, "database": "mydb", "user": "app" },
  "path": ["app", "orders"],
  "kind": "table"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connection` or `connectionId` | object or string | Yes | The same connection selector every database route takes |
| `path` | string[] | Yes | The object's path, container segments first, then the object's own identifier. An empty array is refused |
| `kind` | string | Yes | The object kind id, as the CONNECTED provider declares it. Never inferred from the path: without it a provider has to guess what it is holding from whatever the last segment matches in a catalog |

There is no depth check on `path`.
How deep a kind nests is a per-kind fact the provider declares (a trigger nests under its table),
and the provider validates the path against that declaration.

**Response (200 OK):** one `ObjectDetail`, exactly as the provider answered it.
`ColumnSchema`, `IndexSchema` and `ForeignKeySchema` are defined under
[DatabaseObject](#databaseobject).

```json
{
  "path": ["app", "orders"],
  "columns": [
    { "name": "id", "type": "integer", "nullable": false, "isPrimary": true },
    { "name": "total", "type": "numeric(12,2)", "nullable": true, "isPrimary": false, "defaultValue": "0" }
  ],
  "indexes": [{ "name": "orders_pkey", "columns": ["id"], "unique": true }],
  "foreignKeys": [{ "columnName": "customer_id", "referencedTable": "customers", "referencedColumn": "id" }]
}
```

Column order is the provider's own order, unchanged by this route: Cassandra answers partition key,
then clustering columns, then the rest alphabetically, and that ordering reaches the client intact.

A kind that has no columns is a `200` carrying three empty arrays and never a refusal.
Oracle answers that shape for every kind whose role is not `relation`, MySQL for every kind its own
column predicate rejects, and a caller is expected to render "nothing to show" rather than treat the
engine as broken.

**Statuses:**

| Condition | Status | Body |
|-----------|--------|------|
| The provider answered | `200` | the `ObjectDetail` above, including the all-empty form |
| `path` absent, or not an array of strings | `400` | `{ "error": "\"path\" must be an array of path segments" }` |
| `path` empty | `400` | `{ "error": "\"path\" must name an object, and an empty path names none" }` |
| `kind` absent, not a string, or blank | `400` | `{ "error": "\"kind\" must be a non-empty string" }` |
| The engine refused the read: a kind it does not declare, a path shape that kind does not take, a permission error | `400` | `{ "error": "<the engine's own sentence>", "code": "QUERY_ERROR" }` |
| No session | `401` | `{ "error": "Authentication required", "code": "AUTH_REQUIRED" }` |
| Seed connection not available for the caller's role | `403` | the existing `SeedConnectionError` body |
| Rate limited | `429` | `{ "error": "...", "code": "RATE_LIMITED" }` |
| Anything undeclared | `500` | `createErrorResponse`'s body |

**An object dropped between the listing and this read has two answers, and which one you get is a
SHAPE rather than a count.**
A provider that checks its catalog read for a zero-row answer refuses with `400` and
`code: "QUERY_ERROR"`, carrying its own sentence: PostgreSQL's is `No detail row for app.orders`.
A provider that does not check answers `200` with three empty arrays, which is indistinguishable
from an object that genuinely has no columns.
Both are correct answers from this route.
A client must handle both, and must not read the empty answer as evidence that the object is still
there.

#### POST /api/db/objects/edit-plan

Build a plan for an edited object definition, and answer what an apply would send.
It executes nothing and writes nothing.

The describe route above is the one Phase 2 sibling documented in full in this file.
The other six under `/api/db/objects/` (`containers`, `counts`, `list`, `search`, `inventory`, `source`) are not, except for the container-path rule four of them share, which [Container paths on the object routes](#container-paths-on-the-object-routes) documents.

**Authentication:** Required.
There is NO admin gate on either route, and the reason is measured rather than preferred: a
`user`-role session already creates and drops routines through `POST /api/db/query`, so the role
decides which connection may be OPENED and nothing about what may be done with it.
A seed connection that the caller's role is not admitted to still answers `403`, unchanged, because
both routes resolve the connection through the same seed filter every other database route uses.

**Request:**
```json
{
  "connection": { "id": "conn-123", "type": "postgres", "host": "localhost", "port": 5432, "database": "mydb", "user": "app" },
  "path": ["app", "order_total(integer)"],
  "kind": "function",
  "partId": "definition",
  "text": "FUNCTION app.order_total(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connection` or `connectionId` | object or string | Yes | The same connection selector every database route takes |
| `path` | string[] | Yes | The object's path, container segments first. An empty array is refused |
| `kind` | string | Yes | The object kind id, as the CONNECTED provider declares it |
| `partId` | string | Yes | Which part of the definition this text is. A package has more than one |
| `text` | string | Yes | The reader's edited text for THAT part, at most 1,000,000 characters |

**Response (200 OK), a build that planned:**
```json
{
  "built": true,
  "plan": { "planVersion": 1, "planId": "...", "issuedAt": "...", "connectionFingerprint": "...", "type": "postgres", "path": ["app", "order_total(integer)"], "kind": "function", "partId": "definition", "strategy": "guarded-atomic-batch", "unit": { "medium": "statement", "steps": [{ "text": "...", "language": "pgsql", "segments": [] }] }, "session": [], "revision": { "check": "guarded", "token": "...", "basis": "pg_proc.xmin", "scope": "server" }, "consequences": [] },
  "preimage": { "text": "...", "language": "pgsql" },
  "planToken": "<JWS>"
}
```

`plan.unit` is the exact artifact the apply will send, byte for byte.
`preimage` is the definition the build READ, for the preview's left side, and it rides in the
response rather than inside the plan: a plan carrying both would be about 12 MB inbound on the
apply and would be silently truncated by the framework at 10,485,760 bytes.
`planToken` seals the plan; the apply refuses a plan whose bytes do not match the token it arrives
with.
The plan is readable and unforgeable, which are different properties: a client may read every field
and may not change one.

**Response (200 OK), a build that REFUSED:**
```json
{
  "built": false,
  "refusal": { "refusal": "privilege", "sentence": "must be owner of function order_total", "code": "42501", "at": { "within": "none" } }
}
```

A deliberate engine refusal is a `200` carrying a typed verdict and never a `4xx` or a `5xx`.
The request was well formed and was carried out; what the engine said is the payload.

#### POST /api/db/objects/edit-apply

Send a plan issued by `edit-plan`, and answer what the engine did.
This is the only route in this product that writes a user's database object, and it is the first
one whose action is recorded in the audit log.

**Authentication:** Required. No admin gate, for the reason stated above.

**Request:**
```json
{
  "connection": { "id": "conn-123", "type": "postgres" },
  "plan": { "planVersion": 1, "planId": "..." },
  "planToken": "<JWS>",
  "acknowledged": ["replaces-whole-container"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connection` or `connectionId` | object or string | Yes | Must resolve to the SAME server the plan was built against |
| `plan` | object | Yes | The plan `edit-plan` answered, unchanged |
| `planToken` | string | Yes | The token `edit-plan` answered beside it |
| `acknowledged` | string[] | Only when the plan names consequences | One entry per `plan.consequences[].loses`. The check is enforced by the SERVER |

**Response (200 OK):** one arm of the outcome union, always with a `duration` in milliseconds.

| `outcome` | Meaning | Also carries |
|-----------|---------|--------------|
| `applied` | The addressed object was replaced and nothing else was destroyed | `revision` |
| `applied-with-collateral` | Replaced, AND something the plan warned about was destroyed | `lost`, `revision` |
| `applied-elsewhere` | The engine accepted the text and the addressed object is not what changed | `undone`, optional `wrote` |
| `conflict` with `conflict: "object-changed"` | The object moved between the read and the write. Nothing was executed | `current`, for the diff |
| `conflict` with `conflict: "engine-refused-concurrent"` | Refused on concurrency, not content. Nothing changed and the same plan may be sent again | `sentence`, optional `code` |
| `refused` | The engine refused the write. Nothing changed | `refusal` |
| `interrupted` | The statement was sent and no readable answer came back | `committed`, `sentence` |

There is NO `retryable` field on this route at any status.
A client that retries an apply whose disposition is unknown applies twice.
Once the provider has been called, no error escapes as an HTTP error: a throw and an unreadable
answer both become `interrupted` with `committed: "unknown"` at `200`.

**Statuses, both routes:**

| Condition | Status | Body |
|-----------|--------|------|
| Any DECIDED provider answer: a build that planned, a build that refused, and all seven apply outcomes | `200` | the typed union above |
| Caller mistakes decided from the DECLARATION: undeclared kind, kind not editable, `path` not a path, missing `partId`, malformed plan, a build answering both a plan and a refusal, an unacknowledged required consequence | `400` | `{ "error": "..." }` |
| Plan token invalid, expired, digest mismatch, wrong connection fingerprint, unknown `planVersion` | `400` | `{ "error": "...", "code": "EDIT_PLAN_INVALID" }` |
| Body above 8,388,608 bytes, or `text` above 1,000,000 characters | `413` | `{ "error": "..." }` |
| No session | `401` | `{ "error": "Authentication required", "code": "AUTH_REQUIRED" }` |
| Seed connection not available for the caller's role | `403` | the existing `SeedConnectionError` body |
| Rate limited | `429` | `{ "error": "...", "code": "RATE_LIMITED" }` |
| A throw BEFORE the provider call | as `createErrorResponse` maps it | inherited |
| Anything undeclared | `500` | `createErrorResponse`'s body |

**Audit.**
One apply emits exactly two `object_edit` events under one `correlationId`, which is `plan.planId`:
a DECISION event with `action: "PLAN"` before the provider is called, and an OUTCOME event with
`action` set to the plan's strategy after it.
Neither event ever carries the statement, the command payload, the reader's text, the pre-image, the
engine's message, the engine's code, the revision token or the plan token.
A plan the seal refuses emits ONE event, with `reason: "object_edit_plan_invalid"`.

#### POST /api/db/keys/scan

One page of a resumable walk of an engine's own **key space**.

This is not an object read and does not replace one. `listObjects` answers a whole folder in one call
and is finite by definition, which is true of every catalog-backed engine and false of a key space:
there is no prefix index to enumerate from, so the only way to learn what exists is `SCAN`, and `SCAN`
answers a cursor rather than a listing. A caller that stops at one page holds a sample, and the only
way to hold more is to come back with the cursor it was given. That is a different contract, so it is
a route of its own rather than an option on the object routes.

The walk is offered by an engine that declares `keyScan` in `POST /api/db/provider-meta`'s
`capabilities`; Redis declares `{ "defaultCount": 500, "maxCount": 1000 }`.
etcd declares its own counts ([providers/etcd.md](./providers/etcd.md), section 6.4), and Oxia declares `{ "defaultCount": 500, "maxCount": 1000 }` ([providers/oxia.md](./providers/oxia.md), section 6.4).
Every other connection answers `400`, in this route's own words. A provider that declares the capability and implements no
walk is a distinct `500` rather than a crash: `ProviderCapabilities` is published, so that is a state
an external implementer can genuinely be in.

The declaration also states the walk's shape, in four optional fields that each read as Redis's walk when absent: `separator` (`":"`) splits a key into the panel's folders, `cursor` (`"decimal"`) says how a cursor is spelled, `pattern` (`"glob"`) says what `pattern` is, and `totalScope` (`"database"`) says what `total` counts.
A `totalScope` of `"none"` is an engine that publishes no count and pins no revision: `total` is not read, and a provider answers 0.
etcd declares `"/"`, `"opaque"`, `"prefix"` and `"walk"`: a cursor only it can read, a literal prefix instead of a glob, and a total that counts the keys the walk covers.
Oxia declares `"/"`, `"opaque"`, `"prefix"` and `"none"`: a cursor only it can read, a literal prefix, and no count.

**Authentication:** Required.
No admin gate, for the same reason the object routes have none: the role decides which connection may
be OPENED and nothing about what may be read through it.

**Request:**
```json
{
  "connection": { "id": "conn-123", "type": "redis", "host": "localhost", "port": 6379 },
  "cursor": "0",
  "pattern": "app:cache:*",
  "count": 500,
  "database": 0
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connection` or `connectionId` | object or string | Yes | The same connection selector every database route takes |
| `cursor` | string | No | The cursor the previous page answered with. Absent means `"0"`, which starts a walk. Under a `"decimal"` declaration (Redis) it is refused unless it is a run of digits: Redis cursors are opaque, and only the obviously malformed one is refused here rather than passed through. Under an `"opaque"` declaration (etcd, Oxia) it is any non-empty string, passed through exactly as the previous page wrote it, because only the provider that wrote it can read it |
| `pattern` | string | No | The walk's pattern, in the shape the declaration names. Absent means every key, which is NOT the same as an empty string, which is refused: `MATCH ""` is a pattern no key satisfies. Under `"glob"` (Redis) it is a `MATCH` pattern, trimmed and then forwarded, and a caller scoping a walk has two things to know. `MATCH` is applied per batch server-side and is **not indexed**, so a scoped walk costs the server a full pass over the keyspace rather than a lookup. And it is a glob with **no escape**, so a key segment that contains `*`, `?` or `[` matches more than the prefix asked about: the answer must be filtered by the caller, compared segment by segment (`app:envelope` is not under `app:env`). Under `"prefix"` (etcd) it is the literal prefix every walked key begins with, forwarded exactly as sent, with nothing trimmed and nothing escaped, because a prefix is bytes and a space at either end is part of the range it names |
| `count` | number | No | The batch size. Absent takes the provider's declared `defaultCount`. A value above the declared `maxCount` is **refused rather than clamped**, because a silent clamp answers a request for 10,000 with 1,000 and says nothing |
| `database` | number | No | Which numbered database to walk, taken only from an engine that declares a container level to name (Redis). Absent means the one the session is in, since `SELECT` state lives on the connection and not in this route. A caller offering the choice reads the engine's own list from `POST /api/db/objects/containers`, the same container level the object tree's top level comes from, rather than assuming a count: the same server answers 16 outside cluster mode and 1 inside it. An engine that walks one key space and declares no level (etcd, Oxia) refuses the field |

**Response (200 OK):**

```json
{
  "keys": ["app:cache:ttl", "app:cache:user:1"],
  "cursor": "17",
  "total": 31,
  "types": { "app:cache:ttl": "string", "app:cache:user:1": "string" }
}
```

| Field | Description |
|-------|-------------|
| `keys` | The batch. Under `"glob"` (Redis) it is **not deduplicated and not ordered**: `SCAN` promises neither, so a key present for the whole walk may be returned twice while the table rehashes, and the order is the hash table's rather than the caller's. Under `"prefix"` (etcd) the pages of one walk read an ordered key range at one pinned revision, so they are one consistent view. Oxia also declares `"prefix"` and pins no revision: each page reads the namespace in its own key order, resumed after the last key the previous page answered |
| `cursor` | The cursor for the next page. `"0"` means the walk reached the end, and it is the only end-of-walk signal the engine publishes |
| `types` | Each key's value type, **by key name**. It travels with the page rather than being asked for separately: `TYPE` takes one key and Redis publishes no batch form, so the provider pipelines one call per key and the cost is ONE extra round trip per page whatever the page holds. A key **absent** from the map is one whose type could not be read and a caller should draw nothing for it; a key that vanished between the walk and this read is present with the server's own `"none"`. What it describes is the moment it was read, like everything else in a sampled walk |
| `total` | What a progress indicator divides by, in the scope the declaration's `totalScope` names. Under `"database"` (Redis) it is `DBSIZE` for the database walked: the engine's own key count, and the only denominator a progress indicator can divide by, since a cursor says nothing about how much is left. On a clustered deployment it is the LOCAL node's count: `SCAN` walks one node's slots and `DBSIZE` has no cluster-wide form. Under `"walk"` (etcd) it is the exact count of the keys the walk covers, the pattern's prefix range or the whole key space, at the revision the walk's pages are pinned to; for a user whose grants are narrower, it counts the keys of the ranges that user may read. Under `"none"` the engine publishes no count and pins no revision: the field is not read, and a provider answers 0. |
| `clustered` | Present and `true` only when the server's own `INFO cluster` reply says this deployment is clustered. `SCAN` and `DBSIZE` are per node and neither has a cluster-wide form, so on a cluster `keys` and `total` describe the node that answered and nothing else. **Absent** means the deployment does not say it is clustered, which is the ordinary server; a reply the provider could not read is absent rather than a guess. The fact is read in the same round trip as `total` |
| `skipped` | Present only when the page left keys out: `{ "count", "reason" }`, how many keys this page read and could not name, and why. On etcd a key that is not UTF-8 text is counted here rather than listed, because a name decoded with replacement characters would address a different key. Redis never sends it |

The cursor belongs to the CALLER.
Nothing is retained between two pages, so a page costs a round trip rather than a session, and a cursor arriving after a reconnect is still valid: it is a position, not a handle, spelled as the declaration's `cursor` says.
Under `"decimal"` (Redis) it is a position in a hash table.
Under `"opaque"` (etcd) it is a string only the provider that wrote it can read, and the engine can overtake it between two pages: etcd's cursor carries the revision its walk is pinned to, and once a compaction passes that revision the next page answers etcd's compacted error in place of keys.
etcd's cursor also carries a digest of the key ranges its walk may read, so a page whose ranges differ, because the provider read the user's grants again since the first page or the `pattern` changed, is refused before etcd is asked, with the instruction to start the walk again.
The caller then starts the walk again at `"0"`.

**Statuses:**

| Condition | Status | Body |
|-----------|--------|------|
| The page was read | `200` | the body above |
| The connection's engine declares no `keyScan` | `400` | `{ "error": "<type> declares no key-space walk: its objects are enumerated from a catalog, so there is nothing to page" }` |
| `cursor` is present and not a run of digits, under a `"decimal"` declaration | `400` | `{ "error": "\"cursor\" must be a decimal cursor the previous page answered with" }` |
| `cursor` is present and not a non-empty string, under an `"opaque"` declaration | `400` | `{ "error": "\"cursor\" must be the cursor the previous page answered with" }` |
| `pattern` is present but blank under `"glob"`, or empty or not a string under `"prefix"` | `400` | `{ "error": "\"pattern\" must be a non-empty string" }` |
| `count` is present and not a positive integer | `400` | `{ "error": "\"count\" must be a positive integer" }` |
| `count` exceeds the declared `maxCount` | `400` | `{ "error": "\"count\" must be at most <maxCount>, which is the batch size this engine declares" }` |
| The server has no such database | `400` | `{ "error": "Redis refused database <n>: ERR DB index is out of range", "code": "QUERY_ERROR", "statusCode": 400 }`, never a read of database 0 |
| `database` is negative or not an integer | `400` | `{ "error": "\"database\" must be a non-negative integer" }` |
| `database` is present and the engine declares no container level | `400` | `{ "error": "<type> walks one key space and declares no database level: \"database\" names the numbered database to walk, and this engine has none to name" }` |
| The engine declares `keyScan` and implements no walk | `500` | `{ "error": "<type> declares keyScan but implements no scanKeysPage" }` |
| Rate limited | `429` | `{ "error": "...", "code": "RATE_LIMITED" }` |

A failed page does not advance the caller's cursor. The position already held is the last one the
server acknowledged, so a retry re-asks the batch that failed rather than silently skipping it.

The budget is SHARED and this route carries no bucket of its own: it meters into the `query` bucket
through the same helper the object routes use, 120 requests per 60 seconds by default, so a person
driving a walk spends the same allowance their statements do. That is why `Scan all` loops client-side
on this route rather than asking the server for one unbounded walk.

The sidebar's Keys panel drives this route; what it does with a sample is recorded in the Redis
provider doc ([§6.2](providers/redis.md#62-the-key-space-walk-panel)). A prefix-scoped walk — the
panel's Load more row — is this route again with a `pattern` built from the prefix and a cursor that
belongs to that prefix, so a caller that wants one costs no second contract
([§6.3](providers/redis.md#63-the-prefix-scoped-walk-load-more)).

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

`query-safety` bounds its wait for the model: a provider request that has not finished after 30 seconds
(`QUERY_SAFETY_ROUTE_TIMEOUT_MS` in `src/lib/llm/query-safety.ts`) is aborted, and a request that had not
started streaming answers `504 { "error": "The AI safety analysis did not finish in time.", "code": "TIMEOUT_ERROR" }`;
one that had started ends there. A caller that disconnects aborts the provider request as well. The bound is
fixed, not configurable: the Query Safety dialog, the only caller in this repo, stops waiting after 15 seconds
(`QUERY_SAFETY_ANALYSIS_TIMEOUT_MS`), aborts its request and lets the statement run without the analysis.

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

eight paths, eleven handlers, under `src/app/api/agent/`. They drive the read-only agent runtime — full
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
required", "code": "AUTH_REQUIRED" }` without a session). Never `500`, and never names a key's value.

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

#### GET /api/agent/runs

The finished conversations the calling session can reopen, newest first. This is the **history
index**, not the run record: each conversation carries its steps (run id, objective, workflow, mode,
status, whether it answered, connection, timestamps) so the list needs no per-run ledger read, and a
reopened report is the `GET /api/agent/runs/{runId}` below.

**Authentication:** Required, and scoped to the calling session — a user can only list their own
runs. `404` when this server runs no agents, `401` without a session.

**Query parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `limit` | number | No | Page size, default 20, clamped to 100 at most. A value that is not a positive integer is refused with `400` |
| `cursor` | string | No | The opaque cursor the previous page returned; absent means the newest page. An unreadable value is refused with `400` |

**Response (200 OK):**

```json
{
  "conversations": [
    {
      "threadId": "arun_…",
      "steps": [
        {
          "runId": "arun_…",
          "objective": "Why is checkout slow?",
          "workflowType": "investigation",
          "mode": "agent",
          "status": "succeeded",
          "answered": true,
          "connectionId": "seed:sample",
          "createdAtMs": 1740000000000,
          "updatedAtMs": 1740000120000
        }
      ]
    }
  ],
  "nextCursor": "1740000120000.arun_…"
}
```

`steps` is oldest first within a conversation; conversations are newest first overall. `nextCursor`
is `null` when there is no page after this one. The list is bounded to the 50 newest conversations —
a listing bound, not a deletion.

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
| `previousRunId` | string | No | Continue the **conversation** a run this session opened belongs to. The server derives the earlier steps' objectives and the most recent step's report from those runs' own ledgers, verifies the named run belongs to this session, is on this connection and has ended, and persists the result as `thread` on the new run's header. A run it cannot reach **does not refuse the start**: the run opens carrying no conversation and the response says so through `thread.declined` — `"repointed"` when the predecessor was reachable but was established against a different database than this connection now addresses — the run still opens, and it records the connection as it now addresses it, so a follow-up naming **that** run carries normally: the decline is one question long, not a state the connection is left in — `"disabled"` when the server has conversations switched off, `"error"` on an unreadable ledger, and `"unavailable"` for the five remaining causes, which are deliberately not told apart. Only a value that is not a non-empty string is refused, with `400` — that is a malformed request rather than a runtime condition |

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
{
  "error": "Agent mode executes only where the provider implements a database-native read-only statement path — PostgreSQL, SQLite, DuckDB and SQL Server. On MySQL a run whose workflow sends a statement is refused when it is started, before a run is opened. The operations workflow still runs here, because it sends no statement at all: it calls the curated reporting methods every provider implements. Plan mode drafts on every engine.",
  "refused": "engine-unsupported"
}

// 404 Not Found — this server runs no agents
{ "error": "The agent runtime is not enabled on this server" }

// 422 Unprocessable Entity — the configured model was ESTABLISHED as unable to drive an agent run
{
  "error": "The model \"gemma3:270m\" (ollama) cannot drive an agent run: …",
  "missing": ["toolCalling", "structuredOutput", "streaming"],
  "disproved": []
}
```

> **The engine refusal is a `400`, and it changed this contract.** Since #512 an `agent` run whose
> `workflowType` sends a statement — every workflow but `operations` — is refused here when the
> connection's engine implements no database-native read-only statement path, and `error` carries the
> posture's whole paragraph. It is refused **before a run id exists**: a client that used to receive
> `202` for `investigation` on MySQL and then read `engine-unsupported` off the run receives `400`
> and no run. `operations` is admitted on every engine because it sends no statement at all, and a
> `planning` run is never refused this way — it executes nothing anywhere. The refusal reads the
> same fact the provider factory does (`typeof provider.queryReadOnly`), so the two cannot disagree.
>
> **It is the only `400` here that carries `refused`**, and the value is `"engine-unsupported"` —
> the same name the fact travels under as an `AgentRunFailureReason` on a run that ended this way,
> and the same name in code: both ends of the wire extract that member from the union rather than
> writing the string, so a rename cannot leave the wire on the old one. Every refusal this route's
> own validation writes answers with `error` alone, because the message is the only thing that says
> what went wrong. The connection resolver's `400` is the exception and is worth knowing about: a
> `connectionId` that is not `seed:`-prefixed answers in the shared error shape — `error` plus
> `code` (`"CONFIG_ERROR"`) plus `statusCode` — because it is raised below the route and answered by
> the shared error mapper. The engine refusal is different again because a client may already be
> showing the same paragraph itself: the studio's agent rail stands an amber card carrying it, so it
> needs to know WHICH refusal this is in order to answer with the consequence and a pointer instead
> of a second copy (#513). A client that ignores the field and renders `error` is correct; a client
> that discriminates on the `400` alone is not, and would relabel a malformed `mode`, or an
> `autoExecute` asked for on a workflow that presents no answer, as the engine's refusal.

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

#### PATCH /api/agent/runs/{runId}

Pauses or resumes the run, named by the `action` field: `{"action": "pause"}` or
`{"action": "resume"}`. Pause lands only on a `running` run; resume only on a `paused` one, and a
resume that answers `running` also drives the run again in this process.

```json
// 200 — the run's record after the action
{ "runId": "arun_…", "status": "paused", "…": "…" }
```

A refusal is a `409`, never a `500`: the ledger moved between the render and the click (for example,
a resume that lost the race to the run's end answers the terminal record), or the action cannot be
honoured. An `action` this route has no words for is a `400`.

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
boundary** — `BEGIN READ ONLY` on PostgreSQL, `PRAGMA query_only` on SQLite, a `READ_ONLY` engine
handle plus an SQL-level guard on DuckDB, and on SQL Server a verified least-privilege principal, an
optimizer admission that compiles the statement without running it, a server-side row bound and a
transaction that is always rolled back — at the editor's default
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

### MCP API

The MCP endpoint for AI clients of your own ([`docs/MCP.md`](MCP.md)).
It is off by default (`LIBREDB_MCP_ENABLED`), and it authenticates with a scoped bearer token, never the session cookie.

#### `POST /api/mcp`

A JSON-RPC message of MCP revision 2026-07-28, 2025-11-25 or 2025-06-18, sent with `Authorization: Bearer <your-mcp-token>` and `Content-Type: application/json`.
The answers, in the order they are checked:

| Status | Body | When |
|---|---|---|
| 403 | JSON-RPC `-32000`: `Invalid Origin: <host>`, `Invalid Host: <host>` or `Missing Host header` | The `Origin` is not on the MCP allowlist, or on a loopback bind the `Host` is not |
| 401 | `{"error":"invalid_token","error_description":"..."}` with `WWW-Authenticate: Bearer error="invalid_token", error_description="...", scope="mcp:read"` | No bearer, or one that does not verify |
| 404 | `{"error":"MCP is not enabled on this server"}` | `LIBREDB_MCP_ENABLED` is off |
| 500 | `{"error":"..."}` naming `LIBREDB_MCP_ENABLED` or `NEXT_PUBLIC_APP_VERSION`, or the OAuth `server_error` body | An unrecognized switch value, an unset server version, or a server fault during verification |
| 429 | The rate-limit body of [Error Handling](#error-handling), with `Retry-After` | The per-user query budget is spent |
| 415, 413, 400 | JSON-RPC `-32000`, `-32700`, `-32600` or `-32020` | A body that is not JSON, over 4 MiB, unreadable or invalid, a batch, or a standard header outside visible ASCII or missing after `initialize` |
| 404 | JSON-RPC `-32601`, `Method not found` | `subscriptions/listen`, which this server does not implement |
| 200, 202 | The SDK's JSON-RPC answer, as JSON or as an event stream; 202 for a notification | Everything else |

#### `GET /api/mcp`, `DELETE /api/mcp`

After the same Origin, Host, bearer, switch and version checks, 405 with the SDK's JSON-RPC body and `Allow: POST`: the server keeps no session and offers no stream.
Neither is metered.

#### `GET /api/mcp/token`

The MCP channel's status for the signed-in user, which the settings screen reads; session-checked and never metered.

```text
{ "state": "off" | "misconfigured" | "ready", "problems": [ "..." ], "url": "https://studio.example.com/api/mcp" | null, "tokenTtlDays": 30 | null, "visibleConnections": 2 | null }
```

Each problem names one variable and its fix, never the configured value.
`visibleConnections` is how many `mcp: true` seed connections your role reaches, and `null`, with a problem, when the seed file cannot be read.
It never returns a token.

#### `POST /api/mcp/token`

Mints a token for the signed-in user and role; it reads no body field and spends one slot of the query budget.

| Status | Body |
|---|---|
| 200 | `{ "token": "...", "expiresAt": "<ISO 8601>", "url": "..." }` with `Cache-Control: no-store`; the token appears in no other response |
| 401 | `{ "error": "Authentication required", "code": "AUTH_REQUIRED" }` |
| 403 | `{ "error": "Sign in again to create a token: a token can only be created within 10 minutes of signing in." }`, with `Cache-Control: no-store`, when the session was signed in more than ten minutes ago |
| 409 | `{ "error": "MCP tokens cannot be issued on this server", "problems": [ "..." ] }` |
| 429 | The rate-limit body of [Error Handling](#error-handling), with `Retry-After` |
| 500 | `{ "error": "The token was not issued because its audit record could not be written." }` |

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
{ "ok": true, "migrated": ["connections", "history"] }
```

---

### Connections API

#### GET /api/connections/managed

Auth required. Returns seed/managed connections for the current user's role. A `managed: true` connection has every secret-classified field stripped (`password`, `connectionString`, `apiKeyId`, `apiKeySecret`, `ssl.clientKey`); a `managed: false` one is returned whole, because the browser edits it. `cacheHint` is the client cache TTL in ms (`SEED_CACHE_TTL_MS`, default 60000). See [`docs/SEED_CONNECTIONS.md`](SEED_CONNECTIONS.md).

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

#### GET /api/connections/policy

Auth required; without a session it answers `401 { "error": "Authentication required", "code": "AUTH_REQUIRED" }`.
It answers what this server lets a session do with connections of its own:

```json
{ "customConnections": true }
```

`customConnections` is `false` when `ALLOW_CUSTOM_CONNECTIONS` is `false`, `0`, `off` or `no`, or any value that is not one of those or `true`, `1`, `on` or `yes` (the switch fails closed; one pair of surrounding quotes is stripped first).
Every database route then refuses a connection supplied in the request body, as `connection` or as the whole body, with `403 { "error": "Custom connections are disabled on this server", "code": "CUSTOM_CONNECTIONS_DISABLED", "statusCode": 403 }`, before any provider is built.
A seed named by `connectionId`, or by an inline record whose `id` is `seed:<id>`, is unaffected.
`POST /api/admin/fleet-health` reports such an item as `{ "status": "error", "error": "Custom connections are disabled on this server" }` beside the others.
See [`docs/SEED_CONNECTIONS.md`](SEED_CONNECTIONS.md#custom-connections).

---

### Admin API

Every route here requires an **admin** role (enforced in-handler in addition to the middleware); non-admins get `403 { "error": "Unauthorized. Admin access required." }`. `GET`/`POST /api/admin/audit` check the session inline and return that same `403` whether there is no session at all or a valid session with the wrong role; the two are not distinguished. `POST /api/admin/fleet-health` goes through the shared route guard instead and distinguishes them: no session returns `401 { "error": "Authentication required", "code": "AUTH_REQUIRED" }`, and only a valid session with a non-admin role returns the `403` above.

#### GET /api/admin/audit

Returns audit events. Optional query params: `type` (filter by event type), `limit` (default 100, applied with and without `type`). Events are answered newest first; `limit=0` returns none. Response: `{ "events": [], "total": 0 }`. `POST /api/admin/audit` appends an event (user auto-filled from the session).

Events of type `agent_operation` come from the agent execution path (#328) and additionally carry `correlationId` — the id joining one execution's policy-decision event to its execution-outcome event (a refused operation emits the decision event only, with an `agent_*` reason code). It is opaque and per execution: it identifies neither a user nor a session. On the authoritative stdout line the same value appears as `correlation_id`, and it is omitted entirely from every event that does not set it.

#### POST /api/admin/fleet-health

Body `{ "connections": [...] }`; returns per-connection health `{ "results": [{ connectionId, status, latencyMs, ... }] }`. `400` if `connections` is missing. `401` with no session, `403` with a session that is not an admin — see the note above.
Each connection is resolved the way the db routes resolve one: a managed seed by its `seedId`, a copy that claims a `seed:` id by the operator's record (so a seed that no longer exists is an `error` row), and an inline connection as sent, or as an `error` row while `ALLOW_CUSTOM_CONNECTIONS` is off.

#### GET, POST /api/admin/accounts

The local account registry, available with `STORAGE_PROVIDER=sqlite` or `postgres` and local sign-in; otherwise `409` with the reason.
Both go through the shared route guard: `401` with no session, `403` for a non-admin.
`GET` answers `{ "accounts": [{ "email", "role", "disabled", "totpEnabled", "passkeys", "createdAt" }] }`, where `passkeys` is the account's passkey count, and never a hash or a secret.
`POST` with `{ "email", "password", "role": "admin" | "user" }` creates one and answers `201 { "account": {...} }`; the password needs 8 characters, and an email that already exists in any letter case is `409`.

#### PATCH, DELETE /api/admin/accounts/{email}

`PATCH` takes any of `{ "role": "admin" | "user" }`, `{ "disabled": true | false }`, `{ "password": "..." }`, `{ "clearTotp": true }` and `{ "clearPasskeys": true }` and answers `{ "account": {...} }`.
A password set also removes the account's passkeys, unless the body carries `"keepPasskeys": true` ([PASSKEYS.md](./PASSKEYS.md#admin-actions-and-recovery)).
`clearPasskeys` other than `true` is `400 "clearPasskeys must be true."`, `keepPasskeys` other than `true` is `400 "keepPasskeys must be true."`, and `keepPasskeys` without `password`, or together with `clearPasskeys`, is `400 "keepPasskeys applies only together with a new password, and never with clearPasskeys."`.
A role change, disabling, a password reset and a passkey clear end that account's sessions and MCP tokens at their next request; when the admin changes their own account, the response re-issues their session cookie.
`DELETE` removes the account, its stored rows and its passkeys and answers `{ "ok": true }`.
Both answer `404` for an unknown email, and `409` when the change would leave no enabled admin, or when another change to the same account landed after this request read it: `409 "The account changed at the same time. Reload the page and try again."`, with nothing written.
Every change, and every refused one, is an `account` event in the audit log naming the acting admin.

#### GET /api/admin/discovery

The status of the CapRover discovery source ([SEED_CONNECTIONS.md](./SEED_CONNECTIONS.md)), read by the admin Overview page.
It goes through the shared route guard: `401` with no session, `403` for a non-admin.
With `SEED_DISCOVERY_PATH` unset it answers `{ "discovery": null }`.
Otherwise it answers `{ "discovery": { "platform": "caprover", "state", "message", "generatedAt", "checkedAt", "error": { "code", "message" } | null, "connected": [{ "name", "type" }], "skipped": [{ "appName", "reason" }] }, "transport": { "plainHttp", "cookieSecureOff" } }`, where `state` is `ok`, `waiting`, `stale` or `error`.
It names apps and engine types only, never a host name or an environment value.
`plainHttp` is true when the request arrived over http on a host that is not loopback; `X-Forwarded-Proto` and `X-Forwarded-Host` are read unless `TRUST_PROXY_HEADERS` is `false`, `off` or `0`, in any letter case.
`cookieSecureOff` is true when `AUTH_COOKIE_SECURE` is `false`, `off` or `0`, in any letter case.
Both flags drive a display warning and never a security decision.

---

> **Internal routes (not part of this public reference).** The frontend also calls several internal `/api/db/*` endpoints that mirror provider internals and change with the UI: `multi-query`, `transaction`, `cancel`, `disconnect`, `test-connection`, `monitoring`, `pool-stats`, `profile`, `provider-meta`, and the object-surface routes under `objects/` that are not documented above (`describe`, `edit-plan` and `edit-apply` are). They're auth-gated by the middleware like everything else; consult the route handlers in `src/app/api/db/` for their shapes.

---

## Data Types

### DatabaseConnection

The object is one shape on the wire. Fields the server reads from a request body — and that
change how a connection is opened — are the coordinates and credentials (`id`, `name`, `type`,
`host`, `port`, `user`, `password`, `database`, `schema`, `connectionString`), plus `ssl`,
`sshTunnel`, `serviceName` (Oracle), `instanceName` (MSSQL), `localDataCenter` (Cassandra),
`authSource` (MongoDB), `saslMechanism` (Kafka), `allowInsecureAuth` (Db2, InfluxDB, InfluxDB 3, Oxia), `dataServers` (Oxia), `queryTimeout`, `agentUser`, `agentPassword`, `apiKeyId`/`apiKeySecret`
(Elasticsearch, #708), and `readOnly` (#1089). `color`, `environment`, `group`,
`managed`, `seedId`, and `createdAt` are client-side bookkeeping that travel in the same object.

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
  schema?: string;         // Trino: session schema for unqualified table names
  connectionString?: string; // Full connection string (alternative; Druid has no URI form, host + port only; Cassandra has none either, no URI carries localDataCenter)
  queryTimeout?: number;  // Query timeout in milliseconds; omitted uses 60000 (60 seconds)
  createdAt: Date;         // Creation timestamp
  color?: string;          // UI accent for this connection
  environment?: ConnectionEnvironment; // production | staging | development | local | other
  group?: string;          // Optional sidebar grouping label
  ssl?: SSLConfig;         // TLS mode and optional certificates
  sshTunnel?: SSHTunnelConfig; // Bastion hop before the database host
  serviceName?: string;    // Oracle: service name (e.g. ORCL, XEPDB1)
  instanceName?: string;   // MSSQL: named instance (e.g. SQLEXPRESS)
  localDataCenter?: string; // Cassandra only, and REQUIRED there: the driver refuses to connect without it (`datacenter1` on a stock single node)
  authSource?: string; // MongoDB only: the database the credentials live in (`?authSource=admin`). Not the database being opened - without it the driver checks the user against that one, which fails as a credentials error
  saslMechanism?: 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512'; // Kafka only: the SASL mechanism that checks user and password, absent meaning none. A user or password with no mechanism is refused, and every mechanism requires TLS
  allowInsecureAuth?: boolean; // Db2, both InfluxDB types and Oxia (#786): connect with no TLS although the password (Db2), the password or token (InfluxDB) or the token (Oxia) then crosses the network in cleartext; without it the Db2 provider refuses a connection that has no TLS, both InfluxDB providers one that sends its secret with no TLS to a host that is not loopback, and the Oxia provider one that sends a token with no TLS to a host that is not this machine (docs/providers/oxia.md section 4.6)
  dataServers?: string; // Oxia only: a cluster's data-server addresses, host:port entries separated by commas or whitespace, at most 64; see docs/providers/oxia.md section 4.4
  skipObjectScan?: boolean; // read no catalog when this connection opens: zero reads on connect, so the editor is usable immediately and the object tree offers a load action instead of scanning (#765, an Oracle owner with 43,512 tables froze the browser on connect)
  readOnly?: boolean;      // refuse writes, value edits and maintenance before any request (#1089). Accepted only where the engine's provider enforces it: true anywhere else is refused at seed load and before any provider is built, and a value that is not a boolean is refused everywhere
  managed?: boolean;       // true = admin-controlled: not editable in the UI, secrets kept on the server
  seedId?: string;         // stable reference to seed config ID
  agentUser?: string;      // optional least-privilege role for the agent read-only execution profile (#328)
  agentPassword?: string;  // password for agentUser; secret-classified, sealed at rest by connection-secrets
  apiKeyId?: string;       // Elasticsearch only (#708): API key pair, sent in preference to user/password when both halves are set (trimmed). Secret-classified like agentPassword, not public like user. OpenSearch refuses the pair
  apiKeySecret?: string;   // the pair's secret half; either alone (after trim) falls back to user/password rather than sending a key built from an empty half
}

type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'libsql' | 'duckdb' | 'mongodb' | 'redis' | 'oracle' | 'db2' | 'mssql' | 'libredb' | 'couchbase' | 'clickhouse' | 'druid' | 'elasticsearch' | 'opensearch' | 'trino' | 'cassandra' | 'prometheus' | 'kafka' | 'etcd' | 'neo4j' | 'milvus' | 'qdrant' | 'influxdb' | 'influxdb3' | 'oxia';
type ConnectionEnvironment = 'production' | 'staging' | 'development' | 'local' | 'other';
```

The connection form exposes **Query Timeout (ms)** as an optional positive whole number, up to
2147483647. Leave it blank (or clear a saved value) to retain the 60-second default. Changing a
saved timeout refreshes its cached provider on the next request. Explicit provider options take
precedence; the connectivity check still uses its own 10000 ms timeout.

### DatabaseObject

The identity half of the object surface, as `POST /api/db/objects/list` and
`POST /api/db/objects/inventory` answer it.

```typescript
interface DatabaseObject {
  path: readonly string[]; // Container segments, then the object's own identifier
  name: string;            // Display label, NOT required to equal the last path segment
  kind: string;            // The declared kind id this object was listed under
  status?: string;         // Present only where the engine reports something worth acting on,
                           // in the engine's own word: Oracle's INVALID, SQL Server's DISABLED.
                           // Absent means ordinary, not unknown.
  rowCount?: number;       // Relations only, and only where the engine counts
  sizeBytes?: number;
  readRanges?: readonly ObjectReadRange[]; // Present only where this connection may read part of
                           // the object's range and not all of it: the pieces it may read, as an
                           // etcd prefix group carries them for a user who is not root.
                           // Absent means the connection may read the whole object.
}

type ObjectReadRange =
  | { key: string }                 // One key
  | { prefix: string }              // Every key under the prefix
  | { start: string; end: string }; // Every key from start up to but not including end

interface ColumnSchema {
  name: string;            // Column name
  type: string;            // Data type
  nullable: boolean;       // Allows NULL
  isPrimary: boolean;      // Primary key
  defaultValue?: string;   // Default value
  defaultExpression?: string; // The SQL that produces it, where the provider has it. MySQL
                           // only with includeDefaultSql, since its catalog spells a value (#1031)
  provenance?: "sampled";  // Inferred from sampled rows rather than declared; never sent to MCP or a model
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
  rolledBack?: boolean;    // Set by the client when SANDBOX ran the statement and the server confirmed the rollback; never sent by a route
  pagination?: QueryPagination;          // Auto-limiting the route attaches to every response
  warnings?: QueryWarning[];             // Notices the engine attached; ABSENT when it reported none
  columnTypes?: Record<string, string>;  // Declared type per column, keyed by its name in `fields`
  vectorColumns?: Readonly<Record<string, VectorColumn>>; // Vector columns by name; ABSENT when the result has none
  resultSets?: QueryResultSet[];         // Every set of a multi-result text; never sent by /api/db/query or /api/db/transaction
}

interface QueryPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
  totalReturned: number;
  wasLimited: boolean;
}

interface QueryWarning {
  message: string;         // The notice, as the engine worded it
  code?: number | string;  // The engine's own identifier, when it reported one
  severity?: string;       // The level it was raised at (`WARNING`, `NOTICE`), as the server spells it (may be localized), when it reports one
}

interface VectorColumn {                            // One entry of `vectorColumns`
  kind: "dense" | "sparse" | "multi";               // VectorKind
  dtype: "float32" | "float64" | "float16" | "bfloat16" | "int8" | "uint8" | "binary"; // VectorDType
  dimension: number | null;                         // Elements per vector, bits for "binary", one row's size for "multi"; null for "sparse" and where the engine declares none
  sparseEncoding?: "index-map" | "indices-values";  // SparseEncoding: set on every sparse column
}
```

`pagination` is the object `POST /api/db/query` attaches to every response (`limit`, `offset`,
`hasMore`, `totalReturned`, `wasLimited`). Both optional channels (`warnings`, `columnTypes`) are
filled only by providers whose source declares them, and **absence is the signal**: a run that
produced no warnings omits the field rather than sending `[]`, so a client can decide what to render
from the field's presence alone. `columnTypes` is the declared type of *this* result, which is the
only source for a computed column or an ad-hoc projection — the schema has no catalog entry to
answer with.

A binary cell (a PostgreSQL `bytea`, a MySQL `BLOB`/`VARBINARY`, a SQL Server `varbinary`, an Oracle
`RAW`/`BLOB`, a SQLite or libSQL `BLOB`) crosses this response in the form a Node `Buffer`
serializes to, `{"type":"Buffer","data":[222,173,0,255]}`, and that shape is how the client
recognises it as binary. Everywhere the client writes the value out it is lowercase hex behind `\x`
instead (`\xdead00ff`): the grid, Copy Cell, the row detail sheet, the CSV export, the JSON export
and its Copy as JSON, Copy Row as JSON and the row detail's Copy JSON. The JSON export writes it as
that plain string and carries no column types, so what tells a reader it is binary is the source
column's declared type (the schema, or the DDL export), not the file. The SQL INSERT export writes
the dialect's binary literal built from the same hex (`'\xdead00ff'::bytea`, `X'dead00ff'`,
`HEXTORAW('dead00ff')`). The graph view's own JSON export (`graphJson`) is not one of these
surfaces: node and relationship properties keep the form the driver handed them in.

`vectorColumns` names the columns of this result that hold vectors, keyed by their names in `fields`, and is absent when the result has none, never an empty object.
A declared column's cells render as vector cells: the first 8 elements and the size in the grid (`768 dims`, bits for a binary vector, entries for a sparse one, rows for a multivector), a header line such as `dense float32, 768 dims` over the whole value in the row detail, and the whole value on Copy Cell.
A cell holds its engine's native form, so a copied cell is search data for its own engine: every element of a float vector and of every multivector is written with a fraction when it is integral (`1.0`), int8, uint8 and binary elements and every sparse index are written as integers, and a sparse cell keeps its encoding (`index-map` is `{"3":0.5}`, `indices-values` is `{"indices":[3],"values":[0.5]}`).
A masked column copies its mask, as every other masked cell does.
Only a declared column renders as a vector, so an array in any other column renders as the JSON it is.
`WorkspaceQueryResult`, the result a host returns to `StudioWorkspace`, carries the same optional field, and a page fetched by Load More that carries none keeps the first page's declaration.
`VectorColumn`, `VectorKind`, `VectorDType` and `SparseEncoding` are published from `@libredb/studio/types`.

### HealthInfo

```typescript
interface HealthInfo {
  activeConnections?: number;  // Absent when the engine cannot measure it - never a fabricated 0
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
| `413` | Payload Too Large - the request body, or one part's text, is above the object edit routes' own bound, or a statement is above the console text bound its connection type declares (`POST /api/db/query`) |
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

An engine error is `QUERY_ERROR` when the driver's own code says the statement is at fault, read from the code and never the message (#1427): a SQLSTATE of class `0A`, `21`, `22`, `23`, `42` or `44` (PostgreSQL-wire, MySQL-wire and Db2 drivers), a SQL Server error number for a syntax, name, constraint, conversion or object-permission error (`102`, `156`, `208`, `2627`, `2812` and their neighbours), an Oracle statement error (`ORA-00001`, `ORA-00900` to `ORA-00999`, `ORA-01400`, `ORA-01722`, `ORA-02290` to `ORA-02292` and their neighbours) or a SQLite `SQLITE_ERROR`, `SQLITE_CONSTRAINT`, `SQLITE_MISMATCH` or `SQLITE_RANGE`. So `SELEC 1`, an unknown table and a duplicate key answer `400` on MySQL as on PostgreSQL. Connection, authentication, timeout and cancellation errors keep their own codes, MySQL's account limits `1203` (`max_user_connections`) and `1226` (`max_questions` and the like) stay `DATABASE_ERROR` although their SQLSTATE is `42000`, and an engine error with no recognised code is still `DATABASE_ERROR`.

These are the values of the `code` field emitted by `createErrorResponse` (`src/lib/api/error-codes.ts`):

| Code | Description |
|------|-------------|
| `QUERY_ERROR` | SQL syntax or execution error (400) |
| `QUERY_CANCELLED` | Query cancelled by the client (499) |
| `CONFIG_ERROR` | Invalid database configuration (400) |
| `AUTH_ERROR` | Authentication failed (401) |
| `CUSTOM_CONNECTIONS_DISABLED` | `ALLOW_CUSTOM_CONNECTIONS` is off and the request supplied a connection that is not a seed (403); see `GET /api/connections/policy`. A seed the caller's role may not open is refused with `AUTH_ERROR` (403) instead |
| `AUTH_REQUIRED` | No Studio session, or one that no longer verifies (401). Answered by the middleware and the route-level session checks rather than `createErrorResponse`; the only 401 the browser answers by sending the user to sign in |
| `TIMEOUT_ERROR` | Query exceeded time limit (408); `POST /api/ai/query-safety` answers it with 504 when the model does not answer in time |
| `CONNECTION_ERROR` | Database connection failed (503) |
| `POOL_EXHAUSTED` | Connection pool exhausted (503) |
| `DATABASE_ERROR` | Generic database error (500) |
| `LLM_SAFETY` | Prompt blocked by safety filters (400) |
| `LLM_AUTH` | Invalid LLM API key (401) |
| `LLM_RATE_LIMIT` | LLM usage/rate limit reached (429) |
| `LLM_CONFIG` | LLM misconfigured (503) |
| `LLM_UNCONFIGURED` | No provider was named and its credentials are absent, so AI is treated as switched off (503) |
| `LLM_STREAM` | LLM streaming failure (502) |
| `LLM_ERROR` | Generic LLM error |
| `INTERNAL_ERROR` | Unhandled server error (500) |
| `NETWORK_ERROR` | Network failure |
| `RATE_LIMITED` | Application-level rate limit exceeded (429) - see "Rate Limiting" below |
| `EDIT_PLAN_INVALID` | An object edit plan did not verify: forged, expired, digest mismatch, wrong connection fingerprint, or an unknown `planVersion` (400). Returned by the two `/api/db/objects/edit-*` routes directly rather than through `createErrorResponse`. It is a machine-readable code and not a sentence, so a client can tell a plan that no longer verifies apart from an apply that failed and offer to rebuild the preview; no shipped UI branches on it yet |

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

A wrong password or code on `POST /api/auth/totp`, and on the `register-options` and `remove` actions of `POST /api/auth/passkey`, is charged to the same two budgets.

### Passkey sign-in

`POST /api/auth/passkey/sign-in` has a budget of its own, `passkey_client`, per client address: 10 failed attempts per 300 seconds by default (`RATE_LIMIT_PASSKEY_MAX`, `RATE_LIMIT_PASSKEY_WINDOW_SEC`).
It is checked before the body is read, for both actions, and every refused assertion, malformed body or unknown action spends one unit; a success clears nothing.
Passkey sign-in never spends the login budgets, so failed passkeys cannot lock an address out of password sign-in.
A signature cannot be guessed, so this budget bounds CPU, database reads and audit volume rather than guessing.

### Launch sign-in

`POST /api/auth/launch` spends the password sign-in's per-address budget, `login_client` (`RATE_LIMIT_LOGIN_MAX`, `RATE_LIMIT_LOGIN_WINDOW_SEC`).
It is checked before the body is read, every refused token, refused account, refused session swap or malformed body spends one unit, and a successful launch clears the address's failures.
A launch never spends or clears the per-account budget, because it is not a password guess.

### Every session-guarded route

Every route that reaches a database or an LLM provider shares one of two rate-limit buckets, keyed
on the signed-in session, not the client address. The families rather than a total, because a route
can join a bucket two ways — through its session guard, or by spending the bucket directly — and a
single number written here has gone stale every time it was updated:

| Bucket | Applies to | Default |
|--------|-----------|---------|
| `ai` | The `/api/ai/*` routes, plus every `/api/agent/*` route except `GET /api/agent/config`: classifying an objective, starting a run, driving one, reading one, cancelling one, streaming one, and fetching an artifact | 20 requests / 60 seconds |
| `query` | Every database-reaching `/api/db/*` route, plus `/api/admin/fleet-health`, the three storage data routes (`GET /api/storage`, `PUT /api/storage/{collection}`, `POST /api/storage/migrate`) and the owner's own factor routes (`/api/auth/totp`, `/api/auth/passkey`), together | 120 requests / 60 seconds |

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

The admin password is generated on first run and printed to the server log, or set
through `ADMIN_PASSWORD`. Put yours in place of the placeholder below.

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@libredb.org", "password": "<your admin password>"}' \
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

#### Read the objects, with their columns
```bash
curl -X POST http://localhost:3000/api/db/objects/inventory \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "connection": { "id": "1", "name": "Local PG", "type": "postgres" },
    "kinds": ["table"],
    "includeColumns": true
  }'
```

Add `"includeDefaultSql": true` (with `includeColumns`) to have each column carry `defaultExpression`,
the SQL a migration writes after `DEFAULT`. On MySQL that costs one `SHOW CREATE TABLE` per table with a
default, because its catalog reports the value rather than the SQL; SchemaDiff asks for it, nothing
else does (#1031). Without `includeColumns` it is a 400.

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
    body: JSON.stringify({ email: 'admin@libredb.org', password: process.env.ADMIN_PASSWORD }),
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
| `JWT_SECRET` | Recommended | JWT signing secret (min 32 chars). Auto-generated at boot if unset unless `AUTH_BOOTSTRAP=off`, which turns off secret generation as well as credential generation. Unset with bootstrap off **in production**, the server exits at startup rather than serving a deployment whose every login is 503; outside production the development fallback still applies. Set but shorter than 32 chars: the server exits at startup with code 1 rather than serving a deployment whose logins all fail with 503 |
| `ADMIN_PASSWORD` | Recommended | Admin account password. Auto-generated and printed once at boot if unset unless `AUTH_BOOTSTRAP=off` |
| `ADMIN_EMAIL` | No | Admin login email (default `admin@libredb.org`) |
| `USER_PASSWORD` | No | Optional lower-privilege account password; the `user` account exists only when this is set |
| `USER_EMAIL` | No | Regular-user login email (default `user@libredb.org`, only used when `USER_PASSWORD` is set) |
| `DB_HTTP_BLOCK_PRIVATE_HOSTS` | No | Off when unset. `true`, `on`, or `1` blocks HTTP database requests to loopback, private, link-local, unique-local and selected special-use addresses; `false`, `off`, or `0` allows them. DNS answers are checked at socket connection time. Invalid values fail closed for HTTP databases. Non-HTTP drivers and SSH tunnel hosts are outside this guard; HTTP connections through an SSH tunnel are refused while it is enabled. |
| `ALLOW_CUSTOM_CONNECTIONS` | No | On when unset. `false`, `0`, `off` or `no`, or any unrecognised value (it fails closed and logs an error), refuses, with 403, every connection a request supplies that is not a seed, on every route that builds a database provider; see `GET /api/connections/policy` |
| `LLM_PROVIDER` | No | AI provider: gemini, openai, ollama, custom |
| `LLM_API_KEY` | No | AI provider API key |
| `LLM_MODEL` | No | AI model name |
| `LLM_API_URL` | No | Custom AI endpoint URL. Read for every kind, on the chat surface and in the agent alike. For `gemini` give the versioned URL (`https://host/v1beta`); a bare origin also works, the version segment is composed for it (`src/lib/llm/utils/gemini-endpoint.ts`) |
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
