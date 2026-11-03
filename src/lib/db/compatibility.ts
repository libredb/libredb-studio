/**
 * Wire-compatibility registry (issue #424, Phase 0).
 *
 * Some engines speak the wire protocol of a driver we already ship, so they work
 * through an existing provider with no code of their own. This module is the one
 * place that records which ones, and it deliberately records only what a live
 * probe measured:
 *
 * - `probedVersion` is the version string the engine itself reported during a
 *   gate-4 probe. It is not a supported range and not a guess. An entry without
 *   one fails the unit tests, which is how #424's claim discipline ("connects is
 *   not supported") is enforced rather than merely written down.
 * - `tier` exists because the probes refuted the assumption behind a boolean.
 *   Citus answers all fifteen introspection surfaces; Materialize answers none of
 *   them while still running SQL fine. Both "work", and publishing them under one
 *   word would be the overclaim the issue warns about.
 * - `caveats` are what the probe found broken or misleading, in the user's terms.
 *
 * Two consumers read this: the connection dialog (so a MariaDB user knows to pick
 * MySQL) and the compatibility table in `docs/providers/README.md`. Neither may
 * hold its own copy of the data.
 */
import type { DatabaseType } from "@/lib/types";
import type { WriteReach } from "./write-reach";

/**
 * The drivers we ship, i.e. the engines that have a provider, a doc page and an
 * integration test of their own. Kept here beside the registry because the
 * published count is "shipped drivers + verified relatives" and both halves must
 * come from the same module or they drift.
 */
const SHIPPED: Readonly<Record<DatabaseType, true>> = Object.freeze({
  postgres: true,
  bigquery: true,
  snowflake: true,
  spark: true,
  mysql: true,
  sqlite: true,
  // libSQL (#424 Phase 5): its own provider, doc and integration test. A separate
  // driver from `sqlite` rather than a relative of it - the two share a dialect and
  // nothing else, since one holds a file handle and the other speaks HTTP.
  libsql: true,
  // DuckDB (#424): its own provider, doc and integration test. It is a driver rather
  // than a relative of anything - it speaks no PostgreSQL or MySQL wire protocol, and
  // there is no wire at all, so no engine can be compatible with it by pretending to
  // be it. Nothing is recorded as a relative below for that reason.
  duckdb: true,
  oracle: true,
  // IBM Db2 LUW (#786): its own provider, doc and integration test. Db2 for z/OS and for IBM i
  // speak the same DRDA protocol and are recorded below as relatives only once a gate-4 probe has
  // measured each, never because the protocol answers.
  db2: true,
  mssql: true,
  clickhouse: true,
  druid: true,
  trino: true,
  // Apache Cassandra (#424 Phase 4). ScyllaDB speaks the same CQL wire and is
  // recorded as a relative below: the gate-4 probe ran on 2026-08-21/22 and measured
  // eight of this provider's thirteen surfaces answering, with the five that read
  // Cassandra's `system_views` virtual tables failing because ScyllaDB has no such
  // keyspace. All thirteen answer since 2026-08-24 - re-probed then - but the five
  // answer EMPTY, which is why the tier below is still `partial`.
  cassandra: true,
  // Two ids served by ONE provider module (`providers/sql/search/`), which is the
  // first time "shipped" here does not mean one provider file per id. They are still
  // two entries because the tri-sync invariant is per type-id - each has its own doc
  // page and its own integration test - and because the published count counts what
  // a user can pick, not how the code is laid out.
  elasticsearch: true,
  opensearch: true,
  mongodb: true,
  couchbase: true,
  redis: true,
  // Prometheus (#1085): its own provider, doc and integration test, and the first member of
  // the `timeseries/` family. A relative that speaks the same HTTP API is recorded below only
  // once a gate-4 probe has measured one, never because the API answers.
  prometheus: true,
  // Apache Kafka (#1088): its own provider, doc and integration test, and the first member of the
  // `stream/` family. A broker that speaks the same protocol is recorded below as a relative only
  // once a gate-4 probe has measured one, never because the protocol answers.
  kafka: true,
  // etcd (#1089): its own provider, doc and integration test, and the second member of the `keyvalue/`
  // family. kine and Xline speak etcd's API and are recorded below as relatives only once a gate-4
  // probe has measured each, never because the API answers.
  etcd: true,
  // Neo4j (#424): its own provider, doc and integration test, and the first member of the `graph/`
  // family. Memgraph speaks Bolt and Cypher and is recorded below as a relative only once a gate-4
  // probe has measured it, never because the protocol answers.
  neo4j: true,
  // Milvus (vector-family spec 5): its own provider, doc and integration test, and the first member of the
  // `vector/` family. Zilliz Cloud speaks the same API and is recorded nowhere until a test cluster passes gate 4.
  milvus: true,
  // Qdrant (vector-family spec 6): its own provider, doc and integration test, a member of the `vector/` family.
  // Qdrant Cloud speaks the same API and is recorded nowhere until a test cluster passes gate 4 (vector-family spec 6.2).
  qdrant: true,
  // Weaviate (#1566): its own provider, doc and integration test, the third member of the `vector/` family. Weaviate
  // Cloud and DigitalOcean Managed Weaviate are recorded nowhere until a test cluster passes gate 4 (spec 8).
  weaviate: true,
  // InfluxDB (InfluxDB spec I2): its own provider class, doc and integration test; the first of two type-ids served by
  // `timeseries/influxdb/`, one per query language. InfluxDB Cloud, Clustered and Enterprise 1.x are claimed nowhere
  // until a gate-4 probe measures one.
  influxdb: true,
  // InfluxDB 3 (InfluxDB spec I2): its own provider class, doc and integration test, sharing the connection layer of
  // `timeseries/influxdb/` with `influxdb`. A different engine generation (Rust, Arrow, DataFusion), counted as its
  // own engine.
  influxdb3: true,
  // Oxia (#424): its own provider, doc and integration test, read over its gRPC client API (DECISIONS O2).
  oxia: true,
  // Databend: its own provider, doc and integration test, read and written over its HTTP query API.
  databend: true,
  // S3-compatible object storage: its own provider, doc and integration test, read over the S3 REST API.
  s3: true,
  // Kubernetes: its own provider, doc and integration test, the first member of the `platform/` family: a cluster read
  // over the API server's REST API, beside the databases rather than one of them.
  kubernetes: true,
  // MQTT (#1635): its own provider, doc and integration test. A broker rather than a store, and the first
  // engine here whose read cannot be proved complete, which the provider states on every read rather than
  // hiding. No relative is recorded: every broker speaks the same standard, and a standard is not a
  // compatibility claim about a product.
  mqtt: true,
  // Firestore: its own provider, doc and integration test, read over Firestore REST v1 by a client of this
  // repository's own. Native mode only; no relative is recorded.
  firestore: true,
  // RabbitMQ (#1656): its own provider, doc and integration test, the second member of the `stream/` family. A
  // service that speaks the same management API is recorded below as a relative only once a gate-4 probe has measured
  // one, never because the API answers.
  rabbitmq: true,
  // OPC UA (#1677): its own provider, doc and integration test, the first member of the `industrial/` family.
  // A plant's address space rather than a store, read through a client seam that names eight read services, so
  // the read-only guarantee is a type rather than a setting.
  opcua: true,
  // MTConnect (#1722): its own provider, doc and integration test, the second member of the `industrial/` family.
  // An agent's device model and its observations rather than a store, read through a request table of nine routes
  // that are all GET, so the read-only guarantee is a type rather than a setting.
  mtconnect: true,
  modbus: true,
  netconf: true,
  snmp: true,
  // Eclipse Sparkplug B (#1720): its own provider, doc and integration test, the third member of the
  // `industrial/` family. An MQTT broker's published certificates and data rather than a store, and the
  // read-only guarantee is the absence of code: the encoder has no function that writes a PUBLISH.
  sparkplug: true,
  libredb: true,
});

/**
 * Derived from an exhaustive Record on purpose. As a hand-written array this was
 * the one mandatory registration surface in the codebase with no guard at all: a
 * new type-id omitted here made the published count undercount, nothing failed,
 * and the unit test that checked the count read the same constant on both sides.
 * With the Record the compiler refuses the omission, which is the same technique
 * `src/lib/sql/fence-tags.ts` already uses over this union.
 */
export const SHIPPED_DATABASE_TYPES: readonly DatabaseType[] = Object.freeze(Object.keys(SHIPPED) as DatabaseType[]);

/**
 * Which shipped ids are databases a user already runs, and which one is not.
 *
 * `libredb` is the embedded store this app carries with it; every other id is an
 * external engine you point the product at. Everything published as a database
 * count means the external set - README.md's "<N> drivers reach <M> named
 * engines", the login hero's engine claim - so the split needs a
 * definition somewhere, and it belongs beside `SHIPPED` rather than in the UI that
 * prints it. That is the same reason `SHIPPED` itself lives here.
 *
 * An exhaustive Record again, so a new type-id cannot join without someone
 * answering the question. The alternative - filtering `libredb` out by name at each
 * call site - is how the two halves of a published count drift apart.
 */
const EXTERNAL: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  postgres: true,
  bigquery: true,
  snowflake: true,
  spark: true,
  mysql: true,
  sqlite: true,
  libsql: true,
  // The user's own file, opened from a path they give us - the same reading as
  // `sqlite` below, and external for the same reason.
  duckdb: true,
  oracle: true,
  // A server the user already runs, reached over DRDA.
  db2: true,
  mssql: true,
  clickhouse: true,
  druid: true,
  trino: true,
  cassandra: true,
  elasticsearch: true,
  opensearch: true,
  mongodb: true,
  couchbase: true,
  redis: true,
  // A server the user already runs, reached over its HTTP API.
  prometheus: true,
  // A cluster the user already runs, reached over the Kafka protocol.
  kafka: true,
  // A cluster the user already runs, reached over etcd's gRPC API.
  etcd: true,
  // A server the user already runs, reached over Bolt.
  neo4j: true,
  // A server or cluster the user already runs, reached over Milvus's gRPC API.
  milvus: true,
  // A server or cluster the user already runs, reached over Qdrant's REST API.
  qdrant: true,
  // A server or cluster the user already runs, reached over Weaviate's REST API (and GraphQL below 1.39.7).
  weaviate: true,
  // A server the user already runs, reached over InfluxDB's v1 HTTP API.
  influxdb: true,
  // A server the user already runs, reached over InfluxDB 3's HTTP SQL API.
  influxdb3: true,
  // A server or cluster the user already runs, reached over Oxia's gRPC client API.
  oxia: true,
  // A self-hosted server or a Databend Cloud warehouse, reached over its HTTP query API.
  databend: true,
  // A server or service the user already runs, reached over the S3 REST API.
  s3: true,
  // A cluster the user already runs, reached over the Kubernetes API server's REST API.
  kubernetes: true,
  mqtt: true,
  // A Firestore database the user already runs in Google Cloud, or the emulator the server names.
  firestore: true,
  // A broker the user already runs, reached over its management API and AMQP 0-9-1.
  rabbitmq: true,
  // A server the plant already runs, reached over opc.tcp at one endpoint the reader types.
  opcua: true,
  // An agent the plant already runs, reached over HTTP at one address the reader types.
  mtconnect: true,
  modbus: true,
  netconf: true,
  snmp: true,
  // A broker the plant already runs, reached over MQTT at one address the reader types.
  sparkplug: true,
  // The one false entry. SQLite is a file rather than a server and is still
  // external: it is the user's file, opened from a path they give us. libredb is
  // ours, created by this app, so it is the only id that answers no here.
  libredb: false,
});

/**
 * The shipped ids that are databases a user already runs, in registry order.
 *
 * Also the DENOMINATOR the outward-facing catalog copy is counted against:
 * `tests/unit/lib/catalog-copy-engine-count.test.ts` compares this length with every
 * numeral qualifying "engines" in each storefront file its `COPY_FILES` lists, which until
 * #D47 were only ever corrected by somebody noticing.
 */
export const EXTERNAL_DATABASE_TYPES: readonly DatabaseType[] = Object.freeze(
  SHIPPED_DATABASE_TYPES.filter((type) => EXTERNAL[type]),
);

