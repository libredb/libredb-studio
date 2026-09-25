# Apache Kafka Provider

> Apache Kafka support for LibreDB Studio, read-only over the Kafka protocol through `@platformatic/kafka`.
> The editor text is a JSON read request, declared `queryLanguage: "json"` with `queryDialect: "kafka"`: one object that names a topic and where to start reading.
> Studio browses topics, partitions, consumer groups with their lag, brokers and configs, and reads messages by partition, offset or timestamp; it never produces, commits, joins a group or creates a topic.
> This document is the single reference for the Kafka provider: design, architecture, usage and tests.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `kafka` |
| **Family** | Stream (`src/lib/db/providers/stream/kafka/`), the first provider in that family |
| **Driver** | `@platformatic/kafka` 2.11.0, pinned exactly, pure TypeScript, loaded under Bun and Node alike ([§2.5](#25-the-client-and-why)) |
| **Query language** | `json` with `queryDialect: "kafka"`: a JSON read request of this product's own schema, not MongoDB's JSON ([§5.1](#51-the-read-request)) |
| **Default port** | `9092`, the port a stock broker listens on; the same number is the default under TLS, because a secured listener serves on whatever port its operator chose |
| **Connection pooling** | One `Admin`, one `Consumer` and one fetch `ConnectionPool` per connection, all closed by `disconnect()` ([§3.4](#34-one-client-per-connection-and-no-fetch-session)) |
| **Connection string** | Not supported: a Kafka client takes a bootstrap address, and no URI convention is read |
| **SSH tunnel** | Refused: a tunnel forwards one address, and a Kafka client reaches every broker at the address the broker advertises ([§4.5](#45-no-ssh-tunnel)) |
| **EXPLAIN** | None |
| **Writes** | None, and none are offered ([§6.3](#63-object-edit-789)) |
| **Transactions** | Not applicable; reads are read-committed ([§5.2](#52-result-shape)) |
| **Maintenance** | None |
| **Query cancellation** | None: a read is bounded by its limit, its budgets and its timeout, and there is no server-side evaluation to stop ([§5.5](#55-timeout-and-cancellation)) |
| **Verified against** | **Apache Kafka 4.3.1**, the official `apache/kafka:4.3.1` image, as a single KRaft node (`kafka`), a three-node KRaft cluster (`kafka-cluster`) and a TLS, SCRAM and authorizer broker (`kafka-auth`), all in `database-compose.yml`; the captures of [`tests/fixtures/kafka/README.md`](../../tests/fixtures/kafka/README.md) were taken on 2026-09-24 |
| **Source** | [`src/lib/db/providers/stream/kafka/`](../../src/lib/db/providers/stream/kafka/) |
| **Tests** | [`tests/integration/db/kafka-provider.test.ts`](../../tests/integration/db/kafka-provider.test.ts) + [`tests/unit/db/kafka/`](../../tests/unit/db/kafka/) |
| **Tracking issue** | [#1088, the approved design](https://github.com/libredb/libredb-studio/issues/1088), under [#424](https://github.com/libredb/libredb-studio/issues/424) |

---

## 1. Overview

Apache Kafka is a distributed log: producers append records to the partitions of a topic, and consumers read them back by offset.
It is not SQL-shaped: there are no tables, no rows a client updates, and no query language on the broker.
What a user browses is what the cluster holds: topics and their partitions, consumer groups and how far behind they are, and brokers and their configs.
The teams this product is built for run a message log next to their databases, which is why it ships here (#1088, section 1).

### Concept mapping

| Studio concept | Kafka concept |
|---|---|
| Relation (a row in the tree with columns) | A topic; its columns are the fixed fields of a read result ([§6.1](#topic-columns)) |
| Row | A message (`rowName` "Message") |
| Statement | One JSON read request ([§5.1](#51-the-read-request)) |
| Grouping folder | A consumer group, as a leaf with its lag in its source |
| Configuration object | A broker, with its configs in its source |
| Object source | The broker's own answers for that object, re-serialised with `JSON.stringify` |
| Container | None: `containerLevels: []`, the Elasticsearch and SQLite shape, because one connection is one cluster |

---

## 2. Architecture

### 2.1 Where it sits

```
src/lib/db/providers/stream/kafka/
├── index.ts               KafkaProvider extends BaseDatabaseProvider: lifecycle and composition only
├── client.ts              THE SEAM: the KafkaReadClient interface (read methods only), its types, KafkaError. No I/O
├── platformatic-client.ts The only file that imports @platformatic/kafka; holds the two raw calls
├── connection-options.ts  DatabaseConnection to the bootstrap address, tls and sasl, after validation
├── request.ts             Pure: the editor JSON to a ReadRequest
├── read.ts                Start offsets and the bounded fetch loop
├── decode.ts              Pure: key, value and header decoding
├── results.ts             Pure: decoded records to a QueryResult
├── groups.ts              Group listing, description and the pure lag function
├── objects.ts             Kind declarations and the object surface
├── monitoring.ts          Pure mappings from metadata, config and log-dir answers to the monitoring types
└── errors.ts              KafkaError category to the repository's error classes
```

Each module has one reason to change (#1088, section 3.5).
`index.ts` holds no wire vocabulary, no request parsing, no decoding, no result shaping, no lag arithmetic and no error table; it delegates each to the module that owns it.
`read.ts`, `groups.ts`, `objects.ts` and `monitoring.ts` receive a `Pick<KafkaReadClient, ...>` slice, never the whole client or the provider, and every high-level module depends on the `KafkaReadClient` interface, never on `platformatic-client.ts`.
Nothing outside this directory is imported from another provider: the Couchbase TLS mapping is the reference for `connection-options.ts` and not a dependency.
The host and port validators are the shared `validateHost` and `validatePort` of [`src/lib/db/http/endpoint.ts`](../../src/lib/db/http/endpoint.ts), not a copy.

### 2.2 Class hierarchy

```
DatabaseProvider (interface)
└── BaseDatabaseProvider
    └── KafkaProvider
```

`BaseDatabaseProvider` directly, as for MongoDB, Redis, Couchbase, Prometheus and LibreDB: a read request is not SQL, so nothing `SQLBaseProvider` adds would be true here.
A separate `StreamProvider` root beside `DatabaseProvider` was considered and set aside: every route under `src/app/api/db/` reaches one `DatabaseProvider`, and the v1 surfaces fit that contract (#1088, section 3.1).

### 2.3 What the base class gives for free

Connection-state bookkeeping, the configured query timeout, and the error logging every provider shares.
Nothing Kafka-specific lives in the base class.

### 2.4 Registration & lifecycle

The factory builds it through `createDatabaseProvider()` ([`factory.ts`](../../src/lib/db/factory.ts)) with a dynamic import, so no other engine loads this module, and the client library itself loads only when the first Kafka connection connects.
Its `DB_UI_CONFIG` entry draws it in `text-hue-green`, because Kafka's own mark is black, which is no identity hue, and `SHOWCASE_RANK` places it on the login showcase behind Prometheus and ahead of libSQL.
The constructor validates nothing and opens nothing, so a provider built only to read its declarations touches no socket.
`connect()` validates the connection ([§4](#4-connection)) before any client exists, builds the client, and reads the brokers once, forced past the client's cache, which proves a broker answers the protocol at that address with that credential.
A connect that fails after the client was built closes it again.
`disconnect()` closes the `Admin`, the `Consumer` and the fetch pool, and so does the factory's idle eviction.

### 2.5 The client, and why

`@platformatic/kafka` 2.11.0, used fetch-only, was chosen by a broker-side measurement before any code was written (#1088, section 3.2 and Appendix B).
Reading by partition, offset and timestamp through its `listOffsets`, `listOffsetsWithTimestamps` and a fetch registered no consumer group and never created `__consumer_offsets`, under Bun and Node.
Its `consume()` in MANUAL mode, with explicit offsets and `autocommit: false`, joins the group and leaves an `Empty` group registered after `close()`, so `consume()` is never called.
All four codecs, gzip, snappy, lz4 and zstd, decode with no native addon: snappy and lz4 come from WebAssembly, gzip and zstd from `node:zlib`, and the optional `@node-rs/crc32` falls back to WebAssembly.
`@confluentinc/kafka-javascript` was ruled out because its group-free `assign()` is a librdkafka native addon that fails under Bun, which runs this repository's tests, and `kafkajs` because it cannot read without joining a group and has had no functional commit since 2023.
The Next.js build keeps the package external (`serverExternalPackages` in `next.config.ts`), because its optional native CRC32C addon stops Turbopack; external, the library resolves the addon at run time and falls back to WebAssembly without it.
The package also needs `ajv` 8 at the top of `node_modules`, which the direct `ajv` dependency guarantees (`tests/unit/db/kafka/dependency-resolution.test.ts`).

Supported brokers: a read sends Fetch v13, the first version that names a topic by id (KIP-516), which Apache Kafka answers from 3.1 on.
The client's own README states Apache Kafka 3.5.0 to 4.2.0 as its supported range; this provider was verified against 4.3.1.
A broker whose Fetch range does not hold version 13 is refused at the first read with a `QueryError` naming its range, such as "This broker answers Fetch versions 0 to 12; a read sends Fetch 13, which Apache Kafka answers from 3.1 on".

---

## 3. Design decisions

### 3.1 A JSON dialect, not a third query language

The editor text is JSON, so the provider declares `queryLanguage: "json"` and names its kind of JSON with `queryDialect: "kafka"`, the rule Prometheus's design stated: `queryDialect` distinguishes kinds of JSON, and a new `queryLanguage` is for text that is not JSON (#1088, section 3.3).
The cost is the #427 bug class: a reader keyed on `"json"` alone treats the text as MongoDB.
Every reader of either field has a Kafka arm or a test pinning that its branch is correct for Kafka: a Kafka tab type rendered in Monaco's built-in `json` mode, a Kafka arm before the MongoDB arm in both generators, the MongoDB completion provider registered only where no JSON dialect is declared, and the gates below.
On a topic row both row menus withhold Profile, through `offersColumnProfiling`, Code Generator, through `offersCodeGeneration`, and Generate Test Data, because no kind declares `acceptsRowWrites`.
Code generation is withheld because the models it writes over a topic's fixed columns reject the rows a read returns: a `Date` timestamp against the ISO string, a record-typed value against text, base64 and the Confluent label.
Both menus also withhold Generate Count Query, through `offersCountQuery` (#702): a read request is JSON of its own dialect, with no count grammar.
The execution confirmation gate never asks on a Kafka connection: a read request cannot write, so the `kafka` row of `NON_SQL_DESTRUCTIVE_VOCABULARY` in `src/lib/db/destructive-commands.ts` names no operation and is the gate's whole answer, and a topic named `delete` or `drop` is never read as SQL.
No Monaco language and no JSON schema for the request are registered; a schema with completion and validation is recorded in `docs/BACKLOG.md`.
Widening the published `queryDialect` union breaks an external consumer's exhaustive switch over it, and that ships with a release note rather than a compatibility layer.

### 3.2 Read-only by construction (K4)

Two checks hold the guarantee, and both are required.
The seam guard, [`tests/unit/db/kafka/seam-guard.test.ts`](../../tests/unit/db/kafka/seam-guard.test.ts), fails the build if `@platformatic/kafka` is loaded anywhere in the repository but `platformatic-client.ts` and the fixture seed `docker/kafka/seed-binary.ts`, or if the provider calls a member of the library's objects outside this allowlist: `metadata`, `listTopics`, `describeConfigs`, `listGroups`, `describeGroups`, `listConsumerGroupOffsets`, `listOffsets`, `listOffsetsWithTimestamps`, `describeLogDirs`, `findCoordinator`, `listApis`, `close`, `connect` on the one-off `Connection` of a consumer-protocol group's description, `get` on the fetch `ConnectionPool`, and the two raw calls `consumerGroupDescribeV0` and `fetchV13`.
So `consume`, `commit`, `joinGroup`, `leaveGroup`, `Producer`, `createTopics`, `deleteTopics`, `alterConfigs`, `incrementalAlterConfigs`, `alterConsumerGroupOffsets` and `deleteRecords` cannot be written in the provider, and neither can an `autocreateTopics` other than the literal `false` or a Consumer `groupProtocol` other than `"classic"`.
Every member of the library classes the adapter holds is classified against the installed package as allowed, forbidden or unused, so a client version that adds a member fails the guard until someone classifies it.
The guard is syntactic: it catches an ordinary edit that reaches the library outside the adapter or calls a member outside the allowlist, and its docblock states the ways code written to hide a load or a call can pass it, which are stated rather than chased.
The second check is behavioural: the live harness snapshots the broker before and after its whole run (the topic and group lists, every partition's earliest and latest offsets, every group's committed offsets, the topic and broker configs, and on `kafka-auth` the ACLs) and fails on any difference, and it asserts that the broker log names no group-coordinator entry for the Consumer's group id, `libredb-studio-never-joined`, which the constructor requires and the broker never receives, and no automatic topic creation.
The diff catches a future client version whose read path starts joining a group, committing or writing, which the seam guard cannot see.

### 3.3 Never creating a topic

The broker's default `auto.create.topics.enable=true` is live: a metadata read of a missing topic with `autocreateTopics: true` created it in the measurement.
So `platformatic-client.ts` passes `autocreateTopics: false` on every metadata read, explicitly rather than by the client default, and a missing topic answers a `QueryError` saying the topic does not exist.

### 3.4 One client per connection, and no fetch session

One `Admin`, one `Consumer` and one fetch `ConnectionPool` are built from one options object per connection, and nothing else is built later but the one-off `Connection` a consumer-protocol group's description opens and closes in a `finally`.
A read never goes through the client's `Consumer.fetch`, for two measured reasons.
Its READ_COMMITTED filter reads a control batch's first record and an aborted range's end unguarded, inside the socket handler, so an answer that holds an empty control batch, which Kafka's log cleaner keeps of a producer's last marker, or an ABORT marker of a producer the answer does not list, beside a listed aborted transaction, throws there, and that fetch never settles.
And it keeps one fetch session per broker, which two fetches in flight at once collide on (INVALID_FETCH_SESSION_EPOCH, about a second a round with the client's retry delay).
So the adapter sends Fetch v13 itself, through the client's exported `fetchV13` module, on a connection its `ConnectionPool` holds to the leader's advertised address, READ_COMMITTED and sessionless (session id 0, epoch -1), with `currentLeaderEpoch: -1` so a read across a leader failover is not fenced.
The client parses that answer inside its own try and settles the call either way, so a compacted transactional topic reads in full; with no fetch session, reads that overlap run side by side; and the answer reaches only the adapter's own filter, the Java consumer's rule of [§5.2](#52-result-shape).
The consumer-protocol group description is the other raw call, ConsumerGroupDescribe (API 69) through the exported `consumerGroupDescribeV0`, because the client has no Admin method for it.
Both depend on exports the client does not document as public API; the seam guard pins them, and an Admin method for ConsumerGroupDescribe is requested upstream as a draft recorded in `docs/BACKLOG.md`.

### 3.5 A host that embeds the provider factory

The client handles some answers inside its socket handler, where an exception is uncaught.
The adapter keeps every input known to throw there away from the client: it refuses an internal topic ([§6.1](#kinds-folders-and-identity)) and a group that is not a consumer group ([§6.1](#consumer-groups-and-lag)) before the call, and a read's answer never reaches the client's READ_COMMITTED filter ([§3.4](#34-one-client-per-connection-and-no-fetch-session)).
A malformed answer, which a hostile broker can send ([§4.4](#44-the-broker-chooses-where-studio-connects-next)), can still throw there on the client's other calls: for example a consumer group member whose assignment is shorter than its version and count, which the client's `describeGroups` decodes unchecked.
In the standalone server, whose Next.js router server registers an `uncaughtException` handler, the exception is logged and that one call never settles until its timeout.
A host that embeds the package's provider factory, `createDatabaseProvider` or `getOrCreateProvider` from `src/exports/providers.ts`, in a Node process that installs no `uncaughtException` handler, ends the process instead.
Such a host should install a handler before it connects a Kafka provider to a broker it does not trust.

### 3.6 Measurements

Every number below is a constant the code uses, read back by [`tests/unit/db/kafka/provider-doc.test.ts`](../../tests/unit/db/kafka/provider-doc.test.ts), so a row that disagrees with the code fails the build.

| Constant | Value | What it bounds |
|---|---|---|
| `DEFAULT_QUERY_LIMIT` | `500` | The largest `limit` a read request takes, counted across its partitions; the default is 50 |
| `KAFKA_RESULT_BYTE_BUDGET` | `8388608` | Bytes (8 MiB) of record data the rows of a result hold: keys, values, header names and values, as the client hands them over after decompression ([§5.4](#54-bounds)) |
| `KAFKA_CELL_LIMIT` | `65536` | Characters (64 Ki) of rendered text in one cell ([§5.3](#53-decoding)) |
| `KAFKA_TOPIC_LIST_CAP` | `2000` | Topic names the tree and the inventory hold; past it the Topics count is a floor ([§6.1](#listing-counting-and-scale)) |
| `KAFKA_DEFAULT_PORT` | `9092` | The default bootstrap port |

A fetch waits at most 250 ms on the broker for new records, so an empty partition does not hold a request open.

---

## 4. Connection

### 4.1 Configuration fields

| Field | Used | Notes |
|---|---|---|
| `host` | Yes | The bootstrap broker: a hostname or an IP literal; anything carrying `:`, `/`, `@`, `%` or whitespace is refused before any socket opens, with a `DatabaseConfigError` that does not echo the value |
| `port` | Yes | Default `9092`; outside 1 to 65535 is refused the same way |
| `saslMechanism` | Optional | Labelled "SASL mechanism" in the dialog, a select offering None, `PLAIN`, `SCRAM-SHA-256` and `SCRAM-SHA-512`, with the hint "PLAIN and SCRAM require TLS" |
| `user` | With a mechanism | Sent only when a mechanism is chosen |
| `password` | With a mechanism | Sent only when a mechanism is chosen |
| `database` | No | No Database box renders: one connection is one cluster, so there is nothing to select |
| TLS panel | Yes | [§4.3](#43-tls) |
| SSH tunnel | No | The panel is hidden and a tunnel is refused ([§4.5](#45-no-ssh-tunnel)) |

The select is declared on the `kafka` entry of `DB_UI_CONFIG` (`fieldOptions`, `fieldLabels`, `fieldHints`) rather than chosen by a type test in the dialog.
`saslMechanism` is an optional, non-secret field of `DatabaseConnection`: it names how the password is checked, not a credential, so the connection store keeps it in the clear and a managed seed returns it while it withholds the password.
It is part of the provider cache key's credential frame (`credentialDigest` in `src/lib/db/provider-cache-key.ts`), because Kafka keeps SCRAM credentials per mechanism, so two connections that differ only in mechanism never share a provider.
A seed file takes it as a literal name ([`docs/SEED_CONNECTIONS.md`](../SEED_CONNECTIONS.md)).

One bootstrap address is enough: the client learns every broker from the metadata it answers, so a second address would help only when the first is down at connect time, and v1 takes one.

### 4.2 Authentication, and never in the clear (K3)

| `saslMechanism` | `user` and `password` | What happens |
|---|---|---|
| none | empty | No authentication |
| none | either set | Refused with a `DatabaseConfigError` naming the missing mechanism, never a silent drop of the credential |
| `PLAIN`, `SCRAM-SHA-256` or `SCRAM-SHA-512` | set | SASL with that mechanism, over TLS only |
| any mechanism | TLS mode `disable` | Refused with a `DatabaseConfigError` before any socket opens |

PLAIN sends the password in the clear, and a Kafka credential is usually cluster-wide, so SASL of any mechanism over plaintext is refused.
That is stricter than the Prometheus provider, which sends a credential over plain HTTP.
A CR, LF or NUL in `user` or `password` is refused with a `DatabaseConfigError` that names the field and never contains the value, and nothing is trimmed silently.
The client's protocol logger prints the first bytes of every request frame when `DEBUG` names it (`plt:kafka:protocol`, or `DEBUG=*`), and a SASL PLAIN frame carries the password, so `platformatic-client.ts` mutes that logger when it loads the client, while the client's own logger keeps its lines.
OAUTHBEARER, GSSAPI and AWS MSK IAM are not offered: a pasted bearer token expires within hours and v1 has no refresh flow (`docs/BACKLOG.md`).

### 4.3 TLS

| `ssl.mode` | What happens |
|---|---|
| `disable`, or no TLS panel | Plaintext; SASL is refused ([§4.2](#42-authentication-and-never-in-the-clear-k3)) |
| `require` | Encrypted, certificate not verified unless `rejectUnauthorized` is set |
| `verify-system`, `verify-ca`, `verify-full` | Certificate verified against the supplied CA or, without one, the runtime's trust store |

`ssl.caCert`, `ssl.clientCert` and `ssl.clientKey` reach the client as `ca`, `cert` and `key`, and `rejectUnauthorized = ssl.rejectUnauthorized ?? ssl.mode !== "require"`, the Couchbase rule written again here by the isolation rule (`docs/BACKLOG.md` D37).
With TLS on and a DNS name as the host, the client sends each connection's own host as its TLS server name (SNI) through its `tlsServerName` option, which SNI-routed listeners need; Node sends none without the option.
An IP literal is no legal server name, and Node 26, the production runtime, throws on one, so when the first metadata read shows a broker advertised by IP literal, the adapter rebuilds its clients without the option: a cluster that advertises IP literals is not routed by server name.
A handshake or verification failure is a `ConnectionError` carrying the Node error code, and no connection is retried without TLS.
A verification failure is known by any name Node gives a refused certificate, such as `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `DEPTH_ZERO_SELF_SIGNED_CERT` or `INVALID_PURPOSE`.
A client certificate the broker refuses, or none where the broker requires one, reads as a lost connection, not as a TLS failure: under TLS 1.3, which the `kafka-auth` fixture negotiates, a broker refuses a client certificate after the client's half of the handshake, and the client reports only that the connection closed, handing the socket's error, which carries the alert, to no caller.
A request upstream for the client to keep that error is drafted in `docs/BACKLOG.md`.
Each outcome is exercised by a real handshake against a local TLS server in [`tests/unit/db/kafka/tls-handshake.test.ts`](../../tests/unit/db/kafka/tls-handshake.test.ts), with certificates generated at test time and never committed, and the server-name rule under Node in a child process, because Bun sends a server name unasked.

### 4.4 The broker chooses where Studio connects next

A Kafka client connects to the addresses the broker advertises in its metadata, and authenticates to each with the connection's SASL credentials.
A hostile or misconfigured broker can therefore direct Studio, with its credentials, to any host and port.
This is stated, not mitigated: restricting advertised hosts to the bootstrap host's domain breaks legitimate clusters, since managed services advertise per-broker names.
Use TLS with `verify-full`, under which credentials reach only hosts whose certificate the configured CA vouches for; [`docs/SECURITY.md`](../SECURITY.md) records it with the limitation it widens.
An advertised address Studio cannot reach after the bootstrap succeeded is the most common Kafka connection failure behind Docker and NAT, and it is a `ConnectionError` naming the advertised host and port: "The broker advertised <host>:<port>, which this server cannot reach; the cluster's advertised listeners must be reachable from where Studio runs".

### 4.5 No SSH tunnel

A tunnel forwards one address, and the client reaches every broker at the address that broker advertises, which the tunnel does not carry, so the tunnel would carry the bootstrap connection only and every read would go to the advertised addresses directly.
The dialog hides the SSH panel for Kafka through `showSshTunnel: false`, while it keeps the TLS panel, and `buildConnection` writes `sshTunnel` only for a type that offers the panel (`offersSshTunnel`), so a tunnel left in the dialog's state by another connection is dropped.
A tunnelled connection that arrives another way, from a seed or the API, is refused before any broker request with a `DatabaseConfigError`: "Kafka does not run through an SSH tunnel: the tunnel forwards one address, and a Kafka client reads from every broker the cluster advertises, at the address the broker advertises. Connect to the brokers directly".
There the server opens the tunnel before the provider runs, so an unreachable bastion answers with its SSH error first.

---

## 5. Query interface

### 5.1 The read request

The editor text is one JSON object with a strict schema: an unknown key, a wrong type or a missing required key is a `DatabaseConfigError` naming the key, before any request.

```json
{ "topic": "orders", "from": "latest", "limit": 50 }
{ "topic": "orders", "partition": 0, "from": "earliest", "limit": 50 }
{ "topic": "orders", "partition": 0, "from": { "offset": "120" } }
{ "topic": "orders", "from": { "timestamp": "2026-09-23T00:00:00Z" } }
```

Each line above is one request; the editor sends its whole buffer as one.

| Key | Required | Meaning |
|---|---|---|
| `topic` | Yes | A string matching `^[a-zA-Z0-9._-]{1,249}$`, Kafka's legal topic name |
| `partition` | No | A whole number from 0 to 2147483647, Kafka's INT32; absent means every partition of the topic |
| `from` | No | Where each partition starts; default `"latest"` (below) |
| `limit` | No | A whole number from 1 to 500 (`DEFAULT_QUERY_LIMIT`), default 50, counted across all partitions; `"limit": null` is a wrong type, never the default |

The `from` forms:

- `"earliest"`: each partition from its earliest offset.
- `"latest"`: the last `limit` messages, each partition starting at the larger of its earliest offset and its latest offset minus `limit`.
- `{ "offset": n }`: requires `partition`; `n` is a non-negative whole number, or a digit string, because offsets are 64-bit, at most 9223372036854775807, Kafka's INT64.
  An offset written as a JSON number above 2^53 is refused with advice to write it as a digit string, because `JSON.parse` has already rounded it.
  An offset outside the partition's range is a `QueryError` naming the valid range.
- `{ "timestamp": "<ISO-8601>" }`: each partition from the first offset whose timestamp is at or after the instant, through `listOffsetsWithTimestamps`.
  The instant must carry a zone, because the server's zone and the browser's would read it differently; it must name a day its month has, because `Date.parse` rolls 2026-02-30 into March; and it must fall at or after 1970-01-01T00:00:00Z, because ListOffsets reads -1 and -2 ms as its latest and earliest sentinels.
  A partition with no message at or after the instant contributes no rows, and the result carries a warning naming those partitions.

Bound `params` are refused with a `DatabaseConfigError`: there is no binding, and ignoring them would run a different read from the one the caller built.
Text that is empty once whitespace is removed is refused with a `QueryError`, before the request is parsed.
Invalid JSON is refused with the fixed text "The read request is not valid JSON", never the parser's message, which under Node quotes the start of the text.
`supportsResultPagination` and `supportsExternalQueryLimiting` are both `false`, as on Redis and MongoDB, and `prepareQuery` is the base pass-through: the request carries its own limit.

A topic click in the tree writes and runs `{"topic": <name>, "from": "latest", "limit": 50}`, the action the labels name "Read Latest 50".
Generate Read Request opens `{"topic": <name>, "partition": 0, "from": "earliest", "limit": 50}` in a new tab: an offset of 0 lies before the earliest offset of almost every topic retention has trimmed, and the result's `offset` column then shows the offsets the `{"offset": n}` form can use.
It is one object, not a set of snippets: the tab's whole buffer is sent as one read request, and JSON has no comments to hold alternatives.
Format rewrites the request as indented JSON and reads the same request back: a digit-string offset stays a string.

Where a read starts and ends:

- Every partition a read covers must be named in each offsets answer it uses, the earliest and latest offsets and, for a timestamp read, the offsets at the timestamp; a partition an answer leaves out is refused with a `QueryError` naming the topic, the partition and the answer, before any fetch, and never started from an invented offset.
- A read stops at each partition's last stable offset, the end a read-committed fetch reaches, while a group's lag is measured to the high watermark ([§6.1](#consumer-groups-and-lag)); on a partition with an open transaction the two ends differ.
- The offsets are read one answer at a time, the earliest, then those at the timestamp, then the latest, so a record written while the read is positioned lies below the end it stops at.
  A timestamp read looks each partition up once, before it reads the end, so a message written after that lookup is not in the read even when it lies below the end.
- A transaction's COMMIT and ABORT markers and an aborted transaction's records use offsets but are never rows, so a `"latest"` read of a transactional topic, whose window is `limit` offsets per partition, can answer fewer than `limit` rows.
- Which messages a read answers: of each partition's first `limit` messages from its start in log order, or for `"latest"` those of its last `limit` offsets, the first `limit` in result order, or the last for `"latest"`.
  Result order is by timestamp, and a producer's CreateTime can go back along the log, so a message the read never fetched, beyond a partition's window, can have a timestamp that would have placed it among the rows.

### 5.2 Result shape

One row per record, with the fields `partition`, `offset`, `timestamp`, `key`, `key_encoding`, `value`, `value_encoding` and `headers`, in that order.

- Across partitions, rows are ordered by `timestamp`, then `partition`, then `offset`; within one partition that is log order only while timestamps rise with offsets, as under `LogAppendTime` or one producer's clock.
- `offset` is a decimal string, because offsets are 64-bit and a JavaScript number loses precision past 2^53; `partition` is a number.
- `timestamp` is an ISO-8601 UTC string with millisecond precision, the form the chart tab recognises as a date.
  It is the record's Kafka timestamp: the producer's CreateTime, or on a topic whose `message.timestamp.type` is `LogAppendTime`, the broker's append time, which the broker writes only into the batch's `maxTimestamp`, so the provider reads it from there as the Java client does.
  A record whose timestamp is the protocol's no-timestamp value, -1, has a null timestamp, never the instant one millisecond before the epoch.
  A timestamp outside the range a JavaScript `Date` holds is refused with a `QueryError` naming the partition, the offset and the timestamp.
- `headers` is an object from header name to decoded value, each name an own key, so a header named `__proto__` or `toString` is a header like any other; a name repeated in one record becomes an array in arrival order, so no header is lost.
  A header value of `null` stays `null`.
- Reads are read-committed: a COMMIT or ABORT marker is never a row, a record of an aborted transaction is dropped by the Java consumer's rule, including when the ABORT marker lies in a later response, and a marker still advances the read past its offset.
  An empty control batch, which the log cleaner keeps of a producer's last marker, marks nothing, and a marker whose key is not an int16 version and an int16 type, or whose version is negative, is refused with a `QueryError` naming its offset, never read as no marker.
- A result the provider bounded reports `wasLimited: true` with `hasMore: false` on its `pagination`: no offset can page a Kafka read.

### 5.3 Decoding

Applied in order to the key, to the value and to each header value; the first rule that matches wins.

1. `null` stays `null`, encoding `null`.
2. At least 5 bytes whose byte 0 is `0x00` is the Confluent wire format (magic byte 0, then a 4-byte big-endian schema id): the cell is `schema id <N>, not decoded`, encoding `confluent`.
3. Valid UTF-8 that `JSON.parse` accepts as an object or an array: the parsed value, encoding `json`.
4. Other valid UTF-8: the string, encoding `text`.
5. Anything else: base64 of the value's first bytes, as many whole 3-byte groups as fit in the cell limit beside the suffix, written `<base64> (<n> bytes)`, encoding `base64`; the byte length is always in the cell, and a cut value ends on a whole group.

Rule 2 comes before rule 3 because a Confluent-framed payload can itself be valid UTF-8, so a text value that happens to start with `0x00` is labelled `confluent`: a false positive, stated here rather than guessed around.
No Schema Registry is read and no Avro, Protobuf or JSON Schema payload is decoded; a framed value is labelled with its schema id, never guessed (`docs/BACKLOG.md`).
UTF-8 is checked with a fatal decoder, so invalid bytes are never shown as a replacement character, and with the byte order mark kept, so a value is shown as sent and two header names differing only by the mark stay two keys.
A value longer than four times `KAFKA_CELL_LIMIT` is judged on its first bytes only: rule 3 never applies to it, rule 4 checks that prefix, and rule 5 encodes a prefix, so no whole large value is turned into text before it is cut.
A header name is decoded as text, or as base64 when it is not valid UTF-8, never as JSON and never as a Confluent frame, so two names that look like JSON never collapse into one.
A cell whose text exceeds `KAFKA_CELL_LIMIT` is cut, never inside a UTF-16 surrogate pair, and the result carries a warning naming how many cells were cut and the limit.

### 5.4 Bounds

A fetch's `maxBytes` does not bound its answer: the broker always returns the first batch whole, and with `maxBytes: 1024` it returned a 900,000-byte record.
So the bounds are the provider's own, and each sets `wasLimited` when it cuts a read; the budget, the cell limit and a fetch that makes no progress also carry a warning naming what was cut.

- **The row limit**: a partition stops at `limit` of its records or at its end, and the result holds at most `limit` rows across partitions; a limit that leaves records unread sets `wasLimited` with no warning, because asking for `limit` rows is asking for that cut.
- **The result budget**, `KAFKA_RESULT_BYTE_BUDGET`, counts the record bytes of the rows the result holds, never a row the merge dropped: at every point of the read the result holds only the rows it would answer if the read ended there, a row that falls out of them is dropped as it falls out, and a record that sorts past them is never shaped.
  Each record is shaped once, as it arrives, and only its row is kept.
  The first record is always kept, so a read never answers nothing because one record is larger than the budget; such a record is decoded from its prefix only and cut to the cell limit.
- **Where the budget stops a read**: the partitions are read one after another, in the order the metadata lists them, each forward from its start, and the budget stops the whole read.
  So a read the budget stops answers the rows it held when it stopped, from the partitions read before the stop and the first rows of the one it stopped in, and none from a later partition, whose records are never fetched.
  A `"latest"` read can therefore miss the newest rows of the topic, even when those rows alone would fit the budget, and one the budget stops in the first partition it reads holds the oldest rows of that partition's window.
  Its warning names the offset it stopped before and each later partition with offsets left to read, a partition whose window holds only transaction markers included, since only reading it could tell.
  Answering the newest rows that fit instead would read every partition's window whatever the record size; that trade is recorded in `docs/BACKLOG.md`.
- **No progress**: a fetch that makes no progress below a partition's end stops that partition rather than spin, and the result names the partition, the offset it stopped at and its end.
- **The cell limit**, `KAFKA_CELL_LIMIT` ([§5.3](#53-decoding)).

**Accepted limitation: decompression before any bound (K5).**
The client decompresses every batch of a fetch answer whole, synchronously and with no output cap, before any provider bound applies, and the broker bounds only the compressed batch (`max.message.bytes` is "after compression").
So one answer can hold its compressed size times the codec's ratio in the one Studio process every user shares, measured at about 1,029 to 1 for gzip and 32,692 to 1 for zstd, and a hostile broker ([§4.4](#44-the-broker-chooses-where-studio-connects-next)) is bounded by neither, because the client buffers whatever frame length the broker announces.
A decompressed-size cap is requested upstream as a draft recorded in `docs/BACKLOG.md`; [`docs/SECURITY.md`](../SECURITY.md) records the limitation beside the advertised-address one.

### 5.5 Timeout and cancellation

A read runs under the connection's query timeout through an `AbortSignal`, and every other client call is bounded by the client's connect and request timeouts, set to the same value; a timeout is a `TimeoutError`.
Each step of a read also waits on the read's signal, so a read its timeout stops is answered at once, whatever it waited on, and sends no further fetch.
There is no `cancelQuery`: both routes detect cancellation by presence, a presence-detected method exists only where it does its job, and a read is bounded by its limit, its budgets and its timeout, with no long server-side evaluation to stop.

### 5.6 EXPLAIN

None: `supportsExplain` is `false`, and the plan view is not offered.

---

## 6. Schema introspection

### 6.1 The object surface (#789)

#### Kinds, folders and identity

No container level: the three kind folders hang directly under the connection row.

| Kind | Role | Path | Row name | Columns | Source | `status` |
|---|---|---|---|---|---|---|
| `topic` | `relation` | `[topic]` | the topic name | yes, fixed | partitions and configs | `offline` if any partition has no leader, else `under-replicated` if any partition's in-sync replicas are fewer than its replicas |
| `consumer_group` | `group` | `[groupId]` | the group id | no | the group and its lag | never |
| `broker` | `config` | `[nodeId]` | `<nodeId> <host>:<port>` | no | the broker's configs | never |

- Partitions are not a kind: the tree cannot nest children under an object, so a partition kind would be one flat folder holding every partition of every topic; partitions live in the topic's source, and a partition worth acting on surfaces as the topic's `status`.
- Lag is not a status: any threshold would be the product's invention, so lag lives in the group's source.
- Internal topics (`__consumer_offsets`, `__transaction_state`, `__share_group_state`) are neither listed nor readable.
  The listing leaves them out, and the client's metadata cache answers their names with nothing, while its `listOffsets` on one throws inside its socket handler, so a read or a source of an internal name is refused before the client is asked, with a `QueryError` such as: `Topic "__consumer_offsets" is internal to Kafka, and the client this provider uses drops internal topics from its metadata, so it is not readable here`.
- A partition with no leader is answered by Kafka with LEADER_NOT_AVAILABLE or LISTENER_NOT_FOUND, and the client throws on any partition error while keeping the whole answer on its error, so the adapter reads the metadata and the topic listing from that answer: the tree lists the topic `offline`, and the counts, the overview, health and storage keep working.
  The client reads a topic's offsets as a whole, so a read of that topic is refused with a `QueryError` naming the leaderless partitions, and its source shows its partitions without offsets and says why.
- The Brokers folder lists the live brokers only, because the Metadata answer names no broker that is down, and marks no controller: on KRaft the answer's controller id is a random live broker, and with dedicated controllers the controller is never a listed broker.
- A group's identity is its id, unique per cluster across both protocols, and a broker's is its node id.

#### Topic columns

A topic's columns are fixed, because they are the shape of a read result and not a schema the broker holds: `partition`, `offset`, `timestamp`, `key`, `key_encoding`, `value`, `value_encoding`, `headers`.
`describeObject([topic], "topic")` answers them after confirming the topic exists, and `describeObjects([], "topic", limit)` answers them for every listed topic from the listing read alone, one round trip.

#### Listing, counting and scale

One reader per kind feeds both `countObjects` and `listObjects`, so the count is the listed length.
Topics come from one listing, capped at `KAFKA_TOPIC_LIST_CAP`: past it the Topics count is a floor, which the tree badges `2,000+` from "one topic listing capped at 2,000 names", and the listing holds the first 2,000 in name order.
Past the cap plan mode grounds topics only, because the grounding walk stops at the first truncated batch, and with more consumer groups than the object budget leaves after the topics it reaches no broker (`docs/BACKLOG.md` B89).
A topic row carries no row count: latest minus earliest summed over partitions is an offset span, not a message count, because compaction, transaction markers and retention leave gaps, and publishing it as a count is the defect #424 records for Citus and TimescaleDB; the span appears only in the topic's source, labelled as such.
Listings are filtered by the principal's Describe ACL: a principal with no ACL gets an empty topic listing and an empty group listing with no error, so its tree is indistinguishable from an empty cluster, and the protocol gives the provider no way to tell the two apart.

#### Consumer groups and lag

Groups are listed with both types, classic and the Kafka 4 `consumer` protocol (KIP-848), because a listing with no type filter omits KIP-848 groups.
The listing keeps consumer groups only, by Kafka's own rule, the one `kafka-consumer-groups.sh --list` applies: a `consumer` group, or a `classic` group whose protocol type is `consumer` or empty.
Kafka Connect and Schema Registry coordinate through classic groups that are not consumer groups; they are not listed, the client would fail inside its socket handler decoding their member metadata as a subscription, and they have no committed offsets to show lag for.
A broker below ListGroups v5, such as Apache Kafka before 3.8, reports no group type, so its groups are listed as classic, and a Kafka 3.7 broker with the early-access KIP-848 protocol switched on can hold consumer-protocol groups that this reading cannot tell apart.
A classic group is described by `describeGroups`, and a `consumer` group by ConsumerGroupDescribe (API 69), because `describeGroups` reports a KIP-848 group as `Dead` while the broker says `Empty`, and API 69 refuses a classic one.
A group's existence is decided by the listing, because `describeGroups` answers `Dead` for a name that does not exist.
Lag per partition is the high watermark minus the committed offset, the log end `kafka-consumer-groups.sh --describe` measures against, for every partition of each topic the group has committed on or is assigned.
A partition with no committed offset shows lag as `null` with the note "no committed offset", never 0 and never the whole log, and a committed topic whose latest offsets cannot be read, an internal topic or one with a leaderless partition, keeps its rows with no latest offset and the reason.

### 6.2 Object source (#789)

Every source is JSON, serialised with `JSON.stringify`, `language: "json"`, `form: "complete"`, `origin: "rendered"`, whose shipped caption, "A structured definition, rendered here as JSON", is true of it.
Server text is data: a config value, a header value or a group member's client id is shown exactly as the broker sent it and cannot forge structure.

| Kind | Reads | Parts |
|---|---|---|
| `topic` | the topic's metadata, its earliest offsets and high watermarks, and its configs | Partitions: per partition `leader`, `leaderEpoch`, `replicas`, `isr`, `offlineReplicas`, `earliestOffset`, `latestOffset` and `offsetSpan`, "latest minus earliest, not a message count"; a partition an offsets answer leaves out shows `null` with a note, never 0; on a topic with a leaderless partition the offsets are not read, and the part says why. Configs: the entries whose source is not the default, each with its value, its source in Kafka's words and `readOnly` |
| `consumer_group` | the listing entry, the description, the committed offsets and the high watermarks | Group: its type, state, protocol or assignor, and members with client id, host and assignment. Committed offsets and lag: per topic and partition the committed offset, the latest offset and the lag |
| `broker` | the broker's configs | Every config with its value, its source and `readOnly`; an entry the broker marks sensitive answers `null` from the broker itself and is shown as "redacted by the broker" |

A name that does not exist answers a `QueryError` naming it, and an internal topic's name answers the refusal of [§6.1](#kinds-folders-and-identity).

### 6.3 Object edit (#789)

Nothing to write, and the absence is the product's, not the engine's.
Kafka has writes: a producer appends records, and the admin API creates and deletes topics, changes configs and resets a group's offsets.
This product declines them in v1 by decision (#1088, section 2), so no kind declares `acceptsRowWrites` or `acceptsSourceEdits`, and the provider never produces, commits an offset, joins a group or creates a topic.
The absence is `kafka`'s entry in `EXPECTED_EDIT_ABSTAINERS` (`tests/helpers/object-edit-expectation.ts`), and `tests/isolated/object-edit-declarations.test.ts` is what holds that entry and this section together.

---

## 7. Monitoring & health

Each surface reads the Kafka protocol only, and a surface that cannot give an honest number is left empty rather than filled.

| Method | Source | Notes |
|---|---|---|
| `getHealth()` | a metadata read of the brokers, forced past the client's cache, then the log directories | The forced read must succeed, or the mapped error is thrown; `databaseSize` is the overview's figure, the cache hit ratio "N/A", and no active connection count, because Kafka does not report one and absence differs from zero |
| `getOverview()` | the forced broker read, the topic listing, the configs of the lowest listed node id, and the log directories | `tableCount` is the exact topic count, internal topics excluded; `maxConnections` is that broker's `max.connections`, 0 ("no limit published") when the value is withheld or the configs are refused, and a value that is not a whole number is refused as a protocol error; `databaseSize` is the log-directory sum over every broker, labelled "on disk, all replicas, internal topics excluded", or "N/A" when that read is refused; `version` and `uptime` are "N/A", because the protocol reports neither a product version nor a start time |
| `getStorageStats()` | the log directories | One row per broker and log directory, `broker <id>: <path>`, with the summed partition sizes of the listed topics and a usage percentage where the broker reports its totals; `[]` when the read is refused |
| `getTableStats()` | none | `[]`: `TableStats.rowCount` is a required number, and a topic has no honest message count |
| `getSlowQueries()`, `getActiveSessions()` | none | `[]`, with the empty states "Kafka exposes no query log" and "Kafka does not report client sessions over its protocol" |
| `getIndexStats()` | none | `[]`: a topic has no index |
| `getPerformanceMetrics()` | none | Every metric absent; the panel renders unavailable |
| `getPoolStats()` | not implemented | The route detects it by presence and shows its fallback |

A principal without Describe on the cluster is refused the log directories, and one without DescribeConfigs on the cluster the broker configs, and each refusal degrades only its own figure; any other failure, and a refusal of any other read, still fails the panel.
The `operations` agent workflow reads these surfaces on every engine in both modes, so agent runs reach the broker through them too.

---

## 8. Maintenance

None.
`supportsMaintenance` is `false` and `maintenanceOperations` is empty, so `maintenanceControl()` places no control, and the required maintenance labels, worded true for Kafka, are never rendered.
A direct call of `runMaintenance` is refused with a `QueryError`.

---

## 9. Capabilities & labels

### `getCapabilities()` ([`index.ts`](../../src/lib/db/providers/stream/kafka/index.ts))

- `queryLanguage: "json"`, `queryDialect: "kafka"`.
- `supportsExplain`, `supportsCreateTable`, `supportsTransactions`, `supportsMaintenance`, `supportsInlineRowEdit`, `supportsResultPagination`, `supportsExternalQueryLimiting`, `supportsConnectionString`: all `false`.
- `tablesAreDerivedGroupings: false`: a topic is a relation the broker holds, unlike a Redis key prefix.
- `declaresForeignKeys: false`, `statementTerminator: "none"`, `defaultPort: 9092`, `containerLevels: []`, `maintenanceOperations: []`, and the three object kinds of [§6.1](#61-the-object-surface-789).
- `schemaRefreshPattern: "(?!)"`, which matches nothing: no read request changes what the tree shows, and the base class's SQL pattern would reload the whole tree after a read of a topic named like `orders-drop`.
- No `keyScan`: a topic listing is a catalog read, so there is no key browser and no Browse Keys.

### `getLabels()` ([`index.ts`](../../src/lib/db/providers/stream/kafka/index.ts))

`entityName` "Topic" and "Topics", `rowName` "Message" and "Messages", `selectAction` "Read Latest 50", `generateAction` "Generate Read Request", and the two empty-state sentences of [§7](#7-monitoring--health).
`statementLanguage` carries the read request's schema, because plan mode states it verbatim and it is the only fact about how a statement is written that plan mode's prompt carries per engine: the four keys, the `from` forms, the defaults, two examples, and that no other key is taken, that `offset` and `timestamp` go inside `from`, that the inventory's other columns are fields each message comes back with and not keys of the request, and that a read request reads one topic's messages, never a group's lag.
The integration test parses each example in it with the provider's own parser.

---

## 10. Error handling

Mapped from the protocol error name, the client's error code and the Node error code, never from text a broker wrote; where the client gives no code that tells two failures apart, the adapter reads the client's own fixed text, and live tests against local listeners catch a client upgrade that rewords it.

| Condition | Class |
|---|---|
| invalid request JSON, host, port or credential, SASL over plaintext, a credential with no mechanism, an SSH tunnel, bound params | `DatabaseConfigError`, never echoing a value |
| empty editor text | `QueryError` |
| an unknown topic ("Unknown topic <name>.") | `QueryError`: the topic does not exist |
| an internal topic | `QueryError`: internal to Kafka and not readable here |
| a partition with no leader | `QueryError` naming the leaderless partitions |
| `OFFSET_OUT_OF_RANGE` on a fetch | `QueryError` naming the partition's valid range |
| a broker whose Fetch range does not hold version 13 | `QueryError` naming the broker's range and the version a read sends |
| `NOT_LEADER_OR_FOLLOWER` on a fetch already retried once against the leader read again | `QueryError`: leadership moved during the read, run it again |
| an answer the client's parser cannot read, such as a batch that will not decompress | `QueryError` naming the parser's code, such as `Z_DATA_ERROR` |
| `TOPIC_AUTHORIZATION_FAILED`, `GROUP_AUTHORIZATION_FAILED`, `CLUSTER_AUTHORIZATION_FAILED` | `AuthenticationError` naming the resource type, never a credential |
| SASL authentication failure | `AuthenticationError`, never echoing the credential |
| TLS handshake or verification failure | `ConnectionError` carrying the Node error code |
| a bootstrap address that refuses, does not answer the connect in time, or closes the connection | `ConnectionError` carrying the Node error code, or `connect-timeout` or `connection-lost` where there is none |
| an advertised broker address Studio cannot reach after the bootstrap succeeded | `ConnectionError` naming the advertised host and port ([§4.4](#44-the-broker-chooses-where-studio-connects-next)) |
| a request the broker accepted and did not answer in time, and a read past the query timeout | `TimeoutError` |
| any other protocol error | `QueryError` naming the protocol error name, or the client's code where there is none, never the client's message, which can carry a host and port |

Which Node code a failure carries is the runtime's: TLS to a listener that answers in plaintext gave `ERR_SSL_WRONG_VERSION_NUMBER` under Bun and `ERR_SSL_PACKET_LENGTH_TOO_LONG` under Node, and an address with no route `ECONNREFUSED` under Bun and `ENETUNREACH` under Node, so each row reads a code by its form.
An error that did not come from the client, such as a defect in the provider's own mapping, is rethrown untouched, never dressed up as a broker's answer.

---

## 11. Testing

### 11.1 How the tests work

| File | Owns |
|---|---|
| [`tests/integration/db/kafka-provider.test.ts`](../../tests/integration/db/kafka-provider.test.ts) | The provider end to end over the real adapter, with the recorded library of `tests/helpers/kafka-fixtures.ts` injected through the constructor's `createClient` parameter, so only the broker is fake; the answers are the captures of `tests/fixtures/kafka/` |
| `tests/unit/db/kafka/` | One file per module: `client`, `connection-options`, `request`, `decode`, `results`, `read` (the fetch loop against a reference over generated logs), `groups`, `objects`, `monitoring`, `errors`, `platformatic-client` (the adapter over the recorded library, and sessionless fetches against a local broker), `provider` (the composition over a fake `KafkaReadClient`), `tls-handshake` (real handshakes, and live transport failures against local listeners), `seam-guard` (K4), `dependency-resolution` and `provider-doc` (this document against the code) |

No `mock.module()` anywhere in this suite: it is process-wide in Bun.
The captured answers live in [`tests/fixtures/kafka/`](../../tests/fixtures/kafka/), and its README says how each was taken, with the image digests and cluster ids.
TLS certificates are generated with `openssl` at test time into a temporary directory and never committed, and the TLS tests need `node` on the path: the server-name rule runs the library under Node in a child process.

### 11.2 Run it

```bash
# Just this provider, one process per file
bun tests/run-tests.ts tests/unit/db/kafka/request.test.ts tests/unit/db/kafka/read.test.ts tests/integration/db/kafka-provider.test.ts

# Everything, CI-equivalent
bun run test
```

### 11.3 The live fixtures

```bash
docker compose -f database-compose.yml up -d kafka kafka-init
bun docker/kafka/seed-binary.ts localhost:9092
docker compose -f database-compose.yml --profile kafka-cluster up -d
docker compose -f database-compose.yml --profile kafka-auth up -d kafka-auth
```

`kafka` (port 9092) is a single combined KRaft node, seeded by `docker/kafka/seed.sh` from its `kafka-init` sidecar and by `docker/kafka/seed-binary.ts` from the host: a 3-partition `orders` topic with keys, headers and JSON values, one topic per codec (`codec-gzip`, `codec-snappy`, `codec-lz4`, `codec-zstd`), a 900 KB record in `big`, a non-UTF-8 value and a Confluent-framed value in `bytes`, a `LogAppendTime` topic `ts-append`, a committed and an aborted transaction in `txn`, and the groups `lag-classic`, `lag-kip848` and `lag-partial`, the last with a partition that has no committed offset.
`kafka-cluster` is three nodes on ports 9192 to 9194 with every topic at replication factor 3, where several brokers and `under-replicated` are seen.
`kafka-auth` (port 19094) is TLS with SCRAM-SHA-512 and an authorizer; its principal `reader` is created after start with a password of your choice and no ACL, for the permission and plaintext refusals; the compose file's comment gives the commands.

### 11.4 The live read-only check

[`tests/live/kafka-read-only.ts`](../../tests/live/kafka-read-only.ts) runs a real `KafkaProvider` over every surface against the fixtures above and fails on any change to the broker's state; the runner skips `tests/live/`, so it runs by hand.

```bash
bun tests/live/kafka-read-only.ts --tripwire        # recreates and re-seeds kafka first
bun tests/live/kafka-read-only.ts --redpanda
bun tests/live/kafka-read-only.ts --bootstrap localhost:9192
bun tests/live/kafka-read-only.ts --bootstrap localhost:9192 --failover
```

It snapshots the broker before and after the run: the topic and group lists, every group's committed offsets, every partition's earliest and latest offsets, the topic and broker configs, and on `kafka-auth` the ACLs, through the broker's own tools (`rpk` on Redpanda).
Each line of the snapshot carries the tool that printed it and the block it sits under, such as `All configs for topic orders are:`, before the lines are sorted, and the two snapshots must hold the same lines the same number of times: twelve topics print the same default config line, so a line compared without its topic could change hands unseen.
Between the two it runs the counts, the three listings and one source of each kind, a read in every `from` form and of each seeded topic, the refusals of a missing topic, an out-of-range offset and `__consumer_offsets`, the three panels, the group listing and each group's lag against the broker's own CLI, two `metadata([])` calls counted as two Metadata frames at a forwarder, a bootstrap at `::1`, a read through a bootstrap forwarder that sends no Fetch frame through it, three reads at once, and the process's sockets after `disconnect()`.
With `--tripwire` it first reads every seeded topic on a broker never asked for a group coordinator and checks that `__consumer_offsets` is still absent.
Its log searches for an automatic topic creation and for the never-joined group id are each paired with a control that finds that kind of line in the broker's whole log.

Measured on 2026-09-25: every check passed on `kafka` (57, with the tripwire), on `redpanda` (39), on `kafka-cluster` (47), and on `kafka-auth` as `reader` (7), and every snapshot after a run equalled the one before it.
Against the provider with one rule broken at a time, the check failed each time: a `disconnect()` that closes nothing, `autocreateTopics: true`, a `metadata([])` answered from the cache, lag that ignores the committed offset, a transaction filter that keeps aborted records, a group listing without the `consumer` type, and a lag listing that shows one partition twice.
A config write made during the run from outside the provider, setting `orders` to the `compression.type=gzip` line `codec-gzip` already holds, failed the check too; the check as first committed, which compared bare lines as a set, passed it.

#### Redpanda

Redpanda v26.2.2 is a full relative of this provider ([README](./README.md#wire-compatible-engines)): every surface answered, with data wherever Kafka held data, and the broker's state was unchanged by the run.
Four things read differently from Kafka.
Max connections reads 0, no limit published, because Redpanda's DescribeConfigs answer for a broker holds no `max.connections`.
That answer holds nine entries where Kafka 4.3.1's holds 340, so a broker's source is short.
The Storage panel shows no usage percentage, because its DescribeLogDirs answer carries no total or usable bytes.
Every group reads as classic, which is right there: Redpanda answers ListGroups up to v4, which carries no group type, and has no KIP-848 consumer protocol.

#### Result size (KM2)

Measured in a browser against `bun dev` on 2026-09-25: `{"topic":"big","from":"earliest","limit":1}` answered one row whose value was cut at `KAFKA_CELL_LIMIT`, 65,984 bytes on the wire; `{"topic":"orders","from":"earliest","limit":500}`, over records of about 2 KB each, answered 500 rows in 966,938 bytes, rendered 67 ms after the response arrived, and the grid scrolled at a mean of 47 ms a step.
The grid stayed responsive for both, so `KAFKA_RESULT_BYTE_BUDGET` and `KAFKA_CELL_LIMIT` keep the values of [§3.6](#36-measurements).

#### Several brokers, under-replication and offline partitions (KM8)

On `kafka-cluster` the Brokers folder lists nodes 1, 2 and 3, each partition of `orders` is read from its own leader, and lag on the three groups equals `kafka-consumer-groups.sh --describe`.
With node 3 stopped, `orders` reads as `under-replicated`, the Brokers folder lists nodes 1 and 2, every partition of `orders` still reads, including one whose leader moved off node 3, and the three panels answer; after the restart every topic is `ok` again, and the broker's state before the stop equalled its state after the restart.
`offline` was reached on a throwaway single node with two log directories whose second directory was made unreadable: the partitions on it went offline within about 10 seconds.
There the Topics listing shows the topic `offline`, its source shows its partitions with no offsets, a read of it is refused naming the leaderless partitions, and a read of a healthy topic still answers.
The three panels do not answer there: the broker answers DescribeLogDirs for the failed directory with `KAFKA_STORAGE_ERROR`, and the overview, health and storage fail with that error (`docs/BACKLOG.md` D125).

---

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from "@/lib/db/factory";

const provider = await createDatabaseProvider({
  id: "events",
  name: "Kafka",
  type: "kafka",
  host: "kafka.internal",
  port: 9093,
  saslMechanism: "SCRAM-SHA-512",
  user: "reader",
  password: process.env.KAFKA_PASSWORD,
  ssl: { mode: "verify-full" },
});

await provider.connect();

const result = await provider.query('{"topic": "orders", "from": "latest", "limit": 50}');
console.log(result.fields, result.rows.length);

const groups = await provider.listObjects([], "consumer_group");
await provider.disconnect();
```

### 12.2 Over the API

```bash
curl -X POST http://localhost:3000/api/db/query \
  -H 'Content-Type: application/json' \
  -H 'Cookie: auth-token=<jwt>' \
  -d '{"connectionId":"seed:events-kafka","sql":"{\"topic\": \"orders\", \"from\": \"earliest\", \"limit\": 10}"}'
```

`seed:events-kafka` is the Kafka seed example of [`docs/SEED_CONNECTIONS.md`](../SEED_CONNECTIONS.md); an inline `connection` object works as well.
See [`docs/API_DOCS.md`](../API_DOCS.md) for the full request and response contract.

---

## 13. Known limitations & future work

- **The broker chooses further hosts, with the connection's credentials** ([§4.4](#44-the-broker-chooses-where-studio-connects-next)), and a Kafka connection takes no SSH tunnel ([§4.5](#45-no-ssh-tunnel)).
- **The client decompresses a whole answer before any bound applies** ([§5.4](#54-bounds)).
- **A malformed answer can end a host process with no `uncaughtException` handler** ([§3.5](#35-a-host-that-embeds-the-provider-factory)).
- **A read the budget stops answers older rows than the newest that would fit** ([§5.4](#54-bounds)).
- **Past `KAFKA_TOPIC_LIST_CAP` topics, plan mode grounds topics only** (`docs/BACKLOG.md` B89).
- **A principal with no Describe ACL sees an empty cluster**, with no error to tell it apart ([§6.1](#listing-counting-and-scale)).
- **No OAUTHBEARER, GSSAPI or AWS MSK IAM** ([§4.2](#42-authentication-and-never-in-the-clear-k3)).
- **No Schema Registry decoding**, so Avro, Protobuf and JSON Schema values show their schema id ([§5.3](#53-decoding)).
- **No live tail, no streaming results and no push subscriptions.**
- **No ksqlDB and no SQL over Kafka**: ksqlDB's licence forbids offering it as a competing service, most clusters do not run it, and its queries create server-side groups and topics; SQL over Kafka, if ever wanted, is a separate type-id.
- **No agent execute mode for read requests**, out of scope for the whole #424 epic; plan mode grounds through the object surface and drafts a read request for the user to run.
- **A client certificate the broker refuses reads as a lost connection** ([§4.3](#43-tls)).
- **A broker with a failed log directory fails the overview, health and storage panels** with `KAFKA_STORAGE_ERROR`, where the rest of the object surface keeps working ([§11.4](#114-the-live-read-only-check), `docs/BACKLOG.md` D125).

---

## 14. References

- Source: [`src/lib/db/providers/stream/kafka/`](../../src/lib/db/providers/stream/kafka/)
- Design: [#1088](https://github.com/libredb/libredb-studio/issues/1088)
- Client: [`@platformatic/kafka`](https://github.com/platformatic/kafka), version 2.11.0
- Kafka protocol: <https://kafka.apache.org/protocol>
- KIP-848, the consumer group protocol: <https://cwiki.apache.org/confluence/display/KAFKA/KIP-848%3A+The+Next+Generation+of+the+Consumer+Rebalance+Protocol>
- KIP-516, topic identifiers: <https://cwiki.apache.org/confluence/display/KAFKA/KIP-516%3A+Topic+Identifiers>
