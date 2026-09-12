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

The factory wires Couchbase in via a dynamic import inside `createDatabaseProvider()`
([`factory.ts`](../../src/lib/db/factory.ts)):

```ts
case 'couchbase': {
  // The explicit /index specifier keeps this dynamic import statically analysable:
  // a bare directory resolves only at runtime, which the bundler cannot trace into a chunk.
  const { CouchbaseProvider } = await import('./providers/document/couchbase/index');
  return new CouchbaseProvider(connection, options);
}
```

`connect()` ([`index.ts`](../../src/lib/db/providers/document/couchbase/index.ts)) proves
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
([`transport.ts`](../../src/lib/db/providers/document/couchbase/transport.ts)), so adopting the SDK
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

The result type, `CouchbaseQueryResult`, is deliberately **neutral** rather than the REST
envelope ([`transport.ts`](../../src/lib/db/providers/document/couchbase/transport.ts)):

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
([`transport.ts`](../../src/lib/db/providers/document/couchbase/transport.ts)) whose `code` is a
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
mapping and Capella work (`pickQueryEndpoint()`,
[`http-transport.ts`](../../src/lib/db/providers/document/couchbase/http-transport.ts)). With no
`n1ql` entry anywhere the transport falls back to 8093 / 18093.

Discovery is cached **as a promise**, so concurrent first queries share one round trip — but a
*failed* discovery is not cached, or one unreachable moment would poison every later query on the
connection (`getQueryEndpoint()`,
[`http-transport.ts`](../../src/lib/db/providers/document/couchbase/http-transport.ts)).

Capella endpoints (`couchbases://cb.<id>.cloud.couchbase.com`) are SRV records, so a host given
without an explicit port is resolved through `_couchbases._tcp.<host>` first; a DNS failure or an
empty answer falls back to treating the host as a plain A record, which is what every self-hosted
cluster needs anyway (`resolveHost()`,
[`http-transport.ts`](../../src/lib/db/providers/document/couchbase/http-transport.ts)).

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
([`keyspace.ts`](../../src/lib/db/providers/document/couchbase/keyspace.ts)) doubles embedded
backticks so a hostile identifier cannot terminate its own quoting and have the remainder parsed as
SQL++. Backticks are also required for a second, mundane reason: **`bucket` and `scope` are reserved
words** in SQL++, and an unquoted projection over `system:keyspaces` fails with error 3000 (verified
on Server 8.0.2).

### 3.5 HTTP 200 does not mean success

The Query Service returns syntax and semantic errors **inside a 200 response** with
`status: "errors"`. The transport therefore inspects the payload *before* the HTTP code
(`throwIfFailed()`,
[`http-transport.ts`](../../src/lib/db/providers/document/couchbase/http-transport.ts));
skipping that check reports a failed statement as "0 rows".

### 3.6 `SELECT *` nests documents, so generated queries project the key explicitly

`SELECT * FROM hotel` yields `[{ "hotel": { ... } }]` — the document is nested under the keyspace
name, and the key is not part of the result at all. Generated queries therefore alias the keyspace
and project the key ([`query-generators.ts`](../../src/lib/query-generators.ts)):

```sql
SELECT META(d).id AS __id, d.* FROM `travel`.`inventory`.`hotel` AS d LIMIT 50;
```

The alias `__id` matches `COUCHBASE_DOCUMENT_KEY_COLUMN` in the introspection module
([`introspect.ts`](../../src/lib/db/providers/document/couchbase/introspect.ts)), so the schema tree
and the result grid name the key identically. A hand-written `SELECT *` still works; its columns are
then derived from the rows, because a wildcard signature tells the transport nothing
(`fieldNamesFromSignature()`,
[`http-transport.ts`](../../src/lib/db/providers/document/couchbase/http-transport.ts)).

### 3.7 Read-your-writes: `scan_consistency` defaults to `request_plus`

The query service defaults to `not_bounded`, reading the index in whatever state it happens to be
in. That is unacceptable for an interactive editor. Verified against Couchbase Server 8.0.2:
immediately after an `INSERT`, a `SELECT` returned **zero rows** while `COUNT(*)` already returned
three, and the same `SELECT` returned three rows seconds later — a user inserts a row, selects, and
sees nothing.

The transport therefore sends `scan_consistency: "request_plus"` on **every** statement
(`DEFAULT_SCAN_CONSISTENCY`,
[`http-transport.ts`](../../src/lib/db/providers/document/couchbase/http-transport.ts)), so a user
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
(`primaryIndexRemedy()`, [`index.ts`](../../src/lib/db/providers/document/couchbase/index.ts)):

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
monitoring source funnels through one helper, `degradeTo()`
([`index.ts`](../../src/lib/db/providers/document/couchbase/index.ts)):

