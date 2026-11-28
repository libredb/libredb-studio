import { BUNDLED_SQL_GENERATORS } from "@/lib/db/engine-catalog/sql-generators.generated";
import type { SqlGeneratorsEntry } from "@/lib/db/engine-catalog/projection";
import { boundFunction, type FunctionTable, slotFunctionTable } from "@/lib/db/function-table";
import { CYPHER_GENERATORS } from "@/lib/db/graph/cypher/generators";
import { MONGODB_JSON_GENERATORS } from "@/lib/db/providers/document/mongodb/generators";
import {
  COUCHBASE_GENERATOR_QUOTE,
  COUCHBASE_GENERATOR_SELECT,
  COUCHBASE_GENERATOR_TABLE,
} from "@/lib/db/providers/document/couchbase/generators";
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
import { DRUID_GENERATOR_QUOTE } from "@/lib/db/providers/sql/druid/generators";
import { MSSQL_GENERATOR_QUOTE, MSSQL_GENERATOR_SELECT_LIST } from "@/lib/db/providers/sql/mssql-generators";
import { MYSQL_GENERATOR_QUOTE } from "@/lib/db/providers/sql/mysql-generators";
import { ORACLE_GENERATOR_QUOTE, ORACLE_GENERATOR_SELECT_LIST } from "@/lib/db/providers/sql/oracle-generators";
import { KAFKA_GENERATORS } from "@/lib/db/providers/stream/kafka/generators";
import { RABBITMQ_GENERATORS } from "@/lib/db/providers/stream/rabbitmq/generators";
import { INFLUXQL_GENERATORS } from "@/lib/db/providers/timeseries/influxdb/influxql-generators";
import { PROMQL_GENERATORS } from "@/lib/db/providers/timeseries/prometheus/generators";
import { MILVUS_GENERATORS } from "@/lib/db/providers/vector/milvus/generators";
import { QDRANT_GENERATORS } from "@/lib/db/providers/vector/qdrant/generators";
import { WEAVIATE_GENERATORS } from "@/lib/db/providers/vector/weaviate/generators";
import type { QueryDialect } from "@/lib/db/query-dialects";
import { typeIdRow } from "@/lib/db/type-id";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import type { DialectGenerators, LanguageGenerators, SqlEngineGenerators } from "./types";

/**
 * The query generators' registry: every text one engine writes for a tree click, Generate Query, Generate Count Query
 * or a row action is a dialect's or a language's row declared beside its provider, or an SQL engine's own forms
 * composed from its declaration, and `src/lib/query-generators.ts` reads it here, by what the declaration says or, for
 * an SQL engine's own forms, by the connection's type id, and names no engine itself.
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
 * Studio's SQL generator function table: for each form a declaration names a function at, the functions Studio's own
 * source holds, per engine and name. A name is bound only at its own kind, so a quoting is never run as a statement.
 */
export interface SqlGeneratorFunctions {
  /** `quote`: a name quoted for the engine. */
  readonly quotes: FunctionTable<SqlEngineGenerators["quote"]>;
  /** `table`: the tree click's statement. */
  readonly tables: FunctionTable<NonNullable<SqlEngineGenerators["table"]>>;
  /** `select`: Generate Query's statement on the columns. */
  readonly selects: FunctionTable<NonNullable<SqlEngineGenerators["select"]>>;
  /** `selectList`: Generate Query's statement on the projected column list. */
  readonly selectLists: FunctionTable<NonNullable<SqlEngineGenerators["selectList"]>>;
}

/**
 * The functions the committed declarations name, each the one Studio's source holds for that engine at that slot, all
 * nine an engine's own, from the module beside its provider. Every declaration names each form by its slot's own name
 * (docs/providers/CONTRACT.md, clause M-31), so each kind is built by `slotFunctionTable`, and
 * tests/unit/lib/query-generators-compose.test.ts holds the table to exactly the names the committed declarations give.
 *
 * Studio runs a row's name quoting in the browser and on its server, and its statement forms in the browser, so only
 * Studio's own functions are bound here: a name this table does not hold, a package's included, is refused when the row
 * is composed. Where a package's own generator function runs is decided with the first package that fills a slot
 * (clause S-22).
 */
