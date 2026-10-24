# Weaviate Provider

The `weaviate` type-id: read-only vector database browsing and searching over Weaviate's REST API, and over GraphQL for the searches of a server older than 1.39.7, tested on Weaviate 1.40.2, 1.38.22 and 1.37.4.
Source: [`src/lib/db/providers/vector/weaviate/`](../../src/lib/db/providers/vector/weaviate/).
Tests: [`tests/unit/db/weaviate/`](../../tests/unit/db/weaviate/) and [`tests/integration/db/weaviate-provider.test.ts`](../../tests/integration/db/weaviate-provider.test.ts).
Tracking issue: [#1566](https://github.com/libredb/libredb-studio/issues/1566), with [#1089](https://github.com/libredb/libredb-studio/issues/1089) and [#424](https://github.com/libredb/libredb-studio/issues/424).

## 1. Overview

Studio reads a Weaviate server through Weaviate's own REST requests, written in the editor as one `METHOD /v1/path` line and one JSON body, the form Weaviate's REST reference prints.
It browses collections with their properties and vectors, lists and reads objects, and runs BM25, hybrid, near-vector and near-object searches and aggregate counts, written in the REST search shape on every server and run over REST or GraphQL as the server's version decides.
It writes nothing: every request Studio sends is a read, and no maintenance operation exists for Weaviate.
It sends no text to a model: the searches that embed text on the server are refused before anything is sent, which a listener behind a vectorizer module confirms (section 3.2).
It never wakes a cold tenant, and it sends an API key without TLS only to this machine or through an SSH tunnel.

### Concept mapping

| Weaviate | Studio |
|---|---|
| One server or cluster | One connection, with no database or container level |
| A collection (class) | A row of Collections in the tree, opened in the Source tab |
| An object | A row of a result: `$id`, its properties, and with `include=vector` its vectors |
| The unnamed vector, a named vector | A column `$vector` or `$vector.<name>`, typed `Vector(dimension, distance, index)` |
| A tenant of a multi-tenant collection | A name and activity status in the collection's Source, never a tree row |
| An alias | A name in its collection's Source and in `GET /v1/aliases`, never a tree row |
| A REST read or search route | One request per run in the editor |

Tenants and aliases follow the precedent of Milvus's partitions and Qdrant's aliases: a detail of the collection, in its Source and in the console, because a tenant belongs to one collection and a collection may hold hundreds of thousands of them.

## 2. Architecture

### 2.1 Where it sits

`WeaviateProvider` extends `BaseDatabaseProvider` in the `vector` family, and every module talks to Weaviate only through the `WeaviateClient` interface of `client.ts`, each through the slice of operations it sends.
`rest-client.ts` is the one file that builds a path, from the route table, over the shared `node:http(s)` transport (`src/lib/db/http/node-transport.ts`), so the client can build the console's read routes, the readiness probe and the GraphQL read, and nothing else.
`graphql.ts` is the one producer of GraphQL text.
`routes.ts`, the phase 0 half of `request.ts`, `guard.ts`, `generators.ts` and `labels.ts` are pure and shipped to the browser, because the editor, the confirmation gate and the generators read them; everything else runs on the server only.

### 2.2 Modules

| File | What it owns |
|---|---|
| `client.ts` | The seam: `WeaviateClient`, its operations, its request and answer types, and `WeaviateError` |
| `rest-client.ts` | The only builder of paths, from the route table; the `Authorization` header; the shared transport |
| `connection-options.ts` | The endpoint, the token, the plaintext rule, the TLS material, the tunnel's far end and the seed stage |
| `routes.ts` | The console's dialect and its seventeen routes, their query keys and closed body schemas, the refused keys and the refusal sentences |
| `request.ts`, `guard.ts` | A parsed request to a typed one (names, the where filter, the inference rule, bounds), the search model, and the browser's verdict |
| `versions.ts` | The version `GET /v1/meta` reports and the table that picks REST or GraphQL |
| `graphql.ts` | The REST and GraphQL encoders of one search model, and the GraphQL builder |
| `schema.ts` | A class definition to columns, vectors, the GraphQL selection and the facts a request reads |
| `results.ts`, `execute.ts`, `errors.ts` | Answers to results, one request within its bounds, deadline and permit, the tenant guard, and the one error table |
| `source.ts`, `objects.ts`, `generators.ts`, `labels.ts` | The Source, the object surface, the generated requests and the labels |
| `monitoring.ts`, `monitoring-reads.ts`, `index.ts` | The monitoring panels and the composition root |

### 2.3 Registration & lifecycle

The constructor validates nothing and opens nothing, so a provider built from any connection answers its capabilities and labels.
`connect()` checks the endpoint, the token and the TLS panel first, then sends exactly one request, `GET /v1/meta`, which authenticates (a server with anonymous access off answers 401 without a key) and gives the version the path table reads.
A server older than 1.37 connects, with one warning that it is below the supported range.
`disconnect()` closes the connection's one keep-alive agent, which closes a socket left idle for 4 s on its own, below Weaviate's 10 s idle close.
The transport never goes through an `http_proxy` or `https_proxy` variable and never follows a redirect: use an SSH tunnel to reach a private endpoint.

### 2.4 The client, and why

The client is Studio's own, over the shared transport, and it adds no package.
The official TypeScript client speaks gRPC for its queries, which on Weaviate Cloud and DigitalOcean is a second host name, against the one-endpoint rule the vector providers keep, and it sends headers Studio does not choose.

## 3. Design decisions

### 3.1 Weaviate's REST requests as the console, run over REST or GraphQL

The editor text is the form Weaviate's REST reference documents, so a request can be pasted from it.
Searches are written in the REST search shape on every server, the precedent of Milvus, whose REST text runs over gRPC.
REST search did not arrive in version order, measured on 2026-10-23: 1.38.22 carries the routes behind `EXPERIMENTAL_REST_SEARCH_ENABLED`, 1.39.0 has none, 1.39.6 has them behind the flag, 1.39.7 serves them by default, and near-vector starts at 1.39.8.
So `connect()` reads the version, as Qdrant, Milvus and InfluxDB do, and a table picks the path:

| Server | bm25, hybrid, near-object, aggregate | near-vector |
|---|---|---|
| 1.39.8 and later | REST | REST |
| 1.39.7 | REST | GraphQL |
| below 1.39.7 | GraphQL | GraphQL |
| version not read | GraphQL | GraphQL |

GraphQL is chosen below 1.39.7 even where a 1.38 server has the flag on: both paths return the same rows, and the flag is configuration the version cannot show.
A server that answers `graphql api is disabled` (new Weaviate Cloud clusters set `DISABLE_GRAPHQL`) has the same search sent once more over REST; one that has neither path is refused with one sentence, and browsing keeps working.
1.38.22 ignores `DISABLE_GRAPHQL` and serves GraphQL anyway; 1.39.0 and later honour it (measured).
The path that answered is remembered for the session and named on the result ("Answered via REST search." or "Answered via GraphQL."), and nothing is stored with the saved connection, because managed services upgrade the engine on their own schedule.
No raw GraphQL is a route: `graphql.ts` writes every document from the search model, identifiers checked, strings escaped by one function and numbers as typed.

### 3.2 No text is sent to a model

A Weaviate collection may declare a vectorizer module, and some searches make the server send the user's text to it: the near-text route, generative search (`singlePrompt`, `groupedTask`), `rerank`, and hybrid with an `alpha` other than 0, whose server default is 0.7.
Each is refused before anything is sent, and `alpha` must be written as 0.
Measured on 2026-10-23 with a collection whose `text2vec-openai` base URL is a listener on the Docker bridge gateway: hybrid at `alpha` 0, BM25, near-object, near-vector, aggregate, the object reads and every surface sent the listener nothing on 1.37.4 and 1.40.2, through REST and GraphQL, while hybrid at 0.5 and a nearText control each sent it one request.
No header but `Authorization`, `Content-Type` and `Accept` is ever sent, so a model-provider key such as `X-OpenAI-Api-Key` cannot reach the server through Studio.

### 3.3 Nothing is written

v1 runs reads only: every write route (objects, batch, schema, tenants, aliases, backups, users and roles, replication, namespaces, classifications) is refused by name, saying what v1 runs.
The client sends `GET`, and `POST` only to the search, aggregate and GraphQL paths.

### 3.4 A read never wakes a tenant

On a collection with `autoTenantActivation` on, any data read of a COLD tenant sets it HOT, for a user with only the built-in `viewer` role too; reading the tenant's own record, the tenant list and `/v1/nodes` does not (measured on 1.37.4 and 1.40.2).
So before any request that names a tenant, the provider reads `GET /v1/schema/{collection}/tenants/{tenant}` and refuses unless the status is HOT (or its older name, ACTIVE), naming the status; a multi-tenant collection without a tenant is refused too.
On the 1.37 line (1.37.4 and 1.37.17), `GET /v1/schema/{collection}/shards?tenant=` with a COLD tenant wakes it and then does not answer, and that collection's `/shards` stops answering for every tenant until the server restarts; the guard is what keeps the provider from sending it.

### 3.5 The read-only mode

`enforcesReadOnly` is true: every console request is a read and the provider has no maintenance operation.
A read-only seed connection with no key is refused, because a server with anonymous access on, its default, grants a request with no key every write, so the mode would promise a boundary the server does not keep.

### 3.6 Integers

Weaviate stores an `int` property as a float64 (`intVal` in `usecases/objects/validation/properties_validation.go`): written through REST or gRPC, 2^53 + 1 is stored as 2^53 and 2^63 - 1 is refused, so a plain JSON parse loses nothing the server has.
GraphQL answers null for every int outside the 32-bit range, 2^53 - 1 included, so a null in an `int` column on the GraphQL path carries a warning saying it may be such a value.

## 4. Connection

### 4.1 Configuration fields

| Field | Use |
|---|---|
| Host, Port | One endpoint; `8080` by default. REST and GraphQL share it; gRPC (50051) is never dialled |
| API key or token | An API key or an OIDC access token, sent as `Authorization: Bearer`; empty for anonymous access |
| SSL / TLS | Off, or the mode, CA and client certificate of the shared panel |

There is no User field and no Database box: Weaviate takes a bearer token alone and has no container level, and a non-empty user from a seed or the API is refused naming the field.

### 4.2 Authentication

An API key and an OIDC access token travel the same way, as one bearer header set once per connection.
An OIDC token is pasted, not obtained: v1 has no refresh flow, and an expired token is refused by the server as any other.
The safest credential is the key of a database user that holds only the built-in `viewer` role: it reads every surface this provider shows, and the server refuses its writes (measured).
A `viewer` user can also read `/v1/authz/roles` and `/v1/users/db`, which this provider never reads or shows.
A role scoped to some collections cannot use GraphQL at all, because GraphQL introspection needs `read_collections` on every collection, so on a server below 1.39.7 such a role browses but cannot search.

### 4.3 TLS

The SSL panel maps to the shared TLS material; Weaviate's own listener serves TLS with `--scheme https`, and plain HTTP to a TLS port is refused with a sentence asking for an SSL mode.

### 4.4 One endpoint

Every request goes to the one host and port; REST and GraphQL are two paths on it.

### 4.5 SSH tunnel

The shared tunnel is offered: the origin dialled is the local forward, while sentences, the plaintext rule and the certificate identity use the tunnel's far end.

### 4.6 A key needs TLS off this machine

A key is sent without TLS only to a loopback host or through an SSH tunnel (`plaintextSecretRefusal`); anything else is refused before any socket opens.

### 4.7 Pasting an address

The Host box takes a pasted `http://` or `https://` address and splits it into Host and Port.

### 4.8 Server versions

1.37 and later are supported; 1.37 left Weaviate's support window (the three most recent minors) when 1.40 shipped and stays supported because a managed service still runs it.
The fixture matrix runs 1.40.2, 1.38.22 and 1.37.4, and 1.40.2 with GraphQL disabled; the path table was measured on 1.37.4, 1.37.17, 1.38.22, 1.39.0, 1.39.6, 1.39.7, 1.39.8, 1.39.13, 1.40.0 and 1.40.2.
A later release takes REST by the table, and REST search is still a preview upstream, so a release is claimed only once it is measured.

### 4.9 Hosted services

Weaviate Cloud and DigitalOcean Managed Weaviate are claimed nowhere until a test cluster passes the live check.

### Connection string

`weaviate` has no connection string scheme, no `readTls` and no seed load check: every field of its row in `CONNECTION_STRING` is `null` ([`connection-string.ts`](../../src/lib/db/providers/vector/weaviate/connection-string.ts)).

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `weaviate` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/vector/weaviate/execution-ui.ts).

