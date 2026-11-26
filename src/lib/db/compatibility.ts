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
import type { StatementLanguage } from "@libredb/provider-sdk/manifest";
import type { DatabaseType } from "@/lib/types";
import { BUNDLED_CATALOG } from "./engine-catalog/catalog.generated";
import {
  BUNDLED_CONNECTION_STRING_ACCEPTED,
  BUNDLED_DIALOG_OFFERS_URI,
  BUNDLED_READS_TRUST_MATERIAL,
} from "./engine-catalog/connection-flags.generated";

/**
 * The drivers we ship, i.e. the engines that have a provider, a doc page and an integration test of their own: the
 * engine catalog's ids, in its order, ascending by id (docs/providers/CONTRACT.md, clause M-70). Kept here beside the
 * registry because the published count is "shipped drivers + verified relatives" and both halves must come from the
 * same module or they drift.
 *
 * The catalog is projected from the engine declarations (`./engine-catalog/catalog.generated.ts`, written by
 * scripts/generate-engine-catalog.ts), each engine's `id` authored in its declaration. The generated record is
 * annotated `Record<DatabaseType, CatalogEntry>`, so a member of the union with no declaration fails the typecheck
 * there, which is how a new type-id cannot be left out of the count; a hand-written array had no guard at all.
 */
export const SHIPPED_DATABASE_TYPES: readonly DatabaseType[] = Object.freeze(
  Object.keys(BUNDLED_CATALOG) as DatabaseType[],
);

/**
 * The shipped ids that are databases a user already runs, in the catalog's order: every engine whose declaration
 * authors `location` as `external`.
 *
 * `libredb` is the embedded store this app carries with it, the one engine whose declaration says `embedded`; every
 * other id is an external engine you point the product at. SQLite and DuckDB are files rather than servers and are
 * still external: each is the user's file, opened from a path they give us. Everything published as a database count
 * means the external set - README.md's "<N> drivers reach <M> named engines", the login hero's engine claim - so the
 * split needs a definition somewhere, and it belongs beside `SHIPPED_DATABASE_TYPES` rather than in the UI that prints
 * it. Filtering `libredb` out by name at each call site is how the two halves of a published count drift apart.
 *
 * Also the DENOMINATOR the outward-facing catalog copy is counted against:
 * `tests/unit/lib/catalog-copy-engine-count.test.ts` compares this length with every
 * numeral qualifying "engines" in each storefront file its `COPY_FILES` lists, which until
 * #D47 were only ever corrected by somebody noticing.
 */
export const EXTERNAL_DATABASE_TYPES: readonly DatabaseType[] = Object.freeze(
  SHIPPED_DATABASE_TYPES.filter((type) => BUNDLED_CATALOG[type].location === "external"),
);

/** True for every shipped id except the embedded store, and false for a value the catalog does not hold. */
export function isExternalDatabaseType(type: DatabaseType): boolean {
  return Object.hasOwn(BUNDLED_CATALOG, type) && BUNDLED_CATALOG[type].location === "external";
}

/**
 * Which shipped engines are handed core's trust material, the CA certificates of the file `NODE_EXTRA_CA_CERTS` names
 * (`TrustMaterial` in `./types`, read once per process by `./trust-material`): true for an engine whose provider's TLS
 * library does not read Node.js's trust store, so the variable never reaches it on its own.
 *
 * `createDatabaseProvider` reads this row, through `typeIdRow`, to set `ProviderBuildContext.trust`: core's material
 * where it is true, `undefined` everywhere else. Node.js adds the variable's certificates to every TLS connection it
 * opens without a `ca` of its own, so a provider on `node:tls`, `node:https`, `fetch` or a driver built on them needs
 * nothing, and is handed nothing.
 *
 * Measured on 2026-11-22 for every type-id whose provider opens TLS, in Verify (system trust) against a server whose
 * certificate only a private CA in `NODE_EXTRA_CA_CERTS` signs: every one reached it but Db2, whose driver, db2-node,
 * verifies with rustls against the operating system's store and never reads the variable. The engines with a
 * configurable host were built through the provider factory on Node.js 26.13.1 in the runner image, Node.js 24.22.1
 * and Bun 1.4.4; RabbitMQ's AMQPS leg was dialled through its `dialAmqp`, not built by the factory, on Node.js 26.13.1
 * in the runner image and Bun 1.4.4;
 * Snowflake, BigQuery and Firestore, whose hosts are fixed on port 443, only on Node.js 26.13.1 in the runner image.
 * Not measured:
 * Oracle in Thick mode, whose TLS is the Oracle Client's own (the backlog). A new provider sets its declaration's
 * `connection.readsTrustMaterial` to true only when its TLS library is not Node's, such as a native addon with a TLS
 * stack of its own, and then hands `requireTrustMaterial(context.trust)` from `./utils/require-trust-material` to its
 * TLS wherever a connection verifies against the system trust store.
 *
 * Each row is the engine's `connection.readsTrustMaterial`, authored in its declaration and projected into
 * `./engine-catalog/connection-flags.generated.ts` (docs/providers/CONTRACT.md, clause M-71): an exhaustive frozen
 * Record over the union, so a new type-id cannot join without someone answering, and
 * `tests/security/provider-trust-material.test.ts` holds every entry against the material that engine's provider
 * holds when the factory builds it.
 */
