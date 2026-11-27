/**
 * Every engine's SQL writing row, one per type id, composed when this module loads (docs/providers/CONTRACT.md, clause
 * M-79) from two sources:
 *
 * - the SQL writing each engine's declaration authors, its whole `sqlWriting` segment, projected into
 *   src/lib/db/engine-catalog/sql-writing.generated.ts as `BUNDLED_SQL_WRITING`;
 * - Studio's SQL writing function table, `SQL_WRITING_FUNCTIONS`, which binds each function name a declaration gives
 *   to the function Studio's own source holds for that engine at that slot.
 *
 * Each type name list becomes a set in its declared order, each type pattern is compiled once, here, and a function a
 * declaration states as null is left out of the row, or is the row's null where the row's member takes one
 * (`placeholder` and `temporalLiteral`). A declaration's SQL writing facts and the names of its functions are therefore
 * edited in its file under src/lib/db/engine-declarations and regenerated with `bun run engines:generate`; a function
 * an engine needs of its own is added to `SQL_WRITING_FUNCTIONS`.
 */
import { BUNDLED_SQL_WRITING } from "@/lib/db/engine-catalog/sql-writing.generated";
import type { SqlWritingEntry } from "@/lib/db/engine-catalog/projection";
import { boundFunction, type FunctionTable, slotFunctionTable } from "@/lib/db/function-table";
import { MONGODB_INSERT_DOCUMENTS } from "@/lib/db/providers/document/mongodb/sql-writing";
import { CASSANDRA_CREATE_TABLE_KEY_CLAUSE } from "@/lib/db/providers/sql/cassandra/sql-writing";
import { cassandraLiteral, cqlFrozenNested } from "@/lib/db/providers/sql/cassandra/typed-literals";
import { clickhouseLiteral } from "@/lib/db/providers/sql/clickhouse/typed-literals";
import { databendLiteral } from "@/lib/db/providers/sql/databend/typed-literals";
import { duckdbLiteral } from "@/lib/db/providers/sql/duckdb/typed-literals";
import { MSSQL_BOUND_EDIT, MSSQL_TYPED_LITERAL } from "@/lib/db/providers/sql/mssql-sql-writing";
import {
  ORACLE_BOUND_EDIT,
  ORACLE_COLUMN_WRITERS,
  ORACLE_TEMPORAL_LITERAL,
} from "@/lib/db/providers/sql/oracle-sql-writing";
import { postgresLiteral } from "@/lib/db/providers/sql/postgres-typed-literals";
import { SNOWFLAKE_DECLARE_FROM_SAMPLE } from "@/lib/db/providers/sql/snowflake/sql-writing";
import { snowflakeLiteral } from "@/lib/db/providers/sql/snowflake/typed-literals";
import { sparkLiteral } from "@/lib/db/providers/sql/spark/typed-literals";
import { trinoLiteral } from "@/lib/db/providers/sql/trino/typed-literals";
import { typeIdRow } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";
import {
  binaryBinaryHex,
  binaryHexToRaw,
  binaryPgBytea,
  binaryStandardHex,
  binaryTextBackslash,
  binaryUnhex,
  binaryZeroX,
} from "./export-shared";
import { NO_CONNECTION_SQL_WRITING } from "./no-connection";
import {
  identifierBacktickBackslash,
  identifierBacktickDoubled,
  identifierBracket,
  identifierDoubleQuoted,
  literalBackslash,
  literalDoubleAndBackslash,
  literalStandard,
  literalUnicode,
  placeholderAtP,
  placeholderColon,
  placeholderDollar,
  placeholderQuestion,
  unquoteBackslash,
  unquoteDoubleAndBackslash,
  unquoteStandard,
  unquoteUnicode,
} from "./shared";
import type { ExportSpec, ExportTypeVocabulary, InferredKind, InlineEditSpec, SqlWritingSpec } from "./types";

type CreateTableKeyClause = NonNullable<ExportSpec["createTableKey"]>["clause"];

