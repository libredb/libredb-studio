# Milvus Provider

The `milvus` type-id: read-only browsing, queries, exact counts and vector searches over Milvus's gRPC API, with an admin's Load and Release, tested against Milvus 3.0.2.
Source: [`src/lib/db/providers/vector/milvus/`](../../src/lib/db/providers/vector/milvus/).
Tests: [`tests/unit/db/milvus/`](../../tests/unit/db/milvus/) and [`tests/integration/db/milvus-provider.test.ts`](../../tests/integration/db/milvus-provider.test.ts).
Tracking issues: [#424](https://github.com/libredb/libredb-studio/issues/424) and [#1089](https://github.com/libredb/libredb-studio/issues/1089).

## 1. Overview

Studio reads a Milvus server through a gRPC client of its own, shows its databases and collections in the object tree, and runs one Milvus request per run in the editor, written as Milvus's own REST v2 request: one `POST /v2/vectordb/<route>` line and one JSON body.
It reads only: no request Studio sends writes an entity, changes a schema or loads a collection, and an admin's Load and Release in Admin > Operations are the only state changes, each previewed, confirmed and audited.
It never makes the server call another service: server-side functions, model rankers and search aggregation are refused in every release.
It shows MCP clients and the agent the schema alone, never a value or a vector.

### Concept mapping

| Milvus | Studio |
|---|---|
| A database | A container, labelled Database |
| A collection | A row of Collections, opened in the Source tab |
| A field, the dynamic field | A column; the dynamic field is one column `$meta` of type `JSON (dynamic)` |
| A partition, an alias, an index | Details of a collection, in its Source and in the console routes |
| An entity | A result row |
| A vector field | A vector column, drawn by the vector cell renderer |
| `POST /v2/vectordb/entities/search` and the other read routes | One request per run in the editor |
| LoadCollection, ReleaseCollection | The Load and Release controls of Admin > Operations |

## 2. Architecture

### 2.1 Where it sits

`MilvusProvider` extends `BaseDatabaseProvider` as the first member of the `vector` family, and every module talks to Milvus only through the `MilvusClient` interface of `client.ts`, each through the slice of methods it calls.
`grpc-client.ts` is the one file that imports `@grpc/grpc-js`, `@grpc/proto-loader` and the generated descriptor, and its stub holds exactly the allowlist of section 2.4.
`routes.ts`, `guard.ts`, the phase 0 half of `request.ts`, `generators.ts`, `float32-text.ts`, `type-spelling.ts` and `labels.ts` are pure and shipped to the browser, because the editor, the confirmation gate and the generators read them; everything else runs on the server.

### 2.2 Modules

| File | What it owns |
|---|---|
| `client.ts` | The seam: `MilvusClient`, its wire-mirroring types and `MilvusError` |
| `grpc-client.ts` | The one channel, the `authorization` metadata, `db_name` on every request, the deadlines, `call.cancel()`, the channel options and the TLS identity |
| `proto/` | The vendored milvus-proto files of `go-api/v3.0.2` and the descriptor generated from them by `scripts/generate-milvus-descriptor.mjs` |
| `connection-options.ts` | The connection to options, with the endpoint, credential, plaintext and TLS checks and the seed stage |
| `routes.ts`, `request.ts`, `guard.ts` | The console dialect, the route table with its key schemas and caps, and the request rules in two phases |
| `expr.ts`, `placeholder-group.ts`, `codec.ts`, `field-data.ts` | Filters by template, query vectors on the wire, and every cell decoded from the answer |
| `schema.ts`, `results.ts`, `milvus-vocabulary.ts` | Columns, vector columns, the merge rule, the score column and the result budget |
| `execute.ts`, `objects.ts`, `source.ts` | One request within its bounds, the object surface and the two-part Source |
| `monitoring.ts`, `monitoring-reads.ts`, `maintenance.ts` | The monitoring panels, Load with its preview and Release |
| `write-policy.ts`, `versions.ts`, `errors.ts` | The read-only decisions, the version gates and the one error table |
| `generators.ts`, `float32-text.ts`, `type-spelling.ts`, `labels.ts`, `index.ts` | The generated requests, the float text, the type spellings, the labels and the composition root |

### 2.3 Registration & lifecycle

The constructor validates nothing and opens nothing, so a provider built from any connection answers its capabilities and labels.
`connect()` checks the endpoint, the credentials, the plaintext rule, the TLS material and, for a seed connection, the credential record, all before any channel exists; it then opens one gRPC channel and calls GetVersion, which authenticates and records the version for the gates of section 4.8, and nothing else.
Test Connection runs `connect()` and then CheckHealth; a health failure after a good connect is reported as connected, with no health data.
`disconnect()` closes the channel and aborts a Load's progress poll.

### 2.4 The client, and why

The client is this repository's own, on `@grpc/grpc-js` 1.14.5 and `@grpc/proto-loader` 0.8.1, the pins the etcd provider already uses, so the provider adds no package.
The descriptor is generated from milvus-proto `go-api/v3.0.2` (commit `9e4f0ebc`), vendored under `proto/` with its licence and the SHA-256 of each file, and regenerated byte for byte by `node scripts/generate-milvus-descriptor.mjs`; it is never edited by hand.
The vendor SDK was set aside by measurement: its retry layer applied one insert twice, its telemetry sends the client's host name and error texts to the server, its global mode follows a server-named address with the token, and it adds 127 packages.
The client exposes exactly `getVersion`, `checkHealth`, `getMetricsSystemInfo`, `listDatabases`, `describeDatabase`, `showCollections`, `describeCollection`, `batchDescribeCollection`, `describeIndex`, `getLoadState`, `getLoadingProgress`, `getCollectionStatistics`, `showPartitions`, `listAliases`, `describeAlias`, `query`, `search`, `hybridSearch`, `loadCollection`, `releaseCollection` and `close()`.
It has no `Connect` call and no telemetry method, so Studio registers nothing with the server and reports nothing about the machine it runs on.
The channel sets `grpc.service_config_disable_resolution: 1`, the receive cap of section 5.6, `grpc.enable_http_proxy: 0`, `grpc.enable_retries: 0` and keepalive pings every 10 seconds with a 6-second timeout; no request is ever sent twice, and a Load or Release whose answer is lost reads "may have been applied".

## 3. Design decisions

### 3.1 Milvus's REST routes as the console, run over gRPC

The editor text is the form Milvus's REST reference documents, so a request can be pasted from it, and the provider lowers it to typed gRPC calls and never forwards the text anywhere.
gRPC is used because only its wire carries the raw bytes of JSON and dynamic fields, so integers above 2^53 stay exact, and because a cancel stops the server's search.
Where the result differs from what the REST endpoint would answer, section 5.4 says so.

### 3.2 Nothing loads implicitly

Browsing, describing, statistics, queries, counts, searches, the agent's walk and `inspect_schema` never call LoadCollection, LoadPartitions, Prewarm or a refresh load.
An unloaded collection is fully browsable, and a query, get, count or search on it answers:

Collection unloaded_big is not loaded (state NotLoad). Query, get, count and search need a loaded collection, and loading uses query-node memory that every client of this cluster shares. An admin can load it from Operations; Studio never loads a collection on its own.

### 3.3 No server-side function, ranker or inference, in any release

`functionScore`, `functionChains` and `searchAggregation` are refused by name on `entities/search` and `entities/hybrid_search`, and so is an `endpoint`, `url`, `provider` or credential-label key at any depth of `searchParams` and `rerank.params`, because the server would then send the candidates' text to that address.
Text query data is accepted only for a field a BM25 function produces; text aimed at a field an embedding function produces is refused, because the server would send the text to a third-party embedding provider on the cluster operator's key.
These refusals are permanent: promoting one is a new owner decision, not a measurement.
`rerank` takes `rrf` with `params.k` a number with 0 < k < 16384, or `weighted` with one weight in [0, 1] per sub-request, and nothing else; `norm_score` is refused until a measurement shows its effect.

### 3.4 The read-only mode

With `readOnly` on the connection or in an agent execution profile, Load and Release are refused before any request, with a sentence naming where the mode was set:

| Where the mode was set | Refusal |
|---|---|
| The operator's seed file | This connection is read-only (set in the operator's seed file). |
| A connection of the user's own | This connection is read-only: turn off Read-only in its settings to write. |
| An agent execution profile, on a connection that is not read-only | This run opens the connection read-only (agent execution profile). |

