# Google Cloud Firestore Provider

> Read-only access to a Google Cloud Firestore database in Native mode, Standard or Enterprise edition, over the Firestore REST API v1 (`https://firestore.googleapis.com`), with no Google SDK.
> Every request goes through the shared `node:https` transport, and the access token comes from a service-account key, an authorized-user (ADC) file, a pasted access token, or the server's own identity behind an operator opt-in.
> This document is the reference for the Firestore provider: connection and credentials, the emulator, the query console, the tree, the Keys panel, the Source tab, Explain, billing, limits and errors.

|                        |                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| **Status**             | Implemented, read-only                                                                            |
| **Database type id**   | `firestore`                                                                                       |
| **Family**             | Document (`src/lib/db/providers/document/firestore/`)                                             |
| **Driver**             | None: REST over the shared transport; `jose` (already a dependency) signs service-account grants |
| **Query language**     | The Firestore Admin SDK query chain (Node.js, namespaced API), parsed by Studio, never run        |
| **Default port**       | None: the endpoint is always `firestore.googleapis.com:443`                                       |
| **Connection string**  | Not supported                                                                                     |
| **EXPLAIN**            | `firestore-explain`: Query Explain, plan only from the button; not offered on an emulator server  |
| **Writes**             | None: the provider can send no write request                                                      |
| **Transactions**       | None                                                                                              |
| **Maintenance**        | None                                                                                              |
| **Query cancellation** | Supported: the request is aborted                                                                 |

## Before you connect

Studio reads as the credential's IAM identity, and Firebase Security Rules do not apply to it.
Security Rules govern the Firebase client SDKs; a call made with a service account, a user's ADC file or an access token is an IAM call, so it reads every document the identity's roles allow.
Give Studio a dedicated service account with `roles/datastore.viewer`.

Every read Studio sends is billed to the project, one read per document returned, and a budget alerts but never stops spending; section 8 lists what each surface reads.
Studio never reads a document without a gesture that names it: connecting, the tree and plan mode read collection ids and database metadata only.

## 1. Overview

A connection pins one project and one database.
The tree lists the database's top-level collections; activating one previews 100 documents, and expanding one shows fields sampled from 20 documents.
The Keys panel walks documents and subcollections at any depth, one level per expand, and a document opens in the Source tab.
The console takes one statement in the Admin SDK query-chain syntax, which Studio parses and compiles to one REST request; nothing is ever run as JavaScript.

### 1.1 Concept mapping

| Firestore | Studio |
| --- | --- |
| Project | The connection's `database` field (labelled Project ID) |
| Database | The connection's `schema` field (labelled Database ID); empty means `(default)` |
| Top-level collection | Object kind `collection`, a relation with sampled columns |
| Document, at any depth | Object kind `document`, reached through the Keys panel; it opens in the Source tab |
| Subcollection | A folder of the Keys panel under its document |
| Document id | The key's last segment; the key is the path relative to `documents` |

### 1.2 Surfaces

The embedded workspace has no Keys panel, no connection dialog and no Explain button; each has a console equivalent.

| Feature | Standalone app | Embedded workspace |
| --- | --- | --- |
| Tree of top-level collections, activation preview | Yes | Yes |
| Field expand (sampled) | Yes | Yes, when the host implements `describeObject` |
| Keys panel (documents, subcollections) | Yes | No: `db.collection("users").listDocuments()` and `db.doc("users/alice").listCollections()` |
| Document Source tab | Yes | No: `db.doc("users/alice").get()` and `db.doc("users/alice").listCollections()` |
| Query console | Yes | Yes |
| Explain button | Yes (not on an emulator server) | No: `.explain()` in the console |
| Connection dialog with hints | Yes | No: this document carries the same sentences |

## 2. Architecture

### 2.1 Modules