export const READS_TRUST_MATERIAL: Readonly<Record<DatabaseType, boolean>> = BUNDLED_READS_TRUST_MATERIAL;

/**
 * Which shipped engines' connections serve their object tree from one session, the editor's, each with the reason
 * Studio's census found, or `null` where a tree read may run on a metadata session of the connection's own
 * (docs/providers/CONTRACT.md, clause C-66).
 *
 * The host's own record, core-owned: no engine declaration requests it, and no manifest member states it, since which
 * session a tree read runs on is the host's measurement of the engine and not a claim the engine makes. It is read only
 * by `sessionCapacity` in src/lib/db/session-capacity.ts, which answers `one` for an engine this record names a reason
 * for, and for a connection whose database is in memory, and `several` otherwise. The class decides only which session a
 * tree, monitoring or health read, or a kill, runs on, so a wrong `null` opens one more session for those reads, a
 * wrong reason keeps today's sharing, and neither authorizes anything.
 *
 * An exhaustive Record over the union, so a new type-id cannot join without someone answering, and
 * `tests/unit/db/compatibility.test.ts` holds a reason for every engine granted a single-writer file. Frozen like the
 * records above it.
 */
export const SERVES_ONE_SESSION: Readonly<Record<DatabaseType, string | null>> = Object.freeze({
  postgres: null,
  bigquery: null,
  snowflake: null,
  spark: null,
  mysql: null,
  // A file serves a second session; an in-memory database is another database per handle, which the class reads from
  // the connection.
  sqlite: null,
  libsql: null,
  duckdb:
    "It keeps one read-write handle per database file, as its single-writer file grant records, so a second session would be a second handle on the file.",
  oracle: null,
  db2: null,
  mssql: null,
  clickhouse: null,
  druid: null,
  trino: null,
  cassandra: null,
  elasticsearch: null,
  opensearch: null,
  mongodb: null,
  couchbase: null,
  redis: null,
  prometheus: null,
  kafka: null,
  etcd: null,
  neo4j: null,
  milvus: null,
  qdrant: null,
  weaviate: null,
  influxdb: null,
  influxdb3: null,
  oxia: null,
  databend: null,
  s3: null,
  kubernetes: null,
  mqtt: "Its tree reads nothing from the broker, so a second session would only cost one more broker read at its open.",
  firestore: null,
  rabbitmq: null,
  opcua: "Its tree lists no node, so a second session would only take one more of the server's sessions at its open.",
  mtconnect: null,
  modbus:
    "Its tree is the connection's register map, so a second session would only dial a device that may serve one client at a time.",
  netconf:
    "It holds one NETCONF session per provider, and a device may admit few sessions, none measured, so a second session could be refused where the editor's answers.",
  snmp: "Its tree is the bundled catalog, so a second session would only probe the agent once more at its open.",
  sparkplug:
    "Its tree is the session's own connect read, so a second session would answer another read's snapshot after a broker read of its own.",
  libredb:
    "It keeps one read-write handle per database file, as its single-writer file grant records, so a second session would be a second handle on the file.",
});