Every console request of this version is a read, so the mode changes nothing else.
The mode binds a `user` only on a managed seed whose secret only the seed holds, and only when the server has authorization enabled: Milvus with `authorizationEnabled: false`, its default, accepts any credential or none, so a connection that works proves nothing about the server, and Studio cannot tell.
Double the mode on the server with a Milvus role that holds `CollectionReadOnly` and `DatabaseReadOnly` and nothing more.

### 3.5 Machine access

MCP clients may be given a Milvus seed connection (`mcp: true`): `inspect_schema` and the agent's grounding carry names and types only, never a value, a vector, a default value, a function's parameters or a sampled key.
The provider implements no read-only query path, so agent execution and MCP `run_read_query` refuse Milvus, and plan mode drafts a request that a person runs.
No Milvus statement reaches an AI route: Explain is not offered, and the confirmation gate posts nothing to the query-safety analysis for a Milvus request.

### 3.6 Lossless integers

Every integer typed in a request reaches the wire with exactly its digits after a range check for the field it reaches, never through a JavaScript number, and an Int64 in a result is an exact decimal string.
`9223372036854775807` and `-9223372036854775808` round-trip; `9223372036854775808`, `abc`, `1.5`, ` 12`, `007`, `-0` and `+5` are refused before any request.

## 4. Connection