/** True for every shipped id except the embedded store. */
export function isExternalDatabaseType(type: DatabaseType): boolean {
  return EXTERNAL[type] === true;
}

/** A total record with every value mapped, keyed exactly as the record it was mapped from. */
function mapEntries<K extends string, V, W>(record: Readonly<Record<K, V>>, map: (value: V) => W): Record<K, W> {
  return Object.fromEntries(Object.entries<V>(record).map(([key, value]) => [key, map(value)])) as Record<K, W>;
}

/**
 * What Studio can write on each shipped engine, one of `WriteReach`'s three values (`./write-reach.ts`): `none`, no
 * code in the provider can send a write on any write path; `guarded`, every write path it has is refused by a named
 * gate while read-only mode holds; `open`, at least one path sends a write no Studio gate refuses. A fact about
 * Studio's code, not about the engine or the role a connection signs in as. The static answer
 * `summarizeWriteReach(ProviderCapabilities.writeReach)` gives once a provider is built.
 *
 * Static because its readers decide before a provider exists, as `READ_ONLY_ENFORCED`'s do, which is derived from it
 * below. An exhaustive Record for the reason `EXTERNAL` gives, so a new type-id cannot join without someone answering,
 * and `tests/unit/db/write-reach-capability.test.ts` holds every entry equal to what that engine's provider declares,
 * and holds a `none` provider to declaring no write capability on any path. Frozen like the records above it.
 *
 * It is not an MCP criterion and no MCP code reads it: whether a machine client may read an engine is
 * `MCP_EXPOSABLE`'s answer, which holds on every engine whatever its reach.
 */
export const WRITE_REACH: Readonly<Record<DatabaseType, WriteReach>> = Object.freeze({
  postgres: "open",
  bigquery: "open",
  snowflake: "open",
  spark: "open",
  mysql: "open",
  sqlite: "open",
  libsql: "open",
  duckdb: "open",
  oracle: "open",
  db2: "open",
  mssql: "open",
  clickhouse: "open",
  // Druid native SQL refuses a write, but that is the engine's grammar: Studio sends the statement the editor holds.
  druid: "open",
  trino: "open",
  cassandra: "open",
  // As Druid: the SQL grammar has no write, and Studio sends whatever the editor holds.
  elasticsearch: "open",
  // As Elasticsearch, and the server's own DELETE can be switched on in 2.x.
  opensearch: "open",
  mongodb: "open",
  couchbase: "open",
  redis: "open",
  // No write path in the code, but recorded open until its proof test and live measurement land.
  prometheus: "open",
  // As Prometheus.
  kafka: "open",
  // The first engine that keeps the mode (#1089 E6): its provider refuses every write command, value edit
  // and maintenance operation before any request while the mode holds (`write-policy.ts`).
  etcd: "guarded",
  // Read-only whatever the flag says: this version of the provider refuses every write before it is sent,
  // offers no object edit and no maintenance operation, so a connection marked read-only keeps the promise.
  neo4j: "none",
  // Its provider refuses Load and Release before any request while the mode holds, and every v1 console request is
  // a read (vector-family E8).
  milvus: "guarded",
  // Every v1 console request is a read and the provider has no maintenance operation, and while the mode holds it
  // refuses every route that is not a read before any request (vector-family spec 4.4).
  qdrant: "none",
  // As Qdrant (#1566 spec 3.5): every console request is a read, the provider has no maintenance operation, and it
  // refuses every route that is not a read, and every request that would wake a cold tenant, before any request.
  weaviate: "none",
  // Read-only whatever the flag says: on 1.x and 2.x the InfluxQL lexer policy (`influxql-policy.ts`) is the only
  // boundary between a Studio user and `DROP DATABASE`, so it refuses every statement that is not one `SELECT`, `SHOW`
  // or `EXPLAIN` before any request; the route table reaches no write endpoint.
  influxdb: "none",
  // Read-only whatever the flag says: the closed route table reaches no write, configure, token, cache or plugin
  // endpoint, the SQL policy refuses every statement that does not lead with a read keyword before any request, and
  // the 3.12 planner refuses every write besides.
  influxdb3: "none",
  // Read-only whatever the flag says: the adapter's stub holds only `GetShardAssignments`, `Read`, `List`, `RangeScan`
  // and `Health/Check` (O8), and the parser refuses every write verb by name, naming the read-only mode while it
  // holds (O1).
  oxia: "none",
  // No read-only mode: the provider sends the statement the editor holds, as Db2's does.
  databend: "open",
  // Read-only whatever the flag says: the console's closed command table reaches no write, and the provider sends only
  // GET and HEAD.
  s3: "none",
  // Read-only whatever the flag says: the request policy admits GET and the three self reviews only, before any
  // socket, and the provider offers no object edit and no maintenance operation.
  kubernetes: "none",
  // Structural rather than a mode: the encoder has no function that writes a PUBLISH, so there is no
  // write to enforce against. The valve repeats the check on the bytes.
  mqtt: "none",
  // Read-only whatever the flag says: the client builds only the read requests of its closed table, before any
  // socket, and the provider offers no object edit and no maintenance operation.
  firestore: "none",
  // Read-only whatever the flag says: the management client's closed route table holds GET routes only, and the AMQP
  // client has no encoder for a publish, a get, a reject or any queue or exchange method, so no request path writes.
  rabbitmq: "none",
  // Structural rather than a mode: the client seam names eight read services and none of them writes, so there
  // is no write to enforce against (`src/lib/db/providers/industrial/opcua/client.ts`).
  opcua: "none",
  // Structural rather than a mode: the request table holds nine routes and every one of them is a GET, so there
  // is no write to enforce against (`src/lib/db/providers/industrial/mtconnect/routes.ts`).
  mtconnect: "none",
  // Structural rather than configured: the encoder names four read function codes and device
  // identification, and there is no code in the provider that can build a write (#1723 MB-S1,
  // `src/lib/db/providers/industrial/modbus/valve.ts` re-checks every outbound byte).
  modbus: "none",
  // Structural rather than a mode: the request builder writes four read bodies and `<close-session>`, and no
  // function in the provider builds an `<edit-config>` or any other write
  // (`src/lib/db/providers/network/netconf/requests.ts`).
  netconf: "none",
  // Structural rather than a mode: the valve refuses every outbound datagram whose PDU is not a read, so no Set
  // request leaves Studio (`src/lib/db/providers/network/snmp/valve.ts`).
  snmp: "none",
  // Structural rather than a mode, and the structure is an absence: `encoder.ts` encodes CONNECT, SUBSCRIBE,
  // UNSUBSCRIBE, PINGREQ and DISCONNECT and has no function that writes a PUBLISH, while the CONNECT takes no
  // will parameter at all, so no later edit can register a death certificate by passing a value (5.4).
  sparkplug: "none",
  // Studio's own store: the editor's `put` and `delete` are sent whatever the connection's flag says.
  libredb: "open",
});

/**
 * Which shipped engines keep a read-only connection's promise: their provider refuses every write,
 * object edit and maintenance operation before any request while the connection's `readOnly` is true
 * (#1089). The static answer `ProviderCapabilities.enforcesReadOnly` gives once a provider is built.
 *
 * Static because every reader decides before a provider exists: the seed schema refuses
 * `readOnly: true` at load where this answers false, `assertReadOnlyHonoured` in
 * `src/lib/db/factory.ts` refuses it before anything is built or dialled, and the connection form
 * draws its toggle, and writes the field, only where this answers true. Refused rather than ignored,
 * because a mode an engine ignores lists a connection as read-only and sends its writes.
 *
 * Derived from `WRITE_REACH`, so there is one hand-written answer: true wherever the reach is not `open`.
 * `tests/unit/db/read-only-enforced-capability.test.ts` holds every entry equal to what that engine's provider
 * declares, so the two cannot drift. Frozen like the records above it.
 */
export const READ_ONLY_ENFORCED = Object.freeze(mapEntries(WRITE_REACH, (reach) => reach !== "open"));

/**
 * Which shipped engines open their editor handle under a file-access posture: their provider reads
 * `ProviderExecutionContext.allowExternalFileAccess` and opens with external access off when it is
 * denied, while the database stays writable for DuckDB. SQLite refuses denied access entirely
 * because its drivers cannot confine statement-level file access. The static answer is
 * `ProviderCapabilities.readsFileAccessPosture`.
 *
 * Static because its readers decide before a provider exists: `providerCacheKey` carries the deny
 * posture as a key segment so a denied and a full-reach handle of one connection never share an
 * entry, and `findOpenSingleWriterProvider` lends a handle only to a caller of its own posture. Both
 * run while computing the key to find or open a provider, so neither can ask one. Reading
 * `connection.type` at those two call sites was the alternative and is forbidden by `CLAUDE.md`; this
 * map is how the behaviour stays capability-driven, exactly as `READ_ONLY_ENFORCED` is.
 *
 * An exhaustive Record for the reason `EXTERNAL` gives, so a new type-id cannot join without someone
 * answering, and `tests/unit/db/reads-file-access-posture-capability.test.ts` holds every entry equal
 * to what that engine's provider declares. Frozen like the records above it.
 */
export const READS_FILE_ACCESS_POSTURE: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  postgres: false,
  bigquery: false,
  snowflake: false,
  spark: false,
  mysql: false,
  sqlite: true,
  libsql: false,
  // The engine whose editor handle opens under the posture: external access off for every role but
  // admin, and for every role on a seed a non-admin role can use. SQLite refuses a denied handle instead.
  duckdb: true,
  oracle: false,
  db2: false,
  mssql: false,
  clickhouse: false,
  druid: false,
  trino: false,
  cassandra: false,
  elasticsearch: false,
  opensearch: false,
  mongodb: false,
  couchbase: false,
  redis: false,
  prometheus: false,
  kafka: false,
  etcd: false,
  neo4j: false,
  milvus: false,
  qdrant: false,
  weaviate: false,
  influxdb: false,
  influxdb3: false,
  oxia: false,
  databend: false,
  s3: false,
  kubernetes: false,
  mqtt: false,
  firestore: false,
  rabbitmq: false,
  opcua: false,
  mtconnect: false,
  modbus: false,
  netconf: false,
  snmp: false,
  sparkplug: false,
  libredb: false,
});

/**
 * Which shipped engines keep one handle per database file in this process: the static answer
 * `ProviderCapabilities.singleWriterFile` gives once a provider is built.
 *
 * Static because `providerCacheKey` decides before a provider exists: under governance every user of a
 * connection gets a provider of their own (docs/GOVERNANCE.md#per-user-providers), and the key frames the user as its
 * owner, except on these engines, where a provider per user would be a second handle on one file. DuckDB keeps its own
 * copy of the catalog in a second read-write handle and checkpoints it over the file when it closes, and LibreDB
 * refuses the second open outright, so every user of such a connection is served the one open handle. Reading
 * `connection.type` there was the alternative and is forbidden by `CLAUDE.md`.
 *
 * An exhaustive Record for the reason `EXTERNAL` gives, so a new type-id cannot join without someone
 * answering, and `tests/unit/db/compatibility.test.ts` holds every entry equal to what that engine's
 * provider declares. Frozen like the records above it.
 */
export const SINGLE_WRITER_FILE: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  postgres: false,
  bigquery: false,
  snowflake: false,
  spark: false,
  mysql: false,
  sqlite: false,
  libsql: false,
  duckdb: true,
  oracle: false,
  db2: false,
  mssql: false,
  clickhouse: false,
  druid: false,
  trino: false,
  cassandra: false,
  elasticsearch: false,
  opensearch: false,
  mongodb: false,
  couchbase: false,
  redis: false,
  prometheus: false,
  kafka: false,
  etcd: false,
  neo4j: false,
  milvus: false,
  qdrant: false,
  weaviate: false,
  influxdb: false,
  influxdb3: false,
  oxia: false,
  databend: false,
  s3: false,
  kubernetes: false,
  mqtt: false,
  firestore: false,
  rabbitmq: false,
  opcua: false,
  mtconnect: false,
  modbus: false,
  netconf: false,
  snmp: false,
  sparkplug: false,
  libredb: true,
});