## 5. Query interface

### 5.1 The request

One request per run: optional comment lines starting with `//` or `#`, one `METHOD /v1/path` line with an optional query string, and for `POST` one JSON object.
The prefix may be left out: `GET schema` is `GET /v1/schema`.

### 5.2 The routes

| Route | Query keys | Body |
|---|---|---|
| `GET /v1/meta`, `GET /v1/schema`, `GET /v1/schema/{collection}` | none | none |
| `GET /v1/schema/{collection}/shards` | `tenant` | none |
| `GET /v1/schema/{collection}/tenants`, `GET /v1/schema/{collection}/tenants/{tenant}` | none | none |
| `GET /v1/aliases`, `GET /v1/aliases/{alias}` | none | none |
| `GET /v1/nodes`, `GET /v1/nodes/{collection}` | `output` | none |
| `GET /v1/objects` | `class` (required), `limit`, `after`, `offset`, `include`, `sort`, `order`, `tenant` | none |
| `GET /v1/objects/{collection}/{id}` | `include`, `tenant` | none |
| `POST /v1/search/{collection}/bm25` | none | required `query`; `queryProperties` |
| `POST /v1/search/{collection}/hybrid` | none | required `query` and `alpha: 0`; `queryProperties`, `fusionType`, `maxVectorDistance`, `targetVector` |
| `POST /v1/search/{collection}/near-vector` | none | required `vector`; `targetVector`, `distance`, `certainty` |
| `POST /v1/search/{collection}/near-object` | none | required `id`; `targetVector`, `distance`, `certainty` |
| `POST /v1/aggregate/{collection}` | none | optional: `where`, `tenant`, `groupBy`, `limit`, `returnMetrics` (`count`) |