### 4.1 Configuration fields

| Field | Meaning |
|---|---|
| Host | A name or address, or a pasted http:// or https:// address such as a Zilliz Cloud endpoint, which is split into Host and Port. Port 9091 is Milvus's management port, which Studio never dials. |
| Port | `19530` by default; one port carries gRPC with TLS on or off |
| Database | Optional; empty means default. A dbName in a request body overrides it. |
| User | Optional. At most 32 characters, starting with a letter. Leave it empty to put a token in Password or token. |
| Password or token | Milvus receives the password or token on every call, so a password needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection. |
| SSL / TLS | The mode, the CA, and the client certificate and key |
| SSH Tunnel | A bastion that forwards the one endpoint |
| Read-only | Refuse Load and Release on this connection (section 3.4) |

The Host, Database, User and Password or token rows are the hints the connection dialog shows under each field.
A host that still carries a scheme when it reaches `connect()` is refused with "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS."

### 4.2 Authentication

With a User, Studio sends `user:password` in the `authorization` metadata of every call, base64-encoded as Milvus expects; with User empty, it sends the password as a token, which open-source Milvus reads as `user:password` and Zilliz Cloud as an API key.
A user name is at most 32 characters and starts with a letter; carriage returns, line feeds and NUL are refused in either field, and neither is ever echoed in an error, a log or an audit row.
The dialog warns before Test Connection when the credential is the documented default `root` pair, also when it is written as one token in Password or token with User empty:

> Credential warning: This is the documented default root credential every Milvus server starts with, and it stays valid until an administrator changes it, so anyone who knows Milvus can sign in with it. Change the root password on the server, or connect as a user of your own.

Studio never probes or changes the credential, and a read-only seed that uses it, or no password at all, is refused when the seed file loads and again after its references resolve ([SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md)).

### 4.3 TLS

The five SSL modes map one way onto grpc-js credentials and are never retried weaker: `disable` sends plaintext, `require` encrypts without verifying the certificate, `verify-system` verifies against the system's CAs, and `verify-ca` and `verify-full` against the pasted CA.
`require` sends the password to a peer whose certificate it does not verify.
A client certificate and key are both present or both absent; a certificate whose extended key usage lacks clientAuth, an expired one and a key that does not match it are refused before any channel, naming the reason.
An IP-literal host is verified against the IP in the certificate, and through an SSH tunnel the identity is the tunnel's far end, never its local forward.
Under Bun the server's TLS alert is not reported, so a refusal names the client certificate when one is configured.

### 4.4 One endpoint

Studio dials exactly the configured host and port: the gRPC target is built from the validated parts, no proxy variable is read, no address a server names is dialled, and node addresses in a GetMetrics answer are dropped.
A host named `unix`, `dns`, `ipv4` or `ipv6` is dialled as a DNS name, never as a resolver.
gRPC is outside the HTTP egress guard, as Kafka's and etcd's connections are.

### 4.5 SSH tunnel

Offered: the client dials only the one endpoint, so a tunnel forwards all of it, and the TLS identity is the tunnel's far end.

### 4.6 A password needs TLS off this machine

A password or token over no TLS is refused unless the host is a loopback address or `localhost`, or an SSH tunnel carries the connection, because Milvus receives it on every call:

> This connection would send its password without TLS to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS, connect through an SSH tunnel, or, if authentication is off on this server, clear the password.

### 4.7 Pasting an address

The Host box takes a pasted `http://` or `https://` address, such as a Zilliz Cloud endpoint, and splits it into Host and Port: an explicit port is kept as typed, 443 included, an address with no port takes the scheme's default, 80 or 443, and `https://` raises an SSL mode that is off to `verify-system` without lowering one that is on.
A user name or password, a path, a query string or a fragment in the address is refused by name.
The connection-string box is a different reader, and it reads `http://` and `https://` as ClickHouse, so paste a Milvus or Zilliz address into the Host box, never into the connection-string box.

### 4.8 Server versions

Tested against Milvus 3.0.2; other 3.0.x releases are expected to work and are not tested; 2.6 and older connect and are not tested.
A 2.6 server ignores a parameter it does not know and answers success, so Studio refuses what a server cannot do instead of inferring it from the answer:

