/**
 * Whether the info string on a markdown fence says the block holds a query.
 *
 * Extracted from `src/components/rich-text.tsx` on 2026-08-15, when a SECOND reader of
 * the same fences appeared: `src/lib/agent/plan-statement.ts` reads a plan run's
 * deliverable out of its closing prose on the server, and the rail renders the same
 * text in the browser. While the predicate lived in the browser layer only, the two
 * disagreed about which block is a statement — the reader took the FIRST fenced block
 * whatever its info string, so a run that opened with a ```text illustration recorded
 * the illustration as its deliverable while the rail offered the editor the SQL block
 * below it. One shared answer is what makes the agreement those two modules claim an
 * enforced fact rather than a comment.
 *
 * The fence PATTERN itself stays duplicated in both callers, and deliberately: it is
 * three characters of regex whose reason is recorded in both places, and the server
 * layer does not import the browser layer to get it.
 */

import type { DatabaseType } from "@/lib/types";

/**
 * Every engine this product speaks, as a fence tag.
 *
 * A TOTAL RECORD over `DatabaseType` rather than a list, and that is the point: the
 * first version of this was a hand-written set whose comment claimed every engine was
 * in it, and `libredb` was not (#389 review). A comment cannot keep that promise and a
 * record can — an engine added to the union stops this file compiling until someone
 * decides what its blocks are called.
 *
 * The keys are the canonical type-ids because that is what the union holds; the aliases
 * models actually write live below.
 */