```ts
async function degradeTo<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try { return await operation(); } catch { return fallback; }
}
```

A source the connected user cannot read yields the fallback instead of breaking an otherwise working
connection. `getSchemaRelations()` is the deliberate exception: an empty index list *is* the
un-indexed signal of §3.8, so degrading a failed catalog read to empty would fabricate that signal
for the whole bucket ([`introspect.ts`](../../src/lib/db/providers/document/couchbase/introspect.ts)).

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
([`introspect.ts`](../../src/lib/db/providers/document/couchbase/introspect.ts)) unions **all**
flavours — taking only the first would drop every field the other shapes carry. A field is nullable
when `%docs < 100`, when `null` is among its observed types, or when it is missing from some
flavour. Multiple observed types render as `mixed(a|b)`, the same convention the MongoDB provider
uses. `~meta` becomes the leading `__id` column, marked primary.

### 3.11 EXPLAIN reuses the shared tree model

`ExplainFormat` gains `"couchbase-json"`
([`src/lib/db/types.ts`](../../src/lib/db/types.ts)), with the strategy in
[`src/lib/explain/couchbase-json.ts`](../../src/lib/explain/couchbase-json.ts):

- `buildSql()` returns `EXPLAIN ${sql}` for `SELECT` statements, in **both** modes — it produces the
  plan without executing anything. SQL++ has no `EXPLAIN ANALYZE`; real timings come only from the
  request-level `profile: "timings"` parameter, which `ExplainStrategy` cannot set by design (it
  emits SQL only), so the estimate is the best available answer for either mode. This mirrors
  [`sqlite-queryplan.ts`](../../src/lib/explain/sqlite-queryplan.ts), which ignores the mode for the
  same reason.

  Returning `null` for analyze would not narrow the feature, it would disable it: the direct Explain
  action always builds with mode `analyze` (`explainAccepted`,
  [`use-query-execution.ts`](../../src/hooks/use-query-execution.ts)) and refuses the run when
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
`ConnectionModal` renders the label "Bucket" for `type === 'couchbase'` (`databaseFieldLabel`,
[`ConnectionModal.tsx`](../../src/components/ConnectionModal.tsx)), and `validate()` rejects a
connection without one ([`index.ts`](../../src/lib/db/providers/document/couchbase/index.ts)):

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

`supportsConnectionString` is `true`, and the UI parser, `parseConnectionString()`
([`connection-string-parser.ts`](../../src/lib/connection-string-parser.ts)), decomposes the URL
into discrete fields before the provider sees it:

| Input | host | port | database (bucket) |
|-------|------|------|-------------------|
| `couchbase://localhost:8091/travel` | `localhost` | `8091` | `travel` |
| `couchbase://user:pw@node1,node2/travel` | `node1` (first host wins) | `8091` | `travel` |
| `couchbases://cb.abc123.cloud.couchbase.com` | the host | `18091` | *(none — not invented)* |