| Feature | 3.0 | Before 3.0 | Studio |
|---|---|---|---|
| `orderByFields` | sorts, with an explicit limit | ignored | refused before 3.0, naming 3.0 |
| `groupByFields` | exists | absent | refused on every version |
| `functionScore`, `functionChains`, `searchAggregation` | exist | `functionScore` exists | refused on every version |
| `ids` on search | every key and vector type | an Int64 key and a dense field | no gate; a server without it answers an error |
| `range_filter` without `radius` | refused by the server | accepted | refused on every version |
| `query_mode=large_topk` | honoured | from 2.6.14 | refused on every version, as every key outside section 5.6's table is |

A server whose version Studio cannot read, or whose major is neither 2 nor 3, takes the pre-3.0 answer of every gate.
Milvus Lite's server mode and clusters are not claimed.

### 4.9 Trying Zilliz Cloud

Zilliz Cloud speaks the Milvus API and has not been tested with Studio.
To try it, paste the cluster endpoint into the Host box, or enter the host and port (19530 for Dedicated, 443 for Free and Serverless), choose `verify-system`, and put the API key in Password or token with User empty, or `db_admin` and its password.
Its gaps (no GetMetrics or GetReplicas, databases only on Dedicated) are found by the server's answer, never by the host name.
Prefer a cluster-scoped user or key to a project-wide key.
The claim waits for a test cluster to pass the provider's evidence gate (`docs/BACKLOG.md` D157).

### 4.10 A user who is not root

Lists are filtered by Milvus's grants: a database or collection list reads "visible to this user", never "none".
A search that names no metric and no search parameter runs without the IndexDetail privilege, and its score column says the metric is not readable; a request that names either needs IndexDetail, because its checks read the index.

## 5. Query interface

### 5.1 The request

One request per run: optional comment lines starting with `#`, then one line `POST /v2/vectordb/<route>` (`POST <route>` also works), then one JSON object.
The language the editor and the agent read is generated from the route table, so it cannot drift:

```text
A Milvus request, one per run: optional comment lines starting with #, then a line POST /v2/vectordb/<route> (POST <route> also works) naming one of databases/list, databases/describe, collections/list, collections/describe, collections/get_stats, collections/get_load_state, partitions/list, indexes/list, indexes/describe, aliases/list, aliases/describe, entities/query, entities/get, entities/search and entities/hybrid_search, then one JSON object with that route's Milvus REST v2 body keys, for example POST /v2/vectordb/entities/query {"collectionName": "docs", "filter": "year > 2020", "outputFields": ["title"], "limit": 10} or POST /v2/vectordb/entities/search {"collectionName": "docs", "annsField": "embedding", "data": [[0.1, 0.2]], "limit": 5}. Count rows with "outputFields": ["count(*)"] and no limit or offset. Filters are Milvus boolean expressions in the filter string. Query, get, count and search need a loaded collection. Not requests: writes, load, release, flush, compaction, users and roles, resource groups, snapshots and server-side functions.
```

| Route | Accepted keys |
|---|---|
| `databases/list` | none |
| `databases/describe` | `dbName` |
| `collections/list` | `dbName` |
| `collections/describe` | `dbName`, `collectionName` |
| `collections/get_stats` | `dbName`, `collectionName` |
| `collections/get_load_state` | `dbName`, `collectionName`, `partitionNames` |
| `partitions/list` | `dbName`, `collectionName` |
| `indexes/list` | `dbName`, `collectionName` |
| `indexes/describe` | `dbName`, `collectionName`, `indexName` |
| `aliases/list` | `dbName`, `collectionName` (optional) |
| `aliases/describe` | `dbName`, `aliasName` |
| `entities/query` | `dbName`, `collectionName`, `filter`, `outputFields`, `limit`, `offset`, `partitionNames`, `exprParams`, `consistencyLevel`, `orderByFields` (3.0 and later) |
| `entities/get` | `dbName`, `collectionName`, `id`, `outputFields`, `partitionNames`, `consistencyLevel` |
| `entities/search` | `dbName`, `collectionName`, `data` or `ids`, `annsField`, `filter`, `limit`, `offset`, `outputFields`, `searchParams`, `partitionNames`, `exprParams`, `consistencyLevel`, `groupingField`, `groupSize`, `strictGroupSize` |
| `entities/hybrid_search` | `dbName`, `collectionName`, `search`, `rerank`, `limit`, `offset`, `outputFields`, `partitionNames`, `consistencyLevel`, `groupingField`, `groupSize`, `strictGroupSize` |

