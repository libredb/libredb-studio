# Redis Provider

> Key-value store support for LibreDB Studio, built on [`ioredis`](https://github.com/redis/ioredis).
> This document is the single reference point for the Redis provider: design, architecture,
> usage, and tests. If you are reading the code, extending Redis support, or authoring a new
> provider, start here.

| | |
|---|---|
| **Status** | ✅ Implemented & shipped |
| **Database type id** | `redis` |
| **Family** | Key-Value |
| **Driver** | `ioredis` (`^5.9.2`) |
| **Query language** | `json` (plain command **or** JSON command object) |
| **Default port** | `6379` |
| **Connection pooling** | None — single lazy connection |
| **SSL** | Yes — `connection.ssl` → ioredis `tls` ([§4.3](#43-ssl--tls)) |
| **Source** | [`src/lib/db/providers/keyvalue/redis.ts`](../../src/lib/db/providers/keyvalue/redis.ts) |
| **Tests** | [`tests/integration/db/redis-provider.test.ts`](../../tests/integration/db/redis-provider.test.ts) |
| **Tracking issue** | [#7 — Implement Redis Provider](https://github.com/libredb/libredb-studio/issues/7) |

---

## 1. Overview

Redis is an in-memory key-value store. It has no tables, no rows, no SQL, and no relational
schema. LibreDB Studio is a SQL-oriented IDE, so the central design problem is:

> **How do you present a key-value store through the same `DatabaseProvider` interface that
> PostgreSQL, MySQL, and the rest implement — without emulating SQL and without leaking
> Redis-specific concepts into the shared UI?**

The answer is **mapping by convention, not emulation**. The provider does not pretend Redis is
relational. Instead it maps Redis concepts onto the slots the interface already exposes, and
relabels the UI through the provider-metadata hooks (`getCapabilities()` / `getLabels()`) so the
generic components render Redis-appropriate wording.

### Concept mapping

| `DatabaseProvider` slot | Redis realisation | Redis primitive used |
|-------------------------|-------------------|----------------------|
| "Table" (`TableSchema`) | A **key prefix** (e.g. `user:*`) | `SCAN` + prefix grouping |
| "Row" | A **key** | — |
| `query(sql)` | A Redis command (plain text or JSON) | generic `client.call()` |
| `getHealth()` / `getOverview()` | Server stats | `INFO` |
| `getSlowQueries()` | Slow command log | `SLOWLOG GET` |
| `getActiveSessions()` | Connected clients | `CLIENT LIST` |
| `getStorageStats()` | Memory usage | `INFO memory` |
| `runMaintenance('analyze')` | Server info snapshot | `INFO` |
| Indexes / table stats | Not applicable | returns `[]` |

---

## 2. Architecture

### 2.1 Where it sits

The database layer uses the **Strategy Pattern**. Every provider implements the
[`DatabaseProvider`](../../src/lib/db/types.ts) interface, and most of the shared mechanics live
in the abstract [`BaseDatabaseProvider`](../../src/lib/db/base-provider.ts). Providers are grouped
by family on disk:

```
src/lib/db/
├── base-provider.ts          # abstract base: state, helpers, default metadata, getMonitoringData()
├── types.ts                  # DatabaseProvider interface + all DTOs
├── errors.ts                 # DatabaseError hierarchy + mapDatabaseError()
├── factory.ts                # createDatabaseProvider() — dynamic import per type + provider cache
└── providers/
    ├── sql/                  # postgres, mysql, sqlite, oracle, mssql (extend SQLBaseProvider)
    ├── document/             # mongodb
    └── keyvalue/
        └── redis.ts          # ← RedisProvider (this document)
```

### 2.2 Class hierarchy

```
DatabaseProvider (interface, types.ts)
        ▲
        │ implements
BaseDatabaseProvider (abstract, base-provider.ts)
        ▲
        │ extends
RedisProvider (redis.ts)
```

`RedisProvider` extends `BaseDatabaseProvider` directly (unlike the SQL providers, which extend an
intermediate `SQLBaseProvider`). It overrides every abstract method plus the three metadata hooks
(`getCapabilities`, `getLabels`, `prepareQuery`). It inherits `getMonitoringData()`, which fans the
individual monitoring methods out in parallel — see [`base-provider.ts:99`](../../src/lib/db/base-provider.ts).

### 2.3 What the base class gives you for free

`RedisProvider` reuses these inherited members rather than reimplementing them:

- **State machine** — `setConnected()`, `setError()`, `isConnected()`, `ensureConnected()`.
- **Instrumentation** — `trackQuery()` (active-query counter) and `measureExecution()` (wall-clock timing).
- **Helpers** — `formatDuration()`, `getSafeConfig()` (password-stripped logging), `logError()`.
- **Default `getMonitoringData()`** — orchestrates `getOverview` + `getPerformanceMetrics` +
  `getSlowQueries` + `getActiveSessions` (+ optional tables/indexes/storage) concurrently.

### 2.4 Registration & lifecycle

The factory wires Redis in via a dynamic import so the `ioredis` driver is only loaded when a Redis
connection is actually opened ([`factory.ts:94`](../../src/lib/db/factory.ts)):

```ts
case 'redis': {
  const { RedisProvider } = await import('./providers/keyvalue/redis');
  return new RedisProvider(connection, options);
}
```

API routes use `getOrCreateProvider()`, which caches the connected provider per `connection.id` and
evicts it after 30 minutes idle. `disconnect()` is called on eviction and on graceful shutdown
(`SIGTERM`/`SIGINT`).

---

## 3. Design decisions

These are the non-obvious choices. Read this section before changing the provider.

### 3.1 `SCAN`, never `KEYS *`

Schema discovery uses cursor-based `SCAN` with `COUNT 100`, **not** `KEYS *`
([`redis.ts:327`](../../src/lib/db/providers/keyvalue/redis.ts)). `KEYS *` is O(N) and blocks the
entire Redis server until it completes — catastrophic on a production instance with millions of
keys. `SCAN` is incremental and non-blocking. The scan is also capped at `maxScan = 1000` keys so
schema introspection stays bounded regardless of keyspace size.

### 3.2 Key-prefix grouping as "tables"

`getKeyPrefix()` ([`redis.ts:375`](../../src/lib/db/providers/keyvalue/redis.ts)) takes everything
before the first `:` and appends `:*` — so `user:123` and `user:456` both collapse into the
`user:*` "table". Keys without a colon are their own group. For each prefix the provider probes
keys with `TYPE` until it has observed up to **3 distinct** value-types — it may inspect more than
3 keys when they share a type — to populate the synthetic column metadata. The resulting
`TableSchema` list is sorted by descending key count so the busiest prefixes surface first.

### 3.3 Generic command dispatch via `call()`

Rather than hand-coding a method per Redis command, the provider funnels everything through
`ioredis`'s low-level `client.call(command, ...args)` ([`redis.ts:230`](../../src/lib/db/providers/keyvalue/redis.ts)).
This means **any** Redis command works without code changes — `GET`, `LPUSH`, `XADD`, `JSON.GET`,
module commands, etc. The trade-off is that there is no per-command validation; an unknown or
mis-arity command surfaces as a Redis-side error wrapped in `QueryError`.

### 3.4 Two query formats, one parser

The query string is dispatched by its first character ([`redis.ts:165`](../../src/lib/db/providers/keyvalue/redis.ts)):

- Starts with `{` → parsed as a **JSON command object** `{ "command": "GET", "args": ["k"] }`.
- Anything else → parsed as a **plain command** with a small quote-aware tokenizer that preserves
  single/double-quoted arguments (so `SET k "hello world"` is two args, not three).

The dispatch happens *after* leading blank lines and `#` comment lines are dropped, so the character
that decides the format is the first character of the first runnable line, not of the buffer.

### 3.4a Comments and how one command is picked out of a buffer

`commandBody()` reduces the buffer to the one command to run, in two steps:

1. **Every `#` comment line is dropped**, wherever it sits — leading, interleaved or trailing. A
   line is a comment only when it *starts* with `#` (after trimming) **and no quoted argument is
   open across it**, so a `#` inside a key or a value is never mistaken for one — including the
   continuation line of a multi-line quoted value (`SET note "line1` / `#tag"`). The same quote
   state suspends the blank-line rule: a blank line inside an open quoted argument is data.

   Quote state is tracked **only while the block is a plain command**. The block's kind is fixed by
   its first content line with the same test §3.4 uses to pick a parser (`{` first), because the
   tracker's rules are the plain tokenizer's — no escape handling — and a JSON body's `\"` inside a
   string is not a quote to it. A key named `say"hi` therefore left a phantom quote open, no later
   comment line was dropped, and the whole-buffer run reached `JSON.parse` with comments in it:
   *"Invalid JSON command format"* instead of a `TYPE` result. A JSON body needs no tracking anyway
   — a JSON string carries no literal newline, so no line inside one can begin with `#` (#427).
2. **The first blank-line-delimited block of what remains is taken**, and its lines are joined back
   with a **newline**, verbatim. Leading blank lines are padding and are skipped; the first blank
   line *after* content ends the block.

A block rather than a line, because *outside quotes* the tokenizer treats a newline as ordinary
whitespace: a single command wrapped over several lines (`HSET k a 1` / `b 2`) has always run whole,
and `JSON.stringify(cmd, null, 2)` is legitimately multi-line — taking only line 1 would silently
half-execute both. Not the whole buffer, because the generated cheatsheet (§5.3) is a list of
alternatives separated by blank lines, and running it must run only its first command.

Joined with a newline and not a space, because the tokenizer's whitespace branch is guarded by
`!inQuote`: *inside* a quoted argument a newline is data. `SET note "line1` / `line2"` stores a
two-line value, and a space join silently rewrote it to `line1 line2`. Lines are also appended
without trimming, so indentation inside a quoted value survives.

The dispatch of §3.4 then looks at the first character of that block, not of the buffer. A JSON
command is parsed whole, so a trailing **comment** after a JSON body is fine (it was dropped in
step 1) but trailing **non-comment** text is not — it joins the block and fails `JSON.parse`.

Input that is only comments or blank lines raises
`QueryError("No command to run (only comments or blank lines)")`.

This mirrors the embedded LibreDB provider, and exists so the commented cheatsheet the schema
explorer inserts is directly runnable: selecting one command runs it, and running the whole buffer
runs its first one (#427).

### 3.5 Reply normalisation into the shared grid

Redis replies are heterogeneous (status strings, integers, nil, flat arrays, hash arrays, bulk
`INFO` text). `formatResult()` ([`redis.ts:237`](../../src/lib/db/providers/keyvalue/redis.ts))
normalises each into the standard `{ rows, fields, rowCount }` envelope so the existing
`ResultsGrid` renders them unchanged. See the [reply table](#52-result-shaping) below.

### 3.6 No connection pool

Redis is single-threaded and a single multiplexed connection is the idiomatic client model, so the
provider holds **one** `ioredis` client and ignores the `PoolConfig`. `connect()` uses
`lazyConnect: true` and then calls `connect()` explicitly so connection failures surface
deterministically at `connect()` time rather than on first command.

---

## 4. Connection

### 4.1 Configuration fields

Redis uses the discrete-field form of `DatabaseConnection` (not `connectionString`):

| Field | Required | Notes |
|-------|----------|-------|
| `host` | ✅ | Validated in `validate()` — throws `DatabaseConfigError` if missing |
| `port` | — | Defaults to `6379` |
| `password` | — | Sent as `password`; omit for unauthenticated instances |
| `database` | — | Logical DB index, parsed as int; defaults to `0` |
| `ssl` | — | `SSLConfig`; becomes the ioredis `tls` option ([§4.3](#43-ssl--tls)) |

```ts
const connection = {
  id: 'redis-1',
  name: 'Cache',
  type: 'redis',
  host: 'localhost',
  port: 6379,
  password: 'secret',   // optional
  database: '0',         // logical DB index
  createdAt: new Date(),
};
```

### 4.2 Connection-string nuance ⚠️

`getCapabilities().supportsConnectionString` is **`false`** — the provider itself only consumes
discrete fields. However, the UI connection-string parser
([`src/lib/connection-string-parser.ts`](../../src/lib/connection-string-parser.ts)) *does*
recognise `redis://` and `rediss://` URLs and **decomposes** them into `host` / `port` (default
`6379`) / `password` / `database` before they reach the provider. So a user can paste a
`redis://:pw@host:6379/0` URL into the modal, but the provider never sees the raw string.

Because the raw string is dropped, the scheme's TLS intent has to travel as a field: the parser
returns `sslMode: 'require'` for `rediss://` and `sslMode: 'disable'` for `redis://`, which the
connection form applies to the SSL panel ([§4.3](#43-ssl--tls)). Both arms are explicit on purpose -
a paste overwrites the form rather than merging into it, so pasting a plaintext URL clears a
`require` left over from a previous edit.

### 4.3 SSL / TLS

`buildTLSOptions()` ([`redis.ts:156`](../../src/lib/db/providers/keyvalue/redis.ts)) maps
`connection.ssl` onto the single `tls` option ioredis hands to `tls.connect`, so the material travels
under Node's own names — the same mapping the PostgreSQL, MySQL and Couchbase adapters use:

| `ssl.mode` | `tls` option |
|------------|--------------|
| absent / `disable` | **not present at all** — ioredis negotiates TLS whenever `tls` is set, `{}` included |
| `require` | `{ rejectUnauthorized: false }` |
| `verify-ca` / `verify-full` | `{ rejectUnauthorized: true }` |

`caCert` / `clientCert` / `clientKey` become `ca` / `cert` / `key` when set, each independently — a
server can demand mutual TLS while presenting a self-signed certificate itself. An explicit
`ssl.rejectUnauthorized` always wins over the mode. `require` does not check the chain because a
self-hosted Redis presents a self-signed certificate by default.

Measured against a TLS-only server on 2026-08-23 (`redis:latest --port 0 --tls-port 6380`, so no
plaintext port exists): `disable` is refused with *"Connection is closed."* and `require` connects in
1ms. Both arms matter — before the mode reached the driver, `require` failed the same way `disable`
does, so the pair is what distinguishes a wired path from a documented shape.

> A pasted `rediss://` URL arrives with `mode: 'require'` and a `redis://` one with `disable`
> ([§4.2](#42-connection-string-nuance)), so the scheme picks the mode and the panel is only needed
> to go *further* than `require` - a verifying mode, or certificate material. `require` rather than
> `verify-full` because that is what the ordinary `--tls-port` deployment can satisfy: a paste
> encrypts, and never silently claims to have checked a chain.
>
> Measured through the parser and the provider together on 2026-08-23, against
> `redis:latest --port 0 --tls-port 6390` with a self-signed certificate:
>
> ```text
> rediss://localhost:6390 -> sslMode require | connected, PING = [{"result":"PONG"}] | 14ms
> redis://localhost:6390  -> sslMode disable | FAILED: Failed to connect to Redis: Connection is closed.
> ```

---

## 5. Query interface

### 5.1 Accepted formats

```text
# Plain command (quote-aware)
HGETALL user:1
SET greeting "hello world"
KEYS user:*

# JSON command object
{ "command": "HGETALL", "args": ["user:1"] }
{ "command": "SET", "args": ["greeting", "hello world"] }

# Comments: blank lines and lines starting with '#' are skipped (see 3.4a)
# Read every field of the hash
HGETALL user:1
```

### 5.2 Result shaping

`formatResult()` maps each Redis reply type onto grid columns:

| Redis reply | `fields` | Example cell |
|-------------|----------|--------------|
| Simple string / status (`GET`, `PING`, `SET`) | `result` | `OK`, `PONG`, `hello-world` |
| Integer (`DEL`, `DBSIZE`, `INCR`) | `result` | `(integer) 42` |
| `nil` | `result` | `(nil)` (rowCount `0`) |
| Empty array | `result` | `(empty list)` (rowCount `0`) |
| Array (`KEYS`, `SMEMBERS`, `LRANGE`) | `index`, `value` | `1 \| user:1` |
| Hash (`HGETALL`) | `field`, `value` | `email \| a@b.com` |
| `INFO` | `section`, `key`, `value` | `Server \| redis_version \| 7.2.4` |

`INFO` is special-cased: `parseInfoResult()` splits the bulk reply into one row per metric, tagging
each with its `# Section` header ([`redis.ts:288`](../../src/lib/db/providers/keyvalue/redis.ts)).

### 5.3 Schema-explorer menu actions

Right-clicking a node in the schema tree (or its `⋮` menu) offers commands generated for that node,
so you do not have to type them from memory. The generation is driven by the `queryDialect: 'redis'`
capability, which routes the shared client-side query generators
([`src/lib/query-generators.ts`](../../src/lib/query-generators.ts)) to Redis command output.

Before #427 Redis declared no dialect, so those generators fell through to their MongoDB branch on
the strength of `queryLanguage: 'json'` alone and every action emitted a
`{"collection": "user:*", "operation": "find", …}` document that this provider answered with
`Command is required in JSON format`. The dialect is checked **before** `queryLanguage` everywhere
for that reason.

Both generators are **type-aware**: they read the sampled Redis type off the synthetic `type`
column that `getSchema()` builds (§6). A prefix that sampled a single type resolves; one that
sampled several (`string, hash`) or none does not, and falls into the unknown bucket.

**Scan Keys** (`generateTableQuery`) inserts one runnable command and executes it immediately:

| Node | Sampled type | Command |
|------|--------------|---------|
| prefix group `user:*` | any | `SCAN 0 MATCH user:* COUNT 50` |
| bare key `counter` | `string` | `GET counter` |
| bare key `session` | `hash` | `HGETALL session` |
| bare key `queue` | `list` | `LRANGE queue 0 -1` |
| bare key `tags` | `set` | `SMEMBERS tags` |
| bare key `board` | `zset` | `ZRANGE board 0 -1 WITHSCORES` |
| bare key | unknown or mixed | `TYPE <key>` |

A prefix group always SCANs and is never used as a key argument: it is a derived grouping
(`tablesAreDerivedGroupings`), so `GET user:*` would read a key literally named `user:*`. `TYPE` is
the unknown-bucket answer rather than a guessed reader, because a wrong reader (`GET` on a hash)
returns a `WRONGTYPE` error instead of an answer.

**Generate Command** (`generateSelectQuery`) inserts a cheatsheet instead — a use-case comment above
each command, where **every command line is runnable on its own** via "Run Selected". For a
`user:*` group whose keys sampled as `hash`:

```text
# Redis commands for "user:*" — select a line and Run Selected.

# List keys under this prefix — ONE scan iteration, not the whole set.
# 0 is the start cursor; the reply's first row is the next cursor. Re-run
# with that value in place of 0 until it comes back 0 (a page may be empty).
SCAN 0 MATCH user:* COUNT 50

# Check the key's type
TYPE user:1

# Read every field of the hash
HGETALL user:1

# Create or update one field — this overwrites an existing field
HSET user:1 field example

# Time to live in seconds (-1 no expiry, -2 no such key)
TTL user:1

# Delete the key (DEL takes a literal key name, never a pattern)
DEL user:1
```

Shape rules:

- The `SCAN` block appears only for a prefix group. A bare key starts at `TYPE`.
- The example key for a prefix group is the prefix plus `1` (`user:` → `user:1`), so every line is
  concrete rather than a `<placeholder>` — the same rule the LibreDB cheatsheet follows.
- The read/write pair appears only when the type resolved. An unknown or mixed group gets the
  `TYPE` / `TTL` / `DEL` frame alone. The pairs are `GET`/`SET`, `HGETALL`/`HSET`,
  `LRANGE`/`RPUSH`, `SMEMBERS`/`SADD`, `ZRANGE`/`ZADD`.
- `DEL` is given a literal key, never the group pattern: Redis key arguments are byte strings, so
  `DEL user:*` deletes a key named `user:*` or nothing at all.
- Glob metacharacters are escaped in the `MATCH` half of a `SCAN` only (a key `a[b:1` groups to
  `a[b:*`, whose unescaped `[` would open a character class), never in a key argument, where
  escaping would corrupt a literal key that genuinely contains `*`.
- An argument containing whitespace is double-quoted for the tokenizer of §3.4. An argument that the
  tokenizer cannot round-trip — one containing `"`, `'`, a backslash or a newline — makes **that line
  alone** switch to the lossless JSON command form (`{"command":"DEL","args":["say\"hi\""]}`). The two
  forms mix freely inside one cheatsheet: the provider decides per run, and every line is run on its
  own. Plain `DEL "say"hi""` would reach the driver as the key `sayhi` — a different key.
- The node name in the **header comment** is JSON-quoted, not interpolated raw. A key name is
  arbitrary bytes: a name containing a newline used to end the comment and make its own remainder
  the buffer's first runnable line, so a key called `a⏎DEL user:1 x` produced a cheatsheet whose
  first command was `DEL user:1`. The per-argument defence above never engaged, because the
  injection travelled through a comment rather than through a command. The LibreDB cheatsheet header
  is quoted the same way. For an ordinary name the rendering is unchanged (#427).
- **`SCAN 0 MATCH <prefix>* COUNT 50` is ONE cursor iteration, not a listing.** `0` is the start
  cursor and the reply's first row is the next cursor; re-run with that value in place of `0` until
  it comes back `0`. On a large keyspace an iteration can legitimately return a **non-zero cursor and
  no keys**, so "Scan Keys" may show a cursor and nothing else while the schema tree reports the
  prefix has keys — the tree's count comes from `getSchema()`, which loops the cursor over up to
  1000 keys (§6) rather than stopping at one page. A one-line command cannot loop, so the cheatsheet
  documents the continuation instead of hiding it.

A Redis tab is typed `redis` and rendered by a dedicated Monaco language
([`src/lib/editor/redis-language.ts`](../../src/lib/editor/redis-language.ts)) — command verbs as
keywords, argument words such as `MATCH` / `COUNT` / `WITHSCORES` as functions, `#` line comments.
Before #427 a Redis tab was typed `mongodb` and highlighted as JSON, which flagged every command as
a syntax error.

Four menu actions are **not offered** on Redis, all for the same reason: they address the row as an
object, and a `user:*` row is this server's grouping of a key prefix, not an object any command can
be given.

- `Profile Table` and `Generate Test Data` profile an object and insert rows into it. Both are
  hidden wherever `tablesAreDerivedGroupings` is true rather than left to answer HTTP 400 (#427).
- **Redis offers no per-row maintenance action at all** — neither *"Key Info"* nor *"Memory
  Doctor"*. Both items call `onOpenMaintenance("tables", <row>)`, which opens the admin Operations
  tab against a named table; there is no such table here, so the item was a dead end even for the
  `analyze` this provider does declare (#427). Global maintenance is unaffected and still runs from
  the Operations page (§8).

`Generate Code` stays — it names the row, it does not address it, and it sanitises the name into an
identifier that is legal in every target language (`user:*` → `User`), keeping Unicode letters
intact so a non-ASCII key prefix does not collide with another one.

---

## 6. Schema introspection

`getSchema()` ([`redis.ts:316`](../../src/lib/db/providers/keyvalue/redis.ts)) returns one
`TableSchema` per key prefix:

```
1. cursor = "0"
2. loop:
     [cursor, keys] = SCAN cursor COUNT 100
     for each key:
        prefix = substring before first ':' + ':*'   (or the whole key)
        increment prefix.count
        if prefix has < 3 DISTINCT sampled types: TYPE key → add to prefix.types
           (one blocking round-trip per key until the 3rd distinct type — a
            uniform prefix pays it for every key the scan cap allows)
   until cursor == "0"  OR  totalScanned >= 1000
3. emit TableSchema per prefix, sorted by rowCount desc
```

Each synthetic `TableSchema` has three columns: `key` (string, primary), `value` (typed by the
sampled Redis types, e.g. `string/hash`), and `type`. `indexes` is always empty (`getIndexStats()`
and `getTableStats()` return `[]` — Redis has no indexes or table statistics).

---

## 7. Monitoring & health

All monitoring derives from Redis introspection commands. `parseRedisInfo()` turns the `INFO` bulk
string into a flat `key → value` map that the methods below read from.

| Method | Source command | Returns |
|--------|----------------|---------|
| `getHealth()` | `INFO` | `connected_clients`, `used_memory_human`, hit ratio |
| `getOverview()` | `INFO` + `DBSIZE` | version, uptime, clients, maxclients, memory, key count (`tableCount`) |
| `getPerformanceMetrics()` | `INFO` | cache hit ratio, `instantaneous_ops_per_sec` → `queriesPerSecond` |
| `getSlowQueries()` | `SLOWLOG GET 10` | per-entry id, command text, duration (µs → ms) |
| `getActiveSessions()` | `CLIENT LIST` | one session per client (id, addr, db, flags, cmd, idle) |
| `getStorageStats()` | `INFO memory` | `used_memory_human`, optional `usagePercent` vs `maxmemory` |
| `getTableStats()` | — | `[]` (N/A) |
| `getIndexStats()` | — | `[]` (N/A) |

**Cache hit ratio** is computed as `keyspace_hits / (keyspace_hits + keyspace_misses) * 100`,
defaulting to `100.0` when there has been no traffic ([`redis.ts:557`](../../src/lib/db/providers/keyvalue/redis.ts)).

The monitoring methods that depend on optional Redis features (`SLOWLOG`, `CLIENT LIST`) are wrapped
in try/catch and degrade to `[]` rather than throwing — a restricted ACL that forbids those commands
won't break the monitoring dashboard.

---

## 8. Maintenance

Redis exposes a single maintenance operation:

| Type | Behaviour |
|------|-----------|
| `analyze` | Runs `INFO` and reports the number of lines in the output as a snapshot. Non-destructive. |
| anything else | Throws `QueryError` (`Unsupported maintenance type for Redis`) |

This is reflected in `getCapabilities().maintenanceOperations = ['analyze']`. The admin Operations
tab has gated each card on that list since #282, so it renders the analyze card only and never
offered Redis a vacuum action; #427 changed the **wording** on that card, not the gate (§9). The
schema explorer's **per-row** menu offers neither *"Key Info"* nor *"Memory Doctor"*, because a
per-row action needs an addressable row and these rows are derived groupings (§5.3).

The admin Operations tab also renders this provider's own wording for the analyze card — *"Run
Info"* / *"Server Info"* / *"Get Redis server information and statistics."* — instead of Postgres's
query-planner copy. Those `analyzeGlobal*` fields had been declared and set for a long time and read
by no component (#427).

---

## 9. Capabilities & labels

### `getCapabilities()` ([`redis.ts:56`](../../src/lib/db/providers/keyvalue/redis.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `json` |
| `queryDialect` | `redis` — routes the client-side query generators to Redis command output and types the editor tab `redis` (see 5.3). Checked before `queryLanguage`, which says only "not SQL" and by itself meant MongoDB (#427) |
| `supportsExplain` | `false` |
| `supportsExternalQueryLimiting` | `false` |
| `supportsCreateTable` | `false` |
| `supportsInlineRowEdit` | `false` — Redis commands are not SQL, so there is no `UPDATE ... SET` for the results grid's inline editor to emit |
| `supportsTransactions` | `false` — `MULTI`/`EXEC` exists in Redis and is not exposed through this provider, so the transaction trio and SANDBOX are not offered (#U13) |
| `declaresForeignKeys` | `false` — Redis has no constraints at all, and the "tables" here are key prefixes this provider grouped rather than objects anyone declared |
| `tablesAreDerivedGroupings` | `true` — `getSchema()` SCANs a bounded slice of the keyspace and groups the real key names it found by their prefix, so a `user:*` row is this server's own summary and not a key any command can be given. The agent layer states this to a plan run, in one sentence, so a grounded run does not draft a command against a grouping |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['analyze']` |
| `supportsConnectionString` | `false` |
| `defaultPort` | `6379` |
| `schemaRefreshPattern` | `(DEL\|FLUSHDB\|FLUSHALL\|RENAME)\b` |

`schemaRefreshPattern` tells the UI which executed commands should trigger a schema (key-pattern)
refresh — i.e. commands that add or remove keys.

### `getLabels()` ([`redis.ts:70`](../../src/lib/db/providers/keyvalue/redis.ts))

The label map relabels the generic schema-explorer UI for key-value semantics: entity → *"Key
Pattern"*, row → *"key"*, select → *"Scan Keys"*, generate → *"Generate Command"*, analyze → *"Key
Info"*, search placeholder → *"Search keys…"*, etc. `analyzeAction` (*"Key Info"*) is declared but
no longer reaches the schema explorer's per-row menu, which offers no maintenance here at all
(§5.3); it stays because it is the correct wording the moment a per-row target exists.

The labels rename actions that behave differently here, not generic ones wearing Redis names:
*"Scan Keys"* really emits `SCAN`, and *"Generate Command"* really emits Redis commands (§5.3).
That was not true before #427, when both emitted MongoDB documents under these labels.

`statementLanguage` is the one label no person sees: the agent's plan contract states it verbatim to
the model. Unlike MongoDB's, it is not about the language — a plan run on 2026-08-22 wrote real Redis
commands — but about the **shape** they were packaged in:

```
1) KEYS session:*
2) GET session:1
```

`executeRedisCommand` reads the whole body as **one** command (§5), so the server answered
`ERR unknown command '1)'`. The label therefore names the two things that made it unrunnable — the
list numbering and the second command — alongside the two accepted forms (plain and the lossless
`{"command": …, "args": […]}`), and repeats in words what `tablesAreDerivedGroupings` says in a flag:
a `prefix:*` row is this server's grouping, not a key, so a prefix is reached with `SCAN … MATCH`.

`slowQueriesEmptyState` (*"Redis lists what SLOWLOG holds, and nothing has yet run slower than
slowlog-log-slower-than."*) is the monitoring Queries panel's empty state. It exists for the same
reason the `analyzeGlobal*` triad had to be read rather than merely declared (#427): that panel's
sentence was hardcoded to PostgreSQL's `pg_stat_statements` advice on every engine
(`docs/BACKLOG.md` U12), while what is empty here is the `SLOWLOG` (§7).

`analyzeGlobalLabel` / `analyzeGlobalTitle` / `analyzeGlobalDesc` (*"Run Info"*, *"Server Info"*,
*"Get Redis server information and statistics."*) are rendered by the admin Operations tab. The
`vacuumAction` / `vacuumGlobal*` fields (*"Memory Doctor"*, *"Memory Analysis"*) are still declared
but reach no screen: the admin Operations tab's vacuum card and per-table button are gated on
`maintenanceOperations` containing `vacuum`, which this provider does not list (§8 — that gate is
#282 and unchanged here), and the schema explorer's row item is hidden because the rows are derived
groupings (§5.3). They stay so the map is complete if a vacuum-shaped operation is ever added.

---

## 10. Error handling

The provider raises the shared error classes from
[`src/lib/db/errors.ts`](../../src/lib/db/errors.ts):

| Situation | Error |
|-----------|-------|
| Missing `host` at construction | `DatabaseConfigError` |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails | `ConnectionError` |
| Malformed JSON command | `QueryError` — *"Invalid JSON command format"* |
| JSON without `command` | `QueryError` — *"Command is required…"* |
| Empty command | `QueryError` — *"Empty command"* |
| Redis-side command failure | `QueryError` — *"Redis error: …"* |

All `QueryError`s carry the `QUERY_ERROR` API code and surface to the client as `400 Bad Request`.

---

## 11. Testing

### 11.1 How the tests work

Integration tests live in
[`tests/integration/db/redis-provider.test.ts`](../../tests/integration/db/redis-provider.test.ts).
In keeping with the project's test architecture, the `ioredis` driver is replaced with an in-process
mock via `mock.module('ioredis', …)` **before** the provider is imported — there is no live Redis
container in the suite. The mock simulates a Redis 7.2.x server (`redis_version:7.2.4`,
`INFO`/`SCAN`/`CLIENT LIST`/`call()` responses), which exercises the same code paths as a real
Redis 6.0+ instance.

> ⚠️ **Mock isolation:** `bun`'s `mock.module()` is process-wide. Run the suite with
> `bun run test` (which isolates execution groups), **never** bare `bun test` across multiple
> files — see the note in [`CLAUDE.md`](../../CLAUDE.md). The Redis file mocks `ioredis`, which
> would otherwise leak into any other test sharing the process.

### 11.2 Coverage

The suite covers: validation, connect/disconnect, capabilities, labels, `prepareQuery`, all query
formats (JSON, plain, empty, `HGETALL`, `INFO`, nil), error handling (malformed JSON, missing
`command`, Redis-side error, disconnected provider), schema scanning, health, overview, performance,
slow queries, active sessions, table/index/storage stats, `getMonitoringData`, maintenance, a
battery of common commands (`KEYS`, `SET`, `DEL`, `PING`, `DBSIZE`), and **every `ssl.mode` branch**
asserted against the options object the `Redis` constructor received.

### 11.3 Run it

```bash
# Just this file
bun test tests/integration/db/redis-provider.test.ts

# Full isolated suite (CI-equivalent)
bun run test
```

### 11.4 Optional: verifying against a live Redis

The committed tests are mock-based by design. To smoke-test against a real server during
development:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
# then point a connection at localhost:6379 in the Studio UI and run e.g. `INFO`, `SCAN 0`
```

---

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'r1', name: 'Cache', type: 'redis',
  host: 'localhost', port: 6379, createdAt: new Date(),
});

await provider.connect();
await provider.query('SET greeting "hello"');     // → OK
await provider.query('GET greeting');             // → hello
await provider.query('{ "command": "HGETALL", "args": ["user:1"] }');
const schema = await provider.getSchema();        // → key prefixes as "tables"
await provider.disconnect();
```

### 12.2 Over the API

`POST /api/db/query` with the Redis command in the `sql` field — see the
[Redis Query Format](../API_DOCS.md#redis-query-format) section of `API_DOCS.md` for the full
request/response contract.

---

## 13. Known limitations & future work

- **A pasted `rediss://` URL selects `require`, not a verifying mode.** The parser carries the
  scheme as `sslMode` ([§4.2](#42-connection-string-nuance)), so the paste is encrypted, but nothing
  in a `rediss://` URL says whose certificate to trust - and the ordinary self-hosted `--tls-port`
  node presents a self-signed one, which a verifying mode would refuse. Verification therefore stays
  an explicit choice in the SSL panel; the URL alone never turns it on.
- **No Cluster / Sentinel support.** Only a single standalone node is supported.
- **`SCAN` is capped at 1000 keys** for schema discovery — prefixes that only appear beyond the cap
  won't show as "tables". This is a deliberate bound, not a bug.
- **No read-only guard.** The generic `call()` dispatch executes write/destructive commands
  (`SET`, `DEL`, `FLUSHALL`, …) the same as reads. Access control is expected to be enforced by the
  Redis ACL / user role, not the provider.
- **Binary values** are stringified via `String(...)`; non-UTF8 binary payloads may not render
  faithfully in the grid.
- **The plain-command tokenizer has no escape syntax.** Quotes group an argument but cannot be
  escaped inside one, so a key or value containing a literal `"` or `'` is not expressible in plain
  form; use the JSON command object for those. The schema-explorer generators detect this and emit
  the JSON form for the affected line automatically (§5.3), so only hand-typed plain commands are
  exposed to it.
- **Non-comment text cannot follow a JSON command.** Comment lines anywhere are dropped, including
  after a JSON body, but the body itself is parsed whole (§3.4a) — so trailing text that is not a
  `#` comment joins the block and fails `JSON.parse`.
- **No column modification in a generated migration.** Since
  [#269](https://github.com/libredb/libredb-studio/issues/269) the schema-diff migration generator
  answers a modified column per dialect; keys are not tables and carry no column definitions, so it
  emits `-- Redis: Cannot alter column "<name>". ...` where it previously emitted PostgreSQL
  `ALTER TABLE ... ALTER COLUMN` DDL that means nothing here.

---

## 14. References

- Tracking issue: [#7 — Implement Redis Provider](https://github.com/libredb/libredb-studio/issues/7)
- Driver: [`ioredis`](https://github.com/redis/ioredis)
- Source: [`src/lib/db/providers/keyvalue/redis.ts`](../../src/lib/db/providers/keyvalue/redis.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/redis-provider.test.ts`](../../tests/integration/db/redis-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md#redis-query-format)

---

## 15. Appendix — checklist for authoring a new provider

This Redis provider is a good template for a non-relational backend. To add another provider:

1. **Create** `src/lib/db/providers/<family>/<name>.ts` extending `BaseDatabaseProvider`.
2. **Implement** the abstract methods (`connect`, `disconnect`, `query`, `getSchema`, `getHealth`,
   `runMaintenance`, and the seven monitoring methods). Return `[]` from the ones that don't apply.
3. **Override** `getCapabilities()`, `getLabels()`, and `prepareQuery()` so the shared UI renders
   the right wording and feature flags.
4. **Register** the type in the `factory.ts` switch (dynamic import) and add it to the
   `DatabaseType` union in `src/lib/types.ts`.
5. **Add** the driver dependency to `package.json`.
6. **Map** native driver errors onto the `errors.ts` classes (`ConnectionError`, `QueryError`, …).
7. **Test** with a `mock.module()`-based integration test mirroring the structure above.
8. **Document** the provider in `docs/providers/<name>.md` using this file as the template, and add
   the query format to `docs/API_DOCS.md`.
