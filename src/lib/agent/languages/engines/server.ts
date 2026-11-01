/**
 * The engines' server dialects (#1821): the one way the core reaches an engine's dialect-bound members.
 *
 * Server tier. The registry is total over `AgentEngineType`, so an engine that speaks a statement language does not
 * compile until it registers an overlay here, and it keeps each engine module's overlay whole: its `dialect`, and any
 * member `ENGINE_OVERRIDABLE_SERVER_MEMBERS` names, which `runServerPack` lays over the family pack. The type allows no
 * other member, since every other consumer reads the family pack and an override of it would reach no reader.
 *
 * `engineServerDialect` is total over any type id: an engine with no statement language, an engine whose family has
 * no dialect, and a name that is no key at all (`toString`) each answer `NO_SERVER_DIALECT`, every member
 * `"unsupported"`. That is what grounding and statistics need, since they run on every engine in plan mode.
 */
import type { DatabaseType } from "@/lib/types";
import { INFLUXDB_SERVER_OVERLAY } from "../influxql/engines/influxdb";
import { KUBERNETES_SERVER_OVERLAY } from "../kubectl/engines/kubernetes";
import { LIBREDB_SERVER_OVERLAY } from "../libredbkv/engines/libredb";
import { MONGODB_SERVER_OVERLAY } from "../mongo/engines/mongodb";
import { WEAVIATE_SERVER_OVERLAY } from "../weaviateapi/engines/weaviate";
import { QDRANT_SERVER_OVERLAY } from "../qdrantapi/engines/qdrant";
import { NEO4J_SERVER_OVERLAY } from "../cypher/engines/neo4j";
import { MILVUS_SERVER_OVERLAY } from "../milvusrpc/engines/milvus";
import { REDIS_SERVER_OVERLAY } from "../rediscli/engines/redis";
import { ETCD_SERVER_OVERLAY } from "../etcdctl/engines/etcd";
import { OXIA_SERVER_OVERLAY } from "../oxiacli/engines/oxia";
import { RABBITMQ_SERVER_OVERLAY } from "../rabbitread/engines/rabbitmq";
import { KAFKA_SERVER_OVERLAY } from "../kafkaread/engines/kafka";
import { S3_SERVER_OVERLAY } from "../s3api/engines/s3";
import { FIRESTORE_SERVER_OVERLAY } from "../fsquery/engines/firestore";
import { SNMP_SERVER_OVERLAY } from "../snmpget/engines/snmp";
import { NETCONF_SERVER_OVERLAY } from "../netconfrpc/engines/netconf";
import { MODBUS_SERVER_OVERLAY } from "../modbusread/engines/modbus";
import { PROMETHEUS_SERVER_OVERLAY } from "../promql/engines/prometheus";
import { OPCUA_SERVER_OVERLAY } from "../opcuaread/engines/opcua";
import { MTCONNECT_SERVER_OVERLAY } from "../mtconnectread/engines/mtconnect";
import { MQTT_SERVER_OVERLAY } from "../mqttread/engines/mqtt";
import { SPARKPLUG_SERVER_OVERLAY } from "../sparkplugread/engines/sparkplug";
import type { AgentStatementLanguageId } from "../../agent-manifest";
import { statementFamilyOf } from "../client";
import { defineOverlay } from "../overlay";
import type {
  AgentEngineOverridableServer,
  AgentEngineServerDialect,
  AgentEngineServerOverlays,
  AgentEngineType,
  AgentLanguageServerPack,
  FacetOverrides,
} from "../pack";
import { languageServerPack } from "../server";
import { CASSANDRA_SERVER_OVERLAY } from "../sql/engines/cassandra";
import { CLICKHOUSE_SERVER_OVERLAY } from "../sql/engines/clickhouse";
import { COUCHBASE_SERVER_OVERLAY } from "../sql/engines/couchbase";
import { DB2_SERVER_OVERLAY } from "../sql/engines/db2";
import { DRUID_SERVER_OVERLAY } from "../sql/engines/druid";
import { DUCKDB_SERVER_OVERLAY } from "../sql/engines/duckdb";
import { ELASTICSEARCH_SERVER_OVERLAY } from "../sql/engines/elasticsearch";
import { INFLUXDB3_SERVER_OVERLAY } from "../sql/engines/influxdb3";
import { LIBSQL_SERVER_OVERLAY } from "../sql/engines/libsql";
import { MSSQL_SERVER_OVERLAY } from "../sql/engines/mssql";
import { MYSQL_SERVER_OVERLAY } from "../sql/engines/mysql";
import { OPENSEARCH_SERVER_OVERLAY } from "../sql/engines/opensearch";
import { ORACLE_SERVER_OVERLAY } from "../sql/engines/oracle";
import { POSTGRES_SERVER_OVERLAY } from "../sql/engines/postgres";
import { SQLITE_SERVER_OVERLAY } from "../sql/engines/sqlite";
import { engineFamily } from "./client";