/**
 * Which shipped engines a seed connection may expose to MCP clients (#246): the seed schema refuses
 * `mcp: true` at load on an engine where this answers false, naming the engine, so an opt-in the
 * product does not honour fails the file instead of listing a connection. Static for the reason
 * `READ_ONLY_ENFORCED` is: the seed file is validated before any provider exists.
 *
 * The etcd provider (#1089) is the engine this record was made for, MCP being outside its first version until a
 * change of its own offered it. An entry lands with its provider's registration, which the compiler forces. Each
 * entry that answers false carries its reason beside it, so the record below is the list; every other engine answers
 * true. An exhaustive Record for the reason `EXTERNAL` gives, so a new type-id cannot join
 * without someone answering, and frozen like the records above it.
 */
export const MCP_EXPOSABLE: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  postgres: true,
  bigquery: true,
  snowflake: true,
  spark: true,
  mysql: true,
  sqlite: true,
  libsql: true,
  duckdb: true,
  oracle: true,
  db2: true,
  mssql: true,
  clickhouse: true,
  druid: true,
  trino: true,
  cassandra: true,
  elasticsearch: true,
  opensearch: true,
  mongodb: true,
  couchbase: true,
  redis: true,
  prometheus: true,
  kafka: true,
  // Offered with every answer metadata only, as agent mode reads it: key names and values carry secrets, so
  // `inspect_schema` lists no key prefix, since every agent-mode handle withholds them, and `run_etcd_read` answers
  // the closed table's names, counts and sizes under a user the server proves reads only, on no Kubernetes storage
  // prefix and not on every key.
  etcd: true,
  // Offered for the metadata tools, `list_connections` and `inspect_schema` (Neo4j spec 6.4), and for
  // `run_cypher_read`, which MCP_STATEMENT_READ opens on it.
  neo4j: true,
  // Offered for the metadata tools (vector-family E17), and for `run_milvus_read`, which MCP_STATEMENT_READ opens on
  // it.
  milvus: true,
  // Offered for the metadata tools, carrying names and types only (vector-family spec 4.4), and for
  // `run_qdrant_read`, which MCP_STATEMENT_READ opens on it.
  qdrant: true,
  // As Milvus and Qdrant (#1566 spec 3.5): offered for the metadata tools, and for `run_weaviate_read`, which reads
  // one metadata request under the agent's own boundary; inspect_schema lists a collection's properties and vectors and
  // never its tenants or aliases.
  weaviate: true,
  // Both offered for the metadata tools, which list database, measurement and column names and types only. Both
  // providers implement `queryReadOnly` for agent mode; `run_read_query` serves InfluxDB 3's SQL, opened by
  // MCP_STATEMENT_READ, and no MCP statement tool reads InfluxQL, so `influxdb` stays closed there (BACKLOG B94).
  influxdb: true,
  influxdb3: true,
  // Closed: the 0.18.0 server authorizes nothing, so a token reads, writes and deletes every key of every namespace
  // and the provider's closed table would be the only layer between an MCP client and the cluster; Oxia key paths
  // name Pulsar tenants, namespaces and topics, and no MCP surface that lists no key name is designed (BACKLOG B100).
  oxia: false,
  databend: true,
  // Closed: MCP may read S3 only with an agent read key beside the connection's, whose grants hold the bucket scope,
  // and a seed connection, the only kind MCP reads, carries no agent credential; no MCP surface that lists buckets
  // but never an object key is designed either (BACKLOG B104).
  s3: false,
  // Offered with every answer machine-redacted: `run_kubectl_read` runs the agent's
  // `queryReadOnly`, whose output masks every Secret name, and `inspect_schema` lists relations alone, which no
  // Kubernetes kind is, so no object name, a Secret's included, reaches it.
  kubernetes: true,
  // Offered with every answer metadata only, as agent mode reads it: topic names and payloads are withheld, so
  // `inspect_schema` refuses an MQTT connection by name, since a broker declares no relation kind, and `run_mqtt_read`
  // answers one window's totals or one named topic's counts and flags, with its window and the completeness sentence.
  mqtt: true,
  // Closed: every read is billed to the user's project, an MCP call has an allowance of its own and nothing bounds
  // billed reads across calls, `inspect_schema` carries no allowance, so no collection listing reaches it, and a
  // production viewer role is not measured (BACKLOG B107).
  firestore: false,
  // Offered for the metadata tools, carrying stream names and the fixed read columns only, and for
  // `run_rabbitmq_read`, which reads through agent mode's metadata-only path: each message's offset and body size,
  // never a message value (BACKLOG B108).
  rabbitmq: true,
  // Outside this version. Agent mode reads values with their
  // engineering units and withholds the server's configuration, role identities and session
  // diagnostics, one session per read; no MCP surface that reads through the same withheld set and
  // units lookup is designed yet (BACKLOG B162).
  opcua: false,
  // Offered for the metadata tools and run_mtconnect_read, which acquire an agent-mode handle and so read the device
  // model with the agent's adapter connections withheld.
  mtconnect: true,
  // Closed: agent mode reads the device paced per device and counted per run, and MCP has no run, so nothing would
  // bound a client's device requests across calls; a cancelled call keeps the device's lane until its read's own
  // deadline; and no MCP surface lists the register map's points, so a client could form only a block read whose
  // decoding it guesses (BACKLOG B160).
  modbus: false,
  // Closed: agent mode reads NETCONF configuration and state with keys, password hashes, access rules and every node
  // the device's own YANG marks nacm:default-deny-all withheld by Studio alone, since a read-only account still reads
  // password hashes and keystore entries (docs/providers/netconf.md 6.3), and nothing on the device is proved to hold
  // them out; the rest is the device's whole configuration (BACKLOG B159).
  netconf: false,
  // Offered as agent mode reads it: values are the device's own readings, and the withheld subtrees (the security and
  // target modules, the running processes, the commands the agent runs and the vendor copy tables) are decided on every
  // answer, so `inspect_schema` lists the bundled catalog's tables and scalar groups, none inside a withheld subtree,
  // and `run_snmp_read` steps over or answers withheld every one a read reaches.
  snmp: true,
  // Offered with every answer metadata only, as agent mode reads it: ids, metric names and values are withheld, so
  // `inspect_schema` answers an empty page, since an agent-mode handle declares no kind, and `run_sparkplug_read`
  // answers one window's totals or one named object's counts, with its window and the completeness sentence.
  sparkplug: true,
  libredb: true,
});

/**
 * Which shipped engines an MCP client may run a statement on: a second record beside
 * `MCP_EXPOSABLE`, which also opens `list_connections` and `inspect_schema` and so cannot be turned false to keep a
 * statement tool closed. An MCP statement tool serves an engine only where agent mode executes statements on it,
 * `MCP_EXPOSABLE` offers it and this record answers true (`src/lib/mcp/tools/served-engines.ts`), so an engine that
 * joins agent mode does not open to MCP as a side effect: its row stays false until a change of its own opens it.
 *
 * An exhaustive Record for the reason `EXTERNAL` gives, frozen like the records
 * above it, and held false wherever `MCP_EXPOSABLE` is false and true only for an engine agent mode executes on by
 * `tests/unit/db/compatibility.test.ts`.
 */
export const MCP_STATEMENT_READ: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  postgres: true,
  bigquery: false,
  snowflake: false,
  spark: false,
  mysql: true,
  sqlite: true,
  // Opened on its own: run_read_query runs under the boundary agent mode uses, a token proven at open to be read-only
  // and refused every write by the server (docs/providers/libsql.md section 3.6).
  libsql: true,
  duckdb: true,
  // Opened on its own: run_read_query runs under the boundary agent mode uses, a user set READ ONLY, checked before
  // every statement on that statement's own session to reach nothing READ ONLY leaves open and to hold no grant on a
  // schema Oracle maintains beyond the policy catalogs (docs/providers/oracle.md section 5.7).
  oracle: true,
  // Opened on its own: run_read_query runs under the boundary agent mode uses, a user checked before every statement,
  // on the statement's own connection, to hold nothing but CONNECT and SELECT (docs/providers/db2.md section 10.1).
  db2: true,
  mssql: true,
  // Opened on its own: run_read_query runs under the boundary agent mode uses, `readonly = 1` on every request and a
  // user proven at open to hold only reads (docs/providers/clickhouse.md section 5.6).
  clickhouse: true,
  // Agent mode executes statements on Druid, and MCP read stays closed on it until a change of its own opens it: a
  // LOOKUP of a literal key is kept out by the statement fence alone (BACKLOG B151).
  druid: false,
  // Agent mode executes statements on Trino, and MCP read stays closed on it: the read-only access control lets every
  // identity read other users' query text in `system.runtime.queries`, and only the statement fence keeps it out
  // (BACKLOG B166).
  trino: false,
  // Opened on its own: run_read_query runs under the boundary agent mode uses, a role proven before every statement to
  // hold only SELECT on the connection's keyspace, on a server that enforces it, and a provider check that sends one
  // SELECT of that keyspace or of system_schema (docs/providers/cassandra.md section 14).
  cassandra: true,
  // Opened on its own: run_read_query runs under the boundary agent mode uses, the SQL endpoint's grammar, which holds
  // no write, on a server checked at open to be the release line whose write refusals were captured
  // (docs/providers/elasticsearch.md section 5.9). OpenSearch, served by the same provider directory, has a row of its own.
  elasticsearch: true,
  // Opened on its own: run_read_query runs under the boundary agent mode uses, the SQL plugin's refusal of every write,
  // on a server whose DELETE is proved off and whose release line was checked at open, with a statement check that
  // keeps hidden and dot-led indices from each statement (docs/providers/opensearch.md section 5.9).
  opensearch: true,
  mongodb: true,
  // Opened on its own: run_read_query runs under the boundary agent mode uses, a user whose only roles are query_select
  // on named scopes of the bucket, checked at open and again before every statement on a server proven to enforce it,
  // and a fence that sends one SELECT (docs/providers/couchbase.md section 15).
  couchbase: true,
  // Opened on its own: run_redis_read runs under the boundary agent mode uses, the closed table of metadata reads and
  // an ACL user the server refuses every write probe before every command, on that command's own connection, with
  // every answer projected to counts, types and sizes (docs/providers/redis.md section 16).
  redis: true,
  // Closed: Prometheus has no principal that narrows a read, so the connection's credential reaches every series the
  // TSDB stores, and no layer independent of reading the expression narrows it; agent mode reads under that reach with
  // the flags and every URL's userinfo and query string withheld (BACKLOG B161).
  prometheus: false,
  // Opened on its own: run_kafka_read runs under the boundary agent mode uses, a client that holds the Metadata and
  // ListOffsets reads alone, answered metadata-only with a platform's own topics withheld
  // (docs/providers/kafka.md section 16).
  kafka: true,
  // Opened on its own: run_etcd_read runs under the boundary agent mode uses, the provider's closed table of metadata
  // reads and a user the server shows, before every command, to hold no root role and only READ, on no Kubernetes
  // storage prefix and not on every key, with every answer projected to names, counts and sizes
  // (docs/providers/etcd.md section 15.7).
  etcd: true,
  // Opened on its own: run_cypher_read runs under the boundary agent mode uses, on Enterprise Edition only, a user the
  // server proves before every statement to hold only reads, no LOAD and no extension it can execute, and the
  // server's own classification of every statement (docs/providers/neo4j.md section 15).
  neo4j: true,
  // Opened on its own: run_milvus_read runs under the boundary agent mode uses, the provider's closed RPC table and a
  // user the server proves read-only before every request, every call naming a collection sent only when the user's own
  // collection list holds it, every answer projected to names, counts and flags (docs/providers/milvus.md, section
  // Agent mode).
  milvus: true,
  // Opened on its own: run_qdrant_read runs under the boundary agent mode uses, the provider's closed table of read
  // routes and a key the server refuses an empty alias update and an empty point delete on every collection it lists,
  // before every request, with every answer projected to names, counts and flags (docs/providers/qdrant.md, section
  // Agent mode).
  qdrant: true,
  // Opened on its own: run_weaviate_read runs under the boundary agent mode uses, the provider's closed table of read
  // requests and a key the server proves before every read to hold the viewer role's read actions only, answered
  // through the metadata-only projection (docs/providers/weaviate.md section 15).
  weaviate: true,
  // Agent mode executes InfluxQL on InfluxDB, and MCP read stays closed on it: on 1.x a catalog SHOW's database scope
  // rests on the agent's statement reader alone, and no layer that reads the answer can hold it (BACKLOG B94).
  influxdb: false,
  // Opened on its own: run_read_query runs under the boundary agent mode uses, the 3.12 Core planner's write refusals
  // on a server checked at open to be that line, behind the read policy and the system schema fence
  // (docs/providers/influxdb3.md section 3.5).
  influxdb3: true,
  // Agent mode executes metadata-only reads on Oxia, and MCP read stays closed on it: the server authorizes nothing,
  // so the closed table would be the only layer between an MCP client and every key (BACKLOG B100).
  oxia: false,
  databend: false,
  // Agent mode executes metadata-only reads on S3, and MCP read stays closed on it: a seed connection carries no agent
  // read key, the one layer that holds the bucket scope (BACKLOG B104).
  s3: false,
  kubernetes: true,
  // Opened on its own: run_mqtt_read runs under the boundary agent mode uses, the provider's closed five-packet
  // encoder and valve, which send no PUBLISH and no Will, with every answer projected to one window's counts and flags,
  // never a topic name or a payload, and carrying its window and the completeness sentence as notes
  // (docs/providers/mqtt.md section 15).
  mqtt: true,
  // Agent mode executes metadata-only reads on Firestore, and MCP read stays closed on it: every read is billed and
  // nothing bounds billed reads across MCP calls (BACKLOG B107).
  firestore: false,
  // Opened on its own: run_rabbitmq_read runs under the boundary agent mode uses, the provider's structural closed
  // table (a read client that encodes no take, publish, purge or declare, the stream-only type check before any frame
  // and the `x-stream-offset` 406 backstop), answered metadata only, each message's offset and body size; message values
  // stay withheld (docs/providers/rabbitmq.md section 17, BACKLOG B108).
  rabbitmq: true,
  // Agent mode executes reads with engineering units on OPC UA, and MCP read stays closed on it until a change of its
  // own opens it (BACKLOG B162).
  opcua: false,
  // Opened on its own: run_mtconnect_read runs under the boundary agent mode uses, the provider's closed table of nine
  // GET routes, with the agent's adapter connections withheld from every answer (docs/providers/mtconnect.md section 14).
  mtconnect: true,
  // Agent mode executes paced reads on Modbus, and MCP read stays closed on it: no bound on device requests across
  // calls, no lane release on cancel and no register-map surface exist for MCP yet (BACKLOG B160).
  modbus: false,
  // Agent mode executes reads on NETCONF with the withheld nodes pruned, and MCP read stays closed on it: the pruning
  // is Studio's alone, with no device layer proved to hold the secrets out (BACKLOG B159).
  netconf: false,
  // Opened on its own: run_snmp_read runs under the boundary agent mode uses, the agent's client of Get, GetNext and
  // GetBulk alone behind the valve, with every withheld subtree decided by the prefix of every identifier an answer
  // carries, and its reasons carried as notes; a v2c community is no principal, so the agent's own view and Studio's
  // withheld set are the data scope (docs/providers/snmp.md section 14).
  snmp: true,
  // Opened on its own: run_sparkplug_read runs under the boundary agent mode uses, the provider's closed encoder, which
  // sends no PUBLISH, command or Will, with every answer projected to one window's counts and flags, never an id, a
  // metric name or a value, and carrying its window and the completeness sentence as notes
  // (docs/providers/sparkplug.md section 15).
  sparkplug: true,
  // Opened on its own: run_libredb_read runs under the boundary agent mode uses, a read-only handle of its own for every
  // command, opened through Studio's read-only file adapter, which takes no lock and cannot write; the seed names the
  // one file it reads, Studio's own storage and credential files are refused as a target, and the file's reserved
  // internal namespace is left out of every answer (docs/providers/libredb.md section 15).
  libredb: true,
});

