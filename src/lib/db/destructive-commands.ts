import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import { FIRESTORE_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/document/firestore/destructive";
import { MONGODB_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/document/mongodb/destructive";
import { NEO4J_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/graph/neo4j/destructive";
import { MODBUS_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/industrial/modbus/destructive";
import { MTCONNECT_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/industrial/mtconnect/destructive";
import { OPCUA_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/industrial/opcua/destructive";
import { SPARKPLUG_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/industrial/sparkplug/destructive";
import { ETCD_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/keyvalue/etcd/destructive";
import { MQTT_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/keyvalue/mqtt/destructive";
import { OXIA_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/keyvalue/oxia/destructive";
import { REDIS_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/keyvalue/redis-destructive";
import { NETCONF_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/network/netconf/destructive";
import { SNMP_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/network/snmp/destructive";
import { S3_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/objectstore/s3/destructive";
import { KUBERNETES_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/platform/kubernetes/destructive";
import { KAFKA_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/stream/kafka/destructive";
import { RABBITMQ_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/stream/rabbitmq/destructive";
import { INFLUXDB_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/timeseries/influxdb/influxdb-destructive";
import { PROMETHEUS_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/timeseries/prometheus/destructive";
import { MILVUS_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/vector/milvus/destructive";
import { QDRANT_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/vector/qdrant/destructive";
import { WEAVIATE_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/vector/weaviate/destructive";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";

/**
 * The confirmation gate's vocabulary for the engines whose query text is NOT SQL.
 *
 * Each engine's row is declared beside its provider, in its `destructive.ts` module, with the shape in
 * `./destructive-vocabulary.ts`; this module only collects the rows and answers the gate from them, so it names no
 * engine's commands, operations or readers of its own.
 *
 * `isDangerousQuery` reads a statement's SQL keywords, and for `mongodb` and `redis`
 * it had nothing to read: it returned false outright, so a `FLUSHALL`, a `DEL` and a
 * `deleteMany` ran with no confirmation at all while a `DELETE FROM` on any SQL
 * engine asked (S8). The vocabulary lives here rather than in the dialog for the
 * reason every other by-database difference in this repo does: one type-to-facts
 * table, read by one function, so the gate carries no type test of its own.
 *
 * Scope rule: a row names ONLY what its provider can really run. What each command or
 * operation DOES is taken from the engines' own command references; what can REACH the
 * engine is taken from the provider code.
 */

/**
 * The single type-to-facts table. It has a row for exactly the types that
 * `readsSqlText` in `@/lib/sql/grammar` reports as not SQL, and a test holds the two
 * tables to that. A type with no row here is one whose statements the SQL half of the
 * gate reads; a row would be a second, weaker opinion about the same text.
 */
export const NON_SQL_DESTRUCTIVE_VOCABULARY: Readonly<Partial<Record<DatabaseType, DestructiveVocabulary>>> = {
  etcd: ETCD_DESTRUCTIVE_VOCABULARY,
  firestore: FIRESTORE_DESTRUCTIVE_VOCABULARY,
  influxdb: INFLUXDB_DESTRUCTIVE_VOCABULARY,
  kafka: KAFKA_DESTRUCTIVE_VOCABULARY,
  kubernetes: KUBERNETES_DESTRUCTIVE_VOCABULARY,
  milvus: MILVUS_DESTRUCTIVE_VOCABULARY,
  modbus: MODBUS_DESTRUCTIVE_VOCABULARY,
  mongodb: MONGODB_DESTRUCTIVE_VOCABULARY,
  mqtt: MQTT_DESTRUCTIVE_VOCABULARY,
  mtconnect: MTCONNECT_DESTRUCTIVE_VOCABULARY,
  neo4j: NEO4J_DESTRUCTIVE_VOCABULARY,
  netconf: NETCONF_DESTRUCTIVE_VOCABULARY,
  opcua: OPCUA_DESTRUCTIVE_VOCABULARY,
  oxia: OXIA_DESTRUCTIVE_VOCABULARY,
  prometheus: PROMETHEUS_DESTRUCTIVE_VOCABULARY,
  qdrant: QDRANT_DESTRUCTIVE_VOCABULARY,
  rabbitmq: RABBITMQ_DESTRUCTIVE_VOCABULARY,
  redis: REDIS_DESTRUCTIVE_VOCABULARY,
  s3: S3_DESTRUCTIVE_VOCABULARY,
  snmp: SNMP_DESTRUCTIVE_VOCABULARY,
  sparkplug: SPARKPLUG_DESTRUCTIVE_VOCABULARY,
  weaviate: WEAVIATE_DESTRUCTIVE_VOCABULARY,
};

/**
 * Whether this type's row is the gate's whole answer, which `isDangerousQuery` asks
 * before it reads the text as SQL at all.
 *
 * False for every type with no row, and for no type at all: the SQL half reads those.
 */
export function vocabularyDecidesAlone(databaseType?: DatabaseType): boolean {
  const facts = databaseType === undefined ? undefined : NON_SQL_DESTRUCTIVE_VOCABULARY[databaseType];
  return facts?.decidesAlone === true;
}

/**
 * Whether this query, on a type whose text is not SQL, asks for a confirmation.
 *
 * False for every type with no row - including no type at all, which is the reading a
 * caller without a connection gets and the one the SQL half already covers.
 */
export function isDestructiveNonSqlQuery(query: string, databaseType?: DatabaseType): boolean {
  const facts = databaseType === undefined ? undefined : NON_SQL_DESTRUCTIVE_VOCABULARY[databaseType];
  if (facts === undefined) return false;

  const named = facts.read(query);
  if (named === undefined) return true;
  return named.some((name) => facts.operations.has(name));
}

/**
 * What this statement asks the person to type before it runs, or undefined where the gate's one click is the whole
 * confirmation (#1089, section 5.5).
 *
 * Undefined for every type with no row, including no type at all, and for every row that declares no
 * `typedConfirmation`. The text reaches the row as it was written.
 */
export function vocabularyTypedConfirmation(
  databaseType: DatabaseType | undefined,
  text: string,
): TypedConfirmationAsk | undefined {
  const facts = databaseType === undefined ? undefined : NON_SQL_DESTRUCTIVE_VOCABULARY[databaseType];
  return facts?.typedConfirmation?.(text);
}

/**
 * Whether the confirmation gate may post this type's statements to the AI safety analysis (#1089, E10).
 *
 * True for every type with no row, including no type at all, and for every row that does not declare
 * `safetyAnalysis: false`, which is what the gate did for every engine before the field existed.
 */
export function vocabularySendsToModel(databaseType?: DatabaseType): boolean {
  const facts = databaseType === undefined ? undefined : NON_SQL_DESTRUCTIVE_VOCABULARY[databaseType];
  return facts?.safetyAnalysis !== false;
}

/**
 * The UTF-8 length of a text, counted without encoding it: a surrogate pair is one code point of four bytes, and a
 * lone surrogate counts three, as `TextEncoder` and `Buffer.byteLength` write it as U+FFFD.
 */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * The console text bound this connection type declares, in UTF-8 bytes, or undefined where it declares none.
 *
 * Undefined for every type with no row, including no type at all, and for every row that declares no bound.
 */
export function consoleTextByteLimit(databaseType?: DatabaseType): number | undefined {
  const facts = databaseType === undefined ? undefined : NON_SQL_DESTRUCTIVE_VOCABULARY[databaseType];
  return facts?.maxTextBytes;
}

/** The sentence a text over `limit` bytes is refused with, naming its size and the bound and never quoting it. */
export function consoleTextOverLimit(text: string, limit: number): string | undefined {
  const bytes = utf8Bytes(text);
  if (bytes <= limit) return undefined;
  return `The statement is ${bytes} bytes in UTF-8, over the ${limit}-byte limit for this connection type. Shorten it to run it.`;
}

/**
 * Why this connection type's editor refuses this statement, or undefined to send it.
 *
 * The bound first, so a row's own verdict never reads an oversize text; then the row's `refuse`. Undefined for
 * every type with no row, including no type at all, and for every row that declares neither field.
 */
export function statementRefusal(query: string, databaseType?: DatabaseType): string | undefined {
  const facts = databaseType === undefined ? undefined : NON_SQL_DESTRUCTIVE_VOCABULARY[databaseType];
  if (facts === undefined) return undefined;
  if (facts.maxTextBytes !== undefined) {
    const over = consoleTextOverLimit(query, facts.maxTextBytes);
    if (over !== undefined) return over;
  }
  return facts.refuse?.(query);
}