/**
 * The engines on which **agent mode** executes statements itself: Studio's review record of the
 * engines agent and MCP statements run on.
 *
 * Every agent and MCP statement gate reads this record at run time, and an engine it does not
 * list is refused by name, whatever its provider implements: the start of a statement-sending
 * agent run (`workflowAvailability`, `src/lib/agent/agent-manifest.ts`), the factory's
 * `agent-read-only` and `agent-handover` acquisition and the core read path every agent,
 * hand-over and MCP read-only statement passes (`runReadOnlyReading`; plan mode's statistics
 * read under `agent-operations` does not), both through
 * `assertStatementsReviewed` (`src/lib/db/statement-review.ts`, `PROFILE_ENGINE_NOT_REVIEWED`),
 * and MCP's served set (`src/lib/mcp/tools/served-engines.ts`). A provider's read-only
 * statement path is a second precondition, required and never enough: an engine on the record
 * whose provider has no `queryReadOnly` is still refused `PROFILE_UNSUPPORTED_BY_PROVIDER`,
 * never served `query()`. `queryReadOnly` exists on the providers this list names, each under a
 * boundary it declares (`providers/sql/postgres.ts`, `providers/sql/sqlite.ts`,
 * `providers/sql/duckdb/`, `providers/sql/mssql.ts`, `providers/sql/mysql.ts`,
 * `providers/platform/kubernetes/`, `providers/document/mongodb/index.ts`,
 * `providers/sql/clickhouse/index.ts`, `providers/sql/libsql/index.ts`,
 * `providers/timeseries/influxdb/sql-provider.ts`, `providers/sql/search/index.ts`,
 * `providers/sql/db2/index.ts`).
 *
 * They do not draw the boundary the same way, and the list deliberately says nothing about that.
 * PostgreSQL, SQLite, DuckDB, SQL Server and MySQL bound a statement with the engine's own
 * read-only mechanism. PostgreSQL refuses the write inside `BEGIN READ ONLY`, SQLite and DuckDB
 * open the file read-only, and SQL Server, which has no read-only transaction of any kind,
 * verifies at open that the session's principal cannot write, then admits one statement at a
 * time by asking the optimizer to compile it without running it. MySQL and MariaDB are the
 * two-layer shape: a least-privilege principal, because DDL ends a read-only transaction through
 * its implicit commit, and `START TRANSACTION READ ONLY` for the writes the grants alone would
 * not stop. Kubernetes has no read-only session at all: Studio's request allowlist on the final
 * method and path of every request, plus the identity's RBAC, is the boundary. MongoDB has none
 * either: the connection's user is the boundary, proven, when a connection that sends statements
 * opens, by the server's own account of its privileges and by a write the server must refuse,
 * with the provider's command reader in front of the engine and `maxTimeMS` plus Studio's kill of
 * a read's session as its deadline. ClickHouse refuses writes for the request itself, under
 * `readonly = 1`, and its user is proven at open to hold nothing that setting leaves usable.
 * libSQL's boundary is the token: one the server refuses every write for, proven at open by
 * writes that change nothing and that the server must refuse, and by the token's own read-only
 * claim. InfluxDB 3's boundary is the engine's: the 3.12 Core planner refuses every write and DDL
 * statement on the one route that carries statement text, whatever the token, and the open
 * checks the server is that line. Elasticsearch's boundary is the engine's too: the grammar of
 * its SQL endpoint, the one route that carries statement text, holds no write or DDL statement,
 * and every one sent raw there is refused, and the open checks the server is the measured 9.1 line. OpenSearch's is
 * the engine's as well, from the same module: its SQL plugin refuses every write and DDL statement sent raw, and since
 * a cluster setting can turn its DELETE on, the open proves that DELETE off (the setting reads off, and a DELETE on a
 * fresh name is refused) and checks the server is the measured 3.8 line. Oracle's is the user's: one set READ ONLY,
 * which the server refuses every write for, proven before every statement to reach no code, sequence, package,
 * directory, system privilege or database link that runs outside it, with every statement in a read-only transaction
 * the driver rolls back. Db2's is the user's too: one holding CONNECT and SELECT, proven before every statement to hold
 * nothing else that writes and to reach no code, view, sequence or control that runs with another's authority, with
 * every statement a fullselect in a unit of work rolled back on a connection of its own. Cassandra's is the role's: one
 * holding only SELECT on the connection's keyspace, which the server refuses every write, DDL and GRANT statement as
 * Unauthorized, proven before every statement to be no superuser, to hold no other permission, and to reach no column
 * masked with a user-defined function, on an Apache Cassandra 5.0 server whose own refusal of a DROP proves it
 * enforces grants, each statement on a session of its own. Couchbase's is the user's: one whose only role is
 * query_select on named scopes of the connection's bucket (a role on every scope also reaches its _system scope, so
 * it is refused). The query service refuses such a user every write, DDL, GRANT, function call, CURL() and sequence
 * statement, and the user is proven before every statement through GET /whoami, a group's roles included, on a
 * server whose own refusal of a DELETE proves it enforces the role, with only one SELECT sent, since such a user may
 * still run UPDATE STATISTICS and EXECUTE. Druid's is the engine's: under the native engine its SQL endpoint refuses
 * every INSERT, REPLACE, UPDATE, DELETE, MERGE and DDL statement and every read of EXTERN, whoever asks, which the open
 * and every statement prove with an INSERT the server must refuse, and the request context naming the engine is
 * written by Studio, with only one SELECT sent, since a SET before a statement would select another engine. Trino's is
 * the operator's access control: it must refuse every identity every catalog's table functions, since a pass-through
 * function runs its text in the catalog's source under the catalog's own credential, outside Trino's read-only
 * transaction, and catalog management must be refused, which the open and every statement prove with calls that run
 * nothing and the server must refuse by permission (Trino's read-only access control passes, told apart by a table
 * procedure it alone refuses), with every statement in a read-only transaction rolled back and only one SELECT sent.
 * LibreDB's is the handle's: an embedded file with no principal, which each statement opens on a handle of its own
 * through Studio's read-only file adapter, with no writer lock, so it opens beside the editor's writer, and with no
 * call that can write the file, the engine's one write path refusing before any write; Studio's reader admits get,
 * prefix and range only.
 * InfluxDB's (InfluxQL, 1.x and 2.x) is the principal's: a 1.x user refused SHOW USERS as needing the admin privilege,
 * or a 2.x token that lists no system bucket, refused a no-op DELETE on every database it lists, proven before every
 * statement, so an admin, a server with authentication off and a principal that can write anywhere, where SELECT ...
 * INTO would land, are refused; InfluxDB 3 is refused on this path. Studio's reader admits one SELECT, SHOW of the
 * catalog or EXPLAIN of a SELECT, with no comment. Weaviate's is the provider's closed table of read requests, which
 * can name no write, with a key the server proves a viewer before every request, so a connection with no key, an
 * admin key, a role that writes and a server with RBAC off are refused; Studio's reader admits the meta, schema,
 * shard, tenant, alias and node reads and a bare aggregate count, a COLD tenant is refused rather than woken, and every
 * answer carries names, counts and flags only. Qdrant's is the provider's closed table of read routes, which can name no
 * write, with a key proved read-only before every request by its JWT claims, when it has them, granting access r
 * alone, and by the server refusing an empty alias update and an empty point delete on every collection the key lists,
 * so a connection with no key, the API key, a JWT that writes any collection or alias and a server with no key
 * configured are refused; Studio's reader admits the version, collection, alias, count and cluster reads, so no query
 * reaches the inference address, and every answer carries names, counts and flags only. Neo4j's is the user's, on
 * Enterprise Edition only: before every statement the server must name Enterprise at a version whose built-in routines
 * are pinned, every granted privilege of every role must be a read, LOAD must be revoked or denied, and every
 * procedure and function the user can execute must be a built-in, so an administrator, a user that writes or loads, a
 * server with an extension the user can run and Community Edition, which has no roles, are refused. Studio's reader
 * admits one statement of the editor's read policy with no comment, and the server's EXPLAIN classification and a READ
 * session stand behind it. Milvus's is the provider's gRPC stub filtered to a closed table of RPCs, whose only writes,
 * Load and Release, no agent request reaches, with a user the server proves read-only before every request: it must
 * be refused the list of users, and every privilege its roles and public grant must be a read, so a connection naming
 * no user, root, the admin role, a role that writes, loads or releases and a server with authorization off are
 * refused; Studio's reader admits the database, collection, schema, statistics, load state, partition, index and alias
 * reads in the connection's own database, so no search runs a function on the server, and every answer carries names,
 * counts and flags only. Each provider's own `queryReadOnly` argues its own case.
 * `tests/unit/lib/agent/engine-support.test.ts` holds the first-party providers to this record in
 * both directions - it walks EVERY id in the `DatabaseType` union and reads `queryReadOnly` off the
 * real provider class the factory would construct - so a reviewed engine always has its protected
 * read path, and a provider that gains one fails there until its review row is written here.
 *
 * Two things it deliberately does NOT say, because user-facing copy that compresses them
 * overclaims (docs/AGENT.md, the "Agent mode requires" paragraph that opens it):
 * - **Plan mode opens on every engine and runs no statement of the model's anywhere.** Since #414
 *   a plan run is grounded, and this list reaches only that grounding: see below.
 * - **The `operations` workflow opens without this list, in both modes**, because it composes no
 *   SQL: its `agent-operations` acquisition sets `requiresReadOnlyStatements: false`. In agent mode
 *   it opens on every engine whose `ENGINE_FACETS` row offers agent mode a curated reading.
 *
 * Both are grounded before their first turn, and on an engine whose catalog read is a composed
 * statement (its overlay's `catalogCapture`) that read is sent under `agent-read-only`, so it passes
 * this list like any other statement. On such an engine off the list the acquisition is refused
 * `PROFILE_ENGINE_NOT_REVIEWED` and plan mode and the operations workflow run ungrounded; it is not
 * routed to `agent-operations` instead, because a composed statement is a statement.
 *
 * Held in this module, which imports nothing but types, the generated engine catalog and the generated connection
 * flags on purpose: it is read by the unauthenticated login hero, and a provider module here would drag
 * `oracledb`/`mssql` toward that bundle. Frozen like the records beside it, so no code widens it at run time.
 */