/**
 * Which shipped engines' connection form offers a URI mode (Spec A section 7): the answer
 * `DB_UI_CONFIG[type].showConnectionStringToggle` gives in `src/lib/db-ui-config.ts`. Kept here because the seed
 * layer must not load `db-ui-config.ts`: it value-imports the React icon components, the reason
 * `src/lib/db/credential-warnings.ts` exists. No seed module reads it yet; the environment-URL source of PR A2
 * will, to keep a pasted URI verbatim only where this answers true, as the form's paste keeps it.
 *
 * An exhaustive Record for the reason `EXTERNAL` gives, so a new type-id cannot join without someone answering,
 * frozen like the records above it, and held equal to the form's own answer for every type by
 * `tests/unit/db/connection-string-records.test.ts`.
 */
export const CONNECTION_FORM_URI_MODE: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  postgres: false,
  bigquery: false,
  snowflake: false,
  spark: false,
  mysql: false,
  sqlite: false,
  libsql: true,
  duckdb: false,
  oracle: false,
  db2: false,
  mssql: false,
  clickhouse: true,
  druid: false,
  trino: false,
  cassandra: false,
  elasticsearch: false,
  opensearch: false,
  mongodb: true,
  couchbase: true,
  redis: false,
  prometheus: false,
  kafka: false,
  etcd: false,
  neo4j: false,
  milvus: false,
  qdrant: false,
  weaviate: false,
  influxdb: false,
  influxdb3: false,
  oxia: false,
  databend: false,
  s3: false,
  kubernetes: false,
  mqtt: false,
  firestore: false,
  rabbitmq: false,
  opcua: false,
  mtconnect: false,
  modbus: false,
  // No URI mode: the form names a host, a port, an account and the device's host key fingerprint,
  // and `netconf://` is a scheme nothing in this product parses. Held equal to
  // `DB_UI_CONFIG[type].showConnectionStringToggle` by `connection-string-records.test.ts`.
  netconf: false,
  snmp: false,
  // Host and port are the address, as MQTT's are, so there is no string form to parse.
  sparkplug: false,
  libredb: false,
});

/**
 * The types whose provider reads `connectionString` (Spec A section 7):
 * getCapabilities().supportsConnectionString, except sqlite (declares false, opens the field as the file path)
 * and mssql (declares true for the form's paste, builds from the fields only). Static for the reason
 * `READ_ONLY_ENFORCED` is: the seed schema decides at load, before any provider exists, and refuses a
 * `connectionString` where this answers false, naming the connection and the type, because a provider that
 * ignores the string would list a connection that opens somewhere else than the file says.
 *
 * An exhaustive Record for the reason `EXTERNAL` gives, frozen like the records above it, held equal to every
 * other shipped provider's declaration by the census in `tests/unit/db/connection-string-records.test.ts`, and
 * pinned there for the two exceptions by behavioural tests: sqlite opens the file a `file:` string names, and
 * mssql builds a string-only config against localhost.
 */
export const CONNECTION_STRING_ACCEPTED: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  postgres: true,
  bigquery: false,
  snowflake: false,
  spark: false,
  mysql: true,
  // The provider's supportsConnectionString flag is false, yet it opens this field as the database file path:
  // sqlite.ts getDatabasePath, docs/providers/sqlite.md.
  sqlite: true,
  libsql: true,
  duckdb: false,
  oracle: true,
  db2: true,
  // Declared true for the form's paste, documented UI-only, while buildConfig builds from the fields only, so a
  // seed carrying only connectionString would open localhost: mssql.ts buildConfig, docs/providers/mssql.md.
  mssql: false,
  clickhouse: true,
  druid: false,
  trino: false,
  cassandra: false,
  elasticsearch: false,
  opensearch: false,
  mongodb: true,
  couchbase: true,
  redis: false,
  prometheus: false,
  kafka: false,
  etcd: false,
  neo4j: false,
  milvus: false,
  qdrant: false,
  weaviate: false,
  influxdb: false,
  influxdb3: false,
  oxia: false,
  databend: false,
  s3: false,
  kubernetes: false,
  mqtt: false,
  firestore: false,
  rabbitmq: false,
  // The endpoint URL is the whole address: host and port are read from it, so there is no second string to parse.
  opcua: false,
  // Host and port are the address and `apiPath` is a field of its own, so there is no string form to parse.
  mtconnect: false,
  modbus: false,
  // in one box.
  netconf: false,
  snmp: false,
  sparkplug: false,
  libredb: false,
});

/**
 * Which shipped engines open a file on Studio's own host rather than reach a server: the connection is a path, and
 * the provider opens it inside Studio's process. A governance source can never grant one
 * (docs/GOVERNANCE.md#row-admission-and-skip-codes): row admission in `src/lib/governance/admission.ts` skips it as
 * ENGINE_UNSUPPORTED whatever `GOVERNANCE_ALLOWED_ENGINES` says, because a grant would hand its users a file of the
 * host Studio runs on.
 *
 * Static because admission decides from a row before any provider exists, and reads this record rather than a type
 * id. Kept here because the governance layer must not load `src/lib/db-ui-config.ts`, which value-imports the React
 * icon components; `tests/unit/db/compatibility.test.ts` holds every entry equal to that file's `isFileBased()`, the
 * connection form's own answer. An exhaustive Record for the reason `EXTERNAL` gives, frozen like the records above it.
 */
export const OPENS_LOCAL_FILE: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  postgres: false,
  bigquery: false,
  snowflake: false,
  spark: false,
  mysql: false,
  // A database file opened through `bun:sqlite` or `node:sqlite` in Studio's own process.
  sqlite: true,
  libsql: false,
  // A database file (or `:memory:`) opened by the native DuckDB addon in Studio's own process.
  duckdb: true,
  oracle: false,
  db2: false,
  mssql: false,
  clickhouse: false,
  druid: false,
  trino: false,
  cassandra: false,
  elasticsearch: false,
  opensearch: false,
  mongodb: false,
  couchbase: false,
  redis: false,
  prometheus: false,
  kafka: false,
  etcd: false,
  neo4j: false,
  milvus: false,
  qdrant: false,
  weaviate: false,
  influxdb: false,
  influxdb3: false,
  oxia: false,
  databend: false,
  s3: false,
  kubernetes: false,
  mqtt: false,
  firestore: false,
  rabbitmq: false,
  opcua: false,
  mtconnect: false,
  modbus: false,
  netconf: false,
  snmp: false,
  sparkplug: false,
  // The embedded store this app creates, a file on Studio's own volume.
  libredb: true,
});

/**
 * Which shipped engines reach the whole server when a connection names no database (#1530): the provider then
 * declares `catalogSessions` and opens a session of its own to each database the caller picks, so one credential
 * reaches every database it can sign in to. A governance source grants one database per connection, so row admission
 * in `src/lib/governance/admission.ts` skips such an engine's definition without a database as
 * SERVER_LEVEL_NOT_ALLOWED (docs/GOVERNANCE.md#row-admission-and-skip-codes).
 *
 * Static for the reason `OPENS_LOCAL_FILE` is. `tests/unit/db/compatibility.test.ts` builds every shipped provider
 * with no database and no connection string, nothing connecting, and holds this record equal to the engines whose
 * provider then reports `catalogSessions`. An exhaustive Record for the reason `EXTERNAL` gives, frozen like the
 * records above it.
 */
export const OPENS_SERVER_LEVEL_WITHOUT_DATABASE: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  // An empty `database` on discrete fields reaches the whole server (`serverLevel` in providers/sql/postgres.ts);
  // a connection string never does.
  postgres: true,
  bigquery: false,
  snowflake: false,
  spark: false,
  mysql: false,
  sqlite: false,
  libsql: false,
  duckdb: false,
  oracle: false,
  db2: false,
  mssql: false,
  clickhouse: false,
  druid: false,
  trino: false,
  cassandra: false,
  elasticsearch: false,
  opensearch: false,
  mongodb: false,
  couchbase: false,
  redis: false,
  prometheus: false,
  kafka: false,
  etcd: false,
  neo4j: false,
  milvus: false,
  qdrant: false,
  weaviate: false,
  influxdb: false,
  influxdb3: false,
  oxia: false,
  databend: false,
  s3: false,
  kubernetes: false,
  mqtt: false,
  firestore: false,
  rabbitmq: false,
  opcua: false,
  mtconnect: false,
  modbus: false,
  netconf: false,
  snmp: false,
  sparkplug: false,
  libredb: false,
});