/**
 * Studio's SQL writing function table: for each slot kind a declaration names a function at, the functions Studio's own
 * source holds, per engine and name. A name is bound only at its own kind, so a typed literal writer is never run as a
 * bound edit.
 */
export interface SqlWritingFunctions {
  /** `escapeLiteral`: a text as the engine's whole quoted literal. */
  readonly escapeLiterals: FunctionTable<SqlWritingSpec["escapeLiteral"]>;
  /** `unescapeLiteral`: a whole literal read back to its text. */
  readonly unescapeLiterals: FunctionTable<SqlWritingSpec["unescapeLiteral"]>;
  /** `quoteIdentifier`: a name quoted so its closing quote cannot end it. */
  readonly quoteIdentifiers: FunctionTable<SqlWritingSpec["quoteIdentifier"]>;
  /** `placeholder`: the bind placeholder for a 1-based position. */
  readonly placeholders: FunctionTable<NonNullable<SqlWritingSpec["placeholder"]>>;
  /** `temporalLiteral`: a date or timestamp text as the engine's literal of that kind. */
  readonly temporalLiterals: FunctionTable<NonNullable<SqlWritingSpec["temporalLiteral"]>>;
  /** `insertDocuments`: the request inserting documents at an address. */
  readonly insertDocuments: FunctionTable<NonNullable<SqlWritingSpec["insertDocuments"]>>;
  /** `inlineEdit.boundEdit`: the SET right-hand side of one edit. */
  readonly boundEdits: FunctionTable<NonNullable<InlineEditSpec["boundEdit"]>>;
  /** `export.binaryLiteral`: bytes as a literal the engine accepts. */
  readonly binaryLiterals: FunctionTable<ExportSpec["binaryLiteral"]>;
  /** `export.rewriteDeclared`: a declared type rewritten before a CREATE TABLE takes it. */
  readonly rewriteDeclareds: FunctionTable<NonNullable<ExportSpec["rewriteDeclared"]>>;
  /** `export.declareFromSample`: a column type read from its first value. */
  readonly declareFromSamples: FunctionTable<NonNullable<ExportSpec["declareFromSample"]>>;
  /** `export.typedLiteral`: a cell written from its column's declared type. */
  readonly typedLiterals: FunctionTable<NonNullable<ExportSpec["typedLiteral"]>>;
  /** `export.columnWriters`: one literal writer per column, prepared from the declared types. */
  readonly columnWriters: FunctionTable<NonNullable<ExportSpec["columnWriters"]>>;
  /** `export.createTableKey.clause`: the key's definition from the quoted column names. */
  readonly createTableKeyClauses: FunctionTable<CreateTableKeyClause>;
}

/**
 * The functions the committed declarations name, each the one Studio's source holds for that engine at that slot: 181
 * of them a building block of ./shared.ts or ./export-shared.ts, and 17 an engine's own, from the module beside its
 * provider. Every declaration names each function by its slot's own name (clause M-31), so each kind is built by
 * `slotFunctionTable`, and tests/unit/db/sql-writing/compose.test.ts holds the table to exactly the names the committed
 * declarations give.
 *
 * SQL writing runs in the browser and on the server, so only Studio's own functions are bound here: a name this table
 * does not hold, a package's included, is refused when the row is composed. Whether a declaration may choose a shared
 * building block by name is decided with the first package that fills a slot, and how a package's own SQL writing
 * functions are called and granted in provider isolation milestone M7 (clause S-16).
 */