export const AGENT_EXECUTION_ENGINES: readonly DatabaseType[] = Object.freeze([
  "postgres",
  "sqlite",
  "duckdb",
  "mssql",
  "mysql",
  "kubernetes",
  "mongodb",
  "clickhouse",
  "libsql",
  "influxdb3",
  "elasticsearch",
  "opensearch",
  "oracle",
  "db2",
  "cassandra",
  "couchbase",
  "druid",
  "libredb",
  "influxdb",
  "weaviate",
  "qdrant",
  "neo4j",
  "milvus",
  "redis",
  "etcd",
  "oxia",
  "rabbitmq",
  "kafka",
  "s3",
  "firestore",
  "snmp",
  "netconf",
  "modbus",
  "prometheus",
  "opcua",
  "mtconnect",
  "mqtt",
  "sparkplug",
  "trino",
]);

/**
 * The statement language agent mode sends each engine, or null where it sends the engine no statement: Studio's review
 * record of the claim an engine declaration requests at `agent.statementLanguage` (docs/providers/CONTRACT.md, clauses
 * M-52, M-53 and M-83). The declaration states each shipped engine's request as this table's row, and the table is
 * never a projection of declarations. Only Studio's grant reader, src/lib/db/claim-grants.ts, reads it as a value, and
 * every gate reads its grant, `GRANTED_AGENT_STATEMENT_LANGUAGE`, in its place
 * (tests/unit/db/claim-record-readers.test.ts).
 *
 * Literal-typed, so `AgentEngineType` and `AgentEngineFamily` in src/lib/agent/languages/pack.ts read each engine's
 * language by type, through a type-only import, which carries no value to any gate. Held here, beside
 * `AGENT_EXECUTION_ENGINES`, the review record of the agent statement path, so the grant reader in core reads it with
 * no import of the agent core.
 */