Every search also takes `where`, `limit`, `offset`, `autoLimit`, `returnProperties`, `returnMetadata` (`distance`, `certainty`, `score`, `explainScore`, `creationTime`, `lastUpdateTime`), `tenant` and `consistencyLevel`.

### 5.3 Request rules

- Every body key, at every level the where filter declares, is checked against a closed set and an unknown key is refused by name: the server ignores an unknown key in silence, so a misspelled `where` returned unfiltered results and a misspelled `limit` ten rows (measured).
- `singlePrompt`, `groupedTask` and `rerank` are refused because they call a model; `groupBy`, `numberOfGroups` and `objectsPerGroup` on a search, and `over` and `objectLimit` on an aggregate, because the server reserves them; `returnReferences` because returning cross-references is outside v1.
- A collection or alias name follows Weaviate's own rule, a letter then letters, digits and `_`, at most 255 characters, with its first letter capitalised as the server does; a tenant name holds letters, digits, `-` and `_`, 1 to 64 characters; an object id is a UUID.
- A where filter's `And` and `Or` take operands and `Not` exactly one; every other operator takes a path and exactly one value key; at most 256 conditions, 8 levels and 64 KiB.
- A vector search names a vector with `targetVector` when its collection has more than one, and hybrid does too even at `alpha` 0, which the server refuses without one (measured); a BM25 search reads no vector and sends none; a property a search names must exist and must not be a cross-reference.
- `limit` plus `offset` is at most 1,000, below the server's `QUERY_MAXIMUM_RESULTS`, and `offset` may be 0; a search with no limit is sent with 10 and an object list with 25, so both paths answer the same rows.
- An aggregate with `groupBy` and no `limit` is sent with 100, the number of groups both paths answer then (measured on 1.37.4 and 1.40.2), and a result that reaches its limit says more groups may exist.