/**
 * How much of the product works against a wire-compatible engine.
 *
 * - `full` - every introspection surface answered. Caveats may still record data
 *   that is present but inaccurate, which is why a `full` engine can have them.
 * - `partial` - some surfaces answered, some did not. The editor works; parts of
 *   the browser or the monitoring dashboard are blank.
 * - `query-only` - the SQL editor works and nothing else does. Usable, but not as
 *   a managed database.
 */
export type CompatibilityTier = "full" | "partial" | "query-only";

export interface WireCompatibleEngine {
  /** The engine's name as a user would say it, e.g. "MariaDB". */
  name: string;
  /** The shipped type-id whose driver serves it unchanged. */
  via: DatabaseType;
  /** How much of the product worked during the probe. */
  tier: CompatibilityTier;
  /** The exact server version a live gate-4 probe reported. Never a range. */
  probedVersion: string;
  /** One-line, user-facing notes on what does not work or misleads. */
  caveats: readonly string[];
}

/**
 * Verified relatives, each measured by a live gate-4 probe on 2026-08-18, with
 * TimescaleDB, YugabyteDB, TiDB and StarRocks added from a second probe run on
 * 2026-08-20, Apache Cloudberry and Vitess from a third run the same day,
 * AlloyDB Omni from a fourth run the same day, OceanBase Community Edition
 * and SingleStore from a fifth run the same day, ScyllaDB from a sixth run on
 * 2026-08-21/22, Apache Doris, Garnet and both Percona distributions from a seventh run
 * on 2026-08-26, ParadeDB and OrioleDB from an eighth on 2026-08-27, and
 * VictoriaMetrics, the first relative of the `prometheus` driver, from a ninth on 2026-09-23, and
 * Redpanda, the first relative of the `kafka` driver, from a tenth on 2026-09-25.
 * Databend, probed in the eighth run, is no longer a relative: it ships as the `databend`
 * type-id over its own HTTP query API, and one product is never counted twice.
 * The nine MySQL-wire relatives of the day, Databend among them, were re-measured together on 2026-09-06 for issues
 * #573 and #574, at the wire and then in a browser against the built app, and the
 * outcome per engine is recorded in `docs/providers/mysql.md` section 5.5 for the
 * EXPLAIN grammar and section 8 for the SHOW STATUS reads.
 * Names still awaiting an instance are tracked in issue #424, never here: there
 * is no "pending" state on purpose, because a reader cannot tell a pending entry
 * from a probed one. A name that WAS probed and did not earn an entry has no
 * representation here either - Cloud Spanner's PostgreSQL dialect answered 1 of 15
 * surfaces, and QuestDB 10.0.1 failed the one surface a query-only row exists to claim -
 * so those results are recorded in `docs/providers/README.md` beside this table, with the
 * number that refused each of them.
 *
 * QuestDB is the entry NOT to add back without re-reading that section. It looks like a
 * query-only relative from the provider's side and is not one from the product's: the
 * editor always attaches a `queryId`, the provider then issues `SELECT pg_backend_pid()`
 * first, and QuestDB has no such function - so `provider.query(sql)` answers three rows
 * while pressing Run answers a 500. Same shape as Cloud Spanner, found the same way,
 * and only in a browser.
 */