export const AGENT_STATEMENT_LANGUAGE = Object.freeze({
  postgres: "sql",
  bigquery: null,
  snowflake: null,
  spark: null,
  mysql: "sql",
  sqlite: "sql",
  libsql: "sql",
  duckdb: "sql",
  oracle: "sql",
  db2: "sql",
  mssql: "sql",
  clickhouse: "sql",
  druid: "sql",
  trino: "sql",
  cassandra: "sql",
  elasticsearch: "sql",
  opensearch: "sql",
  mongodb: "mongo",
  couchbase: "sql",
  redis: "rediscli",
  prometheus: "promql",
  kafka: "kafkaread",
  etcd: "etcdctl",
  neo4j: "cypher",
  milvus: "milvusrpc",
  qdrant: "qdrantapi",
  weaviate: "weaviateapi",
  influxdb: "influxql",
  influxdb3: "sql",
  oxia: "oxiacli",
  databend: null,
  s3: "s3api",
  kubernetes: "kubectl",
  mqtt: "mqttread",
  firestore: "fsquery",
  rabbitmq: "rabbitread",
  opcua: "opcuaread",
  mtconnect: "mtconnectread",
  modbus: "modbusread",
  netconf: "netconfrpc",
  snmp: "snmpget",
  sparkplug: "sparkplugread",
  libredb: "libredbkv",
} as const satisfies Record<DatabaseType, StatementLanguage>);

