import { CYPHER_GENERATORS } from "@/lib/db/graph/cypher/generators";
import { MONGODB_JSON_GENERATORS } from "@/lib/db/providers/document/mongodb/generators";
import { COUCHBASE_SQL_GENERATORS } from "@/lib/db/providers/document/couchbase/generators";
import { FIRESTORE_GENERATORS } from "@/lib/db/providers/document/firestore/console/generators";
import { LIBREDB_GENERATORS } from "@/lib/db/providers/embedded/libredb-generators";
import { MODBUS_GENERATORS } from "@/lib/db/providers/industrial/modbus/generators";
import { MTCONNECT_GENERATORS } from "@/lib/db/providers/industrial/mtconnect/generators";
import { OPCUA_GENERATORS } from "@/lib/db/providers/industrial/opcua/generators";
import { SPARKPLUG_GENERATORS } from "@/lib/db/providers/industrial/sparkplug/generators";
import { ETCD_GENERATORS } from "@/lib/db/providers/keyvalue/etcd/generators";
import { MQTT_GENERATORS } from "@/lib/db/providers/keyvalue/mqtt/generators";
import { OXIA_GENERATORS } from "@/lib/db/providers/keyvalue/oxia/generators";
import { REDIS_GENERATORS } from "@/lib/db/providers/keyvalue/redis-generators";
import { NETCONF_GENERATORS } from "@/lib/db/providers/network/netconf/generators";
import { SNMP_GENERATORS } from "@/lib/db/providers/network/snmp/generators";
import { S3_GENERATORS } from "@/lib/db/providers/objectstore/s3/console/generators";
import { KUBECTL_GENERATORS } from "@/lib/db/providers/platform/kubernetes/generators";
import { DRUID_SQL_GENERATORS } from "@/lib/db/providers/sql/druid/generators";
import { MSSQL_SQL_GENERATORS } from "@/lib/db/providers/sql/mssql-generators";
import { MYSQL_SQL_GENERATORS } from "@/lib/db/providers/sql/mysql-generators";
import { ORACLE_SQL_GENERATORS } from "@/lib/db/providers/sql/oracle-generators";
import { KAFKA_GENERATORS } from "@/lib/db/providers/stream/kafka/generators";
import { RABBITMQ_GENERATORS } from "@/lib/db/providers/stream/rabbitmq/generators";
import { INFLUXQL_GENERATORS } from "@/lib/db/providers/timeseries/influxdb/influxql-generators";
import { PROMQL_GENERATORS } from "@/lib/db/providers/timeseries/prometheus/generators";
import { MILVUS_GENERATORS } from "@/lib/db/providers/vector/milvus/generators";
import { QDRANT_GENERATORS } from "@/lib/db/providers/vector/qdrant/generators";
import { WEAVIATE_GENERATORS } from "@/lib/db/providers/vector/weaviate/generators";
import type { QueryDialect } from "@/lib/db/query-dialects";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { DialectGenerators, LanguageGenerators, SqlPortGenerators } from "./types";

/**
 * The query generators' registry: every text one engine writes for a tree click, Generate Query, Generate Count Query
 * or a row action is a row declared beside its provider, and `src/lib/query-generators.ts` reads it here, by what the
 * declaration says, and names no engine itself.
 *
 * Pure and browser-safe, like every row it collects: the tab manager, the row menus and the server routes all read it.
 */

/**
 * Every query dialect's generators, read BEFORE the JSON language's row: each dialect declares `queryLanguage: "json"`
 * too, and without its record a tree click auto-executes a MongoDB `find` its provider refuses (#427, #1088, #1089). A
 * `Record` over `QueryDialect`, so a dialect added to the union does not compile until it has its generators.
 */
export const DIALECT_GENERATORS: Readonly<Record<QueryDialect, DialectGenerators>> = Object.freeze({
  libredb: LIBREDB_GENERATORS,
  redis: REDIS_GENERATORS,
  kafka: KAFKA_GENERATORS,
  etcd: ETCD_GENERATORS,
  milvus: MILVUS_GENERATORS,
  qdrant: QDRANT_GENERATORS,
  weaviate: WEAVIATE_GENERATORS,
  oxia: OXIA_GENERATORS,
  mqtt: MQTT_GENERATORS,
  firestore: FIRESTORE_GENERATORS,
  rabbitmq: RABBITMQ_GENERATORS,
  s3: S3_GENERATORS,
  kubectl: KUBECTL_GENERATORS,
  opcua: OPCUA_GENERATORS,
  mtconnect: MTCONNECT_GENERATORS,
  modbus: MODBUS_GENERATORS,
  netconf: NETCONF_GENERATORS,
  snmp: SNMP_GENERATORS,
  sparkplug: SPARKPLUG_GENERATORS,
} satisfies Record<QueryDialect, DialectGenerators>);

/** The query languages an engine writes its own text in, every one but SQL. */
type EngineQueryLanguage = Exclude<ProviderCapabilities["queryLanguage"], "sql">;

/**
 * Every such language's generators, read after a declared dialect's and before any SQL form. A `Record` over those
 * languages, so a language added to the union does not compile until it has its generators. The `json` row's quoting
 * is read for every JSON-language declaration, a dialect's included; its documents only where no dialect row answers.
 */
export const LANGUAGE_GENERATORS: Readonly<Record<EngineQueryLanguage, LanguageGenerators>> = Object.freeze({
  promql: PROMQL_GENERATORS,
  cypher: CYPHER_GENERATORS,
  influxql: INFLUXQL_GENERATORS,
  json: MONGODB_JSON_GENERATORS,
} satisfies Record<EngineQueryLanguage, LanguageGenerators>);

/**
 * The SQL engines' own forms, keyed by the default port each declares, the signal the generators have always read
 * them by. A port two rows both claim fails at load.
 */
export const SQL_PORT_GENERATORS: ReadonlyMap<number, SqlPortGenerators> = (() => {
  const rows = new Map<number, SqlPortGenerators>();
  for (const row of [
    COUCHBASE_SQL_GENERATORS,
    DRUID_SQL_GENERATORS,
    ORACLE_SQL_GENERATORS,
    MSSQL_SQL_GENERATORS,
    MYSQL_SQL_GENERATORS,
  ]) {
    if (rows.has(row.port)) throw new Error(`SQL_PORT_GENERATORS: port ${row.port} is registered twice`);
    rows.set(row.port, row);
  }
  return rows;
})();

/** The generators of the language a declaration names, looked up as an own key; undefined for SQL. */
export function languageGenerators(capabilities: ProviderCapabilities): LanguageGenerators | undefined {
  const language: string = capabilities.queryLanguage;
  return Object.hasOwn(LANGUAGE_GENERATORS, language)
    ? LANGUAGE_GENERATORS[language as EngineQueryLanguage]
    : undefined;
}

/** The SQL forms of the engine whose default port a declaration names, or undefined for every other port. */
export function sqlPortGenerators(capabilities: ProviderCapabilities): SqlPortGenerators | undefined {
  return capabilities.defaultPort === null ? undefined : SQL_PORT_GENERATORS.get(capabilities.defaultPort);
}