const ENGINE_FENCE_TAGS: Readonly<Record<DatabaseType, true>> = Object.freeze({
  postgres: true,
  mysql: true,
  sqlite: true,
  // A block tagged `libsql` holds SQLite's own dialect: same tokenizer, same
  // statements, measured on sqld 0.24.33 (SQLite 3.47.0). `turso` is registered as
  // an alias below because that is the product name a model is likelier to write.
  libsql: true,
  // A ```duckdb block holds a statement this editor runs against the open file. No
  // alias is registered below: `duck` and `ddb` are both written for other things
  // (`ddb` is DynamoDB in most of the material a model has read), and an alias that
  // names the WRONG engine is worse here than a missing one, because `fenceTagEngine`
  // is what decides whether a plan's deliverable was written for this connection.
  duckdb: true,
  mongodb: true,
  redis: true,
  oracle: true,
  // A ```db2 block holds a statement this editor runs against a Db2 LUW connection (#786). No
  // alias is registered below: `sqlpl` names Db2's procedural language rather than the product,
  // and an alias that names the WRONG engine is worse here than a missing one.
  db2: true,
  mssql: true,
  libredb: true,
  couchbase: true,
  clickhouse: true,
  druid: true,
  // Both products' query language IS SQL over their HTTP endpoint (measured on
  // Elasticsearch 9.1.4 and OpenSearch 3.8.0), so a block tagged with either
  // type-id holds a statement the editor can run. No alias is registered for them
  // below: `es` names Spanish as often as Elasticsearch in a fence, and an alias
  // that names the WRONG engine is worse here than a missing one - `fenceTagEngine`
  // is what decides whether a plan's deliverable was written for this connection.
  elasticsearch: true,
  opensearch: true,
  // A ```trino block holds a statement this editor can run: the fenced text goes
  // straight to `POST /v1/statement`. No alias is registered below - `presto` is the
  // tempting one and it is exactly the wrong one, because PrestoDB is a separate
  // engine this product does not speak, and `fenceTagEngine` is what decides whether
  // a plan's deliverable was written for THIS connection.
  trino: true,
  // A ```cassandra block holds a CQL statement the editor can run. The `cql` alias
  // below is registered as a QUERY tag but NOT as an engine, for the reason `sql`
  // is not: CQL is a language, and ScyllaDB speaks it too, so reading `cql` as
  // "this was written for Cassandra" would put a claim in the model's mouth.
  cassandra: true,
  // A ```prometheus block holds a PromQL expression the editor sends unchanged to
  // `/api/v1/query` (#1085), and it is the tag the planning contract asks a model for. The
  // `promql` alias below spells the language, and it still names this engine: see its entry.
  prometheus: true,
  // A ```kafka block holds a JSON read request the editor sends to the provider as it is
  // (#1088). The `kafkaread` alias below names the agent's language, and it still names this
  // engine: see its entry. `json` is the tempting alias and it is the wrong one, because a MongoDB
  // document is JSON too, and `fenceTagEngine` is what decides whether a plan's deliverable was
  // written for THIS connection.
  kafka: true,
  // An ```etcd block holds one etcdctl command the editor runs as it is (#1089). `sh`, `bash` and
  // `shell` name no engine, which is the reason `sql` maps to no engine in `ALIAS_ENGINES`; the
  // `etcdctl` alias below names the agent's language, and it still names this engine: see its entry.
  etcd: true,
  // A ```neo4j block holds one read-only Cypher statement the editor runs as it is (Neo4j spec 6.4). The
  // `cypher` alias below spells the language, and it still names this engine: see its entry.
  neo4j: true,
  // A ```milvus block holds one Milvus console request the editor runs as it is (vector-family spec 5.7). No alias
  // is registered below: `json` is a MongoDB document as often, `http` and `rest` name no engine, and
  // `fenceTagEngine` is what decides whether a plan's deliverable was written for THIS connection.
  milvus: true,
  // A ```qdrant block holds one Qdrant console request the editor runs as it is (vector-family spec 6.7). No alias
  // is registered below: `json` is a MongoDB document as often, `http` and `rest` name no engine, and
  // `fenceTagEngine` is what decides whether a plan's deliverable was written for THIS connection.
  qdrant: true,
  // A ```weaviate block holds one Weaviate console request the editor runs as it is (#1566 spec 3.4). No alias is
  // registered: `graphql` would read as a request this console refuses, and `json` names no engine.
  weaviate: true,
  // An ```influxdb block holds one InfluxQL statement the editor runs as it is. The `influxql` alias below
  // spells the language, and it still names this engine: see its entry. No `flux` tag is registered anywhere:
  // no type-id runs Flux, and an alias would make a Flux block look runnable on `influxdb`.
  influxdb: true,
  // An ```influxdb3 block holds one DataFusion SQL statement. No alias is registered below: `sql` names no
  // engine, and `influxql` and `flux` are not this type-id's language.
  influxdb3: true,
  // A ```oxia block holds one `oxia client` read command the editor runs as it is (O14). The `oxiacli` alias below
  // names the agent's language, and it still names this engine: see its entry.
  oxia: true,
  // A ```databend block holds one statement in Databend's SQL, sent as it is to `POST /v1/query`. No alias: `sql`
  // names no engine, and `mysql` names the MySQL-wire driver Databend no longer connects through.
  databend: true,
  bigquery: true,
  // A ```snowflake block holds one statement in Snowflake's SQL, sent as it is through the SQL API. No alias:
  // `snowsql` names Snowflake's command-line client, not a dialect.
  snowflake: true,
  // A ```spark block holds one statement in Spark SQL, sent as it is over Spark Connect. No alias.
  spark: true,
  // A ```s3 block holds one AWS CLI subset read command the editor runs as it is. No alias: `aws` names every AWS
  // service, and `sh`, `bash` and `shell` name no engine.
  s3: true,
  // A ```kubernetes block holds one statement of the kubectl subset the editor runs as it is. The `kubectl` alias below
  // spells the command, and it still names this engine. No `yaml` or `sh` tag is registered: neither names an engine.
  kubernetes: true,
  mqtt: true,
  // A ```firestore block holds one statement of the console's read-only Admin SDK subset. No alias: `firebase` names a
  // platform of many products, and `js` and `javascript` name a language, not an engine.
  firestore: true,
  // A ```rabbitmq block holds one JSON read request the editor runs as it is. The `rabbitread` alias below names the
  // agent's language, and it still names this engine: see its entry.
  rabbitmq: true,
  // An ```opcua block holds one JSON read request, which the console runs as it is.
  opcua: true,
  // An ```mtconnect block holds one request line in the agent's own URL grammar, which the console runs as it is.
  mtconnect: true,
  // A ```modbus block holds one JSON read request, which the console runs as it is.
  modbus: true,
  // A ```netconf block holds one JSON read request naming a datastore, a path and a limit, which
  // the console runs as it is. The device's own language is XML and nothing here writes any.
  netconf: true,
  snmp: true,
  // An ```sparkplug block holds one read request in the JSON shape the console runs as it is.
  sparkplug: true,
});