Only the **management** port is ever stored: `8091` for `couchbase://`, `18091` for `couchbases://`.
The scheme also arrives as an SSL mode - `require` for `couchbases://`, `disable` for `couchbase://`
- because the transport picks `https` vs `http` from `config.ssl` alone and never re-reads the
pasted string ([§4.3](#43-tls)); without it a `couchbases://` paste posted plain HTTP to 18091.
`require` and not a verifying mode for the reason §4.3 gives: a self-hosted cluster's certificate is
self-signed, so only the SSL panel turns verification on.
A connection that carries *only* a connection string has its hostname lifted out for the transport
and nothing else — the URL's port is deliberately not used, because a `couchbase://` URL from an
application config carries the KV port, not the management port, and discovery handles the rest
(`hostFromConnectionString()`,
[`index.ts`](../../src/lib/db/providers/document/couchbase/index.ts)).
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

`rejectUnauthorized` follows the same rule PostgreSQL and MySQL use: `require` is the only mode that
does **not** verify the chain, because a self-hosted Couchbase node ships a self-signed certificate.
`verify-system` (D26) verifies against the trust store the runtime already has — the mode a Capella
endpoint can satisfy exactly as pasted, since its certificate is signed by a public root and there is
no PEM to go looking for — while `verify-ca`/`verify-full` verify against a pasted `caCert`. An
explicit `ssl.rejectUnauthorized` always wins
(`buildTlsMaterial()`,
[`http-transport.ts`](../../src/lib/db/providers/document/couchbase/http-transport.ts)).

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?)` ([`index.ts`](../../src/lib/db/providers/document/couchbase/index.ts)) sends
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
([`introspect.ts`](../../src/lib/db/providers/document/couchbase/introspect.ts)):

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
  schema loading in hand (`mapWithConcurrency()`,
  [`introspect.ts`](../../src/lib/db/providers/document/couchbase/introspect.ts)).

`getSchema()` merges both halves. A primary index carries no `index_key`, so it is reported with the
synthetic column `META().id`; `unique` is true only for primary indexes, because no secondary GSI
enforces uniqueness.

---

## 6a. The object surface (#789)

`getSchema()` above flattens the bucket into one list of collections. The object browser is the
other surface: it walks the engine's own hierarchy, so a bucket holds scopes and a scope holds
collections, functions and indexes. Both surfaces are live through Phase 1 and they read the same
catalogs.

Everything in this section was measured against **Couchbase Server 8.0.2 Community** running
[`docker/couchbase-init/01-object-fixture.sh`](../../docker/couchbase-init/01-object-fixture.sh), on
2026-09-11. The statements and the derivations live in
[`objects.ts`](../../src/lib/db/providers/document/couchbase/objects.ts); the four methods are on the
provider in [`index.ts`](../../src/lib/db/providers/document/couchbase/index.ts).

### 6a.1 What is declared

| Level | `id` | Label | Source |
|-------|------|-------|--------|
| 0 | `catalog` | Bucket | `system:buckets` |
| 1 | `schema` | Scope | `system:all_scopes`, `_system` excluded by exact name |

| Kind | Role | Path | Source |
|------|------|------|--------|
| `collection` | relation | `[bucket, scope, collection]` | `system:keyspaces` |
| `function` | routine | `[bucket, scope, function]` | `system:functions` |
| `index` | config, `attachedTo: collection` | `[bucket, scope, collection, index]` | `system:indexes` |

A collection declares `acceptsRowWrites: true`. That is the per-kind fact and it is deliberately
separate from the engine-wide `supportsInlineRowEdit: false` this provider also declares: the
results grid's `UPDATE ... SET` cannot address a document through the `__id` projection
([§9](#9-capabilities--labels)), while an import into a collection is an ordinary `UPSERT`.

`isSessionDefault` is marked at **both** levels. The bucket is the one the connection pinned; the
scope is `_default`, in that bucket only, because an unqualified SQL++ keyspace resolves into
`_default` and [§3.4](#34-keyspace-flattening-follows-the-postgresql-rule) already treats it as the implicit scope for the flat
explorer. Marking only the bucket would leave the tree's first paint opening a bucket and stopping,
with no counts read at all.

### 6a.2 Which catalog, and why not the obvious one

| Read | Catalog | Why not the alternative |
|------|---------|------------------------|
| Scopes | `system:all_scopes` | `system:scopes` lists **neither `_default` nor `_system`**. Measured on a bucket holding four scopes: `SELECT s.name FROM system:scopes` answers 2 rows while `SELECT COUNT(*) FROM system:scopes` answers 4. `_default` is where most of a bucket's collections live, so reading `system:scopes` would hide them. |
| Collections | `system:keyspaces` | `system:all_keyspaces` answers every `system:keyspaces` row for the bucket **plus three**: the `_system` scope's `_mobile` and `_query`, and a scoped `_default`.`_default` row **alongside** the pre-scopes bucket-level row that already is that collection. One collection would get two paths. The excess is three whatever the bucket holds; the totals move with the fixture ([§6a.8](#6a8-the-fixture)), so they are not quoted here. |
| Indexes | `system:indexes` | `system:all_indexes` carries a `#sequentialscan` pseudo-index for **every** keyspace it can see, in every namespace, plus the query service's own `#system` namespace indexes. What it adds is not a constant: it grows with the keyspace count, while `system:indexes` answers only the indexes that were created. |
| Functions | `system:functions` | There is no `system:all_functions` ("Keyspace not found all_functions"). |

**Nothing here counts with `COUNT(*)`, and that is measured rather than stylistic.** A `system:`
keyspace can count rows its own projection never returns — the `system:scopes` measurement above is
the reproducible case — so a badge taken that way would be a number the folder can never show.
`countObjects()` is the **length of what `listObjects()` returns**, kind by kind. That costs one
round trip per declared kind on a count, three in total, and it is what discharges the "the listing
contains exactly what the count counted" rule structurally: there is no second statement for the two
answers to drift apart in.

### 6a.3 The two row shapes, and the bucket-level one

`system:keyspaces` and `system:indexes` each answer two shapes:

- a **scoped** row, carrying `bucket`/`bucket_id` and `scope`/`scope_id`;
- the **pre-scopes bucket-level** row, carrying neither, whose name is the **bucket's** name.

The second is `_default`.`_default` and its indexes. Dropping it would hide every document written
before scopes existed, and naming the collection from the row's own `name` would address it as a
collection called `travel`, which is a keyspace path no statement can reach. One placement function
(`resolveKeyspaceOf()`) serves both catalogs, because their projections are aliased onto the same
field names.

That function is **total**: it always returns a placement. A scoped row that names no scope, and an
index row that names no keyspace, are both placed in `_default`, which is where an unqualified SQL++
keyspace resolves. Neither shape was observed on 8.0.2, and neither is claimed to be unreachable:
dropping a row instead would take it out of the **count and the listing together**, which is an
object that is invisible in the tree while the count still agrees with the listing, so no gate would
see it. The only row dropped is one carrying no **name**, which addresses nothing and cannot be a
tree row.

### 6a.4 Identity

- **A collection** is addressed by its name within its scope.
- **A function** is addressed by its **bare name**, with no argument list. SQL++ has no overloading:
  measured, with `discount(price, pct)` in place, `CREATE FUNCTION discount(price)` is refused with
  *"Function 'discount' already exists"* — refused on the name, arity and all. The same name in
  another scope succeeds. PostgreSQL needs an argument-type list here; Couchbase does not.
- **An index** carries its **collection** in the path. Measured: `ix_name` is created on both
  `inventory`.`airline` and `inventory`.`hotel` and both succeed, while a second `ix_name` on one of
  them is refused with *"The index ix_name already exists."* So the name alone is not unique within
  a scope, and the kind declares `attachedTo: "collection"`.
- A collection name is unique per **scope**, not per bucket: the fixture holds `airline` in both
  `_default` and `inventory`, each with its own `ix_name` over a different key. A read that filtered
  a collection's indexes on the collection name alone would hand one of them the other's.

### 6a.5 A GLOBAL function is excluded

`system:functions` answers namespace-level functions as well as scope-level ones. A global function
belongs to `default:`, above every bucket, so it has no container in a bucket/scope tree; listing it
under a bucket would claim it lives somewhere it does not. The fixture creates `celsius` so the
exclusion is pinned by a test that names it.

The exclusion is **structural**: a row is placed by whether its `identity` carries a bucket and a
scope, never by matching `identity.type` (measured values: `"global"`, `"scope"`). A future third
identity type is therefore placed by where it says it lives rather than dropped for being an
unrecognised spelling. There is no other classifier vocabulary in this provider at all: a row's KIND
is decided by **which catalog it came from**, so there is no `CASE` an unmodelled value can fall out
of.

`definition["#language"]` is likewise never read. Its measured values are `inline` and, on Enterprise
Edition, `javascript`; Community Edition refuses the latter outright (*"Functions of type javascript
are only supported in Enterprise Edition"*). Since one kind covers both flavours, the language is a
detail for a Phase 2 Source tab rather than a classifier.

### 6a.6 What is NOT declared, and what was measured to decide it

- **No `view` kind.** SQL++ has **no `CREATE VIEW` statement at all**: `CREATE VIEW v AS SELECT 1` is
  error 3000, *"syntax error - line 1, column 8, near 'CREATE ', at: VIEW (reserved word)"*. The
  legacy **map-reduce Views**, deprecated since 7.0 and still not removed, do exist — the fixture
  creates `_design/dev_legacy` holding a `by_city` view over the CAPI port — and they are invisible
  to the query service: a `LIKE` over `ENCODE_JSON` of `system:all_keyspaces`, `system:all_indexes`,
  `system:functions`, `system:buckets` and `system:all_scopes` finds **zero** rows mentioning it, and
  it is not a document in `_default`.`_default` either. They are reachable only over ports 8091 and
  8092, which this provider's transport does not speak for objects. Phase 2 could add them through
  the management REST surface; Phase 1 does not guess.
- **No Eventing Function kind.** Eventing is a separate service with its own REST API on port 8096.
  Measured on the fixture node, which runs `data,index,query`: nothing listens on 8096 at all, and
  Eventing is an Enterprise Edition service in any case. It is not reachable through the query
  service this provider speaks.
- **No kind for the `_system` scope's contents.** `_system` is the server's own scope (`_mobile`,
  `_query`) and is excluded by exact name. A prefix rule would be wrong twice: it would sweep up
  `_default`, and the engine already refuses any user scope starting with `_` or `%` (*"First
  character must not be _ or %"*, measured on `_systemx`), so nothing a person creates can hide
  behind the exclusion.

### 6a.7 `describeObject`

The **kind** decides, and nothing reads the name to work out what it is holding.

| Kind | Columns | Indexes | Foreign keys |
|------|---------|---------|--------------|
| `collection` | `INFER`, 100-document sample, the same bound `getSchema()` uses | that collection's `system:indexes` rows, scope and collection both matched | always `[]` |
| `function` | `[]` | `[]` | `[]` |
| `index` | `[]` | `[]` | `[]` |

A rejected `INFER` yields **no columns rather than an error**: the collection being empty (error
7014) and the user lacking SELECT on it are both ordinary states. The fixture leaves `hotel` and
`bookings` empty so that stays measured. `foreignKeys` is always `[]` for the same reason
`declaresForeignKeys: false` is declared: SQL++ has no referential constraint.

A function's parameters and its body, and an index's keys as a first-class detail, are Phase 2.

### 6a.7b `describeObjects`, the bulk column read

`describeObjects(container, kind, limit?)` answers columns and indexes for every object of one kind
in one container. The two halves of an `ObjectDetail` do not have the same answer here, and both
answers are measurements on Couchbase Server 8.0.2 Community, on a node this task created and
removed.

**The indexes bulk-read, and already did.** `INDEXES_SQL` answers one bucket's whole index catalog
in one statement and `describeObject` filters it down to one collection, so the batch reads it
**once** for the folder where a loop over `describeObject` reads the same statement once per
object.

**The columns cannot.** Couchbase stores no schema: a collection has whatever fields its documents
carry, and `INFER` is the engine's own sampler. Three measurements close every combined form:

1. `INFER a, b` is error 3000, a syntax error at the comma. `INFER` takes one keyspace.
2. `INFER` against a scope is refused: `Keyspace resolves to default:travel.inventory - only 2 or 4
   parts are valid`. There is no folder-level form.
3. `INFER` **is** subquery-able — both `SELECT * FROM (INFER ...) AS x` and
   `WITH x AS (INFER ...) SELECT x` parse — so a `UNION ALL` over several of them is a real
   statement. It is still wrong here: measured, such a statement fails **entirely** with error 7014,
   `No documents found, unable to infer schema`, as soon as one of its keyspaces is empty. An empty
   collection is an ordinary state, and the fixture keeps `hotel` and `bookings` empty on purpose,
   so a combined statement would cost a whole folder its columns because one collection held no
   documents.

So the `INFER`s are **one per described object**, at most `INFER_CONCURRENCY` (4) in flight, and cut
by the caller's `limit` before any of them is issued. A folder of N collections costs two catalog
statements plus N `INFER`s, against 2N statements for the same objects one at a time.

| Shape | Statements | Time |
| --- | --- | --- |
| One `describeObjects` over a 40-collection scope | 42 | 293 ms |
| The 40 `describeObject` calls it replaces | 80 | 462 ms |

The gain is real but modest, and that is the honest shape of it: the `INFER`s dominate and they do
not go away, so what the batch removes is 39 whole-bucket index reads. The bench scope is
re-runnable — 40 collections in a `bench` scope, two documents each — and is not part of the
committed fixture.

**One mapper, shared with the single read.** `relationDetail()` in
[`objects.ts`](../../src/lib/db/providers/document/couchbase/objects.ts) builds both, so a batch
cannot spell an index differently from `describeObject` on the same collection. Verified live: for
every collection of `travel`, `travel`.`_default` and `travel`.`inventory`, the batch's detail is
identical to `describeObject()` for the same path.

**`function` and `index` answer `{ details: [] }` with no round trip**, which is the same fact the
single read states by answering three empty arrays: a function's parameters and an index's keys are
not columns.

**The bound is the caller's, and there is no `limit + 1`.** The catalog statements answer a whole
bucket in one round trip each, so the target set is complete before anything is cut and the
comparison is exact. The cut is applied in code, after `comparePaths`, which makes a bounded read's
membership **ours** rather than the server's — the server never orders this read. `INFER`'s own
`sample_size` is deliberately **not** reported as truncation: it bounds the documents a column list
is inferred from, exactly as in the single read and in `getSchema()`, and no object is dropped by
it, so reporting it would claim the batch left objects out when it left none out.

**Collation, for the record.** SQL++ `ORDER BY` over `["\ue000", "😀"]` answers `U+E000` first,
which is UTF-8 byte order, while `comparePaths` compares UTF-16 code units and puts `😀` first
(`0xD83D` is below `0xE000`). Task 26a-2 measured the same divergence on five SQL engines. It cannot
bite here, because no statement in the object surface carries an `ORDER BY` at all: every listing,
and the cut a bounded read applies, is sorted in TypeScript.

### 6a.8 The fixture

[`docker/couchbase-init/01-object-fixture.sh`](../../docker/couchbase-init/01-object-fixture.sh) is
part of the deliverable, not scaffolding: every claim above is re-measurable against it. Couchbase
has **no `/docker-entrypoint-initdb.d`** — a fresh node has no cluster, no bucket and no index — so
it is applied by the `couchbase-init` sidecar in
[`database-compose.yml`](../../database-compose.yml), which mounts this directory at `/fixture` and
runs the script after `cluster-init`, `bucket-create` and the bucket-level `CREATE PRIMARY INDEX`.
The script is re-runnable, so an edit is re-applied with:

```bash
docker compose -f database-compose.yml up -d couchbase couchbase-init
docker logs libredb-couchbase-init
```

To apply it to a node you brought up by hand, mount the directory and run the script inside the
container, which is how the measurements above were taken:

```bash
docker run -d --name cb -p 8091:8091 -p 8092:8092 -p 8093:8093 \
  --ulimit nofile=200000:200000 \
  -v "$PWD/docker/couchbase-init:/fixture:ro" couchbase:community-8.0.2
docker exec cb couchbase-cli cluster-init -c localhost \
  --cluster-username Administrator --cluster-password password123 \
  --cluster-name libredb --services data,index,query \
  --cluster-ramsize 1024 --cluster-index-ramsize 512 --index-storage-setting default
docker exec cb couchbase-cli bucket-create -c localhost -u Administrator -p password123 \
  --bucket travel --bucket-type couchbase --storage-backend couchstore \
  --bucket-ramsize 256 --bucket-replica 0 --wait
docker exec -e COUCHBASE_HOST=localhost cb bash /fixture/01-object-fixture.sh
```

Port **8092** is the CAPI port and is needed only for the map-reduce view; the provider itself uses
8091 and 8093. What the fixture holds, and the counts it produces:

What it holds, so the counts below can be derived rather than remembered:

- **Collections:** `inventory`.`airline`, `inventory`.`hotel`, `_default`.`airline`,
  `_default`.`bookings`, plus `_default`.`_default`, which every bucket has and which the query
  service reports as the pre-scopes bucket-level row ([§6a.3](#6a3-the-two-row-shapes-and-the-bucket-level-one)).
- **Functions:** `discount` in `inventory` and `discount` in `_default`. The global `celsius` is
  deliberately outside the tree ([§6a.5](#6a5-a-global-function-is-excluded)) and is not counted.
- **Indexes:** `ix_name` on each of `inventory`.`airline`, `inventory`.`hotel` and
  `_default`.`airline`, the primary index on `inventory`.`airline`, and the bucket-level primary
  index, which the `couchbase-init` sidecar creates before running the script.

| Container | `collection` | `function` | `index` |
|-----------|--------------|------------|---------|
| `[travel]` | 5 | 2 | 5 |
| `[travel, _default]` | 3 | 1 | 2 |
| `[travel, inventory]` | 2 | 1 | 3 |

The `[travel]` row is the length of each list above; the two scope rows are the same objects split
by scope, with `_default`.`_default` and the bucket-level index falling into `_default`. Those are
the numbers `tests/integration/db/couchbase-provider.test.ts` asserts and the numbers a live
provider answered against the fixture on 2026-09-11. **They move whenever the script gains an
object**, so anything stated as a total elsewhere in this document is stated against this list.

---

## 7. Monitoring & health

Every method below degrades to empty on a permission error
([§3.9](#39-monitoring-degrades-to-empty-never-throws)) — **empty, not zero**: a denied read
measures nothing, and a metric nobody measured is omitted rather than reported as `0`
([§7.1](#71-an-unread-metric-is-absent-not-zero)).

| Method | Source | Notes |
|--------|--------|-------|
| `getOverview()` | `/pools/default`, `/pools/default/buckets/<bucket>`, `system:keyspaces`, `system:indexes` | version and uptime from the first node; `activeConnections` from the `curr_connections` series |
| `getPerformanceMetrics()` | bucket stats | cache hit ratio is `100 - ep_cache_miss_rate` (clamped 0..100); `queriesPerSecond` is `cmd_get + cmd_set`; buffer-pool usage is `quotaPercentUsed` — each is **omitted when its source published nothing** ([§7.1](#71-an-unread-metric-is-absent-not-zero)) |
| `getSlowQueries()` | `system:completed_requests` ordered by `elapsedTime` | one row per recorded request, so `calls` is always 1 — these are individual requests, not aggregates |
| `getActiveSessions()` | `system:active_requests` | request id, statement, user, remote address, state, elapsed |
| `getTableStats()` | `/pools/default/buckets/<bucket>` | **bucket level only** — per-collection item counts need a `COUNT(*)` per collection, too expensive for a monitoring poll |
| `getIndexStats()` | `system:indexes` + `/pools/default/buckets/@index-<bucket>/stats` | index name, scope, collection, keys, type. Modern servers no longer publish per-index statistics there, so an unpublished size shows as `indexSize: "N/A"` with `indexSizeBytes` **omitted** (a `0 B` read as an empty index, and the Storage tab summed it); `scans` still falls back to `0`, because `IndexStats.scans` is a required field |
| `getStorageStats()` | `/pools/default/buckets/<bucket>` | Data (`basicStats.diskUsed`) and RAM Quota (`quota.ram` with `quotaPercentUsed`) |
| `getHealth()` | the four above, in parallel | connections, size, cache hit ratio (the string `N/A` when there is none — `formatCacheHitRatio` from `src/lib/monitoring-cache-ratio.ts`), top 5 slow queries, top 10 sessions |

`maxConnections` in the overview is the documented KV default (65536): Couchbase advertises no
connection ceiling over REST, so the denominator is a constant while the numerator stays measured.

### 7.1 An unread metric is absent, not zero

`PerformanceMetrics.cacheHitRatio`, `queriesPerSecond` and `bufferPoolUsage` are all optional, and
this provider now omits each one whose source published nothing:

| Field | Reported when | Omitted when |
|-------|---------------|--------------|
| `cacheHitRatio` | the `ep_cache_miss_rate` series has a numeric last sample | the series is absent — the stats endpoint was denied, or the bucket is not a Couchbase bucket and publishes no `ep_*` series at all |
| `queriesPerSecond` | at least one of `cmd_get` / `cmd_set` was published (the other counts as 0) | neither was published |
| `bufferPoolUsage` | `basicStats.quotaPercentUsed` is a number | `basicStats` is missing, i.e. the bucket endpoint was unreadable |

A **measured** `0` is kept in every case: a bucket with no misses really is at a 100% hit ratio, an
idle bucket really is doing 0 operations, and an empty bucket really is using none of its quota.

The cache one is why this matters. `DEFAULT_THRESHOLDS` rates the ratio `direction: "below"` with
`critical: 80`, so the previous `missRate === null ? 0` — a stand-in chosen to avoid "a flattering
100" — made every bucket whose statistics the connected user may not read show a **red critical
cache fault the cluster never reported**. Reading the KV stats needs a role many application users
lack ([§3.9](#39-monitoring-degrades-to-empty-never-throws)), so that was the ordinary case, not an
edge one. Omitted, the same panels render `N/A` / "Not measured" and score the card as healthy
(`OverviewTab.tsx`, `PerformanceTab.tsx`).

---

## 8. Maintenance

`runMaintenance(type, target?)`
([`index.ts`](../../src/lib/db/providers/document/couchbase/index.ts)). All three operations
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

### Where each operation may be offered (`maintenanceOperationSpecs`)

Declaring that an operation EXISTS is not enough to put a button on it: two engines that
declare the same `MaintenanceType` take different kinds of target, so each provider also
declares what its own operations may be pointed at. The monitoring Tables tab renders a
per-row control only where `perEntity` is true, the admin Operations tab a whole-database
card only where `global` is true, and both take the wording from `label` (#496).

`POST /api/db/maintenance` reads the same declaration since #U20, and it is the one reader that
REFUSES rather than hides: it takes the placement from whether the request carries a `target`
(absent or empty means whole-database) and answers `400` when this provider marks that
placement unavailable while the other one is available - a targetless `{type:"analyze"}` or
`{type:"reindex"}` is that request here, the API-side half of the two withheld global cards.

| Operation | Control label | Per-row | Global | Why |
|-----------|---------------|---------|--------|-----|
| `analyze` | Update Statistics | yes | **no** | `UPDATE STATISTICS FOR <keyspace>` names one collection, and `dispatchMaintenance` requires the target |
| `reindex` | Build Deferred Indexes | yes | **no** | `BUILD INDEX ON <keyspace>` names one collection; there is no whole-bucket form |
| `kill` | Cancel Request | no | no | the target is a request id from the Sessions panel |

Both global cards are withheld rather than synthesised from a keyspace list this provider
does not enumerate for maintenance. Before #U9 the global Reindex card rendered for every
provider that declared `reindex`, so on Couchbase every click answered *"The reindex
operation requires a target"*; the per-collection control carries the keyspace and runs.
`vacuumAction` (*"Compact"*) names nothing this provider can run - its own description says
the server compacts automatically - so `vacuum` stays undeclared, `vacuumActionOperation`
stays absent, and that card never renders either.

---

## 9. Capabilities & labels

### `getCapabilities()` ([`index.ts`](../../src/lib/db/providers/document/couchbase/index.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | `true` |
| `explainFormat` | `couchbase-json` |
| `supportsExternalQueryLimiting` | `true` |
| `supportsCreateTable` | `false` |
| `supportsInlineRowEdit` | `false` — SQL++ has `UPDATE <keyspace> SET ... WHERE ...`, but the shared editor's `WHERE <pk> = <value>` would filter on `__id`, the key **projection alias**, which is not a document field ([§13](#13-known-limitations--future-work)) |
| `supportsTransactions` | `false` — the query service is reached over stateless HTTP and no session spans two requests, so the transaction trio and SANDBOX are not offered (#464) |
| `declaresForeignKeys` | `false` — SQL++ has no referential constraint; collections are schemaless and the columns reported here are inferred from a document sample |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['analyze', 'reindex', 'kill']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `8091` |
| `schemaRefreshPattern` | `\b(CREATE\|DROP\|ALTER)\s+(COLLECTION\|SCOPE\|INDEX)\b` |

`supportsCreateTable: false` is deliberate: `CreateTableModal` builds `CREATE TABLE` from a column
list, while Couchbase collections are schemaless and `CREATE COLLECTION` takes no columns. Leaving
the flag on would render a control that can only emit invalid SQL++.

### `getLabels()` ([`index.ts`](../../src/lib/db/providers/document/couchbase/index.ts))

Document vocabulary: entity -> *Collection*, row -> *document*, select -> *Select Documents*,
analyze -> *Update Statistics* (the card text names the Enterprise-only restriction), vacuum ->
*Compact* (the card says Couchbase compacts automatically and there is nothing to run), search
placeholder -> *Search collections or fields...*.

One label is about the monitoring tab instead: `slowQueriesEmptyState` -> *"Query stats come from
system:completed_requests, which keeps only requests over the query service's threshold."* The
Queries panel's empty state was hardcoded to PostgreSQL's `pg_stat_statements` advice on every engine
(#463), and the completed-requests catalog ([§7](#7-monitoring--health)) is what
this cluster actually keeps.

The global Reindex card gets its own triad (#464). It was hardcoded to PostgreSQL's
*"Run Reindex"* / *"Rebuild Indexes"* / *"Reconstructs all indexes in the database."*, and this
provider's `reindex` is none of those things: it is `BUILD INDEX` over the **deferred** GSI indexes of
one keyspace ([§8](#8-maintenance)).

| Field | Value |
| --- | --- |
| `reindexGlobalLabel` | *Build Indexes* |
| `reindexGlobalTitle` | *Build Deferred GSI Indexes* |
| `reindexGlobalDesc` | *Runs BUILD INDEX for the deferred global secondary indexes of one collection; it needs a collection, so run it from the collection rather than here.* |

The last clause was a fact about a control that no longer renders. `dispatchMaintenance()` sends
`reindex` through `requireTarget()` while the Operations tab's global card sends no target, so the
card used to answer *"The reindex operation requires a target"* here. #496 settled that by
withdrawing the card rather than by rewording it — `maintenanceOperationSpecs.reindex` declares
`global: false`, and `maintenanceControl(..., "global")` therefore offers nothing. The per-collection
control is the only one on this provider, which is what the operation itself requires. The three
`reindexGlobal*` labels above are consequently read by nobody today; they are the wording the card
would carry if it ever returns.

---

## 10. Error handling

The transport normalizes every failure into `CouchbaseError { code, message, retriable }`; the
provider maps that one numeric space onto the shared classes from
[`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
(`mapCouchbaseError()`, [`index.ts`](../../src/lib/db/providers/document/couchbase/index.ts)):

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
- **Index size is usually unknown and scan counts are usually 0.** Modern servers no longer publish
  per-index series under `@index-<bucket>`, and the provider does not guess: an unpublished size is
  `N/A` with no byte count, while `scans` reports `0` only because the field is required.
- **One bucket per connection.** Multi-bucket browsing from a single connection is out of scope;
  `getSchemaList()` and every monitoring read are scoped to `config.database`.
- **Analytics/Columnar, Full-Text Search, Eventing and Capella management APIs** (allowed-IP
  administration, cluster provisioning) are not covered.
- **Monitoring needs privileges.** Without the Query System Catalog role, slow queries and active
  sessions are `[]`, index scan counts read `0`, and the performance metrics whose sources are denied
  are omitted rather than reported as zeroes — by design
  ([§3.9](#39-monitoring-degrades-to-empty-never-throws), [§7.1](#71-an-unread-metric-is-absent-not-zero)).

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
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [SQLite](./sqlite.md) · [MongoDB](./mongodb.md) · [Apache Trino](./trino.md) · [Redis](./redis.md) · [LibreDB](./libredb.md)
