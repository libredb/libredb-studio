import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import { NEO4J_DESTRUCTIVE_VOCABULARY } from "@/lib/db/graph/cypher/destructive";
import { FIRESTORE_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/document/firestore/destructive";
import { ETCD_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/keyvalue/etcd/destructive";
import { OXIA_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/oxiacli/destructive";
import { S3_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/objectstore/s3/destructive";
import { KUBERNETES_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/kubectl/destructive";
import { INFLUXDB_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/influxql/destructive";
import { MILVUS_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/vector/milvus/destructive";
import { QDRANT_DESTRUCTIVE_VOCABULARY } from "@/lib/db/providers/vector/qdrant/destructive";
import { WEAVIATE_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/weaviateapi/destructive";
import { BUNDLED_STATEMENT_LANGUAGE_DATA } from "@/lib/db/engine-catalog/statement-language.generated";
import { rowRefusal, rowTextByteLimit, rowTypedAsk, statementLanguageRow } from "@/lib/db/statement-language-row";
import { typeIdRow } from "@/lib/db/type-id";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import { MODBUS_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/modbusread/destructive";
import { MONGODB_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/mongo/destructive";
import { MQTT_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/mqttread/destructive";
import { MTCONNECT_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/mtconnectread/destructive";
import { NETCONF_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/netconfrpc/destructive";
import { OPCUA_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/opcuaread/destructive";
import { PROMETHEUS_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/promql/destructive";
import { RABBITMQ_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/rabbitread/destructive";
import { REDIS_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/rediscli/destructive";
import { SNMP_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/snmpget/destructive";
import { SPARKPLUG_DESTRUCTIVE_VOCABULARY } from "@/lib/languages/sparkplugread/destructive";
import type { DatabaseType } from "@/lib/types";

/**
 * The confirmation gate's vocabulary for the engines whose query text is NOT SQL.
 *
 * An engine whose declaration states its statement language as data (`statementLanguageData`, projected into
 * `BUNDLED_STATEMENT_LANGUAGE_DATA`) has its row compiled from that data instead (`typeStatementLanguageRow`), and no
 * row in the table below.
 *
 * Each engine's row is declared in its statement language's core family module, `destructive.ts` under
 * `src/lib/languages/<language>/`, or under `src/lib/db/graph/cypher/` for Cypher, or, until the provider plugin
 * program's slice for that language moves it, beside its provider in its `destructive.ts` module
 * (docs/PROVIDER_IMPORTS.md), with the shape in `./destructive-vocabulary.ts`; this module only collects the rows and
 * answers the gate from them, so it names no engine's commands, operations or readers of its own.
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
 * The single type-to-facts table of Studio's code rows. It has a row for exactly the types that
 * `readsSqlText` in `@/lib/sql/grammar` reports as not SQL whose language is still a module of
 * Studio's; an engine whose declaration states its language as data has its row compiled from
 * it, and a test holds the two tables to that. A type with no row here and no declared data is
 * one whose statements the SQL half of the gate reads; a row would be a second, weaker opinion
 * about the same text.
 */
export const NON_SQL_DESTRUCTIVE_VOCABULARY: Readonly<Partial<Record<DatabaseType, DestructiveVocabulary>>> = {
  etcd: ETCD_DESTRUCTIVE_VOCABULARY,
  firestore: FIRESTORE_DESTRUCTIVE_VOCABULARY,
  influxdb: INFLUXDB_DESTRUCTIVE_VOCABULARY,
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
 * Studio's code row of `databaseType`, the statement language row the confirmation gate reads for a legacy engine whose
 * language is still a module of Studio's, read from the table on each call; null for no type at all and for every type
 * with no row, whose statements the SQL half of the gate reads. Any other value that is not a type id is refused by
 * name (`typeIdRow`, FND-1).
 *
 * @throws {UnknownProviderError} When `databaseType` is defined and is not a type id.
 */
export function codeStatementLanguageRow(databaseType?: DatabaseType): DestructiveVocabulary | null {
  if (databaseType === undefined) return null;
  return typeIdRow(NON_SQL_DESTRUCTIVE_VOCABULARY, databaseType) ?? null;
}

/**
 * The row of each type whose declaration states its statement language as data (`BUNDLED_STATEMENT_LANGUAGE_DATA`),
 * compiled by the one resolver (`statementLanguageRow`) once, when this module loads, so every reader, in the browser
 * and in the legacy record, reads the same frozen object and no statement recompiles a row. A type whose declaration
 * states data while the table above still holds its code row fails here, by name, when the module loads.
 */
const DECLARED_ROWS: ReadonlyMap<string, DestructiveVocabulary> = new Map(
  (Object.keys(BUNDLED_STATEMENT_LANGUAGE_DATA) as DatabaseType[]).flatMap((type) => {
    const data = BUNDLED_STATEMENT_LANGUAGE_DATA[type];
    const row = data === null ? null : statementLanguageRow(type, data, codeStatementLanguageRow(type));
    return row === null ? [] : [[type, row] as const];
  }),
);

/**
 * The statement language row the confirmation gate reads for `databaseType` by type, as the one resolver orders it:
 * the row compiled from the statement language data its declaration states (`DECLARED_ROWS`), else Studio's code row,
 * read from the table on each call (`codeStatementLanguageRow`), else null; null for no type at all. The browser reads
 * it by type until it reads the engine's record, and the legacy adapter's record holds the same object. Any other value
 * that is not a type id is refused by name (`typeIdRow`, FND-1).
 *
 * @throws {UnknownProviderError} When `databaseType` is defined and is not a type id.
 */
export function typeStatementLanguageRow(databaseType?: DatabaseType): DestructiveVocabulary | null {
  const codeRow = codeStatementLanguageRow(databaseType);
  if (databaseType === undefined) return null;
  return DECLARED_ROWS.get(databaseType) ?? codeRow;
}

/**
 * What this statement asks the person to type before it runs, or undefined where the gate's one click is the whole
 * confirmation (#1089, section 5.5).
 *
 * Undefined for every type with no row, including no type at all, and for every row that declares no
 * `typedConfirmation`. Any other value that is not a type id is refused by name (`typeIdRow`, FND-1). The text
 * reaches the row as it was written.
 *
 * @throws {UnknownProviderError} When `databaseType` is defined and is not a type id.
 */
export function vocabularyTypedConfirmation(
  databaseType: DatabaseType | undefined,
  text: string,
): TypedConfirmationAsk | undefined {
  return rowTypedAsk(typeStatementLanguageRow(databaseType), text);
}

/**
 * Whether the confirmation gate may post this type's statements to the AI safety analysis (#1089, E10).
 *
 * True for every type with no row, including no type at all, and for every row that does not declare
 * `safetyAnalysis: false`, which is what the gate did for every engine before the field existed. Any other value that
 * is not a type id is refused by name (`typeIdRow`, FND-1), never answered true.
 *
 * @throws {UnknownProviderError} When `databaseType` is defined and is not a type id.
 */
export function vocabularySendsToModel(databaseType?: DatabaseType): boolean {
  return typeStatementLanguageRow(databaseType)?.safetyAnalysis !== false;
}

/**
 * The console text bound this connection type declares, in UTF-8 bytes, or undefined where it declares none: the bound
 * of its row (`rowTextByteLimit`), which the browser reads by type until it reads the engine's record.
 *
 * Undefined for every type with no row, including no type at all, and for every row that declares no bound. Any other
 * value that is not a type id is refused by name (`typeIdRow`, FND-1).
 *
 * @throws {UnknownProviderError} When `databaseType` is defined and is not a type id.
 */
export function consoleTextByteLimit(databaseType?: DatabaseType): number | undefined {
  return rowTextByteLimit(typeStatementLanguageRow(databaseType));
}

/**
 * Why this connection type's editor refuses this statement, or undefined to send it: the refusal of its row
 * (`rowRefusal`), which the browser reads by type until it reads the engine's record.
 *
 * The bound first, so a row's own verdict never reads an oversize text; then the row's `refuse`. Undefined for
 * every type with no row, including no type at all, and for every row that declares neither field. Any other value
 * that is not a type id is refused by name (`typeIdRow`, FND-1).
 *
 * @throws {UnknownProviderError} When `databaseType` is defined and is not a type id.
 */
export function statementRefusal(query: string, databaseType?: DatabaseType): string | undefined {
  return rowRefusal(typeStatementLanguageRow(databaseType), query);
}