/**
 * The other names the same query languages go by, which is what a model actually types.
 *
 * Separate from the record above because these answer to nothing: no union widens when
 * a model invents `pgsql`, so completeness here is a judgement rather than a guarantee.
 * A tag missing from either costs the user a button and never a wrong one — the copy
 * control is offered on every block regardless.
 */
export const QUERY_FENCE_ALIASES: ReadonlySet<string> = new Set([
  "sql",
  "postgresql",
  "pgsql",
  "psql",
  "plpgsql",
  "mariadb",
  "sqlite3",
  "turso",
  "plsql",
  "tsql",
  "sqlserver",
  "mongo",
  "n1ql",
  "cql",
  "promql",
  "cypher",
  "influxql",
  "kubectl",
  "libredbkv",
  "weaviateapi",
  "qdrantapi",
  "milvusrpc",
  "rediscli",
  "etcdctl",
  "oxiacli",
  "rabbitread",
  "kafkaread",
  "s3api",
  "fsquery",
  "snmpget",
  "netconfrpc",
  "modbusread",
  "opcuaread",
  "mtconnectread",
  "mqttread",
  "sparkplugread",
]);

/**
 * The aliases that name ONE engine, and which one.
 *
 * An entry names the type-id a block's text runs on, which is not always the product the
 * tag spells: `mariadb` names `mysql`, the type-id MariaDB connects through.
 *
 * `sql` is deliberately absent: it names no engine, and mapping it to the connection's
 * would turn a generic tag into a claim the model never made.
 *
 * `fenceTagEngine` reads only this record, so an alias that names an engine goes into both
 * registries; `tests/unit/lib/sql/fence-tags.test.ts` holds this record's keys equal to the
 * alias set less `sql`, and less `cql`, which is absent as a known defect rather than by design
 * (docs/BACKLOG.md B86).
 */