export const WIRE_COMPATIBLE_ENGINES: readonly WireCompatibleEngine[] = [
  {
    name: "Citus",
    via: "postgres",
    tier: "full",
    probedVersion: "citus 14.1-1 on PostgreSQL 18.4",
    caveats: [
      "Row counts and sizes for a distributed table are wrong rather than missing: PostgreSQL statistics describe only the empty coordinator parent, not the shards.",
      "The citus_tables and citus_schemas views appear in the object browser alongside your own tables.",
    ],
  },
  {
    name: "CockroachDB",
    via: "postgres",
    tier: "partial",
    probedVersion: "CockroachDB CCL v26.2.6",
    caveats: [
      "The object browser now lists real tables (previously empty, #38680): the schema query recovers from the missing pg_total_relation_size() builtin by falling back to an unmeasured (0-byte) size instead of failing outright. Foreign keys and indexes are unaffected by this and continue to work.",
      "The overview panel loads with connections/size/uptime marked unavailable rather than failing outright: pg_postmaster_start_time(), pg_size_pretty() and pg_tablespace_location() do not exist there.",
      "Its table and index counts are the user's own. CockroachDB documents exactly four system schemas, and crdb_internal objects reach pg_tables even though information_schema's BASE TABLE filter never shows them - so before those two schemas were excluded, the overview counted 98 tables (93 crdb_internal, 3 pg_extension) for the 2 the object browser listed, and the two panels disagreed inside one app.",
      "Performance metrics, slow queries and active sessions do work: the pg_stat_* views CockroachDB provides are enough for them.",
      'The Explain panel works, and shows what the query really did. CockroachDB refuses PostgreSQL\'s parenthesised options (`at or near "analyze": syntax error`, and `JSON` is legal there only beside DISTSQL, where it answers a processor diagram rather than a plan), so the grammar is measured at connect and this server gets its own unparenthesised EXPLAIN ANALYZE. Until it was measured the panel showed its "no execution plan" empty state, so a failed plan request read as a query with no plan.',
      "Maintenance offers Analyze on one table and nothing else. CockroachDB has no VACUUM, no REINDEX and no whole-database ANALYZE (each a 42601 syntax error), so the provider asks the server at connect which of PostgreSQL's six maintenance statements its grammar has and draws no control for the rest; measured on v26.3.2 on 2026-10-04 (#1387). Until then all three were offered and each click answered HTTP 500 with the parser's error.",
      "Monitoring > Tables and Storage, and the Admin > Operations table list, work. Two things were in the way. The size builtins took a concatenated name, which CockroachDB refused with `pg_size_pretty(): unknown signature: pg_table_size(string)` and which failed the whole read; they take pg_stat_user_tables.relid now (#1436). The rows were then still missing, because pg_stat_user_tables and pg_stat_all_tables both carry zero rows here while pg_class holds the user's tables, so the read falls back to pg_class when the view answers none (#1540). Measured on v26.3.2 on 2026-10-05: three user tables, listed with their names and no figures at all - reltuples, pg_table_size(), pg_indexes_size() and pg_total_relation_size() each answer NULL for a table it has, so every number is absent rather than zero, and the per-table maintenance actions are reachable again.",
      "The Source tab shows a function's or procedure's definition with no Edit control. An edit is applied between two DO blocks that check the routine was not changed meanwhile, and CockroachDB runs an empty DO block but refuses PERFORM inside one (0A000, `unimplemented: this syntax`) and has no pg_proc.xmin (42703), so the provider asks the server at connect whether it runs that guard and offers no edit where it does not; measured on v26.3.2 on 2026-10-08 (#1437). Until then Edit was offered and every apply was refused after the reader had typed it.",
    ],
  },
  {
    name: "Materialize",
    via: "postgres",
    tier: "partial",
    probedVersion: "Materialize 26.40.0 (advertises PostgreSQL 9.5)",
    caveats: [
      'The object browser lists tables and columns (previously nothing worked at all, #38680). The object reads carry none of the constructs Materialize refuses or lacks - no MATERIALIZED CTE hint, no pg_total_relation_size(), and jsonb_agg()/jsonb_build_object() rather than the json_agg()/json_build_object() it does not have (#1075) - and they read keys from pg_constraint rather than information_schema.constraint_column_usage, which Materialize does not implement, so they answer on the first attempt, measured on v26.44.1 on 2026-10-24. Foreign keys and primary keys are empty for a reason that is not ours: Materialize has neither. CREATE TABLE refuses both, "a primary key or unique constraint is not supported" and "column constraint: REFERENCES ... not yet supported", and its pg_constraint holds no row for a user table because there is nothing to put in it. An index made with CREATE INDEX is read with its columns, measured 2026-09-24.',
      "The monitoring dashboard loads with every statistic marked unavailable rather than erroring the whole page: Materialize has no pg statistics catalog and no size functions. All seven tabs render. Three panels - the Tables tab's breakdown and the Storage tab's tablespaces and largest-tables list - are absent rather than empty, each showing Materialize's own sentence under the heading \"This engine does not publish this\" rather than an error, because the message names a pg_ object that is simply not there.",
      "Materialized views are listed beside tables in the object browser, with their columns. Materialize reports them through information_schema.tables as table_type = 'MATERIALIZED VIEW' and they are what its users actually work with, so a browser that listed only BASE TABLE hid the product: revenue_by_region was invisible while the three plain tables showed.",
      "The Explain panel works. Materialize has no rule for EXPLAIN's parenthesised options at all - `(FORMAT JSON)` is refused the same way `(ANALYZE, BUFFERS, FORMAT JSON)` is, and the error names only the first token inside them - and no EXPLAIN ANALYZE either, so the grammar is measured at connect and this server gets the plain EXPLAIN, whose physical plan names the relations it reads, the join strategy and the filters it pushed down. The JSON form its docs publish is not used: it carries no relation names, only internal ids.",
      "Row counts are blank rather than zero. Materialize answers -1 from pg_class.reltuples - PostgreSQL's never-counted sentinel - for tables, views and materialized views alike, so there is no estimate to show and the browser draws no badge. It used to show 0, which read as a measurement nobody made; a table holding three rows said it held none.",
      "In the object tree, the Functions and Procedures folders show Materialize's own sentence, column \"p.prokind\" does not exist, and do not open; every other folder in the tree counts and lists. Materialize's pg_proc has no prokind column, so it cannot say which routine is a function and which a procedure. It reports that as SQLSTATE XX000 rather than PostgreSQL's 42703, and while the object browser keyed its fallback on 42703 every folder in every schema showed that sentence and nothing could be opened. The fallback now keys on the column the refusal names, under any SQLSTATE, measured on Materialize v26.44.1 on 2026-10-04. Object search, the object inventory and the agent's inventory grounding still list the routine kinds and fail there (D226 in docs/BACKLOG.md). A source created from a load generator is listed under Tables, because Materialize's pg_class reports it as an ordinary table.",
    ],
  },
  {
    name: "RisingWave",
    via: "postgres",
    tier: "partial",
    probedVersion: "RisingWave 3.0.4 (advertises PostgreSQL 13.14.0)",
    caveats: [
      'The object browser lists tables and materialized views. It was unavailable until the listing learned to drop pg_class.reltuples, which RisingWave has no column for. The earlier reading of this blamed the schema query\'s LEFT JOIN pg_class ON (...)::regclass, which measurement refuted: that join binds, and RisingWave simply reports an unbindable column as "missing FROM-clause entry for table c", so a column defect reads as a join defect.',
      "Row counts and sizes are blank rather than zero: neither pg_class.reltuples nor pg_total_relation_size() exists to answer, and an unmeasured number is shown as absent rather than as 0.",
      "The monitoring dashboard loads rather than erroring the whole page, with most statistics marked unavailable. Slow-query and active-session panels stay empty (not merely unavailable) because RisingWave also rejects a parameterised LIMIT. This caveat used to say RisingWave has no pg statistics catalog at all, which measurement refuted: pg_stat_user_tables exists and carries a row per table, relid included, while pg_stat_all_tables does not exist, so the absence is per view and not wholesale.",
      "Monitoring > Tables lists the user's tables with their real table and index sizes, where the whole read used to fail. RisingWave binds neither pg_size_pretty() nor pg_total_relation_size(), but answers pg_table_size(relid) and pg_indexes_size(relid), so the byte counts are formatted in-process and only the total is left unmeasured. Measured on 3.1.0 on 2026-10-04 (#1436): a seeded table reads 44 B of table and 0 B of indexes with the total shown as N/A, where before the panel carried `Failed to bind expression: pg_size_pretty(pg_table_size(quote_ident(schemaname) ...))`.",
      "Expanding a table, a view or a materialized view shows its columns, with their types and in the table's own order, through describeObject() and describeObjects() alike, measured 2026-09-24 (#1075). This caveat used to call the gap the engine's, and it was ours: RisingWave has no json type and refused the json_agg(), json_build_object() and '[]'::json the reads were built with, while it answers every jsonb form, which is what the reads use now. It also refuses a subquery inside an aggregate call, which is how an index's column list was built; that is a LATERAL join now.",
      "Nullability and defaults are read from the engine's catalog, which states neither: pg_attribute answers attnotnull false for every column, so a NOT NULL column and a primary key both read nullable, and pg_attrdef is empty, so no column shows a default, one declared with DEFAULT included. The nullability half is filed as D119.",
      "Foreign keys are empty because RisingWave has none: CREATE TABLE refuses REFERENCES in both its column and its table form. The primary key is listed as an index named after its table, and an index lists every column pg_index.indkey names, which on RisingWave is the key columns followed by every column the index carries, the primary key always among them: an index on (amount, customer_id) of a four-column table reads as amount, customer_id, order_id, note.",
      "No maintenance operation is offered. RisingWave has none of VACUUM, ANALYZE and REINDEX in PostgreSQL's form, and because its BEGIN opens no transaction the connect-time probe cannot ask about them without running them, so it asks nothing and offers none; measured on 3.1.0 on 2026-10-04 (#1387).",
    ],
  },
  {
    name: "OrioleDB",
    via: "postgres",
    tier: "full",
    probedVersion: "OrioleDB beta 16 on PostgreSQL 18.4 (nightly of 2026-08-24)",
    caveats: [
      "All fifteen surfaces answer, the object browser is clean (2 objects for 2 user tables) and row counts are exact - 2000 read as 2000 - with a foreign key and its indexes read back.",
      "Every index reads 0 bytes in the object browser and the table statistics: an OrioleDB table keeps its indexes in its own storage and pg_indexes_size() returns 0 for it, the same shape as YugabyteDB's DocDB.",
      "The cache hit ratio is absent rather than wrong: OrioleDB has its own buffer manager, so pg_statio_user_tables stays at 0 hits and 0 reads and the panel reads N/A.",
      "version() DOES name OrioleDB, and the string carries the build hash and date, because the project publishes nightly images only - there is no released tag to pin.",
    ],
  },
  {
    name: "TimescaleDB",
    via: "postgres",
    tier: "full",
    probedVersion: "TimescaleDB 2.29.2 on PostgreSQL 17.11",
    caveats: [
      "Row counts and sizes for a hypertable are wrong rather than missing: PostgreSQL statistics describe the empty parent table, not the chunks the rows live in. Measured on a 31-chunk hypertable, pg_total_relation_size() answered 24576 bytes where the extension's own hypertable_size() answered 2498560 - about a hundredfold understatement. Excluding the chunk schemas from the browser does not change this, because the parent is what the size is read from either way.",
      "The object browser now lists only user tables. TimescaleDB's own seven schemas are excluded, so a database whose sole hypertable had 31 chunks went from 61 objects to the 2 the user created: 34 came from _timescaledb_internal, 22 from _timescaledb_catalog and 3 from _timescaledb_cache.",
      "The overview shows the PostgreSQL version, not the TimescaleDB extension version.",
      "The agent grounds a stock install: the column capture is one row per table rather than one row per column, so the extension's own catalogs no longer overflow the 200-row budget. On a database with real hypertable data every chunk still appears as its own table in the inventory.",
    ],
  },
  {
    name: "YugabyteDB",
    via: "postgres",
    tier: "full",
    probedVersion: "YugabyteDB 2.25.2.0-b0 (advertises PostgreSQL 15.12)",
    caveats: [
      "Row counts and sizes read 0 until someone runs ANALYZE on the table, so a full database can look empty in the object browser.",
      "Index sizes always read 0 bytes, before and after ANALYZE: index storage lives in DocDB, where pg_relation_size() cannot see it.",
      "The overview's database size reads 0 bytes even with populated tables.",
      "Index types read lsm rather than btree - that is YugabyteDB's real storage, not a misreading.",
      "Reindex is not offered: YugabyteDB refuses REINDEX in both forms (0A000 REINDEX not supported yet), and the provider asks at connect. Vacuum is offered, and its result quotes the server's NOTICE that VACUUM is a no-op there rather than claiming it completed; measured on 2026.1.2.0 on 2026-10-04 (#1387).",
    ],
  },
  {
    name: "Apache Cloudberry (incubating)",
    via: "postgres",
    tier: "partial",
    probedVersion: "PostgreSQL 14.4 (Apache Cloudberry 2.1.0-incubating)",
    caveats: [
      "Table statistics and index statistics are unavailable: both fail with the same engine error, \"query plan with multiple segworker groups is not supported\", which is Cloudberry's MPP planner restriction rather than a missing catalog. The monitoring dashboard itself answers - its overview and performance tabs read connections, database size, table count, deadlocks and checkpoint stats normally - and it is specifically the Tables tab's per-table breakdown and the Storage tab's largest-tables list that fail. Each failing panel says \"This database could not answer this panel\" and prints the engine's error under it, so the planner restriction is not presented as a connection fault.",
      "Row counts and sizes read after ANALYZE are correct - 2000 rows for 2000 rows and 576 KB for 589824 bytes - so the object browser here is not the kind that misleads; what they read before ANALYZE was not probed.",
      "The object browser now lists only user tables: pg_ext_aux, which holds the PAX auxiliary tables pg_pax_fastsequence and pg_pax_tables, is excluded along with gp_toolkit, pg_aoseg and pg_bitmapindex, so the count went from 4 objects to the 2 the user created. Cloudberry's schema documentation lists the latter three but not pg_ext_aux, which is here on measurement rather than on the doc's authority.",
      'Its two failing panels keep the heading "This database could not answer this panel" and print the planner\'s own sentence, which is the right reading: pg_stat_user_tables exists here and is readable, so a differently shaped statement could still succeed - unlike an engine that simply has no such function. A foreign key is read back as if it were enforced but is not: Cloudberry accepts ALTER TABLE ... ADD CONSTRAINT with a warning that referential integrity constraints are not supported, and an orphan insert then succeeds.',
      "The overview's database size reads 62 MB against roughly 900 KB of user tables, which is catalog and segment overhead rather than your data.",
      "The agent needs a least-privilege agent role to ground a run: connecting as the cluster's own gpadmin is refused because the execution profile reads that role as too broad. With that role the capture succeeds.",
      "Apache publishes build images only, so the probe ran on a third-party image (woblerr/cloudberry:2.1.0-incubating); no image from the project itself was measured.",
    ],
  },
  {
    name: "AlloyDB Omni",
    via: "postgres",
    tier: "full",
    probedVersion: "PostgreSQL 17.9 (AlloyDB Omni 17.9.0)",
    caveats: [
      'The version panel cannot be told apart from a stock PostgreSQL 17: version() reports only "PostgreSQL 17.9 on x86_64-pc-linux-gnu" and names AlloyDB nowhere, so the product identity is visible only in the alloydb.* settings and in the image tag.',
      "Row counts and sizes are exact, checked against the engine: 2000 rows read as 2000, and 270336 total bytes as 270336 (180224 table plus 90112 index). Foreign keys are both read back and enforced.",
      "The object browser now lists only user tables, and by ownership rather than by name: pg_depend is asked which schemas an extension created, which answers google_ml AND ai where a hardcoded name list had caught only the first. The count went from 10 objects to the 2 the user created. Google's documentation names the google_ml_integration extension but never its schema. Excluding by name would have hidden a schema from any user who happened to call one google_ml; a user's own schema is never extension-owned.",
      "The browser understates what the image installed: outside the system schemas there are 70 objects for 2 user tables, because 49 extension VIEWS are installed into public itself (g_columnar_* x27, google_db_advisor_* x18, g_agg_stat_statements, g_lap_timer, hypopg_list_indexes and a columnar vectorized-join view), plus 4 views in ai and 11 more in google_ml. They are hidden only because the schema query filters table_type = 'BASE TABLE'.",
      "Those eight google_ml tables are readable by a role with no grants at all: a LOGIN role given only CONNECT, with ALL revoked on schema public, still lists them and answered SELECT count(*) FROM google_ml.supported_vertex_models with 15 rows.",
      'The slow-query panel is always empty and health says why: pg_stat_statements ships with the image but is not installed in it, reported as "pg_stat_statements extension not enabled".',
      "The columnar engine is off by default and turning it on needs ALTER SYSTEM plus a restart, not a reload. With it on, the on-disk sizes stay exact but do not count the columnar copy.",
      "The agent needs a least-privilege agent role to ground a run: the image's own postgres superuser is refused because the execution profile reads that role as too broad. With that role the capture succeeds, over an inventory of 69 objects of which 2 are the user's.",
      "Probed on the 17.9.0 image only; the 15.x and 16.x lines were not probed.",
    ],
  },
  {
    // Read this entry beside OrioleDB below: both are `full`, and what each costs the user
    // is the opposite of the other. ParadeDB's cost is WIDTH - nine extensions in the
    // object browser - and OrioleDB's is DEPTH, its own storage being invisible to
    // PostgreSQL's size functions. Neither caveat belongs on the other row.
    name: "ParadeDB",
    via: "postgres",
    tier: "full",
    probedVersion: "ParadeDB 0.25.4 on PostgreSQL 18.6",
    caveats: [
      "All fifteen surfaces answer and the numbers are correct, but the object browser lists 41 objects for 2 user tables and 74 indexes: ParadeDB ships nine extensions, and PostGIS, its tiger geocoder, pg_ivm and paradedb's own tables are all in there.",
      "Agent plan mode WORKS here, and the reason is worth knowing because the opposite was expected: the grounding capture reads what the ROLE can see, and an unprivileged role sees 168 columns where a superuser sees 539 - the tiger geocoder's 425 are not readable - so the capture stays under its 200-row ceiling and a plan run grounded on 21 tables. Connect as a least-privilege role, not as a superuser: the execution profile refuses a superuser outright, on any PostgreSQL.",
      "version() names PostgreSQL only, so the version panel cannot tell a ParadeDB apart from a stock PostgreSQL 18.6. The release is in the image tag, nowhere the provider reads.",
    ],
  },
  {
    // The drop-in pair, and they are two entries rather than one because they are served by
    // two different drivers - the invariant here is one row per (engine, driver) claim.
    // Read them together anyway: the measurements are identical except for which of the two
    // publishes its own name where the provider looks.
    name: "Percona Distribution for PostgreSQL",
    via: "postgres",
    tier: "full",
    probedVersion: "Percona Server for PostgreSQL 18.6.1 on PostgreSQL 18.6",
    caveats: [
      "Behaves as PostgreSQL throughout: all fifteen surfaces answer, row counts and sizes are correct (2000 rows read as 2000, 131072 bytes as 131072), and a foreign key is read back with its indexes.",
      "The version panel names Percona, unlike the MySQL distribution below: version() answers PostgreSQL 18.6 - Percona Server for PostgreSQL 18.6.1, so there is nothing to mistake for stock PostgreSQL.",
      "Slow queries are empty until pg_stat_statements is enabled, which is stock PostgreSQL behaviour and not a Percona property.",
    ],
  },
  {
    name: "MariaDB",
    via: "mysql",
    tier: "full",
    probedVersion: "12.3.2-MariaDB-ubu2404",
    caveats: [
      "The version shown is MariaDB's full build string, including its OS suffix, not a MySQL-style number.",
      "performance_schema ships OFF (@@performance_schema = 0), so the cache-hit, queries-per-second and buffer-pool figures are absent and the slow-query list is empty until the server is started with performance_schema=ON. Everything the schema tree, sizes, sessions and EXPLAIN need comes from information_schema and is unaffected.",
      "Verified on MariaDB 12.3 only; the 10.x information_schema surface was not probed.",
    ],
  },
  {
    name: "Percona Server for MySQL",
    via: "mysql",
    tier: "full",
    probedVersion: "Percona Server for MySQL 8.4.11-11 (version() reports 8.4.11-11)",
    caveats: [
      "Behaves as MySQL throughout: all fifteen surfaces answer, row counts and sizes are correct (2000 rows read as 2000, 114688 bytes as 114688), indexes and a foreign key are read back, and Analyze, Optimize and Check all succeed.",
      "version() answers a bare 8.4.11-11 and the product name lives only in @@version_comment (Percona Server (GPL), Release 11), so the overview reads that comment and names the server Percona Server 8.4.11-11 (#1444); before that it was indistinguishable from a stock MySQL 8.4.",
    ],
  },
  {
    name: "TiDB",
    via: "mysql",
    tier: "full",
    probedVersion: "8.0.11-TiDB-v8.5.1",
    caveats: [
      "A freshly loaded table reads 0 rows and 0 B until TiDB's own background statistics collection catches up; the numbers correct themselves with no ANALYZE.",
      "Max connections reads 0, because TiDB's max_connections defaults to 0 meaning unlimited, and the connection count beside it reads not published: TiDB answers SHOW STATUS with 13 rows and none of them is Threads_connected (wire, 2026-09-06).",
      "The slow-query panel is always empty: TiDB keeps its slow log in information_schema.SLOW_QUERY, not in the performance_schema view the provider reads.",
      "Storage stats list a phantom InnoDB entry at ibdata1:12M:autoextend, which is a MySQL default echoed back by a server that has no InnoDB.",
      "The Explain panel renders TiDB's own operator tree rather than a MySQL JSON plan: TiDB rejects EXPLAIN FORMAT='json' outright, so the provider sends a plain EXPLAIN and the panel shows the operator tree with estRows as the row estimate (browser, 2026-09-06).",
      "Of the maintenance actions only Analyze is offered: TiDB answers OPTIMIZE TABLE with 8200 OPTIMIZE TABLE is not supported and does not parse CHECK TABLE, and the provider asks at connect which of the three it has; measured on v8.5.8 on 2026-10-04 (#1387).",
      "Probed on a standalone --store=unistore server only; a PD + TiKV deployment was not probed.",
    ],
  },
  {
    name: "StarRocks",
    via: "mysql",
    tier: "partial",
    probedVersion: "StarRocks 3.3.22-753696f (version() reports 5.1.0)",
    caveats: [
      "The version shown is MySQL 5.1: version() returns a fictitious compatibility number, and the real build is only in current_version(), which the provider does not call.",
      "The overview panel renders but publishes no uptime and no connection count: StarRocks answers a bare SHOW STATUS with zero rows and SHOW VARIABLES LIKE 'max_connections' with zero rows, so both read N/A, not published, where they used to read a fabricated 0/151 (browser, 2026-09-06).",
      "The health request and the active-session panel are unavailable: StarRocks has no information_schema.PROCESSLIST, which is the engine's own, and the health read still failed on it when it was re-measured in the browser on 2026-09-06. Every other monitoring panel is read independently, so the missing table costs only those two: getMonitoringData() answered overview, performance, slowQueries, tables, indexes and storage through the provider on 2026-08-24.",
      "A freshly loaded table's row count reads 0 until StarRocks' own background statistics collector catches up, not because the provider fails to read it: measured 2026-09-16, a 5-row table read 0 for 45s on StarRocks 4.1.4 and for roughly 4.5 minutes on 3.3.22 before both reported 5. Sizes used to read 0 regardless of that wait, for a different reason - StarRocks answers INDEX_LENGTH NULL for every BASE TABLE, never a real number the way Doris's 0 is, and DATA_LENGTH + INDEX_LENGTH in SQL is NULL-poisoned by that alone even once DATA_LENGTH itself is real. Fixed 2026-09-16 to DATA_LENGTH + COALESCE(INDEX_LENGTH, 0) everywhere this provider sums the two, so a table's size now tracks its row count on the same collector delay instead of staying absent.",
      "No index information at all: StarRocks exposes no secondary-index catalog, so the object browser and the index panel show none.",
      "A parameter cannot sit in the LIMIT position under the binary prepared protocol, and this engine says so in as many words: measured 2026-09-22 through mysql2, LIMIT ? answers 'using parameter(?) as limit or offset not supported' while the identical statement with the number written in succeeds. Same constraint as Doris, which it is a fork of, and it cost the object browser the same 500 on every folder read until the bulk read wrote its bound in. Verified through the provider afterwards against a seeded database: describeObjects() reads 2 objects with 3 columns on the first, and a bound of 1 reads 1 object and reports its own truncation.",
      "The Explain panel renders StarRocks's own text plan: StarRocks does not parse EXPLAIN FORMAT='json', so the provider sends a plain EXPLAIN, which answered a 13-node tree for a constant SELECT (browser, 2026-09-06).",
      "Inline row edit saves. StarRocks prepares SELECT ? but refuses to prepare an UPDATE, INSERT or DELETE with errno 1295 (This command is not supported in the prepared statement protocol yet), and nothing has run when it does, so such a statement is sent once more as text with its values written in; before that every Apply failed. Measured on 4.1.6 and 3.3.22 on 2026-10-09 (#1403).",
    ],
  },
  {
    // Placed next to StarRocks because StarRocks is a FORK of Doris, and this registry
    // had been carrying the fork while missing the original. The neighbouring rows are
    // the reason to read both: they share the fictitious version() and the empty index
    // catalog, and they differ on the numbers, which is the half a reader acts on.
    // Doris reported 2000 rows and 10187 bytes for a table holding exactly that, where
    // StarRocks reports hard zeros - so a fork's row is a prior for the next probe and
    // never an inheritance.
    name: "Apache Doris",
    via: "mysql",
    tier: "full",
    probedVersion: "Apache Doris 4.1.3-rc02-7126cf65d96 (version() reports 5.7.99)",
    caveats: [
      "The overview and health panels render since 2026-09-06, and the overview publishes no uptime and no connection count: Doris answers a bare SHOW STATUS with zero rows and SHOW VARIABLES LIKE 'max_connections' with zero rows, so uptime reads N/A and connections read N/A, not published (browser, 2026-09-06).",
      "No index information at all: information_schema.statistics is empty on Doris, so the index panel and the object browser report none however many keys a table declares.",
      "A declared foreign key is invisible and unenforced: Doris accepts ADD CONSTRAINT ... FOREIGN KEY and lists it in SHOW CONSTRAINTS, but information_schema.KEY_COLUMN_USAGE is empty, so the ER diagram draws no relationship - and an orphan row inserts successfully, because the constraint is a planner hint there.",
      "Optimize and Check are unavailable: neither statement exists in the Doris grammar. Analyze works.",
      "A parameter cannot sit in the LIMIT position under the binary prepared protocol: measured 2026-09-22 through mysql2, the identical statement answers with a literal LIMIT and fails with LIMIT ? on 'mismatched input LIMIT expecting {<EOF>, ;}', while the text protocol takes either. It cost the object browser a 500 on every folder read until the bulk read wrote its bound into the statement instead of binding it. Stock MySQL 8 binds it happily, so this is the relative's constraint and the same one StarRocks states outright.",
      "Row counts and sizes are correct but late: a table read 0 rows and 0 B immediately after a 2000-row insert and the true 2000 rows / 10187 bytes about a minute later, with an ANALYZE in between changing nothing. The lag is self-correcting, so a freshly loaded table looks empty for a while.",
      "A UNIQUE KEY table declares no primary key to the product: information_schema reports COLUMN_KEY as UNI rather than PRI, so the object browser marks no column primary.",
    ],
  },
  {
    name: "Vitess",
    via: "mysql",
    tier: "full",
    probedVersion: "8.0.43-Vitess (Vitess 24.0.2)",
    caveats: [
      "Cancelling a running query does nothing: vtgate refuses KILL QUERY with VT07001 and the statement runs to completion, so a 5 second SLEEP still took its full 5003 ms after the cancel.",
      "Table and index statistics name the physical shard database (vt_probe_0), not the keyspace the connection points at.",
      "Per-index sizes always read 0 bytes: the size query matches information_schema.INNODB_TABLES.NAME against '<database>/%', and Vitess names the InnoDB table after the shard database, so on a keyspace called probe nothing matches.",
      "Setting a session variable can fail where reading it works: SET @@cte_max_recursion_depth is rejected with VT05006 unknown system variable, while SELECT @@cte_max_recursion_depth answers 1000.",
      "Check Table is not offered: vtgate does not parse CHECK TABLE (syntax error at position 6 near 'CHECK'), and the provider asks at connect which of the three maintenance verbs it has, so Analyze and Optimize are drawn; measured on 24.0.4 on 2026-10-04 (#1387).",
      "Probed on an unsharded single-shard keyspace only (show vitess_shards returns probe/0); nothing here is measured about a sharded keyspace.",
      "No permission-error class could be measured, and the reason is the test image rather than Vitess: vttestserver accepts any username with any password and grants it full rights, and CREATE USER is a vtgate parse error, so no restricted role could be created to test with.",
    ],
  },
  {
    name: "OceanBase",
    via: "mysql",
    tier: "partial",
    probedVersion: "5.7.25-OceanBase_CE-v4.4.2.1",
    caveats: [
      "Fourteen of the fifteen surfaces return without throwing, but only twelve of them do their job, which is what makes this partial rather than full.",
      "Health is the one hard failure: the tenant has no performance_schema database at all (ERROR 1049 Unknown database 'performance_schema'). Health passes on the MySQL 26.7.0 baseline probed in the same pass, so this is the engine's.",
      "Performance metrics and storage stats are answered but useless, and the overview, table statistics and index statistics carry useless zeros in their size fields while their row and structure data is real.",
      "Every size reads 0 B - table, index, database and storage - because OceanBase reports DATA_LENGTH 0 and INDEX_LENGTH 0 in information_schema.TABLES.",
      "Storage stats list a phantom InnoDB row at ibdata1:12M:autoextend whose size reads N/A: OceanBase fakes innodb_data_file_path for compatibility and there is no such file.",
      "The slow-query panel reads 0 rows, which is an honest empty rather than a fabricated number.",
      "The header badge reads Slow rather than Online, and it does not mean latency: the badge is set from whether the health request succeeded, and health is the one surface this engine refuses.",
      "Row counts are correct once ANALYZE TABLE has run - 2000 reported for 2000 real - and it must be the MySQL-mode statement: the Oracle-mode ANALYZE TABLE t COMPUTE STATISTICS is rejected with ERROR 1235.",
      "The object browser is clean, 2 objects for 2 user tables: the schema query scopes to TABLE_SCHEMA and to TABLE_TYPE = 'BASE TABLE', and OceanBase's own 860 + 70 + 18 catalog objects are all SYSTEM TABLE or SYSTEM VIEW, so neither filter admits them.",
      "A foreign key is both read back and enforced (an orphan insert is refused with ERROR 1452), but OceanBase creates no backing index for one, so index counts will not match an equivalent MySQL schema.",
      "Cancelling a running query genuinely cancels it, and the Explain panel genuinely describes without executing: an 11-row ASCII plan with an EST.ROWS column.",
      "Sign in to the BUSINESS tenant rather than sys: MODE=mini creates a user tenant named test, so the login is root@test, and the sys tenant exposes nine databases including Oracle-mode artifacts (LBACSYS, ORAAUDITOR, SYS, ocs, sys_external_tbs) that the user tenant does not have.",
      "Probed on the oceanbase/oceanbase-ce:4.4.2-lts image with MODE=mini only.",
    ],
  },
  {
    name: "SingleStore",
    via: "mysql",
    tier: "partial",
    probedVersion: "SingleStoreDB 9.1.1 (advertises MySQL 5.7.32)",
    caveats: [
      "Ten of the fifteen surfaces answered when this engine was first probed. Four of those failures were ours rather than SingleStore's and are fixed: Test Connection, health, the overview and the monitoring dashboard all failed with one engine message, \"This command is not supported in the prepared statement protocol yet\", until every parameterless statement moved to MySQL's text protocol on 2026-08-24, and all four answer since (browser, 2026-09-06).",
      "The Explain panel renders SingleStore's own text plan: EXPLAIN FORMAT=JSON is still a parse error here, so the provider no longer sends it and asks for a plain EXPLAIN instead (browser, 2026-09-06).",
      "The version shown is MySQL 5.7.32: now that the overview renders, it displays the wire version SingleStore advertises rather than SingleStoreDB 9.1.1 (browser, 2026-08-24).",
      "Row counts and sizes are missing rather than wrong: a 2000-row table reads rowCount 0 and 0 B in the object browser, the table statistics and the storage panel, against a ground truth of 2000 rows and 77046 bytes measured four independent ways.",
      "SingleStore leaves information_schema.TABLES zeroed and keeps the real numbers elsewhere - SHOW TABLE STATUS, information_schema.OPTIMIZER_STATISTICS.ROW_COUNT and the EXPLAIN plan's est_table_rows - and running ANALYZE does not change what the panels read.",
      "The index panel lists 4 rows for 2 tables against the MySQL baseline's 2: SingleStore auto-creates a shard key on every table and reports it as an index named __SHARDKEY with indexType SHARD, beside PRIMARY.",
      "Foreign keys do not exist: ALTER TABLE ... ADD FOREIGN KEY fails with ERROR 2752, and with SET GLOBAL ignore_foreign_keys = ON a CREATE TABLE carrying an inline foreign key is accepted and the constraint silently stripped, which is the one shape where a user could believe they have a key they do not.",
      "Of the maintenance actions, Analyze works; Optimize and Check fail with the same prepared-statement error.",
      "The header badge reads Slow rather than Online, and it does not mean latency: the badge is set from whether the health request succeeded, and health is one of the surfaces refused over the prepared-statement protocol.",
      "Permission errors are identical to MySQL and surface with the server's own text intact, and under a SELECT-only role the table list correctly showed only the granted table.",
      "The dev image needs no licence key: it self-licenses with ROOT_PASSWORD as the only variable set, its log recording an unlimited expiration and the Developer Image edition.",
      "Probed on the ghcr.io/singlestore-labs/singlestoredb-dev:0.2.82 image only.",
    ],
  },
  {
    name: "Valkey",
    via: "redis",
    tier: "full",
    probedVersion: "Valkey 9.1.1",
    caveats: [],
  },
  {
    name: "DragonflyDB",
    via: "redis",
    tier: "full",
    probedVersion: "DragonflyDB df-v1.40.1",
    caveats: [
      "Every active session's user reads default, whatever ACL user authenticated: Dragonfly's CLIENT LIST publishes no user= field at all.",
      "Every active session reads idle with state N: Dragonfly's CLIENT LIST carries no cmd= or flags= field.",
    ],
  },
  {
    name: "KeyDB",
    via: "redis",
    tier: "full",
    probedVersion: "KeyDB 6.3.4",
    caveats: [
      "KeyDB publishes no version field of its own, so the overview cannot be told apart from a Redis 6 server.",
      'An active session\'s command can appear without its subcommand ("client" rather than "client|list").',
    ],
  },
  {
    // The fourth Redis relative. Valkey, DragonflyDB and Garnet all publish a version field
    // of their own beside the emulation level (`valkey_version`, `dragonfly_version`,
    // `garnet_version` in INFO), and the provider reads it, labeling the overview ahead of
    // the emulation level (e.g. "Garnet 2.1.5 (Redis 7.4.3)"). KeyDB alone publishes nothing
    // of its own, so it is the only one of the four where the emulation level is the real
    // version.
    name: "Garnet",
    via: "redis",
    tier: "full",
    probedVersion: "Garnet 2.1.5 (advertises Redis 7.4.3)",
    caveats: [
      "Every size reads 0 B: Garnet's INFO publishes no used_memory field at all, so the database size and the memory storage panel are a derived zero rather than a measurement.",
      "The cache hit ratio reads 100%: Garnet publishes neither keyspace_hits nor keyspace_misses, and 100 is the fallback both counters being absent produces (D14).",
      "Max connections reads 0: Garnet's INFO publishes no client-limit field at all, unlike Dragonfly, which publishes one under the underscored max_clients.",
      "Connected clients reads 0 even with a client attached, because Garnet's connected_clients stays 0; the session list itself is correct and shows the connection.",
      "Key prefixes group as expected: 71 keys across user:*, session:* and queue:* were read back as three patterns.",
    ],
  },
  {
    name: "FerretDB",
    via: "mongodb",
    tier: "full",
    probedVersion: "FerretDB 2.7.0 (MongoDB 7.0.77 wire)",
    caveats: [
      "Sign in with the credentials of FerretDB's PostgreSQL backend; authMechanism=PLAIN is rejected.",
      "The version shown is the MongoDB wire version FerretDB advertises, not its own build number.",
      "FerretDB needs its own PostgreSQL backend, so it is a two-container deployment rather than one image.",
    ],
  },
  {
    name: "ScyllaDB",
    via: "cassandra",
    tier: "partial",
    probedVersion: "ScyllaDB 2026.2.4-0.20260810.e54224b8cebb (advertises Cassandra 3.0.8)",
    caveats: [
      "Every surface answers since 2026-08-24, but five answer EMPTY: the connection count, the cache hit ratio and the active-session list all read Cassandra's system_views virtual tables, which ScyllaDB does not have, so they degrade the way a denied grant does instead of failing the connection.",
      'Connections reads 0 rather than N/A on the monitoring dashboard, and that zero is the one number here the server did not measure: there is no field on the overview to say "not published", so a build with no system_views keyspace reports the same 0 a permission-denied role does.',
      "The overview, health, performance-metrics, active-session and monitoring surfaces used to throw, and Test Connection with them; the connection dialog gates its save on that request, so before 2026-08-24 a ScyllaDB connection could not be created in the dialog at all and had to arrive as a seeded or admin-managed one.",
      "The SQL editor and the object browser work in full: statements run, and every one of 18 CQL types read back byte-identically to Apache Cassandra 5.0.9 probed in the same pass.",
      "The version reads Apache Cassandra 3.0.8 - the compatibility number system.local publishes - not ScyllaDB 2026.2.4, which lives in system.versions where the provider does not look. Uptime is real: gossip_generation exists here and answers.",
      "The object browser lists one extra object per secondary index, and the tree and the overview disagree about it: ScyllaDB backs an index with a MATERIALIZED VIEW, so customers_country_idx_index appears in system_schema.views and the tree lists it, while the Tables count comes from system_schema.tables and does not (measured: 4 objects in the tree against tableCount 3). Cassandra lists neither.",
      'Error classes are identical to Cassandra even though the server\'s wording is not - a missing table is "unconfigured table" rather than "table ... does not exist" - because the provider classifies on the driver\'s error code rather than on the message text.',
      "Row counts and sizes are blank for the same reason as on Cassandra, and the panels read N/A rather than a fabricated zero.",
      'Creating a keyspace needs NetworkTopologyStrategy on the 2026.2 line: SimpleStrategy is refused outright with "SimpleStrategy doesn\'t support tablet replication", so the setup recipe in the Cassandra provider doc does not run unchanged.',
      "ScyllaDB 2025.1.14-0.20260612.103b84070f3b was probed in the 2026-08-21/22 pass and behaved identically on every surface, including the same verbatim refusal the fix keys on, so this entry describes both the 2025.1 and the 2026.2 line - but only these two builds, only a single-node container, and only 2026.2.4 was re-probed after the fix.",
    ],
  },
  {
    // The first relative of a driver whose query language is neither SQL-shaped nor JSON: it
    // answers the Prometheus HTTP API, so the `prometheus` provider serves it unchanged. Probed as a
    // single node scraping the compose fixture's targets, with Prometheus 3.13.3 as the baseline in
    // the same pass (#1085 section 7). Claimed for PromQL only: nothing written in MetricsQL, its own
    // query language, was measured, and one PromQL subquery answered different points here than on
    // Prometheus, as a caveat says. The advertised 2.24.0 is in the version string and in no caveat:
    // the overview, the one panel that shows a version, fails here, as the first caveat says.
    name: "VictoriaMetrics",
    via: "prometheus",
    tier: "partial",
    probedVersion: "VictoriaMetrics v1.152.0 (advertises Prometheus 2.24.0)",
    caveats: [
      "The Overview and Storage tabs of the monitoring dashboard fail, and so does the Scrape pools folder, whose count reads unavailable: VictoriaMetrics answers /api/v1/status/runtimeinfo, /api/v1/status/flags and /api/v1/scrape_pools with HTTP 400 and the text 'unsupported path requested', and the message shown says the server does not serve the path, as the server's own answer rather than a server that cannot be reached.",
      "A metric's Source tab shows its type and help and no unit: VictoriaMetrics' /api/v1/metadata entries carry no unit, and the provider leaves it out rather than inventing an empty one.",
      "A target's Source tab has no scrapeInterval or scrapeTimeout: VictoriaMetrics' /api/v1/targets entries carry neither, and keep them as __scrape_interval__ and __scrape_timeout__ among the discovered labels, which the tab shows.",
      "A target VictoriaMetrics has not scraped yet reads as down: VictoriaMetrics reports it with health down, no error and a last scrape of 1970-01-01T00:00:00Z, where Prometheus reports health unknown.",
      "The Rule groups, Recording rules and Alerting rules folders are empty: a single-node server evaluates no rules, so its /api/v1/rules answered no group, and it answers that path from vmalert only when it is started with -vmalert.proxyURL.",
      'A string expression such as "libredb" returns no rows: VictoriaMetrics answers it with an empty vector, where Prometheus answers a string.',
      "A subquery's points are counted back from its evaluation time, both ends of its window kept: avg_over_time(up[5m])[30m:1m] answered 31 points ending at that time, where Prometheus 3.13.3 answers 30 on whole minutes.",
      "PromQL infos and warnings do not appear beside a result: VictoriaMetrics answered rate(up[5m]) with no notice where Prometheus 3.13.3 attaches 'PromQL info: metric might not be a counter', and it sent none with any other answer measured.",
    ],
  },
  {
    // The first relative of the `kafka` driver: it answers the Kafka protocol, so the provider serves
    // it unchanged. Probed as a single node seeded by the Kafka fixture's own scripts, through a real
    // provider run by tests/live/kafka-read-only.ts, with Apache Kafka 4.3.1 as the baseline in the
    // same pass (#1088 section 8). Every surface answered and the broker's state was unchanged by the
    // run; the caveats name the figures Redpanda does not publish over the protocol, and the group
    // type it cannot report, which is right there because it has no other kind of group.
    name: "Redpanda",
    via: "kafka",
    tier: "full",
    probedVersion: "Redpanda v26.2.2",
    caveats: [
      "Max connections reads 0, no limit published: Redpanda's DescribeConfigs answer for a broker holds no max.connections, and it keeps its connection limits in its cluster configuration, which the Kafka protocol does not read.",
      "A broker's Source tab lists nine configs where Apache Kafka 4.3.1 lists 340: Redpanda answers DescribeConfigs for a broker with those nine entries only.",
      "The Storage tab shows no usage percentage: Redpanda's DescribeLogDirs answer carries no total or usable bytes for its data directory, so only the size is shown.",
      "Every consumer group reads as classic, which on Redpanda is always right: it answers ListGroups up to v4, which carries no group type, and it has no KIP-848 consumer group protocol at all.",
    ],
  },
];