A hybrid sub-request in `search` takes `annsField`, `data`, `filter`, `exprParams`, `limit`, `params` and `metricType`, and every sub-request's `data` has the request's length.
An unknown key is refused by name, at every level, although the server would drop it silently.
`collections/load`, `collections/release` and `collections/refresh_load` are refused with a sentence pointing at Admin > Operations; every other documented route (writes, schema changes, flush, compaction, users and roles, resource groups, snapshots and the rest) is refused with the list above.
A body takes no `//` comment (`docs/BACKLOG.md` D158).

### 5.2 Request rules

- An absent `dbName` means the connection's database, else `default`; a `dbName` in the body overrides the connection's database, so the field is a default and not a boundary.
- A collection, alias or database name matches `^[A-Za-z_][A-Za-z0-9_]{0,254}$` exactly; a field name is resolved against a fresh describe of the collection, `$meta` reads every dynamic key, and a dynamic key is projected bare.
- An absent `limit` is sent as 100; `limit: 0` is refused, because REST reads it as unlimited; a query always carries a limit.
- An exact count is `"outputFields": ["count(*)"]` with no `limit` and no `offset`, which are refused; Milvus itself answers a limit with "count entities with pagination is not allowed" and ignores an offset alone.
- An absent `outputFields` is the primary key, every scalar field and the dynamic field, never a vector; name a vector field or `"*"` to see vectors.
- Every query vector is checked against the field's type and dimension from a fresh describe before the search is sent, because a wrong placeholder costs seconds of server retries.
- `ids` and `data` are exclusive on a search; at most 10 ids, no duplicates, and `annsField` is always explicit.
- On a partition-key collection, `partitionNames` is refused naming the key field.
- `groupSize` is an integer from 1 to 10 and needs `groupingField`; `strictGroupSize` is a JSON boolean.
- Consistency is `Strong`, `Bounded` or `Eventually`; `Session` and `Customized` are refused.
  Bounded may miss a write from the last moments (about 300 ms on an idle standalone, at most `common.gracefulTime`, 5 s by default), and a search by id inherits the request's consistency.
- Ids and `exprParams` integers go through Milvus's expression templates, never into the filter text; `exprParams` takes at most 32 keys, each a scalar or an array of at most 1,000 scalars.
- The filter is Milvus's own expression, which the server parses and type-checks; every filter of one request together is at most 64 KiB.
- Every search parameter is checked per index type before the request is sent, and every key outside the table of section 5.6 is refused by name although the server ignores it.

### 5.3 Examples

```text
POST /v2/vectordb/collections/list
{"dbName": "default"}
```

```text
POST /v2/vectordb/entities/query
{"collectionName": "docs_int64", "filter": "seq >= 10 and title like \"doc 001%\"",
 "outputFields": ["id", "seq", "title", "tags", "big_int"], "limit": 5}
```

```text
POST /v2/vectordb/entities/query
{"collectionName": "docs_int64", "filter": "maybe_count is null", "outputFields": ["count(*)"]}
```

```text
POST entities/get
{"collectionName": "docs_varchar", "id": ["vc-0001", "vc-0002"], "outputFields": ["pk", "label"]}
```

```text
# nearest neighbours of a unit vector, filtered by seq
POST /v2/vectordb/entities/search
{"collectionName": "docs_int64", "annsField": "vec",
 "data": [[0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338]],
 "filter": "seq >= 100", "searchParams": {"params": {"ef": 64}}, "outputFields": ["seq", "title"], "limit": 5}
```

```text
POST /v2/vectordb/entities/search
{"collectionName": "fts", "annsField": "text_sparse", "data": ["vector index"], "outputFields": ["id", "text"], "limit": 5}
```

```text
POST /v2/vectordb/entities/hybrid_search
{"collectionName": "docs_varchar",
 "search": [{"annsField": "f16", "data": [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]], "limit": 10},
            {"annsField": "sparse", "data": [{"17": 0.4, "230": 0.2}], "limit": 10}],
 "rerank": {"strategy": "rrf", "params": {"k": 60}}, "outputFields": ["pk", "label"], "limit": 5}
```

```text
POST /v2/vectordb/entities/search
{"collectionName": "docs_varchar", "annsField": "f16", "ids": ["vc-0000", "vc-0001"], "outputFields": ["pk", "label"], "limit": 3}
```

```text
POST /v2/vectordb/entities/search
{"collectionName": "docs_varchar", "annsField": "f16", "data": [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]],
 "groupingField": "label", "groupSize": 1, "outputFields": ["pk", "label"], "limit": 4}
```

### 5.4 Where the console differs from a REST call