/**
 * The refusal of an agent-mode Start whose workflow sends statements, on a connection of an engine granted
 * `policy.readRootsRequired` that declares no read roots. Worded without naming an engine, since the runs route answers
 * it for every engine so granted.
 */
export const READ_ROOTS_REQUIRED_SENTENCE =
  "This connection declares no read roots: agent mode reads its engine only beneath read roots an operator declares on its seed entry (agentReadRoots). Nothing was sent.";

/**
 * Which shipped engines' connection form offers a URI mode (Spec A section 7): the answer
 * `DB_UI_CONFIG[type].showConnectionStringToggle` gives in `src/lib/db-ui-config.ts`. Kept here because the seed
 * layer must not load `db-ui-config.ts`: it value-imports the React icon components, the reason
 * `src/lib/db/credential-warnings.ts` exists. No seed module reads it yet; the environment-URL source of PR A2
 * will, to keep a pasted URI verbatim only where this answers true, as the form's paste keeps it.
 *
 * Each row is the engine's `connection.connectionString.dialogOffersUri`, authored in its declaration and projected
 * into `./engine-catalog/connection-flags.generated.ts` (docs/providers/CONTRACT.md, clause M-71): an exhaustive
 * frozen Record over the union, so a new type-id cannot join without someone answering, held equal to the form's own
 * answer for every type by `tests/unit/db/connection-string-records.test.ts`.
 */
export const CONNECTION_FORM_URI_MODE: Readonly<Record<DatabaseType, boolean>> = BUNDLED_DIALOG_OFFERS_URI;

/**
 * The types whose provider reads `connectionString` (Spec A section 7):
 * getCapabilities().supportsConnectionString, except sqlite (declares false, opens the field as the file path)
 * and mssql (declares true for the form's paste, builds from the fields only). Static for the reason
 * `READ_ONLY_ENFORCED` is: the seed schema decides at load, before any provider exists, and refuses a
 * `connectionString` where this answers false, naming the connection and the type, because a provider that
 * ignores the string would list a connection that opens somewhere else than the file says.
 *
 * Each row is the engine's `connection.connectionString.accepted`, authored in its declaration and projected into
 * `./engine-catalog/connection-flags.generated.ts` (docs/providers/CONTRACT.md, clause M-71): an exhaustive frozen
 * Record over the union, held equal to every other shipped provider's declaration by the census in
 * `tests/unit/db/connection-string-records.test.ts`, and pinned there for the two exceptions by behavioural tests:
 * sqlite opens the file a `file:` string names (docs/providers/sqlite.md), and mssql builds a string-only config
 * against localhost (docs/providers/mssql.md).
 */
export const CONNECTION_STRING_ACCEPTED: Readonly<Record<DatabaseType, boolean>> = BUNDLED_CONNECTION_STRING_ACCEPTED;

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
      "In the object tree, the Functions and Procedures folders show Materialize's own sentence, column \"p.prokind\" does not exist, and do not open; every other folder in the tree counts and lists. Materialize's pg_proc has no prokind column, so it cannot say which routine is a function and which a procedure. It reports that as SQLSTATE XX000 rather than PostgreSQL's 42703, and while the object browser keyed its fallback on 42703 every folder in every schema showed that sentence and nothing could be opened. The fallback now keys on the column the refusal names, under any SQLSTATE, measured on Materialize v26.44.1 on 2026-10-04. Object search, the object inventory and the agent's inventory grounding still list the routine kinds and fail there (D226 in the backlog). A source created from a load generator is listed under Tables, because Materialize's pg_class reports it as an ordinary table.",
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
