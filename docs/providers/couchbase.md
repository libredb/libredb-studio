# Couchbase Provider

> Couchbase Server support for LibreDB Studio, built on the documented REST surfaces — the Query
> Service (`/query/service`) and the management API (`/pools/default...`) — with **no driver
> dependency of any kind**. This document is the single reference point for the Couchbase provider:
> design, architecture, usage, and tests. If you are reading the code, extending Couchbase support,
> or authoring a new provider, start here.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `couchbase` |
| **Family** | Document (`src/lib/db/providers/document/couchbase/`) |
| **Driver** | None — HTTP only (`fetch` for plaintext, `node:https` for TLS; both runtime built-ins) |
| **Query language** | `sql` (SQL++, formerly N1QL) |
| **Default port** | `8091` management (`18091` with TLS). Query ports are **discovered**, never configured |
| **Connection pooling** | None — each statement is one stateless HTTP request |
| **Connection string** | Supported (`couchbase://`, `couchbases://`, Capella SRV endpoints) |
| **EXPLAIN** | `couchbase-json` — estimate only, no `EXPLAIN ANALYZE` |
| **Transactions** | Not exposed (no begin/commit/rollback API on this provider) |
| **Query cancellation** | No `cancelQuery`; a running request is killed via maintenance `kill` |
| **Source** | [`src/lib/db/providers/document/couchbase/`](../../src/lib/db/providers/document/couchbase/) |
| **Tests** | [`tests/integration/db/couchbase-provider.test.ts`](../../tests/integration/db/couchbase-provider.test.ts) + [`tests/unit/db/couchbase/`](../../tests/unit/db/couchbase/) |
| **Tracking issue** | [#262 — Add Couchbase provider (SQL++ over Query REST, no native dependency)](https://github.com/libredb/libredb-studio/issues/262) |

---

## 1. Overview

Couchbase is a distributed document database whose query language, **SQL++**, is a real SQL dialect.
That makes it an easier fit for this codebase than MongoDB was: the provider declares
`queryLanguage: "sql"` and inherits Monaco SQL highlighting, the shared query limiter, the `"sql"`
tab type and saved queries with no additional code.

The two things that *are* Couchbase-shaped, and which every design decision below flows from:

1. **The hierarchy has four levels** — cluster > bucket > scope > collection — while the schema
   explorer renders a flat list. The bucket is pinned by the connection; scope and collection are
   flattened exactly the way PostgreSQL flattens schema and table.
2. **Indexes govern whether, and how fast, a keyspace can be read.** From Server 7.6 an un-indexed
   collection is still readable through a *sequential scan*, but slowly; on 7.0-7.2 it fails
   outright with error 4000. The provider handles both and tells the user what to do
   ([§3.8](#38-un-indexed-keyspaces-sequential-scan-and-error-4000)).

### Concept mapping

| `DatabaseProvider` slot | Couchbase realisation | Mechanism |
|-------------------------|-----------------------|-----------|
| "Table" (`TableSchema`) | A **collection**, displayed as `collection` or `scope.collection` | `system:keyspaces` LEFT JOIN `system:scopes` |
| "Row" | A **document** | SQL++ result row |
| Columns | **Inferred** field types from a 100-document sample | `INFER <keyspace> WITH {"sample_size": 100}` |
| Primary key | The document key, projected as `__id` | `META(d).id` |
| `query(sql)` | A **SQL++** statement | `POST /query/service` |
| Indexes | Global secondary indexes (GSI) | `system:indexes` |
| Foreign keys | none (Couchbase has none) | always `[]` |
| `getOverview()` / storage | Cluster and bucket runtime statistics | `/pools/default`, `/pools/default/buckets/<bucket>` |
| `getSlowQueries()` / `getActiveSessions()` | Query-service request catalogs | `system:completed_requests`, `system:active_requests` |
| Maintenance | `analyze` / `reindex` / `kill` | `UPDATE STATISTICS`, `BUILD INDEX`, `DELETE FROM system:active_requests` |

---

## 2. Architecture

### 2.1 Where it sits

The database layer uses the **Strategy Pattern**. Every provider implements the
[`DatabaseProvider`](../../src/lib/db/types.ts) interface, and most shared mechanics live in the
abstract [`BaseDatabaseProvider`](../../src/lib/db/base-provider.ts). Couchbase is the first
provider that is a *directory* rather than a single file, because the transport is a seam
([§3.2](#32-the-transport-seam-one-interface-one-implementation)):

```
src/lib/db/providers/document/
├── mongodb.ts
└── couchbase/
    ├── index.ts             # CouchbaseProvider - the DatabaseProvider implementation
    ├── transport.ts         # CouchbaseTransport interface + neutral result types (no I/O)
    ├── http-transport.ts    # the one implementation: Query REST + management REST
    ├── keyspace.ts          # display name <-> backtick-quoted keyspace path (pure)
    └── introspect.ts        # system:* catalog reads + INFER
```

The explain strategy lives with the other strategies, not with the provider:
[`src/lib/explain/couchbase-json.ts`](../../src/lib/explain/couchbase-json.ts).

### 2.2 Class hierarchy

```
DatabaseProvider (interface, types.ts)
        ^
        | implements
BaseDatabaseProvider (abstract, base-provider.ts)
        ^
        | extends
CouchbaseProvider (couchbase/index.ts)
```

`CouchbaseProvider` extends `BaseDatabaseProvider` directly — the same pattern as `MongoDBProvider`
and `RedisProvider`. It is **not** a `SQLBaseProvider`, and the reason is the dialect rather than the
transport: that base is pure SQL text helpers keyed off `this.type`
([sql-base.ts](../../src/lib/db/providers/sql/sql-base.ts)) with nothing driver- or pool-bound in it,
so an HTTP transport alone would be no reason to skip it. What does not fit is the quoting —
`escapeIdentifier()` emits double quotes for every type except MySQL and SQL Server, while SQL++
needs doubled backticks, which this provider owns in `keyspace.ts`.

The cost of that choice is one duplication: `prepareQuery()` is re-implemented here to apply the
shared query limiter that `SQLBaseProvider.prepareQuery()` would otherwise have supplied. SQL++ being
a SQL dialect is expressed through `queryLanguage: "sql"`, not through the class hierarchy.

### 2.3 What the base class gives you for free

`CouchbaseProvider` reuses these inherited members rather than reimplementing them:

- **State machine** — `setConnected()`, `setError()`, `isConnected()`, `ensureConnected()`.
- **Instrumentation** — `trackQuery()` (active-query counter) and `measureExecution()` (wall clock).
- **Helpers** — `formatDuration()`, `getSafeConfig()` (password-stripped logging), `mapError()`.
- **Default `getMonitoringData()`** — orchestrates `getOverview` + `getPerformanceMetrics` +
  `getSlowQueries` + `getActiveSessions` (+ tables/indexes/storage) concurrently.

### 2.4 Registration & lifecycle

The factory wires Couchbase in via a dynamic import
([`factory.ts:93`](../../src/lib/db/factory.ts)):

```ts
case 'couchbase': {
  // The explicit /index specifier keeps this dynamic import statically analysable:
  // a bare directory resolves only at runtime, which the bundler cannot trace into a chunk.
  const { CouchbaseProvider } = await import('./providers/document/couchbase/index');
  return new CouchbaseProvider(connection, options);
}
```

`connect()` ([index.ts:335](../../src/lib/db/providers/document/couchbase/index.ts)) proves
reachability *and* credentials with one `GET /pools/default` — the cheapest call that needs no RBAC
role beyond cluster read — then keeps the transport. `disconnect()` clears the transport's cached
endpoint discovery; there are no sockets to close. API routes use `getOrCreateProvider()`, which
caches the connected provider per `connection.id` and evicts it after 30 minutes idle.

---

## 3. Design decisions

These are the non-obvious choices. Read this section before changing the provider.

### 3.1 HTTP transport only — no native dependency, mandatory or optional

The official `couchbase` SDK is Apache-2.0 but weighs 64.6 MB unpacked across 3765 files, depends on
`cmake-js` and `node-addon-api`, and runs a postinstall step that downloads a prebuilt binary or
compiles from source. Studio ships as a Docker image, Snap, AppImage, Flatpak, deb/rpm **and** the
`@libredb/studio` npm package that `libredb-platform` consumes — every one of those would inherit
the native module.

HTTP is also the more deployable choice, not the weaker one: air-gapped installs have no postinstall
download to fail; the binary KV protocol on 11210 does not traverse corporate HTTP proxies while
REST does; site firewall policy commonly opens 8091/18093 and not 11210; and container images need
no glibc/musl matching. Couchbase's own Web Console and the Capella UI are browser applications, so
they reach the cluster over exactly these endpoints.

Two capabilities that look SDK-only are not:

- **Direct document lookup by key** works over the Query Service via `USE KEYS`
  ([§5.3](#53-use-keys-reads-a-document-with-no-index-at-all)).
- **Distributed ACID transactions** work over REST (`BEGIN TRANSACTION` returns a `txid` carried as
  a request parameter). This provider does not expose them yet — see
  [§13](#13-known-limitations--future-work).

What remains genuinely SDK-only is three things, all named honestly in
[§13](#13-known-limitations--future-work): KV range scan, non-JSON documents, and subdocument
operations.

### 3.2 The transport seam: one interface, one implementation

Provider logic never calls `fetch`. It goes through `CouchbaseTransport`
([transport.ts:87](../../src/lib/db/providers/document/couchbase/transport.ts)), so adopting the SDK
later would be one new file implementing the same contract rather than a rewrite:

```ts
interface CouchbaseTransport {
  readonly kind: "http";
  query(stmt: string, o?: QueryOpts): Promise<CouchbaseQueryResult>;
  manage<T>(path: string): Promise<T>;
  /** SDK extension point: KV range scan. Not available over HTTP. */
  scanDocuments?(ks: Keyspace, limit: number, skip: number): Promise<CouchbaseRow[]>;
  close(): Promise<void>;
}
```

The result type is deliberately **neutral** rather than the REST envelope
([transport.ts:45](../../src/lib/db/providers/document/couchbase/transport.ts)):

```ts
interface CouchbaseQueryResult {
  rows: CouchbaseRow[];
  fieldNames: string[] | null;   // null when the source cannot tell (SELECT *)
  executionTimeMs: number;
  mutationCount: number;
  warnings: CouchbaseWarning[];   // { message, code? } - no code is left out, never zeroed
}
```

An interface shaped like `{ results, signature, status, metrics, errors }` would force any future
SDK adapter to fabricate fields only the REST API produces. Both sources produce the shape above
without inventing anything. Errors follow the same rule: the transport throws a normalized
`CouchbaseError { code, message, retriable }`
([transport.ts:105](../../src/lib/db/providers/document/couchbase/transport.ts)) whose `code` is a
single numeric space — SQL++ codes (3000, 4000, 13014, …) and HTTP codes (401, 403, 503) both land
there, so provider-level mapping is one switch.

`manage()` stays HTTP permanently: the SDK's management APIs cover bucket/index/user *settings*, not
cluster and bucket *runtime statistics*, so `/pools/default` and `/pools/default/buckets/<bucket>`
are required for overview, performance and storage metrics under any transport.

> **Seam rule.** The REST envelope identifiers (`results`, `signature`, `requestID`, `status`) must
> appear **only** in `http-transport.ts`. A stray `if (response.status === "errors")` in provider
> logic quietly erodes the boundary and makes a future SDK adapter expensive.

### 3.3 Ports are discovered, not configured

`DatabaseConnection` carries one `port`, but Couchbase needs both a management endpoint and a query
endpoint. Only the **management** port is stored (8091, or 18091 with TLS); the query endpoint comes
from `GET /pools/default/nodeServices`, reading `nodesExt[].services.n1ql` (or `n1qlSSL` under TLS)
and preferring `alternateAddresses.external` when present — which is what makes NAT, Docker port
mapping and Capella work
([http-transport.ts:445](../../src/lib/db/providers/document/couchbase/http-transport.ts)). With no
`n1ql` entry anywhere the transport falls back to 8093 / 18093.

Discovery is cached **as a promise**, so concurrent first queries share one round trip — but a
*failed* discovery is not cached, or one unreachable moment would poison every later query on the
connection ([http-transport.ts:431](../../src/lib/db/providers/document/couchbase/http-transport.ts)).

Capella endpoints (`couchbases://cb.<id>.cloud.couchbase.com`) are SRV records, so a host given
without an explicit port is resolved through `_couchbases._tcp.<host>` first; a DNS failure or an
empty answer falls back to treating the host as a plain A record, which is what every self-hosted
cluster needs anyway ([http-transport.ts:418](../../src/lib/db/providers/document/couchbase/http-transport.ts)).

### 3.4 Keyspace flattening follows the PostgreSQL rule

`keyspace.ts` is pure, with no I/O. The default scope is implicit and everything else is qualified,
exactly as `postgres.ts` does for schema/table:

```ts
keyspaceDisplayName('_default', 'hotel')     // -> "hotel"
keyspaceDisplayName('inventory', 'hotel')    // -> "inventory.hotel"
keyspaceFromDisplayName('travel', 'inventory.hotel')
// -> { bucket: 'travel', scope: 'inventory', collection: 'hotel' }
keyspacePath({ bucket: 'travel', scope: 'inventory', collection: 'hotel' })
// -> `travel`.`inventory`.`hotel`
```

**Quoting is a security boundary.** SQL++ has no bind parameter for identifiers, so keyspace paths
are assembled by concatenation; `quoteIdentifier()`
([keyspace.ts:31](../../src/lib/db/providers/document/couchbase/keyspace.ts)) doubles embedded
backticks so a hostile identifier cannot terminate its own quoting and have the remainder parsed as
SQL++. Backticks are also required for a second, mundane reason: **`bucket` and `scope` are reserved
words** in SQL++, and an unquoted projection over `system:keyspaces` fails with error 3000 (verified
on Server 8.0.2).

### 3.5 HTTP 200 does not mean success

The Query Service returns syntax and semantic errors **inside a 200 response** with
`status: "errors"`. The transport therefore inspects the payload *before* the HTTP code
([http-transport.ts:249](../../src/lib/db/providers/document/couchbase/http-transport.ts)); skipping
that check reports a failed statement as "0 rows".

### 3.6 `SELECT *` nests documents, so generated queries project the key explicitly

`SELECT * FROM hotel` yields `[{ "hotel": { ... } }]` — the document is nested under the keyspace
name, and the key is not part of the result at all. Generated queries therefore alias the keyspace
and project the key ([`query-generators.ts`](../../src/lib/query-generators.ts)):

```sql
SELECT META(d).id AS __id, d.* FROM `travel`.`inventory`.`hotel` AS d LIMIT 50;
```

The alias `__id` matches `COUCHBASE_DOCUMENT_KEY_COLUMN` in the introspection module
([introspect.ts:58](../../src/lib/db/providers/document/couchbase/introspect.ts)), so the schema tree
and the result grid name the key identically. A hand-written `SELECT *` still works; its columns are
then derived from the rows, because a wildcard signature tells the transport nothing
([http-transport.ts:183](../../src/lib/db/providers/document/couchbase/http-transport.ts)).

### 3.7 Read-your-writes: `scan_consistency` defaults to `request_plus`

The query service defaults to `not_bounded`, reading the index in whatever state it happens to be
in. That is unacceptable for an interactive editor. Verified against Couchbase Server 8.0.2:
immediately after an `INSERT`, a `SELECT` returned **zero rows** while `COUNT(*)` already returned
three, and the same `SELECT` returned three rows seconds later — a user inserts a row, selects, and
sees nothing.

The transport therefore sends `scan_consistency: "request_plus"` on **every** statement
([http-transport.ts:55](../../src/lib/db/providers/document/couchbase/http-transport.ts)), so a user
always sees their own writes. Callers that prefer latency over freshness opt out per statement:

```ts
await transport.query('SELECT ...', { scanConsistency: 'not_bounded' });
```

The trade-off is explicit: `request_plus` makes the query wait for the index to catch up with the
mutations issued before it, which costs latency on a write-heavy cluster. Correctness in an editor
is worth more than milliseconds; speed remains one option away.

### 3.8 Un-indexed keyspaces: sequential scan, and error 4000

What happens when a collection has no index depends on the server version, and the difference
matters enough to state plainly.

**Server 7.6 and later — it works, slowly.** The Query Service falls back to a *sequential scan*,
which uses a KV range scan underneath to enumerate keys, so CRUD and JOIN all succeed with no
primary or secondary index present. Verified on Community Edition 8.0.2: selecting from a
collection with no index at all returns rows, and `EXPLAIN` shows the fallback explicitly:

```json
{ "#operator": "PrimaryScan3", "index": "#sequentialscan", "using": "sequentialscan" }
```

Clicking an un-indexed collection in the schema explorer therefore just works. The caveat is
performance, not capability: a sequential scan is not optimised for throughput and degrades sharply
on large collections, to the point of query timeouts. Creating an index remains the right thing to
do for anything beyond a small or throwaway collection — it is a recommendation now, not a
prerequisite.

**Server 7.0 to 7.2 — it fails with error 4000.** Sequential scan does not exist there, so the same
statement returns "No index available on keyspace". The provider re-raises it as a `QueryError`
carrying the runnable remedy, quoted for the exact keyspace the statement read from
([index.ts:473](../../src/lib/db/providers/document/couchbase/index.ts)):

```text
No index available on keyspace `travel`.`inventory`.`hotel` that matches your query.
Create one first: CREATE PRIMARY INDEX ON `travel`.`inventory`.`hotel`
```

In both cases `getSchemaRelations()` reads `system:indexes`, so an un-indexed collection shows an
empty index list in the explorer before anything is run. Documents whose key is known are reachable
without any index on every supported version
([§5.3](#53-use-keys-reads-a-document-with-no-index-at-all)).

### 3.9 Monitoring degrades to empty, never throws

`system:completed_requests`, `system:active_requests` and the index-service statistics require the
**Query System Catalog** RBAC role, so a denial is the *normal* case for a restricted user. Every
monitoring source funnels through one helper
([index.ts:189](../../src/lib/db/providers/document/couchbase/index.ts)):

```ts
async function degradeTo<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try { return await operation(); } catch { return fallback; }
}
```

A source the connected user cannot read yields the fallback instead of breaking an otherwise working
connection. `getSchemaRelations()` is the deliberate exception: an empty index list *is* the
un-indexed signal of §3.8, so degrading a failed catalog read to empty would fabricate that signal
for the whole bucket ([introspect.ts:327](../../src/lib/db/providers/document/couchbase/introspect.ts)).

### 3.10 INFER output is nested, and every flavour is unioned

`INFER` returns one row that is itself an **array of flavours** — one entry per document shape it
found. Each flavour carries a `properties` map whose values have `type`, `%docs` and `samples`, plus
a `~meta` pseudo-property whose nested `id` describes the document key. Verified shape:

```json
{ "#docs": 3, "Flavor": "", "properties": {
  "city": { "type": "string", "%docs": 100, "samples": ["Bursa", "Istanbul"] },
  "~meta": { "properties": { "id": { "type": "string", "samples": ["hotel::1"] } } } } }
```

`columnsFromFlavours()`
([introspect.ts:178](../../src/lib/db/providers/document/couchbase/introspect.ts)) unions **all**
flavours — taking only the first would drop every field the other shapes carry. A field is nullable
when `%docs < 100`, when `null` is among its observed types, or when it is missing from some
flavour. Multiple observed types render as `mixed(a|b)`, the same convention the MongoDB provider
uses. `~meta` becomes the leading `__id` column, marked primary.

### 3.11 EXPLAIN reuses the shared tree model

`ExplainFormat` gains `"couchbase-json"`
([`src/lib/db/types.ts:93`](../../src/lib/db/types.ts)), with the strategy in
[`src/lib/explain/couchbase-json.ts`](../../src/lib/explain/couchbase-json.ts):

- `buildSql()` returns `EXPLAIN ${sql}` for `SELECT` statements, in **both** modes — it produces the
  plan without executing anything. SQL++ has no `EXPLAIN ANALYZE`; real timings come only from the
  request-level `profile: "timings"` parameter, which `ExplainStrategy` cannot set by design (it
  emits SQL only), so the estimate is the best available answer for either mode. This mirrors
  [`sqlite-queryplan.ts`](../../src/lib/explain/sqlite-queryplan.ts), which ignores the mode for the
  same reason.

  Returning `null` for analyze would not narrow the feature, it would disable it: the direct Explain
  action always builds with mode `analyze`
  ([`use-query-execution.ts:165`](../../src/hooks/use-query-execution.ts)) and refuses the run when
  the strategy declines, so the button would be dead while only the background pre-warm worked.
  A non-`SELECT` is still declined in both modes.
- `toRenderModel()` walks `#operator` into the existing `{ kind: "tree" }` model.

**Both child shapes are walked.** Couchbase plans use `~children` (an array, on `Sequence` and
friends) *and* `~child` (a single operator, observed on `Parallel`); a walker handling only
`~children` silently truncates the tree. The strategy collects every tilde-prefixed key of either
shape. Cost and cardinality are read flat on the operator or nested under `optimizer_estimates`, and
`-1` is treated as "no estimate" rather than a metric. Couchbase 8.0.2 advertises
`clusterCapabilities.n1ql` including `costBasedOptimizer` even on **Community Edition**, so cost and
cardinality can appear on CE plans.

---

## 4. Connection

### 4.1 Configuration fields

| Field | Required | Notes |
|-------|----------|-------|
| `host` | Yes (or `connectionString`) | Cluster node hostname. `validate()` throws `DatabaseConfigError` when both are missing |
| `port` | No | **Management** port only. Defaults to `8091` (`18091` when SSL is on). Query ports are discovered ([§3.3](#33-ports-are-discovered-not-configured)) |
| `user` / `password` | No | Sent as HTTP Basic on every request |
| `database` | **Yes** | Carries the **bucket** name. One bucket per connection; the ConnectionModal labels this field "Bucket" |
| `connectionString` | No | `couchbase://` / `couchbases://`; see [§4.2](#42-connection-strings) |
| `ssl` | No | See [§4.3](#43-tls) |

`database` being the bucket is the one field that surprises people, so the form says so:
`ConnectionModal` renders the label "Bucket" for `type === 'couchbase'`
([`ConnectionModal.tsx:139`](../../src/components/ConnectionModal.tsx)), and `validate()` rejects a
connection without one ([index.ts:325](../../src/lib/db/providers/document/couchbase/index.ts)):

```text
Couchbase requires a bucket (use the "database" field)
```

Multi-bucket browsing from a single connection is out of scope; create one connection per bucket.

```ts
const connection = {
  id: 'cb-1',
  name: 'Travel',
  type: 'couchbase',
  host: '127.0.0.1',
  port: 8091,            // management port; 8093 is found from the cluster
  user: 'Administrator',
  password: 'password123',
  database: 'travel',    // the BUCKET
  createdAt: new Date(),
};
```

### 4.2 Connection strings

`supportsConnectionString` is `true`, and the UI parser
([`connection-string-parser.ts:138`](../../src/lib/connection-string-parser.ts)) decomposes the URL
into discrete fields before the provider sees it:

| Input | host | port | database (bucket) |
|-------|------|------|-------------------|
| `couchbase://localhost:8091/travel` | `localhost` | `8091` | `travel` |
| `couchbase://user:pw@node1,node2/travel` | `node1` (first host wins) | `8091` | `travel` |
| `couchbases://cb.abc123.cloud.couchbase.com` | the host | `18091` | *(none — not invented)* |

Only the **management** port is ever stored: `8091` for `couchbase://`, `18091` for `couchbases://`.
A connection that carries *only* a connection string has its hostname lifted out for the transport
and nothing else — the URL's port is deliberately not used, because a `couchbase://` URL from an
application config carries the KV port, not the management port, and discovery handles the rest
([index.ts:368](../../src/lib/db/providers/document/couchbase/index.ts)).
`detectConnectionStringType()` maps both schemes to `couchbase`.

A Capella endpoint carries neither a port nor a bucket path, so the bucket must be filled in by
hand; nothing is invented for it.

### 4.3 TLS

`config.ssl` drives two things. When `mode` is anything but `disable`, requests switch from `fetch`
to `node:https` and the scheme becomes `https`. Node's `fetch` cannot carry a custom CA or relax
verification without an undici `Agent` passed as `dispatcher`, and undici is not a dependency of this
project (and must not become one); `node:https` is a built-in that takes `ca`/`cert`/`key`/
`rejectUnauthorized` directly, so self-signed self-hosted clusters work on the Node runtime that
ships in the Docker image.

`rejectUnauthorized` follows the same rule PostgreSQL and MySQL use: only `verify-ca` and
`verify-full` verify the chain by default, because a self-hosted Couchbase node ships a self-signed
certificate — an explicit `ssl.rejectUnauthorized` always wins
([http-transport.ts:256](../../src/lib/db/providers/document/couchbase/http-transport.ts)).

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?)` ([index.ts:408](../../src/lib/db/providers/document/couchbase/index.ts)) sends
one SQL++ statement. Positional parameters map to `$1`-style placeholders:

```ts
await provider.query('SELECT h.name FROM `travel`.`inventory`.`hotel` AS h WHERE h.city = $1',
                     ['Istanbul']);
```

The request carries `metrics: true`, the effective statement timeout, and
`scan_consistency: request_plus` ([§3.7](#37-read-your-writes-scan_consistency-defaults-to-request_plus)).
`prepareQuery()` injects `LIMIT`/`OFFSET` through the shared limiter
(`supportsExternalQueryLimiting: true`), so paging behaves as it does for every SQL provider —
including where the clause is placed: at the end of the statement, before a trailing comment or `;`
([`query-optimization.md`](../editor/query-optimization.md#where-the-bound-is-placed)).

The limiter is told which dialect it is reading (#292), and Couchbase is one of the dialects
deliberately left at the **compatibility default**: no authoritative source was established for how
SQL++ reads `#`, and guessing it from a neighbouring dialect is what that channel exists to stop. So
the reading here is unchanged — `#` opens a line comment unless the next character makes a PostgreSQL
operator — and a statement ending in a `#` run is returned unbounded rather than bounded on a guess
([which dialect the readers are reading](../editor/query-optimization.md#which-dialect-the-readers-are-reading)).

### 5.2 Result shaping

| Source field | `QueryResult` field | Notes |
|--------------|---------------------|-------|
| result rows | `rows` | JSON objects exactly as the cluster returned them |
| signature | `fields` | `null` for a wildcard signature, in which case columns are the union of the keys the rows carry, first seen first |
| — | `rowCount` | `rows.length`, or the mutation count when a statement returned no rows |
| metrics `executionTime` | `executionTime` | The cluster's own time (excludes network latency); falls back to the measured wall clock when the cluster reported none |
| `warnings` | `warnings` | The notices the cluster attached to a statement it completed, each carrying its message and the cluster's own code **when it reported one** — an entry with no code arrives without one rather than with a substituted `0`, which is itself a legal code. **Absent** when the cluster reported no warnings at all — never an empty array, so the result UI decides from the field's presence alone (issue #273) |

### 5.3 `USE KEYS` reads a document with no index at all

This is the second thing that surprises people, and it is worth knowing before creating an index
just to look at one document. `USE KEYS` bypasses index lookup and reads straight from KV:

```sql
SELECT META(d).id AS __id, d.* FROM `travel`.`inventory`.`hotel` AS d USE KEYS ["hotel::1"];
```

That statement succeeds on a keyspace that has **no index whatsoever** — error 4000 never fires.
What still needs an index is *discovering* keys you do not already know
([§13](#13-known-limitations--future-work)).

### 5.4 EXPLAIN

The EXPLAIN button is available (`supportsExplain: true`) and renders the plan tree described in
[§3.11](#311-explain-reuses-the-shared-tree-model). Couchbase has no analyze mode, so both the
direct action and the background pre-warm show the estimated plan.

---

## 6. Schema introspection

`getSchemaList()` is the primary path used by `/api/db/schema/list`, so columns are produced there
([introspect.ts:306](../../src/lib/db/providers/document/couchbase/introspect.ts)):

| Data | Source |
|------|--------|
| Collections | `system:keyspaces` LEFT JOIN `system:scopes`, filtered to the pinned bucket |
| Columns | `INFER <keyspace> WITH {"sample_size": 100}` per collection, 4 at a time, 5 s server-side timeout each |
| Indexes | `system:indexes` (via `getSchemaRelations()`) |
| Foreign keys | always `[]` — Couchbase has none and none are invented |

Three details are load-bearing:

- **The join is a LEFT JOIN.** `system:scopes` does not list `_default` on Server 8.0.2, so an inner
  join silently drops every collection in the default scope.
- **The bucket-level catalog row is kept.** A row with `name = bucket` and no `bucket`/`scope`
  fields *is* the pre-collections default collection; dropping it would hide every document written
  before scopes existed.
- **A failed INFER yields empty columns, never an error.** The two common causes — the user lacks
  SELECT on the collection, and the collection is empty (error 7014, "No documents found, unable to
  infer schema") — are both states the explorer should render, not fail on. Coverage is *not*
  truncated to a fixed number of collections; the concurrency bound of 4 is what keeps the cost of
  schema loading in hand ([introspect.ts:245](../../src/lib/db/providers/document/couchbase/introspect.ts)).

`getSchema()` merges both halves. A primary index carries no `index_key`, so it is reported with the
synthetic column `META().id`; `unique` is true only for primary indexes, because no secondary GSI
enforces uniqueness.

---

## 7. Monitoring & health

Every method below degrades to empty/zero on a permission error
([§3.9](#39-monitoring-degrades-to-empty-never-throws)).

| Method | Source | Notes |
|--------|--------|-------|
| `getOverview()` | `/pools/default`, `/pools/default/buckets/<bucket>`, `system:keyspaces`, `system:indexes` | version and uptime from the first node; `activeConnections` from the `curr_connections` series |
| `getPerformanceMetrics()` | bucket stats | cache hit ratio is `100 - ep_cache_miss_rate` (clamped 0..100); `queriesPerSecond` is `cmd_get + cmd_set`; buffer-pool usage is `quotaPercentUsed` |
| `getSlowQueries()` | `system:completed_requests` ordered by `elapsedTime` | one row per recorded request, so `calls` is always 1 — these are individual requests, not aggregates |
| `getActiveSessions()` | `system:active_requests` | request id, statement, user, remote address, state, elapsed |
| `getTableStats()` | `/pools/default/buckets/<bucket>` | **bucket level only** — per-collection item counts need a `COUNT(*)` per collection, too expensive for a monitoring poll |
| `getIndexStats()` | `system:indexes` + `/pools/default/buckets/@index-<bucket>/stats` | index name, scope, collection, keys, type; size and scan counts fall back to 0 because modern servers no longer publish them there |
| `getStorageStats()` | `/pools/default/buckets/<bucket>` | Data (`basicStats.diskUsed`) and RAM Quota (`quota.ram` with `quotaPercentUsed`) |
| `getHealth()` | the four above, in parallel | connections, size, cache hit ratio, top 5 slow queries, top 10 sessions |

`maxConnections` in the overview is the documented KV default (65536): Couchbase advertises no
connection ceiling over REST, so the denominator is a constant while the numerator stays measured.

---

## 8. Maintenance

`runMaintenance(type, target?)`
([index.ts:762](../../src/lib/db/providers/document/couchbase/index.ts)). All three operations
**require** a target.

| Type | Couchbase action | Notes |
|------|------------------|-------|
| `analyze` | `UPDATE STATISTICS FOR <keyspace> INDEX ALL` | **Enterprise Edition only.** A Community cluster answers "'Update Statistics' is an enterprise level feature." — returned verbatim as a failed result, not swallowed or reworded |
| `reindex` | `BUILD INDEX ON <keyspace>(...)` over the keyspace's deferred indexes | Reports "No deferred indexes on X" when there are none |
| `kill` | `DELETE FROM system:active_requests WHERE requestId = $1` | Target is the request id shown in active sessions |

`vacuum`, `optimize` and `check` have no Couchbase equivalent, so they are absent from
`maintenanceOperations` and neither tab that offers maintenance renders them — the monitoring Tables
tab since #272, the admin Operations tab since #282.
Calling `runMaintenance` with one directly throws a `QueryError` naming the three supported
operations.

---

## 9. Capabilities & labels

### `getCapabilities()` ([index.ts:276](../../src/lib/db/providers/document/couchbase/index.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | `true` |
| `explainFormat` | `couchbase-json` |
| `supportsExternalQueryLimiting` | `true` |
| `supportsCreateTable` | `false` |
| `supportsInlineRowEdit` | `false` — SQL++ has `UPDATE <keyspace> SET ... WHERE ...`, but the shared editor's `WHERE <pk> = <value>` would filter on `__id`, the key **projection alias**, which is not a document field ([§13](#13-known-limitations--future-work)) |
| `declaresForeignKeys` | `false` — SQL++ has no referential constraint; collections are schemaless and the columns reported here are inferred from a document sample |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['analyze', 'reindex', 'kill']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `8091` |
| `schemaRefreshPattern` | `\b(CREATE\|DROP\|ALTER)\s+(COLLECTION\|SCOPE\|INDEX)\b` |

`supportsCreateTable: false` is deliberate: `CreateTableModal` builds `CREATE TABLE` from a column
list, while Couchbase collections are schemaless and `CREATE COLLECTION` takes no columns. Leaving
the flag on would render a control that can only emit invalid SQL++.

### `getLabels()` ([index.ts:293](../../src/lib/db/providers/document/couchbase/index.ts))

Document vocabulary: entity -> *Collection*, row -> *document*, select -> *Select Documents*,
analyze -> *Update Statistics* (the card text names the Enterprise-only restriction), vacuum ->
*Compact* (the card says Couchbase compacts automatically and there is nothing to run), search
placeholder -> *Search collections or fields...*.

---

## 10. Error handling

The transport normalizes every failure into `CouchbaseError { code, message, retriable }`; the
provider maps that one numeric space onto the shared classes from
[`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
([index.ts:444](../../src/lib/db/providers/document/couchbase/index.ts)):

| Code | Meaning | Error raised |
|------|---------|--------------|
| `4000` | No index available on keyspace | `QueryError` **+ the runnable `CREATE PRIMARY INDEX` remedy** ([§3.8](#38-un-indexed-keyspaces-sequential-scan-and-error-4000)) |
| `1080` | Request timeout | `TimeoutError` |
| `13014` | Missing or invalid credentials | `AuthenticationError` |
| `401` / `403` | HTTP unauthorized / forbidden | `AuthenticationError` |
| `503` | Query service unavailable (node warming up) | `ConnectionError` |
| `0` with `retriable` | Network fault (DNS, refused, reset) | `ConnectionError` |
| anything else (e.g. `3000` syntax) | Statement the cluster rejected | `QueryError` carrying the cluster's message |

| Situation | Error |
|-----------|-------|
| Missing `host` **and** `connectionString` | `DatabaseConfigError` |
| Missing `database` (bucket) | `DatabaseConfigError` |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails on credentials | `AuthenticationError` |
| `connect()` fails otherwise | `ConnectionError` (carries host/port) |

`retriable` marks failures worth repeating (request timeout 1080, bulk KV fetch 12008, CAS mismatch
12009, network faults) as opposed to ones that need a user fix.

---

## 11. Testing

### 11.1 How the tests work

There is **no `mock.module()` anywhere in the Couchbase suite**, which is why these files carry no
process-wide contamination risk:

- [`tests/integration/db/couchbase-provider.test.ts`](../../tests/integration/db/couchbase-provider.test.ts)
  replaces `globalThis.fetch` per test and restores it in `afterEach`. Every payload in it was
  captured from a live Couchbase Server 8.0.2 Community node, so the fake speaks exactly what the
  cluster speaks.
- [`tests/unit/db/couchbase/http-transport.test.ts`](../../tests/unit/db/couchbase/http-transport.test.ts)
  drives the transport through its injected `requestJson` / `resolveSrv` dependencies, and exercises
  the real `nodeRequestJson` against a local server rather than mocking it away.
- [`tests/unit/db/couchbase/introspect.test.ts`](../../tests/unit/db/couchbase/introspect.test.ts)
  and [`keyspace.test.ts`](../../tests/unit/db/couchbase/keyspace.test.ts) test pure functions and a
  hand-written fake transport — the payoff of the seam in
  [§3.2](#32-the-transport-seam-one-interface-one-implementation).
- [`tests/unit/lib/explain/couchbase-json.test.ts`](../../tests/unit/lib/explain/couchbase-json.test.ts)
  covers the plan walker, including the `~child` / `~children` pair.

### 11.2 Coverage

Validation, connect/disconnect, capabilities, labels, `prepareQuery`, query execution and result
shaping, the full error map, endpoint discovery (including `alternateAddresses` and the fallback
port), SRV resolution and its fallback, TLS material, `request_plus` **and** the `not_bounded`
override, collection listing, INFER flavour union, index mapping, every monitoring method and its
degraded path, all three maintenance operations, and the explain strategy.

### 11.3 Run it

```bash
# Just this provider
bun test tests/integration/db/couchbase-provider.test.ts
bun test tests/unit/db/couchbase

# Full isolated suite (CI-equivalent)
bun run test
```

### 11.4 Optional: verifying against a live cluster

The committed tests are mock-based by design. To smoke-test against a real server:

```bash
docker run --rm -d --name cb -p 8091-8096:8091-8096 couchbase:community

# Community Edition REJECTS the Magma storage backend, which couchbase-cli defaults to,
# and a single node cannot satisfy a replica - both flags are required.
docker exec cb couchbase-cli cluster-init -c 127.0.0.1 \
  --cluster-username Administrator --cluster-password password123 \
  --services data,index,query --cluster-ramsize 512 --cluster-index-ramsize 256
docker exec cb couchbase-cli bucket-create -c 127.0.0.1 \
  -u Administrator -p password123 --bucket travel \
  --bucket-type couchbase --bucket-ramsize 256 \
  --storage-backend couchstore --bucket-replica 0
```

Then point a Studio connection at `127.0.0.1:8091` with bucket `travel`, and create a primary index
so the collection can be browsed:

```sql
CREATE PRIMARY INDEX ON `travel`;
```

---

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'cb1', name: 'Travel', type: 'couchbase',
  host: '127.0.0.1', port: 8091,
  user: 'Administrator', password: 'password123',
  database: 'travel',                    // the bucket
  createdAt: new Date(),
});

await provider.connect();

const rows = await provider.query(
  'SELECT META(d).id AS __id, d.* FROM `travel`.`inventory`.`hotel` AS d LIMIT 50',
);
const byKey = await provider.query(
  'SELECT d.* FROM `travel`.`inventory`.`hotel` AS d USE KEYS ["hotel::1"]',
);
const schema = await provider.getSchema();   // collections + inferred fields + indexes

await provider.disconnect();
```

### 12.2 Over the API

`POST /api/db/query` with the SQL++ statement in the `sql` field — the same contract every SQL
provider uses. `POST /api/db/maintenance` (admin) accepts `analyze` / `reindex` / `kill`, each with a
target. Transaction and cancel routes do not apply.

---

## 13. Known limitations & future work

**What the HTTP transport does not provide.** These are real, they are the whole cost of having no
native dependency, and they are listed first so nobody discovers them by accident:

- **Direct KV range scan, on Server 7.0-7.2 only.** The SDK can stream a collection's documents
  straight from the data service without touching an index. On 7.6 and later this gap has closed on
  its own: the Query Service performs a sequential scan backed by a KV range scan, so an un-indexed
  collection lists fine over plain SQL++ and no SDK is required
  ([§3.8](#38-un-indexed-keyspaces-sequential-scan-and-error-4000)). The gap is therefore confined
  to clusters older than 7.6, where an un-indexed collection raises error 4000 and the remedy is to
  create the index. The seam still carries the `scanDocuments?()` extension point
  ([§3.2](#32-the-transport-seam-one-interface-one-implementation)).
- **Non-JSON documents.** The Query Service only sees JSON. Binary and raw-string documents stored
  through the KV API are invisible to every SQL++ statement, so they appear in no result set and
  contribute nothing to `INFER`.
- **Subdocument operations.** The KV subdoc API (mutate/lookup a single path inside a document
  without fetching it) has no REST equivalent. SQL++ projection covers reading a path; targeted
  in-place path mutation does not exist here — an `UPDATE ... SET` rewrites through the query
  service instead.
- **No inline row editing in the results grid**, declared as `supportsInlineRowEdit: false`
  ([#269](https://github.com/libredb/libredb-studio/issues/269)). The obstacle is not `UPDATE` — SQL++
  has it — but the document key: the collection-open query projects it as `META(d).id AS __id`, and
  the shared editor's key heuristic picks that alias up and emits `WHERE __id = '<key>'`, a predicate
  no document satisfies, so the edit would match zero documents and still report success. Addressing a
  document needs `META(d).id` or `USE KEYS`, i.e. per-dialect statement building
  ([#279](https://github.com/libredb/libredb-studio/issues/279)). Until then the control is not
  offered here and a document is edited with a hand-written SQL++ statement.
- **No column modification in a generated migration.** #269 also gave the schema-diff migration
  generator a per-dialect answer for a modified column; a collection has no column definition to
  change, so it emits `-- Couchbase: Cannot alter column "<name>". ...` where it previously emitted
  PostgreSQL `ALTER TABLE ... ALTER COLUMN` DDL the query service would reject.

A follow-up issue gets opened if a real user reports one of: browsing collections that have no
index, viewing non-JSON documents, or a policy requiring the official SDK. At that point the work is
one new file implementing `CouchbaseTransport`; provider logic, introspection, the explain strategy
and all UI registration are untouched.

Everything else:

- **No transactions.** SQL++ transactions work over REST (`BEGIN TRANSACTION` returns a `txid`), but
  the provider exposes no begin/commit/rollback API.
- **No `cancelQuery`.** A running statement is terminated through maintenance `kill` with its
  request id, which needs the Query System Catalog role.
- **`UPDATE STATISTICS` is Enterprise-only.** On Community Edition the maintenance action returns
  the cluster's refusal verbatim rather than pretending to succeed.
- **No analyze-mode EXPLAIN.** SQL++ has none; see
  [§3.11](#311-explain-reuses-the-shared-tree-model).
- **Schema columns are a sample, not a declaration.** `INFER` reads 100 documents per collection, so
  a field that appears only in unsampled documents will not show. Inference is flat: a nested object
  is reported as its own type, not expanded into dotted sub-fields.
- **Table stats are bucket level.** Per-collection item counts would need a `COUNT(*)` per
  collection on every monitoring poll.
- **Index size and scan counts are usually 0.** Modern servers no longer publish per-index series
  under `@index-<bucket>`, and the provider does not guess.
- **One bucket per connection.** Multi-bucket browsing from a single connection is out of scope;
  `getSchemaList()` and every monitoring read are scoped to `config.database`.
- **Analytics/Columnar, Full-Text Search, Eventing and Capella management APIs** (allowed-IP
  administration, cluster provisioning) are not covered.
- **Monitoring needs privileges.** Without the Query System Catalog role, slow queries and active
  sessions are `[]` and index statistics fall back to zero — by design
  ([§3.9](#39-monitoring-degrades-to-empty-never-throws)).

---

## 14. References

- Tracking issue: [#262 — Add Couchbase provider](https://github.com/libredb/libredb-studio/issues/262)
- Source: [`src/lib/db/providers/document/couchbase/`](../../src/lib/db/providers/document/couchbase/)
- Explain strategy: [`src/lib/explain/couchbase-json.ts`](../../src/lib/explain/couchbase-json.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/couchbase-provider.test.ts`](../../tests/integration/db/couchbase-provider.test.ts) · [`tests/unit/db/couchbase/`](../../tests/unit/db/couchbase/)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Query Service REST API: <https://docs.couchbase.com/server/current/n1ql/n1ql-rest-api/index.html>
- Listing Node Services: <https://docs.couchbase.com/server/current/rest-api/rest-list-node-services.html>
- System namespace catalogs: <https://docs.couchbase.com/server/current/n1ql/n1ql-intro/sysinfo.html>
- USE clause (`USE KEYS`): <https://docs.couchbase.com/server/current/n1ql/n1ql-language-reference/hints.html>
- INFER: <https://docs.couchbase.com/server/current/n1ql/n1ql-language-reference/infer.html>
- EXPLAIN: <https://docs.couchbase.com/server/current/n1ql/n1ql-language-reference/explain.html>
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [SQLite](./sqlite.md) · [MongoDB](./mongodb.md) · [Redis](./redis.md) · [LibreDB](./libredb.md)