export const SQL_GENERATOR_FUNCTIONS: SqlGeneratorFunctions = Object.freeze({
  quotes: slotFunctionTable("generatorQuote", {
    couchbase: COUCHBASE_GENERATOR_QUOTE,
    druid: DRUID_GENERATOR_QUOTE,
    mssql: MSSQL_GENERATOR_QUOTE,
    mysql: MYSQL_GENERATOR_QUOTE,
    oracle: ORACLE_GENERATOR_QUOTE,
  }),
  tables: slotFunctionTable("generatorTable", {
    couchbase: COUCHBASE_GENERATOR_TABLE,
  }),
  selects: slotFunctionTable("generatorSelect", {
    couchbase: COUCHBASE_GENERATOR_SELECT,
  }),
  selectLists: slotFunctionTable("generatorSelectList", {
    mssql: MSSQL_GENERATOR_SELECT_LIST,
    oracle: ORACLE_GENERATOR_SELECT_LIST,
  }),
});

/**
 * Engine `id`'s SQL generator row, composed from `entry`, the generator forms its declaration states, and `functions`:
 * its name quoting bound, each statement form bound or left out where the declaration states it as null, and its count
 * expression as declared. The row is frozen.
 *
 * @throws {Error} Naming the engine and the name, for a function name `functions` holds none for at its slot, a name it
 * holds only at another slot included.
 */
export function composeSqlEngineGenerators(
  id: DatabaseType,
  entry: NonNullable<SqlGeneratorsEntry>,
  functions: SqlGeneratorFunctions,
): SqlEngineGenerators {
  const { table, select, selectList } = entry;
  return Object.freeze({
    quote: boundFunction(id, functions.quotes, entry.quote),
    ...(table === null ? {} : { table: boundFunction(id, functions.tables, table) }),
    ...(select === null ? {} : { select: boundFunction(id, functions.selects, select) }),
    ...(selectList === null ? {} : { selectList: boundFunction(id, functions.selectLists, selectList) }),
    countExpression: entry.countExpression,
  });
}

/**
 * The SQL forms and identifier quoting each SQL engine writes apart from the shared ones, keyed by type id, composed
 * when this module loads (docs/providers/CONTRACT.md, clause M-81) from the generator forms each engine's declaration
 * authors, projected into src/lib/db/engine-catalog/sql-generators.generated.ts as `BUNDLED_SQL_GENERATORS`, and
 * Studio's SQL generator function table, so a connection's forms follow its type and never the port its declaration
 * names, and a committed module naming a function Studio holds none for fails every importer by that sentence. A
 * `Partial` over `DatabaseType`: an engine whose declaration states no forms has no row and writes the shared forms.
 * Read only through `sqlEngineGenerators`.
 */
export const SQL_ENGINE_GENERATORS: Readonly<Partial<Record<DatabaseType, SqlEngineGenerators>>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(BUNDLED_SQL_GENERATORS) as DatabaseType[]).flatMap((id) => {
      const entry = BUNDLED_SQL_GENERATORS[id];
      return entry === null ? [] : [[id, composeSqlEngineGenerators(id, entry, SQL_GENERATOR_FUNCTIONS)]];
    }),
  ),
);

/** The generators of the language a declaration names, looked up as an own key; undefined for SQL. */
export function languageGenerators(
  capabilities: Pick<ProviderCapabilities, "queryLanguage">,
): LanguageGenerators | undefined {
  const language: string = capabilities.queryLanguage;
  return Object.hasOwn(LANGUAGE_GENERATORS, language)
    ? LANGUAGE_GENERATORS[language as EngineQueryLanguage]
    : undefined;
}

/**
 * The SQL forms of `type`'s engine: none for `undefined`, which is no connection, and for a type id with no row; its
 * row otherwise, read through `typeIdRow`, so any other value is refused by name before the table is read.
 *
 * @throws {UnknownProviderError} When `type` is defined and not a type id.
 */
export function sqlEngineGenerators(type: DatabaseType | undefined): SqlEngineGenerators | undefined {
  return type === undefined ? undefined : typeIdRow(SQL_ENGINE_GENERATORS, type);
}