export const SQL_WRITING_FUNCTIONS: SqlWritingFunctions = Object.freeze({
  escapeLiterals: slotFunctionTable("escapeLiteral", {
    bigquery: literalBackslash,
    cassandra: literalStandard,
    clickhouse: literalDoubleAndBackslash,
    couchbase: literalBackslash,
    databend: literalDoubleAndBackslash,
    db2: literalStandard,
    druid: literalStandard,
    duckdb: literalStandard,
    elasticsearch: literalStandard,
    etcd: literalStandard,
    firestore: literalStandard,
    influxdb: literalBackslash,
    influxdb3: literalStandard,
    kafka: literalStandard,
    kubernetes: literalStandard,
    libredb: literalStandard,
    libsql: literalStandard,
    milvus: literalStandard,
    modbus: literalStandard,
    mongodb: literalStandard,
    mqtt: literalStandard,
    mssql: literalUnicode,
    mtconnect: literalStandard,
    mysql: literalDoubleAndBackslash,
    neo4j: literalBackslash,
    netconf: literalStandard,
    opcua: literalStandard,
    opensearch: literalDoubleAndBackslash,
    oracle: literalStandard,
    oxia: literalStandard,
    postgres: literalStandard,
    prometheus: literalStandard,
    qdrant: literalStandard,
    rabbitmq: literalStandard,
    redis: literalStandard,
    s3: literalStandard,
    snmp: literalStandard,
    snowflake: literalDoubleAndBackslash,
    spark: literalBackslash,
    sparkplug: literalStandard,
    sqlite: literalStandard,
    trino: literalStandard,
    weaviate: literalStandard,
  }),
  unescapeLiterals: slotFunctionTable("unescapeLiteral", {
    bigquery: unquoteBackslash,
    cassandra: unquoteStandard,
    clickhouse: unquoteDoubleAndBackslash,
    couchbase: unquoteBackslash,
    databend: unquoteDoubleAndBackslash,
    db2: unquoteStandard,
    druid: unquoteStandard,
    duckdb: unquoteStandard,
    elasticsearch: unquoteStandard,
    etcd: unquoteStandard,
    firestore: unquoteStandard,
    influxdb: unquoteBackslash,
    influxdb3: unquoteStandard,
    kafka: unquoteStandard,
    kubernetes: unquoteStandard,
    libredb: unquoteStandard,
    libsql: unquoteStandard,
    milvus: unquoteStandard,
    modbus: unquoteStandard,
    mongodb: unquoteStandard,
    mqtt: unquoteStandard,
    mssql: unquoteUnicode,
    mtconnect: unquoteStandard,
    mysql: unquoteDoubleAndBackslash,
    neo4j: unquoteBackslash,
    netconf: unquoteStandard,
    opcua: unquoteStandard,
    opensearch: unquoteDoubleAndBackslash,
    oracle: unquoteStandard,
    oxia: unquoteStandard,
    postgres: unquoteStandard,
    prometheus: unquoteStandard,
    qdrant: unquoteStandard,
    rabbitmq: unquoteStandard,
    redis: unquoteStandard,
    s3: unquoteStandard,
    snmp: unquoteStandard,
    snowflake: unquoteDoubleAndBackslash,
    spark: unquoteBackslash,
    sparkplug: unquoteStandard,
    sqlite: unquoteStandard,
    trino: unquoteStandard,
    weaviate: unquoteStandard,
  }),
  quoteIdentifiers: slotFunctionTable("quoteIdentifier", {
    bigquery: identifierBacktickBackslash,
    cassandra: identifierDoubleQuoted,
    clickhouse: identifierDoubleQuoted,
    couchbase: identifierDoubleQuoted,
    databend: identifierBacktickDoubled,
    db2: identifierDoubleQuoted,
    druid: identifierDoubleQuoted,
    duckdb: identifierDoubleQuoted,
    elasticsearch: identifierDoubleQuoted,
    etcd: identifierDoubleQuoted,
    firestore: identifierDoubleQuoted,
    influxdb: identifierDoubleQuoted,
    influxdb3: identifierDoubleQuoted,
    kafka: identifierDoubleQuoted,
    kubernetes: identifierDoubleQuoted,
    libredb: identifierDoubleQuoted,
    libsql: identifierDoubleQuoted,
    milvus: identifierDoubleQuoted,
    modbus: identifierDoubleQuoted,
    mongodb: identifierDoubleQuoted,
    mqtt: identifierDoubleQuoted,
    mssql: identifierBracket,
    mtconnect: identifierDoubleQuoted,
    mysql: identifierBacktickDoubled,
    neo4j: identifierDoubleQuoted,
    netconf: identifierDoubleQuoted,
    opcua: identifierDoubleQuoted,
    opensearch: identifierBacktickDoubled,
    oracle: identifierDoubleQuoted,
    oxia: identifierDoubleQuoted,
    postgres: identifierDoubleQuoted,
    prometheus: identifierDoubleQuoted,
    qdrant: identifierDoubleQuoted,
    rabbitmq: identifierDoubleQuoted,
    redis: identifierDoubleQuoted,
    s3: identifierDoubleQuoted,
    snmp: identifierDoubleQuoted,
    snowflake: identifierDoubleQuoted,
    spark: identifierBacktickDoubled,
    sparkplug: identifierDoubleQuoted,
    sqlite: identifierDoubleQuoted,
    trino: identifierDoubleQuoted,
    weaviate: identifierDoubleQuoted,
  }),
  placeholders: slotFunctionTable("placeholder", {
    couchbase: placeholderDollar,
    db2: placeholderQuestion,
    druid: placeholderQuestion,
    duckdb: placeholderQuestion,
    mssql: placeholderAtP,
    mysql: placeholderQuestion,
    oracle: placeholderColon,
    postgres: placeholderDollar,
    sqlite: placeholderQuestion,
  }),
  temporalLiterals: slotFunctionTable("temporalLiteral", {
    oracle: ORACLE_TEMPORAL_LITERAL,
  }),
  insertDocuments: slotFunctionTable("insertDocuments", {
    mongodb: MONGODB_INSERT_DOCUMENTS,
  }),
  boundEdits: slotFunctionTable("boundEdit", {
    mssql: MSSQL_BOUND_EDIT,
    oracle: ORACLE_BOUND_EDIT,
  }),
  binaryLiterals: slotFunctionTable("binaryLiteral", {
    bigquery: binaryTextBackslash,
    cassandra: binaryZeroX,
    clickhouse: binaryUnhex,
    couchbase: binaryTextBackslash,
    databend: binaryUnhex,
    db2: binaryBinaryHex,
    druid: binaryStandardHex,
    duckdb: binaryUnhex,
    elasticsearch: binaryStandardHex,
    etcd: binaryStandardHex,
    firestore: binaryStandardHex,
    influxdb: binaryStandardHex,
    influxdb3: binaryStandardHex,
    kafka: binaryStandardHex,
    kubernetes: binaryStandardHex,
    libredb: binaryStandardHex,
    libsql: binaryStandardHex,
    milvus: binaryStandardHex,
    modbus: binaryStandardHex,
    mongodb: binaryStandardHex,
    mqtt: binaryStandardHex,
    mssql: binaryZeroX,
    mtconnect: binaryStandardHex,
    mysql: binaryStandardHex,
    neo4j: binaryStandardHex,
    netconf: binaryStandardHex,
    opcua: binaryStandardHex,
    opensearch: binaryStandardHex,
    oracle: binaryHexToRaw,
    oxia: binaryStandardHex,
    postgres: binaryPgBytea,
    prometheus: binaryStandardHex,
    qdrant: binaryStandardHex,
    rabbitmq: binaryStandardHex,
    redis: binaryStandardHex,
    s3: binaryStandardHex,
    snmp: binaryStandardHex,
    snowflake: binaryStandardHex,
    spark: binaryStandardHex,
    sparkplug: binaryStandardHex,
    sqlite: binaryStandardHex,
    trino: binaryStandardHex,
    weaviate: binaryStandardHex,
  }),
  rewriteDeclareds: slotFunctionTable("rewriteDeclared", {
    cassandra: cqlFrozenNested,
  }),
  declareFromSamples: slotFunctionTable("declareFromSample", {
    snowflake: SNOWFLAKE_DECLARE_FROM_SAMPLE,
  }),
  typedLiterals: slotFunctionTable("typedLiteral", {
    cassandra: cassandraLiteral,
    clickhouse: clickhouseLiteral,
    databend: databendLiteral,
    duckdb: duckdbLiteral,
    mssql: MSSQL_TYPED_LITERAL,
    postgres: postgresLiteral,
    snowflake: snowflakeLiteral,
    spark: sparkLiteral,
    trino: trinoLiteral,
  }),
  columnWriters: slotFunctionTable("columnWriters", {
    oracle: ORACLE_COLUMN_WRITERS,
  }),
  createTableKeyClauses: slotFunctionTable("createTableKeyClause", {
    cassandra: CASSANDRA_CREATE_TABLE_KEY_CLAUSE,
  }),
});