const SERVER_OVERLAYS: AgentEngineServerOverlays = Object.freeze({
  postgres: Object.freeze({ ...POSTGRES_SERVER_OVERLAY }),
  sqlite: Object.freeze({ ...SQLITE_SERVER_OVERLAY }),
  duckdb: Object.freeze({ ...DUCKDB_SERVER_OVERLAY }),
  mssql: Object.freeze({ ...MSSQL_SERVER_OVERLAY }),
  mysql: Object.freeze({ ...MYSQL_SERVER_OVERLAY }),
  clickhouse: Object.freeze({ ...CLICKHOUSE_SERVER_OVERLAY }),
  libsql: Object.freeze({ ...LIBSQL_SERVER_OVERLAY }),
  influxdb3: Object.freeze({ ...INFLUXDB3_SERVER_OVERLAY }),
  elasticsearch: Object.freeze({ ...ELASTICSEARCH_SERVER_OVERLAY }),
  opensearch: Object.freeze({ ...OPENSEARCH_SERVER_OVERLAY }),
  oracle: Object.freeze({ ...ORACLE_SERVER_OVERLAY }),
  db2: Object.freeze({ ...DB2_SERVER_OVERLAY }),
  cassandra: Object.freeze({ ...CASSANDRA_SERVER_OVERLAY }),
  couchbase: Object.freeze({ ...COUCHBASE_SERVER_OVERLAY }),
  druid: Object.freeze({ ...DRUID_SERVER_OVERLAY }),
  mongodb: Object.freeze({ ...MONGODB_SERVER_OVERLAY }),
  kubernetes: Object.freeze({ ...KUBERNETES_SERVER_OVERLAY }),
  libredb: Object.freeze({ ...LIBREDB_SERVER_OVERLAY }),
  influxdb: Object.freeze({ ...INFLUXDB_SERVER_OVERLAY }),
  weaviate: Object.freeze({ ...WEAVIATE_SERVER_OVERLAY }),
  qdrant: Object.freeze({ ...QDRANT_SERVER_OVERLAY }),
  neo4j: Object.freeze({ ...NEO4J_SERVER_OVERLAY }),
  milvus: Object.freeze({ ...MILVUS_SERVER_OVERLAY }),
  redis: Object.freeze({ ...REDIS_SERVER_OVERLAY }),
  etcd: Object.freeze({ ...ETCD_SERVER_OVERLAY }),
  oxia: Object.freeze({ ...OXIA_SERVER_OVERLAY }),
  rabbitmq: Object.freeze({ ...RABBITMQ_SERVER_OVERLAY }),
  kafka: Object.freeze({ ...KAFKA_SERVER_OVERLAY }),
  s3: Object.freeze({ ...S3_SERVER_OVERLAY }),
  firestore: Object.freeze({ ...FIRESTORE_SERVER_OVERLAY }),
  snmp: Object.freeze({ ...SNMP_SERVER_OVERLAY }),
  netconf: Object.freeze({ ...NETCONF_SERVER_OVERLAY }),
  modbus: Object.freeze({ ...MODBUS_SERVER_OVERLAY }),
  prometheus: Object.freeze({ ...PROMETHEUS_SERVER_OVERLAY }),
  opcua: Object.freeze({ ...OPCUA_SERVER_OVERLAY }),
  mtconnect: Object.freeze({ ...MTCONNECT_SERVER_OVERLAY }),
  mqtt: Object.freeze({ ...MQTT_SERVER_OVERLAY }),
  sparkplug: Object.freeze({ ...SPARKPLUG_SERVER_OVERLAY }),
} satisfies AgentEngineServerOverlays);

