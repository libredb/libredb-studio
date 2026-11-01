# libSQL Provider

> libSQL support for LibreDB Studio, built on the Hrana HTTP protocol (`POST /v2/pipeline`) with
> **no driver dependency of any kind**: a statement is JSON in the body of a POST and the answer
> comes back through the runtime's own `fetch`. One type-id reaches two deployments — a self-hosted
> **libSQL server (`sqld`)** and **Turso Cloud** — because they speak the same protocol and embed the
> same SQLite. This document is the single reference point for the libSQL provider: design,
> architecture, usage, and tests.

`DB_HTTP_BLOCK_PRIVATE_HOSTS=true` blocks loopback, private, link-local and other non-public HTTP destinations; it is off by default so local connections work.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `libsql` |
| **Family** | SQL (`src/lib/db/providers/sql/libsql/`) |
| **Driver** | None — HTTP only (`fetch`, a runtime built-in) |
| **Query language** | `sql` (SQLite's dialect. The embedded version depends on the BUILD, not on the version number: `:latest` and Turso Cloud answered 3.47.0 and the pinned `v0.24.33` answers 3.45.1 - see **Reproducible with** below) |
| **Default port** | `8080` (sqld's own). `443` when TLS is on, which is how Turso Cloud serves every database |
| **Connection pooling** | None — each statement is one stateless HTTP request |
| **Connection string** | Supported (`libsql://<database>-<org>.turso.io?authToken=<jwt>`) |
| **Credential** | An auth TOKEN, sent as `Authorization: Bearer` and labelled "Auth Token" in the form. A connection that also names a `user` sends `Authorization: Basic` instead, for a self-hosted `sqld` started with `SQLD_HTTP_AUTH` ([§4.5](#45-http-basic-for-a-self-hosted-server)) |
| **EXPLAIN** | `sqlite-queryplan` — the same `EXPLAIN QUERY PLAN` shape SQLite answers |
| **Transactions** | Not exposed (the provider closes its Hrana stream with each statement, so it holds no session for one) |
| **Maintenance** | `reindex` and `check` only — `VACUUM`, `ANALYZE`, `PRAGMA optimize` and `PRAGMA wal_checkpoint` are refused by the server on both deployments |
| **Source** | [`src/lib/db/providers/sql/libsql/`](../../src/lib/db/providers/sql/libsql/) |
| **Tests** | [`tests/integration/db/libsql-provider.test.ts`](../../tests/integration/db/libsql-provider.test.ts) + [`tests/unit/db/libsql/`](../../tests/unit/db/libsql/) |
| **Tracking issue** | [#424 — the database coverage map](https://github.com/libredb/libredb-studio/issues/424) |
| **Probed against** | `ghcr.io/tursodatabase/libsql-server` reporting `sqld 0.24.33 (f8fb14f3 2026-08-11)`, and a Turso Cloud database in `aws-eu-west-1`, both on 2026-08-27 |
| **Reproducible with** | `ghcr.io/tursodatabase/libsql-server:v0.24.33`, the tag `database-compose.yml` pins. It is a DIFFERENT build of the same version - `sqld 0.24.33 (40a151bd 2025-12-19)`, because `:latest` is a rolling rebuild - and it was re-probed surface by surface on 2026-08-27: the same 17 of 19, the same four refusals with byte-identical wording, and the same `"notnull"` behaviour. **One thing the two builds do NOT share is the embedded SQLite version**: `:latest` and Turso Cloud answer `3.47.0` and the pinned tag answers `3.45.1`, re-measured 2026-09-11 while building the object surface. Every measurement below holds on the pinned tag, and where a version floor matters the doc says which build it was taken from. |

---

## 1. Overview

libSQL is a fork of SQLite that keeps the file format and the dialect and adds a **server**. What a
client talks to is `sqld`, and what `sqld` speaks is Hrana: a list of requests posted as JSON, one
result per request, values encoded as `{ type, value }` with integers carried as decimal strings.
Turso Cloud is that same server, managed and reached over TLS on a hostname that identifies the
database.

That is the whole reason this is a separate type-id from `sqlite` rather than a relative of it, and
the reason it is ONE id rather than two:

- **Not `sqlite`.** The SQLite provider holds a FILE handle through a synchronous driver
  (`bun:sqlite` / `node:sqlite`), reads sizes with `fs.statSync`, and enforces the agent read-only
  profile with `PRAGMA query_only`. None of those three exist here: there is no file on this
  machine, no handle to hold, and `PRAGMA query_only = true` is refused by the server. The dialect is
  shared; the execution layer has nothing in common.
- **Not two ids.** A self-hosted `sqld` and a Turso Cloud database differ in host, TLS and token.
  Every statement, every catalog and every refusal measured the same on both. Two ids would mean two
  docs and two tests describing one set of measurements.

**Turso Database — the Rust rewrite — is deliberately absent.** It is a different engine (written
from scratch, SQLite-compatible, concurrent writes and vector search) rather than a deployment of
this one, and on 2026-08-27 it published **no server image**: `tursodatabase/turso`,
`tursodatabase/tursodb` and `ghcr.io/tursodatabase/turso-server` were all unpullable, and the engine
ships as an in-process npm package (`@tursodatabase/database`). #424 publishes a name only after
connecting to it, so it earns no row here or in the compatibility registry.

### Concept mapping

| libSQL | This product | Note |
|---|---|---|
| A database (a hostname on Turso Cloud, a namespace on `sqld`) | The connection | There is no `database` field: the database IS the host |
| `main` schema | The single schema | SQLite has one, and the provider reports `schemaName: "main"` throughout |
| Table | Table | `sqlite_master` |
| Index | Index | `pragma_index_list`, minus SQLite's own `sqlite_autoindex_*` |
| Auth token (JWT) | The `password` field | Labelled "Auth Token" in the connection dialog |
| The user and password of `SQLD_HTTP_AUTH` | The `user` and `password` fields | Sent together as HTTP Basic; the Username box's hint says when to fill it |
| `dbstat` pages | Table and index bytes | Available on BOTH deployments, unlike `bun:sqlite` |

---

## 2. Architecture

```
src/lib/db/providers/sql/libsql/
├── index.ts             LibSQLProvider — the 13 provider methods, capabilities, labels
├── introspect.ts        every read expressed as SQL (sqlite_master, pragma_*, dbstat)
├── transport.ts         the NEUTRAL seam: what a caller needs, not how Hrana spells it
└── hrana-transport.ts   the only file that knows /v2/pipeline, the baton and the value codec
```

`tests/unit/db/libsql/seam-guard.test.ts` parses every file in that directory and fails the build if
Hrana vocabulary (`baton`, `base_url`, `affected_row_count`, `query_duration_ms`,
`replication_index`, `decltype`, `rows_read`, `rows_written`, the endpoint path) appears outside
`hrana-transport.ts`. `last_insert_rowid` is checked only as a payload READ, because it is also a
real SQLite function that any implementation may legitimately call.

The seam is not ceremony: Hrana also runs over WebSocket, `@tursodatabase/database` embeds the engine
in-process, and `@libsql/client` speaks both. Any of them would answer the same questions — none of
them with a `baton`.

---

## 3. Design decisions

### 3.1 No driver, and the reason is the protocol's size

`@libsql/client` is a dependency to speak a protocol that is three JSON shapes wide: a request list,
a result list, and a typed value. The whole transport is ~330 lines including the comments that
record the wire. The same judgement as Couchbase (#263), ClickHouse (#264), Druid (#265) and Trino
(#438).

### 3.2 A failed statement answers HTTP 200

Measured on both deployments:

```
POST /v2/pipeline   {"requests":[{"type":"execute","stmt":{"sql":"SELECT * FROM no_such_table"}},{"type":"close"}]}
HTTP/1.1 200 OK
{"baton":null,"base_url":null,"results":[
  {"type":"error","error":{"message":"SQLite error: no such table: no_such_table","code":"SQLITE_UNKNOWN"}},
  {"type":"ok","response":{"type":"close"}}]}
```

So `response.ok` says the pipeline was accepted, never that the statement ran. Every failure is read
out of `results[]`. This is the trap Trino's provider documents in the same words, and it is why the
transport carries `status: 200` on a statement error deliberately: the transport succeeded.

### 3.3 An auth failure uses a different envelope, and a bad token is a 400

| Situation | Status | Body |
|---|---|---|
| No token to a private database | `401` | `{"error":"Unauthorized: \`unauthorized access attempt on database: empty JWT token\`"}` |
| Malformed token | `400` | `{"error":"JWT error: InvalidToken"}` |
| Statement rejected | `200` | `{"results":[{"type":"error","error":{"message":…,"code":…}}]}` |

The auth envelope's `error` is a bare STRING rather than the `{ message, code }` object the statement
path uses, so the error reader handles both. 400 is in the provider's authentication set alongside
401 and 403 for that reason: keying only on 401 would report a malformed token as a connection
failure.

### 3.4 Integers arrive as decimal strings, and the same digits go back as integers

Hrana quotes every integer — `{"type":"integer","value":"2000"}` — which is the protocol protecting
64-bit values from a double. `decodeInteger` returns a `number` when the value is exactly
representable and the **decimal string verbatim** when it is not. `Number("9007199254740993")` is
9007199254740992, and a rounded rowid is a corruption nothing downstream can detect (#460 is the
Trino version of the same lesson).

The one place a wide integer IS parsed to a double is `readNumber` in `introspect.ts`, and only for
display statistics: a row count above 2^53 is 9 quadrillion rows. Result CELLS never pass through it.

**Sending one back.** Reading exactly is only half an edit. `decodeInteger` is lossy in ONE direction:
`9007199254740993` the integer and `'9007199254740993'` the text both leave this transport as the same
JavaScript string, so a value arriving in a bind carries no clue which it was. SQLite settles that by
the COLUMN's affinity, and only for a column that HAS one. Measured 2026-09-18 against sqld 0.24.33
(`ghcr.io/tursodatabase/libsql-server:v0.24.33`, SQLite 3.45.1), on a row whose key is
`9007199254740993`, sending each bind over `POST /v2/pipeline` both ways:

| Column declared | `{"type":"text"}` (what the read used to send back) | `{"type":"integer"}` (what it sends now) |
|---|---|---|
| `INTEGER` / `NUMERIC` | 1 row | 1 row |
| `TEXT` | 1 row | 1 row |
| `BLOB` | **0 rows** | 1 row |
| no type at all | **0 rows** | 1 row |

`INTEGER` and `NUMERIC` affinity convert the text to a number before comparing and `TEXT` affinity
converts the integer to text, so those answer the same either way. A column declared `BLOB` or
declared NOTHING has NO affinity: SQLite compares the operands as they stand, a text is never equal to
an integer, and **the row the grid had just read could not be found again** — `UPDATE … WHERE id = ?`
reported 0 rows changed and the editor told the user nothing had happened.

Note what this is NOT. Unlike `bun:sqlite`, the read side here never rounds — Hrana quotes its
integers — so the damage was a silent NO-OP, never a write onto the neighbouring row
([sqlite.md §3.6](./sqlite.md#36-a-64-bit-integer-survives-the-round-trip-in-both-directions) is the
other half of that comparison).

The affinity is not knowable at a bind — a bind is a value, and the protocol never names the column an
operand belongs to — so `encodeValue` answers the question it CAN answer exactly: **it accepts back
precisely what `decodeInteger` hands out**, and leaves every other string as text. The bound and the
digit shape it tests against are read from
[`sqlite-int64.ts`](../../src/lib/db/providers/sql/sqlite-int64.ts), which the SQLite driver reads
too: both providers hand out the same shape, so they must accept the same shape back. Those digits are
emitted for one input only, a 64-bit integer outside the safe range, so reading them back as that
integer is the exact inverse:

| Bound string | Sent as | Why |
|---|---|---|
| `"9007199254740993"`, `"-9007199254740993"`, `"9223372036854775807"` | `{"type":"integer"}` | the only shape the read emits |
| `"1"`, `"9007199254740991"` | `{"type":"text"}` | inside the safe range the read hands out a NUMBER, never digits, so such a string is the caller's own text |
| `"007"`, `"+7"`, `" 7"`, `""`, `"7.0"`, `"9e15"` | `{"type":"text"}` | shapes the read cannot emit |
| `"99999999999999999999"`, `"9223372036854775808"` | `{"type":"text"}` | wider than SQLite's own `INTEGER`, so no row could match as a number either |

Only a real `string` is tested, never `String(param)` of some other object: the read side hands out
strings and nothing else, so nothing else can be a value it emitted.

**The round trip, end to end through the provider against that live server.** Two rows with ids
`9007199254740992` and `9007199254740993`, read back and then edited on the id that was read:

| Column declared | Read back | `UPDATE` on the read key | Rows afterwards |
|---|---|---|---|
| `INTEGER` | `"9007199254740992"`, `"9007199254740993"` | 1 row | `…992=neighbour`, `…993=edited` |
| `TEXT` | the same two | 1 row | the same |
| `BLOB` | the same two | 1 row | the same |
| no type at all | the same two | 1 row | the same |

Ordinary values are untouched in the same pass: `SELECT 1` is still the number `1` and `COUNT(*)`
still a number. A genuinely textual all-digit key is still text — `'9007199254740993'` and `'007'` in
a `TEXT PRIMARY KEY` both match, and `typeof(id)` reads `text` for both — because `TEXT` affinity
converts the bind back to text.

What that costs, measured and accepted: in a column with NO affinity that genuinely stores this shape
as TEXT, the bind now misses where it used to match. That is the same ambiguity read from the other
end, it cannot be resolved without the affinity, and the integer reading is the one these digits exist
for. This is the same rule `toSQLiteBindValue` applies in the SQLite driver, by design — the two
providers hand out the same shape, so they accept the same shape back.

### 3.5 The server refuses four statements, so four controls are withheld

Measured on both deployments, with the wording differing and the code identical:

| Statement | sqld 0.24.33 | Turso Cloud |
|---|---|---|
| `VACUUM` | `unsupported statement: VACUUM` | `SQL not allowed statement: VACUUM` |
| `ANALYZE` | `unsupported statement: ANALYZE` | `SQL not allowed statement: ANALYZE` |
| `PRAGMA optimize` | `unsupported statement: PRAGMA optimize` | `SQL not allowed statement: PRAGMA optimize` |
| `PRAGMA wal_checkpoint(TRUNCATE)` | `unsupported statement` | `SQL statement is not allowed` |
| `PRAGMA query_only = true` | `unsupported statement` | `SQL not allowed statement` |
| `REINDEX` | accepted | accepted |
| `PRAGMA integrity_check` | accepted | accepted |

`maintenanceOperations` is therefore `["reindex", "check"]`. A Vacuum control that fails every time
is the Cloud Spanner shape #424 refuses rows for, and `runMaintenance` refuses the other types HERE
rather than sending them, so the message names the reason instead of relaying a server error for a
statement the user never typed.

**Nothing keys on the wording.** The two deployments word the identical refusal differently under one
`SQL_PARSE_ERROR`, so a provider that matched on text would have been wrong on one of them from the
first day.

### 3.6 The agent read-only profile rests on a read-only token

`sqlite.ts` implements `queryReadOnly` by setting `query_only` and verifying the readback, per statement.
libSQL has no such lever: the pragma is refused on both deployments, for every credential.
So the boundary here is credential-enforced: a token the server refuses every write for.
A self-hosted sqld started with `SQLD_AUTH_JWT_KEY` checks a JWT signed by that key, and refuses a write from one whose claims carry `"a": "ro"` unless a permission claim (`"p"`) widens it: a token carrying `"a": "ro"` and a `"p"` that grants `rw` on the namespace writes, which the open refuses.
Turso Cloud mints the same kind of token with `turso db tokens create --read-only`.
sqld classifies every statement before it runs it, and refuses a request that carries a write from such a token as a whole, with HTTP 403 (`Authorization forbidden: Current session doesn't not have Write permission to namespace default`), on each HTTP statement route measured (`/v2/pipeline`, `/v3/pipeline`, `/v1/execute`, `/v1/batch` and `/`); Hrana over WebSocket was not measured, and this provider never speaks it.
Turso Cloud refuses the same write in-band instead: the request answers HTTP 200, and the statement's step carries the error, code `BLOCKED`, `Operation was blocked: SQL write operations are forbidden (current session doesn't have write permission)`.
Agent mode executes statements on PostgreSQL, SQLite, DuckDB, SQL Server, MySQL, Kubernetes, MongoDB, ClickHouse, libSQL, InfluxDB 3 (SQL), Elasticsearch, OpenSearch, Oracle, Db2 LUW, Apache Cassandra, Couchbase, Apache Druid, LibreDB, InfluxDB (InfluxQL), Weaviate, Qdrant, Neo4j, Milvus, Redis, etcd, Oxia, RabbitMQ, Apache Kafka, S3-compatible object storage, Firestore, SNMP, NETCONF, Modbus, Prometheus, OPC UA, MTConnect, MQTT, Sparkplug B and Trino; on libSQL the provider implements `queryReadOnly` in [`index.ts`](../../src/lib/db/providers/sql/libsql/index.ts), with the open's proof in [`agent-boundary.ts`](../../src/lib/db/providers/sql/libsql/agent-boundary.ts) and the reading of an answer in [`agent-read.ts`](../../src/lib/db/providers/sql/libsql/agent-read.ts).

#### The open's proof

The proof runs in `connect()` only when the execution context sets both `readOnly` and `sendsStatements`, the agent and hand-over profiles.
The operations profile and plan mode send no statement of the model's, so they open unproven, and plan mode keeps grounding on a connection whose token writes.
`queryReadOnly` refuses on any handle opened without that context, an ordinary editor handle included, before it sends anything.
Any answer the proof cannot read refuses the profile.

1. The connection must send a bearer token.
   A connection that names a user signs in with HTTP Basic, which sqld (`SQLD_HTTP_AUTH`) grants every statement and has no read-only form for, and is refused `PROFILE_PRIVILEGES_TOO_BROAD`.
   A connection with no token reaches only a server that checks no credential, and is refused `PROFILE_SERVER_UNENFORCED`.
   Both are refused before anything is sent.
2. The token must be a read-only token and carry nothing that could widen it.
   It must be a JWT whose claims carry `"a": "ro"`, and its only other claims may be the standard ones and the ids the two servers mint: `exp`, `iat`, `nbf`, `id`, `kid`, `rid`, `iss`, `sub`, `aud` and `jti`.
   Any other claim, sqld's `"p"` permission claim, a `perm` claim or one no server has minted yet, may be read by the server to grant writes.
   A token that fails either test is refused `PROFILE_PRIVILEGES_TOO_BROAD` with a message that says it can write and that the profile needs a read-only token, so the run ends with the reason `agent-principal-refused`.
   This check runs before anything is sent with the token, so a token that can write is never sent a probe.
   Studio cannot verify the signature, so this reads the token's own statement, which the server's answers below must bear out, never instead of them.
3. After the connect probe, three writes go with the agent's token, each on a name made fresh for the open (`libredb_agent_probe_<32 hex digits>`), so none changes anything on any outcome: `DROP TABLE IF EXISTS "<name>"`, `DELETE FROM "<name>" WHERE 0` and `INSERT INTO "<name>" SELECT 1 WHERE 0`.
   Each server classifies each as a write before it looks for the table.
   Each must be answered with one server's own read-only refusal, matched on its full measured wording, and the same server's refusal must answer all three: sqld's 403 `Authorization forbidden: Current session doesn't not have Write permission to namespace <name>`, or Turso Cloud's HTTP 200 step error with code `BLOCKED` and the wording above.
   A 403 with any other body, such as a proxy's, does not count.
   Turso's `BLOCKED` refusal that ends `(writes are blocked, do you need to upgrade your plan?)` is what a token that can write is answered on a database whose writes are blocked, and it refuses the profile.
   A probe the server runs was sent with a token that declares read-only access, so the server does not hold tokens to their claims: it checks no token, or admits one it did not sign.
   That refuses the profile `PROFILE_SERVER_UNENFORCED`, which ends the run with the reason `server-authorization-off`.
   Any other answer, a statement error such as "no such table" included, refuses it `PROFILE_UNSUPPORTED_TARGET`.

The proof runs at open only: a token whose rights change after the open is seen at the next open of a profiled handle.
Turso Cloud was measured on 2026-10-29 on a scratch database with a read-only token and a full-access one.
The read-only token carries the claims `a`, `exp`, `iat`, `id`, `kid` and `rid`, and Turso answered its writes with the in-band `BLOCKED` refusal above.
The integration suite replays that answer from a local server that answers as Turso does, with no Turso token.

#### The agent token

The agent credential takes the token form: the agent token alone, sent as the bearer credential in place of the connection's own token, with an agent user beside it refused.
An agent token beside a connection string is refused (`AGENT_CREDENTIAL_WITH_CONNECTION_STRING`), since the URL's own `authToken` would win; with no agent token the agent runs with the connection's own token, which the open must admit.
A connection that names a user cannot carry an agent token: the user would turn it into HTTP Basic, which the open refuses.
A token sqld admits, with a key pair made for the server and the claims `{"a": "ro"}`; the public key goes in `SQLD_AUTH_JWT_KEY` as the raw 32 bytes in URL-safe base64:

```ts
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
const { privateKey } = generateKeyPairSync("ed25519");
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const body = `${part({ alg: "EdDSA", typ: "JWT" })}.${part({ a: "ro" })}`;
console.log("SQLD_AUTH_JWT_KEY", createPublicKey(privateKey).export({ format: "jwk" }).x);
console.log("token", `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`);
```

#### The statement path

Each call sends one statement as the single statement step of one request that closes its own stream, so nothing a statement opens outlives the call: a `BEGIN IMMEDIATE` answers the read-only token, and a write with another token right after it runs.
sqld refuses a second statement in the same text (`SQL_MANY_STATEMENTS`).
A write the server refuses reaches the caller as a statement refusal in the server's own words, not as a failed credential.
Hrana has no server-side row or byte bound, so the transport reads the answer in chunks and stops at six times the byte budget plus a 1 MiB envelope (`agentBodyCap`), since a value on the wire takes at most a little over five times the bytes it takes in the caller's row; the parsed rows are then held to the row and byte budgets, and every refusal is the shared sentence of [`read-only-budget.ts`](../../src/lib/db/providers/sql/read-only-budget.ts).
The deadline is the transport's own, and a statement past it is refused as over the time budget.
Hrana has no cancel request; closing the request at the deadline is what stops the statement: a recursive count held a core at 100% until the abort, and the server was idle within two seconds of it.
An estimating plan is the `EXPLAIN QUERY PLAN` prefix the agent composes, sent in the ordinary execute mode; the estimate-plan session mode is refused.

#### What only the server stops

Every statement below is refused by the server for every token, the writable one included, with its own statement error rather than a 403: `ATTACH DATABASE` (`unsupported statement`), `VACUUM` and `VACUUM INTO`, `ANALYZE`, `CREATE TEMP TABLE`, `PRAGMA journal_mode`, `PRAGMA writable_schema` and `PRAGMA query_only` with a value (`unsupported statement`), `SELECT load_extension(...)` (`not authorized`), and `CREATE FUNCTION ... LANGUAGE wasm` (a syntax error).
No namespace or admin route answers on the statement port (`/v1/namespaces/...` is 404); the admin API listens only where the operator starts it on a port of its own.
The read-only token can read `GET /dump`, which is a read of the whole database, and is never sent by this provider.
`EXPLAIN` of a write compiles it without running it, and answers the read-only token.

#### Boundary record

Measured on `ghcr.io/tursodatabase/libsql-server:v0.24.33` (`sqld 0.24.33 (40a151bd 2025-12-19)`, SQLite 3.45.1) on 2026-10-29, by [`tests/live/libsql-agent-boundary.ts`](../../tests/live/libsql-agent-boundary.ts), with Studio's agent admission bypassed: 96 checks, all passing.
Three servers: one checking JWTs with a read-only token, a writable token and a read-only token whose permission claim grants writes, all signed by its key, one started with HTTP Basic, and one checking no credential.

| Probe | Read-only token, through `queryReadOnly` | Writable token, positive control on a scratch table |
| --- | --- | --- |
| `INSERT`, `INSERT ... RETURNING`, `INSERT ... ON CONFLICT DO UPDATE`, `REPLACE`, `UPDATE`, `DELETE`, `WITH ... DELETE` | 403 | ran |
| `CREATE TABLE`, `CREATE INDEX`, `CREATE VIEW`, `CREATE TRIGGER`, `ALTER TABLE ... ADD COLUMN`, `DROP INDEX`, `DROP TABLE` | 403 | ran |
| `REINDEX`, `PRAGMA user_version = 5`, `PRAGMA foreign_keys = OFF` | 403 | ran |
| `ATTACH`, `VACUUM`, `VACUUM INTO`, `ANALYZE`, `CREATE TEMP TABLE`, `PRAGMA journal_mode`, `PRAGMA writable_schema`, `PRAGMA query_only = 0` | `unsupported statement` | `unsupported statement` |
| `SELECT load_extension(...)` | `not authorized` | `not authorized` |
| `CREATE FUNCTION ... LANGUAGE wasm` | syntax error | syntax error |
| `SELECT 1; DELETE ...` | `SQL_MANY_STATEMENTS` | `SQL_MANY_STATEMENTS` |
| a write in a batch, a sequence or a stored statement, and on `/v3/pipeline`, `/v1/execute`, `/v1/batch` and `/` | 403 | not sent |

The tables, rows, indexes, views, triggers and `user_version` read back the same before and after the refused statements.
Each of the open's three probes answered the read-only token 403 with `Authorization forbidden: Current session doesn't not have Write permission to namespace default`; the writable token ran the `DROP TABLE IF EXISTS` and was told "no such table" by the other two, so none changed anything.
At open, the read-only token was admitted, and these were refused.
The writable token, on the JWT server and on the server that checks no credential, was refused `PROFILE_PRIVILEGES_TOO_BROAD` before a probe was sent.
A user name and password on the Basic server were refused `PROFILE_PRIVILEGES_TOO_BROAD`, with nothing sent.
The read-only token on the Basic server failed its connect probe with 401, and so did a read-only token with a forged signature on the JWT server.
The server that checks no credential was refused `PROFILE_SERVER_UNENFORCED` with no token (nothing sent), and with the read-only token and the forged one (the probe ran).
The operations profile opened the writable token unproven, and read the object surface plan mode grounds on.
An editor handle refused `queryReadOnly` before sending anything.
The catalog reads, the statistics probe, the estimating plan and the pattern table profile the agent composes each answered the read-only token.
The budgets: 51 rows under a budget of 50, 100,000 bytes of hex under 65,536, and a statement past a one-second deadline were each refused, and the server answered the next statement.
A token whose permission claims the server cannot read is refused 401 at connect, before the proof.
A token carrying `"a": "ro"` and `"p": {"rw": {"ns": ["default"]}}` ran `INSERT`, `DELETE ... WHERE 0` and `DROP TABLE IF EXISTS` on the server, and the open refused it on its claims (`PROFILE_PRIVILEGES_TOO_BROAD`) before a probe was sent.

Run it against servers you may write to; it creates tables with the `libredb_lb_` prefix and drops them on exit:

```sh
docker run -d -e SQLD_NODE=primary -e SQLD_AUTH_JWT_KEY=<public key> -p 18181:8080 ghcr.io/tursodatabase/libsql-server:v0.24.33
docker run -d -e SQLD_NODE=primary -e SQLD_HTTP_AUTH=basic:<base64 of user:password> -p 18182:8080 ghcr.io/tursodatabase/libsql-server:v0.24.33
docker run -d -e SQLD_NODE=primary -p 18183:8080 ghcr.io/tursodatabase/libsql-server:v0.24.33
LIBREDB_LIVE_LIBSQL_JWT_PORT=18181 LIBREDB_LIVE_LIBSQL_RO_TOKEN=<ro token> LIBREDB_LIVE_LIBSQL_RW_TOKEN=<rw token> \
  LIBREDB_LIVE_LIBSQL_WIDENED_TOKEN=<ro token with a p claim granting rw> \
  LIBREDB_LIVE_LIBSQL_BASIC_PORT=18182 LIBREDB_LIVE_LIBSQL_BASIC_USER=<user> LIBREDB_LIVE_LIBSQL_BASIC_PASSWORD=<password> \
  LIBREDB_LIVE_LIBSQL_OPEN_PORT=18183 bun tests/live/libsql-agent-boundary.ts
```

#### MCP read

MCP's `run_read_query` serves libSQL through the agent's own path: it takes the connection under the agent read-only profile, so the open runs the proof above, and sends the statement through `queryReadOnly`, alone in one request under the token.
It shares the agent's profiled handle, so the proof runs at the open of that handle, as in agent mode, not before each statement: a token whose rights change after the open is seen at the next open.
A seed carries no separate agent token, so the seed's own token must be one the open admits: a writable token, a read-only token with any other claim, a user name and password (HTTP Basic), no token, and a server that runs the probes are each refused, in the tool's sentence, before any statement runs.
MCP's statement fence refuses a write-shaped statement before anything is acquired, as defence in depth; it also refuses every `PRAGMA`, reads included, and `EXPLAIN` of a write.
It runs a `SELECT` (a `WITH` is fine), `VALUES`, or `EXPLAIN`: `TABLE` and `EXPLAIN ANALYZE` are syntax errors on sqld 0.24.33, as on SQLite, and `EXPLAIN QUERY PLAN` runs; it pages with `LIMIT n OFFSET m`, and an offset on `VALUES`, `EXPLAIN` or a query with its own `LIMIT` is refused.
A result past 1000 rows or 1 MiB is refused, never cut, and one past `timeout_ms` is answered as the timeout: the provider closes the request at the deadline, which stops the statement on sqld.
A client that closes its request stops the wait only: the statement runs on until the provider closes its request at the time left of `timeout_ms`.
Measured on 2026-11-01 by watching the container: after a two-second `timeout_ms` the server was idle within a second, and after a cancel one second into a 15-second `timeout_ms` a recursive count held a core until that deadline.

[`tests/live/libsql-mcp-boundary.ts`](../../tests/live/libsql-mcp-boundary.ts) replays the boundary record above through the tool's handler with its statement fence removed, against the same three `ghcr.io/tursodatabase/libsql-server:v0.24.33` servers, and passed on 2026-11-01 (98 checks).
The read-only token read its table; the writable token, the read-only token whose permission claim grants writes, a user name and password on the Basic server, and the server that checks no credential, with no token and with the read-only token, were each refused at open through MCP.
The MCP fence refused every statement of the record before anything was acquired; with it removed, every write was refused by sqld with 403, `ATTACH`, `VACUUM`, `VACUUM INTO`, `ANALYZE`, `CREATE TEMP TABLE` and the pragmas sqld does not take with `unsupported statement`, `DETACH` with `no such database`, `load_extension` with `not authorized`, and a second statement with `more than one statement`.
The writable token ran each write on a scratch table, and a hash of the tables, rows, indexes, views, triggers and `user_version` read back the same before and after.
A read paged with `offset`; a read past 1000 rows, one past 1 MiB and one past a one-second `timeout_ms` were each refused, and the server answered the next call.
Turso Cloud was not re-run through MCP: its read-only refusal is the one the open already admits, measured on 2026-10-29.

```sh
LIBREDB_LIVE_LIBSQL_JWT_PORT=18181 LIBREDB_LIVE_LIBSQL_RO_TOKEN=<ro token> LIBREDB_LIVE_LIBSQL_RW_TOKEN=<rw token> \
  LIBREDB_LIVE_LIBSQL_WIDENED_TOKEN=<ro token with a p claim granting rw> \
  LIBREDB_LIVE_LIBSQL_BASIC_PORT=18182 LIBREDB_LIVE_LIBSQL_BASIC_USER=<user> LIBREDB_LIVE_LIBSQL_BASIC_PASSWORD=<password> \
  LIBREDB_LIVE_LIBSQL_OPEN_PORT=18183 bun tests/live/libsql-mcp-boundary.ts
```

#### Agent language pack

Statement-language family: `sql`.
Overlay: [`src/lib/agent/languages/sql/engines/libsql.ts`](../../src/lib/agent/languages/sql/engines/libsql.ts), with its client row in [`src/lib/agent/languages/sql/engines/client.ts`](../../src/lib/agent/languages/sql/engines/client.ts).
The agent reads it through `runServerPack` and `agentEnginePack`, and the dialect through `engineServerDialect`.

| Member | Kind | Value |
| --- | --- | --- |
| `catalogRead` | Dialect-bound | Supplied |
| `planEstimate` | Dialect-bound | Supplied |
| `profileComposition` | Dialect-bound | Supplied |
| `statistics` | Dialect-bound | Supplied |
| `catalogCapture` | Dialect-bound | `"unsupported"` |

This overlay overrides no Shared member, so every Shared member is the `sql` statement-language family's own.
Every statement it composes is SQLite's, and each kind was run with the read-only token: the catalog reads off `sqlite_master`, the `sqlite_stat1` probe, `EXPLAIN QUERY PLAN`, and the table profile's `LIKE` and `GLOB` counts.
The server refuses `ANALYZE` for every token, so `sqlite_stat1` exists only in a database that brought one with it, and the probe reads its absence as statistics absent.
The grounding capture is unsupported because it reads through the read-only path, which a token that writes cannot open, and plan mode grounds on such a connection; grounding asks the provider to describe its schema instead.
A plan run reads its statistics under the profile it grounds under, the operations profile here: the `sqlite_stat1` availability probe and the statistics read are composed by Studio and sent through the provider's own query path, so a plan run on a token that can write succeeds, grounded, and never asks for the read-only profile.
In agent mode these statements run only on a handle whose open admitted the token: a read-only token with none but the allowed claims, refused a write by sqld or Turso Cloud in that server's own words.
A pack does not open agent mode: execution is gated by `AGENT_EXECUTION_ENGINES` and the execution-profile check.
MCP's `run_read_query` runs a statement on libSQL (`MCP_STATEMENT_READ.libsql` is true) under the same boundary, described in "MCP read" above.

### 3.7 `notnull` must be quoted, and only a live server says so

```sql
SELECT cid, name, type, notnull, dflt_value, pk FROM pragma_table_info('probe_customers')
-- SQL string could not be parsed: near NOTNULL, "None": syntax error at (1, 32)
```

`notnull` is a SQLite keyword — the postfix `x NOTNULL` operator — so projecting it bare is a parse
error. The cost is narrow and quiet: it fails the COLUMN read of every table and leaves the rest of
the tree intact, so the object browser lists the tables and shows each as having no columns. No unit
test could catch it (a fake transport does not parse SQL), and the gate-4 live probe did.
`tests/unit/db/libsql/introspect.test.ts` now pins the statement text.

### 3.8 A batch is one round trip, and each statement keeps its own outcome

A libSQL server is normally across a network, and SQLite introspection is per-table: a row count, a
`pragma_table_info`, a `pragma_index_list` and a `pragma_foreign_key_list` for each. One request per
statement is four round trips per table. Hrana takes a LIST of requests, so `executeBatch` sends them
all at once — a whole schema read is three round trips regardless of table count, plus one for sizes.

Measured, and the reason the batch hands failures back individually rather than throwing:

```
requests: [SELECT 1 AS a] [SELECT * FROM nope] [SELECT 3 AS c]
results:  ok               error                ok
```

A failing statement does NOT abort the pipeline. Collapsing that onto one rejection is how a single
refused read costs a whole dashboard (#477, BACKLOG D22), so `LibSQLBatchOutcome` is a discriminated
per-statement result and the provider decides, per reading, what an absent one means.

### 3.9 `dbstat` answers here, so the sizes are real

`bun:sqlite` has no `dbstat` at all, which is why the SQLite provider's Storage tab is often empty.
Both libSQL deployments answer it, so table and index bytes here are MEASURED — 4096 bytes of table
and 4096 of index for a 3-row table, 53248 for a 2000-row one. When `dbstat` is absent the byte
fields are OMITTED rather than zeroed: 0 B reads as an empty table, which is a claim.

### 3.10 The version panel names what the deployment publishes

`GET /version` is a sqld route that Turso Cloud does not have (`{"error":"route not found:
[\"version\"]"}`). So `serverVersion()` answers `null` there rather than throwing, and the panel
reads:

- self-hosted: `sqld 0.24.33 (f8fb14f3 2026-08-11) (SQLite 3.47.0)`
- Turso Cloud: `SQLite 3.47.0`

Neither is "Unknown", because in both cases the engine answered something.

Both halves come from the deployment rather than from this product, which is why the pinned
`v0.24.33` image reads `sqld 0.24.33 (40a151bd 2025-12-19) (SQLite 3.45.1)` instead: same version
number, different build, different embedded engine.

### 3.11 No sessions, no uptime, no connection ceiling

Hrana is stateless: a statement is a request. There is no session object anywhere, so
`getActiveSessions()` answers `[]` and `HealthInfo.activeSessions` is empty — a row for the request in
flight would be the provider describing itself. `maxConnections` is `0`, this codebase's encoding for
"no limit published" (the same as Trino, Druid and MSSQL), and `uptime` is `"N/A"` because no route
or catalog publishes one.

`getSlowQueries()` answers `[]` for a reason of the engine's: libSQL keeps no statistics about
finished statements. The empty state says exactly that instead of naming a PostgreSQL extension.

### 3.12 The dialect facts were re-measured, not inherited

The grammar registry maps `libsql` to the SAME `SQLITE_GRAMMAR` object, and every one of its four
facts was re-measured over Hrana rather than assumed:

| Fact | Measured on sqld 0.24.33 |
|---|---|
| `#` starts a comment | **No** — `SELECT 1 # x` is "bad variable name" |
| `[…]` quotes an identifier | **Yes** — `SELECT [id] FROM probe_customers` parses |
| Block comments nest | **No** — `/* outer /* inner */ SELECT 1` runs |
| `q'…'` is a literal | **No** — syntax error |
| `''` escapes a quote | **Yes** — `SELECT 'it''s'` answers `it's` |
| `hex(X'0102deadbeef')` | `0102DEADBEEF`; `typeof(X'')` is `blob`, `length(X'')` is 0 |
| A `CREATE TRIGGER … BEGIN … END` body holds its `;` (#1312) | **Yes**: cut at its inner `;` it is "SQL string could not be parsed: unexpected end of input", sent whole it is created and fires |

### 3.13 `endOpenQueryTransaction()` is not implemented, because the engine has no transaction to leave open

The providers that implement `endOpenQueryTransaction()` ([`types.ts`](../../src/lib/db/types.ts)) let `POST /api/db/multi-query` end a transaction a failed script left open on the session the next request borrows; the set is read from the type rather than listed here, because a list repeated across provider docs goes stale the moment it grows.
`sqlite.ts` is the closest relative here and it does implement it, which is exactly why the difference is worth writing down: **the engine has no transaction to leave open** on anything this provider holds.

Hrana keeps a server-side stream alive between requests and hands back a `baton` to continue it.
This transport appends `{ "type": "close" }` to the statements of every pipeline and ignores both `baton` and `base_url` ([`hrana-transport.ts`](../../src/lib/db/providers/sql/libsql/hrana-transport.ts)), so the stream a statement ran on is gone before the response is read.
That is the same decision as `supportsTransactions: false` ([§3.5](#35-the-server-refuses-four-statements-so-four-controls-are-withheld) lists what else it costs) and as the interactive controls this provider withholds: the `baton` is the feature an interactive transaction would consume, and nothing here consumes it.
So a `BEGIN` has no stream to outlive, and the next request opens a new one.

This is a declared boundary, not a default: `endOpenQueryTransaction` is optional on `DatabaseProvider` with no default value, and the route shape-checks for it rather than assuming `"none"`.


---

## 4. Connection

### 4.1 Configuration fields

| Field | Required | Meaning |
|---|---|---|
| `host` | yes (or a URL) | `libredb-probe.turso.io`, or the host running `sqld` |
| `port` | no | Defaults to `8080` plaintext, `443` under TLS |
| `user` | no | Only for a self-hosted `sqld` started with `SQLD_HTTP_AUTH`. When it is non-empty the transport sends `Authorization: Basic base64(user:password)` instead of the bearer token ([§4.5](#45-http-basic-for-a-self-hosted-server)) |
| `password` | when the server requires one | The auth TOKEN, sent as `Authorization: Bearer`, or the password that goes with `user` |
| `ssl` | no | Any mode other than `disable` selects HTTPS |
| `connectionString` | no | A `libsql://` URL, resolved into the fields above |

There is no `database` (the database is the host).
The connection form gates its Username and Database boxes on this same list, so a box appears exactly where a value is written: it draws a Username box, whose hint says it is only for a server started with `SQLD_HTTP_AUTH`, and no Database box.
The list names `user` because the transport sends one: a provider that authenticates with a field the form does not write is the Redis ACL user of #502 again, and `tests/unit/lib/db-ui-config.test.ts` fails on it.

### 4.2 Connection strings

```
libsql://<database>-<org>.turso.io?authToken=<jwt>
```

That is the URL `turso db show --url` and the dashboard print. `libsql://` implies TLS and 443, and
there is no plaintext form of the scheme: a self-hosted server on plain HTTP is reached through the
host/port fields with TLS off, because `http://` already resolves to ClickHouse's connection string
row and two engines cannot own one scheme.

### 4.3 Getting a token

```bash
turso db tokens create <database>              # full access
turso db tokens create <database> --read-only  # read-only, the token agent mode takes (§3.6)
```

A self-hosted `sqld` started without authentication takes no token at all, and sending an empty one
is a 400 rather than an anonymous connection — so a connection with no token sends no header.


### 4.4 Endpoint validation and redirects

`host` and `port` are validated when the transport is constructed, which happens in `connect()`, so
a bad value fails Test Connection and never a capability read. A host must be a hostname, an IPv4
address or an IPv6 address (bracketed or not), and a port must be an integer from 1 to 65535.
Anything else is a `DatabaseConfigError` that names the field and does not repeat the value.
Every request URL is built by the shared [`endpoint.ts`](../../src/lib/db/http/endpoint.ts) with
`URL` and `URLSearchParams` and checked against the intended hostname, port and path before it is
sent, so no value can move a request to another path or another server. A scheme's default port
(80 for `http`, 443 for `https`) is left out of the URL the way `URL` serializes it.

Redirects are not followed. Every request sets `redirect: "manual"`, and a 3xx answer becomes a
`ConnectionError` naming the status and only the origin of its `Location`, since a followed
redirect would take the token and the statement to wherever the server pointed.

`serverVersion()` answers `null` for every failure by contract ([§3.10](#310-the-version-panel-names-what-the-deployment-publishes)),
so a redirect from `/version` is one more "no version to show". It is still not followed.

### 4.5 HTTP Basic for a self-hosted server

A self-hosted `sqld` started with `SQLD_HTTP_AUTH="basic:<base64(user:password)>"` checks a user name and a password rather than a token.
sqld calls this legacy HTTP basic authentication and chooses it ahead of any JWT key the server was also given (`make_user_auth_strategy` in `libsql-server/src/main.rs`).
A connection with a non-empty `user` therefore sends `Authorization: Basic base64(user:password)`, encoded as UTF-8, with an empty password when the connection has none.
A connection without one keeps sending the password as `Authorization: Bearer <password>`, which is what Turso Cloud and a JWT-checking server read, and a connection with neither sends no header.

A Basic-auth server would also accept a bearer token equal to `base64(user:password)`, but only through its own leniency.
Its `HttpBasic` strategy splits the header at the first space, discards the scheme and accepts any value that contains the configured credential.
Sending the scheme the server is configured for keeps that leniency out of the contract.
This is read from the sqld source (`libsql-server/src/auth/user_auth_strategies/http_basic.rs`, byte-identical at `libsql-server-v0.24.32`, `libsql-server-v0.24.33` and `main`), not measured against a live server by these tests, which pin the header the transport builds.

A rejected credential answers `401` with this body, read from the same source (`src/error.rs` and `src/auth/errors.rs` at `libsql-server-v0.24.32`), and the provider reports it as an `AuthenticationError` like every other credential failure ([§3.3](#33-an-auth-failure-uses-a-different-envelope-and-a-bad-token-is-a-400)):

```json
{"error":"Unauthorized: `The `Basic` HTTP authentication credentials were rejected`"}
```

A `libsql://` URL never sends Basic.
Its credential is the token in `?authToken=` or the password in its authority, so a `user` beside the URL is dropped when the URL is resolved, and the URL's own user name is not read.

### Connection string

The scheme shown for libSQL is `libsql://`.
Its row in `CONNECTION_STRING` is declared in [`connection-string.ts`](../../src/lib/db/providers/sql/libsql/connection-string.ts).
Its `paste` claims `libsql://`, with port 443 by default, and reads the token from `authToken`.
It has no `readTls`: a `libsql://` URL is TLS always and has no plaintext form, so a paste sets `require`.
It runs no seed load check.

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `libsql` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/sql/libsql/execution-ui.ts).

---

## 5. Query interface

`query(sql, params)` sends one statement and returns `{ rows, fields, rowCount, executionTime,
columnTypes? }`.

- **Parameters are positional** (`?`), encoded per type: an integer as a decimal string, a
  non-integral number as a float, a boolean as SQLite's own 1/0, `Uint8Array` as base64, a `Date` as
  an ISO string. Passing none sends no `args` member at all.
- **`fields`** are the declared column names, each non-empty and unique, and the rows are keyed by position under them in [`hrana-transport.ts`](../../src/lib/db/providers/sql/libsql/hrana-transport.ts).
  A repeated name comes back numbered: two columns declared `id` are `id` and `id (2)`, each with its own value and declared type.
  A column declared with no name, or with an empty one (`1 AS ""`), comes back as `(No column name)`.
  Before this, a repeated name kept only the last value while `fields` listed it twice, and an unnamed column was `column_N`, which a column the statement itself named `column_1` overwrote.
  Pinned against the Hrana answer shape in `tests/unit/db/libsql/hrana-transport.test.ts` and `tests/integration/db/libsql-provider.test.ts`; not re-measured against a live sqld in this change.
  A row whose value count is not the column count is refused with an error rather than padded.
- **`rowCount`** is the row count for a read and the engine's `affected_row_count` for a write.
- **`columnTypes`** carries SQLite's declared types verbatim (`INTEGER`, `TEXT`) and is OMITTED when
  the engine declared none — which it does for every computed column and every PRAGMA, so an absent
  map is the common case rather than a failure.
- **`executionTime`** is the engine's own measurement when it rounds to at least a millisecond, and
  the wall-clock one otherwise.
- **A `BLOB` arrives as a `Buffer`.** Hrana carries a blob as base64 (`x'DEADBEEF00FF'` answers
  `{"type":"blob","base64":"3q2+7wD/"}` on sqld 0.24.33, `x''` answers `"base64":""`), and
  [`hrana-transport.ts`](../../src/lib/db/providers/sql/libsql/hrana-transport.ts) decodes it to a
  `Buffer` rather than a plain `Uint8Array`. The rows reach the browser through `JSON.stringify`, which
  writes a plain `Uint8Array` as an object keyed by index (`{"0":222,"1":173,...}`): the grid showed
  that object and "Export as SQL INSERT" wrote it back as quoted text, so a replay stored a string
  where the bytes had been. A `Buffer` serializes to `{"type":"Buffer","data":[...]}`, which
  `asBytes` in [`binary.ts`](../../src/lib/export/binary.ts) reads, so the grid, the CSV and the JSON
  export (#1381) show `\xdeadbeef00ff` and the SQL export writes `X'deadbeef00ff'` (and `X''` for an empty blob), the
  same as the SQLite provider. Measured 2026-10-04 on sqld 0.24.33: the exported INSERTs, run into a
  fresh `BLOB` table, read back with identical `hex()` and `length()`, `0x00` and `0xFF` included.

### EXPLAIN

`EXPLAIN QUERY PLAN` answers the four-column `id/parent/notused/detail` shape, read by the shared
`sqlite-queryplan` strategy. Measured against the probe fixture:

```
SEARCH probe_customers USING INDEX idx_customers_country (country=?)
```

---

### SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/sql/libsql/sql-grammar.ts`](../../src/lib/db/providers/sql/libsql/sql-grammar.ts), the `libsql` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
Its grammar is `SQLITE_GRAMMAR`, the one reading the statement splitter, the row limiter, the confirmation gate and query-event redaction share, so they cannot disagree about where a literal or a comment ends.
It is the same grammar object as `sqlite`'s, and every one of its facts was re-measured over Hrana on sqld 0.24.33 rather than inherited: `SELECT 1 # x` is refused ("bad variable name"), `SELECT [id] FROM probe_customers` parses, `/* outer /* inner */ SELECT 1` runs, and `q'[x]'` is a syntax error.
The trigger-body fact was measured on the same sqld: a trigger cut at its inner `;` is "SQL string could not be parsed: unexpected end of input", and sent whole it is created.
Sharing the object is deliberate: a divergence would have to be written down as its own grammar, which is the change a reader should see.
`readsSqlText` is `true`: the editor text is SQL, and the provider extends `SQLBaseProvider`.
Redaction is `sql` with no name quote: a redacted statement keeps its words, and every literal and quoted run becomes `?`.

## 6. Schema introspection

| Surface | Statement |
|---|---|
| Tables | `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'` |
| Row count | `SELECT COUNT(*) AS row_count FROM "<table>"` |
| Columns | `SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info('<table>')` |
| Indexes | `SELECT seq, name, "unique", origin FROM pragma_index_list('<table>')` |
| Index columns | `SELECT seqno, cid, name FROM pragma_index_info('<index>')` |
| Foreign keys | `SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list('<table>')` |
| Bytes | `SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name` |

`sqlite_autoindex_*` entries are dropped: no user declared them and no user can drop them, so listing
them reports objects the schema does not contain.

Degradation is per reading, not per tree:

| What failed | What the user sees |
|---|---|
| The table list | The read fails — there is nothing to degrade to |
| One table's columns | That table listed with no columns; every other table intact |
| One table's row count | No count for it; the others keep theirs |
| `dbstat` | No sizes anywhere; every row count still real |

### 6.1 The object surface (#789)

The table above is the flat model: one list of tables, no views, no indexes as objects, no triggers at
all. The object surface replaces it with five container-aware methods (`listContainers`, `countObjects`,
`listObjects`, `describeObject`, `describeObjects`) declared in [`types.ts`](../../src/lib/db/types.ts) and implemented in
[`objects.ts`](../../src/lib/db/providers/sql/libsql/objects.ts). The flat reading it replaced is deleted.

Everything below was measured on 2026-09-11 against `ghcr.io/tursodatabase/libsql-server:v0.24.33`, the
image [`database-compose.yml`](../../database-compose.yml) pins, which embeds **SQLite 3.45.1** (§0's
**Reproducible with** row records why that differs from the 3.47.0 the `:latest` build and Turso Cloud
answer). The floor that matters here is 3.37, and both builds are above it.

#### libSQL is a ZERO-CONTAINER engine, and `[]` is an answer

`containerLevels` is `[]`, `containerDepth()` answers 0, and `listContainers()` answers `[]`. A connection
addresses one database and every object in it is addressed by a bare name, so `DatabaseObject.path` for a
table is `['orders']` and for a trigger `['orders', 'orders_stamp']`. No synthetic `main` container is invented to make the shape match the engines that do have a container level, such as PostgreSQL's schemas.

#### The four kinds, and the one that is NOT declared

| Kind | `role` | Catalog | Selector | Note |
|---|---|---|---|---|
| `table` | `relation` | `PRAGMA table_list` | `type IN ('table','virtual')` | `acceptsRowWrites: true` |
| `view` | `relation` | `PRAGMA table_list` | `type = 'view'` | not a row-write target |
| `index` | `config` | `sqlite_schema` | `type = 'index'` | first-class here, as on [sqlite](./sqlite.md) |
| `trigger` | `attached` | `sqlite_schema` | `type = 'trigger'` | `attachedTo: 'table'`, path `[parent, name]` |

**No `function` kind, and that is a measurement rather than an omission.** libSQL once advertised WASM
user-defined functions, which would be a stored routine this surface could list. On the build this repo
runs they do not exist:

| Probe | Answer |
|---|---|
| `CREATE FUNCTION fib LANGUAGE wasm AS X'0061736d'` | `SQL string could not be parsed: syntax error around L1:16: FUNCTION` |
| `SELECT * FROM libsql_wasm_func_table` | `SQLite error: no such table: libsql_wasm_func_table` |
| `sqld --help` | no wasm option of any spelling |

A kind an engine does not have is ABSENT from the declaration rather than declared and counted zero,
because a folder badged 0 is a claim that the database holds none of something it could hold.

A trigger's parent is not always a table: an `INSTEAD OF` trigger on a VIEW is accepted and
`sqlite_schema.tbl_name` then names the view. The count and the listing both carry it rather than one of
them dropping it.

#### `PRAGMA table_list` answers over Hrana, so the shadow tables are separated the same way

This was the open question for this provider and it is settled by measurement: `PRAGMA table_list` answers
over the Hrana transport in both the statement and the table-valued form. It needs SQLite 3.37 and this
build is 3.45.1.

That matters because `sqlite_schema.type` is too coarse to count tables with. An FTS5 table is ONE object a
user selects from plus five SHADOW tables the module owns; `sqlite_schema` types every one of them `table`.
Measured on the fixture below, which holds nine ordinary tables and one FTS5 table, a naive `sqlite_schema`
scan answers **16**.

| `table_list.type` | Kind | Why |
| --- | --- | --- |
| `table` | `table` | an ordinary table, `WITHOUT ROWID` and `STRICT` included |
| `virtual` | `table` | the FTS5 table itself: a user selects from it and writes rows to it |
| `view` | `view` | |
| `shadow` | none | storage a virtual-table module owns; nothing selects from it directly |

That vocabulary is SQLite's own documented four values and NOT a `SELECT DISTINCT type` over a fixture,
which would only ever enumerate the fixture. The fixture is built to contain all four.

Bound parameters reach the `pragma_*` table-valued functions over Hrana (`pragma_table_xinfo(?, ?)`
answers), so these statements bind where [`introspect.ts`](../../src/lib/db/providers/sql/libsql/introspect.ts)
embeds object names as SQL literals.

#### Only `main`, and here the engine enforces most of it

Every count and every listing is restricted to `main`. On a file that restriction is a decision; here the
server refuses most of what could produce a second schema:

| Statement | sqld 0.24.33 |
|---|---|
| `ATTACH DATABASE ':memory:' AS side` | `unsupported statement` |
| `CREATE TEMP TABLE t(x)` / `CREATE TEMPORARY TABLE` / `CREATE TABLE temp.t(x)` | `unsupported statement` |
| `CREATE TEMP VIEW v AS SELECT 1` | `unsupported statement` |
| **`CREATE VIEW temp.v AS SELECT 1`** | **accepted** |

So one temp object IS reachable, and it is enough to make the restriction load-bearing rather than
defensive: with `temp.orders` live, `PRAGMA table_list` publishes `orders` under both schemas and an
unrestricted listing answers two objects with ONE path, which is the uniqueness the tree addresses rows by.
The count and the listing apply the same predicate, so a badge can never disagree with its folder.

`sqlite_schema` needs no schema bind: unqualified it always resolves to `main.sqlite_schema`, and a temp
object would live in the separate `sqlite_temp_schema`.

#### Names libSQL reserves for itself

Every population excludes `name NOT LIKE 'sqlite\_%' ESCAPE '\'`. It can never hide a user's object: the
engine refuses the name outright over Hrana too, `CREATE TABLE sqlite_foo` answering *"object name reserved
for internal use: sqlite_foo"*. `ESCAPE` is load-bearing rather than decoration, because `_` is LIKE's
single-character wildcard: measured on the fixture, the unescaped pattern answers nine tables where the
engine holds ten, having swallowed `sqliteXledger`.

What it removes, per population, because that decides where the rule can be tested:

| Population | Rows the predicate removes |
|---|---|
| `PRAGMA table_list` (tables, views) | `sqlite_schema` on every database, `sqlite_sequence` once a table declares `AUTOINCREMENT` |
| `sqlite_schema` (indexes) | `sqlite_autoindex_<table>_<n>`, the index behind a `UNIQUE` constraint |
| `sqlite_schema` (triggers) | nothing that can exist. Measured, `CREATE TRIGGER sqlite_guard ...` is refused *"object name reserved for internal use"* and the engine creates no trigger of its own |
| `pragma_index_list` (an object's detail) | the same `sqlite_autoindex_*` rows, so the folder and the detail agree |

The index row is the one worth spelling out, because one table shape hides it. An implicit
`sqlite_autoindex_*` on an ordinary ROWID table IS a row of `sqlite_schema` typed `index`, so it reaches
the Indexes FOLDER and not only an object's detail: measured, `CREATE TABLE badges(id INTEGER PRIMARY KEY,
code TEXT UNIQUE, label TEXT)` puts `sqlite_autoindex_badges_1` there. A `WITHOUT ROWID` table is the
exception, and its autoindex appears in `pragma_index_list` while `sqlite_schema` omits it. A fixture
holding only the second shape makes this predicate look untestable when it is not.

#### `describeObject()` reads for the two relation kinds only, in TWO round trips

An `index` and a `trigger` answer three empty arrays without touching the network, which is a true fact
about those kinds rather than a failed read.

`table` and `view` are therefore the only kinds here that declare `hasColumns`, so they are the only rows
the object tree gives a twisty and expands into column rows; `index` and `trigger` declare nothing and stay
leaves, which is what `describeObject()` answering no column for them means (#789).
Both deployments this one type-id serves, self-hosted sqld and Turso Cloud, read the same pragmas through
the same transport, so the declaration is one fact about the engine and not per deployment.

For a `table` and a `view` the reads are batched, and that is where this provider stops being
[sqlite.ts](../../src/lib/db/providers/sql/sqlite.ts): there every read is a call into a file handle, and
here every read is an HTTP request.

| Round trip | Statements |
|---|---|
| 1 | `pragma_table_xinfo(?, ?)` where `hidden <> 1`, `pragma_index_list(?, ?)`, `pragma_foreign_key_list(?, ?)` |
| 2 | one `pragma_index_info(?, ?)` per index, plus one `pragma_table_info(?, ?)` per foreign-key parent that needs resolving |

A table with four indexes costs two requests rather than seven. The second batch is empty when there is
nothing to ask, and an empty batch touches no network at all.

| Data | Note |
|---|---|
| Columns | `table_xinfo` and NOT `table_info`, which DROPS a generated column: measured, `table_info('orders')` answers four columns where `table_xinfo` answers five. `hidden = 1` is the other direction, a virtual table module's own interface columns (`notes` and `rank` on an FTS5 table), which the table does not declare |
| `isPrimary` | `pk > 0`. `pk` is a 1-BASED RANK and not a flag, so `= 1` reports the second column of a composite primary key as ordinary |
| `type` | as answered, which is the EMPTY STRING on a virtual table's columns. The deleted flat reading wrote `"TEXT"` there, which is a guess about affinity |
| Indexes | same `sqlite_` exclusion as the Indexes folder, so the two surfaces agree about what an index is. An index on an EXPRESSION publishes a null column name (`cid = -2`) and is left out rather than labelled |
| Foreign keys | `referencedTable` is a bare name: a foreign key's parent is resolved inside the same database |

`REFERENCES customers` with no column list answers `to = NULL`, which SQLite reads as the parent's PRIMARY
KEY, so the parent's key columns are read rather than a null being put in a typed string field. A parent
with no primary key at all is a schema the engine accepts and rejects only on INSERT; there is nothing to
name, and the field is empty.

Zero columns IS a failed read and raises: the engine refuses `CREATE TABLE t()`, so every table and every
view has at least one column.

#### `describeObjects()` describes a whole folder in ONE round trip (#789)

`describeObjects(container, kind, limit?)` answers columns, indexes and foreign keys for EVERY object
of one kind in `main`, in ONE request whatever the folder holds. The five statements - the target read
plus four detail reads - are independent of each other, each carrying its own copy of the target CTE,
so they go in a single Hrana batch. Measured against
`ghcr.io/tursodatabase/libsql-server:v0.24.33` holding the fixture below: **1 request for the ten-table
folder against 12 for ten `describeObject()` calls**, and 1 ms against 8 ms over the loopback, where a
round trip costs almost nothing. On a Turso Cloud database that ratio is the whole story.

That is the engine-specific half of the decision. The SQLite provider issues the same five statements
as five separate calls into a file handle, because there a round trip is a function call.

Each detail statement joins a pragma table-valued function against the target set, which sqld accepts:
measured, a TVF argument that references a column of the row being joined runs the pragma once per
target object inside one statement.

The five decisions this engine had to make for itself, each measured rather than reasoned:

**Which catalog.** The same pragmas `describeObject()` reads and the same `PRAGMA table_list` target
`listObjects()` reads. It is not `readSchema()`'s: the flat surface reads `sqlite_master` and
`PRAGMA table_info`, so it sees the FTS5 shadow tables as ordinary tables and DROPS a generated column,
and its `NOT LIKE 'sqlite_%'` carries no `ESCAPE`, so it also drops `sqliteXledger`. MEMBERSHIP comes
from the target read and never from the column read: deriving it from the columns would drop an object
whose every column is hidden, and the folder's listing would then name an object the batch does not
carry. It is also why this read does not repeat the single read's zero-column throw - there an empty
answer means the object is not there under that name, here the catalog has just said it is.

**Which kinds have no columns.** `index` and `trigger`, which answer `{ details: [] }` without touching
the network: `pragma_table_xinfo` answers zero rows for an index name and for a trigger name. That is
the same fact `describeObject()` answers as three empty arrays, and on this engine it coincides exactly
with `role === "relation"` - which is not the general rule, since a MariaDB sequence is declared
`config` and has eight real columns.

**What bounds the read on the wire.** `LIMIT ?` inside the target CTE, the placeholder BOUND rather than
interpolated and carrying `limit + 1`, so a saturated read is told from an exact one with no second
count. Measured accepted on 0.24.33, which the flat surface does not rely on: `introspect.ts` embeds
object names as SQL literals. The extra object is dropped in code and `truncated` carries the CALLER's
limit. Nothing here caps the columns of an object.

**What orders the cut, and under whose collation.** `ORDER BY t.name` in the target CTE, and it is
load-bearing twice. Measured: `pragma_table_list` answers in no useful order without it, so a bounded
read would keep an arbitrary subset. And that sort runs under BINARY, the UTF-8 BYTE order, which is not
the order `comparePaths` produces: measured on the live server, a database holding the two names
`U+E000` and `U+1F600` answers `ORDER BY t.name` as `U+E000, U+1F600` (bytes `EE 80 80` below
`F0 9F 98 80`) where a JavaScript sort answers the reverse, because JavaScript compares UTF-16 code
units and the surrogate `0xD83D` sorts below `0xE000`. So the MEMBERSHIP of a bounded cut is the
server's and the ORDER of the answer is ours. The four detail statements repeat the same target CTE
rather than joining a temporary of it, which is safe because a name is unique within a schema, so
`ORDER BY t.name` is a TOTAL order and all five statements cut the same set.

**Mixed path depth (ruling 5f).** Not in this engine's relation set. `table` and `view` are the kinds
with columns and both are addressed `[name]` under a zero-level container; `trigger` is the one kind
that nests, and it has no columns.

**Two repairs the single read needed to make one mapper possible**, and both are improvements rather
than accommodations. The foreign key statement now resolves an unnamed parent key in a correlated
`(SELECT p.name FROM pragma_table_info(f."table", ?) AS p WHERE p.pk = f.seq + 1)`, so no foreign key
costs a request of its own any more and the bulk read needs no statement per distinct parent; and
`pragma_index_list` is ordered by name, because measured it answers in reverse creation order and the
bulk read has to order by the object to group its rows.

**One defect only the live run caught**, which is standing ruling 5b's trap exactly. The new foreign
key statement carries THREE placeholders - the subquery's schema is first, because SQLite numbers
placeholders by where they appear in the statement text and the select list is written before the FROM
- and the single read was still passing the old two-value array. sqld answers
`Arguments do not match SQL parameters: value for parameter 3 not found`. The fake server in the test
file dispatches on statement text and never counted binds, so the suite was green while every
`describeObject()` foreign key read would have failed against a real server. The bind arity is now
pinned by an assertion in that suite.

#### Column defaults: the value, with the catalog text kept alongside (#1029)

libSQL reports a column default as the expression AS WRITTEN, through `pragma_table_xinfo`'s `dflt_value`, identical to SQLite's on every row below. A string
default therefore arrives quoted, with SQL standard quote doubling, while a number and an
expression arrive bare. Measured 2026-09-21 on SQLite 3.53.2 through `bun:sqlite`, the engine libSQL forks. The payloads this suite
replays, captured from sqld 0.24.33 (SQLite 3.47.0), carry `customers.country` as `'TR'`,
quoted the same way, and #1029 measured `@libsql/client` identical on every row:

| DDL | the value the column defaults to | catalog text |
| --- | --- | --- |
| `DEFAULT 'NULL'` | `NULL` | `'NULL'` |
| `DEFAULT 'abc'` | `abc` | `'abc'` |
| `DEFAULT ''` | the empty string | `''` |
| `DEFAULT 'it''s'` | `it's` | `'it''s'` |
| `DEFAULT 'a\b'` | `a\b` | `'a\b'` |
| `DEFAULT 42` | `42` | `42` |
| `DEFAULT CURRENT_TIMESTAMP` | the expression | `CURRENT_TIMESTAMP` |
| no default | none | SQL NULL |

Each column carries both readings. `defaultValue` is the value, decoded by `unquoteLiteral()`
(`src/lib/sql/values.ts`) with the `unquoteStandard` reader this engine's SQL writing module names, so `'it''s'` reads as
`it's` and a backslash stays ordinary data. Text that is not exactly one complete literal,
a number or an expression, passes through unchanged. `defaultExpression` is the
catalog text itself, which is always valid SQL here and is what the schema-diff migration
generator writes after the word `DEFAULT`; without it, a decoded `abc` would be emitted as
`DEFAULT abc`. The empty string default stays the empty string, never `undefined`, and a
column with no default carries neither field. `readCatalogDefault()` is local to this
provider, the way per-provider normalization is everywhere else in this tree; the escape
knowledge it relies on is the shared part.

#### No `rowCount` and no `sizeBytes` on a listed object

There is no catalog row estimate: `sqlite_stat1` exists only after an `ANALYZE` this server refuses
outright, so a count per object would be a full scan per row of a listing and a round trip per row on top.
`dbstat` does answer here (§3.9), but it scans the whole database to do it. A fabricated 0 in either field
reads as an empty object.

#### A refused read is not zero

`countObjects()` answers `{ unavailable: "<the server's own sentence>" }` for every kind at once, with no
product prefix in front of the server's words, and `listObjects()` raises. A failed statement is an HTTP
200 carrying the engine's message (§3.2), so `response.ok` is never the verdict.

#### The fixture, and running it

The DDL is [`docker/sqlite-init/02-libsql-object-fixture.sql`](../../docker/sqlite-init/02-libsql-object-fixture.sql).
It used to live here as a fenced block and nowhere else, which meant a reader could see the
measurement and could not re-run it; the file is what replaced that. The object-surface tests answer
from a catalog captured off a live server started from that file, and the fake applies only the
predicates each statement actually spells, so dropping a predicate from the provider widens the
population here the way it would against the real server.

Apply it, and print the catalog it built:

```bash
docker compose -f database-compose.yml up -d libsql          # sqld on localhost:18080
bun docker/sqlite-init/apply-to-libsql.ts http://127.0.0.1:18080
bun docker/sqlite-init/apply-to-libsql.ts http://127.0.0.1:18080 <token>   # Turso Cloud
```

sqld ships no client: the image carries neither `sqlite3` nor `curl`, so the fixture needs an applier
of its own and that script is it. It sends one statement per request rather than one batch, because a
batch stops at the first failure and a half-applied fixture is worse than one that did not apply, and
it prints each statement's own outcome. The same file also builds a local database FILE:

```bash
bun docker/sqlite-init/build-fixture.ts /tmp/demo.sqlite 02-libsql-object-fixture.sql
```

It holds one of every declared kind, all four `table_list.type` values, a generated column, a composite
primary key on a `WITHOUT ROWID` table, an `AUTOINCREMENT` table, an expression index, BOTH
implicit-index shapes (the `WITHOUT ROWID` one that only `pragma_index_list` publishes and the
`UNIQUE`-on-a-ROWID-table one that is also a `sqlite_schema` row), an `INSTEAD OF` trigger on a view,
a trigger whose name is also a table's, a `sqliteXledger` table, a foreign key that names its column
and two that do not, and a foreign-key parent with no primary key.
Counts: `table 10, view 1, index 3, trigger 3`.

It is NOT the same DDL as [`01-object-fixture.sql`](../../docker/sqlite-init/01-object-fixture.sql),
which the SQLite provider's suite replays: that one holds `TEMP` and `ATTACH`ed objects sqld refuses
outright, and this one holds a `STRICT` table and the second implicit-index shape. One directory, one
splitter, one build script, one file per engine's own captured catalog.

`ANALYZE` is absent from the file and must stay absent: measured on sqld 0.24.33, it answers
`SQL string could not be parsed: unsupported statement: ANALYZE`.

### 6.2 Object source (#789)

One statement answers every kind, because libSQL IS SQLite and `sqlite_schema` keeps the text the author submitted.

```sql
SELECT s.sql AS sql
  FROM sqlite_schema AS s
 WHERE s.type = ?
   AND s.name = ?
```

| Kind | `sqlite_schema.type` | `form` | `origin` | Monaco language |
| --- | --- | --- | --- | --- |
| `table` | `table` | `complete` | `stored` | `sql` |
| `view` | `view` | `complete` | `stored` | `sql` |
| `index` | `index` | `complete` | `stored` | `sql` |
| `trigger` | `trigger` | `complete` | `stored` | `sql` |

No kind declares nothing: all four have a definition text and all four publish it.
A `VIRTUAL` table is typed `table` in `sqlite_schema`, so the `table` kind covers the FTS5 object the listing takes from `PRAGMA table_list`.

#### What the text IS

`form` is `complete` on every kind: each is a statement that runs as given, never a body or a bare `SELECT`.

`origin` is `stored`, and on this engine family that is a real distinction rather than a formality.
Measured live against sqld 0.24.33: `orders` comes back carrying the twenty-one-space continuation indent of the fixture statement, exactly as it was sent, where PostgreSQL and MySQL hand back a statement rebuilt out of a catalog.
The Source tab's caption exists to keep those two apart, and if every engine reported `regenerated` the distinction would be decoration.

The same `ALTER TABLE` caveat SQLite has applies here, and it is recorded in [`sqlite.md`](sqlite.md#what-the-text-is-and-the-one-caveat-on-stored): the engine REWRITES the stored text on a rename or an added column, so the bytes are the author's own up to the last schema change.
That is still a different fact from a regeneration.

#### There is no refusal, and that is a CANNOT rather than an omission

Three things could have produced one here and none of them does:

| Candidate | Measured |
| --- | --- |
| A privilege refusal | There is no privilege system to refuse a read. A token that can query at all can read `sqlite_schema` whole |
| sqld's statement allowlist | It refuses `VACUUM`, `ANALYZE`, `ATTACH` and `PRAGMA query_only` ([§3.5](#35-the-server-refuses-four-statements-so-four-controls-are-withheld)). A plain `SELECT` from `sqlite_schema` is not in that set: this exact statement answered on sqld 0.24.33 |
| A NULL definition | `sqlite_schema.sql` is NULL for exactly one shape, an index the engine created for itself. Every listing here carries `name NOT LIKE 'sqlite\_%' ESCAPE '\'`, so no path the object tree produces addresses such a row |

The provider still turns a NULL, an absent column or a whitespace-only text into a REFUSAL part rather than an empty definition, because an empty editor over a definition is the one failure this surface exists to prevent.
THOSE ARE THREE DIFFERENT FACTS AND THEY GET THREE DIFFERENT SENTENCES, because a refusal stating a cause that is false for the shape in front of it sends its reader somewhere there is nothing to find.
A stored NULL says the engine keeps NULL there only for an index it created for itself.
A whitespace-only text says the column holds no non-whitespace character, and claims no cause at all.
A reply carrying no `sqlite_schema.sql` column says exactly that, and says it is a fact about the read and not about the object: on this transport a wrong alias answers a row built from the column names the reply really carried, so the key is simply absent.
The sentences for those cases are OURS and not the server's, which is the exception to the rule that a refusal carries the engine's own words: the server supplies none, it simply stores NULL.

NOTHING IN THIS PROVIDER OR ITS SUITE KEYS ON REFUSAL WORDING, and that is deliberate.
The two deployments word the identical refusal differently ([§3.2](#32-a-failed-statement-answers-http-200)), so a test that pinned either sentence would pass on one and fail on the other.

A statement the server rejected and a credential that expired mid-session both RAISE through the provider's own mapping.
Neither becomes a refusal part: nobody answered about the object, and rendering a transport symptom as the object's own refusal would state it as a fact about the object.

An object that is not there RAISES too, naming the last path segment.
Absence and unreadability are different facts.

#### No escaper, no schema bind, one round trip

Both binds are PARAMETERS, so no identifier is interpolated and this read needs no identifier escaper.

The `type` value comes from the KIND and never from what the name happens to match, and that is behavioural rather than stylistic.
Measured live: a TRIGGER may share a name with a TABLE, so `SELECT sql FROM sqlite_schema WHERE name = 'badges'` answers TWO rows with the table's first, and a read that resolved the type from the name would hand a reader the table's DDL under the trigger's address.
[`02-libsql-object-fixture.sql`](../../docker/sqlite-init/02-libsql-object-fixture.sql) holds that object so the rule is exercised rather than asserted by statement shape.

Unqualified `sqlite_schema` resolves to `main.sqlite_schema` and this provider declares no container level, so there is no schema bind, exactly as the index and trigger listings have none.

ONE ROUND TRIP and ONE PART.
A libSQL object has exactly one text, so there is no batch to assemble and no second request to pay for, and nothing here splits into a specification and a body the way an Oracle or a MariaDB package does.

---

### 6.3 Object edit (#789)

This engine is a REFUSAL, and the reason is that there is no replace grammar to build a strategy on.
There is no `OR REPLACE` for any kind and no `ALTER VIEW`, each measured against a kind-naming plain-`CREATE` control, and `IF NOT EXISTS` parses as a SILENT NO-OP rather than as an error.
The only strategy left is a transaction, and a successful apply would still not be evidence the object works, because the SQLite dialect this engine speaks never validates a view or a trigger BODY at CREATE time.
A row can also carry `sql IS NULL`, as `sqlite_autoindex_uq_1` does, so non-editability is a PER-ROW fact here and not only a per-kind one.
No kind here declares `acceptsSourceEdits`, and `tests/isolated/object-edit-declarations.test.ts` is what holds that absence and this section together.

## 7. Monitoring & health

Measured through the provider against both deployments (fixture: 2 tables, 3 and 2000 rows, 1 index):

| Panel | Reading |
|---|---|
| Version | `sqld 0.24.33 (f8fb14f3 2026-08-11) (SQLite 3.47.0)` / `SQLite 3.47.0` on Turso Cloud. The pinned `v0.24.33` image reads `(40a151bd 2025-12-19) (SQLite 3.45.1)`: the panel names the build it is talking to |
| Database size | `64 KB` (65536 bytes), from `page_count × page_size` |
| Database size unavailable | `databaseSize` is `"N/A"`; `databaseSizeBytes` is omitted, not zeroed |
| Tables / indexes | 2 / 1 |
| Uptime | `N/A` — libSQL publishes none |
| Max connections | `0` — no limit published |
| Active connections | absent — Hrana is stateless |
| Cache hit ratio | `N/A` — SQLite's counters are behind the C API, and no statement reaches them |
| Health rows | `Integrity: OK`, `Journal Mode: wal` |
| Slow queries | Empty, permanently: libSQL keeps no statement statistics |
| Active sessions | Empty: no session exists to report |
| Deadlocks | `0`, and it is a fact rather than a gap — SQLite serializes writers behind one write lock and refuses a second with `SQLITE_BUSY` |
| Table stats | `probe_customers` 3 rows, 4096 B table + 4096 B index; `probe_orders` 2000 rows, 53248 B |
| Index stats | `idx_customers_country`, columns `[country]`, 4096 B, `scans: 0` (no per-index counter exists) |
| Storage | One entry, `main`, 65536 B. No WAL size: no statement reports it |

---

## 8. Maintenance

| Operation | Offered | Statement |
|---|---|---|
| `reindex` | per table and globally | `REINDEX` / `REINDEX "<table>"` |
| `check` | globally | `PRAGMA integrity_check`, and the ANSWER is read — a corrupt database reports damage in its row while the statement itself succeeds |
| `vacuum`, `analyze`, `optimize`, `kill` | withheld | Refused by the server (§3.5); a direct API call is refused by the provider with the reason |

A `container` is deliberately ignored (#772): a libSQL connection resolves names against its one
attached database, exactly as `sqlite.ts` does.

---

## 9. Capabilities & labels

### `getCapabilities()` ([`src/lib/db/providers/sql/libsql/index.ts`](../../src/lib/db/providers/sql/libsql/index.ts))

| Capability | Value | Description / Note |
|---|---|---|
| `queryLanguage` | `sql` | SQLite dialect over Hrana JSON pipeline |
| `defaultPort` | `8080` | `sqld`'s own default; `443` under TLS (Turso Cloud) |
| `supportsExplain` | `true` | `EXPLAIN QUERY PLAN` supported |
| `explainFormat` | `"sqlite-queryplan"` | SQLite's 4-column `id/parent/notused/detail` query plan strategy |
| `supportsConnectionString` | `true` | `libsql://<database>-<org>.turso.io?authToken=<jwt>` |
| `supportsInlineRowEdit` | `true` | Results grid inline edits supported |
| `supportsTestDataGeneration` | `true` | Generate Test Data offered on tables (one multi-row `INSERT INTO ... VALUES`) |
| `supportsResultPagination` | `true` | `LIMIT n OFFSET m`, the grammar it shares with SQLite (#816) |
| `supportsTransactions` | `false` | Stateless request stream closed with each statement; no interactive session held |
| `agentCredential` | `"token"` | The agent's own token alone, sent as the bearer credential ([§3.6](#36-the-agent-read-only-profile-rests-on-a-read-only-token)) |
| `maintenanceOperations` | `["reindex", "check"]` | Only `REINDEX` and `PRAGMA integrity_check` are permitted by server allowlist |
| `maintenanceOperationSpecs` | `reindex` (`perEntity: true`, `global: true`), `check` (`perEntity: false`, `global: true`) | Placement rules for per-table and global maintenance actions |
| `createTable` | declared, see [Create Table form](#create-table-form) | `CREATE TABLE` works as an ordinary SQL statement |
| `schemaRefreshPattern` | `"(CREATE\|DROP\|ALTER\|TRUNCATE\|REINDEX)\\b"` | Matches statements that modify schema or index metadata |
| `containerLevels` | `[]` | Zero-container engine; bare object names throughout ([§6.1](#61-the-object-surface-789)) |
| `containerPathShapes` | `exact` | Only the empty path `[]` addresses a container, so any segment is refused, by the object routes over HTTP and by this provider directly (#1147) |
| `objectKinds` | `LIBSQL_OBJECT_KINDS` | `table` (relation, `acceptsRowWrites`), `view` (relation), `index` (config), `trigger` (attached) |

### Create Table form

libSQL answers as SQLite because it embeds it: the same engine over a network.
`createTable` is `SQLITE_CREATE_TABLE` from [`sqlite-create-table.ts`](../../src/lib/db/providers/sql/sqlite-create-table.ts), the same object the SQLite provider returns, shared by import and never by a type-id branch (#1822).

| Field | Value |
| --- | --- |
| Auto-increment clause | `INTEGER PRIMARY KEY AUTOINCREMENT`, not sequence-backed |
| Column constraints | Yes: `PRIMARY KEY` and `UNIQUE` |
| Key type | `INTEGER` |
| Types | `TEXT`, `INTEGER`, `REAL`, `BLOB`, `NUMERIC` |

The measured reasons for each value are in [sqlite.md, "Create Table form"](./sqlite.md#create-table-form).
A row that reads like the old shared list is the engine agreeing with it.

### Labels — overridden (`getLabels()`, [`src/lib/db/providers/sql/libsql/index.ts`](../../src/lib/db/providers/sql/libsql/index.ts))

| Label Key | Value | Purpose |
|---|---|---|
| `slowQueriesEmptyState` | *"libSQL keeps no statistics about finished statements, so there is nothing to enable."* | Queries panel empty state; libSQL tracks no slow query statistics |
| `reindexGlobalLabel` | *"Run Reindex"* | Global maintenance action button |
| `reindexGlobalTitle` | *"Rebuild Indexes"* | Operations tab card heading |
| `reindexGlobalDesc` | *"Runs bare REINDEX, rebuilding every index in the database."* | Operations tab card description |

### SQL writing

[`libsql/sql-writing.ts`](../../src/lib/db/providers/sql/libsql/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalStandard` and read back by `unquoteStandard`: the quote is doubled and a backslash is data.
A name is quoted by `identifierDoubleQuoted`, the SQL standard form: a double-quoted name with an inner double quote doubled.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
Measured on sqld 0.24.33: `SELECT 'it''s'` answers `it's`, and a backslash has no special meaning, the same standard doubling SQLite defines.
libSQL shares only this grammar with SQLite, through the shared building blocks, and not SQLite's row: SQLite binds `?`, and libSQL's row has no placeholder.
Inline row editing reads a key column's kind through the module's own `inlineEdit`, because libSQL embeds SQLite and SQLite's type words name an affinity and not a storage width.
`instantTypeNames` is the empty `NO_INSTANT_TYPE_NAMES`: a `DATE`, `DATETIME` or `TIMESTAMP` column holds the text or integer somebody put in it, and that value is its own identity.
Measured 2026-09-19 on libSQL server v0.24.33 over its HTTP pipeline and on bun:sqlite (Bun 1.4.0), `zz_<decl>(k <decl> PRIMARY KEY, note TEXT)` for each of the three declarations against `'2024-01-15'`, `'2026-01-01 10:00:00.123'`, `'2026-01-01T07:00:00.123Z'` and the epoch 1705276800, 24 combinations: every value came back unchanged, `WHERE k IN (?)` matched one group holding one row, and the `UPDATE` changed exactly one row, libSQL identical to bun:sqlite on all twelve of its own.
`float64TypeNames` is `EVERY_TYPE_IS_FLOAT64`, `"all"`: SQLite has one float width, so `REAL`, `FLOAT`, `DOUBLE` and `DOUBLE PRECISION` are four spellings of one 8-byte double.
Measured 2026-09-18 on libSQL server v0.24.33 and bun:sqlite, `zz_real(r REAL, f FLOAT, d DOUBLE, dp DOUBLE PRECISION)` answered `real` to `typeof()` for all four, read 0.30000000000000004 back identical, and `WHERE r = 1.5`, `WHERE f = 0.1`, `WHERE d = 0.30000000000000004` and `WHERE dp = 0.1` each matched exactly one row on both.
`exactDecimalTypeNames` is the empty `NO_EXACT_DECIMAL_TYPE_NAMES`: SQLite has no decimal type, so `DECIMAL(20,4)` takes NUMERIC affinity and stores an integer or an 8-byte double.
That was measured 2026-09-19 on bun:sqlite only ([SQLite](sqlite.md)): `WHERE k = 1234567890123456.8` matched one row, its own; libSQL states it because it embeds the same engine and reports the same `sqlite3_column_decltype` declarations.
Every edit is bound as typed.

The module's `export` field writes a result export's column types from `STANDARD_DDL_TYPES`, NaN and the infinities as NULL through `NULL_NON_FINITE`, no re-spelling through `NO_BARE_SPELLING`, and a binary cell through `binaryStandardHex` (`X'0102'`).
`standsAlone` is the SQLite list, `VERBATIM_DECLARED_TYPES_STAND_ALONE`, held by name for the same measured reason: libSQL is SQLite 3.47.0, and `pragma_table_info` there answers the declared spelling verbatim too (measured on sqld 0.24.33).

---

## 10. Error handling

libSQL maps HTTP transport errors and Hrana execution errors to typed application exceptions via `mapLibSQLError()` ([`src/lib/db/providers/sql/libsql/index.ts`](../../src/lib/db/providers/sql/libsql/index.ts)):

| Situation | Error Class | Details |
|---|---|---|
| Missing `host` and no `connectionString` | `DatabaseConfigError` | Thrown during `validate()` |
| HTTP `400`, `401`, or `403` status | `AuthenticationError` | Indicates an invalid, missing or unauthorized auth token, or a Basic credential the server rejected |
| HTTP Status `0` / Network unreachable / Connect timeout | `ConnectionError` | Carries `host` and `port` |
| Statement execution error in Hrana pipeline (`results[].error`) | `QueryError` | Extracts message from error payload and associates original SQL |
| Non-transport error | `QueryError` / `DatabaseError` | Passed through or wrapped |

---

## 11. Testing

```bash
# Just this provider
bun test tests/unit/db/libsql tests/integration/db/libsql-provider.test.ts

# The live server the tests were written against
docker compose -f database-compose.yml up -d libsql   # sqld on localhost:18080
```

The object-surface block (§6.1) is answered by a CATALOG rather than by canned per-statement replies: the
raw `PRAGMA table_list` and `sqlite_schema` contents as the live server returned them, with the fake
applying only the predicates each statement spells. Dropping a predicate from the provider therefore
widens the population the way it would against the real server.

`globalThis.fetch` is replaced per test and restored afterwards; `mock.module()` is refused, being
process-wide in bun. Every payload in the tests was captured from the two live deployments.

### Verifying against a live server

```bash
docker compose -f database-compose.yml up -d libsql
# then point a Studio connection at 127.0.0.1:18080 with TLS off and no token
```

For Turso Cloud, create a database and a token with the `turso` CLI and paste the
`libsql://…?authToken=…` URL into the connection dialog.

---

## 12. Usage examples

```ts
import { createDatabaseProvider } from "@/lib/db/factory";

// 1. Connect using a Turso Cloud connection string (includes auth token)
const provider = await createDatabaseProvider({
  id: "libsql-turso",
  name: "Turso Cloud DB",
  type: "libsql",
  connectionString: "libsql://my-database-my-org.turso.io?authToken=eyJhbGciOi...",
  createdAt: new Date(),
});

// Or connect using discrete parameters for a self-hosted sqld instance
const localProvider = await createDatabaseProvider({
  id: "libsql-local",
  name: "Local sqld",
  type: "libsql",
  host: "127.0.0.1",
  port: 8080,
  createdAt: new Date(),
});

// Or a self-hosted sqld started with SQLD_HTTP_AUTH="basic:<base64(user:password)>":
// naming a user sends the pair as HTTP Basic
const basicProvider = await createDatabaseProvider({
  id: "libsql-basic",
  name: "sqld with HTTP Basic",
  type: "libsql",
  host: "sqld.internal",
  port: 8080,
  user: "libsql",
  password: "libsql-pass",
  createdAt: new Date(),
});

await provider.connect();

// 2. Execute queries with parameter binding
const result = await provider.query("SELECT * FROM users WHERE active = ?", [1]);
console.log(`Fetched ${result.rowCount} rows in ${result.executionTime}ms`);

// 3. Introspect schema objects (libSQL is zero-container, so container is [])
const tables = await provider.listObjects([], "table");
const { details } = await provider.describeObjects([], "table");

// 4. Run maintenance tasks
const integrity = await provider.runMaintenance("check");
console.log("Integrity check result:", integrity.message);

await provider.disconnect();
```

---

## 13. Known limitations & future work

| Limitation | Cause | Owner |
|---|---|---|
| No transaction controls | The provider closes its Hrana stream with each statement, so it holds no session | Ours. Hrana's `baton` is exactly the feature that would carry one |
| Agent mode needs a read-only token | `PRAGMA query_only` is refused by the server, so the token is the only lever ([§3.6](#36-the-agent-read-only-profile-rests-on-a-read-only-token)) | The engine's; mint a read-only token |
| MCP read needs a read-only seed token | A seed carries no separate agent token, so its own token is the one the open proves ("MCP read", §3.6) | The engine's; mint a read-only token for the seed |
| No Vacuum, Analyze or Optimize | Refused by the server's statement allowlist | The engine's |
| No slow queries, no sessions, no uptime, no cache ratio | libSQL publishes none of them | The engine's |
| No WAL size on the Storage tab | No statement reports it, and `PRAGMA wal_checkpoint` is refused | The engine's |
| Turso Database (the Rust engine) is not reachable | It publishes no server image and ships in-process | Revisit when a server image exists |
| No `function` object kind | `CREATE FUNCTION ... LANGUAGE wasm` is refused by the server's parser and `libsql_wasm_func_table` does not exist (§6.1) | The engine's. Declare the kind if a build ever accepts it |
| A no-affinity column holding these digits as TEXT cannot be keyed on | The bind is a value with no column attached, so the transport cannot read the affinity that would settle it (§3.4) | Ours, and accepted: the integer reading is the one the digits exist for |
| The object surface reads `main` only | `ATTACH` is refused outright and a declaration is read off a provider that never connects | Ours, and Phase 1's scope |

---

## Migration DDL

[`LIBSQL_MIGRATION_DDL`](../../src/lib/db/providers/sql/libsql/migration-ddl.ts) is what the schema-diff migration generator writes for `libsql`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
libSQL is SQLite, so `transactionWrapper` is `null` for SQLite's reason (#284), and this provider also closes its Hrana stream in the same request as each statement, so a `BEGIN` it emitted could not be continued.
A foreign key is declared only as a `CREATE TABLE` table constraint, so an added table takes the key inside the statement, and an added or dropped foreign key on an existing table is a comment (#515).
Measured over Hrana on sqld 0.24.33: `ALTER TABLE "users" ADD CONSTRAINT "fk_users_dept_id" FOREIGN KEY ("dept_id") REFERENCES "departments"("id")` and `ALTER TABLE t DROP CONSTRAINT fk_x` are both "near CONSTRAINT ... syntax error".
A modified column is a comment: on sqld 0.24.33 `ALTER TABLE t ALTER COLUMN c TYPE integer` is "unexpected end of input" and `MODIFY COLUMN` is "syntax error around `MODIFY`", while `DROP COLUMN` and `RENAME COLUMN` are accepted.
SQLite gained `ALTER COLUMN ... SET/DROP NOT NULL` in 3.53.0 (measured 2026-08-27), but sqld 0.24.33 ships 3.47.0, so declining every modification is still right here.
The fields it takes unchanged from `src/lib/db/migration-ddl/shared.ts` are `standardAddColumn`, `standardColumnDef`, `standardCreateIndex`, `standardDropColumn`, `standardDropIndex`, `standardDropTable` and `standardPrimaryKey`.

Every refusal reason it can print, verbatim:

- "SQLite cannot retype a column; recreate the table and copy the rows."
- "SQLite declares one only in CREATE TABLE; recreate the table and copy the rows."
- "Requires table recreation."

---

## 14. References

- Turso documentation — <https://docs.turso.tech/introduction>
- libSQL — <https://github.com/tursodatabase/libsql>
- Turso Database (the Rust engine) — <https://github.com/tursodatabase/turso>
- Hrana protocol specification — <https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md>
- [`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) — the registration checklist this provider followed
- [`docs/providers/sqlite.md`](sqlite.md) — the same dialect against a file
- [`docs/providers/mongodb.md`](mongodb.md) — sibling provider doc reference