/** The function `table` binds for engine `id` under `name`, or null where the declaration states none. */
function boundOrNull<Bound>(id: DatabaseType, table: FunctionTable<Bound>, name: string | null): Bound | null {
  return name === null ? null : boundFunction(id, table, name);
}

/**
 * A declared type name list as the set the inline edit reads, in its declared order. The Set object is frozen, which
 * does not stop `Set.prototype.add`: the set is read-only by its `ReadonlySet` type, and no reader writes to it.
 */
function typeNameSet(names: readonly string[]): ReadonlySet<string> {
  return Object.freeze(new Set(names));
}

/** The inline edit `edit` declares: each type name list a set, `all` kept as itself, and the bound edit bound. */
function inlineEditOf(id: DatabaseType, edit: SqlWritingEntry["inlineEdit"], functions: SqlWritingFunctions) {
  const { float64TypeNames, boundEdit } = edit;
  return Object.freeze({
    instantTypeNames: typeNameSet(edit.instantTypeNames),
    exactDecimalTypeNames: typeNameSet(edit.exactDecimalTypeNames),
    float64TypeNames: float64TypeNames === "all" ? float64TypeNames : typeNameSet(float64TypeNames),
    ...(boundEdit === null ? {} : { boundEdit: boundFunction(id, functions.boundEdits, boundEdit) }),
  }) satisfies InlineEditSpec;
}