### 5.4 Examples

```
GET /v1/objects?class=Article&limit=50
POST /v1/search/Article/bm25 {"query": "vector search", "where": {"path": ["category"], "operator": "Equal", "valueText": "alpha"}, "limit": 5, "returnMetadata": ["score"]}
POST /v1/search/Product/near-vector {"vector": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], "targetVector": "image", "limit": 3, "returnMetadata": ["distance"]}
POST /v1/aggregate/TenantNotes {"tenant": "acme"}
```

### 5.5 Where the console differs from a REST call

A request is checked and re-written before it is sent, never forwarded as typed, and on a server below 1.39.7 a search is sent as GraphQL.

### 5.6 Result shape

A search row has the same columns on both paths: `$id`, the properties asked for (every non-reference property when none is named), then the metadata asked for as `$distance`, `$certainty`, `$score`, `$explainScore`, `$creationTime` and `$lastUpdateTime`, the times in milliseconds since the epoch; GraphQL answers the times and the score as text, which are read back as the numbers REST answers.
Neither search path returns a vector: REST search has no metadata for it.
An object read with `include=vector` returns `$vector` and `$vector.<name>` cells, drawn as vectors.
An aggregate answers one `count` row, or one row per group with the group's value; an object list that fills its limit says how to read the next page with `after` from the last row shown, which after the result budget drops a page's tail is the last row kept, or to set the `after` it already names; a list that names `offset` or `sort` gets no such notice, because `after` takes neither.
A near-vector search that finds nothing on a compressed index says that a vector of the wrong length looks the same there, because Weaviate answers an empty result rather than an error then.