| Behaviour | REST v2 | Studio |
|---|---|---|
| `limit` absent, except a lone count | 100 rows | 100 rows, sent explicitly |
| `limit` or `offset` on a lone `count(*)` | dropped or ignored | refused before the request |
| `limit: 0` | unlimited for a query | refused |
| `outputFields` absent | every field, vectors included | scalar and dynamic fields only |
| An unknown key | dropped | refused by name |
| A 3.0-only key on an older server | dropped | refused naming the version |
| `dbName` absent | `default` | the connection's database |
| Integers above 2^53 in the dynamic field or a JSON field | lost, or a nested JSON string | exact |
| Float16, bfloat16, binary and Int8 vectors in results | base64 | numbers and byte arrays |
| Array fields | the raw protobuf structure | arrays |
| `entities/get` by a VarChar id holding a quote | differs from Studio on 3.0.2 | one template value, matched exactly |
| A non-finite score | an empty body | `"Infinity"` with a warning |
| `functionScore`, `functionChains`, `searchAggregation` | accepted | refused in every release |
| `rerank.strategy` other than `rrf` and `weighted` | an error from the server | refused before the request |
| Text data on an embedding-function field | sent to the embedding provider | refused |
| Consistency `Session`, `Customized` | accepted | refused |
| The bounds of section 5.6 | the server's wider limits | refused past them |
| `collections/list` order | REST's order | gRPC's order |
| The response | the REST envelope | the result grid |

### 5.5 Result shape

Rows are built in the collection's field order, never in the order the server sends its columns.
Int64 values are exact decimal strings, JSON and dynamic values are parsed with integers above 2^53 kept exact (with a warning naming the fields), and a VarChar or Text cell is cut at 65,536 UTF-16 code units with a visible marker.
Each float vector element is the shortest decimal that reads back as the same float32, so a copied vector searches exactly as stored; float16, bfloat16 and Int8 vectors are numbers, a binary vector is `dimension / 8` bytes, and a sparse vector is Milvus's own map of index to value.
Every vector column is declared to the grid, which draws it as a vector cell with its dimension.
A search's score is a `distance` column whose type names the metric and its direction, such as `Float, COSINE, higher is closer`; a non-finite score reads `"Infinity"`, `"-Infinity"` or `"NaN"` with one warning.
A search with more than one query vector or id starts with a `$query` column, and a grouped search carries the group value in `$group`.
A static field always wins its own name: a dynamic key of the same name is shown as `$meta.<key>` with a warning, and only `$meta["<key>"]` in a filter reaches the dynamic value.
Decimal, Date, Time and Mol columns are shown empty with a warning, and an unknown type reads "unsupported type N".

### 5.6 Bounds