/**
 * The type vocabulary `vocabulary` declares: the bare type families as one record of each name to its kind, built kind
 * by kind in the declared kind order, and each pattern compiled once, here, from its source and flags. The record is
 * frozen and the patterns are not, since a RegExp's `lastIndex` is the engine's to write.
 */
function vocabularyOf(vocabulary: SqlWritingEntry["export"]["typeVocabulary"]): ExportTypeVocabulary {
  const bareTypeFamily: Record<string, InferredKind> = Object.fromEntries(
    (Object.entries(vocabulary.bareTypeFamily) as [InferredKind, readonly string[]][]).flatMap(([kind, names]) =>
      names.map((name) => [name, kind]),
    ),
  );
  const { floatType, exactNumericType, numericWrapper } = vocabulary;
  return Object.freeze({
    bareTypeFamily: Object.freeze(bareTypeFamily),
    floatType: new RegExp(floatType.source, floatType.flags),
    exactNumericType: new RegExp(exactNumericType.source, exactNumericType.flags),
    numericWrapper: new RegExp(numericWrapper.source, numericWrapper.flags),
  });
}

/** The export hooks `facts` declares, each bound through `functions`, a hook stated as null left out. */
function optionalHooksOf(id: DatabaseType, facts: SqlWritingEntry["export"], functions: SqlWritingFunctions) {
  const { rewriteDeclared, declareFromSample, typedLiteral, columnWriters, createTableKey } = facts;
  return {
    ...(rewriteDeclared === null
      ? {}
      : { rewriteDeclared: boundFunction(id, functions.rewriteDeclareds, rewriteDeclared) }),
    ...(declareFromSample === null
      ? {}
      : { declareFromSample: boundFunction(id, functions.declareFromSamples, declareFromSample) }),
    ...(typedLiteral === null ? {} : { typedLiteral: boundFunction(id, functions.typedLiterals, typedLiteral) }),
    ...(columnWriters === null ? {} : { columnWriters: boundFunction(id, functions.columnWriters, columnWriters) }),
    ...(createTableKey === null
      ? {}
      : {
          createTableKey: Object.freeze({
            note: createTableKey.note,
            clause: boundFunction(id, functions.createTableKeyClauses, createTableKey.clause),
          }),
        }),
  } satisfies Partial<ExportSpec>;
}