### 5.7 Bounds

A response is read up to 16 MiB, a result is built up to 8 MiB and dropped whole past it, and a text cell is cut at 65,536 characters with a marker.
A metadata route has 10 s and a read or search 30 s, at most the connection's query timeout and below Weaviate's 60 s write timeout.

### 5.8 Time, cancellation and the confirmation gate

A running or queued request can be cancelled; the request's socket is closed.
Every route is a read, so nothing asks for confirmation; the browser runs the same phase 0 the provider runs, and a text it refuses is never sent.

### 5.9 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/vector/weaviate/sql-grammar.ts`](../../src/lib/db/providers/vector/weaviate/sql-grammar.ts), the `weaviate` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
`readsSqlText` is `false`: `weaviate` takes one Weaviate console request, a `METHOD /v1/path` line and one JSON body, whose strings escape with a backslash and where `//` opens a comment outside a string; the provider parses it with the shared console parser.
The confirmation gate therefore answers from this engine's row of `NON_SQL_DESTRUCTIVE_VOCABULARY` in `src/lib/db/destructive-commands.ts` instead of a SQL reading.
Its grammar is `DEFAULT_SQL_GRAMMAR`, the compatibility default, since no SQL grammar of its own applies to this text.
Redaction is `none`: a redacted statement is stored as `?`, because a reader guessing where a literal ends in a language it does not read can store the literal.

## 6. Schema introspection

### 6.1 The object surface

One kind, Collection, from one `GET /v1/schema`, which also answers every collection's columns, so describing every collection is one round trip; collections are listed by name.
A collection's columns are `$id`, its properties in schema order typed with Weaviate's own word (`text`, `int`, `number`, `date`, `geoCoordinates`, `object` and the rest, a cross-reference as `ref → Target`), then its vectors.
The schema declares no dimension, so opening one single-tenant collection reads one object with `include=vector` to spell it; a multi-tenant collection is never read past its schema.
No row count is on the listing.

### 6.2 Object source