| Module | Responsibility | Browser-safe |
| --- | --- | --- |
| `index.ts` | `FirestoreProvider`: capabilities, connect, query, cancel, the object surface, the Keys panel, the Source tab | No |
| `seams.ts` | Every effect: transports, clock, sleep, environment, files, home directory, platform | No |
| `constants.ts` | Type id, limits, endpoints, environment names, shared sentences | Yes |
| `labels.ts`, `connection-options.ts` | Labels, the statement-language sentence, the field rules | Yes |
| `names.ts`, `field-path.ts`, `values.ts` | Id rules and path encoding, field paths, REST values both ways | Yes |
| `google-credentials.ts`, `google-token-source.ts` | Credential parsing, the ADC chain, the grants and the token cache | No |
| `credential-policy.ts` | The server-identity opt-in, the operator-seed rule, the emulator refusal | No |
| `requests.ts` | The closed table of the seven read requests | Yes |
| `transport.ts` | One lane per bearer value, the emulator lane, routing headers, response caps | No |
| `console/lexer.ts`, `console/parser.ts`, `console/compile.ts`, `console/guard.ts`, `console/generators.ts` | The query chain: tokens, statement, request, the browser-side refusal, generated text | Yes |
| `console/execute.ts`, `results.ts` | Running one request and shaping its rows | No, yes |
| `sampling.ts`, `key-scan.ts`, `cursor.ts`, `objects.ts` | Field sampling, Keys panel levels, the cursor envelope, the object surface | Yes, no, yes, no |
| `errors.ts` | Google's errors to Studio's error classes and sentences | Yes |

The editor language is `src/lib/editor/firestore-language.ts` and `firestore-completions.ts`, and the Explain strategy is `src/lib/explain/firestore-explain.ts`.

### 2.2 Request path

Console: the editor, `POST /api/db/query`, the provider's parser and compiler, one request of the closed table, the transport, Firestore, the decoder, the result grid.
The route never adds a page bound: the provider answers `wasLimited: false`, so no Load more is offered and the editor's page options never reach the statement.
Tree: `listObjects` and `countObjects` read top-level collection ids; `describeObject` samples one collection.
Keys panel: one REST listing per page.
Source tab: one `get` and one subcollection listing.

## 3. Design decisions

### 3.1 Read-only by construction

The transport admits seven requests and refuses everything else before any socket: the database resource (`GET`), `documents.get`, `documents.listDocuments`, `listCollectionIds`, `runQuery`, `runAggregationQuery` and `batchGet`.
Each is matched on method, path shape, verb, query parameter names and top-level body keys, so `transaction`, `newTransaction`, `readTime`, `recursive` and `requestOptions` never leave Studio, and no transaction is opened.
`READ_ONLY_ENFORCED.firestore` is true and the provider declares `enforcesReadOnly`.

### 3.2 REST, no SDK

Every read is a `GET` or a `POST` of the REST API v1, so the provider needs no gRPC stack and no new dependency.

### 3.3 The console parses; it never runs JavaScript

The console reads the Admin SDK chain users already write, accepts a closed set of methods, and compiles the statement to one request; the server parses it again before any request.

### 3.4 The emulator switch belongs to the server

`FIRESTORE_EMULATOR_HOST` is read from the server environment only and sends every Firestore connection on that server to the emulator; no connection field can name a host.

### 3.5 Machine access

`MCP_EXPOSABLE.firestore` is false and the provider implements no `queryReadOnly`, so agent execution and MCP `run_read_query` refuse Firestore.
Plan mode works: it grounds on collection names and `__name__` as each collection's column, at the cost of two root id listings and no document read, and drafts statements fenced with the `firestore` tag.
Sampled fields never reach a model.
The Explain panel's AI tab sends the statement and the plan, which names indexed fields, to the configured model when the user clicks it.

## 4. Connection

### 4.1 Fields

| Field | Label | Rule |
| --- | --- | --- |
| `database` | Project ID | Required; 6 to 30 lowercase letters, digits and `-`, starting with a letter, not ending with `-`, optionally prefixed by a legacy `domain:` |
| `schema` | Database ID | Optional; empty means `(default)`; otherwise 4 to 63 lowercase letters, digits and `-`, letter first, letter or digit last, not shaped like a UUID |
| `password` | Service-account key, ADC JSON or access token | Section 4.2 |

There is no host, port, SSL panel, SSH tunnel or connection string.
Collection and document ids are non-empty, at most 1,500 bytes of UTF-8, hold no `/`, are not `.` or `..`, and do not match `__.*__`, except that a document id `__id<digits>__` from a Datastore import is accepted; every id an answer carries is checked the same way before it is shown or reused.
A custom connection keeps its credential in the browser's local storage in plain text by design, so a shared deployment should use an operator seed ([SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md)).