/** The export `facts` declares: its data as frozen copies in the declared member order, and its functions bound. */
function exportOf(id: DatabaseType, facts: SqlWritingEntry["export"], functions: SqlWritingFunctions): ExportSpec {
  return Object.freeze({
    ddlTypes: Object.freeze({ ...facts.ddlTypes }),
    standsAlone: Object.freeze([...facts.standsAlone]),
    bareSpelling: Object.freeze(Object.fromEntries(facts.bareSpelling.map(({ name, spelling }) => [name, spelling]))),
    typeVocabulary: vocabularyOf(facts.typeVocabulary),
    binaryLiteral: boundFunction(id, functions.binaryLiterals, facts.binaryLiteral),
    nonFinite: Object.freeze({ ...facts.nonFinite }),
    insertForm: facts.insertForm,
    ...optionalHooksOf(id, facts, functions),
  });
}

/**
 * Engine `id`'s SQL writing row, composed from `entry`, its projected SQL writing, and `functions`: each function
 * bound through `functions`, `placeholder` and `temporalLiteral` bound or null, `insertDocuments` bound or left out,
 * the inline edit by `inlineEditOf` and the export by `exportOf`. The row and every record in it are frozen, a type
 * pattern apart; a type name set is read-only by its `ReadonlySet` type, since freezing a Set does not stop its `add`.
 *
 * @throws {Error} Naming the engine and the name, for a function name `functions` holds none for at its slot, a name it
 * holds only at another slot included.
 */
export function composeSqlWriting(
  id: DatabaseType,
  entry: SqlWritingEntry,
  functions: SqlWritingFunctions,
): SqlWritingSpec {
  const { insertDocuments } = entry;
  return Object.freeze({
    escapeLiteral: boundFunction(id, functions.escapeLiterals, entry.escapeLiteral),
    unescapeLiteral: boundFunction(id, functions.unescapeLiterals, entry.unescapeLiteral),
    quoteIdentifier: boundFunction(id, functions.quoteIdentifiers, entry.quoteIdentifier),
    placeholder: boundOrNull(id, functions.placeholders, entry.placeholder),
    temporalLiteral: boundOrNull(id, functions.temporalLiterals, entry.temporalLiteral),
    inlineEdit: inlineEditOf(id, entry.inlineEdit, functions),
    export: exportOf(id, entry.export, functions),
    ...(insertDocuments === null
      ? {}
      : { insertDocuments: boundFunction(id, functions.insertDocuments, insertDocuments) }),
  });
}

/**
 * Every engine's SQL writing row, composed when this module loads from `BUNDLED_SQL_WRITING` and Studio's SQL writing
 * function table, so a committed module naming a function Studio holds none for fails every importer by that sentence.
 * Keyed in the projection's ascending id order, and total over `DatabaseType`, since the generated record is typed over
 * it: a new provider cannot be added without an answer here, because the silent wrong answer is exactly the defect the
 * literal rules exist to close (issue #290).
 */
export const SQL_WRITING: Readonly<Record<DatabaseType, SqlWritingSpec>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(BUNDLED_SQL_WRITING) as DatabaseType[]).map((id) => [
      id,
      composeSqlWriting(id, BUNDLED_SQL_WRITING[id], SQL_WRITING_FUNCTIONS),
    ]),
  ) as Record<DatabaseType, SqlWritingSpec>,
);

/**
 * The rules for `type`: the no-connection spec for `undefined`, and its row for a type id, read through `typeIdRow`,
 * so any other value is refused by name and `"constructor"` or `"__proto__"` is never read off the prototype as if it
 * were a row.
 *
 * @throws {UnknownProviderError} When `type` is defined and not a type id: a string that names no provider, `""`,
 * `null`, or a value that is not text.
 */
export function sqlWritingFor(type: string | undefined): SqlWritingSpec {
  if (type === undefined) return NO_CONNECTION_SQL_WRITING;
  return typeIdRow(SQL_WRITING, type);
}