The Source has two parts: `Schema`, the class definition as Weaviate answers it, and `State`: the aliases that point at the collection, then for a single-tenant collection its shards with their statuses and its exact object count (aggregate `meta.count`), and for a multi-tenant one its tenant count and the first 1,024 tenants by name with their activity statuses, as Milvus lists partitions.
`/v1/nodes` object counts are never used: they read 0 for collections that held objects twenty minutes after they were written.

### 6.3 Object edit (#789): nothing to write

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: v1 reads only (section 3.3).
The absence is `weaviate`'s entry in `EXPECTED_EDIT_ABSTAINERS` (`tests/helpers/object-edit-expectation.ts`), and `tests/isolated/object-edit-declarations.test.ts` is what holds that entry and this section together.

### 6.4 Generated requests

A collection click runs `GET /v1/objects?class=<collection>&limit=50`; on a multi-tenant collection phase 1 refuses it with no call and names the request that lists the tenants and which are HOT.
Generate Request writes, without running it, a near-vector search over the first vector with a probe vector of the right length, and a BM25 search and an aggregate count as comments.
Where no object has shown the vector's length, as in the tree's one-read schema columns, the BM25 search is the request and the near-vector search a comment waiting for the user's numbers, because a guessed length is a server error ("vector lengths don't match", measured on 1.40.2).

## 7. Monitoring & health

| Surface | Reads |
|---|---|
| Health | `GET /v1/.well-known/ready`, readiness only |
| Overview | `GET /v1/meta` for the version, `GET /v1/schema` for the collections and vector indexes; uptime and size are not reported |
| Tables | One exact count per single-tenant collection of the first 200 by name; a multi-tenant collection is counted per tenant in the console |
| Indexes | One row per vector: index type, distance and compression |
| Slow queries, sessions, storage | Empty: Weaviate reports none over the routes Studio reads |

## 8. Maintenance

None: Weaviate has no maintenance operation in v1, so no Admin > Operations card and no tree control is offered for it.

## 9. Capabilities & labels

`queryLanguage` `json` with `queryDialect` `weaviate`, `containerLevels` empty, `enforcesReadOnly` true, every `supports*` false, `defaultPort` 8080.
The labels name a Collection and an Object, "Read Objects" and "Generate Request", and the statement language plan mode states is generated from the route table.

### SQL writing