### 4.2 Credentials

The `password` field holds one of three things:

1. A service-account key JSON (`"type": "service_account"`): a JWT-bearer grant at `https://oauth2.googleapis.com/token`, signed RS256, for the scope `https://www.googleapis.com/auth/datastore`.
2. An authorized-user JSON (`"type": "authorized_user"`, what `gcloud auth application-default login` writes): a refresh-token grant at the same URL, with no scope parameter; when the file carries a `quota_project_id` that passes the project id rule, every request sends it as `x-goog-user-project`.
3. An access token, with or without a `Bearer ` prefix, sent as is and never refreshed; one from `gcloud auth print-access-token` lasts about an hour.

The fourth form is no credential at all: the server's own identity, for an operator-seeded connection only (section 4.4), or an emulator server (section 4.5).
Every other `type` (`external_account`, `impersonated_service_account`, `external_account_authorized_user` and any unknown value) is refused with a sentence.
Every URL a credential file carries (`token_uri`, `auth_uri`, `universe_domain`, `credential_source` and any other) is ignored: the token URL is the constant above.
The password input strips line feeds, which a key file survives: its line breaks are JSON whitespace and its private key's breaks are `\n` escapes.

An empty field on a server without `FIRESTORE_EMULATOR_HOST` is refused, for a connection sent by a browser with:

> Paste a service-account key JSON, an authorized-user JSON or an access token: the server's own Google identity is used only for operator-seeded connections

and for an operator seed on a server without the opt-in with:

> Set FIRESTORE_SERVER_CREDENTIALS=true on the server to let this seeded connection use the server's own Google identity

The token source keeps one token per connection, refreshes it 60 seconds before it expires, shares one refresh among concurrent requests, caches nothing on failure, and never logs or reports a token, an assertion, a key or a key id.

### 4.3 IAM and Security Rules

Studio reads as the credential's IAM identity, and Firebase Security Rules do not apply to it.
The read grant is `roles/datastore.viewer`, which also holds `datastore.databases.getMetadata`, the permission the connect probe needs.
A missing `datastore.entities.list` is not proven on connect; the first listing answers it with the 403 sentence of section 12.

### 4.4 Server identity

With `FIRESTORE_SERVER_CREDENTIALS=true` on the server and an operator-seeded connection (`managed: true`, which a browser-sent connection can never claim) whose field is empty, Studio reads the server's identity in Application Default Credentials order: the file `GOOGLE_APPLICATION_CREDENTIALS` names, then gcloud's well-known file (`$HOME/.config/gcloud/application_default_credentials.json`, or `%APPDATA%\gcloud\application_default_credentials.json` on Windows), then the metadata server (`GCE_METADATA_HOST`, or `metadata.google.internal`).
A named credentials file that cannot be read is an error, never a fallback to the metadata server.
On GKE with Workload Identity, the pod's service account is the identity.

### 4.5 The emulator

`FIRESTORE_EMULATOR_HOST` names the emulator as `host:port` or `[ipv6]:port`, with no scheme; any other shape is refused when the provider is built.
When it is set, every Firestore connection on the server talks to the emulator, over plain HTTP, with the literal `Bearer owner` as its only authorization; no token is minted, no token or metadata request is built, and `FIRESTORE_SERVER_CREDENTIALS` is not read.
Changing it needs a server restart.
A connection that carries a credential is refused:

> This server sends every Firestore connection to the emulator at 127.0.0.1:8080 (FIRESTORE_EMULATOR_HOST): clear the credential field, or ask the operator to unset the variable

Connecting always warns:

> Connected to the Firestore emulator at 127.0.0.1:8080, not to Google; FIRESTORE_EMULATOR_HOST is set on this server

and when the probe lists no collection it adds:

> The emulator listed no collection: it creates any project and database on demand, so the project id must match the one the data was written under

The project id is still required and validated; use a `demo-` id, which never names a real project.
The emulator does not run Query Explain, so the Explain button is not drawn, and a console `.explain()` answers:

> The Firestore emulator does not run Query Explain; run Explain against a Google project

Three ways to run one:

1. `npx`, with an emulator on this machine (`gcloud emulators firestore start --host-port=127.0.0.1:8080`, or the Firebase CLI's `firebase emulators:start --only firestore`):

       FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx @libredb/studio

2. Docker, with the emulator bound to `0.0.0.0:8080` on the host:

       docker run --rm -p 3000:3000 -e FIRESTORE_EMULATOR_HOST=host.docker.internal:8080 --add-host=host.docker.internal:host-gateway ghcr.io/libredb/libredb-studio:latest

   `--add-host` is needed on Linux; Docker Desktop resolves `host.docker.internal` itself.

3. The `firestore` service of `database-compose.yml`, seeded by `firestore-seed` with the sample data of `docker/firestore/seed.json` under the project `demo-libredb`: a Studio container on the same compose network uses `FIRESTORE_EMULATOR_HOST=firestore:8080`, and Studio on the host uses `FIRESTORE_EMULATOR_HOST=127.0.0.1:8380`.

`DB_HTTP_BLOCK_PRIVATE_HOSTS=true` refuses a loopback emulator, as it refuses every private address.

### 4.6 Endpoints and egress

The API origin `https://firestore.googleapis.com` and the token origin `https://oauth2.googleapis.com` are fixed; regional endpoints are not supported.
Every request carries `x-goog-request-params` (`project_id`, and `database_id` for a named database) and `google-cloud-resource-prefix`.
The API, token and emulator lanes refuse link-local addresses; the metadata lane cannot, because the metadata server is one.
The shared transport has no HTTPS proxy support, so a Studio whose egress goes through a proxy cannot reach Google.

## 5. Query interface

### 5.1 The statement

One statement per run, a chain that starts at `db`, with whitespace and `//` or `/* */` comments between any two tokens, an optional leading `await` and an optional trailing `;`.
A chain that ends early runs as if it ended in `.get()`.

| From | Calls | Answers |
| --- | --- | --- |
| `db` | `collection(path)` (odd segments), `collectionGroup(id)`, `doc(path)` (even segments), `listCollections()`, `getAll(ref, ...)` | a collection, a query, a document, top-level collection ids, documents |
| collection | `doc(id)`, `listDocuments()` | a document; document names, missing parents included |
| collection, query | `where`, `orderBy`, `limit`, `offset`, `startAt`, `startAfter`, `endAt`, `endBefore`, `select` | a query |
| collection, query | `findNearest({ vectorField, queryVector, limit, distanceMeasure [, distanceResultField] [, distanceThreshold] })` | a vector query |
| collection, query | `count()`, `aggregate({ key: AggregateField.count() \| sum(path) \| average(path), ... })` | an aggregation |
| collection, query, vector, aggregation | `explain([{ analyze: boolean }])`, `get()` | explain metrics; the run |
| document | `collection(id)`, `get()`, `listCollections()` | a collection; one document; subcollection ids |

`Filter.where`, `Filter.and`, `Filter.or`, `FieldPath.documentId()`, `new FieldPath(...)`, `Timestamp.fromDate(new Date("..."))`, `Timestamp.fromMillis(n)`, `new Timestamp(s, n)`, `new GeoPoint(lat, lng)`, `FieldValue.vector([...])` and `AggregateField` are read with or without the `admin.firestore.` prefix.
Operators are `<`, `<=`, `==`, `!=`, `>=`, `>`, `array-contains`, `in`, `not-in` and `array-contains-any`; `=` is read as `==`.

### 5.2 Grammar

```
statement   = [ "await" ] "db" { "." call } [ ";" ]
call        = name "(" [ expr { "," expr } [ "," ] ] ")"
expr        = string | number | "true" | "false" | "null" | "NaN" | [ "-" ] "Infinity"
            | array | object | typed | ref | filter | path | aggregate
ref         = "db" "." "doc" "(" string ")"
ns          = "admin" "." "firestore" "."
```

Strings take single, double or backtick quotes with JavaScript escapes; a `${` inside a backtick string is refused.
Identifiers are ASCII, and any identifier the grammar does not name is refused.
Every refusal names its line and column and quotes a short excerpt.

### 5.3 Near misses

| Text | Studio answers |
| --- | --- |
| `const ref = db.collection("users");` | Studio runs one chain starting at db; write it inline |
| `query(collection(db, "users"))` | Use the namespaced form, db.collection(...) |
| `admin.firestore().collection("users")` | Start the chain at db |
| `db.collection("users").get().then((snapshot) => snapshot)` | Studio runs the query itself; end the chain at the query or .get() |
| `db.collection("users").add({ name: "Ada" })` | Studio is read-only for Firestore in this version |

### 5.4 Examples

```js
db.collection("users").limit(100)
db.collection("users").count()
db.collection("users").where("age", ">=", 30).orderBy("age").limit(20)
db.collection("users").where("nickname", "==", null)
db.collection("users").where("tags", "array-contains", "beta")
db.collection("users").where("status", "in", ["active", "trial"])
db.collection("users").where(Filter.or(Filter.where("age", "==", 34), Filter.where("age", "==", 41)))
db.collection("users").where("joined", ">=", Timestamp.fromDate(new Date("2026-01-01")))
db.collection("users").where(new FieldPath("dotted.key"), "==", "a field whose name holds a dot")
db.collection("users").select("name", "address.city")
db.collection("users").orderBy("name").startAfter("Bob").limit(10)
db.collection("orders").orderBy(FieldPath.documentId()).startAfter("0002").limit(2)
db.collection("users/alice/orders").limit(100)
db.collectionGroup("orders").where("total", ">", 50)
db.collection("products").aggregate({ total: AggregateField.sum("price"), mean: AggregateField.average("price") })
db.collection("products").findNearest({ vectorField: "embedding", queryVector: [0.1, 0.2, 0.3], limit: 5, distanceMeasure: "COSINE" })
db.collection("products").where("price", ">", 10).explain({ analyze: true })
db.doc("users/alice").get()
db.doc("users/alice").listCollections()
db.listCollections()
db.collection("users").listDocuments()
db.getAll(db.doc("users/alice"), db.doc("users/bob"))
```

### 5.5 Numbers, times and field paths

An integral literal is an `integerValue` sent as its decimal digits, from -2^63 to 2^63-1; a literal with a fraction or an exponent is a `doubleValue`.
So `1.0` and `1e3` are doubles and `9007199254740993` is an exact integer; Firestore compares integers and doubles numerically, so a filter matches either.
`Timestamp.fromDate(new Date(s))` takes an RFC 3339 date-time with `Z` or an offset, or a date `YYYY-MM-DD` read as UTC midnight, and nothing else, so a statement never depends on the server's time zone.
`new Timestamp(seconds, nanos)` takes nanos from 0 to 999,999,999 and a time from 0001-01-01 to 9999-12-31; `new GeoPoint(lat, lng)` takes latitude from -90 to 90 and longitude from -180 to 180.
A string field path splits on `.`; a field whose name holds a `.` is written `new FieldPath("dotted.key")`, and a sampled column of such a field is named in that form, so the column name is the path `where()` reads back.
A value compared with `FieldPath.documentId()` is a document reference: a plain id resolves under the queried collection.
`null` and `NaN` take only `==` and `!=`.
A `runQuery` with no `limit` and no `findNearest` gets `.limit(100)` with a warning; a `limit` is at most 1,000, an `offset` at most 1,000, and `getAll` takes at most 1,000 references.
An aggregation carries no default limit, and its result warns that Firestore bills one read per 1,000 index entries it scans; an `offset` warns that every skipped document is billed.

### 5.6 Results

Documents answer `__name__` first (the path relative to `documents`), then the `select()` paths in order, or else every top-level field name across the result in UTF-8 byte order; more than 500 columns stop at 500 with a warning.
Each column's type is a Firestore type name, or `mixed(a|b)` when documents disagree; a column whose every value is a vector of one dimension is declared a vector column.

| REST value | Cell |
| --- | --- |
| `nullValue` | `null` |
| `booleanValue` | boolean |
| `integerValue` | a number within 2^53 - 1, else the exact digit string |
| `doubleValue` | a number; `NaN`, `Infinity` and `-Infinity` as those strings |
| `timestampValue` | the RFC 3339 string as sent |
| `stringValue` | string |
| `bytesValue` | `{ "bytesValue": "<base64>" }` |
| `referenceValue` | `{ "referenceValue": "users/alice" }`, relative inside this database, the full name otherwise |
| `geoPointValue` | `{ "geoPointValue": { "latitude": n, "longitude": n } }` |
| `arrayValue`, `mapValue` | an array or an object of cells |
| vector | `{ "__type__": "__vector__", "value": [n, ...] }` |

A field a document lacks and a stored null both show as NULL in the grid, so `where("nickname", "==", null)` matches stored nulls only.
`count()` and `aggregate()` answer one row keyed by the statement's keys.
`listCollections()` answers `id` and `path` rows in UTF-8 byte order.
`listDocuments()` answers `__name__` and `exists`, at most 100 rows with a warning when more exist.
`getAll()` answers the found documents in request order and names the missing ones in a warning; `doc().get()` on a missing document answers no rows and a warning.

### 5.7 Cancellation

Cancel aborts the in-flight request.

## 6. Schema introspection

### 6.1 The tree

The tree lists the database's top-level collections, with no container level.
Listing and counting read the collection ids, at most 10 requests of 1,000 ids each, and say so when that bound bites.
Activating a collection runs the generated preview, `db.collection("users").limit(100)`.

### 6.2 Field sampling

Expanding a collection samples 20 documents in `__name__` order, 20 billed reads, and shows dotted field paths to depth 3, at most 200, each with its type list and marked as sampled.
Past 200, the cut keeps the first 200 by the sorted column names, `new FieldPath(...)` names included, so a nested field written in that form sorts under `n` and not under its first segment.
Sampled fields appear only when a collection is expanded, because sampling bills a read per document, and they never reach a model or the MCP surface.
The inventory and plan mode read no document: each collection carries `__name__` only.

### 6.3 The Keys panel

A pattern is a path relative to `documents`; its complete segments name the level, and the text after the last `/` filters it.

| Level | Example | Answer |
| --- | --- | --- |
| Root | empty, or `us` | top-level collection ids as folders `users/` |
| Collection | `users/` | each document as the key `users/alice` and the folder `users/alice/`; a missing parent as a folder only |
| Collection with a partial id | `users/al` | stored documents whose id starts with `al` |
| Document | `users/alice/` | its subcollections as folders `users/alice/orders/` |

Root and document levels read the whole id list, sort it by UTF-8 bytes and page it, because Firestore promises no order for that listing.
A collection level lists in Firestore's own `__name__` order.
A collection level with a partial id cannot see missing parents, and says:

> A typed id lists stored documents only; parents that exist only through their subcollections appear when the collection is listed without one.

A level whose parent document id contains `:` cannot list its subcollections, and is refused before any request with the console statement that reads them.
A page whose documents are too large for the answer cap is refused with:

> These documents are too large to list this many at a time; list the level with a smaller count

A cursor from a listing Google no longer honours is refused with:

> This listing expired; list the level again

Google answers a page token it no longer honours, or one it cannot decode, with 400 `INVALID_ARGUMENT` and "invalid page token" (measured 2026-10-12 against a real project).
The emulator 1.22.0 answers a token it cannot decode with 500 `UNKNOWN` instead, and the panel shows that error as the emulator words it.

The panel counts a key and its folder as two entries, so "Listed n" reads twice the number of documents.

### 6.4 The Source tab

A document opens in three parts: "Data", its fields decoded as in section 5.6; "Document", the REST document verbatim; and "Subcollections", its subcollection ids.
A document whose id contains `:` shows the first two parts, and in place of the third a neutral statement, without the failure heading, of why its subcollections are not listed.

### 6.5 Generated statements

The tree's preview is `db.collection("users").limit(100)`, Generate Count Query writes `db.collection("users").count()`, and the Source tab offers `db.collection("users/alice/orders").limit(100)` for a subcollection; each parses back to the same path for every valid id.

### 6.6 Object edit (#789): nothing to write

Firestore declares no editable object kind and no write path; a document's Source tab is read-only.

### 6.7 No transactions: `endOpenQueryTransaction()` is absent

The provider opens no transaction, so it has none to end, and it does not implement `endOpenQueryTransaction()`.

## 7. Explain

The Explain button sends the statement with `explainOptions: { analyze: false }`: the plan only, billed as one read, and no query runs.
A console `.explain({ analyze: true })` runs the query and returns its execution statistics, billed as the query.
The panel draws one node per index used and the execution statistics as metrics, and shows every key it does not know rather than dropping it.
On a real project the plan names each index by `properties` and `query_scope`, and `analyze` adds `resultsReturned`, `executionDuration`, `readOperations` and `debugStats` with its billing details (measured 2026-10-12).
An ordinary run sends no background plan.
Explain is offered for queries, vector queries and aggregations; a document get, `getAll`, `listCollections`, `listDocuments` and a statement that already calls `explain` each answer their own sentence.

## 8. Billing

Firestore bills every document read, at least one per query, and a budget alerts but never caps.

| Surface | What it reads |
| --- | --- |
| Connect, Test Connection, health, pulse, fleet health | Production: the database resource, no document; emulator: one id page |
| Tree root listing and count | One id listing each, at most 10 pages |
| Field expand | 20 documents |
| Bulk describe (inventory, plan-mode walk) | No document |
| Collection preview | 100 documents |
| Keys panel, List more | One page: up to 500 documents, or one id listing |
| Keys panel, List all of this level | Up to 10,000 entries, about 5,000 documents, and it can be stopped |
| Source tab | One document plus one id listing |
| Console statement | At most 1,000 documents, 1,000 skipped by `offset`, 1,000 `getAll` references; aggregations one read per 1,000 index entries, `findNearest` one per 100 vector entries |
| Explain button | One read |
| Ordinary run | No background plan |
| Completions, generators, health, overview, monitoring | No request |

No statement re-reads the tree.
Enterprise edition bills 4 KiB read units instead of document reads.
The free quota (50,000 document reads a day) covers one database per project, the first one created, whatever its id.
On the no-cost Spark plan, a project that passes a product's no-cost quota has that product shut off until the quota resets, and Firestore's resets daily around midnight Pacific time, so a walk that spends the free reads stops the project's own apps from reading until then.

## 9. Monitoring & health

Health and pulse reuse the connect probe; the overview and the monitoring panels send no request.

## 10. Capabilities & labels

| Capability | Value |
| --- | --- |
| `queryLanguage` / `queryDialect` | `json` / `firestore` |
| `supportsExplain` / `explainFormat` | true / `firestore-explain`; on an emulator server false, with no format |
| `supportsResultPagination`, `supportsExternalQueryLimiting` | false |
| `supportsCreateTable`, `supportsInlineRowEdit`, `supportsTestDataGeneration`, `supportsTransactions`, `supportsMaintenance` | false |
| `enforcesReadOnly` | true |
| `containerLevels` | none |
| `objectKinds` | `collection` (relation), `document` (Keys panel, Source tab, JSON) |
| `keyScan` | separator `/`, opaque cursor, prefix pattern, no total, levels rooted at `collection`, 100 by default and 1,000 at most |

`READ_ONLY_ENFORCED.firestore` is true and `MCP_EXPOSABLE.firestore` is false; agent and MCP execution are BACKLOG B107.

## 11. Limits

| Limit | Value |
| --- | --- |
| Default `runQuery` limit | 100 |
| Largest `runQuery` limit | 1,000 |
| Largest `offset` | 1,000 |
| References per `getAll` | 1,000 |
| Aggregations per statement | 1 to 5 |
| `findNearest` limit | 1 to 1,000 |
| Query vector dimensions | 2,048 |
| Documents a field expand samples | 20 |
| Depth a sampled field path reaches | 3 |
| Fields a sample keeps | 200 |
| Result columns | 500 |
| Console text | 64 KiB |
| Console nesting depth | 32 |
| Console tokens | 10,000 |
| Keys page, default | 100 |
| Keys page, largest | 1,000 |
| Documents per collection-level listing | 500 |
| Documents per collection-level listing without a names-only mask | 50 |
| Id listing requests per level | 10 |
| Ids asked for per id listing request | 1,000 |
| Rows `listDocuments()` answers | 100 |
| Cursor envelope characters | 2,048 |
| Cursor envelope decoded bytes | 1,536 |
| Answer cap for queries, `batchGet` and `listDocuments` | 64 MiB |
| Answer cap for `get`, id listings, aggregations and the database resource | 4 MiB |
| Answer cap for token and metadata answers | 64 KiB |
| Grace past the query timeout | 5 s |

## 12. Error handling

Every sentence leads with Google's own message and reason where Google sends them.

| Answer | Studio error | What it says |
| --- | --- | --- |
| Token endpoint refusal | `AuthenticationError` | Google's `error_description`, never the assertion |
| Probe: Datastore mode | `DatabaseConfigError` | see below |
| Probe: Firestore API access disabled | `DatabaseConfigError` | see below |
| Emulator started in Datastore mode | `DatabaseConfigError` | the emulator was started in Datastore mode |
| 404 on the probe | `DatabaseConfigError` | project or database not found, naming both |
| 401 with a pasted access token | `AuthenticationError` | see below |
| 401 otherwise | `AuthenticationError` | the credential was refused |
| 403 `SERVICE_DISABLED` | `DatabaseConfigError` | the API is off on the project, with Google's activation link |
| 403 `USER_PROJECT_DENIED`, or no quota project on an authorized-user file | `AuthenticationError` | adds `run gcloud auth application-default set-quota-project <project>` |
| 403 on connect | `AuthenticationError` | the permission when Google names it, and `roles/datastore.viewer` as the read grant |
| 403 or 404 after connect | `QueryError` | the same, for this statement |
| 400 `FAILED_PRECONDITION` asking for an index | `QueryError` | Google's message, with the index creation link |
| 400 `INVALID_ARGUMENT` | `QueryError` | Google's message |
| 429 `RESOURCE_EXHAUSTED` | `QueryError` | quota or rate exhausted, with `Retry-After` when sent |
| `DEADLINE_EXCEEDED`, transport timeout | `TimeoutError` | past the connection's query timeout; an aggregation adds that Firestore stops aggregations at 60 seconds |
| An answer past its cap | `QueryError` | asks for a smaller `limit` or a `select` |
| 5xx | `QueryError` | the status and Google's message |

A query, an aggregation or a batch read whose stream fails after it began still answers 2xx, with Google's error as its last element.
Studio maps that error by its own code, as the table does, and never shows the documents before it as a whole answer.

> This database is in Datastore mode, which the Firestore API does not serve

> Firestore API access is off on this database; turn it on or connect through its MongoDB-compatible endpoint with the MongoDB connection type

> The pasted access token was refused; tokens from gcloud auth print-access-token last about an hour: paste a new one, or use a service-account key

## 13. Testing

Unit tests under `tests/unit/db/firestore/` drive every module through its seams with fakes.
`tests/integration/db/firestore-provider.test.ts` runs the real provider over captures of emulator 1.22.0 (`tests/fixtures/firestore/`, recorded by `tests/live/firestore-evidence.ts` from the plan `tests/live/firestore-evidence-plan.ts`) and over built answers for what the emulator cannot give: tokens, IAM, the database resource, index errors and Query Explain.
On 2026-10-12 a real project's `(default)` database answered as those built answers expect, checked by hand: the database probe, a token grant from a pasted service-account key and from the server's own identity, listings, queries, aggregations, Query Explain with and without `analyze`, an index error and an undecodable page token.
`e2e/firestore-connection.spec.ts` drives the dialog and `e2e/firestore-provider.spec.ts` browses a stub that replays the captures.
`tests/live/firestore-live-check.ts` runs the same plan against a running emulator:

    docker compose -f database-compose.yml up -d firestore firestore-seed
    FIRESTORE_EMULATOR_HOST=127.0.0.1:8380 bun tests/live/firestore-live-check.ts

## 14. Known limitations

Not supported in this version, each a BACKLOG entry: writes of any kind, Pipelines, Datastore mode, the MongoDB-compatible API (use the `mongodb` type), Firebase Auth user sign-in under Security Rules, service-account impersonation, regional endpoints, real-time listeners, agent statement execution and MCP, collection export, point-in-time reads, `limitToLast`, bytes literals in the console, a read budget meter, an absent-cell marker in the grid, full support for the Enterprise BSON types, and a CI job running the emulator.
An egress HTTPS proxy is not supported.

## 15. References

- Firestore REST API v1: https://cloud.google.com/firestore/docs/reference/rest
- Query Explain: https://cloud.google.com/firestore/docs/query-explain
- Firestore pricing: https://firebase.google.com/docs/firestore/pricing
- Firebase pricing plans, the Spark plan's quota shutoff: https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
- Security Rules and server libraries: https://firebase.google.com/docs/firestore/security/get-started
- Application Default Credentials: https://cloud.google.com/docs/authentication/application-default-credentials
- The Firestore emulator: https://cloud.google.com/firestore/native/docs/emulator
