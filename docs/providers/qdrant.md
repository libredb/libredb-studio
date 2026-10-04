# Qdrant Provider

The `qdrant` type-id: read-only vector database browsing and querying over Qdrant's REST API, tested and claimed on Qdrant 1.19.1.
Source: [`src/lib/db/providers/vector/qdrant/`](../../src/lib/db/providers/vector/qdrant/).
Tests: [`tests/unit/db/qdrant/`](../../tests/unit/db/qdrant/) and [`tests/integration/db/qdrant-provider.test.ts`](../../tests/integration/db/qdrant-provider.test.ts).
Tracking issue: [#424](https://github.com/libredb/libredb-studio/issues/424), with [#1089](https://github.com/libredb/libredb-studio/issues/1089).

## 1. Overview

Studio reads a Qdrant server through Qdrant's own REST requests, written in the editor as one `METHOD /path` line and one JSON body, the form Qdrant's documentation prints.
It browses collections with their vectors, payload indexes and a sampled view of payload keys, reads points by id, scrolls, counts and facets, and runs queries, batches and grouped queries over dense, sparse and multivector data.
It writes nothing: every request Studio sends is one of seventeen reads, and no maintenance operation exists for Qdrant.
It refuses every inference input except the local BM25 model, sends an API key without TLS only to this machine or through an SSH tunnel, warns about a JWT that declares no expiry or manage access, and shows MCP clients the schema and payload-index names alone.

### Concept mapping

| Qdrant | Studio |
|---|---|
| One server or cluster | One connection, with no database or container level |
| A collection | A row of Collections in the tree, opened in the Source tab |
| A point | A row of a result, its id, its vectors and its payload keys as columns |
| A named vector, a sparse vector, a multivector | A column `vector.<name>` (or `vector` for the unnamed one), drawn as a vector cell with its dimension |
| A payload index | An index of the collection, and a typed column |
| An alias | A name in the collection's Source and in `GET /aliases`, never a tree row |
| `GET /collections/{collection_name}` and the other read routes | One request per run in the editor |

## 2. Architecture

### 2.1 Where it sits

`QdrantProvider` extends `BaseDatabaseProvider` in the `vector` family, and every module talks to Qdrant only through the `QdrantClient` interface of `client.ts`, each through the slice of operations it sends.
`rest-client.ts` is the one file that builds a path, from the route table, over the shared `node:http(s)` transport (`src/lib/db/http/node-transport.ts`), so the client can build the seventeen read routes and nothing else.
`routes.ts`, the phase 0 half of `request.ts`, `guard.ts`, `generators.ts`, `labels.ts` and `type-spelling.ts` are pure and shipped to the browser, because the editor, the confirmation gate and the generators read them; everything else runs on the server only.

### 2.2 Modules

| File | What it owns |
|---|---|
| `client.ts` | The seam: `QdrantClient`, its operations, its request and answer types, and `QdrantError` |
| `rest-client.ts` | The only builder of paths, from the route table; the `api-key` header; the shared transport |
| `connection-options.ts` | The endpoint, the key, the plaintext rule, the TLS material, the tunnel's far end and the seed stage |
| `routes.ts` | The console's dialect and its seventeen routes, with their query keys and closed body schemas, the version gates and the refusal sentences |
| `request.ts`, `guard.ts` | A parsed request to a typed one (ids, vectors, the inference rule, budgets, gates), and the browser's verdict |
| `versions.ts`, `qdrant-vocabulary.ts`, `columns.ts` | The version gates, the vocabulary of distances, datatypes and scores, and the column-name rule |
| `schema.ts`, `sample.ts`, `type-spelling.ts` | Collection info to columns, indexes and vector fields, the payload sample, and the vector type text |
| `results.ts`, `execute.ts`, `errors.ts` | Answers to results, one request within its bounds, deadline and permit, and the one error table |
| `source.ts`, `objects.ts`, `generators.ts`, `labels.ts` | The Source, the object surface, the generated requests and the labels |
| `monitoring.ts`, `monitoring-reads.ts`, `index.ts` | The monitoring panels and the composition root |

### 2.3 Registration & lifecycle

The constructor validates nothing and opens nothing, so a provider built from any connection answers its capabilities and labels.
`connect()` checks the endpoint, the key and the TLS panel first, then sends exactly two requests: `GET /`, for the version the gates read, which proves reachability only, and `GET /collections`, the authenticated read every credential may make; it never sends a write-shaped request, `/cluster`, `/telemetry` or a manage-only read.
A `connect()` that resolves means the server answered an authenticated read, which an open server answers for any key or none, and never that the credential can do anything more.
`disconnect()` closes the connection's one keep-alive agent, which closes a socket left idle for 4 s on its own (section 3.3).
The transport never goes through an `http_proxy` or `https_proxy` variable and never follows a redirect: use an SSH tunnel to reach a private endpoint.

### 2.4 The client, and why

The client is Studio's own, a few hundred lines over the shared transport, and it adds no package.
The official `@qdrant/js-client-rest` was set aside after it was measured against the rules of sections 4.3, 4.4 and 3.6 on Node 24, Node 26 and Bun, which this provider keeps on all three: one endpoint, no redirect and no proxy, a CA per connection, and integers kept exact.
The gRPC port 6334 is not used: a gRPC client would take no per-connection CA and sit outside the HTTP egress guard.

## 3. Design decisions

### 3.1 Qdrant's REST requests as the console

The editor takes the requests Qdrant's own documentation and web console print, closed to seventeen read routes, `GET` and `POST`, and re-serialised from Studio's own parse rather than forwarded as typed.
Every body key is checked against the route's schema at every level it declares, the filter tree included, because Qdrant ignores an unknown key in silence: a misspelled `filter` returns unfiltered points.
Asked directly, outside Studio, Qdrant 1.19.1 refused `{"filter": {"must_nto": []}}` with HTTP 400: "Format error in JSON body: unknown field `must_nto`, expected one of `should`, `min_should`, `must`, `must_not`".
For a `must` condition beside a misspelled `rnage` it answered HTTP 200 with the points the condition matched, the misspelled range ignored.
Studio refuses both by name whatever the server does.

### 3.2 No server-side inference, in any release

Studio refuses every Qdrant inference object (a text, image or object input with a model) except the local BM25 model, in every release.
A request with such an input makes the Qdrant server call an inference service that the operator configured, passing the input, any request header ending in -api-key and the caller's identity; some hosted models are billed; and a statement could carry a third-party API key into query history.
Studio never sends these inputs, so the console cannot trigger that path.

The local BM25 model is `qdrant/bm25` or `bm25`, in lower case, with no `options` key, aimed at a sparse vector; any `options` key anywhere is refused.
No snapshot recover, upload or partial recover route is in the console.

### 3.3 Nothing is written

v1 runs reads only: no point, payload, vector, index, collection, alias, snapshot or cluster change is a route of the console, and each is refused by name, saying what v1 runs.
No read writes as a side effect: no index is created for a facet or an `order_by`, and `wait` and `ordering` are never sent.
Nothing is retried, so nothing is sent twice: a lost answer is reported as lost.
So that a request is not lost to the server's own keep-alive, the transport closes a pooled socket after 4 s idle, below Qdrant's 5 s keep-alive, which closed an idle socket 4.8 s after its answer when measured (#1419): measured on 2026-10-03/04 against Qdrant 1.19.1, requests separated by about 5 s of idle failed now and then with `ECONNRESET` (1 of 16 at 4.93 s pauses), because a request was written on a pooled socket as the server closed it.

### 3.4 The read-only mode

A Qdrant connection keeps a read-only mode (`READ_ONLY_ENFORCED`), set by the operator's seed file, on a connection of the user's own, or by an agent execution profile, and it refuses every route that is not a read and every maintenance operation before any request.
Every v1 route is a read and Qdrant has no maintenance operation, so the mode changes nothing a request can do today; it is the boundary a later write would meet.
A Qdrant server without `service.api_key`, its default, accepts any key or none, so on such a server the mode binds only the seeded connection, and a read-only seed with no key is refused (section 4.2).
A server-side boundary exists only when the key itself is read-only on the server.

### 3.5 Machine access

MCP is offered (`mcp: true`): `inspect_schema` carries collection names, vector names, sizes, distances and datatypes, sparse vector names, and payload-index field names and types, and its description says that other payload keys may exist.
It never carries payload values, vectors, collection `metadata`, strict-mode values or a sampled payload key.
Neither agent execution nor MCP `run_read_query` runs a request: agent execution and MCP `run_read_query` refuse Qdrant, because the provider implements no read-only query path for them.
No Qdrant request text reaches an AI route: there is no Explain, and the confirmation gate posts nothing for an analysis.

### 3.6 Lossless integers

Every integer typed in a request reaches the wire with exactly its digits, and every answer is parsed with integers above 2^53 kept as exact digits, so the ids `9007199254740993`, `2^63` and `18446744073709551615` read exactly those points.
A point id is written as a bare number from 0 to 18446744073709551615 or as a UUID string; an id written as a digit string is refused, because the server refuses it.
A range bound above 2^53 is sent with a warning that Qdrant compares range bounds as doubles.

## 4. Connection

### 4.1 Configuration fields

| Field | Rule |
|---|---|
| Host | A name or address, or a pasted http:// or https:// address such as http://localhost:6333, which is split into Host and Port. Studio dials this REST port only, never Qdrant's gRPC port 6334 or its cluster port 6335. |
| Port | `6333` by default, the REST port; ports 6334 and 6335 are never dialled |
| API key or JWT | Qdrant receives the API key or JWT on every request, so a key needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection. A read-only or collection-scoped key with an expiry is the safest choice. |

There is no User field and no Database box: Qdrant has no user name and no container level.
A non-empty user from a seed file or the API is refused when the connection opens, naming the field.
A collection or alias name in a request is refused before it reaches a path when it is empty, `.` or `..`, holds `/` or NUL, as written or once percent-decoded (so `%2e%2e` and `a%2fb` are refused too), or is longer than 255 characters; a vector name is refused when it holds one of `<`, `>`, `:`, `"`, `/`, `\`, `|`, `?`, `*`, NUL or U+001F, or is longer than 200 bytes.

### 4.2 Authentication

The API key or JWT travels as one `api-key` header on every request, never as `Authorization` as well and never in a URL; a key that holds CR, LF, NUL or a non-printable byte is refused naming the field.
Use a read-only key (`service.read_only_api_key`) or a JWT scoped to the collections you need, with an expiry: an admin key or a manage token reads, and outside Studio writes, everything the server holds.
The dialog reads a JWT locally, with no request and no signature check, and warns before Test Connection when it declares no expiry, manage access, or no access claim at all:

> Credential warning: This token declares no expiry, or manage access to the whole server, so it stays valid, and as powerful, until the server's key changes. Prefer a read-only or collection-scoped key with an expiry.

The sentence says what the token declares, never what the server granted, and names no claim value; an opaque key is never probed.
A read-only seed with no key is refused when the file loads, and again once its references resolve, because the mode would promise a boundary an open server does not keep:

> Credential warning: A Qdrant server without an API key, its default, accepts any key or none, so a read-only seed without a key promises a boundary the server does not keep.

### 4.3 TLS

The SSL panel maps one way and is never retried weaker: `require` encrypts without verifying the server's certificate, `verify-system` uses the runtime's roots, and `verify-ca` and `verify-full` use the CA you paste.
A client certificate and key are sent to a server that sets `verify_https_client_certificate`.
An IP address as the host is checked against the certificate's IP names, with no SNI.

### 4.4 One endpoint

Studio dials the host and port of the connection and nothing else: no proxy variable, no redirect, and no peer address a `/collections/{collection_name}/cluster` answer names, which is shown as data.
Every request goes through the HTTP egress guard (`DB_HTTP_BLOCK_PRIVATE_HOSTS`) when it is on.

### 4.5 SSH tunnel

A tunnel is offered; through it, the TLS identity is the tunnel's far end, never its local forward.

### 4.6 A key needs TLS off this machine

A key or JWT over no TLS is refused unless the host is a loopback address or `localhost`, or an SSH tunnel carries the connection, because Qdrant receives it on every request:

> This connection would send its API key without TLS to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS, connect through an SSH tunnel, or, if authentication is off on this server, clear the API key.

A server with no key at all opens anywhere.

### 4.7 Pasting an address

Paste Qdrant's own address, such as `http://localhost:6333` or a cloud endpoint's `https://` address, into the Host box: it is split into Host and Port, an explicit port kept as typed and an absent one read as 80 or 443, and `https://` raises SSL mode to `verify-system` without ever lowering it.
The connection-string box reads `http://` and `https://` as ClickHouse, so a Qdrant address pasted there selects ClickHouse.

### 4.8 Server versions

Tested against Qdrant 1.19.1 on Node 24.14.0, Node 26.10.0 and Bun 1.4.2; an older server connects and is not tested.
`GET /` gives the server's version when the connection opens, and a request key newer than the server is refused by name with the version it needs, because an older server ignores some of them and answers the others with an error that names no key:

| Key | Needs |
|---|---|
| `rrf.weights` | 1.17.0 |
| `relevance_feedback` | 1.17.0 |
| `params.idf` | 1.19.0 |
| `match.prefix` | 1.19.0 |
| the `slice` condition | 1.19.0 |
| formula `acosh`, `max`, `min` | 1.19.1 |

A server whose version is missing or not a plain `major.minor.patch` connects, and every gated key is refused naming the version it needs.
Clusters were not measured and are not claimed.

### 4.9 Trying Qdrant Cloud

Qdrant Cloud is not claimed until a test cluster passes gate 4 (D154 in `docs/BACKLOG.md`).
To try it, paste the cluster's `https://` endpoint into the Host box and its key into API key or JWT.
Its keys are JWTs with manage access to the whole cluster and an expiry of 90 days by default, and a key whose expiry is left empty never expires, which the dialog's warning names: prefer a read-only or collection-scoped key with an expiry.
Its strict mode answers "Limit exceeded", "Index required but not found", "Exact search disabled" and HTTP 429 with `Retry-After` in normal use; Studio shows each after its own sentence (section 10).

## 5. Query interface

### 5.1 The request

```text
A Qdrant request, one per run: optional comment lines starting with // or #, then a line METHOD /path naming one of GET /, GET /collections, GET /collections/{collection_name}, GET /collections/{collection_name}/exists, GET /aliases, GET /collections/{collection_name}/aliases, POST /collections/{collection_name}/points, GET /collections/{collection_name}/points/{id}, POST /collections/{collection_name}/points/scroll, POST /collections/{collection_name}/points/count, POST /collections/{collection_name}/facet, POST /collections/{collection_name}/points/query, POST /collections/{collection_name}/points/query/batch, POST /collections/{collection_name}/points/query/groups, GET /collections/{collection_name}/optimizations, GET /collections/{collection_name}/snapshots and GET /collections/{collection_name}/cluster, with every brace-enclosed segment replaced by a real name or id. GET routes take no body; POST routes take one JSON object with that route's Qdrant REST body, for example POST /collections/docs/points/query {"query": [0.1, 0.2], "using": "text", "filter": {"must": [{"key": "category", "match": {"value": "alpha"}}]}, "limit": 5}. Filters are Qdrant must, should and must_not trees. Ids are unsigned integers written as plain numbers, or UUID strings. Not requests: point and payload writes, vector and index changes, collection and alias changes, snapshot create, download, upload and recover, shard, peer and cluster changes, search/matrix, /telemetry and /metrics.
```

### 5.2 The routes

| Request line | Query keys | Body |
|---|---|---|
| `GET /` | none | none |
| `GET /collections` | none | none |
| `GET /collections/{collection_name}` | none | none |
| `GET /collections/{collection_name}/exists` | none | none |
| `GET /aliases` | none | none |
| `GET /collections/{collection_name}/aliases` | none | none |
| `POST /collections/{collection_name}/points` | `consistency`, `timeout` | required: `ids`; also `shard_key`, `with_payload`, `with_vector` |
| `GET /collections/{collection_name}/points/{id}` | `consistency`, `timeout` | none |
| `POST /collections/{collection_name}/points/scroll` | `consistency`, `timeout` | optional: `filter`, `limit`, `offset`, `order_by`, `shard_key`, `with_payload`, `with_vector` |
| `POST /collections/{collection_name}/points/count` | `consistency`, `timeout` | optional: `exact`, `filter`, `shard_key` |
| `POST /collections/{collection_name}/facet` | `consistency`, `timeout` | required: `key`; also `exact`, `filter`, `limit`, `shard_key` |
| `POST /collections/{collection_name}/points/query` | `consistency`, `timeout` | optional: `filter`, `limit`, `lookup_from`, `offset`, `params`, `prefetch`, `query`, `score_threshold`, `shard_key`, `using`, `with_payload`, `with_vector` |
| `POST /collections/{collection_name}/points/query/batch` | `consistency`, `timeout` | required: `searches`, each a query body |
| `POST /collections/{collection_name}/points/query/groups` | `consistency`, `timeout` | required: `group_by`; also `filter`, `group_size`, `limit`, `lookup_from`, `params`, `prefetch`, `query`, `score_threshold`, `shard_key`, `using`, `with_lookup`, `with_payload`, `with_vector` |
| `GET /collections/{collection_name}/optimizations` | `with`, `completed_limit` | none |
| `GET /collections/{collection_name}/snapshots` | none | none |
| `GET /collections/{collection_name}/cluster` | none | none |

`consistency` takes a positive integer, `majority`, `quorum` or `all`; `timeout` a positive integer; `with` a comma-separated list of `queued`, `completed` and `idle_segments`; `completed_limit` a positive integer.
An optional body may be left out; a required one, or a missing required key, is refused by name.
Every other Qdrant route is refused, naming what v1 runs, and `PUT`, `DELETE` and `PATCH` are refused by the method set.

### 5.3 Request rules

- `limit` absent on a query, a scroll or a facet is sent as 10, and on query groups as 10 with `group_size` 3; `exact` absent on a count is sent as `true`; each is the server's own default, sent explicitly.
- A query vector is checked against the collection the request names, read once for that request: the `using` name exists, a dense vector has the declared size and fits its datatype (float16 within 65,504, uint8 integers from 0 to 255), a multivector's rows each have the declared size, and a sparse vector's indices fit 32 bits; a `null` element is refused by name.
- The numbers of a dense or multivector query are written as doubles, `1.0` for a typed `1`, because Qdrant reads a two-row array of integers as a sparse pair.
- No request creates an index or a collection.

### 5.4 Examples

```text
GET /collections
```

```text
GET /collections/docs/points/42
```

```text
POST /collections/docs/points/scroll
{"filter": {"must": [{"key": "category", "match": {"value": "alpha"}}]}, "limit": 1, "with_payload": true, "with_vector": false}
```

```text
POST /collections/plain/points/query?consistency=majority
{"query": [0.2, 0.1, 0.9, 0.7], "filter": {"must": [{"key": "city", "match": {"value": "London"}}]}, "params": {"hnsw_ef": 128, "exact": false}, "limit": 3}
```

```text
POST /collections/docs/points/query
{"query": {"indices": [1, 3, 5, 7], "values": [0.1, 0.2, 0.3, 0.4]}, "using": "keywords"}
```

```text
POST /collections/docs/points/count
{"filter": {"must": [{"key": "category", "match": {"value": "alpha"}}]}, "exact": true}
```

```text
POST /collections/docs/points/query
{"query": {"text": "vector search", "model": "qdrant/bm25"}, "using": "keywords", "limit": 5, "with_payload": true}
```

```text
POST /collections/docs/points/query/batch
{"searches": [{"query": 42, "using": "text", "limit": 3}, {"query": 42, "using": "image", "limit": 3}]}
```

```text
POST /collections/docs/points/query/groups
{"query": 42, "using": "text", "group_by": "category", "group_size": 2, "limit": 3}
```

```text
// two titles from a scroll
POST /collections/docs/points/scroll
{
    "limit": 2, // two points
    "with_payload": ["title"]
}
```

### 5.5 Where the console differs from a REST call

| Behaviour | REST | Studio |
|---|---|---|
| `limit` absent on query or scroll | 10 | 10, sent explicitly |
| `exact` absent on a count | exact | `true`, sent explicitly |
| `//` comments in the body | refused | read out by the lexer |
| An unknown key | ignored | refused by name |
| A key newer than the server | ignored, or an error that names no key | refused naming the version |
| An id written as a digit string | refused | refused with a sentence |
| Integers above 2^53 | exact in the JSON | exact in the grid |
| An inference object other than local BM25 | sent to the inference service | refused |
| A two-row integral multivector query | read as a sparse pair and refused | written as doubles |
| `next_page_offset` | a body field | a warning with the exact id |
| `timeout` | absent unless given | the remaining deadline, in whole seconds, on the 8 routes that take it |
| `limit` 100,000,000 | accepted | refused past the bounds of section 5.7 |
| `{"query": {"sample": "random"}}` | a random sample | the same |

### 5.6 Result shape

A point is a row: `id` (a uint64 as exact digits, or a UUID), `score` where the route ranks, one column per vector (`vector` for the unnamed one, `vector.<name>` for each named one), then the payload's top-level keys in first-seen order, a nested object as one JSON cell.
A vector cell shows its first elements and its dimension, and Copy Cell copies the whole vector in Qdrant's own encoding, so a copied cell is valid query data: dense as numbers, multivector as rows, sparse as `{indices, values}`.
A Cosine vector reads back normalised, so its type says "stored normalised" and the cell never claims that stored equals input; a `turbo4` vector is a 4-bit reconstruction, and a notice says so; a float16 element that overflowed is `null`.
A payload key is renamed only when it would collide with an engine column or with one Studio adds: `id` becomes `payload.id`, and a warning lists the renames; filters still take the original key, which the Source shows beside a renamed column.
A batch's rows carry `$search`, the 0-based index of their search; a grouped query's rows carry `$group`, and with `with_lookup` the first row of each group carries `$lookup`; a facet answers `value` and `count`.
The score column says what its numbers mean for the search that produced them: higher or lower is better by the vector's distance, `fused` for a fusion, `computed` for a formula, a recommendation or a discovery, and `unranked` for a scroll or a sample; a score the server prints as `null` reads "not finite", with a warning.
A scroll whose answer holds `next_page_offset` carries a warning with that exact id: repeat the request with it as the body's `offset`.

### 5.7 Bounds

| Bound | Value |
|---|---|
| Console text and parser | 1,048,576 bytes of UTF-8; depth 32, 4,096 nodes, 262,144 numeric leaves, 32,768 scalar leaves |
| Rows | at most 1,000: a query or scroll by `limit`, a retrieve by its id count, a batch by the sum of its searches' limits, query groups by `limit` times `group_size` |
| Batch and prefetch | at most 10 searches; prefetch at most 2 deep, 4 entries per list and 10 prefetch nodes in the whole request |
| Candidates | at most 10,000: the sum over every query node of offset plus limit, times the quantization oversampling; `hnsw_ef` at most 1,024, oversampling at most 8.0, MMR's `candidates_limit` at most 1,024 |
| Facet | `limit` at most 1,000 |
| Filter | 65,536 bytes; at most 256 conditions; `nested` at most 4 deep; `match.any`, `match.except` and `has_id` lists at most 10,000 entries |
| Formula | at most 12 deep and 128 nodes |
| Vectors | a dense size from 1 to 65,536; a multivector's rows times size below 1,048,576 |
| Transport cap | 16,777,216 bytes per answer; past it the connection is closed, no row is kept, and the error names the cap, the request's `limit` and the vectors it asked for |
| Result budget | 8,388,608 bytes of converted rows, rows dropped whole past it, with a warning |
| String values | 65,536 UTF-16 code units, cut with a visible marker and one warning |
| Payload sample | 1,000 points without vectors |
| In flight | 4 requests per connection and 16 per server in this process, with a queue of 64 |

No request is refused for its expected size: 1,000 points with every vector are about 6.5 MB at the seeded 384 dimensions and about 19 MB at 1,536, so ask for the vectors you need, or none, with `with_vector`.

### 5.8 Time, cancellation and the confirmation gate

A request has one deadline, fixed when it arrives, 10 seconds for a metadata route and 30 for a point read or query, each at most the connection's query timeout, shared by its wait for a slot, its collection read and its call.
On the eight routes that take `timeout`, Studio sends the remaining deadline in whole seconds, less one, at least 1, and a `timeout` you type is clamped to it.
Stop cancels the request in Studio and on the socket; the server stops a scroll, a facet, a query and a grouped query within a fifth of a second of its timeout, but an exact count keeps working after its timeout, and after a cancel, until it completes, so add `"exact": false` to a slow count.
The confirmation gate asks about nothing, because every request reads, and it never sends a Qdrant request for an AI analysis.

## 6. Schema introspection

### 6.1 The object surface

Collections are the one kind, listed by `GET /collections` with no row count, and labelled as visible to this credential.
A collection's columns are its `id`, its vectors with their type (`Dense(384, float32, Cosine; stored normalised)`, `Sparse(idf)`, `Multi(16, float32, Dot, max_sim)`), its payload-index fields typed by their index, and the top-level keys of the payload sample, marked sampled.
Its indexes are its payload indexes and one per vector, whose kind comes from its HNSW configuration: `hnsw`, `flat` when the graph is off, and `opaque` for per-tenant graphs only and for a sparse vector.
No collections are visible to this credential when the tree is empty: a server with no collection, a token scoped to other collections and a token granted only an alias all answer an empty list.
An alias is never resolved and never a tree row: a credential scoped to an alias can still open it by name in the console, because no listing returns its name.

### 6.2 Object source

The Source has two parts: `Schema`, the collection's configuration in Qdrant's create-collection vocabulary, and `State`, its status, `optimizer_status`, its `points_count` labelled an estimate, its indexed vector count, its aliases, its snapshot list, its optimizations, its cluster information and its `metadata`, shown as data.
It is six reads: the collection, its aliases, its snapshots, its optimizations, its cluster information and its own payload sample; no snapshot is ever downloaded.
Where the server reports a `memory` tier beside the deprecated `on_disk` flags, the Source shows `memory` and marks the flags deprecated.

### 6.3 Object edit (#789): nothing to write

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: v1 reads only (section 3.3).
The absence is `qdrant`'s entry in `EXPECTED_EDIT_ABSTAINERS` (`tests/helpers/object-edit-expectation.ts`), and `tests/isolated/object-edit-declarations.test.ts` is what holds that entry and this section together.

### 6.4 The payload sample

Qdrant declares no schema for payloads, so the tree and the Source sample 1,000 points without vectors, read uniformly by id with a `slice` filter on 1.19.0 and later, and the first points by id on an older server, which the Source says.
A payload index's type wins for an indexed key; integer and float are one numeric family, because a whole float written from JavaScript is stored as an integer; `null` makes a field nullable; two or more families make it `mixed`, with a notice.
1,000 points find a key present on 1 percent of points with a probability above 0.9999, and one present on 0.1 percent with a probability of about 0.63; the Source states the sample size beside the sampled fields.
A collection with no points is not sampled.

### 6.5 Generated requests

A click on a collection runs `POST /collections/<name>/points/scroll` with `{"limit": 100, "with_payload": true, "with_vector": false}`.
Generate Command writes, without running it, a query over the collection's first dense vector with a probe vector, a comment naming the vector and its type, `using` for a named vector, and one comment line for every other vector; Generate Code, Profile and Generate Count Query are not offered, and a count is the documented count request.

## 7. Monitoring & health

Health is `GET /`, reachability only.
The overview gives the version, the number of collections visible to this credential and the number of payload and vector indexes; the Tables tab carries this caption:
The first 200 collections. Point counts are Qdrant's approximate points_count; POST /collections/{collection_name}/points/count with "exact": true is exact.
Slow queries are not read:

> Qdrant keeps slow requests behind a manage-only route that returns other clients' request bodies, which Studio does not read.

Sessions, performance and storage are not read either:

> Qdrant does not report client sessions over the routes Studio reads. For sessions, performance and storage, connect Studio to a Prometheus server that scrapes Qdrant's /metrics.

Studio never reads `/telemetry`, `/metrics`, `/profiler`, `/debugger`, `/stacktrace`, `/logger`, `/issues`, `/audit/logs` or a snapshot download.

## 8. Maintenance

None: Qdrant has no maintenance operation in v1, so no Admin > Operations card and no tree control is offered for it.

## 9. Capabilities & labels

`queryLanguage: "json"` with `queryDialect: "qdrant"`, `containerLevels: []`, `defaultPort: 6333`, `enforcesReadOnly: true`, `statementTerminator: "none"`, and `false` for explain, table creation, transactions, inline row edits, result pagination, external query limiting, maintenance and the connection string.
A collection is labelled "Collection"; the password field "API key or JWT"; the export menu offers no SQL INSERT or DDL for a Qdrant result.

## 10. Error handling

| Answer | What Studio says |
|---|---|
| 401 | Qdrant refused the API key or JWT, then the server's text |
| 403 `ExpiredSignature` | the JWT has expired |
| 403 `InvalidSignature` | the JWT's signature does not match this server's key |
| other 403 | the credential is not allowed to list collections, or, after connect, to run this request, then the server's text |
| 404 on a collection | the collection does not exist or is not visible to this credential |
| 400 or 422 on a body | the input sentence, then the server's text, which may not name the bad key |
| 400 strict mode | Studio's sentence, then the server's text verbatim; "Exact search disabled" adds the hint `"exact": false` |
| 429 | Qdrant rate-limited the request, with the wait it asked for when it gave one; never retried |
| a timeout | the timeout sentence, without the server's elapsed figure; on an exact count, the limit of section 5.8 |

Every server text is shown after Studio's sentence, and a text that holds any form of the key or the JWT is withheld whole.
Neither the key, the JWT nor any of its three parts reaches an error, a result, a log line, an audit row or a notice.

## 11. Testing

### 11.1 How the tests work

The unit tests drive each module through a recording client, and the integration test drives the provider over the real REST client with answers captured from Qdrant 1.19.1 (`tests/fixtures/qdrant/`, `tests/fixtures/qdrant-surface/` and `tests/fixtures/vector/qdrant/`), with no module mock; the route table is checked against the OpenAPI document Qdrant published at that tag, by its SHA-256.

### 11.2 Run it

```bash
bun tests/run-tests.ts tests/integration/db/qdrant-provider.test.ts
bun run test
```

### 11.3 The live fixtures

`database-compose.yml` holds `qdrant` (127.0.0.1:6333, no key), `qdrant-auth` (6343, an admin key, a read-only key and JWT RBAC), `qdrant-tls` (6353) and `qdrant-mtls` (6363, with a client certificate); [`docker/qdrant/README.md`](../../docker/qdrant/README.md) says how to start, seed and key them and what each collection is for.

### 11.4 The live check

`tests/live/qdrant-live-check.ts` runs a real `QdrantProvider` against the fixtures of section 11.3 on Node 24, Node 26 and Bun, and fails on any change it made outside its own collections, after running every example of section 5.4, the copy loop of every vector type and every refusal corpus; an inference listener and a snapshot-URL listener answer a positive control and must then receive nothing from Studio.
It runs by hand, with the keys copied out as `docker/qdrant/README.md` shows: `bun tests/live/qdrant-live-check.ts --keys <dir>`.

## 12. Running Qdrant for Studio

Give Studio a read-only key (`service.read_only_api_key`), or, with `service.jwt_rbac` on, a JWT that grants read access to the collections it should see and carries an expiry; keep the admin key out of Studio.
Serve REST over TLS (`service.enable_tls`) whenever Studio is not on the same machine.
Set `telemetry_disabled` if the server should not report to the vendor, and note that the server logs every request's path and query string.

## 13. Known limitations

- Vectors and payloads reach query history and saved queries, as every statement's text does.
- Any read credential can download whole snapshots and read the server's telemetry outside Studio.
- A collection-scoped token with write access can delete a named vector from every point of its collection outside Studio.
- The Qdrant server logs every request's path and query string, so collection names appear in its log.
- A stopped query runs on the server until its server timeout, and an exact count runs past it until it completes.
- A seed's in-flight slots, queue and running requests are shared by every user of the seed, so any user who knows a run's id can cancel it.
- Studio cannot tell what an opaque key can do: `readOnly` is enforced by Studio whatever the key, and a server-side boundary exists only when the key itself is read-only on the server.
- A Qdrant server without `service.api_key`, its default, accepts any key or none, so it has no boundary at all.
  Prefer a read-only or collection-scoped key, or a JWT with an expiry.
- The server's own egress, its inference calls and its snapshot recovery included, is outside the HTTP egress guard.
- TLS mode `require` sends the API key to an unverified peer.
- An empty tree is what a scoped token, an alias-only token and an empty server all produce.
- A vendor address pasted into the connection-string box instead of the Host box still selects ClickHouse.
- A hostile or impersonated endpoint holds the key it receives and can return it in an encoding Studio does not list, so Studio withholds only the forms it sends.

## 14. References

- The design: the vector-family design under issue #424, sections 3, 4 and 6.
- Qdrant's REST API reference and its OpenAPI document at tag 1.19.1, and its security guide.
- [`docker/qdrant/README.md`](../../docker/qdrant/README.md) and [`tests/fixtures/vector/README.md`](../../tests/fixtures/vector/README.md).