| Bound | Value |
|---|---|
| Console text | 1,048,576 bytes of UTF-8, checked first, in the browser and on the server |
| Default page | 100 rows, sent explicitly; a lone `count(*)` carries none |
| Rows per query or get | 1 to 1,000 |
| Query window | `offset` plus `limit` at most 16,384 |
| Search | `nq` at most 10, `limit` at most 1,024, and `nq` times (`offset` plus `limit`) times the group size at most 10,240 |
| Hybrid search | at most 10 sub-requests of the same `nq`, and `nq` times the group size times (the sub-requests' limits plus the outer `offset` plus `limit`) at most 10,240 |
| Search parameters | per index type, each key in its own range: `nprobe` 1 to 65,536; `ef`, `reorder_k` and `search_list` at least `offset` plus `limit` and at most 65,536; `refine_k` 1 to 64; `drop_ratio_search` at least 0 and below 1; a key the index type does not take refused |
| Filter text | 65,536 bytes summed over every filter of one request |
| `exprParams` | 32 keys, each a scalar or an array of at most 1,000 scalars |
| Arrays | `entities/get` ids at most 1,000; search `ids` at most 10; `outputFields` at most 256; `partitionNames` at most 1,024 |
| String cells | 65,536 UTF-16 code units, cut with a marker |
| Result budget | 8,388,608 bytes, the rows past it dropped whole, with a warning |
| Receive cap | 16,777,216 bytes per answer; a query or get past it is asked again with half its limit |
| Deadlines | 10 s for a metadata route and 30 s for queries and searches, each at most the connection's query timeout |
| In flight | 4 calls per connection and 16 across every Milvus connection of this Studio process, with a queue of 64 |

At 1,536 dimensions a row with one vector is about 19 KB, so about 430 such rows fit the budget; vectors are left out of the default output, so a browse never meets it.

### 5.7 Cancellation and the confirmation gate

Cancel stops a running call and the server stops the search; a queued request leaves the queue and sends nothing.
The server keeps parsing a large filter after a cancel, which is why the filter bound is summed over the request.
The confirmation gate reads a Milvus request with the provider's own guard, so what asks and what runs are one parse: every request of this version reads, so none asks, and a request the guard refuses is refused in the editor, before anything is sent and with nothing written to history.

## 6. Schema introspection

### 6.1 The object surface

One container level, Database, from ListDatabases, and one kind, Collection, from one ShowCollections per database, names only.
Opening a collection reads DescribeCollection: a vector type is spelled with its dimension, `FloatVector(768)`, a BM25 function's output as `SparseFloatVector(BM25: text_bm25)`, and the tree shows the type before the parenthesis with the full text in the tooltip.
Partitions, aliases and indexes are details in the collection's Source, never tree objects, and the row count is never on the listing.

### 6.2 Object source

A collection's Source has two parts: `Schema`, in the vocabulary of the REST reference's create-collection request, and `State`, in the vocabulary of its describe answer, with the load state in Milvus's own words, the GetCollectionStatistics estimate labelled "estimate: flushed segments only, deletes not subtracted, may lag recent inserts", partitions and aliases.
A function's name, type and input and output fields are shown, and none of its parameters, which can carry a credential label or a service address.

### 6.3 Generated requests

A click on a collection runs `entities/query` with its database and name, an empty filter and a limit of 100; on an unloaded collection it answers the not-loaded sentence and never loads.
Generate Command writes a runnable search over the collection's first dense vector field with a probe vector of the right dimension, a comment naming the field, and a comment for each other vector field; a collection whose only vectors are sparse gets both forms as comments, and a BM25 output field a text search.
Generate Code, Profile, Generate Test Data, Generate Count Query and the SQL INSERT and DDL export formats are not offered.

### 6.4 Object edit (#789): nothing to write

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: this version writes no data (section 3.4).
The absence is `milvus`'s entry in `EXPECTED_EDIT_ABSTAINERS` (`tests/helpers/object-edit-expectation.ts`), and `tests/isolated/object-edit-declarations.test.ts` is what holds that entry and this section together.

## 7. Monitoring & health

Health is CheckHealth.
The overview gives the version and the selected database's collection count, "visible to this user".
The Tables tab and Admin > Operations list the first 200 collections of the selected database with GetCollectionStatistics' estimate:

The first 200 collections of the database. Row counts are server estimates of flushed segments and do not subtract deletes; POST entities/query with outputFields ["count(*)"] is exact on a loaded collection.

Index statistics carry each index's native type, `AUTOINDEX` as Milvus reports it, and cover only collections whose IndexDetail the user holds.
Slow queries and sessions are not offered, and the two panels say why:

> Milvus keeps query statistics on its management port 9091, which Studio does not dial

> Milvus reports client sessions on its management port 9091, which Studio does not dial

For performance, storage and query-node metrics, point a Prometheus server at Milvus's `:9091/metrics` and read it through the Prometheus provider.

## 8. Maintenance

Two controls of Admin > Operations, on each collection, for an admin, each audited with the Studio user, the Milvus user, the database and the collection:

| Operation | Label | Confirmation | Description |
|---|---|---|---|
| Load | "Load" | the preview, then a click | Loads the collection into query-node memory |
| Release | "Release" | the preview, then the collection's exact name | Every other client's search and query on this collection then fails with code 101 until it is loaded again. |

Load's preview shows the load state, the row estimate, each vector field with its index state, query-node memory used of total and the data loaded on query nodes, "as reported by the server, possibly several seconds old", with the load's cost estimated as about the raw data again in shared memory.
A collection with a vector field that has no index is refused before LoadCollection.
Load sends LoadCollection, then reads the progress every second for at most 10 seconds, and reports "Loaded" or "Loading N%, continues on the server"; one Load runs at a time on a connection, and a collection the server is still loading is refused until it reads Loaded.
A load the server continues after the 10 seconds is not covered by that lock.
Release asks for the collection's exact, case-sensitive name.
Both also need the Milvus user's own Load or Release privilege, which the server enforces; a lost answer reads "may have been applied" and is never sent again.

## 9. Capabilities & labels

`queryLanguage: "json"` with `queryDialect: "milvus"`, one container level labelled Database, the kind Collection, `defaultPort: 19530`, `enforcesReadOnly: true`, `supportsMaintenance: true` with `load` and `release`, and `false` or absent for explain, table creation, transactions, inline row edits, result pagination, external query limiting and connection strings.
The password field is labelled "Password or token".

## 10. Error handling

| Answer | What Studio says |
|---|---|
| gRPC 16 | Milvus refused the user name or password (or token), then the server's text |
| gRPC 7 | the Milvus user lacks the privilege, then the server's text naming it |
| gRPC 14, "Connection dropped" | the connection to Milvus was lost; run it again |
| A deadline, in any of its three shapes | the deadline of the call |
| gRPC 12 | not supported by this server version |
| Code 101 | the not-loaded sentence of section 3.2 |
| Code 1100 | the input sentence, then Milvus's text with the filter's line and column |
| Code 100, or success with `CollectionNotExists` | the collection does not exist in the database |
| Code 800 | the database does not exist |
| Code 2000, 2001 or 2099 | Milvus rejected the request on the query node, with no raw server text |
| A TLS handshake failure | the cause, or the client certificate under Bun |
| Any other code | Studio's sentence naming the code, then Milvus's text |

Studio's sentence comes first and the server's text after it; a server text that holds any form of the configured password or token is withheld whole.
Success is code 0 together with `Success`.

## 11. Testing

### 11.1 How the tests work

The unit tests drive each module through a recorded client, the integration test runs the real provider, codecs and error table over answers captured from Milvus 3.0.2 (`tests/fixtures/milvus/`), and the TLS tests run real handshakes under Bun and Node; nothing mocks a module.

### 11.2 Run it

```bash
bun tests/run-tests.ts tests/integration/db/milvus-provider.test.ts
bun run test
```

### 11.3 The live fixtures

`database-compose.yml` holds `milvus` (127.0.0.1:19530, authorization on, the management port as 127.0.0.1:19091), `milvus-tls` (19531) and `milvus-mtls` (19532) behind the `milvus-tls` profile, and the `milvus-seed` one-shot; [`docker/milvus/README.md`](../../docker/milvus/README.md) says how to start and seed them and what each collection is for.

### 11.4 The live check

`tests/live/milvus-live-check.ts` runs a real `MilvusProvider` against the fixtures on Node 24, Node 26 and Bun, and fails on any change outside its own collections, after the copy loop, the REST equivalence run, every refusal corpus, the telemetry check, Load and Release on a private copy and the search ceilings: `bun tests/live/milvus-live-check.ts --service milvus`.

## 12. Running Milvus for Studio

Keep the management port 9091 off the network: on 3.0.2 it answers without authentication, its metrics and its telemetry list included, and Studio never dials it.
Turn authorization on (`common.security.authorizationEnabled: true`) and change the default root password before anyone connects; with authorization off, any credential or none connects.
Give Studio's seeds a user of their own with `CollectionReadOnly` and `DatabaseReadOnly`, and the read-only mode on top.
Milvus's RBAC hides neither the topology nor other databases' row counts from an authenticated user, because GetMetrics needs no privilege.

## 13. Known limitations

- Vectors and payloads reach query history and saved queries, as every statement's text does.
- A filter's text is echoed in errors and in the Studio log.
- A load holds shared query-node memory until it is released, for every client of the cluster.
- Milvus RBAC hides neither the topology nor other databases' row counts from any authenticated user, since GetMetrics needs no privilege.
- A `dbName` in a body overrides the connection's database, so only Milvus RBAC on a user that is not root scopes a seed to one database.
- A seed's in-flight slots, queue and running requests are shared by every user of the seed, so any user who knows a run's id can cancel it, and the bound counts Studio's calls, not the server's work, which a large filter's parsing outlives.
- `readOnly` binds only on a managed seed whose secret only it holds, and only when the server has authorization enabled; Milvus with `authorizationEnabled: false`, its default, accepts any credential or none, so a connection that works proves nothing about the server and Studio cannot tell.
- TLS mode `require` sends the password to an unverified peer.
- gRPC, and every request the Milvus server itself makes, is outside the HTTP egress guard.
- REST `entities/get` and `entities/delete` by a VarChar id holding a quote differ from Studio's template on 3.0.2.
- A vendor address pasted into the connection-string box instead of the Host box still selects ClickHouse.
- Zilliz users should prefer a cluster-scoped user or key to a project-wide key; Zilliz Cloud is not tested (section 4.9).
- A hostile or impersonated endpoint holds the password it receives and can return it in an encoding Studio does not list, so Studio withholds only the forms it sends.
- The management port 9091 answers without authentication on 3.0.2, so the operator keeps it off the network.
- A load the server continues after Load's 10-second poll is not covered by the one-load lock.
- Clusters, Milvus Lite and 2.6 and older are not claimed.

## 14. References

- The design: the vector-family design under issue #424, sections 3 to 5.
- Milvus's REST v2 reference (`rest-summary-v3.0.x`) and the milvus-proto `go-api/v3.0.2` definitions.
- [`docker/milvus/README.md`](../../docker/milvus/README.md) and [`tests/fixtures/milvus/README.md`](../../tests/fixtures/milvus/README.md).