export const ALIAS_ENGINES: Readonly<Record<string, DatabaseType>> = Object.freeze({
  postgresql: "postgres",
  pgsql: "postgres",
  psql: "postgres",
  plpgsql: "postgres",
  mariadb: "mysql",
  sqlite3: "sqlite",
  turso: "libsql",
  plsql: "oracle",
  tsql: "mssql",
  sqlserver: "mssql",
  mongo: "mongodb",
  n1ql: "couchbase",
  // A language rather than a product, and still ONE type-id: every PromQL server this product
  // reaches, VictoriaMetrics included, connects through `prometheus` (#1085). Left out of this
  // record, a ```promql block contradicted no connection and was recorded as a PostgreSQL
  // run's statement. A second type-id that runs PromQL is the moment to revisit this entry.
  // `cql` is absent on a reason the same rule does not leave standing, since ScyllaDB connects
  // through `cassandra` too; docs/BACKLOG.md B86 records it.
  promql: "prometheus",
  // The `promql` rule again: Cypher is a language, and `neo4j` is the only type-id that runs it. Left
  // out of this record, a ```cypher block contradicted no connection and was recorded as a PostgreSQL
  // run's statement. A second graph type-id that runs Cypher is the moment to revisit this entry.
  cypher: "neo4j",
  // The `promql` rule again: InfluxQL is a language, and `influxdb` is the only type-id that runs it
  // (`influxdb3` runs SQL). A second InfluxQL type-id is the moment to revisit this entry.
  influxql: "influxdb",
  // The command the Kubernetes console speaks, and `kubernetes` is the only type-id that runs it.
  kubectl: "kubernetes",
  // The agent's name for the LibreDB command language, and `libredb` is the only type-id that runs it.
  libredbkv: "libredb",
  // The agent's name for the Weaviate request language, and `weaviate` is the only type-id that runs it.
  weaviateapi: "weaviate",
  // The agent's name for the Qdrant request language, and `qdrant` is the only type-id that runs it.
  qdrantapi: "qdrant",
  // The agent's name for the Milvus request language, and `milvus` is the only type-id that runs it.
  milvusrpc: "milvus",
  // The agent's name for the Redis command language, and `redis` is the only type-id that runs it.
  rediscli: "redis",
  // The agent's name for the etcdctl command language, and `etcd` is the only type-id that runs it.
  etcdctl: "etcd",
  // The agent's name for the Oxia command language, and `oxia` is the only type-id that runs it.
  oxiacli: "oxia",
  // The agent's name for the RabbitMQ read request language, and `rabbitmq` is the only type-id that runs it.
  rabbitread: "rabbitmq",
  // The agent's name for the Kafka metadata read request language, and `kafka` is the only type-id that runs it.
  kafkaread: "kafka",
  // The agent's name for the S3 metadata read command language, and `s3` is the only type-id that runs it.
  s3api: "s3",
  // The agent's name for the Firestore metadata read statement language, and `firestore` is the only type-id that runs it.
  fsquery: "firestore",
  // The agent's name for the SNMP read command language, and `snmp` is the only type-id that runs it.
  snmpget: "snmp",
  // The agent's name for the NETCONF read request language, and `netconf` is the only type-id that runs it.
  netconfrpc: "netconf",
  // The agent's name for the Modbus read request language, and `modbus` is the only type-id that runs it.
  modbusread: "modbus",
  // The agent's name for the OPC UA read request language, and `opcua` is the only type-id that runs it.
  opcuaread: "opcua",
  // The agent's name for the MTConnect read request language, and `mtconnect` is the only type-id that runs it.
  mtconnectread: "mtconnect",
  // The agent's name for the MQTT read request language, and `mqtt` is the only type-id that runs it.
  mqttread: "mqtt",
  // The agent's name for the Sparkplug read request language, and `sparkplug` is the only type-id that runs it.
  sparkplugread: "sparkplug",
});

/**
 * The engine a tag NAMES, or `null` when it names none (#396 review).
 *
 * The distinction this draws is the one `isQueryFenceTag` cannot: that predicate asks
 * whether a block holds a query at all, and answers yes for `mysql` on a PostgreSQL
 * connection. A reader that then records the block under the connection's own dialect
 * has relabelled the model's MySQL as PostgreSQL — it says the run drafted something
 * for this database that the run explicitly wrote for another one, which is the
 * false-self-description defect this repository keeps finding.
 *
 * `null` for an untagged fence and for `sql` is not a gap: neither says which engine,
 * so neither can contradict the connection. Only an explicit engine can.
 */
export const fenceTagEngine = (tag: string | undefined): DatabaseType | null => {
  if (tag === undefined) return null;
  if (Object.hasOwn(ENGINE_FENCE_TAGS, tag)) return tag as DatabaseType;
  return Object.hasOwn(ALIAS_ENGINES, tag) ? ALIAS_ENGINES[tag] : null;
};

/**
 * Whether a fence holds something the editor should be offered.
 *
 * Fail-closed on an unrecognised tag, the same posture the auto-execute gate takes about
 * a dialect it has no rule for: the tag is the model saying what the block is, and
 * offering to put a shell command into a SQL editor would be this surface claiming
 * something the model contradicted.
 *
 * An untagged fence counts. Models write one for SQL constantly, and in a document
 * whose entire subject is a database the bare fence is a query far more often than it
 * is anything else — while the cost of being wrong is one click that puts text in an
 * editor, which the user can see and undo.
 *
 * The tag is expected lower-cased; both callers lower-case it as they read the fence.
 */
export const isQueryFenceTag = (tag: string | undefined): boolean =>
  tag === undefined || Object.hasOwn(ENGINE_FENCE_TAGS, tag) || QUERY_FENCE_ALIASES.has(tag);