/** What an engine with no dialect answers: every member unsupported. */
const NO_SERVER_DIALECT: AgentEngineServerDialect = Object.freeze({
  catalogRead: "unsupported",
  planEstimate: "unsupported",
  profileComposition: "unsupported",
  statistics: "unsupported",
  catalogCapture: "unsupported",
});

/** One engine's server overlay as the core reads it: any overridable member, and the dialect if its family has one. */
type EngineServerOverlay = FacetOverrides<AgentEngineOverridableServer> & {
  readonly dialect?: AgentEngineServerDialect;
};

/** What an engine with no overlay holds: nothing, so its server facet is its family's own. */
const NO_SERVER_OVERLAY: EngineServerOverlay = Object.freeze({});

/**
 * The server overlay of `type` as the registry holds it, whole, or an empty one for a type with no overlay. Read by
 * `agentEnginePack` in `engines/index.ts` and by `runServerPack`.
 */
export function engineServerOverlay(type: DatabaseType): EngineServerOverlay {
  return Object.hasOwn(SERVER_OVERLAYS, type) ? SERVER_OVERLAYS[type as AgentEngineType] : NO_SERVER_OVERLAY;
}

/** The server dialect of `type`: its overlay's own frozen `dialect`, or `NO_SERVER_DIALECT`. */
export function engineServerDialect(type: DatabaseType): AgentEngineServerDialect {
  return engineServerOverlay(type).dialect ?? NO_SERVER_DIALECT;
}

/** Every registered engine's server dialect, in registry order: what a rule derived across engines reads. */
export function everyEngineServerDialect(): readonly AgentEngineServerDialect[] {
  return Object.values(SERVER_OVERLAYS).flatMap((overlay: EngineServerOverlay) =>
    overlay.dialect === undefined ? [] : [overlay.dialect],
  );
}

/** The server facet of one engine, as `runServerPack` answers it. */
type EngineServerFacet = Readonly<AgentLanguageServerPack & { readonly dialect?: AgentEngineServerDialect }>;

/**
 * Each engine's server facet, derived once, on its first read. A member an overlay derives from its base (`(base) =>
 * value`) is a new object every time its function runs, so a facet derived on every read would differ on every run,
 * and from the one `agentEnginePack` holds.
 */
const ENGINE_SERVER_FACETS = new Map<DatabaseType, EngineServerFacet>();

/**
 * The server facet one run reads: the family its persisted `language` names (`statementFamilyOf`), with the overlay of
 * `type` applied only when `type` speaks that family. An engine with no family, or a connection re-typed after the
 * run opened, reads the family pack itself. A language this server does not know is the named error of
 * `languageServerPack`. `agentEnginePack` reads its server facet here too, so both hand out the same object.
 */
export function runServerPack(language: AgentStatementLanguageId | undefined, type: DatabaseType): EngineServerFacet {
  const family = statementFamilyOf(language);
  const base = languageServerPack(family);
  if (engineFamily(type) !== family) return base;
  let facet = ENGINE_SERVER_FACETS.get(type);
  if (facet === undefined) {
    facet = defineOverlay(base, engineServerOverlay(type));
    ENGINE_SERVER_FACETS.set(type, facet);
  }
  return facet;
}