/** The verified relatives served by one shipped driver, in registry order. */
export function compatibleEnginesFor(type: DatabaseType): readonly WireCompatibleEngine[] {
  return WIRE_COMPATIBLE_ENGINES.filter((engine) => engine.via === type);
}

/**
 * The counting rule for #424's claim discipline: a published count is the external
 * engines plus the relatives an actual probe verified, and nothing else.
 *
 * Renamed from `verifiedEngineCount`, and the rename is the fix rather than a
 * tidy-up. That function counted `SHIPPED_DATABASE_TYPES`, which includes the
 * embedded store, so it answered 33 while README.md published 32 for the same
 * claim. Both numbers were defensible and neither said which set it was counting,
 * which is precisely the failure a single definition exists to prevent: a count is
 * wrong when its denominator is unstated, not when its digit is stale.
 *
 * The name now says the set. A product is countable here when a user can point the
 * app at it, so the embedded store is out of both halves of the sum.
 *
 * Still no runtime consumer: README.md and the docs table are markdown and quote the
 * number as prose, and the login hero prints the two halves separately - the external
 * count in the proof row, the relatives count in the relatives line - rather than their
 * sum. This exists
 * so the arithmetic has one definition, and the unit test pins it.
 */
export function connectableProductCount(): number {
  return EXTERNAL_DATABASE_TYPES.length + WIRE_COMPATIBLE_ENGINES.length;
}