[`weaviate/sql-writing.ts`](../../src/lib/db/providers/vector/weaviate/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalStandard` and read back by `unquoteStandard`: the quote is doubled and a backslash is data.
A name is quoted by `identifierDoubleQuoted`, the SQL standard form: a double-quoted name with an inner double quote doubled.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
This engine declares `queryLanguage: "json"`, so no statement is ever built for it to read; what a generator emits for such a connection is portable SQL meant to run elsewhere, and the standard form is the only thing it can claim.
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field writes a result export's CREATE TABLE and INSERT from the shared building blocks alone: `STANDARD_DDL_TYPES` for the column types, `NOTHING_STANDS_ALONE` and `NO_BARE_SPELLING`, so every bare declared name is re-spelled from its family, `NULL_NON_FINITE` for NaN and the infinities, and `binaryStandardHex` for a binary cell (`X'0102'`).
The engine declares `queryLanguage: "json"`, so no SQL statement is ever built for it to read, and a file exported from it is meant to run somewhere else: every bare name in it is re-spelled portably rather than kept as one engine's private word.

## 10. Error handling

| Condition | Class |
|---|---|
| 401, a missing or refused key or token | `AuthenticationError` |
| 403 from RBAC at connect | `AuthenticationError`; after connect a `QueryError` naming what the server refused |
| A collection that does not exist (404, or GraphQL's unknown field) | `QueryError` |
| A route this server version does not serve | `QueryError` |
| A cold tenant | refused before any read, naming its status |
| GraphQL disabled, REST search absent or behind its flag | `QueryError` naming what the server lacks |
| A GraphQL refusal of a scoped role | `QueryError` naming the version where REST search serves |
| Past `QUERY_MAXIMUM_RESULTS` | `QueryError` |
| Plain HTTP to a TLS port, a TLS failure, a refused or unreachable endpoint | `ConnectionError` |
| A deadline | `TimeoutError` |
| An invalid request, name, key or token | `DatabaseConfigError` or a phase 0 refusal, never echoing a secret |

GraphQL answers its refusals under HTTP 200 with `errors` beside `data`; they are read into the same classes.

## 11. Testing

### 11.1 How the tests work

The unit tests drive every module through a recording client and a recording transport, with no `mock.module()`.
The integration test replays [`tests/fixtures/weaviate/`](../../tests/fixtures/weaviate/README.md): each file is one scenario of `tests/live/weaviate-scenarios.ts`, written by `tests/live/weaviate-evidence.ts` against the fixture servers, holding every request the provider sent, each answer, and what each call returned or threw.
The replay builds the same provider over a transport that answers from the file, makes the same calls, and fails unless the requests and the outcomes are the recorded ones.

### 11.2 Run it

`bun tests/run-tests.ts tests/unit/db/weaviate/` and `bun tests/run-tests.ts tests/integration/db/weaviate-provider.test.ts`.

### 11.3 The live fixtures

`database-compose.yml` runs `weaviate` (1.40.2), and behind `weaviate-matrix` `weaviate-1-37` (1.37.4), `weaviate-1-38` (1.38.22) and `weaviate-nographql`, and behind `weaviate-secure` `weaviate-auth` and `weaviate-tls` with a `viewer` user; [`docker/weaviate/README.md`](../../docker/weaviate/README.md) describes them and the seeded collections.

### 11.4 The live check

`bun tests/live/weaviate-live-check.ts --keys <dir>` runs every scenario against the fixture servers and holds each run to its capture, the same requests and the same outcomes, compared with object keys and arrays sorted because Weaviate's own order differs between two identical reads; it snapshots the schema, the aliases and every tenant's status before and after, and fails on any change.
Measured on 2026-10-23: every scenario matched and no tenant changed status.
`bun tests/live/weaviate-path-parity.ts` sends 72 requests, every where operator and value type, every search kind and the aggregates, to 1.40.2 over REST and to 1.38.22 and 1.37.4 over GraphQL, and fails unless each answers the same rows with the same cell types; a grouped aggregate's order and 1.37's WithinGeoRange count are the servers' own and expected.

## 12. Running Weaviate for Studio

Start a server with no vectorizer and `API_BASED_MODULES_DISABLED=true` for a server Studio only reads: an empty `ENABLE_MODULES` still loads every API-based module.
Create a database user with the built-in `viewer` role and give Studio its key.

## 13. Known limitations

- No write path, no raw GraphQL, no gRPC and no cross-references in results.
- A search on a server below 1.39.7 with GraphQL disabled and the REST flag off is refused; browsing works.
- A role scoped to some collections cannot search a server below 1.39.7.
- Per-tenant counts are read in the console, not in the Source.
- An OIDC token is not refreshed.
- Weaviate 1.37 counts an aggregate filtered by `WithinGeoRange` as 0 even where objects match (measured on 1.37.4: 0, while a search finds 500; 1.38.22 and 1.40.2 count 500); such a count carries a note saying so.

## Migration DDL

[`WEAVIATE_MIGRATION_DDL`](../../src/lib/db/providers/vector/weaviate/migration-ddl.ts) is what the schema-diff migration generator writes for `weaviate`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
It declines the whole diff: `refusal` is the one line the migration prints after its header, in place of any DDL, and `transactionWrapper` is `null`.
`weaviate` text is a Weaviate console request, not SQL, so there is no table DDL to wrap (#284).

The refusal reason it prints, verbatim:

- "A collection's properties and vectors are declared through Weaviate's own schema API, not SQL DDL, so there is no column definition to change."

## 14. References

- Weaviate REST reference and OpenAPI document, v1.40.2.
- Weaviate source, `usecases/objects/validation/properties_validation.go`, `entities/schema/validation.go`, `adapters/handlers/rest/server.go`, v1.40.2.
- The design: issue [#1566](https://github.com/libredb/libredb-studio/issues/1566).
